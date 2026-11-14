"""
routes_bridge.py — Recebe mensagens dos bridges Baileys/Venom

[FIX 1] Normalização de tipos corrigida:
        Baileys → internal:  imageMessage→image, audioMessage→audio, etc.
[FIX 2] Sub-objetos de mídia passados ao webhook_handler
[FIX 3] _build_webhook_payload agora usa "whatsapp_business_account" como object
        ANTES: "bridge_message" → process_webhook rejeitava tudo (return "ignored")
        AGORA: "whatsapp_business_account" → entra no fluxo normal de processamento
[FIX 4] account_id embutido em metadata["account_id"] para que
        _process_incoming_messages possa propagar ao get_or_create_conversation
[FIX 5] process_webhook agora aceita account_id como kwarg
[FIX 6] _resolve_account_id com fallback para primeira conta ativa quando
        session_id não encontra correspondência exata
[NEW]   POST /bridge/sync — recebe histórico em lote (messages.set)
"""
from fastapi import APIRouter, Request, Depends, HTTPException
from sqlalchemy.orm import Session
import asyncio
from concurrent.futures import ThreadPoolExecutor
import logging
import time
import uuid
import os
from collections import deque
from datetime import datetime

from backend.database.connection import get_db, SessionLocal

# Pool dedicado para o processamento síncrono de webhooks (DB bloqueante).
# Incidente 2026-09-03: usar asyncio.to_thread() (executor padrão do loop,
# min(32, cpu+4) workers, COMPARTILHADO com qualquer outro to_thread do
# processo) fazia uma rajada de backfill encher a fila do executor padrão
# e travar até o /api/health (que também usa to_thread) atrás dela. Um
# executor próprio, do tamanho do pool de conexões do banco, isola essa
# fila — health checks e outras rotas leves não ficam mais reféns da fila
# de processamento de webhook/backfill.
WEBHOOK_EXECUTOR = ThreadPoolExecutor(max_workers=20, thread_name_prefix="webhook")


async def _run_in_webhook_executor(func, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(WEBHOOK_EXECUTOR, func, *args)


# ── Portao de carga (sync de historico x trafego ao vivo) ─────
# Historico antigo (POST /bridge/sync, nao-catchup) e trafego ao vivo dividem o
# mesmo executor e o mesmo pool de banco. Os bridges consultam GET
# /bridge/load ANTES de cada pagina de historico e esperam enquanto o backend
# estiver ocupado; alem disso o proprio /bridge/sync recusa (429) lotes de
# historico quando o sistema esta sobrecarregado, protegendo mesmo bridges que
# nao consultem o portao. Mensagem ao vivo e catch-up NUNCA sao recusados.
_LOAD_WINDOW_S = 60
_LIVE_BUSY_PER_MIN = int(os.getenv("HISTORY_GATE_LIVE_BUSY_PER_MIN", "20"))
_QUEUE_BUSY = int(os.getenv("HISTORY_GATE_QUEUE_BUSY", "5"))
# Mescla de historico: historico vindo de uma conta companion (Baileys) entra na
# conta primaria (WPPConnect), deduplicado por wamid. false = comportamento antigo
# (historico da companion e ignorado).
HISTORY_MERGE_FROM_FALLBACK = os.getenv("HISTORY_MERGE_FROM_FALLBACK", "true").lower() != "false"
_QUEUE_OVERLOADED = int(os.getenv("HISTORY_GATE_QUEUE_OVERLOADED", "20"))
_live_events: deque = deque()          # timestamps (epoch s) de mensagens ao vivo recebidas
_live_in_flight = 0
_sync_in_flight = 0


def _executor_queue_depth() -> int:
    try:
        return WEBHOOK_EXECUTOR._work_queue.qsize()
    except Exception:
        return 0


def _load_snapshot() -> dict:
    now = time.time()
    while _live_events and now - _live_events[0] > _LOAD_WINDOW_S:
        _live_events.popleft()
    live_per_min = len(_live_events)
    queue = _executor_queue_depth()
    if queue >= _QUEUE_OVERLOADED or _live_in_flight >= 10:
        level, delay_ms = "overloaded", 30000
    elif queue >= _QUEUE_BUSY or live_per_min >= _LIVE_BUSY_PER_MIN or _sync_in_flight >= 2:
        level, delay_ms = "busy", 8000
    else:
        level, delay_ms = "ok", 0
    return {
        "level": level,
        "suggested_delay_ms": delay_ms,
        "executor_queue": queue,
        "live_per_min": live_per_min,
        "live_in_flight": _live_in_flight,
        "sync_in_flight": _sync_in_flight,
    }
from backend.database.models import Message, MessageType, Direction, MessageStatus, Conversation
from backend.services.webhook_handler import webhook_handler, CIPHERTEXT_PLACEHOLDER
from backend.services.conversation_service import conversation_service
from backend.api.websocket import ws_manager
from backend.api.bridge_auth import require_bridge
from backend.api.routes_auth import get_current_user

logger = logging.getLogger(__name__)
router_bridge = APIRouter(prefix="/api/webhook", dependencies=[Depends(require_bridge)])

# ── Mapeamento de tipos Baileys → interno ─────────────────────
BAILEYS_TYPE_MAP = {
    "conversation":          "text",
    "extendedTextMessage":   "text",
    "imageMessage":          "image",
    "videoMessage":          "video",
    "audioMessage":          "audio",
    "pttMessage":            "audio",
    "documentMessage":       "document",
    "stickerMessage":        "sticker",
    "locationMessage":       "location",
    "contactMessage":        "contact",
    "reactionMessage":       "reaction",
    # passthrough: tipos já normalizados vindos de outros bridges
    "text":     "text",
    "image":    "image",
    "video":    "video",
    "audio":    "audio",
    "document": "document",
    "sticker":  "sticker",
    "location": "location",
    "reaction": "reaction",
    "contact":  "contact",
    # wppconnect (MessageType enum) usa nomenclatura própria — "chat" pra
    # texto e "ptt" pra áudio/voz, distintos de "audio". Sem isso, ambos
    # caíam no default "text" (chat por coincidência ficava certo; ptt não —
    # toda mensagem de voz era salva como texto vazio).
    "chat":         "text",
    "ptt":          "audio",
    "vcard":        "contact",
    "multi_vcard":  "contact",
}

# Tipos de PROTOCOLO/sistema do WhatsApp (não são mensagens de usuário) que o
# wa-web-bridge e o wppconnect-bridge encaminham sem filtrar (onAnyMessage
# cobre tudo, sem checar o tipo antes) — o Baileys não sofre disso porque já
# filtra/pré-formata do lado do bridge. Sem tratamento, esses tipos caem no
# fallback "text" do BAILEYS_TYPE_MAP e o campo "text" deles não é texto
# legível (ex.: e2e_notification manda o LID da contraparte em vez de um
# corpo de mensagem) — resultado: bolha confusa tipo "145436216164408@lid"
# no meio da conversa. Confirmado em produção: 78 e2e_notification e 21
# notification_template em 7 dias, então não é caso raro.
# gp2 (protocolo de gerenciamento de grupo v2) também vaza por aqui — já é
# tratado à parte por forwardGroupNotification/onNotificationMessage.
_IGNORED_RAW_TYPES = {
    "e2e_notification", "notification", "notification_template",
    "protocol", "hsm", "debug", "oversized", "broadcast_notification", "gp2",
}

# ciphertext = mensagem chegou mas ainda não pôde ser decifrada (sessão/chave
# não sincronizada a tempo) — tem significado real pro usuário (mesma
# situação que o WhatsApp oficial mostra como "aguardando esta mensagem"),
# por isso não entra no _IGNORED_RAW_TYPES: vira um placeholder em vez de
# sumir ou mostrar lixo. CIPHERTEXT_PLACEHOLDER vem de webhook_handler.py
# (não duplicado aqui) porque webhook_handler.py também precisa dele pra
# "curar" a mensagem se ela chegar decifrada depois com o mesmo wamid — ver
# comentário na idempotência de save de mensagem lá.


def _resolve_account_id(db: Session, session_id: str):
    """
    Busca o WhatsAppAccount pelo session_id.

    Fallback 1: se session_id for numérico, tenta como account_id direto.
    Fallback 2: retorna a primeira conta Baileys ativa disponível.
    Isso evita que _build_webhook_payload emita account_id=None e crie
    conversas órfãs (account_id=NULL) que não aparecem no frontend.
    """
    try:
        from backend.database.models import WhatsAppAccount
        from sqlalchemy import select
        import json

        # Tentativa 1 — correspondência exata por session_id
        account = db.execute(
            select(WhatsAppAccount).where(WhatsAppAccount.session_id == session_id)
        ).scalar_one_or_none()
        if account:
            return account.id

        # Tentativa 1.5 — session_id real só existe dentro de provider_config
        # (JSON) para várias contas (ex.: baileys/wppconnect neste banco têm a
        # coluna WhatsAppAccount.session_id NULL — só provider_config tem o
        # valor certo). Sem isso, essas contas sempre caem na Tentativa 3.
        candidates = db.execute(
            select(WhatsAppAccount).where(
                WhatsAppAccount.provider_type.in_(["baileys", "venom", "wppconnect", "whatsapp_web_js"]),
                WhatsAppAccount.is_active == True,
            )
        ).scalars().all()
        for acc in candidates:
            if not acc.provider_config:
                continue
            try:
                # provider_config e coluna JSON: pode voltar como str (json.dumps
                # gravado como string) ou ja como dict, conforme quem gravou.
                cfg = acc.provider_config
                if isinstance(cfg, str):
                    cfg = json.loads(cfg)
            except (ValueError, TypeError):
                continue
            if isinstance(cfg, dict) and cfg.get("session_id") == session_id:
                return acc.id

        # Tentativa 2 — session_id pode ser o próprio account_id numérico
        if session_id and str(session_id).isdigit():
            account = db.execute(
                select(WhatsAppAccount).where(WhatsAppAccount.id == int(session_id))
            ).scalar_one_or_none()
            if account:
                logger.info("[Bridge] session_id '%s' resolvido como account_id direto", session_id)
                return account.id

        # Tentativa 3 — fallback para primeira conta ativa entre os providers
        # não-oficiais. BUG anterior: scalar_one_or_none() sem limit(1) —
        # com mais de uma conta ativa (o caso normal aqui, com 4 contas de
        # teste) lançava MultipleResultsFound, caía no except abaixo e
        # retornava None silenciosamente. None faz get_or_create_conversation
        # casar com QUALQUER conversa existente do contato, ignorando de
        # qual conta ela é — misturando mensagens entre contas diferentes.
        account = db.execute(
            select(WhatsAppAccount).where(
                WhatsAppAccount.provider_type.in_(["baileys", "venom", "wppconnect", "whatsapp_web_js"]),
                WhatsAppAccount.is_active == True,
            ).order_by(WhatsAppAccount.id.asc()).limit(1)
        ).scalar_one_or_none()
        if account:
            logger.warning(
                "[Bridge] Nenhuma conta com session_id='%s'. "
                "Usando fallback account_id=%s (%s)",
                session_id, account.id, account.provider_type,
            )
            return account.id

        logger.warning("[Bridge] Nenhuma conta para session_id=%s e sem fallback disponível", session_id)
        return None

    except Exception as exc:
        logger.error("[Bridge] Erro ao resolver account_id: %s", exc)
        return None


def _is_fallback_only_account(db: Session, account_id) -> bool:
    """
    True quando account_id aponta pra uma conta Baileys criada só como
    fallback de ENVIO de outra conta (mesmo número real, ver
    provider_config.fallback_for_account_id — settings_router.post
    "/accounts/{id}/fallback" em routes_settings.py, e
    _find_baileys_fallback_account em routes.py).

    Uma conta fallback é um aparelho vinculado de verdade (sessão Baileys
    real e autenticada), então sem esse bloqueio ela ingeriria histórico e
    mensagens ao vivo IGUAL a qualquer conta normal — duplicando cada
    conversa da conta original numa segunda conta. Chamada logo após
    resolver account_id em qualquer handler que CRIA/atualiza
    conversa/contato/mensagem (não nos que só escopam uma query por
    account_id em cima de uma mensagem que JÁ existe, como /bridge/edit,
    /bridge/revoke e /bridge/poll-vote — esses não criam nada nem
    duplicam nada, então não precisam desse checque).

    Antes disso, esse bloqueio vivia só do lado do bridge Node
    (FALLBACK_ONLY_BAILEYS_SESSIONS, env var estática, exige restart do
    pm2 pra atualizar) — mover a fonte de verdade pra cá permite ligar/
    desligar o fallback de uma conta só editando o banco (via UI), sem
    precisar reiniciar nenhum bridge.
    """
    if not account_id:
        return False
    try:
        from backend.database.models import WhatsAppAccount
        import json
        account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == account_id).first()
        if not account or not account.provider_config:
            return False
        cfg = account.provider_config
        if isinstance(cfg, str):
            try:
                cfg = json.loads(cfg)
            except (ValueError, TypeError):
                return False
        return bool(cfg.get("fallback_for_account_id"))
    except Exception:
        return False


def _fallback_primary_account_id(db: Session, account_id):
    """
    Se account_id e uma conta companion/fallback (provider_config.fallback_for_account_id),
    devolve o id da conta PRIMARIA a que ela serve; senao None.

    Usado so na mescla de HISTORICO (ver _run_webhook_sync_batch_sync): o WPPConnect
    extrai o maximo e o Baileys companion completa o que faltar, gravando na mesma
    conta primaria. Trafego ao vivo da companion continua ignorado (nao duplica).
    """
    if not account_id:
        return None
    try:
        from backend.database.models import WhatsAppAccount
        import json
        account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == account_id).first()
        if not account or not account.provider_config:
            return None
        cfg = account.provider_config
        if isinstance(cfg, str):
            cfg = json.loads(cfg)
        primary = cfg.get("fallback_for_account_id")
        return int(primary) if primary else None
    except Exception:
        return None


def _normalize_message(payload: dict) -> dict:
    """
    Converte um payload do bridge para o formato interno do WebhookHandler.

    Suporta tipos de texto e mídia. Para mídia, adiciona o sub-objeto
    esperado pelo webhook_handler ({"image": {...}, "video": {...}, etc.)
    com a URL de download quando disponível.
    Propaga campos de grupo e direção para processamento completo.
    Propaga from_lid quando o bridge não conseguiu resolver o LID a tempo.
    """
    raw_type  = payload.get("type", "text")
    norm_type = BAILEYS_TYPE_MAP.get(raw_type, "text")

    # from_lid: LID numérico sem @lid enviado pelo bridge quando a resolução falhou.
    # Permite que o webhook_handler tente o fallback de lookup por lid no banco.
    from_lid_raw = payload.get("from_lid", "") or ""
    from_lid = from_lid_raw.split("@")[0] if from_lid_raw else ""

    msg_obj = {
        "id":              payload.get("wamid", f"bridge_{payload.get('session_id', 'x')}"),
        "from":            payload.get("from", ""),
        "to":              payload.get("to", ""),
        "type":            norm_type,
        "timestamp":       str(int(payload.get("timestamp", 0) / 1000)),  # ms → s
        "pushName":        payload.get("contact_name") or payload.get("push_name", ""),
        "direction":       payload.get("direction", "inbound"),
        "is_group":        payload.get("is_group", False),
        "group_jid":       payload.get("group_jid"),
        "group_name":      payload.get("group_name") or payload.get("group_subject"),
        "participant":     payload.get("participant"),
        "reply_to_wamid":  payload.get("reply_to_wamid"),
        "mentions":        payload.get("mentions", []),
        "forwarded":       payload.get("forwarded", False),
        "forward_score":   payload.get("forward_score", 0),
        "vcard":           payload.get("vcard"),
        "vcard_name":      payload.get("vcard_name", ""),
        "vcards":          payload.get("vcards"),
        "revoked_wamid":   payload.get("revoked_wamid"),
        "from_lid":        from_lid,  # LID numérico, vazio se resolvido ou não aplicável
        "interactive_payload": payload.get("interactive_payload"),  # ex.: dados de enquete recebida
    }

    if norm_type == "text":
        msg_obj["text"] = {"body": payload.get("text", "")}

    elif norm_type in ("image", "video", "sticker"):
        msg_obj[norm_type] = {
            "id":       payload.get("media_id", ""),
            "mime_type": payload.get("mimetype", ""),
            "caption":  payload.get("caption", ""),
            "url":      payload.get("media_url", ""),
        }

    elif norm_type == "audio":
        msg_obj["audio"] = {
            "id":       payload.get("media_id", ""),
            "mime_type": payload.get("mimetype", "audio/ogg; codecs=opus"),
            "voice":    payload.get("ptt", False),
            "url":      payload.get("media_url", ""),
        }

    elif norm_type == "document":
        msg_obj["document"] = {
            "id":       payload.get("media_id", ""),
            "mime_type": payload.get("mimetype", ""),
            "filename": payload.get("filename", "arquivo"),
            "caption":  payload.get("caption", ""),
            "url":      payload.get("media_url", ""),
        }

    elif norm_type == "location":
        loc = payload.get("location", {})
        msg_obj["location"] = {
            "latitude":  loc.get("latitude", 0),
            "longitude": loc.get("longitude", 0),
            "name":      loc.get("name", ""),
        }

    elif norm_type == "reaction":
        msg_obj["reaction"] = {
            "message_id": payload.get("reaction_message_id", ""),
            "emoji":      payload.get("reaction_emoji", ""),
        }

    return msg_obj


def _build_webhook_payload(provider: str, session_id: str, account_id, msg_obj: dict, is_history: bool = False) -> dict:
    """
    Monta o envelope no formato que process_webhook espera.
    Inclui dados de contato e grupo para máximo de informação preservada.

    is_history=True identifica mensagens vindas do resync de histórico
    (POST /bridge/sync, disparado ao conectar/reconectar) — mensagens de
    antes da sessão existir não fazem sentido entrar como "aberta" na fila
    de atendimento. Ver uso em _process_incoming_messages.
    """
    contacts = [{
        "profile": {"name": msg_obj.get("pushName", "")},
        "pushName": msg_obj.get("pushName", ""),
        "wa_id": msg_obj.get("from", ""),
    }]

    # Se é mensagem de grupo com participante identificado, adiciona contato do participante
    participant = msg_obj.get("participant")
    if participant and participant != msg_obj.get("from", ""):
        participant_phone = participant.split("@")[0]
        contacts.append({
            "profile": {"name": msg_obj.get("pushName", "")},
            "pushName": msg_obj.get("pushName", ""),
            "wa_id": participant_phone,
        })

    return {
        "object": "whatsapp_business_account",
        "bridge_provider": provider,
        "session_id":      session_id,
        "account_id":      account_id,
        "entry": [{
            "changes": [{
                "value": {
                    "messages": [msg_obj],
                    "contacts": contacts,
                    "metadata": {
                        "phone_number_id": f"bridge_{session_id}",
                        "account_id":      account_id,
                        "is_history":      is_history,
                    },
                }
            }]
        }],
    }


# ── POST /bridge ──────────────────────────────────────────────

def _run_webhook_processing_sync(provider: str, session_id: str, payload: dict) -> None:
    """
    Roda TODO o processamento de uma mensagem ao vivo (resolver conta,
    normalizar, salvar no banco, baixar mídia, emitir websocket) com sua
    PRÓPRIA sessão de banco e seu PRÓPRIO event loop isolado (asyncio.run —
    necessário porque process_webhook faz `await` de verdade, ex.: download
    de mídia via httpx). SEMPRE chamada via asyncio.to_thread, nunca direto.

    Por quê: o driver do banco (pymysql) é síncrono e bloqueante — rodando
    isso direto na rota, ele trava o ÚNICO event loop do processo (uvicorn
    --workers 1) pelo tempo inteiro do processamento, e mais NADA no
    servidor consegue avançar nesse meio tempo (nem um /api/health que nem
    toca banco). Confirmado ao vivo 2x em 2026-09-02. Rodar numa thread
    separada libera o loop principal pra continuar atendendo tudo mais
    enquanto essa thread (com sua própria conexão do pool) processa.

    O broadcast de websocket dentro de process_webhook continua funcionando
    porque ws_manager._emit() detecta que está sendo chamado de fora do
    loop principal e usa run_coroutine_threadsafe pra voltar pra lá — ver
    capture_main_loop()/_emit() em backend/api/websocket.py.
    """
    db = SessionLocal()
    try:
        account_id = _resolve_account_id(db, session_id)
        if _is_fallback_only_account(db, account_id):
            return {"status": "ok", "ignored": "fallback_only_account"}
        msg_obj    = _normalize_message(payload)
        normalized = _build_webhook_payload(provider, session_id, account_id, msg_obj)
        asyncio.run(webhook_handler.process_webhook(db, normalized, account_id=account_id))
    finally:
        db.close()


@router_bridge.post("/bridge")
async def receive_bridge_message(request: Request):
    """
    Recebe uma mensagem em tempo real do bridge Baileys/Venom.
    """
    payload    = await request.json()
    provider   = payload.get("bridge_provider", "unknown")
    session_id = payload.get("session_id", "default")
    raw_type   = payload.get("type")

    logger.info("[Bridge] Mensagem — provider=%s session=%s type=%s from=%s",
                provider, session_id, raw_type, payload.get("from"))

    if raw_type in _IGNORED_RAW_TYPES:
        logger.info("[Bridge] Ignorando evento de protocolo (type=%s) — não é mensagem de usuário", raw_type)
        return {"status": "ok"}
    if raw_type == "ciphertext":
        payload["text"] = CIPHERTEXT_PLACEHOLDER

    global _live_in_flight
    _live_events.append(time.time())
    _live_in_flight += 1
    try:
        await _run_in_webhook_executor(_run_webhook_processing_sync, provider, session_id, payload)
    except Exception as exc:
        logger.error("[Bridge] Erro ao processar mensagem: %s", exc, exc_info=True)
        # Incidente real (2026-09-01): isso retornava 200 OK mesmo com o
        # processamento falhando — o bridge (axios) via "sucesso" e nunca
        # tentava de novo nem registrava a falha, então a mensagem sumia
        # sem deixar rastro. Propaga como erro pra postWebhookWithRetry
        # (bridge) fazer retry e, se persistir, chamar /bridge/register-failed.
        raise HTTPException(status_code=500, detail=f"Falha ao processar mensagem: {exc}")
    finally:
        _live_in_flight = max(0, _live_in_flight - 1)

    return {"status": "ok"}


# ── POST /bridge/register-failed ────────────────────────────────
# Chamado pelo bridge (postWebhookWithRetry) quando TODAS as tentativas de
# entregar /bridge falharam. Faz uma última tentativa de processar normal —
# cobre o backend ter voltado a responder nesse meio-tempo — e só cria um
# placeholder visível (status=FAILED, "!" vermelho no front) se isso
# também falhar, guardando o payload original pra permitir retry manual.
@router_bridge.post("/bridge/register-failed")
async def register_bridge_failed(request: Request, db: Session = Depends(get_db)):
    payload    = await request.json()
    provider   = payload.get("bridge_provider", "unknown")
    session_id = payload.get("session_id", "default")
    account_id = _resolve_account_id(db, session_id)
    if _is_fallback_only_account(db, account_id):
        return {"status": "ok", "ignored": "fallback_only_account"}

    try:
        msg_obj    = _normalize_message(payload)
        normalized = _build_webhook_payload(provider, session_id, account_id, msg_obj)
        await webhook_handler.process_webhook(db, normalized, account_id=account_id)
        logger.info("[Bridge] register-failed: mensagem recuperada de primeira (backend já tinha voltado)")
        return {"status": "ok", "recovered": True}
    except Exception as exc:
        logger.error("[Bridge] register-failed: processamento falhou de novo (%s) — criando placeholder visível", exc)

    wamid        = payload.get("wamid") or f"bridge_{session_id}_{int(time.time() * 1000)}"
    is_group     = bool(payload.get("is_group"))
    group_jid    = payload.get("group_jid")
    group_name   = payload.get("group_name")
    is_outbound  = payload.get("direction") == "outbound"
    from_id      = (payload.get("from") or "").split("@")[0]
    to_id        = (payload.get("to") or "").split("@")[0]

    if is_group and group_jid:
        chat_wa_id = group_jid
    elif is_outbound and to_id and to_id != "me":
        chat_wa_id = to_id
    else:
        chat_wa_id = from_id

    if not chat_wa_id:
        logger.error("[Bridge] register-failed: payload sem from/to, impossível atribuir a uma conversa — só resta o dead-letter local do bridge")
        return {"status": "error", "recovered": False}

    contact = conversation_service.get_or_create_contact(
        db, wa_id=chat_wa_id, phone_number=chat_wa_id,
        is_group=is_group, group_subject=group_name,
    )
    conversation = conversation_service.get_or_create_conversation(
        db, contact.id, account_id=account_id, is_group=is_group,
        group_jid=group_jid, group_name=group_name,
    )

    direction_enum = Direction.OUTBOUND if is_outbound else Direction.INBOUND
    ts = int(payload.get("timestamp") or time.time() * 1000)

    existing = db.query(Message).filter(
        Message.wamid == wamid, Message.conversation_id == conversation.id
    ).first()
    if existing:
        message = existing
    else:
        message = Message(
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type=MessageType.TEXT,
            direction=direction_enum,
            message_text="Mensagem não pôde ser recebida",
            status=MessageStatus.FAILED,
            timestamp=ts,
            failed_payload=payload,
        )
        db.add(message)
        conversation.last_message_at = datetime.fromtimestamp(ts / 1000)
        db.commit()
        db.refresh(message)

    await ws_manager.broadcast_new_message({
        **conversation_service._format_message(message),
        "conversation_id": conversation.id,
    })

    return {"status": "ok", "recovered": False, "message_id": message.id}


# ── POST /bridge/retry-failed/{message_id} ──────────────────────
# Clique manual no "!" vermelho no front. Reprocessa o payload original
# guardado — se o webhook_handler achar o mesmo wamid+conversation_id, ele
# ATUALIZA essa linha no lugar (ver "era FAILED" em webhook_handler.py) em
# vez de criar uma segunda mensagem.
@router_bridge.post("/bridge/retry-failed/{message_id}")
async def retry_bridge_failed(message_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    message = db.query(Message).filter(Message.id == message_id).first()
    if not message:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    if message.status != MessageStatus.FAILED or not message.failed_payload:
        raise HTTPException(status_code=400, detail="Essa mensagem não está com falha pendente de recuperação")

    payload    = message.failed_payload
    provider   = payload.get("bridge_provider", "unknown")
    session_id = payload.get("session_id", "default")
    account_id = _resolve_account_id(db, session_id)
    if _is_fallback_only_account(db, account_id):
        return {"status": "ok", "ignored": "fallback_only_account"}

    try:
        msg_obj    = _normalize_message(payload)
        normalized = _build_webhook_payload(provider, session_id, account_id, msg_obj)
        await webhook_handler.process_webhook(db, normalized, account_id=account_id)
    except Exception as exc:
        logger.error("[Bridge] retry-failed: ainda não foi possível recuperar mensagem #%s: %s", message_id, exc)
        raise HTTPException(status_code=502, detail=f"Ainda não foi possível recuperar: {exc}")

    db.refresh(message)
    if message.status == MessageStatus.FAILED:
        raise HTTPException(status_code=502, detail="Reprocessado, mas a mensagem continua sem conteúdo recuperado")

    return {
        "success": True,
        "message": "Mensagem recuperada com sucesso",
        "data": {"message": conversation_service._format_message(message)},
    }


# ── POST /bridge/sync ─────────────────────────────────────────

def _run_webhook_sync_batch_sync(provider: str, session_id: str, messages: list, catchup: bool = False) -> tuple:
    """
    Roda o LOTE inteiro de histórico numa única thread/loop/sessão — ver
    _run_webhook_processing_sync acima pro porquê (mesmo motivo, mesma
    técnica). Um hop de thread só por requisição HTTP (não um por
    mensagem): o lote inteiro processa em sequência ali dentro, e o loop
    principal do processo fica livre o tempo todo pra atender qualquer
    outra coisa nesse meio tempo — era exatamente essa rota (resync de
    histórico, chamada com dezenas de mensagens de uma vez) a responsável
    pelo incidente de 2026-09-02 com o backfill automático.
    """
    db = SessionLocal()
    saved = 0
    skipped = 0
    merged_into = None

    async def _run_all():
        nonlocal saved, skipped, merged_into
        account_id = _resolve_account_id(db, session_id)
        if _is_fallback_only_account(db, account_id):
            # Companion/fallback: so HISTORICO antigo e aceito, e entra na conta
            # primaria (mescla). Catch-up (mensagem "ao vivo" atrasada) segue ignorado.
            primary_id = _fallback_primary_account_id(db, account_id)
            if catchup or not HISTORY_MERGE_FROM_FALLBACK or not primary_id:
                return
            merged_into = primary_id
            account_id = primary_id
        for msg_payload in messages:
            raw_type = msg_payload.get("type")
            if raw_type in _IGNORED_RAW_TYPES:
                skipped += 1
                continue
            if raw_type == "ciphertext":
                msg_payload["text"] = CIPHERTEXT_PLACEHOLDER

            msg_obj    = _normalize_message(msg_payload)
            # catchup=True: mensagens REAIS que chegaram atrasadas (sessão caída) — entram como
            # não lidas e em conversa aberta, ao contrário do resync de histórico antigo.
            # A guarda de mensagem velha (>1h) do webhook_handler continua valendo: sem bot/auto-reply.
            normalized = _build_webhook_payload(provider, session_id, account_id, msg_obj, is_history=not catchup)
            try:
                await webhook_handler.process_webhook(db, normalized, account_id=account_id)
                saved += 1
            except Exception as exc:
                logger.warning("[Bridge:sync] Mensagem ignorada: %s", exc)
                skipped += 1

    try:
        asyncio.run(_run_all())
    finally:
        db.close()
    return saved, skipped, merged_into


@router_bridge.post("/bridge/sync")
async def receive_bridge_sync(request: Request):
    """
    Recebe histórico de mensagens em lote ao autenticar (messages.set do Baileys).
    Processa cada mensagem individualmente — duplicatas são ignoradas pelo
    webhook_handler via wamid único.
    """
    payload    = await request.json()
    provider   = payload.get("bridge_provider", "baileys")
    session_id = payload.get("session_id", "default")
    messages   = payload.get("messages", [])
    catchup    = bool(payload.get("catchup", False))

    logger.info("[Bridge:sync] session=%s mensagens=%d catchup=%s", session_id, len(messages), catchup)

    # Historico antigo cede lugar ao trafego ao vivo: sobrecarregado -> 429 e o
    # bridge tenta de novo depois (ver history-gate). Catch-up passa sempre.
    if not catchup:
        snap = _load_snapshot()
        if snap["level"] == "overloaded":
            raise HTTPException(
                status_code=429,
                detail="backend sobrecarregado — tente o lote de historico novamente",
                headers={"Retry-After": str(max(1, snap["suggested_delay_ms"] // 1000))},
            )

    global _sync_in_flight
    _sync_in_flight += 1
    try:
        saved, skipped, merged_into = await _run_in_webhook_executor(_run_webhook_sync_batch_sync, provider, session_id, messages, catchup)
    finally:
        _sync_in_flight = max(0, _sync_in_flight - 1)

    logger.info("[Bridge:sync] Concluído — salvas=%d ignoradas=%d merged_into=%s", saved, skipped, merged_into)
    return {"status": "ok", "saved": saved, "skipped": skipped, "merged_into": merged_into}


@router_bridge.get("/bridge/load")
async def bridge_load():
    """Carga atual do backend p/ os bridges decidirem o ritmo do sync de
    historico (ver history-gate nos bridges). Barato: so le contadores."""
    return _load_snapshot()


# ── POST /bridge/missing ──────────────────────────────────────

def _find_missing_wamids_sync(session_id: str, wamids: list) -> list:
    db = SessionLocal()
    try:
        account_id = _resolve_account_id(db, session_id)
        q = db.query(Message.wamid).join(Conversation, Message.conversation_id == Conversation.id).filter(
            Message.wamid.in_(wamids)
        )
        if account_id is not None:
            q = q.filter(Conversation.account_id == account_id)
        existing = {row[0] for row in q.all()}
        return [w for w in wamids if w not in existing]
    finally:
        db.close()


@router_bridge.post("/bridge/missing")
async def bridge_missing(request: Request):
    """Dos wamids enviados, devolve os que AINDA não existem no banco dessa conta.
    Deixa o bridge só buscar/enviar o que falta na recuperação de mensagens
    perdidas, em vez de reenviar duplicatas (cada uma custa processamento e um
    evento new_message no WebSocket). Falso "faltando" é inofensivo: o
    /bridge/sync continua deduplicando por wamid."""
    payload    = await request.json()
    session_id = payload.get("session_id", "default")
    wamids     = [w for w in (payload.get("wamids") or []) if isinstance(w, str)][:500]
    if not wamids:
        return {"status": "ok", "missing": []}
    missing = await _run_in_webhook_executor(_find_missing_wamids_sync, session_id, wamids)
    return {"status": "ok", "missing": missing}


# ── POST /bridge/status ───────────────────────────────────────

@router_bridge.post("/bridge/status")
async def receive_bridge_status(request: Request):
    """Recebe atualizações de status (read/delivered) dos bridges."""
    payload = await request.json()
    logger.info("[Bridge] Status — provider=%s msg_id=%s",
                payload.get("bridge_provider"), payload.get("message_id"))

    message_id = payload.get("message_id")
    if not message_id:
        return {"status": "ok"}

    # BUG (2026-09-04): só entendia o formato de "receipts" (Baileys, ver
    # update.receipt no bridge) — o bridge WPPConnect nunca mandou isso,
    # manda um `status` já traduzido em string ("delivered"/"read", ver
    # forwardStatusUpdate no bridge). Sem aceitar esse campo, TODO status
    # de conta WPPConnect (SAC-01/POS-01/RMA-01/TI-01) caía sempre no
    # default "delivered" — nunca progredia pra "read" (preto), e nem
    # isso chegava a valer de verdade por causa do bug de wamid errado
    # (ver ack.id?._serialized no bridge) que fazia a mensagem nunca ser
    # encontrada no banco, travando tudo em "enviado" (só).
    explicit_status = payload.get("status")
    if explicit_status in ("delivered", "read"):
        status_value = explicit_status
    else:
        receipts = payload.get("receipts", {})
        status_value = "delivered"
        if receipts.get("readTimestamp") or receipts.get("playedTimestamp"):
            status_value = "read"

    from backend.services.webhook_handler import webhook_handler
    from backend.database.connection import SessionLocal
    db = SessionLocal()
    try:
        value = {
            "statuses": [
                {
                    "id": message_id,
                    "status": status_value
                }
            ]
        }
        await webhook_handler._process_message_statuses(db, value)
    except Exception as e:
        logger.error(f"Erro ao processar status bridge: {e}")
    finally:
        db.close()
        
    return {"status": "ok"}


# ── POST /bridge/contacts ─────────────────────────────────────

@router_bridge.post("/bridge/contacts")
async def receive_bridge_contacts(request: Request, db: Session = Depends(get_db)):
    """
    Recebe mapeamentos LID→phone do bridge via contacts.upsert.

    Cada item deve conter wa_id (telefone real) e lid (LID Baileys sem @lid).
    O serviço registra o mapeamento, corrige contatos fantasma criados com
    o LID como wa_id e mescla conversas se necessário.
    """
    from backend.services.conversation_service import conversation_service as cs

    payload  = await request.json()
    contacts = payload.get("contacts", [])
    session_id = payload.get("session_id", "default")
    account_id = _resolve_account_id(db, session_id)
    if _is_fallback_only_account(db, account_id):
        return {"status": "ok", "ignored": "fallback_only_account"}
    resolved = 0
    skipped  = 0

    for c in contacts:
        lid  = c.get("lid", "")
        wa_id = c.get("wa_id", "")
        push_name = c.get("push_name", "")
        # saved_name: nome real da agenda de endereços (Baileys c.name), distinto do
        # push_name (nome que a própria pessoa define). Só existe quando o contato
        # está de fato salvo na agenda do telefone vinculado à sessão.
        saved_name = c.get("contact_name", "")

        if not lid or not wa_id:
            skipped += 1
            continue

        # Remove sufixos JID para normalizar
        lid_clean   = lid.split("@")[0] if "@" in lid else lid
        phone_clean = wa_id.split("@")[0] if "@" in wa_id else wa_id

        # Ignora se LID == phone (não é um LID real)
        if lid_clean == phone_clean:
            skipped += 1
            continue

        ok = cs.register_lid_mapping(
            db,
            lid=lid_clean,
            phone_number=phone_clean,
            push_name=push_name or None,
            saved_name=saved_name or None,
            account_id=account_id,
        )
        if ok:
            resolved += 1
        else:
            skipped += 1

    logger.info("[Bridge/contacts] LID mappings — resolvidos=%d ignorados=%d", resolved, skipped)
    return {"status": "ok", "resolved": resolved, "skipped": skipped}


# ── POST /bridge/poll-vote ────────────────────────────────────

@router_bridge.post("/bridge/poll-vote")
async def receive_bridge_poll_vote(request: Request, db: Session = Depends(get_db)):
    """
    Recebe a contagem agregada de votos de uma enquete.

    O voto (pollUpdateMessage) é decifrado e agregado do lado da bridge
    (handlePollVote em index.js) — aqui só re-renderiza o texto salvo da
    mensagem da enquete original com a contagem atual e notifica os clientes
    via WebSocket, em vez de criar uma mensagem nova a cada voto (que é como
    o WhatsApp de verdade se comporta: voto atualiza a enquete, não vira uma
    mensagem na conversa).
    """
    payload      = await request.json()
    session_id   = payload.get("session_id", "default")
    poll_wamid   = payload.get("poll_wamid")
    options      = payload.get("options", [])
    total_voters = payload.get("total_voters", 0)

    if not poll_wamid:
        return {"status": "ok"}

    # Escopado por conta: o mesmo wamid pode existir em contas diferentes
    # (eco multi-device entre providers ligados ao mesmo número real).
    account_id = _resolve_account_id(db, session_id)
    query = db.query(Message).filter(Message.wamid == poll_wamid)
    if account_id is not None:
        query = query.join(Conversation, Message.conversation_id == Conversation.id).filter(
            Conversation.account_id == account_id
        )
    message = query.first()
    if not message:
        logger.warning("[Bridge/poll-vote] wamid desconhecido: %s", poll_wamid)
        return {"status": "ok"}

    question = (message.message_text or "").split("\n", 1)[0]
    if not question.startswith("📊"):
        question = f"📊 {question}"

    lines = [question]
    for opt in options:
        name  = opt.get("name", "")
        votes = opt.get("votes", 0)
        mark  = "☑️" if votes else "☐"
        lines.append(f"{mark} {name} — {votes} voto(s)")
    if total_voters:
        lines.append(f"👥 {total_voters} voto(s) no total")

    message.message_text = "\n".join(lines)

    # Estrutura pro front renderizar a enquete com apuração de verdade (marca
    # quem tem mais votos, contagem por opção) em vez de só o texto formatado
    # acima — esse texto continua existindo como fallback pra quem não tem a
    # UI de enquete (ex.: buscas). Preserva question/options originais quando
    # já existentes (poll criada por nós, via wa-web/wppconnect); senão
    # reconstrói a partir do texto/voto (caso Baileys, que nunca populava
    # interactive_payload na criação).
    existing = message.interactive_payload or {}
    clean_question = (existing.get("question") or question.lstrip("📊").strip())
    option_names = existing.get("options") or [o.get("name", "") for o in options]
    message.interactive_payload = {
        "type": "poll",
        "question": clean_question,
        "options": option_names,
        "votes": [{"name": o.get("name", ""), "count": o.get("votes", 0)} for o in options],
        "total_voters": total_voters,
    }
    db.commit()

    await ws_manager.broadcast_poll_update({
        "wamid": poll_wamid,
        "message": message.message_text,
    })


# ── POST /bridge/edit ─────────────────────────────────────────

@router_bridge.post("/bridge/edit")
async def receive_bridge_edit(request: Request, db: Session = Depends(get_db)):
    """
    Recebe edição de mensagem feita pelo CONTATO (messages.update / MESSAGE_EDIT).

    Diferente da revogação (delete-for-everyone), o WhatsApp não reenvia a
    mensagem editada via messages.upsert — o novo texto só chega pelo evento
    messages.update do Baileys. Atualiza o texto salvo e notifica os clientes
    via WebSocket, em vez de criar uma mensagem nova.
    """
    payload    = await request.json()
    session_id = payload.get("session_id", "default")
    wamid      = payload.get("wamid")
    new_text   = payload.get("new_text", "")

    if not wamid or not new_text:
        return {"status": "ok"}

    # Escopado por conta: o mesmo wamid pode existir em contas diferentes
    # (eco multi-device entre providers ligados ao mesmo número real).
    account_id = _resolve_account_id(db, session_id)
    query = db.query(Message).filter(Message.wamid == wamid)
    if account_id is not None:
        query = query.join(Conversation, Message.conversation_id == Conversation.id).filter(
            Conversation.account_id == account_id
        )
    message = query.first()
    if not message:
        logger.warning("[Bridge/edit] wamid desconhecido: %s", wamid)
        return {"status": "ok"}

    message.message_text = new_text
    db.commit()

    await ws_manager.broadcast_message_edit({
        "wamid": wamid,
        "new_text": new_text,
    })

    return {"status": "ok"}


# ── POST /bridge/revoke ───────────────────────────────────────

REVOKED_PLACEHOLDER = "🚫 Esta mensagem foi apagada"


@router_bridge.post("/bridge/revoke")
async def receive_bridge_revoke(request: Request, db: Session = Depends(get_db)):
    """
    Recebe revogação de mensagem (delete-for-everyone) feita pelo CONTATO.

    Gap conhecido até aqui: revoked_wamid chegava embutido no payload da
    mensagem genérica (/bridge, type="revoke") mas "revoke" nunca foi um
    tipo reconhecido em nenhum dispatch — a revogação era descartada
    silenciosamente e a mensagem original continuava aparecendo normal.
    Mesmo padrão de /bridge/edit: acha a mensagem original por wamid,
    substitui o texto por um placeholder e notifica via WebSocket (reusa
    message_edit_update — é a mesma operação do ponto de vista do
    frontend: "o texto desta mensagem existente mudou").
    """
    payload      = await request.json()
    session_id   = payload.get("session_id", "default")
    revoked_wamid = payload.get("revoked_wamid")

    if not revoked_wamid:
        return {"status": "ok"}

    # Escopado por conta — mesmo racional do /bridge/edit e /bridge/poll-vote:
    # o mesmo wamid pode existir em contas diferentes (eco multi-device).
    account_id = _resolve_account_id(db, session_id)
    query = db.query(Message).filter(Message.wamid == revoked_wamid)
    if account_id is not None:
        query = query.join(Conversation, Message.conversation_id == Conversation.id).filter(
            Conversation.account_id == account_id
        )
    message = query.first()
    if not message:
        logger.warning("[Bridge/revoke] wamid desconhecido: %s", revoked_wamid)
        return {"status": "ok"}

    message.message_text = REVOKED_PLACEHOLDER
    db.commit()

    await ws_manager.broadcast_message_edit({
        "wamid": revoked_wamid,
        "new_text": REVOKED_PLACEHOLDER,
    })

    return {"status": "ok"}


# ── POST /bridge/group-notification ───────────────────────────

@router_bridge.post("/bridge/group-notification")
async def receive_bridge_group_notification(request: Request, db: Session = Depends(get_db)):
    """
    Recebe eventos nativos de grupo do Baileys (participante removido, promovido
    a admin, nome/descrição alterados, mensagens temporárias, etc.) que hoje só
    aparecem no WhatsApp normal — e grava como mensagem de sistema na conversa
    do grupo para aparecer também no front da aplicação.
    """
    payload    = await request.json()
    session_id = payload.get("session_id", "default")
    group_jid  = payload.get("group_jid")
    text       = payload.get("text")
    timestamp  = payload.get("timestamp") or int(time.time() * 1000)

    if not group_jid or not text:
        return {"status": "ok"}

    account_id = _resolve_account_id(db, session_id)
    if _is_fallback_only_account(db, account_id):
        return {"status": "ok", "ignored": "fallback_only_account"}
    contact = conversation_service.get_or_create_contact(db, group_jid, group_jid, is_group=True)
    conversation = conversation_service.get_or_create_conversation(
        db, contact.id, account_id=account_id, is_group=True, group_jid=group_jid,
    )

    message = Message(
        wamid=f"sysnotif_{uuid.uuid4().hex}",
        conversation_id=conversation.id,
        contact_id=contact.id,
        message_type=MessageType.TEXT,
        direction=Direction.INBOUND,
        message_text=text,
        status=MessageStatus.DELIVERED,
        timestamp=timestamp,
    )
    db.add(message)
    # Mesmo bug do webhook_handler.py: sem isso, notificação de grupo nunca
    # subia a conversa na lista, mesmo sendo atividade real.
    conversation.last_message_at = datetime.fromtimestamp(timestamp / 1000)
    db.commit()
    db.refresh(message)

    await ws_manager.broadcast_new_message({
        "wamid": message.wamid,
        "type": "text",
        "direction": "inbound",
        "from_number": group_jid.split("@")[0],
        "contact_name": contact.name,
        "is_group": True,
        "group_jid": group_jid,
        "group_name": contact.name,
        "message": text,
        "timestamp": message.timestamp,
        "status": "delivered",
        "sender": "contact",
        "conversation_id": conversation.id,
    })

    return {"status": "ok"}

    return {"status": "ok"}
