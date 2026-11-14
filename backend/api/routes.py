from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Response, Request
import uuid
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import logging
import os
import re
from pathlib import Path
import aiofiles
import httpx
from datetime import datetime, timedelta # <-- ADDED timedelta
from sqlalchemy import func # <-- ADDED func

# Importações do projeto
from backend.database.connection import get_db
from backend.services.whatsapp_service import WhatsAppService, WhatsAppAPIError
from backend.services.conversation_service import ConversationService, _br_mobile_alt_wa_id
from backend.api.routes_auth import get_current_user
from backend.api.bridge_auth import require_bridge
from backend.api.permissions import user_has_permission
from backend.api.websocket import ws_manager
from backend.models.database_models import Message, Direction, MessageStatus, Conversation, Contact, MediaFile  # <-- ADDED MediaFile
from backend.database.models import WhatsAppAccount
from backend.providers.factory import get_unofficial_provider, normalize_provider_type, UNOFFICIAL_PROVIDER_TYPES
from backend.utils.media_converter import normalize_media
from backend.utils.display_name import format_display_name, build_identity_prefix
from backend.models.schemas import (
    # Básicos
    SendTextMessage,
    SendMediaMessage,
    SendLocationMessage,
    SendTemplateMessage,
    MarkMessageRead,
    APIResponse,
    # NOVOS
    SendContactMessage,
    SendInteractiveMessage,
    SendReactionMessage,
    RemoveReactionMessage,
    SendInteractiveButtonsRequest,
    SendInteractiveListRequest,
    SendInteractiveProductRequest,
    SendInteractiveProductListRequest,
    SendCtaUrlButtonRequest
)

logger = logging.getLogger(__name__)

conversation_service = ConversationService()

_UNOFFICIAL_PROVIDERS = UNOFFICIAL_PROVIDER_TYPES


def _get_account(db: Session, account_id: Optional[int]) -> Optional[WhatsAppAccount]:
    """Busca a conta pelo id, ou a primeira conta ativa disponível."""
    if account_id:
        acc = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == account_id).first()
        if acc:
            return acc
    return db.query(WhatsAppAccount).filter(WhatsAppAccount.is_active == True).first()


def get_provider(db: Session, account_id: Optional[int]):
    """Retorna o provider correto (bridge não-oficial ou WhatsAppService Meta) para a conta."""
    account = _get_account(db, account_id)
    provider_str = normalize_provider_type(account.provider_type) if account else None
    if account and provider_str == "site_chat":
        from backend.providers.site_chat_provider import SiteChatProvider
        return SiteChatProvider({"account_id": account.id}), "site_chat"
    if account and provider_str in _UNOFFICIAL_PROVIDERS:
        raw = account.provider_config or {}
        if isinstance(raw, str):
            import json as _json
            try:
                raw = _json.loads(raw)
            except (ValueError, TypeError):
                raw = {}
        config: dict = raw
        config.setdefault("session_id", account.session_id or "default")
        return get_unofficial_provider(provider_str, config), provider_str
    # Meta Cloud API
    if account and account.meta_phone_number_id and account.meta_access_token:
        return WhatsAppService(
            phone_number_id=account.meta_phone_number_id,
            access_token=account.meta_access_token,
            provider_type=account.provider_type,
        ), "meta"
    # Sem conta válida configurada — erro explícito em vez de fallback silencioso
    if account:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Conta #{account.id} ({account.provider_type}) não está com as credenciais "
                "configuradas. Para Meta: preencha Phone Number ID e Access Token. "
                "Para Baileys/bridge: certifique-se de que o bridge está rodando."
            )
        )
    raise HTTPException(
        status_code=400,
        detail=(
            "Nenhuma conta WhatsApp ativa encontrada. "
            "Cadastre uma conta em Configurações → Contas WA antes de enviar mensagens."
        )
    )


def get_whatsapp_service(db: Session, account_id: Optional[int]) -> WhatsAppService:
    """Compatibilidade: retorna WhatsAppService com credenciais da conta correta (somente Meta)."""
    account = _get_account(db, account_id)
    if account and account.meta_phone_number_id and account.meta_access_token:
        return WhatsAppService(
            phone_number_id=account.meta_phone_number_id,
            access_token=account.meta_access_token,
        )
    raise ValueError(f"Não foi possível inicializar WhatsAppService. Credenciais Meta ausentes para account_id={account_id}.")


def _resolve_account_id(db: Session, account_id: Optional[int], wa_id: str) -> Optional[int]:
    """
    Retorna account_id explícito quando fornecido.
    Caso contrário, tenta descobrir a conta pela conversa mais recente do contato.
    """
    if account_id:
        return account_id
    contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()
    if not contact:
        alt_wa_id = _br_mobile_alt_wa_id(wa_id)
        if alt_wa_id:
            contact = db.query(Contact).filter(Contact.wa_id == alt_wa_id).first()
    if not contact and "@g.us" in wa_id:
        # Grupo pode estar salvo sem o sufixo @g.us (dado legado) — tenta a
        # variante sem sufixo antes de desistir e cair no fallback de
        # "primeira conta ativa" em get_provider(), que pode escolher a
        # conta errada quando há mais de uma configurada.
        contact = db.query(Contact).filter(Contact.wa_id == wa_id.split("@")[0]).first()
    if contact:
        conv = (
            db.query(Conversation)
            .filter(Conversation.contact_id == contact.id, Conversation.account_id.isnot(None))
            .order_by(Conversation.last_message_at.desc())
            .first()
        )
        if conv and conv.account_id:
            logger.info(f"account_id resolvido pela conversa existente: {conv.account_id}")
            return conv.account_id
    return None


def _check_24h_window(db: Session, provider_kind: str, wa_id: str) -> None:
    """
    Bloqueia envio de mensagem livre (não-template) fora da janela de
    atendimento de 24h da Meta. Sem isso, a API aceita o request normalmente
    mas a Meta descarta a entrega — a equipe vê "enviado" no app e o cliente
    nunca recebe nada. Só se aplica à Cloud API (Baileys/bridges não têm
    essa restrição).
    """
    if provider_kind != "meta":
        return
    contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()
    if not contact:
        alt_wa_id = _br_mobile_alt_wa_id(wa_id)
        if alt_wa_id:
            contact = db.query(Contact).filter(Contact.wa_id == alt_wa_id).first()

    last_inbound = None
    if contact:
        last_inbound = (
            db.query(Message)
            .filter(Message.contact_id == contact.id, Message.direction == Direction.INBOUND)
            .order_by(Message.timestamp.desc())
            .first()
        )

    now_ms = int(datetime.utcnow().timestamp() * 1000)
    if not last_inbound or (now_ms - last_inbound.timestamp) > 24 * 60 * 60 * 1000:
        raise HTTPException(
            status_code=409,
            detail=(
                "Fora da janela de 24h de atendimento — a Meta só entrega mensagem de "
                "template pra este contato agora (a mensagem livre seria aceita pela API "
                "mas descartada pela Meta sem avisar). Envie um template para reabrir a janela."
            ),
        )


def _get_contact_and_conversation(
    db: Session,
    clean_number: str,
    resolved_account_id: Optional[int],
):
    """
    Resolve (ou cria) o Contact/Conversation de destino para uma mensagem outbound.

    Detecta grupo pelo sufixo @g.us em vez de tratar todo destinatário como
    contato individual. Sem isso, get_or_create_conversation() casava a
    conversa só por contact_id — e como o Contact de um grupo pode ter sido
    salvo em algum momento sem o sufixo @g.us, um envio cujo `to` já vem com
    o sufixo criava um Contact + Conversation novos ("chat fantasma") em vez
    de reaproveitar a conversa de grupo já existente.
    """
    is_group = "@g.us" in clean_number
    contact = conversation_service.get_or_create_contact(
        db, clean_number, clean_number, is_group=is_group
    )
    conversation = conversation_service.get_or_create_conversation(
        db,
        contact.id,
        account_id=resolved_account_id,
        is_group=is_group,
        group_jid=clean_number if is_group else None,
    )
    return contact, conversation


def _sync_conversation_unread_count(db: Session, conversation_id: int) -> None:
    """
    Recalcula conversation.unread_count a partir das mensagens inbound ainda não lidas.
    Chamado sempre que uma mensagem é marcada como lida individualmente
    (POST /messages/read), já que esse endpoint não zerava o contador da conversa.
    """
    remaining_unread = db.query(Message).filter(
        Message.conversation_id == conversation_id,
        Message.direction == Direction.INBOUND,
        Message.status != MessageStatus.READ
    ).count()

    db.query(Conversation).filter(Conversation.id == conversation_id).update(
        {"unread_count": remaining_unread}
    )


def _extract_wamid(api_response: Dict[str, Any], provider_kind: str) -> Optional[str]:
    """Extrai o WAMID da resposta, considerando o formato de cada provider."""
    if provider_kind in ("baileys", "venom", "whatsapp_web_js", "site_chat"):
        return api_response.get("message_id")
    if provider_kind == "wppconnect":
        # Servidor oficial @wppconnect-team/wppconnect-server pode variar o formato
        # conforme a versão — tenta as chaves mais comuns antes de desistir.
        return (
            api_response.get("message_id")
            or api_response.get("id")
            or (api_response.get("response") or {}).get("id")
        )
    # Meta Cloud API format: {"messages": [{"id": "wamid..."}]}
    return api_response.get("messages", [{}])[0].get("id")

def _friendly_send_error(err_msg: str, provider_kind: str) -> str:
    """
    Traduz erros crus do provider pra mensagem acionável, quando dá pra
    explicar o que aconteceu de verdade — senão devolve o erro original.

    "No LID for user": bug conhecido e sem correção do lado da lib usada
    pelo bridge WPPConnect (wa-js) pra contas ainda sem LID (endereçamento
    novo de multi-device do WhatsApp) resolvido do lado do destinatário —
    acontece tipicamente na primeira mensagem pra um número que esta sessão
    nunca falou. Testado ao vivo (2026-09-10): nenhuma chamada da lib
    (sendText, checkNumberStatus, openChat) resolve isso, mesmo na versão
    mais nova publicada — é limitação real do WhatsApp Web não-oficial, não
    timing/cache do nosso lado. Contorno confirmado ao vivo pelo usuário
    (2026-09-10): não basta só mandar a 1ª mensagem pelo WhatsApp oficial —
    precisa esperar o CLIENTE responder pelo menos uma vez (é a resposta dele
    que carrega o LID e deixa o WhatsApp expor esse mapeamento pro nosso
    lado); mandar e já tentar seguir sem resposta dele ainda falha.
    """
    if provider_kind == "wppconnect" and "No LID for user" in (err_msg or ""):
        return (
            "Esse é o primeiro contato desta conta com este número, e o WhatsApp "
            "ainda não expôs os dados necessários pra essa mensagem sair por aqui "
            "(limitação da lib do bridge, sem correção disponível). Envie a "
            "primeira mensagem pelo WhatsApp oficial (celular ou web.whatsapp.com) "
            "e aguarde o cliente responder antes de continuar por aqui — só mandar "
            "sem esperar a resposta dele ainda pode falhar."
        )
    return err_msg


def _find_baileys_fallback_account(db: Session, account: Optional[WhatsAppAccount]) -> Optional[WhatsAppAccount]:
    """Acha uma conta Baileys ativa vinculada ao MESMO número de telefone que
    uma conta WPPConnect (linked-device companion na mesma conta real do
    WhatsApp — WhatsApp permite vários dispositivos ligados ao mesmo número).
    Usada como fallback de "No LID for user" (ver _friendly_send_error):
    Baileys fala o protocolo diretamente, não passa pela pipeline de envio
    do WhatsApp Web dentro do navegador (onde mora essa checagem de LID), e
    resolve o destinatário via onWhatsApp() sem exigir que ele já tenha
    respondido antes — não sofre desse limite. Só funciona se essa conta
    Baileys companion já existir e estiver de fato pareada (QR escaneado no
    mesmo aparelho) — sem isso, retorna None e quem chamou segue com a
    falha original."""
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


async def _send_text_maybe_fallback(
    db: Session,
    account: Optional[WhatsAppAccount],
    provider,
    provider_kind: str,
    send_kwargs: Dict[str, Any],
):
    """Envia pelo provider principal; se for WPPConnect e a resposta vier
    com success=False, tenta de novo por uma conta Baileys companion do
    mesmo número (ver _find_baileys_fallback_account).

    2026-09-10: inicialmente só disparava quando o texto do erro batia
    exatamente "No LID for user" — falha real ao vivo mostrou que o mesmo
    bug de LID às vezes volta como error="" (string vazia) em vez do texto
    de sempre (@wppconnect-team/wppconnect não é consistente sobre como
    serializa o motivo de rejeição em todos os pontos internos — ver
    comentário de errMsg() em wppconnect-bridge/index.js). Checar o texto
    exato é frágil demais; qualquer success=False SÍNCRONO do WPPConnect
    agora tenta o fallback — se não houver conta Baileys companion pro
    número (caso normal, mais comum), _find_baileys_fallback_account devolve
    None e nada muda; se houver e ela também falhar, devolve a falha
    ORIGINAL do WPPConnect igual antes.

    2026-09-11 (incidente real, disco cheio derrubando o backend por
    minutos — ver bridge_watchdog.py): a versão anterior também tratava
    QUALQUER EXCEÇÃO (timeout, conexão caiu) como sinal de "não enviou" e
    disparava o fallback. Isso é uma suposição falsa — uma exceção de
    rede/timeout não prova que o WPPConnect não processou o envio, só que
    não conseguimos ler a resposta a tempo (exatamente o que acontece
    quando o backend trava por lock de disco). Confirmado ao vivo: dezenas
    de mensagens saíram DUPLICADAS de verdade pro cliente (mesmo texto,
    200-500s de diferença, uma via WPPConnect outra via Baileys) porque o
    envio original tinha na real funcionado. Por isso agora só entra no
    fallback com uma resposta SÍNCRONA success=False (o WPPConnect
    respondeu e disse explicitamente que rejeitou) — uma exceção propaga
    direto, sem reenviar por conta própria, porque reenviar às cegas é pior
    que deixar o agente ver o erro e decidir se reenvia manualmente.
    Devolve (api_response, provider_kind_realmente_usado) — provider_kind só
    muda pra "baileys" quando o fallback de fato teve sucesso; em qualquer
    outro caso devolve a resposta/erro ORIGINAL do WPPConnect, pra
    _friendly_send_error e _extract_wamid continuarem corretos."""
    api_response = await provider.send_text_message(**send_kwargs)
    needs_fallback = provider_kind == "wppconnect" and api_response.get("success") is False

    if not needs_fallback:
        return api_response, provider_kind

    fallback_account = _find_baileys_fallback_account(db, account)
    if not fallback_account:
        return api_response, provider_kind

    fb_provider, _ = get_provider(db, fallback_account.id)
    fb_kwargs = {k: v for k, v in send_kwargs.items() if k != "reply_to_from_me"}
    if send_kwargs.get("reply_to"):
        quoted_msg = db.query(Message).filter(Message.wamid == send_kwargs["reply_to"]).first()
        fb_kwargs["reply_to_from_me"] = bool(quoted_msg and quoted_msg.direction == Direction.OUTBOUND)

    try:
        fb_response = await fb_provider.send_text_message(**fb_kwargs)
    except Exception:
        return api_response, provider_kind

    if fb_response.get("success") is False:
        return api_response, provider_kind

    logger.info(f"'No LID for user' no WPPConnect (conta #{account.id}) — fallback pro Baileys (conta #{fallback_account.id}) OK")
    return fb_response, "baileys"


async def _send_media_maybe_fallback(
    db: Session,
    account: Optional[WhatsAppAccount],
    provider,
    provider_kind: str,
    method_name: str,
    send_kwargs: Dict[str, Any],
):
    """Mesma lógica de _send_text_maybe_fallback, mas para mídia (send_image/
    send_video/send_audio/send_document/send_sticker) — ver comentário lá
    para o porquê completo do fallback pro Baileys companion.

    BUG CORRIGIDO (2026-09-16): /send/text já tinha esse fallback desde
    2026-09-10, mas /send/media nunca ganhou o mesmo tratamento — confirmado
    ao vivo (conta #14, WPPConnect): texto pro mesmo número/conta se
    recuperava sozinho via fallback, mas imagem/vídeo/áudio/documento
    quebrava direto com 502 ("No LID for user") pro usuário, mesmo havendo
    uma conta Baileys companion pareada no mesmo aparelho.
    """
    api_response = await getattr(provider, method_name)(**send_kwargs)
    needs_fallback = provider_kind == "wppconnect" and api_response.get("success") is False

    if not needs_fallback:
        return api_response, provider_kind

    fallback_account = _find_baileys_fallback_account(db, account)
    if not fallback_account:
        return api_response, provider_kind

    fb_provider, _ = get_provider(db, fallback_account.id)
    fb_kwargs = {k: v for k, v in send_kwargs.items() if k != "reply_to_from_me"}
    if send_kwargs.get("reply_to"):
        quoted_msg = db.query(Message).filter(Message.wamid == send_kwargs["reply_to"]).first()
        fb_kwargs["reply_to_from_me"] = bool(quoted_msg and quoted_msg.direction == Direction.OUTBOUND)

    try:
        fb_response = await getattr(fb_provider, method_name)(**fb_kwargs)
    except Exception:
        return api_response, provider_kind

    if fb_response.get("success") is False:
        return api_response, provider_kind

    logger.info(f"'No LID for user' no WPPConnect (conta #{account.id}) — fallback pro Baileys (conta #{fallback_account.id}) OK ({method_name})")
    return fb_response, "baileys"


UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

router = APIRouter()

@router.post("/upload/public", dependencies=[Depends(get_current_user)])
async def upload_public_media(
    request: Request,
    file: UploadFile = File(...)
):
    """
    Faz upload de um arquivo para ser usado publicamente (ex: Templates de Mídia da Meta).
    Retorna a URL pública do arquivo.
    """
    try:
        original_name = file.filename or "arquivo"
        safe_original = "".join(c if c.isalnum() or c in "._-" else "_" for c in original_name)
        safe_name = f"{uuid.uuid4().hex}_{safe_original}"
        file_path = UPLOAD_DIR / safe_name
        
        async with aiofiles.open(file_path, 'wb') as out_file:
            content = await file.read()
            await out_file.write(content)
            
        # Tenta pegar URL pública do ngrok
        base_url = str(request.base_url).rstrip("/")
        public_base_url = base_url
        try:
            import httpx
            with httpx.Client(timeout=1.0) as client:
                r = client.get("http://localhost:4040/api/tunnels")
                if r.status_code == 200:
                    tunnels = r.json().get("tunnels", [])
                    if tunnels:
                        public_base_url = tunnels[0]["public_url"].rstrip("/")
        except Exception:
            pass

        public_url = f"{public_base_url}/uploads/{safe_name}"
        
        return {"success": True, "url": public_url, "path": f"/uploads/{safe_name}"}
    except Exception as e:
        logger.error(f"Erro no upload público: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ENDPOINT DE UPLOAD DE MÍDIA DO BRIDGE

@router.post("/media/bridge-upload", dependencies=[Depends(require_bridge)])
async def bridge_media_upload(
    request: Request,
    media_id: str,
    mime_type: str = "application/octet-stream",
):
    """
    Recebe mídia binária do bridge Baileys (body raw), salva em uploads/ e retorna a URL local.
    Chamado pelo bridge antes de enviar o payload principal para /webhook/bridge.
    """
    try:
        content = await request.body()
        if not content:
            raise HTTPException(status_code=400, detail="Body vazio")

        _MIME_EXT = {
            "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
            "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
            "vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
            "vnd.ms-excel": "xls",
            "vnd.ms-powerpoint": "ppt",
            "msword": "doc",
            "vnd.oasis.opendocument.text": "odt",
            "vnd.oasis.opendocument.spreadsheet": "ods",
            "x-zip-compressed": "zip",
            "x-rar-compressed": "rar",
            "x-7z-compressed": "7z",
            "octet-stream": "bin",
        }
        raw_subtype = mime_type.split("/")[-1].split(";")[0].strip()
        ext = _MIME_EXT.get(raw_subtype, raw_subtype[:10]) or "bin"
        safe_id = "".join(c if c.isalnum() or c in "_-" else "_" for c in media_id)
        filename = f"{safe_id}.{ext}"
        file_path = UPLOAD_DIR / filename

        async with aiofiles.open(file_path, "wb") as f:
            await f.write(content)

        media_url = f"/uploads/{filename}"
        logger.info(f"[BridgeUpload] Mídia salva: {file_path} ({len(content)} bytes) → {media_url}")
        return {"status": "ok", "media_url": media_url, "mime_type": mime_type, "filename": filename}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[BridgeUpload] Erro: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ENDPOINTS DE ENVIO - MENSAGENS BÁSICAS

@router.post("/send/text")
async def send_text_message(
    message: SendTextMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    try:
        # Validar e limpar número
        clean_number = message.to.strip() if '@' in message.to else ''.join(filter(str.isdigit, message.to))
        if not clean_number:
            raise HTTPException(status_code=400, detail="Número de telefone inválido")

        # Resolver account_id: usa o explícito ou busca pela conversa existente com o contato
        resolved_account_id = _resolve_account_id(db, message.account_id, clean_number)

        logger.info(f"Enviando texto para {clean_number} | account_id={resolved_account_id}")

        # Resolver provider
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        logger.info(f"Provider selecionado: {provider_kind} | tipo: {type(provider).__name__}")

        # Determina se a mensagem citada é outbound (fromMe) para o Baileys renderizar corretamente
        reply_to_from_me = False
        if message.reply_to and provider_kind == "baileys":
            quoted_msg = db.query(Message).filter(Message.wamid == message.reply_to).first()
            reply_to_from_me = bool(quoted_msg and quoted_msg.direction == Direction.OUTBOUND)

        # Identificação do atendente: toda mensagem de texto enviada por um
        # usuário do app leva "*Nome de exibição - Setor*" em negrito na
        # frente, grupo ou 1:1 — pedido explícito pra saber quem escreveu num
        # número compartilhado por vários atendentes. Feito aqui (servidor),
        # não no front, pra valer sempre, não importa por onde a mensagem
        # chegue até essa rota. Sem setor cadastrado, cai só no nome. Nome
        # de exibição respeita a preferência de cada um (Configurações >
        # Minha Conta) — ver backend/utils/display_name.py.
        display_name = format_display_name(current_user.full_name, current_user.email, current_user.display_name_format)
        # Nome de exibicao desativado ("none") -> mensagem sem prefixo.
        identity_prefix = build_identity_prefix(current_user.full_name, current_user.email, current_user.display_name_format, current_user.sector)
        final_text = f"{identity_prefix}{message.text}"

        # Resolve o destino ANTES de tentar enviar — precisa existir nos dois
        # desfechos (sucesso E falha) pra poder registrar a mensagem com
        # falha na conversa certa (ver save_failed_outbound_message).
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)

        # Resposta CITANDO um card "Dúvida de produto" do site: vai SÓ ao site
        # (publicada sob a pergunta) — nunca ao chat box do cliente, onde a
        # dúvida nem aparece. Mensagem sem citar o card segue o fluxo normal.
        if provider_kind == "site_chat" and (message.reply_to or "").startswith("siteQ_"):
            from backend.api.routes_site_chat_questions import answer_question_from_panel
            outcome = await answer_question_from_panel(message.reply_to, message.text, display_name)
            if outcome == "missing":
                raise HTTPException(status_code=404, detail="Dúvida de produto não encontrada.")
            if outcome == "answered":
                raise HTTPException(
                    status_code=409,
                    detail="Esta dúvida já foi respondida (no site ou no painel). Para falar com o cliente "
                           "no chat box, envie a mensagem sem usar 'Responder' no card.",
                )
            if outcome == "busy":
                raise HTTPException(status_code=409, detail="A resposta anterior desta dúvida ainda está sendo enviada ao site.")
            changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
            if changes:
                db.commit()
                await ws_manager.broadcast_conversation_meta_update({
                    "conversation_id": conversation.id, **changes,
                })
            return APIResponse(
                success=True,
                message="Resposta enviada para publicação no site",
                data={"site_question": True, "to": clean_number, "text": message.text},
            )

        # Incidente real (2026-09-01): quando o envio falhava, a rota só
        # devolvia um erro HTTP — nada era salvo, a mensagem simplesmente não
        # existia em lugar nenhum. Agora toda falha vira uma linha visível
        # (status=FAILED, "!" vermelho no front) com os dados originais
        # guardados pra reenvio manual (POST /messages/{id}/retry-send).
        failed_payload = {
            "kind": "text", "to": clean_number, "text": message.text,
            "reply_to": message.reply_to or None, "account_id": resolved_account_id,
        }

        # Enviar via provider correto
        account_for_fallback = _get_account(db, resolved_account_id)
        try:
            send_kwargs: Dict[str, Any] = {
                "to": clean_number,
                "text": final_text,
                "reply_to": message.reply_to or None,
            }
            if provider_kind == "baileys":
                send_kwargs["reply_to_from_me"] = reply_to_from_me
            api_response, provider_kind = await _send_text_maybe_fallback(
                db, account_for_fallback, provider, provider_kind, send_kwargs
            )
        except Exception as provider_err:
            logger.error(f"Exceção do provider [{provider_kind}]: {provider_err}", exc_info=True)
            failed_msg = conversation_service.save_failed_outbound_message(
                db, conversation.id, contact.id, "text", final_text, failed_payload,
                reply_to_wamid=message.reply_to or None,
            )
            await ws_manager.broadcast_new_message({
                **conversation_service._format_message(failed_msg),
                "conversation_id": conversation.id,
            })
            status = provider_err.http_status if isinstance(provider_err, WhatsAppAPIError) else 502
            raise HTTPException(
                status_code=status,
                detail=f"[{provider_kind}] Falha ao enviar mensagem: {provider_err}"
            )

        logger.info(f"Resposta do provider ({provider_kind}): {api_response}")

        # Checar erro explícito retornado pelo provider (ex: bridge offline, sessão não autenticada)
        if api_response.get("success") is False:
            err_msg = api_response.get("error", "Falha ao enviar mensagem")
            failed_msg = conversation_service.save_failed_outbound_message(
                db, conversation.id, contact.id, "text", final_text, failed_payload,
                reply_to_wamid=message.reply_to or None,
            )
            await ws_manager.broadcast_new_message({
                **conversation_service._format_message(failed_msg),
                "conversation_id": conversation.id,
            })
            raise HTTPException(status_code=502, detail=f"[{provider_kind}] {_friendly_send_error(err_msg, provider_kind)}")

        # Extrair WAMID (formato difere por provider)
        wamid = _extract_wamid(api_response, provider_kind)
        logger.info(f"WAMID obtido: {wamid}")

        if wamid:
            conversation_service.save_outbound_message(
                db=db,
                wamid=wamid,
                conversation_id=conversation.id,
                contact_id=contact.id,
                message_type="text",
                message_text=final_text,
                reply_to_wamid=message.reply_to or None,
            )

            # Cronômetro de SLA: auto-atribui (se ainda sem dono) e marca
            # "pending" (aguardando o cliente responder). Também é aqui que o
            # handoff humano acontece — pausa o bot/IA (ver webhook_handler.
            # _forward_to_ai_webhook) se ele ainda estava respondendo, e grava
            # o momento — ver docstring de handle_agent_outbound_reply.
            changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
            if changes:
                db.commit()
                await ws_manager.broadcast_conversation_meta_update({
                    "conversation_id": conversation.id, **changes,
                })

        return APIResponse(
            success=True,
            message="Mensagem enviada com sucesso",
            data={"message_id": wamid, "to": clean_number, "text": final_text},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao enviar texto: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ── POST /messages/{message_id}/retry-send ──────────────────────
# Clique manual no "!" vermelho de uma mensagem NOSSA que falhou ao enviar
# (ver save_failed_outbound_message). Reaproveita os dados originais do
# envio guardados em failed_payload e tenta de novo pelo mesmo provider —
# só suporta texto por enquanto (demais tipos de envio ainda não persistem
# falha, apenas retornam erro HTTP direto ao front).
@router.post("/messages/{message_id}/retry-send")
async def retry_send_message(
    message_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from sqlalchemy.exc import IntegrityError

    message = db.query(Message).filter(Message.id == message_id).first()
    if not message:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    if (message.direction != Direction.OUTBOUND or message.status != MessageStatus.FAILED
            or not message.failed_payload):
        raise HTTPException(status_code=400, detail="Essa mensagem não está com falha de envio pendente")

    payload = message.failed_payload
    if payload.get("kind") != "text":
        raise HTTPException(status_code=400, detail=f"Reenvio manual ainda não suportado para esse tipo de mensagem ('{payload.get('kind')}')")

    clean_number = payload["to"]
    account_id = payload.get("account_id")
    provider, provider_kind = get_provider(db, account_id)

    display_name = format_display_name(current_user.full_name, current_user.email, current_user.display_name_format)
    identity_prefix = build_identity_prefix(current_user.full_name, current_user.email, current_user.display_name_format, current_user.sector)
    final_text = f"{identity_prefix}{payload['text']}"

    reply_to_from_me = False
    if payload.get("reply_to") and provider_kind == "baileys":
        quoted_msg = db.query(Message).filter(Message.wamid == payload["reply_to"]).first()
        reply_to_from_me = bool(quoted_msg and quoted_msg.direction == Direction.OUTBOUND)

    account_for_fallback = _get_account(db, account_id)
    try:
        send_kwargs: Dict[str, Any] = {"to": clean_number, "text": final_text, "reply_to": payload.get("reply_to")}
        if provider_kind == "baileys":
            send_kwargs["reply_to_from_me"] = reply_to_from_me
        api_response, provider_kind = await _send_text_maybe_fallback(
            db, account_for_fallback, provider, provider_kind, send_kwargs
        )
        if api_response.get("success") is False:
            raise Exception(api_response.get("error", "Falha ao enviar mensagem"))
    except Exception as exc:
        logger.error(f"retry-send: ainda falhou pra mensagem #{message_id}: {exc}")
        raise HTTPException(status_code=502, detail=f"Ainda não foi possível enviar: {_friendly_send_error(str(exc), provider_kind)}")

    wamid = _extract_wamid(api_response, provider_kind)
    if not wamid:
        raise HTTPException(status_code=502, detail="Provider não retornou confirmação de envio")

    # Recicla a MESMA linha (troca o wamid sintético pelo real, sai do estado
    # de falha) em vez de criar uma segunda mensagem na conversa.
    message.wamid = wamid
    message.message_text = final_text
    message.status = MessageStatus.SENT
    message.failed_payload = None
    message.timestamp = int(datetime.now().timestamp() * 1000)

    conversation = db.query(Conversation).filter(Conversation.id == message.conversation_id).first()
    changes = None
    if conversation:
        conversation.last_message_at = datetime.now()
        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)

    try:
        db.commit()
    except IntegrityError:
        # Corrida rara: o eco do webhook já criou a linha real com esse
        # mesmo wamid nesse meio-tempo — descarta o placeholder duplicado
        # em vez de quebrar o retry.
        db.rollback()
        real = db.query(Message).filter(
            Message.wamid == wamid, Message.conversation_id == message.conversation_id
        ).first()
        if real:
            db.delete(db.query(Message).filter(Message.id == message_id).first())
            db.commit()
            message = real
        else:
            raise

    db.refresh(message)
    if changes:
        await ws_manager.broadcast_conversation_meta_update({
            "conversation_id": message.conversation_id, **changes,
        })

    return APIResponse(
        success=True,
        message="Mensagem reenviada com sucesso",
        data={"message": conversation_service._format_message(message)},
    )


@router.post("/send/media")
async def send_media_message(
    request: Request,
    to: str = Form(...),
    media_type: str = Form(..., alias="type"),
    caption: Optional[str] = Form(None),
    reply_to: Optional[str] = Form(None),
    account_id: Optional[int] = Form(None),
    media: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia mensagem com mídia (imagem, vídeo, áudio, documento, sticker).
    Suporta Meta Cloud API e Baileys/bridge providers.

    Form Data:
    - to: Número do destinatário
    - type: image|video|audio|document|sticker
    - caption: Legenda (opcional)
    - reply_to: WAMID para responder (opcional)
    - account_id: ID da conta (opcional)
    - media: Arquivo
    """
    if not user_has_permission(db, current_user, "feature_send_media"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar mídia.")
    file_path = None
    converted_path = None
    try:
        clean_number = to.strip() if '@' in to else ''.join(filter(str.isdigit, to))
        if not clean_number:
            raise HTTPException(status_code=400, detail="Número de telefone inválido")

        if media_type not in ("image", "video", "audio", "document", "sticker"):
            raise HTTPException(status_code=400, detail=f"Tipo de mídia inválido: {media_type}")

        resolved_account_id = _resolve_account_id(db, account_id, clean_number)
        logger.info(f"Enviando {media_type} para {clean_number} | account_id={resolved_account_id}")

        # Salvar arquivo com nome único para evitar colisões
        original_name = media.filename or "arquivo"
        # Sanitiza caracteres inválidos no nome do arquivo
        safe_original = "".join(c if c.isalnum() or c in "._-" else "_" for c in original_name)
        safe_name = f"{uuid.uuid4().hex}_{safe_original}"
        file_path = UPLOAD_DIR / safe_name
        content = await media.read()
        logger.info(f"Salvando arquivo: {file_path} ({len(content)} bytes, content_type={media.content_type})")
        async with aiofiles.open(file_path, 'wb') as f:
            await f.write(content)

        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        logger.info(f"Provider: {provider_kind} ({type(provider).__name__})")

        wamid = None
        media_id = None

        if provider_kind in _UNOFFICIAL_PROVIDERS:
            # BUG CORRIGIDO: antes só "baileys" (comparação literal) entrava
            # aqui — venom/wppconnect/whatsapp_web_js caíam no `else` de baixo,
            # que é Meta Cloud API-only, e falhavam com erro enganoso (token/
            # media_id da Meta que essas contas nem têm). Agora qualquer
            # provider não-oficial passa por aqui.
            import base64 as _b64
            file_mime = media.content_type or "application/octet-stream"
            file_name = media.filename or "arquivo"

            # Normaliza o arquivo para o formato aceito pelo WhatsApp/Baileys
            normalized_path, file_mime = normalize_media(file_path, file_mime, media_type)
            if normalized_path != file_path:
                converted_path = normalized_path
                async with aiofiles.open(normalized_path, 'rb') as f:
                    content = await f.read()
                logger.info(f"Usando arquivo normalizado: {normalized_path.name} ({len(content)} bytes, mime={file_mime})")

            # Envia o arquivo como base64 — o bridge decodifica e envia como Buffer,
            # eliminando a necessidade de o bridge fazer um download HTTP.
            file_b64 = _b64.b64encode(content).decode("utf-8")
            logger.info(f"Enviando como base64 ({len(content)} bytes, mime={file_mime})")

            # Determina fromMe da mensagem citada (para reply_to exibir corretamente)
            reply_to_from_me = False
            if reply_to:
                quoted_msg = db.query(Message).filter(Message.wamid == reply_to).first()
                reply_to_from_me = bool(quoted_msg and quoted_msg.direction == Direction.OUTBOUND)

            # Venom não recebeu o suporte a file_b64 nos métodos send_image/
            # send_video/send_audio/send_document (biblioteca com envio básico
            # já instável — não vale o esforço, ver _FULL_API_PROVIDERS em
            # routes_baileys.py) — upload direto continua bloqueado só pra ele.
            if provider_kind == "venom" and media_type != "sticker":
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"[{provider_kind}] Envio de {media_type} por upload direto ainda não é suportado "
                        "neste provider — use uma URL pública."
                    ),
                )
            if media_type == "sticker" and provider_kind == "venom":
                raise HTTPException(status_code=400, detail="[venom] Envio de sticker não é suportado neste provider no momento (limitação da biblioteca).")

            media_kwargs: Dict[str, Any] = {
                "to": clean_number, "file_b64": file_b64, "mime_type": file_mime,
                "reply_to": reply_to or None, "reply_to_from_me": reply_to_from_me,
            }
            if media_type in ("image", "video", "document"):
                media_kwargs["caption"] = caption or ""
            if media_type == "document":
                media_kwargs["filename"] = file_name
            if media_type == "sticker":
                media_kwargs.pop("reply_to_from_me")  # send_sticker não aceita esse kwarg

            try:
                account_for_fallback = _get_account(db, resolved_account_id)
                api_response, provider_kind = await _send_media_maybe_fallback(
                    db, account_for_fallback, provider, provider_kind, f"send_{media_type}", media_kwargs
                )
            except HTTPException:
                raise
            except Exception as provider_err:
                logger.error(f"Exceção do provider {provider_kind} ao enviar {media_type}: {provider_err}", exc_info=True)
                raise HTTPException(
                    status_code=502,
                    detail=f"[{provider_kind}] Falha ao enviar {media_type}: {provider_err}"
                )

            logger.info(f"Resposta do bridge ({media_type}): {api_response}")

            if not isinstance(api_response, dict):
                raise HTTPException(status_code=502, detail=f"[{provider_kind}] Resposta inválida do bridge: {api_response!r}")

            if api_response.get("success") is False:
                raise HTTPException(status_code=502, detail=f"[{provider_kind}] {_friendly_send_error(api_response.get('error', 'Falha ao enviar'), provider_kind)}")

            wamid = api_response.get("message_id") or api_response.get("id")
        else:
            # Meta Cloud API: upload + envio por media_id
            svc = get_whatsapp_service(db, resolved_account_id)
            upload_response = await svc.upload_media(str(file_path), media.content_type)
            media_id = upload_response.get("id")

            meta_methods = {
                "image": svc.send_image,
                "video": svc.send_video,
                "audio": svc.send_audio,
                "document": svc.send_document,
                "sticker": svc.send_sticker,
            }
            kwargs: Dict[str, Any] = {"to": clean_number, f"{media_type}_id": media_id, "reply_to": reply_to}
            if media_type in ("image", "video", "document") and caption:
                kwargs["caption"] = caption
            if media_type == "document":
                kwargs["filename"] = media.filename

            api_response = await meta_methods[media_type](**kwargs)
            wamid = api_response.get("messages", [{}])[0].get("id")

            # Remover arquivo temporário apenas no fluxo Meta (Baileys precisa do arquivo acessível)
            try:
                os.remove(file_path)
                file_path = None
            except OSError:
                pass

        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)

        # Providers não-oficiais (Baileys e, agora, sticker nos outros 3): o
        # arquivo salvo em UPLOAD_DIR é acessível via /uploads/
        local_media_url = None
        if provider_kind in _UNOFFICIAL_PROVIDERS and file_path and file_path.exists():
            local_media_url = f"/uploads/{file_path.name}"

        if wamid:
            conversation_service.save_outbound_message(
                db=db,
                wamid=wamid,
                conversation_id=conversation.id,
                contact_id=contact.id,
                message_type=media_type,
                media_id=media_id,
                media_url=local_media_url,
                caption=caption,
                filename=media.filename if media_type == "document" else None,
                file_size=len(content),
                mime_type=media.content_type,
                reply_to_wamid=reply_to or None,
            )

            changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
            if changes:
                db.commit()
                await ws_manager.broadcast_conversation_meta_update({
                    "conversation_id": conversation.id, **changes,
                })

        return APIResponse(
            success=True,
            message=f"Mídia {media_type} enviada com sucesso",
            data={"message_id": wamid, "media_id": media_id, "media_url": local_media_url}
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao enviar mídia: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Remove o arquivo convertido (temporário) se houver
        if converted_path and converted_path.exists():
            try:
                os.remove(converted_path)
            except OSError:
                pass


# FAVORITAR / FIXAR / ENCAMINHAR PARA A EQUIPE — mensagem de cliente

def _get_message_by_conversation_and_wamid(db: Session, conversation_id: int, wamid: str) -> Message:
    msg = (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id, Message.wamid == wamid)
        .first()
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    return msg


class MessageStarRequest(BaseModel):
    starred: bool


@router.post("/conversations/{conversation_id}/messages/{wamid}/star")
async def star_message(
    conversation_id: int,
    wamid: str,
    payload: MessageStarRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Favoritar mensagem de cliente. Antes só existia a chamada de protocolo
    (POST /api/baileys/message/star), que nunca gravava Message.is_starred —
    o "favorito" sumia ao recarregar a lista. Aqui persiste de verdade e,
    quando o provider suporta (Baileys/WPPConnect/whatsapp-web.js), também
    reflete no app do celular vinculado, em melhor esforço (não bloqueia a
    resposta se o bridge falhar).
    """
    msg = _get_message_by_conversation_and_wamid(db, conversation_id, wamid)
    msg.is_starred = payload.starred
    db.commit()
    try:
        conv = msg.conversation
        provider, provider_kind = get_provider(db, conv.account_id)
        if provider_kind in _UNOFFICIAL_PROVIDERS and conv.contact:
            await provider.star_message(conv.contact.wa_id, wamid, payload.starred)
    except Exception as e:
        logger.warning(f"Falha ao refletir favorito no provider: {e}")
    return APIResponse(success=True, data={"wamid": wamid, "is_starred": msg.is_starred})


class MessagePinRequest(BaseModel):
    pinned: bool


@router.post("/conversations/{conversation_id}/messages/{wamid}/pin")
async def pin_message(
    conversation_id: int,
    wamid: str,
    payload: MessagePinRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Fixar mensagem de cliente. Antes só existia a chamada de protocolo (POST
    /api/baileys/message/pin) — sem coluna no banco, sem lista de fixadas,
    e o front nem atualizava o estado local após chamar. Aqui persiste de
    verdade (Message.is_pinned); reflexo no app do celular é melhor esforço.
    """
    msg = _get_message_by_conversation_and_wamid(db, conversation_id, wamid)
    msg.is_pinned = payload.pinned
    db.commit()
    try:
        conv = msg.conversation
        provider, provider_kind = get_provider(db, conv.account_id)
        if provider_kind in _UNOFFICIAL_PROVIDERS and conv.contact and payload.pinned:
            await provider.pin_message(conv.contact.wa_id, wamid, 604800)
    except Exception as e:
        logger.warning(f"Falha ao refletir fixação no provider: {e}")
    return APIResponse(success=True, data={"wamid": wamid, "is_pinned": msg.is_pinned})


class MessageForwardToInternalRequest(BaseModel):
    target_internal_conversation_ids: List[int]


# Tipos de mensagem de cliente que fazem sentido virar mídia no chat interno
# (o restante — localização, interativa, template, reação — vira só texto-resumo).
_FORWARDABLE_MEDIA_TYPES = {"image", "video", "audio", "document", "sticker"}


@router.post("/conversations/{conversation_id}/messages/{wamid}/forward-to-internal")
async def forward_message_to_internal(
    conversation_id: int,
    wamid: str,
    payload: MessageForwardToInternalRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Encaminha uma mensagem de cliente pro chat interno (Equipe), com
    referência ao contato de origem — quem recebe vê um card clicável que
    abre a conversa do cliente (ver InternalMessage.forwarded_from_*).
    """
    if not payload.target_internal_conversation_ids:
        raise HTTPException(status_code=400, detail="Selecione ao menos uma conversa da Equipe")

    msg = _get_message_by_conversation_and_wamid(db, conversation_id, wamid)
    contact = msg.contact
    contact_name = (contact.saved_name or contact.push_name or contact.name) if contact else None
    contact_phone = contact.phone_number if contact else None

    mt = msg.message_type.value.lower()
    text = msg.message_text or msg.caption or ""
    media_url = msg.media_url
    if mt not in _FORWARDABLE_MEDIA_TYPES:
        text = text or f"[{mt}]"
        mt, media_url = "text", None
    elif not media_url:
        # Mídia só existe no CDN da Meta (ainda não baixada localmente) — não
        # dá pra reencaminhar o arquivo em si, cai pra um resumo em texto.
        text = (text or f"[{mt}]") + " (mídia não disponível para encaminhar)"
        mt = "text"

    from backend.api.routes_internal_chat import _persist_and_broadcast_message, _require_participant

    results = []
    for target_id in payload.target_internal_conversation_ids:
        target_conv = _require_participant(db, target_id, current_user.id)
        message_data = await _persist_and_broadcast_message(
            db, target_conv, current_user,
            text=text, message_type=mt, media_url=media_url,
            mime_type=msg.mime_type, filename=msg.filename,
            forwarded_from_wa_conversation_id=conversation_id,
            forwarded_from_wa_wamid=wamid,
            forwarded_from_contact_name=contact_name,
            forwarded_from_contact_phone=contact_phone,
        )
        results.append(message_data)

    return APIResponse(success=True, data=results)


async def send_forwarded_message_to_conversation(
    db: Session,
    conversation: Conversation,
    text: Optional[str] = None,
    media_path: Optional[Path] = None,
    media_type: Optional[str] = None,
    mime_type: Optional[str] = None,
    filename: Optional[str] = None,
) -> Optional[str]:
    """
    Envia texto e/ou mídia já salva em disco (uploads/) pra uma Conversation
    já existente — usado pelo encaminhamento Equipe→WhatsApp
    (POST /api/internal-chats/messages/{id}/forward-to-whatsapp, em
    routes_internal_chat.py). Diferente de /send/text e /send/media (que
    resolvem contato/conta a partir de um número digitado pelo usuário),
    aqui conversa e conta já são conhecidas — e, propositalmente, NÃO leva o
    prefixo "*Nome - Setor*" que /send/text adiciona: é conteúdo de terceiro
    sendo repassado pro cliente, não uma mensagem digitada agora. Retorna o
    wamid enviado, ou None se nada foi enviado.
    """
    contact = conversation.contact
    if not contact:
        raise HTTPException(status_code=400, detail="Conversa sem contato associado")
    to = contact.wa_id or contact.phone_number
    provider, provider_kind = get_provider(db, conversation.account_id)
    _check_24h_window(db, provider_kind, to)

    wamid = None
    if media_path and media_path.exists() and media_type:
        import base64
        file_mime = mime_type or "application/octet-stream"
        local_media_url = None
        media_id = None
        if provider_kind in _UNOFFICIAL_PROVIDERS:
            normalized_path, file_mime = normalize_media(media_path, file_mime, media_type)
            with open(normalized_path, "rb") as f:
                content = f.read()
            file_b64 = base64.b64encode(content).decode("utf-8")
            if media_type == "image":
                api_response = await provider.send_image(to, file_b64=file_b64, caption=text or "", mime_type=file_mime)
            elif media_type == "video":
                api_response = await provider.send_video(to, file_b64=file_b64, caption=text or "", mime_type=file_mime)
            elif media_type == "audio":
                api_response = await provider.send_audio(to, file_b64=file_b64, mime_type=file_mime)
            elif media_type == "document":
                api_response = await provider.send_document(to, file_b64=file_b64, filename=filename or "arquivo", mime_type=file_mime, caption=text or "")
            else:
                api_response = await provider.send_sticker(to, file_b64=file_b64, mime_type=file_mime)
            local_media_url = f"/uploads/{media_path.name}"
        else:
            svc = get_whatsapp_service(db, conversation.account_id)
            upload_response = await svc.upload_media(str(media_path), file_mime)
            media_id = upload_response.get("id")
            meta_methods = {"image": svc.send_image, "video": svc.send_video, "audio": svc.send_audio, "document": svc.send_document}
            kwargs: Dict[str, Any] = {"to": to, f"{media_type}_id": media_id}
            if media_type in ("image", "video", "document") and text:
                kwargs["caption"] = text
            if media_type == "document":
                kwargs["filename"] = filename or "arquivo"
            api_response = await meta_methods[media_type](**kwargs)

        if isinstance(api_response, dict) and api_response.get("success") is not False:
            wamid = _extract_wamid(api_response, provider_kind)
        if wamid:
            conversation_service.save_outbound_message(
                db=db, wamid=wamid, conversation_id=conversation.id, contact_id=contact.id,
                message_type=media_type, caption=text or None, media_url=local_media_url,
                media_id=media_id, filename=filename if media_type == "document" else None,
                mime_type=file_mime,
            )
    elif text:
        api_response = await provider.send_text_message(to=to, text=text)
        if isinstance(api_response, dict) and api_response.get("success") is not False:
            wamid = _extract_wamid(api_response, provider_kind)
        if wamid:
            conversation_service.save_outbound_message(
                db=db, wamid=wamid, conversation_id=conversation.id, contact_id=contact.id,
                message_type="text", message_text=text,
            )
    return wamid


@router.post("/send/location")
async def send_location_message(
    location: SendLocationMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia localização
    
    Body:
    {
        "to": "5511999990001",
        "latitude": -23.550520,
        "longitude": -46.633308,
        "name": "Avenida Paulista",
        "address": "Av. Paulista, 1578 - Bela Vista, São Paulo - SP",
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    if not user_has_permission(db, current_user, "feature_send_location"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar localização.")
    try:
        clean_number = location.to.strip() if '@' in location.to else ''.join(filter(str.isdigit, location.to))
        
        # Obter account_id (se houver na pydantic model, use; senão None)
        acc_id = getattr(location, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, clean_number)
        
        logger.info(f"Enviando localização para {clean_number} | account_id={resolved_account_id}")
        
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        
        if not hasattr(provider, "send_location"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta enviar localização")
            
        api_response = await provider.send_location(
            to=clean_number,
            latitude=location.latitude,
            longitude=location.longitude,
            name=location.name,
            address=location.address,
            reply_to=location.reply_to
        )
        
        if api_response.get("success") is False:
            err_msg = api_response.get("error", "Falha ao enviar localização")
            raise HTTPException(status_code=502, detail=f"[{provider_kind}] {_friendly_send_error(err_msg, provider_kind)}")
            
        wamid = _extract_wamid(api_response, provider_kind)
        
        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)

        import json
        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="location",
            message_text=json.dumps({
                "latitude": location.latitude,
                "longitude": location.longitude,
                "name": location.name,
                "address": location.address
            })
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Localização enviada com sucesso",
            data={"message_id": wamid}
        )
        
    except HTTPException:
        raise
        
    except Exception as e:
        logger.error(f"Erro ao enviar localização: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# NOVOS ENDPOINTS - CONTATOS

@router.post("/send/contacts")
async def send_contacts_message(
    message: SendContactMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia contato(s) no formato vCard
    
    Body:
    {
        "to": "5511999990001",
        "contacts": [
            {
                "name": {
                    "formatted_name": "João Silva",
                    "first_name": "João",
                    "last_name": "Silva"
                },
                "phones": [
                    {
                        "phone": "5511999999999",
                        "type": "CELL",
                        "wa_id": "5511999999999"
                    }
                ],
                "emails": [
                    {"email": "joao@example.com", "type": "WORK"}
                ],
                "addresses": [
                    {
                        "street": "Rua Exemplo, 123",
                        "city": "São Paulo",
                        "state": "SP",
                        "country": "Brasil",
                        "type": "HOME"
                    }
                ],
                "org": {
                    "company": "Empresa XYZ",
                    "title": "Gerente"
                },
                "urls": [
                    {"url": "https://example.com", "type": "WORK"}
                ],
                "birthday": "1990-01-15"
            }
        ],
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    if not user_has_permission(db, current_user, "feature_send_contacts"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar contatos.")
    try:
        logger.info(f"Enviando {len(message.contacts)} contato(s) para {message.to}")
        clean_number = WhatsAppService.validate_phone_number(message.to)
        
        acc_id = getattr(message, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        
        if not hasattr(provider, "send_contacts"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta envio de contatos.")

        # Converter Pydantic models para dicts
        contacts_data = [contact.dict(exclude_none=True) for contact in message.contacts]
        
        api_response = await provider.send_contacts(
            to=clean_number,
            contacts=contacts_data,
            reply_to=message.reply_to
        )
        
        if api_response.get("success") is False:
            err_msg = api_response.get("error", "Falha ao enviar contatos")
            raise HTTPException(status_code=502, detail=f"[{provider_kind}] {_friendly_send_error(err_msg, provider_kind)}")
        
        wamid = _extract_wamid(api_response, provider_kind)

        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)

        # "contacts" não é um MessageType próprio no banco (cai em TEXT) — grava um
        # texto legível com nome e telefone(s) em vez do genérico "N contato(s)"
        # que não dizia nada útil na conversa local.
        contact_lines = []
        for c in message.contacts:
            c_name = c.name.formatted_name if c.name else "Contato"
            c_phones = ", ".join(p.phone for p in (c.phones or []) if p.phone)
            contact_lines.append(f"📇 {c_name}" + (f"\n📱 {c_phones}" if c_phones else ""))

        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="text",
            message_text="\n".join(contact_lines)
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Contato(s) enviado(s) com sucesso",
            data={"message_id": wamid, "contacts_count": len(message.contacts)}
        )

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Erro ao enviar contatos: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# NOVOS ENDPOINTS - MENSAGENS INTERATIVAS

@router.post("/send/interactive/buttons")
async def send_interactive_buttons(
    payload: SendInteractiveButtonsRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia mensagem com botões de resposta (máximo 3)
    
    Body:
    {
        "to": "5511999990001",
        "body_text": "Escolha uma opção:",
        "buttons": [
            {"id": "btn_sim", "title": "Sim"},
            {"id": "btn_nao", "title": "Não"},
            {"id": "btn_talvez", "title": "Talvez"}
        ],
        "header_text": "Confirmação" (opcional),
        "footer_text": "Powered by WhatsApp" (opcional),
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    if not user_has_permission(db, current_user, "feature_send_interactive"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar botões/listas interativas.")
    try:
        logger.info(f"Enviando botões interativos para {payload.to}")
        clean_number = WhatsAppService.validate_phone_number(payload.to)
        
        resolved_account_id = _resolve_account_id(db, payload.account_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        
        if not hasattr(provider, "send_interactive_buttons"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta enviar botões interativos.")

        api_response = await provider.send_interactive_buttons(
            to=clean_number,
            body_text=payload.body_text,
            buttons=payload.buttons,
            header_text=payload.header_text,
            footer_text=payload.footer_text,
            reply_to=payload.reply_to
        )
        
        if api_response.get("success") is False:
            err_msg = api_response.get("error", "Falha ao enviar botões")
            raise HTTPException(status_code=502, detail=f"[{provider_kind}] {_friendly_send_error(err_msg, provider_kind)}")

        wamid = _extract_wamid(api_response, provider_kind)
        
        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)
        
        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"Botões: {payload.body_text}",
            interactive_payload={
                "kind": "buttons",
                "body_text": payload.body_text,
                "header_text": payload.header_text,
                "footer_text": payload.footer_text,
                "buttons": payload.buttons,
            },
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Botões interativos enviados com sucesso",
            data={"message_id": wamid, "buttons_count": len(payload.buttons)}
        )
        
    except Exception as e:
        logger.error(f"Erro ao enviar botões: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/send/interactive/cta-url")
async def send_cta_url_button(
    payload: SendCtaUrlButtonRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia mensagem com botão CTA (Call-to-Action) que abre um link externo

    Body:
    {
        "to": "5511999990001",
        "body_text": "Confira nossa promoção!",
        "display_text": "Ver oferta",
        "url": "https://example.com/promo",
        "header_text": "Promoção" (opcional),
        "footer_text": "Válido até domingo" (opcional),
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    try:
        logger.info(f"Enviando botão CTA para {payload.to}")
        clean_number = WhatsAppService.validate_phone_number(payload.to)

        resolved_account_id = _resolve_account_id(db, payload.account_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)

        if not hasattr(provider, "send_cta_url_button"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta botão CTA.")

        api_response = await provider.send_cta_url_button(
            to=clean_number,
            body_text=payload.body_text,
            display_text=payload.display_text,
            url=payload.url,
            header_text=payload.header_text,
            footer_text=payload.footer_text,
            reply_to=payload.reply_to
        )

        if api_response.get("success") is False:
            err_msg = api_response.get("error", "Falha ao enviar botão CTA")
            raise HTTPException(status_code=502, detail=f"[{provider_kind}] {_friendly_send_error(err_msg, provider_kind)}")

        wamid = _extract_wamid(api_response, provider_kind)

        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)

        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"CTA: {payload.display_text} -> {payload.url}",
            interactive_payload={
                "kind": "cta_url",
                "body_text": payload.body_text,
                "header_text": payload.header_text,
                "footer_text": payload.footer_text,
                "display_text": payload.display_text,
                "url": payload.url,
            },
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Botão CTA enviado com sucesso",
            data={"message_id": wamid}
        )

    except Exception as e:
        logger.error(f"Erro ao enviar botão CTA: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ENDPOINT: PROXY DE MÍDIA
@router.get("/media/proxy/{media_id}")
async def proxy_media(media_id: str, db: Session = Depends(get_db)):
    """
    Proxy para servir mídias do WhatsApp Cloud API
    CORREÇÃO FINAL: Removida validação incorreta de tamanho
    """
    try:
        logger.info(f"[PROXY] Requisição de mídia: {media_id}")
        
        # VALIDAÇÃO BÁSICA: apenas verifica se não está vazio
        if not media_id or not re.fullmatch(r"[A-Za-z0-9_.\-]{5,200}", media_id):
            logger.warning(f"[PROXY] Media ID inválido: {media_id!r}")
            raise HTTPException(
                status_code=400,
                detail="ID de mídia inválido"
            )
        
        # REMOVIDO: Validação incorreta que rejeitava IDs válidos
        # if media_id.isdigit() and len(media_id) < 20:
        #     raise HTTPException(status_code=404, ...)
        
        logger.info(f"[PROXY] Buscando mídia no banco de dados...")
        message = db.query(Message).filter(Message.media_id == media_id).first()

        if message:
            logger.info(f"[PROXY] Encontrado no DB: {message.mime_type}")

        # ARQUIVO LOCAL (Baileys/bridge) — servir diretamente
        local_media = db.query(MediaFile).filter(MediaFile.media_id == media_id).first()
        if local_media and os.path.exists(local_media.filepath):
            logger.info(f"[PROXY] Servindo arquivo local: {local_media.filepath}")
            mime = local_media.mime_type or "application/octet-stream"
            return FileResponse(
                local_media.filepath,
                media_type=mime,
                headers={
                    "Cache-Control": "public, max-age=86400",
                    "X-Media-ID": media_id,
                },
            )

        # OBTER URL TEMPORÁRIA DA META
        logger.info(f"[PROXY] Obtendo URL da Meta para ID: {media_id}")
        
        try:
            # 1. Determinar o token da conta a partir da mensagem
            access_token = None
            if message and message.conversation_id:
                conversation = db.query(Conversation).filter(Conversation.id == message.conversation_id).first()
                if conversation and conversation.account_id:
                    from backend.database.models import WhatsAppAccount
                    account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == conversation.account_id).first()
                    if account and account.meta_access_token:
                        access_token = account.meta_access_token

            if not access_token:
                logger.error("[PROXY] Token de acesso não encontrado e não configurado para a conta vinculada!")
                raise HTTPException(
                    status_code=500,
                    detail="Token de acesso da conta não configurado ou conta não encontrada"
                )

            headers = {"Authorization": f"Bearer {access_token}"}
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Obter metadata da mídia (URL e mime_type)
                meta_url = f"https://graph.facebook.com/v18.0/{media_id}"
                response = await client.get(meta_url, headers=headers)
                response.raise_for_status()
                
                media_info = response.json()
                media_url = media_info.get("url")
                mime_type = media_info.get("mime_type", "application/octet-stream")
                
                if not media_url:
                    logger.error(f"[PROXY] URL vazia retornada pela Meta")
                    raise HTTPException(
                        status_code=404,
                        detail="URL de mídia não retornada pela Meta"
                    )
                
                logger.info(f"[PROXY] URL obtida com sucesso")
                logger.info(f"[PROXY] Tipo MIME: {mime_type}")
                
                # BAIXAR MÍDIA DA URL TEMPORÁRIA
                logger.info(f"[PROXY] Baixando mídia da URL temporária...")
                download_response = await client.get(media_url, headers=headers)
                download_response.raise_for_status()
                
                content_size = len(download_response.content)
                logger.info(f"[PROXY] Mídia baixada: {content_size} bytes")
                
                # Retornar mídia ao frontend
                return Response(
                    content=download_response.content,
                    media_type=mime_type,
                    headers={
                        'Content-Length': str(content_size),
                        'Cache-Control': 'public, max-age=86400',
                        'X-Media-ID': media_id,
                        'X-Content-Type': mime_type
                    }
                )
                
        except httpx.HTTPStatusError as e:
            status = e.response.status_code
            logger.error(f"[PROXY] Erro HTTP ao baixar: {status}")
            logger.error(f"[PROXY] Resposta: {e.response.text[:500]}")
            
            if status == 403:
                raise HTTPException(
                    status_code=500,
                    detail="Acesso negado pela Meta (token sem permissão)"
                )
            elif status == 404:
                raise HTTPException(
                    status_code=404,
                    detail="Mídia expirada ou removida"
                )
            else:
                raise HTTPException(
                    status_code=500,
                    detail=f"Erro ao baixar mídia: HTTP {status}"
                )
        
        except httpx.TimeoutException:
            logger.error(f"[PROXY] Timeout ao baixar mídia")
            raise HTTPException(
                status_code=504,
                detail="Timeout ao baixar mídia (rede lenta)"
            )
        
        except Exception as e:
            logger.error(f"[PROXY] Erro ao baixar: {e}", exc_info=True)
            raise HTTPException(
                status_code=500,
                detail=f"Erro ao baixar mídia: {str(e)}"
            )
            
    except HTTPException:
        # Re-raise para manter status codes
        raise
        
    except Exception as e:
        logger.error(f"[PROXY] Erro inesperado: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Erro interno: {str(e)}"
        )
        
@router.post("/send/interactive/list")
async def send_interactive_list(
    payload: SendInteractiveListRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia mensagem com lista de opções
    
    Body:
    {
        "to": "5511999990001",
        "body_text": "Escolha um produto:",
        "button_text": "Ver Opções",
        "sections": [
            {
                "title": "Eletrônicos",
                "rows": [
                    {"id": "prod_1", "title": "Smartphone", "description": "Modelo XYZ"},
                    {"id": "prod_2", "title": "Notebook"}
                ]
            },
            {
                "title": "Acessórios",
                "rows": [
                    {"id": "acc_1", "title": "Fone de Ouvido"}
                ]
            }
        ],
        "header_text": "Catálogo" (opcional),
        "footer_text": "Preços sujeitos a alteração" (opcional),
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    if not user_has_permission(db, current_user, "feature_send_interactive"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar botões/listas interativas.")
    try:
        logger.info(f"Enviando lista interativa para {payload.to}")
        clean_number = WhatsAppService.validate_phone_number(payload.to)
        
        acc_id = getattr(payload, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        
        if not hasattr(provider, "send_interactive_list"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta listas interativas.")

        api_response = await provider.send_interactive_list(
            to=clean_number,
            body_text=payload.body_text,
            button_text=payload.button_text,
            sections=payload.sections,
            header_text=payload.header_text,
            footer_text=payload.footer_text,
            reply_to=payload.reply_to
        )
        
        wamid = _extract_wamid(api_response, provider_kind)
        
        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)
        
        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"Lista: {payload.body_text}",
            interactive_payload={
                "kind": "list",
                "body_text": payload.body_text,
                "button_text": payload.button_text,
                "header_text": payload.header_text,
                "footer_text": payload.footer_text,
                "sections": payload.sections,
            },
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Lista interativa enviada com sucesso",
            data={"message_id": wamid, "sections_count": len(payload.sections)}
        )
        
    except Exception as e:
        logger.error(f"Erro ao enviar lista: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/send/interactive/product")
async def send_interactive_product(
    payload: SendInteractiveProductRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia produto único do catálogo
    
    Body:
    {
        "to": "5511999990001",
        "catalog_id": "1234567890",
        "product_retailer_id": "prod_abc123",
        "body_text": "Confira este produto!" (opcional),
        "footer_text": "Disponível em estoque" (opcional),
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    if not user_has_permission(db, current_user, "feature_send_products"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar produtos.")
    try:
        logger.info(f"Enviando produto para {payload.to}")
        clean_number = WhatsAppService.validate_phone_number(payload.to)
        
        acc_id = getattr(payload, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        
        if not hasattr(provider, "send_interactive_product"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta envio de produto interativo.")

        api_response = await provider.send_interactive_product(
            to=clean_number,
            catalog_id=payload.catalog_id,
            product_retailer_id=payload.product_retailer_id,
            body_text=payload.body_text,
            footer_text=payload.footer_text,
            reply_to=payload.reply_to
        )
        
        wamid = _extract_wamid(api_response, provider_kind)
        
        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)
        
        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"Produto: {payload.product_retailer_id}"
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Produto interativo enviado com sucesso",
            data={"message_id": wamid}
        )
        
    except Exception as e:
        logger.error(f"Erro ao enviar produto: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/send/interactive/product-list")
async def send_interactive_product_list(
    payload: SendInteractiveProductListRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia lista de múltiplos produtos do catálogo, agrupados em seções

    Body:
    {
        "to": "5511999990001",
        "catalog_id": "1234567890",
        "header_text": "Nossos produtos",
        "body_text": "Confira a seleção abaixo!",
        "sections": [
            {
                "title": "Categoria 1",
                "product_items": [
                    {"product_retailer_id": "prod_1"},
                    {"product_retailer_id": "prod_2"}
                ]
            }
        ],
        "footer_text": "Disponível em estoque" (opcional),
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    if not user_has_permission(db, current_user, "feature_send_products"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar produtos.")
    try:
        logger.info(f"Enviando lista de produtos para {payload.to}")
        clean_number = WhatsAppService.validate_phone_number(payload.to)

        acc_id = getattr(payload, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)

        if not hasattr(provider, "send_interactive_product_list"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta lista de produtos interativa.")

        api_response = await provider.send_interactive_product_list(
            to=clean_number,
            catalog_id=payload.catalog_id,
            header_text=payload.header_text,
            body_text=payload.body_text,
            sections=payload.sections,
            footer_text=payload.footer_text,
            reply_to=payload.reply_to
        )

        wamid = _extract_wamid(api_response, provider_kind)

        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)

        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"Lista de produtos: {payload.header_text}",
            interactive_payload={
                "kind": "product_list",
                "header_text": payload.header_text,
                "body_text": payload.body_text,
                "footer_text": payload.footer_text,
                "sections": payload.sections,
            },
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Lista de produtos enviada com sucesso",
            data={"message_id": wamid, "sections_count": len(payload.sections)}
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao enviar lista de produtos: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# MÍDIA AVANÇADA (CLEANUP & STATS) # <-- NEW SECTION

@router.post("/media/cleanup", dependencies=[Depends(get_current_user)])
async def cleanup_old_media(
    days: int = 365,
    db: Session = Depends(get_db)
):
    """
    Remove mídias antigas (padrão: 1 ano)
    
    Query params:
    - days: Número de dias para manter (padrão: 365)
    """
    try:
        cutoff_date = datetime.utcnow() - timedelta(days=days)
        
        # 1. Buscar mídias antigas
        old_media = db.query(MediaFile).filter(
            MediaFile.downloaded_at < cutoff_date
        ).all()
        
        deleted_count = 0
        failed_count = 0
        freed_space = 0
        
        for media in old_media:
            try:
                # Remover arquivo do disco
                if os.path.exists(media.filepath):
                    file_size = os.path.getsize(media.filepath)
                    os.remove(media.filepath)
                    freed_space += file_size
                    logger.info(f"Arquivo removido: {media.filepath}")
                else:
                    logger.warning(f"Arquivo não encontrado no disco, removendo apenas registro: {media.filepath}")
                
                # Remover do banco
                db.delete(media)
                deleted_count += 1
            
            except Exception as e:
                logger.error(f"Erro ao remover mídia {media.media_id}: {e}")
                failed_count += 1
        
        db.commit()
        
        freed_mb = round(freed_space / (1024 * 1024), 2)
        
        return APIResponse(
            success=True,
            message=f"Limpeza concluída: {deleted_count} arquivos removidos ({freed_mb} MB liberados)",
            data={
                "deleted": deleted_count,
                "failed": failed_count,
                "freed_space_mb": freed_mb
            }
        )
    
    except Exception as e:
        logger.error(f"Erro ao limpar mídias: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/media/stats", dependencies=[Depends(get_current_user)])
async def get_media_stats(db: Session = Depends(get_db)):
    """Estatísticas de armazenamento de mídias"""
    try:
        
        total_files = db.query(MediaFile).count()
        total_size = db.query(func.sum(MediaFile.file_size)).scalar() or 0
        
        # Join MediaFile back to Message to categorize by type
        stats_by_type = db.query(
            Message.message_type,
            func.count(MediaFile.id).label('count'),
            func.sum(MediaFile.file_size).label('total_size')
        ).join(
            MediaFile, MediaFile.message_id == Message.id  # CORRETO
        ).group_by(Message.message_type).all()
        
        return APIResponse(
            success=True,
            data={
                "total_files": total_files,
                "total_size_bytes": total_size,
                "total_size_mb": round(total_size / (1024 * 1024), 2),
                "by_type": [
                    {
                        "type": stat.message_type.value if stat.message_type else "unknown",
                        "count": stat.count,
                        "size_mb": round((stat.total_size or 0) / (1024 * 1024), 2)
                    }
                    for stat in stats_by_type
                ]
            }
        )
    
    except Exception as e:
        logger.error(f"Erro ao obter estatísticas: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# NOVOS ENDPOINTS - REAÇÕES

@router.post("/send/reaction", dependencies=[Depends(get_current_user)])
async def send_reaction(
    message: SendReactionMessage,
    db: Session = Depends(get_db)
):
    """Envia reação (emoji) para uma mensagem. Suporta Baileys e Meta Cloud API."""
    try:
        clean_number = message.to.strip() if '@' in message.to else ''.join(filter(str.isdigit, message.to))
        logger.info(f"Enviando reação {message.emoji} para {clean_number} | msg={message.message_id} | account_id={message.account_id}")

        resolved_account_id = _resolve_account_id(db, message.account_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)

        # from_me vem do frontend (que sabe a direção) com fallback para consulta no DB
        from_me = message.from_me
        if not from_me and provider_kind == "baileys":
            original_msg = db.query(Message).filter(Message.wamid == message.message_id).first()
            if original_msg:
                from_me = original_msg.direction == Direction.OUTBOUND

        try:
            reaction_kwargs: Dict[str, Any] = {
                "to": clean_number,
                "message_id": message.message_id,
                "emoji": message.emoji,
            }
            if provider_kind == "baileys":
                reaction_kwargs["from_me"] = from_me
            api_response = await provider.send_reaction(**reaction_kwargs)
        except Exception as provider_err:
            logger.error(f"Exceção do provider [{provider_kind}] ao reagir: {provider_err}", exc_info=True)
            status = provider_err.http_status if isinstance(provider_err, WhatsAppAPIError) else 502
            raise HTTPException(status_code=status, detail=f"[{provider_kind}] Falha ao enviar reação: {provider_err}")

        if api_response.get("success") is False:
            raise HTTPException(status_code=502, detail=f"[{provider_kind}] {api_response.get('error', 'Falha ao enviar reação')}")

        # Salva a reação como metadado na mensagem original (não cria nova mensagem)
        original_message = db.query(Message).filter(Message.wamid == message.message_id).first()
        if original_message:
            original_message.reaction_emoji = message.emoji
            db.commit()

        return APIResponse(
            success=True,
            message="Reação enviada com sucesso",
            data={"message_id": message.message_id, "emoji": message.emoji}
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao enviar reação: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/send/reaction/remove", dependencies=[Depends(get_current_user)])
async def remove_reaction(
    message: RemoveReactionMessage,
    db: Session = Depends(get_db)
):
    """
    Remove reação de uma mensagem
    """
    try:
        logger.info(f"Removendo reação para {message.to} da mensagem {message.message_id}")
        clean_number = WhatsAppService.validate_phone_number(message.to)
        
        acc_id = getattr(message, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, clean_number)
        provider, provider_kind = get_provider(db, resolved_account_id)
        _check_24h_window(db, provider_kind, clean_number)
        
        if not hasattr(provider, "remove_reaction"):
            raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta remover reação.")
        
        # 1. Enviar remoção via API
        api_response = await provider.remove_reaction(
            to=clean_number,
            message_id=message.message_id
        )
        
        # 2. Atualizar o original no DB (Garantir persistência)
        original_message = db.query(Message).filter(Message.wamid == message.message_id).first()
        
        if original_message:
            original_message.reaction_emoji = None
            db.commit()
            logger.info(f"Reação removida do banco para WAMID {message.message_id}")
        else:
            logger.warning(f"Mensagem original {message.message_id} não encontrada para remover reação outbound.")

        return APIResponse(
            success=True,
            message="Reação removida com sucesso",
            data={"message_id": message.message_id}
        )
        
    except Exception as e:
        logger.error(f"Erro ao remover reação: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# TEMPLATE

@router.post("/send/template")
async def send_template_message(
    template: SendTemplateMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Envia mensagem template pré-aprovada
    
    CORRIGIDO: Adiciona tratamento específico para templates não aprovados
    
    Body:
    {
        "to": "5511999990001",
        "template_name": "hello_world",
        "language_code": "pt_BR",
        "components": [],
        "reply_to": "wamid.xxx" (opcional)
    }
    """
    if not user_has_permission(db, current_user, "feature_send_templates"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para enviar templates.")
    try:
        clean_number = template.to.strip() if '@' in template.to else ''.join(filter(str.isdigit, template.to))
        
        # Obter account_id se existir, senão tenta descobrir
        acc_id = getattr(template, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, clean_number)
        
        logger.info(f"Enviando template {template.template_name} para {clean_number} | account_id={resolved_account_id}")
        
        provider, provider_kind = get_provider(db, resolved_account_id)

        if provider_kind == "baileys":
            api_response = await provider.send_template(
                to=clean_number,
                template_name=template.template_name,
                language=template.language_code,
                components=template.components or []
            )
        elif provider_kind == "meta":
            # MM Lite: contas nos tiers meta_cloud_mmlite/meta_cloud_full mandam
            # templates de categoria MARKETING pelo endpoint otimizado da Meta.
            use_marketing_endpoint = False
            account_for_tier = _get_account(db, resolved_account_id)
            if account_for_tier and normalize_provider_type(account_for_tier.provider_type) in (
                "meta_cloud_mmlite", "meta_cloud_full"
            ):
                from backend.api.routes_templates import get_template_category
                category = await get_template_category(db, template.template_name, resolved_account_id)
                use_marketing_endpoint = (category == "MARKETING")

            api_response = await provider.send_template(
                to=clean_number,
                template_name=template.template_name,
                language_code=template.language_code,
                components=template.components,
                reply_to=template.reply_to,
                use_marketing_endpoint=use_marketing_endpoint
            )
        else:
            api_response = await provider.send_template(
                to=clean_number,
                template_name=template.template_name,
                language_code=template.language_code,
                components=template.components,
                reply_to=template.reply_to
            )
        
        if api_response.get("success") is False:
            err_msg = api_response.get("error", "Falha ao enviar template")
            raise HTTPException(status_code=502, detail=f"[{provider_kind}] {_friendly_send_error(err_msg, provider_kind)}")
            
        wamid = _extract_wamid(api_response, provider_kind)
        
        # Salvar no banco
        contact, conversation = _get_contact_and_conversation(db, clean_number, resolved_account_id)

        # Melhorar o texto de preview da mensagem salva no banco
        from backend.api.routes_templates import TemplateCacheModel
        
        display_text = f"Template: {template.template_name}"
        
        # 1. Tentar pegar o texto do banco de cache
        template_obj = db.query(TemplateCacheModel).filter(TemplateCacheModel.name == template.template_name).first()
        if template_obj and template_obj.components:
            import json
            try:
                comp_list = json.loads(template_obj.components) if isinstance(template_obj.components, str) else template_obj.components
                body = next((c.get("text") for c in comp_list if c.get("type") == "BODY"), None)
                if body:
                    display_text += f"\n\n{body}"
            except Exception:
                pass
                
        # 2. Anexar URL da mídia se o usuário enviou
        media_url = None
        for c in (template.components or []):
            if c.get("type") == "header" and c.get("parameters"):
                p = c["parameters"][0]
                media_type = p.get("type")
                if media_type in ["image", "video", "document"]:
                    media_url = p.get(media_type, {}).get("link")
                    
        if media_url:
            display_text = f"{media_url}\n{display_text}"

        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="template",
            message_text=display_text
        )

        changes = conversation_service.handle_agent_outbound_reply(db, conversation, current_user.id)
        if changes:
            db.commit()
            await ws_manager.broadcast_conversation_meta_update({
                "conversation_id": conversation.id, **changes,
            })

        return APIResponse(
            success=True,
            message="Template enviado com sucesso",
            data={"message_id": wamid}
        )
        
    except httpx.HTTPStatusError as e:
        error_data = e.response.json() if e.response else {}
        error_code = error_data.get("error", {}).get("code")
        error_message = error_data.get("error", {}).get("message", str(e))
        
        # Erro específico: template não existe no idioma
        if error_code == 132001:
            logger.error(f"Template '{template.template_name}' não aprovado para '{template.language_code}'")
            raise HTTPException(
                status_code=404,
                detail=f"Template '{template.template_name}' não está aprovado para o idioma '{template.language_code}'. "
                       f"Verifique no WhatsApp Business Manager se o template existe e está aprovado."
            )
        
        # Outros erros da API
        logger.error(f"Erro ao enviar template: {error_message}")
        raise HTTPException(status_code=e.response.status_code, detail=error_message)
        
    except Exception as e:
        logger.error(f"Erro ao enviar template: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# MARCAR COMO LIDA

@router.post("/messages/read", dependencies=[Depends(get_current_user)])
async def mark_message_read(message: MarkMessageRead, db: Session = Depends(get_db)):
    """
    Marca mensagem como lida
    
    CORRIGIDO: Valida idade da mensagem antes de chamar API da Meta
    Mensagens com mais de 30 dias não podem ser marcadas como lidas
    
    Body:
    {
        "message_id": "wamid.HBgNNTU0NDk4NDE0NjM3ORUCABIYFjNBMDhGRjU4..."
    }
    """
    try:
        # BUG anterior: buscava só por wamid, sem escopar por conta — o mesmo
        # wamid pode existir em VÁRIAS conversas (eco multi-device entre
        # providers ligados ao mesmo número real, mesmo padrão já corrigido
        # em /bridge/poll-vote, /bridge/edit e /bridge/revoke). Sem o escopo,
        # `.first()` podia acertar uma linha de OUTRA conta/conversa — a
        # mensagem que o usuário via na tela continuava "não lida" porque a
        # que realmente foi atualizada era outra, com wamid igual mas em
        # outra conversa (às vezes até com timestamp corrompido, disparando
        # o branch de "mensagem antiga" por engano).
        query = db.query(Message).filter(Message.wamid == message.message_id)
        if message.account_id is not None:
            query = query.join(Conversation, Message.conversation_id == Conversation.id).filter(
                Conversation.account_id == message.account_id
            )
        db_message = query.first()

        if not db_message:
            # Mensagem não encontrada localmente — marcar apenas como sucesso silencioso
            logger.warning(f"Mensagem {message.message_id} não encontrada no banco — ignorando mark-read")
            return APIResponse(success=True, message="Mensagem não encontrada localmente, ignorado")

        # Verificar se mensagem é inbound (apenas inbound podem ser marcadas como lidas)
        if db_message.direction != Direction.INBOUND:
            return APIResponse(success=True, message="Mensagem outbound, ignorado")

        # Já está marcada como lida
        if db_message.status == MessageStatus.READ:
            return APIResponse(success=True, message="Já marcada como lida")

        # Verificar idade da mensagem (Meta só aceita mensagens com menos de 30 dias)
        message_age_days = (datetime.now().timestamp() * 1000 - db_message.timestamp) / (1000 * 60 * 60 * 24)

        if message_age_days > 30:
            logger.info(f"Mensagem antiga ({message_age_days:.1f} dias). Marcando apenas localmente.")
            db_message.status = MessageStatus.READ
            _sync_conversation_unread_count(db, db_message.conversation_id)
            db.commit()
            return APIResponse(success=True, message="Marcada como lida localmente (mensagem antiga)")

        # Resolver account_id: preferir campo do request, senão pegar da conversa
        account_id = message.account_id
        if account_id is None:
            conv = db.query(Conversation).filter(Conversation.id == db_message.conversation_id).first()
            if conv:
                account_id = conv.account_id

        # Tentar chamar API do Provider (Baileys ou Meta)
        try:
            provider, provider_kind = get_provider(db, account_id)
            if provider_kind == "site_chat":
                pass  # sem recibo de leitura externo — só o status local abaixo
            elif provider_kind == "baileys":
                contact = db.query(Contact).filter(Contact.id == db_message.contact_id).first()
                if contact:
                    jid = contact.wa_id
                    participant = db_message.participant_jid
                    await provider.mark_read(jid=jid, message_id=message.message_id, participant_jid=participant)
            else:
                svc = get_whatsapp_service(db, account_id)
                # Sempre INBOUND neste ponto (checado acima) — a Meta só aceita
                # typing_indicator junto com o read receipt de uma mensagem do usuário.
                await svc.mark_as_read(message.message_id, typing_indicator=True)
        except Exception as api_err:
            logger.warning(f"Falha ao chamar API para mark-read ({message.message_id}): {api_err}")

        # Independente do resultado da API, marca localmente
        db_message.status = MessageStatus.READ
        _sync_conversation_unread_count(db, db_message.conversation_id)
        db.commit()

        return APIResponse(success=True, message="Mensagem marcada como lida")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao marcar como lida: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
        
# UPSERT DE CONTATO (participantes de grupo)

@router.post("/contacts/upsert", dependencies=[Depends(get_current_user)])
async def upsert_contact(request: Request, db: Session = Depends(get_db)):
    """Cria ou atualiza contato individual. Usado para registrar participantes de grupos."""
    try:
        data = await request.json()
        wa_id        = data.get("wa_id", "")
        phone_number = data.get("phone_number", wa_id.split("@")[0])
        push_name    = data.get("push_name")
        # contact_name: nome real da agenda de endereços (só existe se salvo no
        # telefone vinculado) — distinto do push_name. "name" segue aceito por
        # compatibilidade com chamadores antigos.
        saved_name   = data.get("contact_name") or data.get("name")
        name         = data.get("name") or data.get("push_name")
        if not wa_id:
            return APIResponse(success=False, error="wa_id obrigatório")
        contact = conversation_service.get_or_create_contact(
            db=db,
            wa_id=wa_id,
            phone_number=phone_number,
            name=name,
            push_name=push_name,
            saved_name=saved_name,
        )
        return APIResponse(success=True, data={"id": contact.id, "wa_id": contact.wa_id})
    except Exception as e:
        # {e!r}+exc_info=True (2026-09-11): a versão anterior (f"{e}") vinha
        # vazia nos logs bem no meio de uma rajada real de IntegrityError —
        # sem repr()/traceback não dava pra achar a causa real. Mantido
        # assim daqui pra frente (não é só diagnóstico temporário).
        logger.error(f"Erro ao upsert contato: {e!r}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e) or type(e).__name__)


@router.post("/conversations/open", dependencies=[Depends(get_current_user)])
async def open_conversation(request: Request, db: Session = Depends(get_db)):
    """
    Abre (cria se necessário) a conversa 1:1 com um número, sem enviar nenhuma
    mensagem no WhatsApp — usado pelo botão "Abrir conversa" ao clicar em um
    participante de grupo que ainda não tem conversa individual.
    """
    try:
        data = await request.json()
        raw_phone = (data.get("phone_number") or data.get("wa_id") or "").strip()
        account_id = data.get("account_id")
        phone_number = raw_phone.split("@")[0]
        if not phone_number:
            return APIResponse(success=False, error="phone_number obrigatório")

        contact = conversation_service.get_or_create_contact(
            db=db,
            wa_id=phone_number,
            phone_number=phone_number,
        )
        conversation = conversation_service.get_or_create_conversation(
            db=db,
            contact_id=contact.id,
            account_id=account_id,
        )
        return APIResponse(success=True, data={"conversation_id": conversation.id})
    except Exception as e:
        logger.error(f"Erro ao abrir conversa: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# CONVERSAS E MENSAGENS (JÁ EXISTENTES)

@router.get("/conversations")
async def get_conversations(
    account_id: Optional[int] = None,   # ← ADICIONAR
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Lista conversas, opcionalmente filtradas por conta. Restringe às conversas
    atribuídas ao usuário atual (ou não atribuídas/na fila) quando o papel
    dele não tem feature_view_all_chats NEM feature_view_shared_account_chats,
    e às contas explicitamente concedidas quando o papel não tem
    feature_view_all_accounts.

    feature_view_all_chats e feature_view_shared_account_chats têm o MESMO
    efeito na query (removem a restrição por assigned_to_user_id) — a
    diferença é de intenção/escopo, não de mecanismo: a primeira é pra quem
    deve ver literalmente tudo (ex: supervisor, já combinada com
    feature_view_all_accounts); a segunda é pra atendentes que dividem um
    número com colegas — só faz sentido ver "todo mundo" porque
    feature_view_all_accounts já está False pra eles, então o filtro de
    allowed_account_ids abaixo já limita isso às contas que o próprio
    atendente tem acesso. Ficam decoupled de propósito: dá pra desligar uma
    sem mexer na outra (ex: no dia que existir fila de verdade e quem divide
    número não precisar mais ver o histórico do colega).
    """
    try:
        sees_teammates_chats = (
            user_has_permission(db, current_user, "feature_view_all_chats")
            or user_has_permission(db, current_user, "feature_view_shared_account_chats")
        )
        restrict_to = None if sees_teammates_chats else current_user.id

        allowed_account_ids = None
        if not user_has_permission(db, current_user, "feature_view_all_accounts"):
            allowed_account_ids = {a.id for a in current_user.granted_accounts}
            if account_id is not None and account_id not in allowed_account_ids:
                raise HTTPException(status_code=403, detail="Você não tem acesso a esta conta WhatsApp.")

        conversations = conversation_service.get_all_conversations_with_last_message(
            db,
            account_id=account_id,    # ← PASSAR
            restrict_to_user_id=restrict_to,
            allowed_account_ids=allowed_account_ids,
        )
        return APIResponse(success=True, data=conversations)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao buscar conversas: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/conversations/search", dependencies=[Depends(get_current_user)])
async def search_conversations(
    q: str,
    account_id: Optional[int] = None,
    db: Session = Depends(get_db)
):
    """Busca conversas pelo nome/telefone do contato OU pelo conteúdo de alguma mensagem."""
    try:
        if not q or not q.strip():
            return APIResponse(success=True, data=[])
        results = conversation_service.search_conversations(db, q.strip(), account_id=account_id)
        return APIResponse(success=True, data=results)
    except Exception as e:
        logger.error(f"Erro ao buscar conversas por termo: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/messages/search", dependencies=[Depends(get_current_user)])
async def search_messages(
    q: str,
    account_id: Optional[int] = None,
    db: Session = Depends(get_db)
):
    """Busca todas as ocorrências de mensagens cujo texto/legenda batem com o termo."""
    try:
        if not q or not q.strip():
            return APIResponse(success=True, data=[])
        results = conversation_service.search_messages(db, q.strip(), account_id=account_id)
        return APIResponse(success=True, data=results)
    except Exception as e:
        logger.error(f"Erro ao buscar mensagens por termo: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/statuses", dependencies=[Depends(get_current_user)])
async def get_statuses(
    account_id: Optional[int] = None,
    db: Session = Depends(get_db)
):
    """
    Retorna as mensagens de Status (Stories) recebidas nas últimas 24h — separado
    da lista normal de conversas (get_all_conversations_with_last_message exclui
    o contato status@broadcast de propósito).
    """
    try:
        cutoff_ms = int((datetime.utcnow() - timedelta(hours=24)).timestamp() * 1000)
        messages = conversation_service.get_status_messages(
            db, account_id=account_id, since_ms=cutoff_ms
        )
        return APIResponse(success=True, data={"messages": messages})
    except Exception as e:
        logger.error(f"Erro ao buscar status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/conversations/{conversation_id}/messages", dependencies=[Depends(get_current_user)])
async def get_messages(
    conversation_id: int,
    limit: int = 50,
    before_timestamp: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """Lista mensagens de uma conversa.

    before_timestamp (opcional): pagina mensagens ANTERIORES a esse timestamp
    (epoch ms) — usado pelo front pra "carregar mensagens antigas" ao rolar
    pro topo do chat. Sem ele, mantém o comportamento original (as `limit`
    mais recentes).
    """
    try:
        # get_conversation_messages já retorna dicts formatados
        messages = conversation_service.get_conversation_messages(
            db, conversation_id, limit=limit, before_timestamp=before_timestamp
        )

        return APIResponse(
            success=True,
            data={
                "conversation_id": conversation_id,
                "messages": messages,  # Já vem formatado como lista de dicts
                # Heurística simples: se voltou exatamente `limit`, pode haver
                # mais; se voltou menos, essa foi a última página de verdade.
                "has_more": len(messages) >= limit,
            }
        )
    except Exception as e:
        logger.error(f"Erro ao buscar mensagens: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/conversations/{conversation_id}/read", dependencies=[Depends(get_current_user)])
async def mark_conversation_read(
    conversation_id: int,
    db: Session = Depends(get_db)
):
    """Marca todas as mensagens de uma conversa como lidas"""
    try:
        # Buscar todas as mensagens não lidas da conversa
        unread_messages = db.query(Message).filter(
            Message.conversation_id == conversation_id,
            Message.direction == Direction.INBOUND,
            Message.status != MessageStatus.READ
        ).all()
        
        conversation = db.query(Conversation).filter(
            Conversation.id == conversation_id
        ).first()
        
        if conversation and unread_messages:
            try:
                provider, provider_kind = get_provider(db, conversation.account_id)
                contact = db.query(Contact).filter(Contact.id == conversation.contact_id).first()
                if contact and provider_kind != "site_chat":
                    jid = contact.wa_id
                    if provider_kind == "baileys":
                        for msg in unread_messages:
                            await provider.mark_read(jid=jid, message_id=msg.wamid, participant_jid=msg.participant_jid)
                    else:
                        svc = get_whatsapp_service(db, conversation.account_id)
                        # Meta só precisa marcar a última
                        latest_msg = max(unread_messages, key=lambda m: m.timestamp)
                        await svc.mark_as_read(latest_msg.wamid)
            except Exception as e:
                logger.warning(f"Erro ao notificar provider de leitura na conversa {conversation_id}: {e}")

        # Marcar como lidas
        for msg in unread_messages:
            msg.status = MessageStatus.READ
        
        # Zerar contador de não lidas
        if conversation:
            conversation.unread_count = 0
        
        db.commit()
        
        return APIResponse(success=True, message="Conversa marcada como lida")
    except Exception as e:
        logger.error(f"Erro ao marcar conversa como lida: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/conversations/{conversation_id}/unread", dependencies=[Depends(get_current_user)])
async def mark_conversation_unread(
    conversation_id: int,
    db: Session = Depends(get_db)
):
    """
    Marca uma conversa como não lida manualmente — igual o "marcar como não
    lida" do WhatsApp oficial. Não reenvia nem retira o "lido" já confirmado
    pro contato via protocolo (impossível desfazer isso) — só afeta nosso
    indicador local.

    BUG anterior: só setava Conversation.unread_count, mas GET /conversations
    (conversation_service.get_all_conversations_with_last_message) NUNCA lê
    essa coluna — ele RECALCULA unread_count toda vez a partir de
    Message.status inbound != READ. Sem tocar numa mensagem de verdade, o
    contador "sumia" no próximo poll/refresh da lista, sempre voltando a 0.
    Fix: volta o status da última mensagem inbound pra DELIVERED (desfaz
    especificamente o que /read faz), e ainda sincroniza a coluna via
    _sync_conversation_unread_count pra quem mais ler ela diretamente.
    """
    try:
        conversation = db.query(Conversation).filter(
            Conversation.id == conversation_id
        ).first()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversa não encontrada")

        last_inbound = db.query(Message).filter(
            Message.conversation_id == conversation_id,
            Message.direction == Direction.INBOUND,
        ).order_by(Message.timestamp.desc()).first()

        if last_inbound:
            last_inbound.status = MessageStatus.DELIVERED

        conversation.unread_count = max(conversation.unread_count or 0, 1)
        db.commit()
        _sync_conversation_unread_count(db, conversation_id)
        db.commit()

        return APIResponse(success=True, message="Conversa marcada como não lida")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao marcar conversa como não lida: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/conversations/{conversation_id}/messages", dependencies=[Depends(get_current_user)])
async def clear_conversation_messages(
    conversation_id: int,
    db: Session = Depends(get_db)
):
    """Remove todas as mensagens de uma conversa (limpar chat local)"""
    try:
        deleted = db.query(Message).filter(
            Message.conversation_id == conversation_id
        ).delete(synchronize_session=False)
        conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
        if conv:
            conv.unread_count = 0
        db.commit()
        return {"status": "ok", "deleted_count": deleted}
    except Exception as e:
        logger.error(f"Erro ao limpar conversa: {e}")
        raise HTTPException(status_code=500, detail=str(e))












