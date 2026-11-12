"""
bot_health_watchdog.py — detecta bot/IA travado por silêncio prolongado.

Complementa os outros dois sinais de "bot precisa de atenção" (erro/exceção
ao encaminhar em webhook_handler._forward_to_ai_webhook, resposta repetida em
routes_ai_bot.py::bot_reply): esse aqui cobre o caso em que o webhook de IA
respondeu 200 ao receber a mensagem (aceitou processar) mas nunca chamou
POST /api/bot/reply de volta — o workflow trava no meio (loop infinito
interno, erro não tratado, nó pendurado esperando algo que nunca chega).

Conversation.bot_forwarded_at marca "mandei pro bot, ainda esperando resposta"
— setado em _forward_to_ai_webhook, limpo em bot_reply() assim que a resposta
chega. Se ficar setado por mais que FREEZE_TIMEOUT, marca bot_loop_detected.

Mesmo padrão de bridge_watchdog.py/csat_timeout_watchdog.py: loop asyncio
puro, sessão nova por ciclo, exceções isoladas nunca derrubam o loop.
"""
import asyncio
import logging
from datetime import datetime, timedelta

from backend.database.connection import SessionLocal
from backend.database.models import Conversation
from backend.api.websocket import ws_manager
from backend.services.conversation_service import conversation_service

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 60
FREEZE_TIMEOUT = timedelta(minutes=5)


async def _check_stuck_conversations() -> None:
    cutoff = datetime.utcnow() - FREEZE_TIMEOUT

    db = SessionLocal()
    try:
        stuck = db.query(Conversation).filter(
            Conversation.bot_enabled == True,  # noqa: E712
            Conversation.bot_forwarded_at.isnot(None),
            Conversation.bot_forwarded_at < cutoff,
            Conversation.bot_loop_detected == False,  # noqa: E712
        ).all()

        for conversation in stuck:
            if conversation_service.flag_bot_needs_attention(db, conversation):
                logger.info(
                    f"[BotHealthWatchdog] Bot sem responder há mais de {FREEZE_TIMEOUT} — conversa #{conversation.id}"
                )
                try:
                    await ws_manager.broadcast_conversation_meta_update({
                        "conversation_id": conversation.id, "bot_loop_detected": True,
                    })
                except Exception as exc:
                    logger.warning(f"[BotHealthWatchdog] Falha ao notificar via WebSocket (conversa #{conversation.id}): {exc}")
    finally:
        db.close()


async def run_bot_health_watchdog():
    logger.info(f"[BotHealthWatchdog] Iniciado — verificação a cada {CHECK_INTERVAL_S}s")
    while True:
        try:
            await _check_stuck_conversations()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"[BotHealthWatchdog] Erro no ciclo de verificação: {exc}", exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_S)
