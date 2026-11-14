/**
 * TaskDetailModal — visão expandida de uma InternalTask: editar título/
 * descrição/responsável/prazo, marcar feita/reabrir, checklist de subtasks
 * e anexos (arquivo/imagem). Abre a partir do card na timeline do chat
 * (InternalChatArea) ou da lista em "Dados do contato"/"Dados do grupo"
 * (InternalContactInfoPanel/InternalGroupManager) — mesma tarefa, mesmo
 * modal, sincronizado ao vivo via internal_task_updated (o `task` que chega
 * por prop já reflete qualquer mudança de outra aba/pessoa).
 */
import React, { useState, useRef } from 'react';
import { BsX, BsListCheck, BsPaperclip, BsTrash, BsPlus, BsFileEarmark, BsDownload, BsPauseFill, BsPlayFill, BsXCircle, BsArrowCounterclockwise } from 'react-icons/bs';
import { MdEdit } from 'react-icons/md';
import moment from 'moment';

const RECURRENCE_LABELS = { daily: 'dia(s)', weekly: 'semana(s)', monthly: 'mês(es)' };
// 0=segunda...6=domingo — mesma convenção de datetime.weekday() usada no backend.
const WEEKDAY_LABELS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

// low|medium|high|urgent — mesma convenção usada no backend (TASK_PRIORITIES).
const PRIORITY_META = {
  low: { label: 'Baixa', color: '#8a8f98' },
  medium: { label: 'Média', color: '#3b82f6' },
  high: { label: 'Alta', color: '#f59e0b' },
  urgent: { label: 'Urgente', color: '#e53e3e' },
};

const TASK_HISTORY_LABELS = {
  created: '📋 criou a tarefa',
  completed: 'concluiu a tarefa',
  approved: '👍 aprovou a conclusão',
  rejected: '👎 reprovou a conclusão',
  reopened: '🔄 reabriu a tarefa',
  paused: '⏸️ pausou a tarefa',
  resumed: '▶️ retomou a tarefa',
  pause_reminder: '⏰ lembrete de pausa disparado',
  cancelled: '🚫 cancelou a tarefa',
  uncancelled: '↩️ reativou a tarefa',
  due_reminder: '⏰ lembrete de prazo disparado',
};

const TaskDetailModal = ({ task, conversation, currentUserId, onClose, onUpdate, onAddSubtask, onToggleSubtask, onDeleteSubtask, onAddAttachment, onDeleteAttachment, onApprove, onReject, onPause, onResume, approving, rejecting, resuming, onCancel, onUncancel, uncancelling }) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(task.title);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionInput, setDescriptionInput] = useState(task.description || '');
  const [newSubtask, setNewSubtask] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingReminder, setEditingReminder] = useState(false);
  const [reminderInput, setReminderInput] = useState('');
  const fileInputRef = useRef(null);

  if (!task) return null;
  const isDone = task.status === 'done';
  const isPaused = task.status === 'paused';
  const isCancelled = task.status === 'cancelled';
  // Pessoal/de conversa de cliente não tem roster de conversa — pelo menos
  // quem criou/é responsável aparecem como opção (senão um responsável já
  // definido apareceria como "Ninguém em especial" no <select>, mesmo tendo
  // valor real).
  const participants = conversation?.participants
    || [task.created_by, task.assigned_to].filter(Boolean).filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i);
  // Concluir (tarefa e subtarefas) é só de quem criou ou é responsável;
  // descrição é só de quem criou; aprovar/reprovar a conclusão é só de
  // quem criou (o responsável concluir e também poder auto-aprovar
  // esvaziaria o sentido da aprovação). Pausar/retomar/cancelar/reativar
  // usa a mesma regra de concluir (criador ou responsável) — backend
  // reforça igual.
  const isCreator = currentUserId === task.created_by?.id;
  const canComplete = isCreator || currentUserId === task.assigned_to?.id;
  const canApprove = isDone && !task.approved_by && isCreator;
  const canPauseOrResume = canComplete && !isDone && !isCancelled;
  const canCancel = canComplete && !isDone && !isCancelled;
  const canUncancel = canComplete && isCancelled;

  const saveTitle = () => {
    const trimmed = titleInput.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === task.title) { setTitleInput(task.title); return; }
    onUpdate({ title: trimmed });
  };

  const saveDescription = () => {
    setEditingDescription(false);
    if (descriptionInput.trim() === (task.description || '')) return;
    onUpdate({ description: descriptionInput.trim() });
  };

  const handleAssigneeChange = (e) => {
    const value = e.target.value;
    if (!value) onUpdate({ clearAssignedTo: true });
    else onUpdate({ assignedTo: Number(value) });
  };

  const handleDueChange = (e) => {
    const value = e.target.value;
    if (!value) onUpdate({ clearDueAt: true });
    else onUpdate({ dueAt: new Date(value).toISOString() });
  };

  const handleAddSubtask = () => {
    const title = newSubtask.trim();
    if (!title) return;
    onAddSubtask(title);
    setNewSubtask('');
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      await onAddAttachment(file);
    } finally {
      setUploading(false);
    }
  };

  const doneSubtasks = (task.subtasks || []).filter(s => s.is_done).length;
  const totalSubtasks = (task.subtasks || []).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><BsListCheck style={{ verticalAlign: -3, marginRight: 6 }} /> Tarefa</h3>
          <button className="modal-close" onClick={onClose}><BsX size={22} /></button>
        </div>

        <div className="modal-body" style={{ padding: '18px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Título + concluir */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <input
              type="checkbox" checked={isDone}
              disabled={!canComplete || isPaused || isCancelled}
              title={isPaused ? 'Tarefa pausada — retome antes de concluir' : isCancelled ? 'Tarefa cancelada — reative antes de concluir' : (canComplete ? undefined : 'Só quem criou ou é responsável pode concluir')}
              onChange={() => onUpdate({ status: isDone ? 'pending' : 'done' })}
              style={{ marginTop: 4, cursor: (canComplete && !isPaused && !isCancelled) ? 'pointer' : 'default', flexShrink: 0, width: 18, height: 18 }}
            />
            {editingTitle ? (
              <input
                type="text" value={titleInput} onChange={(e) => setTitleInput(e.target.value)}
                onBlur={saveTitle} onKeyPress={(e) => e.key === 'Enter' && saveTitle()}
                autoFocus style={{ flex: 1, fontSize: 16, fontWeight: 600 }}
              />
            ) : (
              <div
                onClick={() => setEditingTitle(true)}
                style={{
                  flex: 1, fontSize: 16, fontWeight: 600, cursor: 'pointer',
                  textDecoration: (isDone || isCancelled) ? 'line-through' : 'none', opacity: (isDone || isCancelled) ? 0.6 : 1,
                }}
                title="Clique para editar"
              >
                {task.title} <MdEdit size={13} style={{ opacity: 0.4, verticalAlign: -1 }} />
              </div>
            )}
          </div>
          <div style={{ marginTop: -12, marginLeft: 28, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
              color: '#fff', background: (PRIORITY_META[task.priority] || PRIORITY_META.medium).color,
            }}>
              {(PRIORITY_META[task.priority] || PRIORITY_META.medium).label}
            </span>
            {task.customer_conversation_id && (
              <span style={{ fontSize: 11, opacity: 0.65 }} title="Vinculada a esta conversa pro seu controle — o cliente nunca vê nem recebe nada sobre isso.">
                🔒 Só pra você
              </span>
            )}
            {!task.conversation_id && !task.customer_conversation_id && (
              <span style={{ fontSize: 11, opacity: 0.65 }}>👤 Tarefa pessoal</span>
            )}
          </div>
          {isDone && task.completed_by && (
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: -12, marginLeft: 28 }}>
              Concluída por {task.completed_by.full_name} {task.completed_at && `em ${moment(task.completed_at).format('DD/MM/YYYY HH:mm')}`}
            </div>
          )}
          {task.approved_by && (
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: -12, marginLeft: 28 }}>
              👍 Aprovada por {task.approved_by.full_name} {task.approved_at && `em ${moment(task.approved_at).format('DD/MM/YYYY HH:mm')}`}
            </div>
          )}
          {isPaused && (
            <div style={{
              fontSize: 12.5, marginTop: -8, marginLeft: 28, padding: '8px 10px', borderRadius: 8,
              background: 'var(--bg-secondary, #f9f9f9)', borderLeft: '3px solid var(--brand-orange, var(--whatsapp-green))',
            }}>
              <div style={{ fontWeight: 600 }}>
                ⏸️ Pausada por {task.paused_by?.full_name || 'alguém'} {task.paused_at && `em ${moment(task.paused_at).format('DD/MM/YYYY HH:mm')}`}
              </div>
              {task.pause_reason && <div style={{ opacity: 0.85, marginTop: 2, whiteSpace: 'pre-wrap' }}>{task.pause_reason}</div>}

              {/* Lembrete opcional pra não esquecer a tarefa pausada —
                  task_pause_reminder_watchdog.py dispara um aviso na
                  timeline quando vencer. Editável/cancelável enquanto
                  pausada, só por quem criou/é responsável. */}
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {editingReminder ? (
                  <>
                    <input
                      type="datetime-local" value={reminderInput} autoFocus
                      onChange={(e) => setReminderInput(e.target.value)}
                      style={{ fontSize: 12.5 }}
                    />
                    <button
                      className="es-link-btn"
                      onClick={() => {
                        if (!reminderInput) return;
                        onUpdate({ pauseReminderAt: new Date(reminderInput).toISOString() });
                        setEditingReminder(false);
                      }}
                    >
                      Salvar
                    </button>
                    <button className="es-link-btn" onClick={() => setEditingReminder(false)}>Cancelar</button>
                  </>
                ) : task.pause_reminder_at ? (
                  <>
                    <span>⏰ Lembrete em {moment(task.pause_reminder_at).format('DD/MM HH:mm')}</span>
                    {canPauseOrResume && (
                      <>
                        <button
                          className="es-link-btn"
                          onClick={() => { setReminderInput(moment(task.pause_reminder_at).format('YYYY-MM-DDTHH:mm')); setEditingReminder(true); }}
                        >
                          Editar
                        </button>
                        <button className="es-link-btn" onClick={() => onUpdate({ clearPauseReminderAt: true })}>Cancelar lembrete</button>
                      </>
                    )}
                  </>
                ) : canPauseOrResume ? (
                  <button className="es-link-btn" onClick={() => { setReminderInput(''); setEditingReminder(true); }}>
                    ⏰ Definir lembrete
                  </button>
                ) : null}
              </div>
            </div>
          )}
          {isCancelled && (
            <div style={{
              fontSize: 12.5, marginTop: -8, marginLeft: 28, padding: '8px 10px', borderRadius: 8,
              background: 'var(--bg-secondary, #f9f9f9)', borderLeft: '3px solid #e53e3e',
            }}>
              <div style={{ fontWeight: 600 }}>
                🚫 Cancelada por {task.cancelled_by?.full_name || 'alguém'} {task.cancelled_at && `em ${moment(task.cancelled_at).format('DD/MM/YYYY HH:mm')}`}
              </div>
              {task.cancel_reason && <div style={{ opacity: 0.85, marginTop: 2, whiteSpace: 'pre-wrap' }}>{task.cancel_reason}</div>}
            </div>
          )}
          {(canPauseOrResume || canCancel || canUncancel) && (
            <div style={{ marginTop: -8, marginLeft: 28, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {isPaused ? (
                <button
                  onClick={() => onResume?.(task.id)}
                  disabled={resuming}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', fontSize: 13, borderRadius: 6,
                    border: '1px solid var(--brand-orange, var(--whatsapp-green))', background: 'none',
                    color: 'var(--brand-orange, var(--whatsapp-green))', fontWeight: 600,
                    opacity: resuming ? 0.6 : 1, cursor: resuming ? 'wait' : 'pointer',
                  }}
                >
                  <BsPlayFill size={14} /> {resuming ? 'Retomando…' : 'Retomar'}
                </button>
              ) : canPauseOrResume ? (
                <button
                  onClick={() => onPause?.(task.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', fontSize: 13, borderRadius: 6,
                    border: '1px solid var(--border-color)', background: 'none', color: 'var(--text-secondary)', fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <BsPauseFill size={14} /> Pausar
                </button>
              ) : null}
              {canUncancel ? (
                <button
                  onClick={() => onUncancel?.(task.id)}
                  disabled={uncancelling}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', fontSize: 13, borderRadius: 6,
                    border: '1px solid #e53e3e', background: 'none', color: '#e53e3e', fontWeight: 600,
                    opacity: uncancelling ? 0.6 : 1, cursor: uncancelling ? 'wait' : 'pointer',
                  }}
                >
                  <BsArrowCounterclockwise size={14} /> {uncancelling ? 'Reativando…' : 'Reativar tarefa'}
                </button>
              ) : canCancel ? (
                <button
                  onClick={() => onCancel?.(task.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', fontSize: 13, borderRadius: 6,
                    border: '1px solid var(--border-color)', background: 'none', color: 'var(--text-secondary)', fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <BsXCircle size={14} /> Cancelar tarefa
                </button>
              ) : null}
            </div>
          )}
          {canApprove && (
            <div style={{ display: 'flex', gap: 8, marginTop: -12, marginLeft: 28 }}>
              <button
                className="btn-primary" onClick={() => onApprove?.(task.id)}
                disabled={approving || rejecting}
                style={{
                  padding: '6px 14px', fontSize: 13,
                  opacity: approving ? 0.6 : 1, cursor: approving ? 'wait' : 'pointer',
                }}
              >
                {approving ? 'Aprovando…' : 'Aprovar'}
              </button>
              <button
                onClick={() => onReject?.(task.id)}
                disabled={approving || rejecting}
                style={{
                  padding: '6px 14px', fontSize: 13, borderRadius: 6, border: '1px solid #e53e3e',
                  background: 'none', color: '#e53e3e', fontWeight: 600,
                  opacity: rejecting ? 0.6 : 1, cursor: rejecting ? 'wait' : 'pointer',
                }}
              >
                {rejecting ? 'Reprovando…' : 'Reprovar'}
              </button>
            </div>
          )}

          {task.recurrence_interval && (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: -12, marginLeft: 28 }}>
              🔁 {task.recurrence_interval === 'weekly' && task.recurrence_days_of_week?.length > 0
                ? `Toda ${task.recurrence_days_of_week.map(d => WEEKDAY_LABELS[d]).join(', ')}`
                : `Repete a cada ${task.recurrence_every || 1} ${RECURRENCE_LABELS[task.recurrence_interval]}`}
              {task.recurrence_parent_id && ' (gerada automaticamente)'}
            </div>
          )}

          {/* Descrição — só quem criou a tarefa pode editar */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', marginBottom: 4 }}>
              Descrição {task.description_edited && <span style={{ fontWeight: 400, fontStyle: 'italic', opacity: 0.7 }}>(editado)</span>}
            </label>
            {editingDescription ? (
              <textarea
                value={descriptionInput} onChange={(e) => setDescriptionInput(e.target.value)}
                onBlur={saveDescription} autoFocus rows={3} style={{ width: '100%', resize: 'vertical' }}
              />
            ) : (
              <div
                onClick={() => isCreator && setEditingDescription(true)}
                title={isCreator ? undefined : 'Só quem criou a tarefa pode editar a descrição'}
                style={{
                  fontSize: 13.5, cursor: isCreator ? 'pointer' : 'default',
                  opacity: task.description ? 1 : 0.5, whiteSpace: 'pre-wrap',
                }}
              >
                {task.description || (isCreator ? 'Adicionar descrição...' : 'Sem descrição.')}
              </div>
            )}
          </div>

          {/* Responsável + prazo + urgência */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', marginBottom: 4 }}>Responsável</label>
              <select value={task.assigned_to?.id || ''} onChange={handleAssigneeChange} style={{ width: '100%' }}>
                <option value="">Ninguém em especial</option>
                {participants.map(p => (
                  <option key={p.id} value={p.id}>{p.full_name}{p.id === currentUserId ? ' (você)' : ''}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', marginBottom: 4 }}>Prazo</label>
              <input
                type="datetime-local"
                value={task.due_at ? moment(task.due_at).format('YYYY-MM-DDTHH:mm') : ''}
                onChange={handleDueChange} style={{ width: '100%' }}
              />
            </div>
            <div style={{ flex: 1, minWidth: 120 }}>
              <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', marginBottom: 4 }}>Urgência</label>
              <select value={task.priority || 'medium'} onChange={(e) => onUpdate({ priority: e.target.value })} style={{ width: '100%' }}>
                {Object.entries(PRIORITY_META).map(([value, meta]) => (
                  <option key={value} value={value}>{meta.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Subtasks */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', marginBottom: 6 }}>
              Subtarefas {totalSubtasks > 0 && `(${doneSubtasks}/${totalSubtasks})`}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {(task.subtasks || []).map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox" checked={s.is_done}
                    disabled={!canComplete}
                    title={canComplete ? undefined : 'Só quem criou ou é responsável pela tarefa pode concluir'}
                    onChange={() => onToggleSubtask(s.id, !s.is_done)}
                    style={{ cursor: canComplete ? 'pointer' : 'default', flexShrink: 0 }}
                  />
                  <span style={{ flex: 1, fontSize: 13.5, textDecoration: s.is_done ? 'line-through' : 'none', opacity: s.is_done ? 0.6 : 1 }}>
                    {s.title}
                  </span>
                  <button
                    onClick={() => onDeleteSubtask(s.id)} title="Remover"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5, padding: 2, display: 'flex' }}
                  >
                    <BsTrash size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text" value={newSubtask} onChange={(e) => setNewSubtask(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddSubtask()}
                placeholder="Novo item" style={{ flex: 1, fontSize: 13 }}
              />
              <button className="es-link-btn" onClick={handleAddSubtask} disabled={!newSubtask.trim()} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <BsPlus size={16} /> Adicionar
              </button>
            </div>
          </div>

          {/* Anexos */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', marginBottom: 6 }}>
              Anexos {(task.attachments || []).length > 0 && `(${task.attachments.length})`}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {(task.attachments || []).map(a => (
                <div key={a.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8,
                  background: 'var(--bg-secondary, #f9f9f9)',
                }}>
                  {a.mime_type?.startsWith('image/')
                    ? <img src={a.file_url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                    : <BsFileEarmark size={18} style={{ flexShrink: 0, opacity: 0.7 }} />}
                  <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.filename || 'Arquivo'}
                  </div>
                  <a href={a.file_url} target="_blank" rel="noreferrer" title="Baixar" style={{ display: 'flex', color: 'inherit', opacity: 0.6 }}>
                    <BsDownload size={14} />
                  </a>
                  <button
                    onClick={() => onDeleteAttachment(a.id)} title="Remover"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5, padding: 2, display: 'flex' }}
                  >
                    <BsTrash size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button
              className="es-link-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <BsPaperclip size={14} /> {uploading ? 'Enviando...' : 'Anexar arquivo'}
            </button>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileChange} />
          </div>

          {/* Histórico completo — sempre grava todo evento real, mesmo quando
              o aviso correspondente no chat é suprimido por repetição rápida
              (ver TASK_NOTICE_COOLDOWN no backend). */}
          <div>
            <button
              onClick={() => setShowHistory(v => !v)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              Histórico {(task.history || []).length > 0 && `(${task.history.length})`} {showHistory ? '▲' : '▼'}
            </button>
            {showHistory && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {(task.history || []).length === 0 && (
                  <div style={{ fontSize: 12.5, opacity: 0.5 }}>Sem eventos registrados.</div>
                )}
                {(task.history || []).map(h => (
                  <div key={h.id} style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>{TASK_HISTORY_LABELS[h.event] || h.event} {h.user ? `— ${h.user.full_name}` : ''}</span>
                      <span style={{ opacity: 0.5, flexShrink: 0 }}>{moment(h.created_at).format('DD/MM HH:mm')}</span>
                    </div>
                    {h.reason && <div style={{ opacity: 0.7, fontStyle: 'italic' }}>"{h.reason}"</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskDetailModal;
