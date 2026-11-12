"""
Integração genérica de bot/IA — canal de ENTRADA (ferramenta de IA → wpp).

Qualquer ferramenta que fale HTTP+JSON (n8n, Make, um script próprio) pode
usar POST /api/bot/reply pra enviar a resposta gerada de volta pro cliente,
sem precisar saber qual provider (Baileys/WPPConnect/WA-Web/Venom/Meta Cloud
API) está por trás da conta. O canal de SAÍDA (wpp → ferramenta de IA, quando
uma mensagem chega) fica em webhook_handler.py::_forward_to_ai_webhook.

Autenticação: não é usuário logado (sem JWT) — é um segredo compartilhado
por conta (WhatsAppAccount.ai_webhook_secret), o mesmo usado no header
Authorization tanto pro wpp mandar o POST de saída quanto aqui pra validar
quem está mandando a resposta.

Registrar em app.py:
    from backend.api.routes_ai_bot import ai_bot_router
    app.include_router(ai_bot_router, prefix="/api", tags=["Bot/IA"])
"""

import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.database.models import Conversation, WhatsAppAccount
from backend.models.schemas import APIResponse
from backend.services.conversation_service import conversation_service
from backend.api.websocket import ws_manager

logger = logging.getLogger(__name__)

ai_bot_router = APIRouter()


class BotReplyRequest(BaseModel):
    conversation_id: int
    text: str


@ai_bot_router.post("/bot/reply")
async def bot_reply(
    payload: BotReplyRequest,
    db: Session = Depends(get_db),
    authorization: str = Header(default=""),
):
    conversation = db.query(Conversation).filter(Conversation.id == payload.conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == conversation.account_id).first()
    secret = account.ai_webhook_secret if account else None
    token = authorization[7:] if authorization.lower().startswith("bearer ") else authorization
    if not secret or token != secret:
        raise HTTPException(status_code=401, detail="Token inválido")

    if not conversation.bot_enabled:
        raise HTTPException(status_code=409, detail="bot_paused")

    # Import local pra evitar ciclo de import (routes.py importa vários
    # módulos que, transitivamente, acabariam importando este arquivo).
    from backend.api.routes import send_forwarded_message_to_conversation

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text não pode ser vazio")

    # Bookkeeping de "bot respondeu" (limpa bot_forwarded_at, atualiza
    # detecção de loop por repetição) — ver ConversationService.
    # register_bot_reply, compartilhado com routes_evolution_compat.py.
    changes = conversation_service.register_bot_reply(db, conversation, text)
    db.commit()
    if changes:
        await ws_manager.broadcast_conversation_meta_update({
            "conversation_id": conversation.id, **changes,
        })

    wamid = await send_forwarded_message_to_conversation(db, conversation, text=text)
    if not wamid:
        # send_forwarded_message_to_conversation não levanta exceção em falha
        # do provider (ex: sessão Baileys não pareada) — só retorna None. Sem
        # esse check a ferramenta de IA veria "success: true" mesmo sem nada
        # ter sido enviado de verdade.
        raise HTTPException(status_code=502, detail="Falha ao enviar mensagem — verifique se a conta está conectada/pareada")

    return APIResponse(success=True, data={"message_id": wamid, "conversation_id": conversation.id})
