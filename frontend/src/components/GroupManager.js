/**
 * GroupManager.js — Painel de gerenciamento de grupo (Baileys)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { MdArrowBack, MdPersonAdd, MdPersonRemove, MdAdminPanelSettings, MdExitToApp, MdRefresh, MdEdit, MdWorkOutline } from 'react-icons/md';
import { BsPinFill, BsListCheck } from 'react-icons/bs';
import moment from 'moment';
import { baileysApi } from '../services/api';
import avatarCache from '../utils/avatarCache';
import { limitAvatarFetch } from '../utils/avatarFetchLimiter';
import '../styles/ContactInfoPanel.css';

const formatPhoneDisplay = (phone) => {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55'))
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55'))
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length >= 8) return `+${d}`;
  return phone;
};

// Foto de perfil com o mesmo cache compartilhado usado em Sidebar.js/ChatArea.js
// (evita rebuscar a mesma foto quando o participante já apareceu em outro lugar).
const AvatarThumb = ({ jid, accountId, fallbackLabel }) => {
  const [avatarUrl, setAvatarUrl] = useState(avatarCache.get(jid) || null);

  useEffect(() => {
    if (avatarUrl || !jid) return;
    if (avatarCache.has(jid)) { setAvatarUrl(avatarCache.get(jid)); return; }
    let cancelled = false;
    // Incidente 2026-09-11: essa busca não passava pelo limitAvatarFetch —
    // um grupo grande renderiza um AvatarThumb POR PARTICIPANTE, cada um
    // disparando sua própria request sem limite nenhum. Confirmado ao vivo:
    // rajada de dezenas de 500 em /profile/picture derrubou a autenticação
    // de 3 sessões WPPConnect (SAC-01/POS-01/ti01 precisaram de QR novo).
    limitAvatarFetch(() => baileysApi.getProfilePicture(jid, false, accountId))
      .then(res => {
        // res?.success === false = falha do bridge (timeout, sessão caída,
        // rajada de 500 como no incidente 2026-09-11), não "contato sem
        // foto" — não pode gravar null no cache, senão a foto fica marcada
        // como inexistente pro resto da sessão do navegador mesmo existindo.
        if (res?.success === false) return;
        const url = res?.url || null;
        avatarCache.set(jid, url);
        if (!cancelled) setAvatarUrl(url);
      })
      .catch(() => {}); // erro de rede — mesmo motivo, não grava no cache
    return () => { cancelled = true; };
  }, [jid, accountId, avatarUrl]);

  return avatarUrl
    ? <img src={avatarUrl} alt="" style={styles.avatarImg} />
    : <span>{(fallbackLabel || '?').charAt(0).toUpperCase()}</span>;
};

const GroupManager = ({
  conversation, accountId, onClose, onRefresh, onOpenParticipantInfo, onUpdateContactInternal, messages = [], onPinMessage,
  tasks = [], currentUserId, onToggleTask, onOpenTask,
}) => {
  const [metadata, setMetadata] = useState(null);
  const [savingInternal, setSavingInternal] = useState(false);
  const [joinRequests, setJoinRequests] = useState([]);
  const [inviteCode, setInviteCode]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [action, setAction]     = useState(null); // { type, jid }
  const [addInput, setAddInput] = useState('');
  const [busy, setBusy]         = useState(false);
  const [isAdmin, setIsAdmin]   = useState(false);
  const [msg, setMsg]           = useState('');
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectInput, setSubjectInput]     = useState('');
  const [editingDesc, setEditingDesc]       = useState(false);
  const [descInput, setDescInput]           = useState('');

  const groupJid = conversation?.contact?.wa_id;

  const loadMetadata = useCallback(async () => {
    if (!groupJid) return;
    setLoading(true);
    setError('');
    try {
      const res = await baileysApi.groupGetMetadata(groupJid, accountId);
      console.log('[GroupManager] metadata response:', JSON.stringify(res));
      const meta = res?.metadata ?? res;
      setMetadata(meta);

      let isAd = false;
      if (meta?.participants) {
        const myP = meta.participants.find(p => p.isMe);
        isAd = myP?.admin === 'admin' || myP?.admin === 'superadmin';
        setIsAdmin(isAd);
      }
      
      try {
        const reqRes = await baileysApi.groupGetJoinRequests(groupJid, accountId);
        if (reqRes?.requests) {
          setJoinRequests(reqRes.requests);
        }
      } catch (err) {
        console.warn('Could not fetch join requests', err);
      }
      
      try {
        const ic = await baileysApi.groupGetInviteCode(groupJid, accountId);
        setInviteCode(ic?.code || ic?.invite_code || '');
      } catch (e) {
        console.error('Failed to get invite code:', e);
      }
    } catch (e) {
      setError('Erro ao carregar info do grupo.');
    } finally {
      setLoading(false);
    }
  }, [groupJid, accountId]);

  useEffect(() => { loadMetadata(); }, [loadMetadata]);

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 3000); };

  const doAction = async (fn, successMsg) => {
    setBusy(true);
    try {
      await fn();
      flash(successMsg);
      await loadMetadata();
    } catch (e) {
      flash('Erro: ' + (e?.response?.data?.detail || e.message || 'tente novamente'));
    } finally {
      setBusy(false);
      setAction(null);
    }
  };

  const handleRemove = (jid) =>
    doAction(() => baileysApi.groupRemoveParticipants(groupJid, [jid.split('@')[0]], accountId), 'Participante removido.');

  const handlePromote = (jid) =>
    doAction(() => baileysApi.groupPromoteAdmins(groupJid, [jid.split('@')[0]], accountId), 'Promovido a admin.');

  const handleDemote = (jid) =>
    doAction(() => baileysApi.groupDemoteAdmins(groupJid, [jid.split('@')[0]], accountId), 'Removido de admin.');

  const handleJoinRequest = (jid, action) =>
    doAction(() => baileysApi.groupUpdateJoinRequest(groupJid, [jid.split('@')[0]], action, accountId), `Pedido ${action === 'approve' ? 'aprovado' : 'rejeitado'}.`);

  const handleAdd = () => {
    const phones = addInput.split(/[\n,;]+/).map(p => p.trim().replace(/\D/g, '')).filter(p => p.length >= 8);
    if (!phones.length) { flash('Informe ao menos um número.'); return; }
    doAction(() => baileysApi.groupAddParticipants(groupJid, phones, accountId), `${phones.length} participante(s) adicionado(s).`);
    setAddInput('');
  };

  const handleUpdateSubject = () => {
    if (!subjectInput.trim() || subjectInput.trim() === metadata?.subject) { setEditingSubject(false); return; }
    doAction(() => baileysApi.groupUpdateSubject(groupJid, subjectInput.trim(), accountId), 'Nome do grupo atualizado.');
    setEditingSubject(false);
  };

  const handleUpdateDescription = () => {
    doAction(() => baileysApi.groupUpdateDescription(groupJid, descInput.trim(), accountId), 'Descrição atualizada.');
    setEditingDesc(false);
  };

  const handleToggleAnnounce = (announce) =>
    doAction(() => baileysApi.groupSetAnnounce(groupJid, announce, accountId), announce ? 'Modo somente-admin ativado.' : 'Modo somente-admin desativado.');

  const handleToggleDisappearing = (enabled) =>
    doAction(() => baileysApi.groupSetDisappearing(groupJid, enabled ? 604800 : 0, accountId), enabled ? 'Mensagens temporárias ativadas (7 dias).' : 'Mensagens temporárias desativadas.');

  const handleToggleInternal = async () => {
    const contactId = conversation?.contact?.id;
    if (!contactId || savingInternal) return;
    setSavingInternal(true);
    try {
      await onUpdateContactInternal?.(contactId, !conversation?.contact?.is_internal);
    } catch (e) {
      console.error('Erro ao marcar grupo como interno:', e);
      alert('Não foi possível atualizar essa configuração.');
    } finally {
      setSavingInternal(false);
    }
  };

  const handleLeave = () => {
    if (!window.confirm('Sair do grupo?')) return;
    doAction(() => baileysApi.groupLeave(groupJid, accountId), 'Você saiu do grupo.');
    onRefresh?.();
    onClose();
  };

  const participants = metadata?.participants || [];
  const myJid = null; // sem acesso ao JID próprio aqui, omitimos o botão de sair em favor do leave geral
  // BUG (grupos não tinham essa opção): esse painel substitui o ContactInfoPanel
  // pra conversa de grupo, mas nunca herdou a seção "Mensagens fixadas" que
  // ele tem — só o menu de 3 pontos do ChatArea (fora daqui) deixava fixar
  // mensagem em grupo, sem nenhum jeito de ver/desfixar depois.
  const pinnedMessages = messages.filter(m => m.is_pinned);

  return (
    <div className="contact-info-panel">
      <div className="cip-header">
        <button className="cip-icon-btn" onClick={onClose} title="Voltar">
          <MdArrowBack size={22} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingSubject ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{ ...styles.input, flex: 1, margin: 0 }}
                value={subjectInput}
                onChange={e => setSubjectInput(e.target.value)}
                autoFocus
                maxLength={100}
              />
              <button style={styles.addBtn} onClick={handleUpdateSubject} disabled={busy}>Salvar</button>
            </div>
          ) : (
            <div
              style={{ fontWeight: 700, fontSize: 16, cursor: isAdmin ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              onClick={() => { if (!isAdmin) return; setSubjectInput(metadata?.subject || ''); setEditingSubject(true); }}
              title={isAdmin ? 'Clique para renomear' : ''}
            >
              {metadata?.subject || conversation?.name || 'Grupo'}
              {isAdmin && <MdEdit size={14} color="var(--text-secondary, #888)" />}
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', fontWeight: 400 }}>{participants.length} participantes</div>
        </div>
        <button className="cip-icon-btn" onClick={loadMetadata} title="Atualizar"><MdRefresh size={20} /></button>
      </div>

      {msg && <div style={styles.flashMsg}>{msg}</div>}

      <div className="cip-body" style={styles.body}>
          {loading ? (
            <div style={styles.centered}>Carregando...</div>
          ) : error ? (
            <div style={{ color: '#e74c3c', padding: 12 }}>{error}</div>
          ) : (
            <>
              {/* Descrição */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Descrição</div>
                {editingDesc ? (
                  <div>
                    <textarea
                      style={{ ...styles.input, width: '100%', minHeight: 60, boxSizing: 'border-box' }}
                      value={descInput}
                      onChange={e => setDescInput(e.target.value)}
                      autoFocus
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button style={styles.addBtn} onClick={handleUpdateDescription} disabled={busy}>Salvar</button>
                      <button style={styles.actionBtn} onClick={() => setEditingDesc(false)}>Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{ ...styles.descBox, cursor: isAdmin ? 'pointer' : 'default' }}
                    onClick={() => { if (!isAdmin) return; setDescInput(metadata?.desc || ''); setEditingDesc(true); }}
                    title={isAdmin ? 'Clique para editar' : ''}
                  >
                    {metadata?.desc || (isAdmin ? 'Sem descrição — clique para adicionar.' : 'Sem descrição.')}
                  </div>
                )}
              </div>

              {/* Tarefas — todas, inclusive concluída/cancelada (a faixa do
                  ChatArea só mostra as abertas), mesma seção de ContactInfoPanel.js
                  (conversa individual), agora também em grupo. */}
              <div className="cip-section">
                <div className="cip-section-title">
                  <BsListCheck size={14} /> Tarefas ({tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').length} pendentes)
                </div>
                {tasks.length === 0 ? (
                  <div className="cip-empty">Nenhuma tarefa criada nesta conversa.</div>
                ) : (
                  <div className="cip-starred-list">
                    {tasks.map(t => {
                      const doneSubtasks = (t.subtasks || []).filter(s => s.is_done).length;
                      const totalSubtasks = (t.subtasks || []).length;
                      const attachmentCount = (t.attachments || []).length;
                      const isTerminal = t.status === 'done' || t.status === 'cancelled';
                      return (
                        <div
                          key={t.id} className="cip-starred-item"
                          onClick={() => onOpenTask?.(t.id)}
                          style={{ cursor: onOpenTask ? 'pointer' : 'default' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <input
                              type="checkbox" checked={t.status === 'done'}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => onToggleTask?.(t.id, t.status === 'done' ? 'pending' : 'done')}
                              style={{ marginTop: 2, cursor: (onToggleTask && (currentUserId === t.created_by?.id || currentUserId === t.assigned_to?.id) && t.status !== 'paused' && t.status !== 'cancelled') ? 'pointer' : 'default', flexShrink: 0 }}
                              disabled={!onToggleTask || (currentUserId !== t.created_by?.id && currentUserId !== t.assigned_to?.id) || t.status === 'paused' || t.status === 'cancelled'}
                              title={t.status === 'paused' ? 'Tarefa pausada — retome antes de concluir' : t.status === 'cancelled' ? 'Tarefa cancelada — reative antes de concluir' : ((currentUserId === t.created_by?.id || currentUserId === t.assigned_to?.id) ? undefined : 'Só quem criou ou é responsável pode concluir')}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="cip-starred-text" style={{ textDecoration: isTerminal ? 'line-through' : 'none', opacity: isTerminal ? 0.6 : 1 }}>
                                {t.title} {t.status === 'paused' && <span style={{ fontSize: 11, opacity: 0.7 }}>⏸️ pausada</span>} {t.status === 'cancelled' && <span style={{ fontSize: 11, opacity: 0.7, color: '#e53e3e' }}>🚫 cancelada</span>}
                              </div>
                              <div className="cip-starred-footer">
                                <span>
                                  {t.due_at ? `⏰ ${moment(t.due_at).format('DD/MM HH:mm')}` : ''}
                                  {totalSubtasks > 0 ? ` ${t.due_at ? '· ' : ''}☑️ ${doneSubtasks}/${totalSubtasks}` : ''}
                                  {attachmentCount > 0 ? ` · 📎 ${attachmentCount}` : ''}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Mensagens fixadas — mesma seção de ContactInfoPanel.js (conversa
                  individual), agora também em grupo. */}
              <div className="cip-section">
                <div className="cip-section-title">
                  <BsPinFill size={14} /> Mensagens fixadas ({pinnedMessages.length})
                </div>
                {pinnedMessages.length === 0 ? (
                  <div className="cip-empty">Nenhuma mensagem fixada.</div>
                ) : (
                  <div className="cip-starred-list">
                    {pinnedMessages.map((m, i) => (
                      <div key={m.wamid || i} className="cip-starred-item">
                        <div className="cip-starred-text">{m.message || m.caption || '[Mídia]'}</div>
                        <div className="cip-starred-footer">
                          <span>{moment(m.timestamp).format('DD/MM/YYYY HH:mm')}</span>
                          <button className="cip-unstar-btn" title="Desafixar" onClick={() => onPinMessage?.(m, false)}>
                            <BsPinFill size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Grupo interno — sem bot/IA nem SLA/CSAT (mesmo mecanismo de
                  Contact.is_internal usado em ContactInfoPanel.js pra conversas
                  1:1; disponível pra qualquer usuário, não só admin do grupo). */}
              <div style={styles.section}>
                <div style={styles.toggleRow}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <MdWorkOutline size={15} /> Grupo interno
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>Sem bot/IA, sem SLA/CSAT — uso entre equipe/fornecedores</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={!!conversation?.contact?.is_internal}
                    onChange={handleToggleInternal}
                    disabled={savingInternal}
                  />
                </div>
              </div>

              {/* Configurações do grupo */}
              {isAdmin && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Configurações</div>
                  <div style={styles.toggleRow}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>Somente administradores enviam mensagens</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>Modo anúncio</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={!!metadata?.announce}
                      onChange={e => handleToggleAnnounce(e.target.checked)}
                      disabled={busy}
                    />
                  </div>
                  <div style={styles.toggleRow}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>Mensagens temporárias</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary, #888)' }}>Somem após 7 dias</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={!!metadata?.ephemeralDuration}
                      onChange={e => handleToggleDisappearing(e.target.checked)}
                      disabled={busy}
                    />
                  </div>
                </div>
              )}

              {/* Adicionar participante */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}><MdPersonAdd size={16} /> Adicionar participante</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    style={{ ...styles.input, flex: 1 }}
                    value={addInput}
                    onChange={e => setAddInput(e.target.value)}
                    placeholder="5511999998888, 5521977776666..."
                  />
                  <button style={styles.addBtn} onClick={handleAdd} disabled={busy}>Adicionar</button>
                </div>
              </div>

              {/* Pedidos de entrada pendentes */}
              {joinRequests.length > 0 && (
                <div style={styles.section}>
                  <div style={styles.sectionTitle}>Pedidos de Entrada ({joinRequests.length})</div>
                  <div style={styles.participantList}>
                    {joinRequests.map(req => {
                      const phone = req.jid?.split('@')[0] || req.jid;
                      const displayName = req.name || formatPhoneDisplay(phone);
                      return (
                        <div key={req.jid} style={styles.participantRow}>
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, cursor: onOpenParticipantInfo ? 'pointer' : 'default' }}
                            onClick={() => onOpenParticipantInfo?.({ participant_jid: req.jid, contact_name: req.name || null })}
                          >
                            <div style={styles.avatar}>
                              <AvatarThumb jid={req.jid} accountId={accountId} fallbackLabel={displayName} />
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button style={styles.addBtn} onClick={() => handleJoinRequest(req.jid, 'approve')} disabled={busy}>Aprovar</button>
                            <button style={{ ...styles.addBtn, background: '#e74c3c' }} onClick={() => handleJoinRequest(req.jid, 'reject')} disabled={busy}>Rejeitar</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              
              {/* Link de convite */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Link de Convite</div>
                {inviteCode ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input 
                      style={{ ...styles.input, flex: 1, color: '#2b82c9' }} 
                      value={`https://chat.whatsapp.com/${inviteCode}`} 
                      readOnly 
                    />
                    <button style={styles.addBtn} onClick={() => { navigator.clipboard.writeText(`https://chat.whatsapp.com/${inviteCode}`); flash('Link copiado!'); }}>Copiar</button>
                    <button style={{ ...styles.addBtn, background: '#f39c12' }} onClick={() => doAction(() => baileysApi.groupRevokeInviteCode(groupJid, accountId), 'Link revogado.')} disabled={busy}>Revogar</button>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: '#888' }}>Não foi possível obter o link de convite. (Você precisa ser administrador)</div>
                )}
              </div>

              {/* Lista de participantes */}
              <div style={styles.section}>
                <div style={styles.sectionTitle}>Participantes</div>
                <div style={styles.participantList}>
                  {participants.map(p => {
                    const phone = p.id?.split('@')[0] || p.id;
                    const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
                    const displayName = p.name || formatPhoneDisplay(phone);
                    return (
                      <div key={p.id} style={styles.participantRow}>
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, cursor: (onOpenParticipantInfo && !p.isMe) ? 'pointer' : 'default' }}
                          onClick={() => { if (!p.isMe) onOpenParticipantInfo?.({ participant_jid: p.id, contact_name: p.name || null }); }}
                          title={!p.isMe ? 'Ver contato' : undefined}
                        >
                          <div style={styles.avatar}>
                            <AvatarThumb jid={p.id} accountId={accountId} fallbackLabel={displayName} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {displayName} {p.isMe && <span style={{ color: '#888', fontWeight: 'normal' }}>(Você)</span>}
                            </div>
                            {isAdmin && <div style={styles.adminBadge}>Admin</div>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {isAdmin ? (
                            <button style={styles.actionBtn} onClick={() => handleDemote(p.id)} disabled={busy} title="Remover admin">
                              <MdAdminPanelSettings size={16} color="#e67e22" />
                            </button>
                          ) : (
                            <button style={styles.actionBtn} onClick={() => handlePromote(p.id)} disabled={busy} title="Tornar admin">
                              <MdAdminPanelSettings size={16} color="#27ae60" />
                            </button>
                          )}
                          <button style={styles.actionBtn} onClick={() => handleRemove(p.id)} disabled={busy} title="Remover do grupo">
                            <MdPersonRemove size={16} color="#e74c3c" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

      {/* Footer */}
      <div style={styles.footer}>
        <button style={styles.leaveBtn} onClick={handleLeave} disabled={busy}>
          <MdExitToApp size={16} /> Sair do Grupo
        </button>
      </div>
    </div>
  );
};

const styles = {
  body: { padding: '12px 18px' },
  footer: { padding: '12px 18px', borderTop: '1px solid var(--border-color, #eee)', display: 'flex', justifyContent: 'flex-end' },
  flashMsg: { background: '#0EA5A4', color: '#fff', padding: '8px 18px', fontSize: 13 },
  centered: { textAlign: 'center', padding: 24, color: 'var(--text-secondary, #888)' },
  section: { marginBottom: 16 },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, marginBottom: 8, color: 'var(--text-secondary, #666)' },
  descBox: { background: 'var(--bg-secondary, #f5f5f5)', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 14, color: 'var(--text-secondary, #666)' },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' },
  input: { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-color, #ddd)', background: 'var(--bg-secondary, #f5f5f5)', color: 'inherit', fontSize: 13 },
  addBtn: { background: '#0EA5A4', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  participantList: { display: 'flex', flexDirection: 'column', gap: 4 },
  participantRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 8, background: 'var(--bg-secondary, #f9f9f9)' },
  avatar: { width: 34, height: 34, borderRadius: '50%', background: 'var(--avatar-bg, #1E293B)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, flexShrink: 0, overflow: 'hidden' },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover' },
  adminBadge: { fontSize: 10, background: '#f39c12', color: '#fff', borderRadius: 4, padding: '1px 5px', display: 'inline-block', marginTop: 2 },
  actionBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex', alignItems: 'center' },
  leaveBtn: { display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1px solid #e74c3c', color: '#e74c3c', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600 },
};

export default GroupManager;
