"""
routes_push.py — inscrição/desinscrição de Web Push do navegador do usuário
(ver subscribeToPush em src/utils/desktopNotify.js e send_push_to_user em
backend/services/web_push.py).

Registrar em app.py:
    from backend.api.routes_push import router_push
    app.include_router(router_push, prefix="/api/push", tags=["Push"])
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.database.models import PushSubscription, User
from backend.api.routes_auth import get_current_user
from backend.models.schemas import APIResponse
from backend.services.web_push import VAPID_PUBLIC_KEY

router_push = APIRouter()


@router_push.get("/vapid-public-key")
async def get_vapid_public_key():
    return APIResponse(success=True, data={"public_key": VAPID_PUBLIC_KEY or None})


class SubscribeKeys(BaseModel):
    p256dh: str
    auth: str


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: SubscribeKeys


@router_push.post("/subscribe")
async def subscribe_push(
    payload: SubscribeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upsert por endpoint — resubscrever o mesmo navegador (ex: chaves
    rotacionadas pelo browser) atualiza em vez de duplicar. Um endpoint só
    pode pertencer a um usuário por vez: se essa inscrição já existia pra
    OUTRA conta neste mesmo navegador (ex: logout+login de outra pessoa na
    mesma máquina), ela passa a apontar pro usuário atual — senão a pessoa
    antiga continuaria recebendo push do que acontece na sessão nova."""
    existing = db.query(PushSubscription).filter(PushSubscription.endpoint == payload.endpoint).first()
    if existing:
        existing.user_id = current_user.id
        existing.p256dh = payload.keys.p256dh
        existing.auth = payload.keys.auth
    else:
        db.add(PushSubscription(
            user_id=current_user.id, endpoint=payload.endpoint,
            p256dh=payload.keys.p256dh, auth=payload.keys.auth,
        ))
    db.commit()
    return APIResponse(success=True, data=None)


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router_push.post("/unsubscribe")
async def unsubscribe_push(
    payload: UnsubscribeRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == payload.endpoint, PushSubscription.user_id == current_user.id,
    ).delete(synchronize_session=False)
    db.commit()
    return APIResponse(success=True, data=None)
