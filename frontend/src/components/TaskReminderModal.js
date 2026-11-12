/**
 * TaskReminderModal — lembrete de tarefa (pausada OU com prazo vencido,
 * ver task_pause_reminder_watchdog.py / task_due_reminder_watchdog.py) como
 * popup modal de verdade: fundo escurecido, foco só nele. Substitui o toast
 * de canto (pedido explícito: um toast passa despercebido, atrapalha
 * lembrar de fato — precisa interromper a tela como os outros modais do
 * app, não só piscar no canto). Som + notificação desktop/push (se
 * permitida/inscrita) continuam disparando à parte, ver notifyNewMessage e
 * subscribeToPush em App.js.
 */
import React from 'react';
import { BsAlarm } from 'react-icons/bs';

const TaskReminderModal = ({ reminder, onOpenTask, onClose }) => {
  if (!reminder) return null;
  const task = reminder.task;
  const isDueReminder = reminder.kind === 'due_reminder';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><BsAlarm style={{ verticalAlign: -3, marginRight: 6 }} /> {isDueReminder ? 'Lembrete de prazo' : 'Lembrete de tarefa pausada'}</h3>
        </div>

        <div className="modal-body" style={{ padding: '20px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>⏰</div>
          <div style={{ fontSize: 15, lineHeight: 1.5 }}>{reminder.text}</div>
          {!isDueReminder && task?.pause_reason && (
            <div style={{ fontSize: 13, opacity: 0.7, marginTop: 10, fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
              "{task.pause_reason}"
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Dispensar</button>
          {task && (
            <button
              className="btn-primary"
              onClick={() => { onOpenTask?.(task); onClose(); }}
            >
              Ver tarefa
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default TaskReminderModal;
