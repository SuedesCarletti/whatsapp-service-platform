"""
task_due_reminder_watchdog.py — lembrete de tarefa com PRAZO vencido.

Diferente do lembrete de pausa (task_pause_reminder_watchdog.py, opcional,
agendado por quem pausou), este é automático: qualquer tarefa pendente com
due_at preenchido dispara sozinha quando o prazo chega, sem precisar que
ninguém escolha um horário — pedido explícito (mesmo tratamento de popup +
push que já existia só pra pausa). Só dispara pra tarefas "pending" (pausada/
cancelada/concluída não fazem sentido lembrar — ver filtro abaixo) e só uma
vez por prazo (due_reminder_notified_at, limpo de novo se o prazo for
editado — ver update_internal_task em routes_internal_chat.py).

Mesmo padrão de bridge_watchdog.py/task_pause_reminder_watchdog.py: loop
asyncio puro, uma sessão nova por ciclo, exceções isoladas nunca derrubam o
loop.
"""
import asyncio
import logging
from datetime import datetime

from backend.database.connection import SessionLocal
from backend.database.models import InternalTask, InternalTaskHistory
from backend.services.web_push import send_push_to_user

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 60


async def _fire_due_reminders() -> None:
    # Import tardio — mesmo motivo do task_pause_reminder_watchdog.py (evita
    # ciclo de import com app.py via routes_internal_chat).
    from backend.api.routes_internal_chat import _persist_and_broadcast_message, _broadcast_task, _format_task
    from backend.api.websocket import ws_manager

    db = SessionLocal()
    try:
        due = db.query(InternalTask).filter(
            InternalTask.status == "pending",
            InternalTask.due_at.isnot(None),
            InternalTask.due_at <= datetime.utcnow(),
            InternalTask.due_reminder_notified_at.is_(None),
        ).all()

        for task in due:
            task.due_reminder_notified_at = datetime.utcnow()
            db.add(InternalTaskHistory(task_id=task.id, event="due_reminder"))
            db.commit()

            text = f"⏰ Lembrete: o prazo da tarefa \"{task.title}\" chegou."
            try:
                if task.conversation_id is not None:
                    conv = task.conversation
                    await _persist_and_broadcast_message(
                        db, conv, None, text=text, message_type="task", task_id=task.id, task_event="due_reminder",
                    )
                    await _broadcast_task(db, task, conv)
                else:
                    uids = list({task.created_by, task.assigned_to} - {None})
                    await ws_manager.notify_task_reminder(uids, {"text": text, "task": _format_task(task), "kind": "due_reminder"})
                    await _broadcast_task(db, task, None)
                for uid in {task.created_by, task.assigned_to} - {None}:
                    send_push_to_user(db, uid, "⏰ Prazo de tarefa chegou", text, url="/app")
                logger.info(f"[TaskDueReminderWatchdog] Lembrete disparado — tarefa #{task.id}")
            except Exception as exc:
                logger.error(f"[TaskDueReminderWatchdog] Falha ao notificar tarefa #{task.id}: {exc}", exc_info=True)
    finally:
        db.close()


async def run_task_due_reminder_watchdog():
    logger.info(f"[TaskDueReminderWatchdog] Iniciado — verificação a cada {CHECK_INTERVAL_S}s")
    while True:
        try:
            await _fire_due_reminders()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"[TaskDueReminderWatchdog] Erro no ciclo de verificação: {exc}", exc_info=True)

        await asyncio.sleep(CHECK_INTERVAL_S)
