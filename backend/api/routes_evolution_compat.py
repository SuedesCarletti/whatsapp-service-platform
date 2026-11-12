"""
Shim de compatibilidade com a Evolution API — caminho de onboarding pra
migrar um bot/agente já pronto, construído contra a Evolution API, pro
wpp-platform sem reescrever a lógica de negócio dele.

Muitos bots de automação (n8n, Make, etc.) feitos pra falar com a Evolution
API chamam ela diretamente em nós/passos HTTP espalhados pela lógica de
negócio, sempre nos paths /message/sendText|sendContact|sendMedia/{instance}
com o mesmo formato de body/headers. Em vez de reescrever esses passos pra
um contrato novo (risco alto pra um bot já em produção), este router imita
o contrato HTTP da Evolution API — a única mudança necessária do lado do
bot é trocar o host e a apikey.

Isso é DIFERENTE do contrato genérico de bot/IA (routes_ai_bot.py,
POST /api/bot/reply) — aquele é o recomendado pra qualquer ferramenta nova;
este aqui é só pra migrar algo que já fala Evolution API. Qualquer conta
pode usar esse modo (campo WhatsAppAccount.ai_webhook_format="evolution_compat",
configurável em Configurações → Contas WA), não é exclusivo de nenhum
cliente específico. Ver payload de saída equivalente em
webhook_handler.py::_forward_to_ai_webhook (modo ai_webhook_format="evolution_compat").

Serve para migrar bots n8n já existentes (construídos sobre a Evolution API)
sem reescrever seus nós de envio.

Registrar em app.py SEM prefixo /api (os paths já vêm da Evolution):
    from backend.api.routes_evolution_compat import evolution_compat_router
    app.include_router(evolution_compat_router, tags=["Evolution Compat"])
"""

import base64
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.database.models import WhatsAppAccount
from backend.models.schemas import APIResponse
from backend.services.conversation_service import conversation_service
from backend.api.websocket import ws_manager

logger = logging.getLogger(__name__)

evolution_compat_router = APIRouter()

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


def _clean_number(number: str) -> str:
    # Mesma convenção de /send/text (routes.py): com "@" é um JID completo
    # (Baileys guarda contact.wa_id no formato JID), sem "@" fica só dígitos.
    return number.strip() if "@" in number else "".join(filter(str.isdigit, number))


async def _resolve_account_and_conversation(db: Session, instance: str, number: str, apikey: str):
    """
    Resolve a WhatsAppAccount pelo account_name (== "instance" da Evolution)
    e a Conversation pelo número — ou levanta HTTPException (401/404/409),
    igual ao POST /api/bot/reply genérico (routes_ai_bot.py).
    """
    from backend.api.routes import _get_contact_and_conversation

    account = db.query(WhatsAppAccount).filter(WhatsAppAccount.account_name == instance).first()
    if not account:
        raise HTTPException(status_code=404, detail=f"Conta '{instance}' não encontrada")

    token = apikey[7:] if apikey.lower().startswith("bearer ") else apikey
    if not account.ai_webhook_secret or token != account.ai_webhook_secret:
        raise HTTPException(status_code=401, detail="apikey inválida")

    clean_number = _clean_number(number)
    if not clean_number:
        raise HTTPException(status_code=400, detail="number inválido")

    contact, conversation = _get_contact_and_conversation(db, clean_number, account.id)
    if not conversation.bot_enabled:
        raise HTTPException(status_code=409, detail="bot_paused")

    return account, contact, conversation


async def _register_bot_reply(db: Session, conversation, reply_text: Optional[str] = None) -> None:
    """
    Comum aos 3 endpoints abaixo: bookkeeping de "bot respondeu" (limpa
    bot_forwarded_at, atualiza detecção de loop) igual ao POST /api/bot/reply
    genérico (routes_ai_bot.py) — sem isso, contas em modo evolution_compat
    (como esta) nunca tinham um alerta de "bot travado" limpo, mesmo com o
    bot respondendo normalmente, porque a resposta saía por aqui, não por lá.
    reply_text é opcional (sendContact/sendMedia sem legenda passam None) —
    sem texto pra comparar repetição, só confirma que o bot está vivo (limpa
    bot_forwarded_at).
    """
    changes = conversation_service.register_bot_reply(db, conversation, reply_text)
    db.commit()
    if changes:
        await ws_manager.broadcast_conversation_meta_update({"conversation_id": conversation.id, **changes})


class EvoOptions(BaseModel):
    delay: Optional[int] = None
    presence: Optional[str] = None


class EvoSendTextRequest(BaseModel):
    number: str
    text: str
    options: Optional[EvoOptions] = None


@evolution_compat_router.post("/message/sendText/{instance}")
async def evo_send_text(
    instance: str,
    payload: EvoSendTextRequest,
    db: Session = Depends(get_db),
    apikey: str = Header(default=""),
):
    from backend.api.routes import send_forwarded_message_to_conversation

    _account, _contact, conversation = await _resolve_account_and_conversation(db, instance, payload.number, apikey)
    await _register_bot_reply(db, conversation, payload.text)
    wamid = await send_forwarded_message_to_conversation(db, conversation, text=payload.text)
    if not wamid:
        raise HTTPException(status_code=502, detail="Falha ao enviar — verifique se a conta está conectada/pareada")
    return APIResponse(success=True, data={"message_id": wamid, "key": {"id": wamid}})


class EvoContact(BaseModel):
    fullName: str
    wuid: Optional[str] = None
    phoneNumber: str


class EvoSendContactRequest(BaseModel):
    number: str
    contact: List[EvoContact]
    options: Optional[EvoOptions] = None


@evolution_compat_router.post("/message/sendContact/{instance}")
async def evo_send_contact(
    instance: str,
    payload: EvoSendContactRequest,
    db: Session = Depends(get_db),
    apikey: str = Header(default=""),
):
    from backend.api.routes import get_provider, _extract_wamid
    from backend.services.conversation_service import conversation_service

    account, contact, conversation = await _resolve_account_and_conversation(db, instance, payload.number, apikey)
    await _register_bot_reply(db, conversation)
    provider, provider_kind = get_provider(db, account.id)
    if not hasattr(provider, "send_contacts"):
        raise HTTPException(status_code=501, detail=f"Provider {provider_kind} não suporta envio de contatos.")

    contacts_data = [
        {"full_name": c.fullName, "phones": [{"number": c.phoneNumber}]}
        for c in payload.contact
    ]
    api_response = await provider.send_contacts(to=_clean_number(payload.number), contacts=contacts_data)
    if isinstance(api_response, dict) and api_response.get("success") is False:
        raise HTTPException(status_code=502, detail=api_response.get("error", "Falha ao enviar contato"))

    wamid = _extract_wamid(api_response, provider_kind)
    contact_lines = [f"📇 {c.fullName}\n📱 {c.phoneNumber}" for c in payload.contact]
    if wamid:
        conversation_service.save_outbound_message(
            db=db, wamid=wamid, conversation_id=conversation.id, contact_id=contact.id,
            message_type="text", message_text="\n".join(contact_lines),
        )
    return APIResponse(success=True, data={"message_id": wamid, "key": {"id": wamid}})


class EvoSendMediaRequest(BaseModel):
    number: str
    mediatype: str  # image|video|audio|document|sticker
    mimetype: Optional[str] = None
    fileName: Optional[str] = None
    caption: Optional[str] = None
    media: str  # base64
    options: Optional[EvoOptions] = None


@evolution_compat_router.post("/message/sendMedia/{instance}")
async def evo_send_media(
    instance: str,
    payload: EvoSendMediaRequest,
    db: Session = Depends(get_db),
    apikey: str = Header(default=""),
):
    from backend.api.routes import send_forwarded_message_to_conversation, _UNOFFICIAL_PROVIDERS, get_provider

    account, _contact, conversation = await _resolve_account_and_conversation(db, instance, payload.number, apikey)
    await _register_bot_reply(db, conversation, payload.caption)

    try:
        raw = base64.b64decode(payload.media)
    except Exception:
        raise HTTPException(status_code=400, detail="media (base64) inválido")

    ext = Path(payload.fileName or "").suffix or ".bin"
    tmp_path = UPLOAD_DIR / f"evo_{uuid.uuid4().hex}{ext}"
    tmp_path.write_bytes(raw)

    # Baileys/WPPConnect precisam do arquivo acessível em uploads/ depois do
    # envio — o media_url salvo na conversa aponta pra ele. Só remove no
    # fluxo Meta, que envia por media_id e não depende do arquivo local
    # (mesma regra de /send/media, routes.py).
    _, provider_kind = get_provider(db, account.id)
    wamid = await send_forwarded_message_to_conversation(
        db, conversation,
        text=payload.caption,
        media_path=tmp_path,
        media_type=payload.mediatype,
        mime_type=payload.mimetype,
        filename=payload.fileName,
    )
    if provider_kind not in _UNOFFICIAL_PROVIDERS:
        tmp_path.unlink(missing_ok=True)

    if not wamid:
        raise HTTPException(status_code=502, detail="Falha ao enviar — verifique se a conta está conectada/pareada")
    return APIResponse(success=True, data={"message_id": wamid, "key": {"id": wamid}})
