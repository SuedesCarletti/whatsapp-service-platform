"""
task_pause_reminder_watchdog.py — lembrete de tarefa pausada.

Ao pausar uma tarefa (ver pause_internal_task em routes_internal_chat.py),
quem pausou pode escolher opcionalmente um horário pra ser lembrado — sem
isso, uma tarefa pausada fica esquecida pra sempre até alguém abrir de novo
por acaso. Este watchdog varre tarefas pausadas com pause_reminder_at
vencido e ainda não notificado, posta um aviso na timeline do chat (mensagem
"do sistema", sender_id=None — ver _persist_and_broadcast_message —, então
is_mine fica False pra TODOS os participantes, inclusive quem pausou, e o
popup/som de notificação dispara mesmo pra quem precisa lembrar) e marca
pause_reminder_notified_at pra não repetir a cada ciclo.

Mesmo padrão de bridge_watchdog.py/csat_timeout_watchdog.py: loop asyncio
puro (sem APScheduler), uma sessão nova por ciclo, exceções isoladas nunca
derrubam o loop.
"""
import asyncio
import logging
from datetime import datetime

from backend.database.connection import SessionLocal
from backend.database.models import InternalTask, InternalTaskHistory
from backend.services.web_push import send_push_to_user

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 60  # a UI só escolhe minuto (datetime-local), não precisa de mais precisão


async def _fire_due_reminders() -> None:
    # Import tardio: routes_internal_chat importa muita coisa do app inteiro
    # (webhooks, settings...) — importar no topo do módulo criaria um ciclo
    # com app.py, que importa este watchdog. Mesmo motivo do _load_settings
    # tardio em csat_timeout_watchdog.py.
    from backend.api.routes_internal_chat import _persist_and_broadcast_message, _broadcast_task, _format_task
    from backend.api.websocket import ws_manager

    db = SessionLocal()
    try:
        due = db.query(InternalTask).filter(
            InternalTask.status == "paused",
            InternalTask.pause_reminder_at.isnot(None),
            InternalTask.pause_reminder_at <= datetime.utcnow(),
            InternalTask.pause_reminder_notified_at.is_(None),
        ).all()

        for task in due:
            task.pause_reminder_notified_at = datetime.utcnow()
            db.add(InternalTaskHistory(task_id=task.id, event="pause_reminder"))
            db.commit()

            pauser_name = task.pauser.full_name if task.pauser else "alguém"
            text = f"⏰ Lembrete: a tarefa \"{task.title}\" segue pausada (por {pauser_name}) — não esqueça de retomar."
            try:
                if task.conversation_id is not None:
                    conv = task.conversation
                    await _persist_and_broadcast_message(
                        db, conv, None, text=text, message_type="task", task_id=task.id, task_event="pause_reminder",
                    )
                    await _broadcast_task(db, task, conv)
                else:
                    # Pessoal ou vinculada a conversa de CLIENTE — sem
                    # timeline pra postar aviso (cliente nunca pode receber
                    # nada disso). Entrega direta por socket pra quem criou/
                    # é responsável, mesmo popup central de lembrete no
                    # front, + broadcast de estado pra quem tiver a faixa
                    # de tarefas dessa conversa de cliente aberta agora.
                    uids = list({task.created_by, task.assigned_to} - {None})
                    await ws_manager.notify_task_reminder(uids, {"text": text, "task": _format_task(task), "kind": "pause_reminder"})
                    await _broadcast_task(db, task, None)
                # Web Push — chega no computador mesmo com o navegador
                # fechado (pedido explícito, ver web_push.py). O aviso acima
                # já cobre quem está com o app aberto agora; isso é pra
                # quem não está.
                for uid in {task.created_by, task.assigned_to} - {None}:
                    send_push_to_user(db, uid, "⏰ Lembrete de tarefa pausada", text, url="/app")
                logger.info(f"[TaskPauseReminderWatchdog] Lembrete disparado — tarefa #{task.id}")
            except Exception as exc:
                logger.error(f"[TaskPauseReminderWatchdog] Falha ao notificar tarefa #{task.id}: {exc}", exc_info=True)
    finally:
        db.close()


async def run_task_pause_reminder_watchdog():
    logger.info(f"[TaskPauseReminderWatchdog] Iniciado — verificação a cada {CHECK_INTERVAL_S}s")
    while True:
        try:
            await _fire_due_reminders()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"[TaskPauseReminderWatchdog] Erro no ciclo de verificação: {exc}", exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_S)
