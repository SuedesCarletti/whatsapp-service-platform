# backend/services/site_chat_protocol.py
"""
Protocolos do chat do site (24h por padrão, configurável por conta).

Do lado do cliente (widget) o atendimento é um protocolo: dura 24h contadas a
partir da última atividade (mensagem do visitante, resposta do atendente ou
dúvida de produto). Passou disso, o próximo clique no chat começa do zero.
Do lado do painel nada some — a conversa guarda tudo, e cada abertura de
protocolo vira um aviso de sistema centralizado (mesmo mecanismo "sysnotif_"
das notificações de grupo).

Todas as funções são síncronas e recebem a Session — chamar de dentro do
SITE_CHAT_EXECUTOR (nunca direto no event loop).
"""
import asyncio
import json
import logging
import time
from datetime import datetime
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from backend.database.models import (
    Contact,
    Conversation,
    Direction,
    Message,
    MessageStatus,
    MessageType,
    SiteChatProtocol,
    SiteChatVisitor,
    WhatsAppAccount,
)

logger = logging.getLogger(__name__)

DEFAULT_TTL_HOURS = 24
MIN_TTL_HOURS = 1
MAX_TTL_HOURS = 24 * 30
HOUR_MS = 60 * 60 * 1000
NOTICE_WAMID_PREFIX = "sysnotif_proto_"


def now_ms() -> int:
    return int(time.time() * 1000)


def clamp_ttl_hours(value) -> int:
    try:
        hours = int(float(value))
    except (TypeError, ValueError):
        return DEFAULT_TTL_HOURS
    return max(MIN_TTL_HOURS, min(MAX_TTL_HOURS, hours))


def ttl_hours_for_account(db: Session, account_id: int) -> int:
    """Duração do protocolo configurada na conta (provider_config.protocol_ttl_hours); padrão 24h."""
    acc = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == account_id).first()
    raw = acc.provider_config if acc else None
    cfg = {}
    if raw:
        try:
            cfg = json.loads(raw) if isinstance(raw, str) else dict(raw)
        except (ValueError, TypeError):
            cfg = {}
    return clamp_ttl_hours(cfg.get("protocol_ttl_hours", DEFAULT_TTL_HOURS))


def latest_protocol(db: Session, visitor_id: int) -> Optional[SiteChatProtocol]:
    return (
        db.query(SiteChatProtocol)
        .filter(SiteChatProtocol.visitor_id == visitor_id)
        .order_by(SiteChatProtocol.id.desc())
        .first()
    )


def is_active(proto: Optional[SiteChatProtocol], ttl_hours: int, at_ms: Optional[int] = None) -> bool:
    if not proto:
        return False
    return (at_ms or now_ms()) - proto.last_activity_ms < ttl_hours * HOUR_MS


def active_protocol(db: Session, visitor: SiteChatVisitor) -> Optional[SiteChatProtocol]:
    proto = latest_protocol(db, visitor.id)
    return proto if is_active(proto, ttl_hours_for_account(db, visitor.account_id)) else None


def public_info(proto: Optional[SiteChatProtocol], ttl_hours: int) -> Optional[dict]:
    if not is_active(proto, ttl_hours):
        return None
    return {"number": proto.number, "expires_at": proto.last_activity_ms + ttl_hours * HOUR_MS}


def _notice_text(proto: SiteChatProtocol, reason: str, ttl_hours: int) -> str:
    return f"📋 Protocolo {proto.number} iniciado — {reason} ({ttl_hours}h sem atividade encerra o protocolo para o cliente)"


def _broadcast_notice(msg: Message, conv: Conversation, contact: Contact) -> None:
    from backend.api.websocket import ws_manager

    payload = {
        "id": msg.id,
        "wamid": msg.wamid,
        "type": "text",
        "direction": "inbound",
        "from_number": (contact.wa_id or "").split("@")[0],
        "contact_name": contact.name,
        "is_group": False,
        "message": msg.message_text,
        "timestamp": msg.timestamp,
        "status": "read",
        "sender": "contact",
        "conversation_id": conv.id,
        "account_id": conv.account_id,
    }
    try:
        asyncio.run(ws_manager.broadcast_new_message(payload))
    except Exception:
        logger.warning("[SiteChat] falha ao emitir aviso de protocolo via WS", exc_info=True)


def ensure_protocol(
    db: Session,
    visitor: SiteChatVisitor,
    conv: Optional[Conversation],
    trigger_ms: int,
    reason: str = "chat do site",
) -> Tuple[SiteChatProtocol, bool]:
    """
    Garante um protocolo ativo para a atividade em `trigger_ms`. Ativo: só
    renova a última atividade. Vencido/inexistente: abre outro e, havendo
    conversa, registra o aviso (timestamp 1ms antes do gatilho, pra ele
    ordenar antes da mensagem que abriu o protocolo).
    """
    ttl_hours = ttl_hours_for_account(db, visitor.account_id)
    proto = latest_protocol(db, visitor.id)
    if is_active(proto, ttl_hours, trigger_ms):
        if trigger_ms > proto.last_activity_ms:
            proto.last_activity_ms = trigger_ms
            db.commit()
        return proto, False

    proto = SiteChatProtocol(
        account_id=visitor.account_id,
        visitor_id=visitor.id,
        started_ms=trigger_ms - 1,
        last_activity_ms=trigger_ms,
    )
    db.add(proto)
    db.flush()
    proto.number = f"{datetime.fromtimestamp(trigger_ms / 1000):%Y%m%d}-{proto.id:04d}"

    notice = None
    contact = None
    if conv is not None:
        contact = db.query(Contact).filter(Contact.id == conv.contact_id).first()
    if conv is not None and contact is not None:
        notice = Message(
            wamid=f"{NOTICE_WAMID_PREFIX}{proto.id}",
            conversation_id=conv.id,
            contact_id=contact.id,
            message_type=MessageType.TEXT,
            direction=Direction.INBOUND,
            message_text=_notice_text(proto, reason, ttl_hours),
            status=MessageStatus.READ,
            timestamp=proto.started_ms,
        )
        db.add(notice)
    db.commit()

    if notice is not None:
        db.refresh(notice)
        _broadcast_notice(notice, conv, contact)
    return proto, True


def touch_for_agent_reply(db: Session, wa_id: str) -> None:
    """Resposta do atendente: renova o protocolo ativo ou abre um novo (follow-up depois de vencido)."""
    visitor = db.query(SiteChatVisitor).filter(SiteChatVisitor.wa_id == wa_id).first()
    if not visitor:
        return
    conv = None
    if visitor.contact_id:
        conv = (
            db.query(Conversation)
            .filter(Conversation.contact_id == visitor.contact_id, Conversation.account_id == visitor.account_id)
            .first()
        )
    ensure_protocol(db, visitor, conv, now_ms(), reason="resposta do atendente")
