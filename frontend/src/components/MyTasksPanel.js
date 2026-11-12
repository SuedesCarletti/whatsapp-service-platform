/**
 * MyTasksPanel.js — painel global "minhas tarefas": todas as tarefas abertas
 * atribuídas a mim ou criadas por mim, em qualquer conversa da Equipe, num
 * lugar só. Aberto pelo ícone de Tarefas no IconRail (abaixo de Mídia).
 * Clicar numa tarefa leva pra conversa certa e abre o detalhe.
 */
import React from 'react';
import { BsX, BsListCheck, BsPeopleFill } from 'react-icons/bs';
import moment from 'moment';
import 'moment/locale/pt-br';
import { TaskPriorityBadge } from './InternalChatArea';

moment.locale('pt-br');

const formatDue = (dueAt) => {
  if (!dueAt) return null;
  const m = moment(dueAt);
  const overdue = m.isBefore(moment());
  return { text: m.calendar(), overdue };
};

const MyTasksPanel = ({ tasks = [], currentUserId, onClose, onOpenTask, onNewTask }) => {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><BsListCheck style={{ verticalAlign: -3, marginRight: 6 }} /> Minhas tarefas</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {onNewTask && (
              <button className="es-link-btn" onClick={onNewTask} style={{ fontSize: 13 }}>+ Nova</button>
            )}
            <button className="modal-close" onClick={onClose}><BsX size={22} /></button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: '8px 12px 16px' }}>
          {tasks.length === 0 ? (
            <div style={{ padding: '30px 10px', textAlign: 'center', color: 'var(--text-secondary, #888)', fontSize: 13.5 }}>
              Nenhuma tarefa aberta atribuída ou criada por você. 🎉
            </div>
          ) : (
            tasks.map(task => {
              const due = formatDue(task.due_at);
              const isMine = task.assigned_to?.id === currentUserId;
              return (
                <div
                  key={task.id}
                  onClick={() => onOpenTask(task)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 8px',
                    borderRadius: 8, cursor: 'pointer', borderBottom: '1px solid var(--border-color, #eee)',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-hover, #f5f5f5)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  {task.is_unread && (
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', background: '#e02e2e',
                      marginTop: 6, flexShrink: 0,
                    }} title="Não vista" />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ fontSize: 13.5, fontWeight: task.is_unread ? 700 : 500 }}>{task.title}</div>
                      <TaskPriorityBadge priority={task.priority} />
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary, #888)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                      {task.customer_conversation_id ? (
                        <span title="Vinculada a uma conversa de cliente — só você vê">🔒 {task.conversation_name}</span>
                      ) : task.conversation_id ? (<>
                        {task.conversation_is_group && <BsPeopleFill size={10} />}
                        <span>{task.conversation_name}</span>
                      </>) : (
                        <span>👤 Pessoal</span>
                      )}
                      {!isMine && <span>· criada por você</span>}
                      {due && <span style={{ color: due.overdue ? '#e02e2e' : undefined }}>· {due.text}</span>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default MyTasksPanel;
