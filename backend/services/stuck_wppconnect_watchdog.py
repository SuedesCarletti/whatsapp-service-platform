"""
stuck_wppconnect_watchdog.py — reenvio automático de mensagens "fantasma".

Incidente 2026-09-11 (achado ao vivo, confirmado pelo usuário): o
WPPConnect pode devolver `success: true` (com `message_id` válido) num
chat endereçado por LID SEM transmitir a mensagem de verdade — falha
muda, sem exceção nenhuma, então `withLidRetry` (bridge Node — só reage
a exceção "No LID for user") nunca entra em ação. Prova concreta: a
mesma conversa recebeu uma mensagem enviada direto do celular (chegou,
confirmou entrega real do WhatsApp em 1s) e três mensagens seguidas
enviadas pela plataforma via WPPConnect (todas com `success: true` e
message_id, nenhuma nunca confirmou entrega — cliente nunca recebeu).

Política: toda mensagem outbound enviada por conta WPPConnect que fica
presa em status=SENT (nunca vira delivered/read) por mais de
STUCK_AFTER_MINUTES é candidata a reenvio automático pela conta Baileys
companion do mesmo número (mesmo mecanismo de
`_find_baileys_fallback_account`/`_send_text_maybe_fallback` já usado em
routes.py — Baileys fala o protocolo direto, sem a camada de emulação de
navegador que causa esse falso positivo). MAX_AGE_HOURS evita reprocessar
um histórico antigo indefinidamente — só mensagens recentes (da janela de
trabalho atual) são candidatas; mensagens mais antigas que já ficaram
paradas nesse status por outro motivo (e não foram pegas a tempo) ficam
de fora, pra não gerar uma rajada de reenvios duplicados de coisas já
resolvidas ou irrelevantes.

Cada mensagem só é processada uma vez (`stuck_retry_attempted_at`),
sucesso ou falha — sem isso o watchdog tentaria de novo a cada ciclo.
"""
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from backend.database.connection import SessionLocal
from backend.database.models import Message, MessageStatus, Direction, Conversation, WhatsAppAccount, Contact
from backend.providers.factory import get_unofficial_provider, normalize_provider_type

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 120
STUCK_AFTER_MINUTES = 3
MAX_AGE_HOURS = 6

# Pool próprio e pequeno — mesmo motivo do bridge_watchdog (ver comentário lá):
# nunca bloquear o event loop com uma query síncrona direto na coroutine.
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="stuck-msg-watchdog")


def _find_baileys_fallback(db, account: WhatsAppAccount):
    """Mesma lógica de `_find_baileys_fallback_account` em routes.py —
    conta Baileys ativa vinculada ao MESMO número de telefone."""
    if not account or not account.phone_number:
        return None
    candidates = (
        db.query(WhatsAppAccount)
        .filter(
            WhatsAppAccount.phone_number == account.phone_number,
            WhatsAppAccount.is_active == True,
            WhatsAppAccount.id != account.id,
        )
        .all()
    )
    for cand in candidates:
        if normalize_provider_type(cand.provider_type) == "baileys":
            return cand
    return None


def _build_provider(account: WhatsAppAccount):
    import json
    raw = account.provider_config or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = {}
    config = dict(raw)
    config.setdefault("session_id", account.session_id or "default")
    return get_unofficial_provider(normalize_provider_type(account.provider_type), config)


def _fetch_candidates_sync():
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        rows = (
            db.query(Message, Conversation, WhatsAppAccount, Contact)
            .join(Conversation, Conversation.id == Message.conversation_id)
            .join(WhatsAppAccount, WhatsAppAccount.id == Conversation.account_id)
            .join(Contact, Contact.id == Message.contact_id)
            .filter(
                Message.direction == Direction.OUTBOUND,
                Message.status == MessageStatus.SENT,
                # Incidente 2026-09-15: sem este filtro, uma mensagem enviada
                # DIRETO DO CELULAR (nunca passou pela nossa API) também cai
                # aqui — nunca recebe ack de entrega pelo mesmo motivo que as
                # de verdade travadas, mas já foi entregue de verdade pelo
                # WhatsApp nativo. O watchdog reenviava (ou marcava FAILED)
                # mensagens que o cliente já tinha recebido. Só mensagens que
                # sabemos ter passado pelo nosso /send (ver
                # conversation_service.save_outbound_message) são candidatas
                # reais a "nossa API travou no envio".
                Message.sent_via_platform.is_(True),
                Message.stuck_retry_attempted_at.is_(None),
                Message.created_at <= now - timedelta(minutes=STUCK_AFTER_MINUTES),
                Message.created_at >= now - timedelta(hours=MAX_AGE_HOURS),
            )
            .all()
        )
        candidates = []
        for msg, conv, account, contact in rows:
            if normalize_provider_type(account.provider_type) != "wppconnect":
                continue
            candidates.append({
                "message_id": msg.id,
                "text": msg.message_text,
                "reply_to_wamid": msg.reply_to_wamid,
                "account_id": account.id,
                "wa_id": contact.wa_id,
            })
        return candidates
    finally:
        db.close()


async def _fetch_candidates():
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_EXECUTOR, _fetch_candidates_sync)


def _mark_attempted_sync(message_id: int, new_wamid: str = None, mark_failed: bool = False, failed_payload: dict = None):
    db = SessionLocal()
    try:
        msg = db.query(Message).filter(Message.id == message_id).first()
        if not msg:
            return
        msg.stuck_retry_attempted_at = datetime.utcnow()
        if new_wamid:
            msg.wamid = new_wamid
        if mark_failed:
            msg.status = MessageStatus.FAILED
            msg.failed_payload = failed_payload
        db.commit()
    finally:
        db.close()


async def _mark_attempted(message_id: int, new_wamid: str = None, mark_failed: bool = False, failed_payload: dict = None):
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(
        _EXECUTOR, _mark_attempted_sync, message_id, new_wamid, mark_failed, failed_payload
    )


async def _retry_one(db_for_lookup, candidate: dict) -> None:
    account = db_for_lookup.query(WhatsAppAccount).filter(WhatsAppAccount.id == candidate["account_id"]).first()
    fallback_account = _find_baileys_fallback(db_for_lookup, account)

    failed_payload = {
        "kind": "text",
        "to": candidate["wa_id"],
        "text": candidate["text"],
        "reply_to": candidate["reply_to_wamid"],
        "account_id": candidate["account_id"],
    }

    if not fallback_account:
        # Incidente 2026-09-11 (achado ao vivo, ~800 mensagens da ti01 pegas
        # de uma vez): marcar como FAILED aqui era um erro sério — "sem
        # fallback disponível" NÃO é evidência de não-entrega real, é só
        # ausência de uma companion Baileys pareada pra essa conta (ex.:
        # ti01, cujo problema conhecido é o pipeline de confirmação de
        # entrega quebrado — mensagens provavelmente CHEGAM normalmente,
        # só não sabemos por essa via). Marcar como FAILED em massa gera um
        # alarme falso enorme (centenas de "!" vermelho em conversas que
        # foram entregues igual). Só marcamos FAILED quando um fallback
        # EXISTE e a tentativa de reenvio por ele também falhou de verdade
        # — aí sim é evidência real de problema nessa mensagem específica.
        # Sem fallback: só loga e pula, sem tocar no status da mensagem.
        logger.info(
            f"[StuckMsgWatchdog] Mensagem #{candidate['message_id']} (conta "
            f"#{candidate['account_id']}) presa em SENT, mas sem conta Baileys fallback "
            f"disponível pra essa conta — sem evidência de não-entrega real, deixando como está."
        )
        await _mark_attempted(candidate["message_id"])
        return

    try:
        fb_provider = _build_provider(fallback_account)
        fb_response = await fb_provider.send_text_message(to=candidate["wa_id"], text=candidate["text"])
    except Exception as exc:
        logger.warning(f"[StuckMsgWatchdog] Reenvio via fallback falhou pra #{candidate['message_id']}: {exc}")
        await _mark_attempted(candidate["message_id"], mark_failed=True, failed_payload=failed_payload)
        return

    if fb_response.get("success") is False:
        logger.warning(
            f"[StuckMsgWatchdog] Fallback respondeu falha pra #{candidate['message_id']}: "
            f"{fb_response.get('error')}"
        )
        await _mark_attempted(candidate["message_id"], mark_failed=True, failed_payload=failed_payload)
        return

    new_wamid = fb_response.get("message_id") or fb_response.get("id")
    logger.info(
        f"[StuckMsgWatchdog] Mensagem #{candidate['message_id']} presa em SENT (conta "
        f"#{candidate['account_id']}, WPPConnect) reenviada com sucesso via fallback Baileys "
        f"(conta #{fallback_account.id}) — novo wamid: {new_wamid}"
    )
    await _mark_attempted(candidate["message_id"], new_wamid=new_wamid)


async def run_stuck_wppconnect_watchdog():
    logger.info(f"[StuckMsgWatchdog] Iniciado — verificação a cada {CHECK_INTERVAL_S}s")
    while True:
        try:
            candidates = await _fetch_candidates()
            if candidates:
                logger.info(f"[StuckMsgWatchdog] {len(candidates)} mensagem(ns) candidata(s) a reenvio")
                db = SessionLocal()
                try:
                    for candidate in candidates:
                        await _retry_one(db, candidate)
                finally:
                    db.close()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"[StuckMsgWatchdog] Erro no ciclo de verificação: {exc}", exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_S)
