/**
 * InternalGroupManager — administração de grupo do chat interno (mirror de
 * GroupManager.js, mas pros grupos internos entre usuários da equipe):
 * renomear, trocar foto, adicionar/remover participante, promover/rebaixar
 * admin, sair do grupo. Painel lateral (mesmo CSS de ContactInfoPanel.css),
 * renderizado como irmão do InternalChatArea, não como modal — igual ao
 * WhatsApp Web.
 */
import React, { useState } from 'react';
import { BsPersonAdd, BsPeopleFill, BsListCheck, BsPinFill } from 'react-icons/bs';
import { MdArrowBack, MdEdit, MdCameraAlt, MdPersonRemove, MdAdminPanelSettings, MdExitToApp } from 'react-icons/md';
import moment from 'moment';
import apiService from '../services/api';
import '../styles/ContactInfoPanel.css';

const getInitials = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const InternalGroupManager = ({ conversation, currentUserId, agents, tasks = [], onToggleTask, onOpenTask, onClose, onGroupUpdated, onLeftGroup, messages = [], onPinMessage, onOpenDirectChat }) => {
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(conversation.name);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [selectedNewIds, setSelectedNewIds] = useState([]);

  const myRow = (conversation.participants || []).find(p => p.id === currentUserId);
  const isAdmin = !!myRow?.is_admin;

  const doAction = async (fn, successMsg) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res?.data && onGroupUpdated) onGroupUpdated(res.data);
      if (successMsg) console.log(successMsg);
    } catch (err) {
      alert(err.response?.data?.detail || 'Erro ao executar a ação.');
    } finally {
      setBusy(false);
    }
  };

  const handleRename = () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === conversation.name) { setEditingName(false); return; }
    doAction(() => apiService.renameInternalGroup(conversation.id, trimmed)).then(() => setEditingName(false));
  };

  const handlePhotoChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    doAction(() => apiService.updateInternalGroupPhoto(conversation.id, file));
  };

  const handlePromote = (userId) => doAction(() => apiService.setInternalGroupAdmin(conversation.id, userId, true));
  const handleDemote = (userId) => doAction(() => apiService.setInternalGroupAdmin(conversation.id, userId, false));

  const handleRemove = (userId) => {
    if (!window.confirm('Remover esta pessoa do grupo?')) return;
    doAction(() => apiService.removeInternalGroupParticipant(conversation.id, userId));
  };

  const handleLeave = () => {
    if (!window.confirm('Sair deste grupo?')) return;
    setBusy(true);
    apiService.removeInternalGroupParticipant(conversation.id, currentUserId)
      .then(() => { onLeftGroup?.(conversation.id); onClose(); })
      .catch(err => alert(err.response?.data?.detail || 'Não foi possível sair do grupo.'))
      .finally(() => setBusy(false));
  };

  const handleAddSelected = () => {
    if (selectedNewIds.length === 0) return;
    doAction(() => apiService.addInternalGroupParticipants(conversation.id, selectedNewIds))
      .then(() => { setShowAddPicker(false); setSelectedNewIds([]); });
  };

  const participantIds = new Set((conversation.participants || []).map(p => p.id));
  const candidates = (agents || []).filter(a => !participantIds.has(a.id));
  // BUG (grupos não tinham essa opção): esse painel substitui o
  // InternalContactInfoPanel pro chat interno em grupo, mas nunca herdou a
  // seção "Mensagens fixadas" que ele tem.
  const pinnedMessages = messages.filter(m => m.is_pinned && !m.is_deleted);

  return (
    <div className="contact-info-panel">
      <div className="cip-header">
        <button className="cip-icon-btn" onClick={onClose} title="Voltar">
          <MdArrowBack size={22} />
        </button>
        <span><BsPeopleFill style={{ verticalAlign: -2 }} /> Dados do grupo</span>
      </div>

      <div className="cip-body" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <label style={{ position: 'relative', cursor: isAdmin ? 'pointer' : 'default' }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%', overflow: 'hidden', background: 'var(--bg-secondary, #eee)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 600,
            }}>
              {conversation.photo_url
                ? <img src={conversation.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : getInitials(conversation.name)}
            </div>
            {isAdmin && (
              <>
                <div style={{
                  position: 'absolute', bottom: 0, right: 0, width: 22, height: 22, borderRadius: '50%',
                  background: 'var(--whatsapp-green, #25D366)', color: '#fff', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <MdCameraAlt size={13} />
                </div>
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} disabled={busy} />
              </>
            )}
          </label>

          <div style={{ flex: 1, minWidth: 0 }}>
            {editingName ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleRename()}
                  autoFocus style={{ flex: 1 }}
                />
                <button className="btn-primary" onClick={handleRename} disabled={busy}>OK</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversation.name}</strong>
                {isAdmin && (
                  <MdEdit size={16} style={{ cursor: 'pointer', opacity: 0.6, flexShrink: 0 }} onClick={() => setEditingName(true)} />
                )}
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>
              {(conversation.participants || []).length} participantes
            </div>
          </div>
        </div>

        <div className="cip-section">
          <div className="cip-section-title">
            <BsPinFill size={14} /> Mensagens fixadas ({pinnedMessages.length})
          </div>
          {pinnedMessages.length === 0 ? (
            <div className="cip-empty">Nenhuma mensagem fixada.</div>
          ) : (
            <div className="cip-starred-list">
              {pinnedMessages.map((m, i) => (
                <div key={m.id || i} className="cip-starred-item">
                  <div className="cip-starred-text">{m.text || (m.message_type !== 'text' ? `[${m.message_type}]` : '')}</div>
                  <div className="cip-starred-footer">
                    <span>{moment(m.created_at).format('DD/MM/YYYY HH:mm')}</span>
                    <button className="cip-unstar-btn" title="Desafixar" onClick={() => onPinMessage?.(m.id, false)}>
                      <BsPinFill size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <BsListCheck size={15} /> Tarefas ({tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length} pendentes)
          </div>
          {tasks.length === 0 ? (
            <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhuma tarefa criada neste grupo.</small>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tasks.map(t => {
                const doneSubtasks = (t.subtasks || []).filter(s => s.is_done).length;
                const totalSubtasks = (t.subtasks || []).length;
                const attachmentCount = (t.attachments || []).length;
                return (
                  <div
                    key={t.id}
                    onClick={() => onOpenTask?.(t.id)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 8,
                      background: 'var(--bg-secondary, #f9f9f9)', cursor: onOpenTask ? 'pointer' : 'default',
                    }}
                  >
                    <input
                      type="checkbox" checked={t.status === 'done'}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleTask?.(t.id, t.status === 'done' ? 'pending' : 'done')}
                      style={{ marginTop: 2, cursor: (onToggleTask && (currentUserId === t.created_by?.id || currentUserId === t.assigned_to?.id) && t.status !== 'paused' && t.status !== 'cancelled') ? 'pointer' : 'default', flexShrink: 0 }}
                      disabled={!onToggleTask || (currentUserId !== t.created_by?.id && currentUserId !== t.assigned_to?.id) || t.status === 'paused' || t.status === 'cancelled'}
                      title={t.status === 'paused' ? 'Tarefa pausada — retome antes de concluir' : t.status === 'cancelled' ? 'Tarefa cancelada — reative antes de concluir' : ((currentUserId === t.created_by?.id || currentUserId === t.assigned_to?.id) ? undefined : 'Só quem criou ou é responsável pode concluir')}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, textDecoration: (t.status === 'done' || t.status === 'cancelled') ? 'line-through' : 'none', opacity: (t.status === 'done' || t.status === 'cancelled') ? 0.6 : 1 }}>
                        {t.title} {t.status === 'paused' && <span style={{ fontSize: 11, opacity: 0.7 }}>⏸️ pausada</span>} {t.status === 'cancelled' && <span style={{ fontSize: 11, opacity: 0.7, color: '#e53e3e' }}>🚫 cancelada</span>}
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.7 }}>
                        {t.assigned_to ? `👤 ${t.assigned_to.full_name}` : ''}
                        {t.due_at ? `${t.assigned_to ? ' · ' : ''}⏰ ${moment(t.due_at).format('DD/MM HH:mm')}` : ''}
                        {totalSubtasks > 0 ? ` ${(t.assigned_to || t.due_at) ? '· ' : ''}☑️ ${doneSubtasks}/${totalSubtasks}` : ''}
                        {attachmentCount > 0 ? ` · 📎 ${attachmentCount}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Participantes</div>
          <button className="es-link-btn" onClick={() => setShowAddPicker(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <BsPersonAdd size={14} /> Adicionar
          </button>
        </div>

        {showAddPicker && (
          <div style={{ marginBottom: 12, border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: 8 }}>
            {candidates.length === 0 ? (
              <small style={{ color: 'var(--text-secondary, #888)' }}>Todo mundo já está no grupo.</small>
            ) : (
              <>
                <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                  {candidates.map(a => (
                    <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox" checked={selectedNewIds.includes(a.id)}
                        onChange={() => setSelectedNewIds(prev => prev.includes(a.id) ? prev.filter(id => id !== a.id) : [...prev, a.id])}
                      />
                      {a.full_name}
                    </label>
                  ))}
                </div>
                <button className="btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={handleAddSelected} disabled={busy || selectedNewIds.length === 0}>
                  Adicionar selecionados
                </button>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(conversation.participants || []).map(p => (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 8,
              background: 'var(--bg-secondary, #f9f9f9)',
            }}>
              <div
                onClick={() => p.id !== currentUserId && onOpenDirectChat?.(p)}
                title={p.id !== currentUserId && onOpenDirectChat ? 'Clique para ver o contato' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0,
                  cursor: p.id !== currentUserId && onOpenDirectChat ? 'pointer' : 'default',
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', background: 'var(--avatar-bg)',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0,
                }}>
                  {getInitials(p.full_name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.full_name} {p.id === currentUserId && '(você)'}</div>
                  {p.is_admin && <div style={{ fontSize: 10, background: '#f39c12', color: '#fff', borderRadius: 4, padding: '1px 5px', display: 'inline-block', marginTop: 2 }}>Admin</div>}
                </div>
              </div>
              {isAdmin && p.id !== currentUserId && (
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {p.is_admin ? (
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex', alignItems: 'center' }} onClick={() => handleDemote(p.id)} disabled={busy} title="Remover admin">
                      <MdAdminPanelSettings size={16} color="#e67e22" />
                    </button>
                  ) : (
                    <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex', alignItems: 'center' }} onClick={() => handlePromote(p.id)} disabled={busy} title="Tornar admin">
                      <MdAdminPanelSettings size={16} color="#27ae60" />
                    </button>
                  )}
                  <button style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex', alignItems: 'center' }} onClick={() => handleRemove(p.id)} disabled={busy} title="Remover do grupo">
                    <MdPersonRemove size={16} color="#e74c3c" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color, #eee)', display: 'flex', justifyContent: 'flex-end' }}>
        <button
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1px solid #e74c3c', color: '#e74c3c', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600 }}
          onClick={handleLeave} disabled={busy}
        >
          <MdExitToApp size={16} /> Sair do Grupo
        </button>
      </div>
    </div>
  );
};

export default InternalGroupManager;
