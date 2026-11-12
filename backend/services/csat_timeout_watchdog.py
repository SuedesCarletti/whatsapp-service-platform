"""
csat_timeout_watchdog.py — auto-encerramento da janela de CSAT.

Quando uma conversa é resolvida (ver routes_attendance.py::update_conversation_status),
a pesquisa de satisfação é enviada e `awaiting_csat` vira True. Se o cliente
nunca responder, essa janela ficaria aberta pra sempre — este watchdog fecha
sozinho depois de `csat.timeout_hours` (config em Configurações → Automações,
0 = nunca expira), só limpando a flag `awaiting_csat` (não grava CsatResponse
nenhum — "sem resposta" não é uma nota).

Sempre filtra por `awaiting_csat == True`, nunca só pela idade de
`resolved_at` isolado: reabrir uma conversa resolvida (webhook_handler.py,
cliente escreveu de novo) limpa `awaiting_csat` mas não limpa `resolved_at`
(fica "sujo"), então usar só `resolved_at` classificaria erroneamente uma
conversa já reaberta como "janela de CSAT vencida".

Mesmo padrão de bridge_watchdog.py: loop asyncio puro (sem APScheduler),
uma sessão nova por ciclo, exceções isoladas nunca derrubam o loop.
"""
import asyncio
import logging
from datetime import datetime, timedelta

from backend.database.connection import SessionLocal
from backend.database.models import Conversation
from backend.api.websocket import ws_manager

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 900  # 15 min — timeout é configurado em horas, não precisa de mais precisão que isso


def _read_timeout_hours() -> int:
    from backend.api.routes_settings import _load_settings

    try:
        csat = _load_settings().get("automations", {}).get("csat", {})
        return int(csat.get("timeout_hours", 24) or 0)
    except Exception as exc:
        logger.warning(f"[CsatTimeoutWatchdog] Falha ao ler timeout_hours, usando 24h: {exc}")
        return 24


async def _close_expired_windows() -> None:
    timeout_hours = _read_timeout_hours()
    if timeout_hours <= 0:
        return  # 0 = nunca expira

    cutoff = datetime.utcnow() - timedelta(hours=timeout_hours)

    db = SessionLocal()
    try:
        expired = db.query(Conversation).filter(
            Conversation.awaiting_csat == True,  # noqa: E712
            Conversation.resolved_at.isnot(None),
            Conversation.resolved_at < cutoff,
        ).all()

        for conversation in expired:
            conversation.awaiting_csat = False
            db.commit()
            logger.info(f"[CsatTimeoutWatchdog] Janela de CSAT encerrada por timeout — conversa #{conversation.id}")
            try:
                await ws_manager.broadcast_conversation_meta_update({
                    "conversation_id": conversation.id, "awaiting_csat": False,
                })
            except Exception as exc:
                logger.warning(f"[CsatTimeoutWatchdog] Falha ao notificar via WebSocket (conversa #{conversation.id}): {exc}")
    finally:
        db.close()


async def run_csat_timeout_watchdog():
    logger.info(f"[CsatTimeoutWatchdog] Iniciado — verificação a cada {CHECK_INTERVAL_S}s")
    while True:
        try:
            await _close_expired_windows()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"[CsatTimeoutWatchdog] Erro no ciclo de verificação: {exc}", exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_S)
