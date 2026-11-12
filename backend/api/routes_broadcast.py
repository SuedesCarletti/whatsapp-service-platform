"""
routes_broadcast.py — Listas de transmissão (broadcast lists)

Paridade com o "Nova lista de transmissão" nativo do WhatsApp: uma lista
nomeada de contatos de uma conta, reaproveitável em vários disparos. Cada
disparo manda a MESMA mensagem individualmente pra cada contato da lista
(mensagem normal 1:1 na conversa de cada um, não é grupo) — é só um loop de
envio de texto reaproveitando a mesma infra de _get_contact_and_conversation/
get_provider/save_outbound_message já usada em /send/text, então funciona
igual nos 4 bridges (nenhum deles tem "broadcast" como recurso de protocolo
separado, é sempre múltiplos sends).

Throttle entre envios (3-7s aleatório): sem isso, mandar N mensagens em
sequência imediata pelos bridges não-oficiais é um padrão clássico de
detecção de spam/automação — risco real de ban da conta vinculada.
"""
import asyncio
import logging
import random
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database.connection import get_db, SessionLocal
from backend.database.models import (
    BroadcastList, broadcast_list_contacts, BroadcastSend, BroadcastSendRecipient,
    Contact, Conversation, User,
)
from backend.services.conversation_service import conversation_service
from backend.api.routes_auth import get_current_user
from backend.api.permissions import user_has_permission
from backend.api.websocket import ws_manager
from backend.utils.display_name import build_identity_prefix

logger = logging.getLogger(__name__)
router_broadcast = APIRouter(prefix="/api/broadcast-lists", tags=["Broadcast"])

MIN_THROTTLE_S = 3.0
MAX_THROTTLE_S = 7.0


# ── Schemas ──────────────────────────────────────────────────

class BroadcastListCreate(BaseModel):
    account_id: int
    name: str
    contact_ids: List[int] = []


class BroadcastListUpdate(BaseModel):
    name: Optional[str] = None
    contact_ids: Optional[List[int]] = None


class BroadcastSendCreate(BaseModel):
    text: str


def _require_feature(db: Session, user: User):
    if not user_has_permission(db, user, "feature_broadcast"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para usar listas de transmissão.")


def _serialize_list(bl: BroadcastList) -> dict:
    return {
        "id": bl.id,
        "account_id": bl.account_id,
        "name": bl.name,
        "created_by": bl.created_by,
        "created_at": bl.created_at.isoformat() if bl.created_at else None,
        "updated_at": bl.updated_at.isoformat() if bl.updated_at else None,
        "contact_count": len(bl.contacts),
        "contacts": [
            {"id": c.id, "name": c.name or c.push_name or c.phone_number, "phone_number": c.phone_number, "wa_id": c.wa_id}
            for c in bl.contacts
        ],
    }


def _serialize_send(s: BroadcastSend, include_recipients: bool = False) -> dict:
    data = {
        "id": s.id,
        "broadcast_list_id": s.broadcast_list_id,
        "account_id": s.account_id,
        "message_text": s.message_text,
        "status": s.status,
        "total": s.total,
        "sent_count": s.sent_count,
        "failed_count": s.failed_count,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "finished_at": s.finished_at.isoformat() if s.finished_at else None,
    }
    if include_recipients:
        data["recipients"] = [
            {
                "id": r.id,
                "contact_id": r.contact_id,
                "name": r.contact.name or r.contact.push_name or r.contact.phone_number if r.contact else None,
                "status": r.status,
                "error": r.error,
                "sent_at": r.sent_at.isoformat() if r.sent_at else None,
            }
            for r in s.recipients
        ]
    return data


# ── CRUD de listas ───────────────────────────────────────────

@router_broadcast.get("")
async def list_broadcast_lists(account_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    rows = db.query(BroadcastList).filter(BroadcastList.account_id == account_id).order_by(BroadcastList.updated_at.desc()).all()
    return [_serialize_list(r) for r in rows]


@router_broadcast.post("")
async def create_broadcast_list(payload: BroadcastListCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    _require_feature(db, current_user)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nome da lista é obrigatório")

    bl = BroadcastList(account_id=payload.account_id, name=name, created_by=current_user.id)
    if payload.contact_ids:
        bl.contacts = db.query(Contact).filter(Contact.id.in_(payload.contact_ids), Contact.is_group == False).all()
    db.add(bl)
    db.commit()
    db.refresh(bl)
    return _serialize_list(bl)


@router_broadcast.get("/{list_id}")
async def get_broadcast_list(list_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    bl = db.query(BroadcastList).filter(BroadcastList.id == list_id).first()
    if not bl:
        raise HTTPException(status_code=404, detail="Lista não encontrada")
    return _serialize_list(bl)


@router_broadcast.patch("/{list_id}")
async def update_broadcast_list(list_id: int, payload: BroadcastListUpdate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    _require_feature(db, current_user)
    bl = db.query(BroadcastList).filter(BroadcastList.id == list_id).first()
    if not bl:
        raise HTTPException(status_code=404, detail="Lista não encontrada")
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Nome da lista é obrigatório")
        bl.name = name
    if payload.contact_ids is not None:
        bl.contacts = db.query(Contact).filter(Contact.id.in_(payload.contact_ids), Contact.is_group == False).all()
    db.commit()
    db.refresh(bl)
    return _serialize_list(bl)


@router_broadcast.delete("/{list_id}")
async def delete_broadcast_list(list_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    _require_feature(db, current_user)
    bl = db.query(BroadcastList).filter(BroadcastList.id == list_id).first()
    if not bl:
        raise HTTPException(status_code=404, detail="Lista não encontrada")
    db.delete(bl)
    db.commit()
    return {"success": True}


# ── Disparo ──────────────────────────────────────────────────

@router_broadcast.post("/{list_id}/send")
async def send_broadcast(list_id: int, payload: BroadcastSendCreate, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    _require_feature(db, current_user)
    bl = db.query(BroadcastList).filter(BroadcastList.id == list_id).first()
    if not bl:
        raise HTTPException(status_code=404, detail="Lista não encontrada")
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Mensagem não pode ser vazia")
    if not bl.contacts:
        raise HTTPException(status_code=400, detail="Lista não tem nenhum contato")

    send = BroadcastSend(
        broadcast_list_id=bl.id,
        account_id=bl.account_id,
        message_text=text,
        created_by=current_user.id,
        status="pending",
        total=len(bl.contacts),
    )
    db.add(send)
    db.commit()
    db.refresh(send)

    for contact in bl.contacts:
        db.add(BroadcastSendRecipient(broadcast_send_id=send.id, contact_id=contact.id, status="pending"))
    db.commit()

    asyncio.create_task(_run_broadcast_send(send.id))

    return _serialize_send(send)


@router_broadcast.get("/sends/{send_id}")
async def get_broadcast_send(send_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    send = db.query(BroadcastSend).filter(BroadcastSend.id == send_id).first()
    if not send:
        raise HTTPException(status_code=404, detail="Disparo não encontrado")
    return _serialize_send(send, include_recipients=True)


@router_broadcast.get("/{list_id}/sends")
async def list_broadcast_sends(list_id: int, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    rows = db.query(BroadcastSend).filter(BroadcastSend.broadcast_list_id == list_id).order_by(BroadcastSend.created_at.desc()).all()
    return [_serialize_send(r) for r in rows]


async def _run_broadcast_send(send_id: int):
    """
    Roda em background (fora do ciclo request/response) — sessão própria via
    SessionLocal(), mesmo padrão já usado em websocket.py pra código
    disparado fora de uma rota. Processa um destinatário por vez com
    throttle aleatório entre envios (ver docstring do módulo).
    """
    from backend.api.routes import get_provider, _get_contact_and_conversation, _extract_wamid

    db = SessionLocal()
    try:
        send = db.query(BroadcastSend).filter(BroadcastSend.id == send_id).first()
        if not send:
            return
        send.status = "sending"
        db.commit()

        creator = db.query(User).filter(User.id == send.created_by).first()
        if creator:
            identity_prefix = build_identity_prefix(creator.full_name, creator.email, creator.display_name_format, creator.sector)
            final_text = f"{identity_prefix}{send.message_text}"
        else:
            final_text = send.message_text

        try:
            provider, provider_kind = get_provider(db, send.account_id)
        except HTTPException as e:
            send.status = "failed"
            send.finished_at = datetime.utcnow()
            db.commit()
            logger.error(f"[Broadcast] Envio {send_id} abortado — provider indisponível: {e.detail}")
            await ws_manager.broadcast_broadcast_progress(_progress_payload(send))
            return

        recipients = db.query(BroadcastSendRecipient).filter(BroadcastSendRecipient.broadcast_send_id == send_id).all()

        for i, recipient in enumerate(recipients):
            contact = db.query(Contact).filter(Contact.id == recipient.contact_id).first()
            if not contact:
                recipient.status = "failed"
                recipient.error = "Contato não existe mais"
                send.failed_count += 1
                db.commit()
                continue

            try:
                api_response = await provider.send_text_message(to=contact.wa_id, text=final_text)
                if api_response.get("success") is False:
                    raise RuntimeError(api_response.get("error", "Falha ao enviar"))

                wamid = _extract_wamid(api_response, provider_kind)
                if wamid:
                    _, conversation = _get_contact_and_conversation(db, contact.wa_id, send.account_id)
                    conversation_service.save_outbound_message(
                        db=db, wamid=wamid, conversation_id=conversation.id, contact_id=contact.id,
                        message_type="text", message_text=final_text,
                    )
                    await ws_manager.broadcast_new_message({
                        "wamid": wamid, "type": "text", "direction": "outbound", "from_number": "me",
                        "message": final_text, "sender": "me", "conversation_id": conversation.id,
                        "account_id": send.account_id, "timestamp": int(datetime.utcnow().timestamp() * 1000),
                    })

                recipient.status = "sent"
                recipient.wamid = wamid
                recipient.sent_at = datetime.utcnow()
                send.sent_count += 1
            except Exception as e:
                logger.warning(f"[Broadcast] Falha ao enviar para contato {contact.id}: {e}")
                recipient.status = "failed"
                recipient.error = str(e)[:500]
                send.failed_count += 1

            db.commit()
            await ws_manager.broadcast_broadcast_progress(_progress_payload(send))

            if i < len(recipients) - 1:
                await asyncio.sleep(random.uniform(MIN_THROTTLE_S, MAX_THROTTLE_S))

        send.status = "done"
        send.finished_at = datetime.utcnow()
        db.commit()
        await ws_manager.broadcast_broadcast_progress(_progress_payload(send))
    finally:
        db.close()


def _progress_payload(send: BroadcastSend) -> dict:
    return {
        "id": send.id,
        "broadcast_list_id": send.broadcast_list_id,
        "status": send.status,
        "total": send.total,
        "sent_count": send.sent_count,
        "failed_count": send.failed_count,
    }
