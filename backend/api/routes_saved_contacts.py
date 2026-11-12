"""
Agenda pessoal de contatos vCard — evita redigitar nome/telefone toda vez
no ContactSender. Mesmo padrão de routes_stickers.py (galeria pessoal por
usuário, sem FK pra conversa/mensagem de origem).

Registrar em app.py:
    from backend.api.routes_saved_contacts import router_saved_contacts
    app.include_router(router_saved_contacts, prefix="/api/saved-contacts", tags=["Saved Contacts"])
"""

import logging
from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.database.models import SavedContact, User
from backend.api.routes_auth import get_current_user
from backend.models.schemas import APIResponse
from backend.utils.time_utils import to_utc_iso

logger = logging.getLogger(__name__)

router_saved_contacts = APIRouter()


def _brief(c: SavedContact) -> dict:
    return {
        "id": c.id,
        "display_name": c.display_name,
        "contact_data": c.contact_data,
        "created_at": to_utc_iso(c.created_at),
    }


@router_saved_contacts.get("")
async def list_saved_contacts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    contacts = db.query(SavedContact).filter(
        SavedContact.user_id == current_user.id
    ).order_by(SavedContact.display_name.asc()).all()
    return APIResponse(success=True, data=[_brief(c) for c in contacts])


class SaveContactRequest(BaseModel):
    display_name: str
    contact_data: Dict[str, Any]


@router_saved_contacts.post("")
async def save_contact(
    payload: SaveContactRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not payload.display_name.strip():
        raise HTTPException(status_code=400, detail="Nome é obrigatório")
    if not payload.contact_data:
        raise HTTPException(status_code=400, detail="contact_data é obrigatório")

    contact = SavedContact(
        user_id=current_user.id,
        display_name=payload.display_name.strip(),
        contact_data=payload.contact_data,
    )
    db.add(contact)
    db.commit()
    db.refresh(contact)
    return APIResponse(success=True, data=_brief(contact))


class UpdateContactRequest(BaseModel):
    display_name: Optional[str] = None
    contact_data: Optional[Dict[str, Any]] = None


@router_saved_contacts.put("/{contact_id}")
async def update_saved_contact(
    contact_id: int,
    payload: UpdateContactRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    contact = db.query(SavedContact).filter(
        SavedContact.id == contact_id, SavedContact.user_id == current_user.id
    ).first()
    if not contact:
        raise HTTPException(status_code=404, detail="Contato salvo não encontrado")

    if payload.display_name is not None:
        if not payload.display_name.strip():
            raise HTTPException(status_code=400, detail="Nome é obrigatório")
        contact.display_name = payload.display_name.strip()
    if payload.contact_data is not None:
        contact.contact_data = payload.contact_data

    db.commit()
    db.refresh(contact)
    return APIResponse(success=True, data=_brief(contact))


@router_saved_contacts.delete("/{contact_id}")
async def delete_saved_contact(
    contact_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    contact = db.query(SavedContact).filter(
        SavedContact.id == contact_id, SavedContact.user_id == current_user.id
    ).first()
    if not contact:
        raise HTTPException(status_code=404, detail="Contato salvo não encontrado")
    db.delete(contact)
    db.commit()
    return APIResponse(success=True, data={"id": contact_id})
