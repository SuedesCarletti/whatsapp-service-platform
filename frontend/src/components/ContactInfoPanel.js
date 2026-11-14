/**
 * ContactInfoPanel.js — Painel lateral "Dados do contato", estilo WhatsApp Web.
 * Renderizado como irmão do ChatArea (não substitui, fica ao lado).
 */
import React, { useState, useEffect } from 'react';
import moment from 'moment';
import {
  MdArrowBack,
  MdNotifications,
  MdNotificationsOff,
  MdStar,
  MdStarBorder,
  MdBlock,
  MdReport,
  MdDeleteOutline,
  MdLock,
  MdVideoLibrary,
  MdTimer,
  MdLabelOutline,
  MdBusiness,
  MdChevronRight,
  MdClose,
  MdDownload,
  MdEdit,
  MdCheck,
  MdWorkOutline,
  MdOutlineStickyNote2,
  MdSearch,
} from 'react-icons/md';
import { BsPinFill, BsPin, BsListCheck } from 'react-icons/bs';
import { baileysApi } from '../services/api';
import { limitAvatarFetch } from '../utils/avatarFetchLimiter';
import { isSiteChatId, isSiteChatContact } from '../utils/siteChat';
import '../styles/ContactInfoPanel.css';

const formatPhoneDisplay = (phone) => {
  if (!phone) return '';
  if (isSiteChatId(String(phone))) return '';
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55'))
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55'))
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length >= 8) return `+${d}`;
  return phone;
};

const DISAPPEARING_OPTIONS = [
  { label: 'Desativado', value: 0 },
  { label: '24 horas', value: 86400 },
  { label: '7 dias', value: 604800 },
  { label: '90 dias', value: 7776000 },
];

const MEDIA_TYPES = ['image', 'video', 'audio', 'document'];

const ContactInfoPanel = ({
  conversation,
  messages = [],
  accountId,
  providerType,
  onClose,
  onPinChat,
  onMuteChat,
  onToggleFavorite,
  onSearchInChat,
  onClearChat,
  onDeleteChat,
  onBlockContact,
  onViewMedia,
  onStarMessage,
  onPinMessage,
  onUpdateContactName,
  onUpdateContactInternal,
  onUpdateContactNotes,
  // Tarefas vinculadas a esta conversa (ver create_standalone_task no
  // backend) — pedido explícito 2026-09-23: a faixa no topo do ChatArea só
  // mostra as ABERTAS (mesmo padrão do chat interno), então concluída sem
  // nenhum lugar pra ver de novo literalmente sumia da interface. Esta
  // seção mostra TODAS (concluída/cancelada inclusive), mesma ideia da
  // seção "Tarefas" do InternalContactInfoPanel.js pro chat interno.
  tasks = [],
  currentUserId,
  onToggleTask,
  onOpenTask,
}) => {
  const [photoUrl, setPhotoUrl] = useState(null);
  const [about, setAbout] = useState(null);
  const [businessProfile, setBusinessProfile] = useState(null);
  const [disappearing, setDisappearing] = useState(0);
  const [showPhotoViewer, setShowPhotoViewer] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesInput, setNotesInput] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  const isBaileys = providerType === 'baileys';
  const jid = conversation?.contact?.wa_id;
  const isSiteChat = isSiteChatContact(conversation?.contact);
  const [visitor, setVisitor] = useState(null);
  // Nome "de verdade" (agenda) só quando o contato está salvo — mesmo critério
  // do Sidebar/ChatArea. O nome autodeclarado no WhatsApp da pessoa (push_name/
  // profile.name) é informativo, não substitui o nome salvo nem o número.
  const savedName = conversation?.contact?.saved_name || null;
  const notes = conversation?.contact?.notes || '';
  const profileName = conversation?.contact?.push_name || conversation?.contact?.name || null;
  const name = savedName || profileName; // usado nos textos de ação (bloquear/denunciar etc.)
  const phoneNumber = conversation?.contact?.phone_number || (jid || '').split('@')[0];
  const isMuted = conversation?.is_muted || false;
  const isFavorite = conversation?.is_favorite || false;
  const isPinned = conversation?.is_pinned || false;
  const isInternal = conversation?.contact?.is_internal || false;
  const [savingInternal, setSavingInternal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Mesmo critério do Sidebar.js: usa a URL já salva no banco (contacts.
    // profile_picture_url) como valor inicial em vez de zerar pra null —
    // a busca ao vivo abaixo entra na MESMA fila compartilhada e limitada
    // (limitAvatarFetch, 3 por vez) que a sidebar inteira também usa, então
    // pode ficar minutos na fila (ou falhar) enquanto esse valor já existia
    // pronto. Sem isso o painel ficava sem foto nenhuma até a busca ao vivo
    // resolver — a sidebar, ao lado, sempre mostrava a foto na hora.
    setPhotoUrl(conversation?.contact?.profile_picture_url || null);
    setAbout(null);
    setBusinessProfile(null);
    setDisappearing(0);
    setShowPhotoViewer(false);
    setEditingName(false);
    setEditingNotes(false);
    if (!jid || isSiteChatId(jid)) return;

    // Incidente 2026-09-11: essa busca não passava pelo limitAvatarFetch
    // já usado em Sidebar.js/ChatArea.js — ver comentário completo em
    // GroupManager.js.
    limitAvatarFetch(() => baileysApi.getProfilePicture(jid, true, accountId))
      .then(res => { if (!cancelled && res?.url) setPhotoUrl(res.url); })
      .catch(() => {});

    baileysApi.getUserStatus(jid, accountId)
      .then(res => { if (!cancelled && res?.status) setAbout(res.status); })
      .catch(() => {});

    baileysApi.getContactBusinessProfile(jid, accountId)
      .then(res => { if (!cancelled && res?.profile) setBusinessProfile(res.profile); })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [jid, accountId]);

  const siteContactId = isSiteChat ? conversation?.contact?.id : null;
  useEffect(() => {
    setVisitor(null);
    if (!siteContactId) return;
    let cancelled = false;
    fetch(`/api/site-chat/contacts/${siteContactId}/visitor`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const rows = d?.data || [];
        if (!cancelled) setVisitor(rows.find(v => v.account_id === accountId) || rows[0] || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [siteContactId, accountId]);

  const mediaMessages = messages.filter(m => m.mediaUrl && MEDIA_TYPES.includes(m.type));
  const mediaThumbs = mediaMessages.filter(m => m.type === 'image' || m.type === 'video').slice(-3).reverse();
  const starredMessages = messages.filter(m => m.is_starred);
  const pinnedMessages = messages.filter(m => m.is_pinned);

  const handleDisappearingChange = (e) => {
    const value = Number(e.target.value);
    setDisappearing(value);
    if (!jid) return;
    baileysApi.setDisappearingMessages(jid, value, accountId)
      .catch(e2 => console.error('Erro ao configurar mensagens temporárias:', e2));
  };

  const startEditName = () => {
    setNameInput(savedName || profileName || '');
    setEditingName(true);
  };

  const cancelEditName = () => setEditingName(false);

  const handleSaveName = async () => {
    const trimmed = nameInput.trim();
    const contactId = conversation?.contact?.id;
    if (!trimmed || !contactId) { setEditingName(false); return; }
    setSavingName(true);
    try {
      await onUpdateContactName?.(contactId, trimmed);
      setEditingName(false);
    } catch (e) {
      console.error('Erro ao salvar nome do contato:', e);
      alert('Não foi possível salvar o nome do contato.');
    } finally {
      setSavingName(false);
    }
  };

  const startEditNotes = () => {
    setNotesInput(notes);
    setEditingNotes(true);
  };

  const cancelEditNotes = () => setEditingNotes(false);

  const handleSaveNotes = async () => {
    const contactId = conversation?.contact?.id;
    if (!contactId) { setEditingNotes(false); return; }
    setSavingNotes(true);
    try {
      await onUpdateContactNotes?.(contactId, notesInput.trim());
      setEditingNotes(false);
    } catch (e) {
      console.error('Erro ao salvar observações do contato:', e);
      alert('Não foi possível salvar as observações.');
    } finally {
      setSavingNotes(false);
    }
  };

  const handleToggleInternal = async () => {
    const contactId = conversation?.contact?.id;
    if (!contactId || savingInternal) return;
    setSavingInternal(true);
    try {
      await onUpdateContactInternal?.(contactId, !isInternal);
    } catch (e) {
      console.error('Erro ao marcar contato como interno:', e);
      alert('Não foi possível atualizar essa configuração.');
    } finally {
      setSavingInternal(false);
    }
  };

  const handleReportContact = () => {
    const confirmed = window.confirm(
      `Bloquear e denunciar ${name || formatPhoneDisplay(phoneNumber)}? O contato será bloqueado e não poderá mais te enviar mensagens.`
    );
    if (confirmed) onBlockContact?.();
  };

  if (!conversation) return null;

  return (
    <div className="contact-info-panel">
      <div className="cip-header">
        <button className="cip-icon-btn" onClick={onClose} title="Voltar">
          <MdArrowBack size={22} />
        </button>
        <span>Dados do contato</span>
      </div>

      <div className="cip-body">
        {/* Avatar / Nome / Telefone / Recado */}
        <div className="cip-profile">
          <div
            className={`cip-avatar ${photoUrl ? 'cip-avatar-clickable' : ''}`}
            onClick={() => photoUrl && setShowPhotoViewer(true)}
            title={photoUrl ? 'Ver foto do perfil' : undefined}
          >
            {photoUrl
              ? <img src={photoUrl} alt="" />
              : <span>{(name || phoneNumber || '?').charAt(0).toUpperCase()}</span>}
          </div>
          {editingName ? (
            <div className="cip-name-edit">
              <input
                autoFocus
                className="cip-name-input"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') cancelEditName();
                }}
                placeholder="Nome do contato"
                maxLength={255}
                disabled={savingName}
              />
              <button
                className="cip-icon-btn"
                onClick={handleSaveName}
                disabled={savingName || !nameInput.trim()}
                title="Salvar nome"
              >
                <MdCheck size={20} />
              </button>
              <button className="cip-icon-btn" onClick={cancelEditName} disabled={savingName} title="Cancelar">
                <MdClose size={20} />
              </button>
            </div>
          ) : (
            <div className="cip-name-row">
              {savedName
                ? <div className="cip-name">{savedName}</div>
                : <div className="cip-name-placeholder" onClick={startEditName}>Adicionar nome do contato</div>}
              <button className="cip-icon-btn cip-edit-name-btn" onClick={startEditName} title="Editar nome do contato">
                <MdEdit size={16} />
              </button>
            </div>
          )}
          <div className={savedName ? 'cip-phone-secondary' : 'cip-phone-primary'}>
            {isSiteChat
              ? (visitor?.email || visitor?.phone || 'Visitante do site')
              : (formatPhoneDisplay(phoneNumber) || 'Número desconhecido')}
          </div>
          {profileName && profileName !== savedName && (
            <div className="cip-profile-name">Nome do perfil: {profileName}</div>
          )}
          {about && <div className="cip-about">{about}</div>}
        </div>

        {/* Visitante do site (plugin WooCommerce) */}
        {isSiteChat && (
          <div className="cip-section">
            <div className="cip-section-title">🌐 Visitante do site</div>
            {visitor ? (
              <>
                <div className="cip-field">
                  <strong>Identificação</strong>
                  <p>
                    {visitor.verified
                      ? 'Cliente logado na loja (verificado)'
                      : '⚠️ Visitante não verificado (dados informados por ele)'}
                  </p>
                </div>
                {visitor.name && <div className="cip-field"><strong>Nome</strong><p>{visitor.name}</p></div>}
                {visitor.email && <div className="cip-field"><strong>E-mail</strong><p><a href={`mailto:${visitor.email}`}>{visitor.email}</a></p></div>}
                {visitor.phone && <div className="cip-field"><strong>Telefone</strong><p>{formatPhoneDisplay(visitor.phone) || visitor.phone}</p></div>}
                {visitor.wp_user_id && <div className="cip-field"><strong>ID do usuário na loja</strong><p>{visitor.wp_user_id}</p></div>}
                {visitor.last_page_url && (
                  <div className="cip-field">
                    <strong>Última página</strong>
                    <p>
                      <a href={visitor.last_page_url} target="_blank" rel="noreferrer">
                        {visitor.last_page_title || visitor.last_page_url}
                      </a>
                    </p>
                  </div>
                )}
                {visitor.first_seen_at && <div className="cip-field"><strong>Primeiro acesso</strong><p>{new Date(visitor.first_seen_at + 'Z').toLocaleString('pt-BR')}</p></div>}
                {visitor.last_seen_at && <div className="cip-field"><strong>Último acesso</strong><p>{new Date(visitor.last_seen_at + 'Z').toLocaleString('pt-BR')}</p></div>}
              </>
            ) : (
              <div className="cip-field"><p>Carregando dados do visitante...</p></div>
            )}
          </div>
        )}

        {/* Perfil comercial */}
        {businessProfile && (
          <div className="cip-section">
            <div className="cip-section-title">
              <MdBusiness size={16} /> Perfil comercial
            </div>
            {businessProfile.description && <div className="cip-field"><p>{businessProfile.description}</p></div>}
            {businessProfile.address && <div className="cip-field"><strong>Endereço</strong><p>{businessProfile.address}</p></div>}
            {businessProfile.email && <div className="cip-field"><strong>E-mail</strong><p><a href={`mailto:${businessProfile.email}`}>{businessProfile.email}</a></p></div>}
            {Array.isArray(businessProfile.website) && businessProfile.website.length > 0 && (
              <div className="cip-field">
                <strong>Site</strong>
                {businessProfile.website.map((w, i) => (
                  <p key={i}><a href={w} target="_blank" rel="noreferrer">{w}</a></p>
                ))}
              </div>
            )}
            {businessProfile.category && <div className="cip-field"><strong>Categoria</strong><p>{businessProfile.category}</p></div>}
          </div>
        )}

        {/* Observações internas — texto livre do atendente sobre o cliente,
            nunca sincronizado com o WhatsApp (Contact.notes). */}
        <div className="cip-section">
          <div className="cip-section-title">
            <MdOutlineStickyNote2 size={16} /> Observações
          </div>
          {editingNotes ? (
            <div className="cip-notes-edit">
              <textarea
                autoFocus
                className="cip-notes-input"
                value={notesInput}
                onChange={e => setNotesInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') cancelEditNotes(); }}
                placeholder="Anotações sobre este cliente (visível só pra equipe)"
                maxLength={2000}
                rows={4}
                disabled={savingNotes}
              />
              <div className="cip-notes-actions">
                <button className="cip-icon-btn" onClick={handleSaveNotes} disabled={savingNotes} title="Salvar observações">
                  <MdCheck size={20} />
                </button>
                <button className="cip-icon-btn" onClick={cancelEditNotes} disabled={savingNotes} title="Cancelar">
                  <MdClose size={20} />
                </button>
              </div>
            </div>
          ) : notes ? (
            <div className="cip-notes-text" onClick={startEditNotes} title="Clique para editar">
              {notes}
            </div>
          ) : (
            <div className="cip-empty cip-notes-placeholder" onClick={startEditNotes}>
              Adicionar observação sobre este cliente
            </div>
          )}
        </div>

        {/* Buscar no chat */}
        <button className="cip-row" onClick={() => onSearchInChat?.()}>
          <div className="cip-row-main">
            <span className="cip-row-label">Buscar no chat</span>
          </div>
          <MdSearch size={20} />
        </button>

        {/* Mídia, links e documentos */}
        <button className="cip-row" onClick={() => onViewMedia?.()}>
          <div className="cip-row-main">
            <span className="cip-row-label">Mídia, links e documentos</span>
            <span className="cip-row-sub">{mediaMessages.length} {mediaMessages.length === 1 ? 'item' : 'itens'}</span>
          </div>
          {mediaThumbs.length > 0 ? (
            <div className="cip-media-thumbs">
              {mediaThumbs.map((m, i) => (
                <div key={i} className="cip-media-thumb">
                  {m.type === 'video'
                    ? <MdVideoLibrary size={18} />
                    : <img src={m.mediaUrl} alt="" />}
                </div>
              ))}
            </div>
          ) : <MdChevronRight size={20} className="cip-row-chevron" />}
        </button>

        {/* Tarefas — todas, inclusive concluída/cancelada (a faixa do ChatArea
            só mostra as abertas, ver comentário na assinatura do componente). */}
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

        {/* Mensagens fixadas */}
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

        {/* Mensagens favoritas */}
        <div className="cip-section">
          <div className="cip-section-title">
            <MdStar size={16} /> Mensagens favoritas ({starredMessages.length})
          </div>
          {starredMessages.length === 0 ? (
            <div className="cip-empty">Nenhuma mensagem favoritada.</div>
          ) : (
            <div className="cip-starred-list">
              {starredMessages.map((m, i) => (
                <div key={m.wamid || i} className="cip-starred-item">
                  <div className="cip-starred-text">{m.message || m.caption || '[Mídia]'}</div>
                  <div className="cip-starred-footer">
                    <span>{moment(m.timestamp).format('DD/MM/YYYY HH:mm')}</span>
                    <button className="cip-unstar-btn" title="Remover dos favoritos" onClick={() => onStarMessage?.(m, false)}>
                      <MdStarBorder size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Fixar conversa */}
        <button className="cip-row" onClick={() => onPinChat?.()}>
          <div className="cip-row-main">
            <span className="cip-row-label">{isPinned ? 'Desafixar conversa' : 'Fixar conversa'}</span>
          </div>
          <span className={`cip-switch ${isPinned ? 'on' : ''}`}>
            {isPinned ? <BsPinFill size={16} /> : <BsPin size={16} />}
          </span>
        </button>

        {/* Silenciar notificações */}
        <button className="cip-row" onClick={() => onMuteChat?.()}>
          <div className="cip-row-main">
            <span className="cip-row-label">Silenciar notificações</span>
          </div>
          <span className={`cip-switch ${isMuted ? 'on' : ''}`}>
            {isMuted ? <MdNotificationsOff size={18} /> : <MdNotifications size={18} />}
          </span>
        </button>

        {/* Conversa interna — colega/fornecedor, sem bot/IA nem SLA/CSAT */}
        <button className="cip-row" onClick={handleToggleInternal} disabled={savingInternal}>
          <div className="cip-row-main">
            <span className="cip-row-label">Conversa interna</span>
            <span className="cip-row-sub">Sem bot/IA, sem SLA/CSAT — uso entre equipe/fornecedores</span>
          </div>
          <span className={`cip-switch ${isInternal ? 'on' : ''}`}>
            <MdWorkOutline size={18} />
          </span>
        </button>

        {/* Mensagens temporárias */}
        {!isSiteChat && <div className="cip-row cip-row-static">
          <div className="cip-row-main">
            <span className="cip-row-label"><MdTimer size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />Mensagens temporárias</span>
          </div>
          <select className="cip-select" value={disappearing} onChange={handleDisappearingChange} disabled={!isBaileys}>
            {DISAPPEARING_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>}

        {/* Criptografia */}
        {!isSiteChat && <div className="cip-row cip-row-static cip-encryption">
          <MdLock size={18} />
          <span>As mensagens pessoais são protegidas com a criptografia de ponta a ponta. Toque para saber mais.</span>
        </div>}

        {/* Adicionar aos favoritos */}
        <button className="cip-row" onClick={() => onToggleFavorite?.()}>
          <div className="cip-row-main">
            <span className="cip-row-label">{isFavorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}</span>
          </div>
          {isFavorite ? <MdStar size={20} color="var(--whatsapp-green)" /> : <MdStarBorder size={20} />}
        </button>

        {/* Adicionar à lista */}
        <button className="cip-row" onClick={() => alert('Funcionalidade "Listas/Etiquetas" será implementada em breve!')}>
          <div className="cip-row-main">
            <span className="cip-row-label">Adicionar à lista</span>
          </div>
          <MdLabelOutline size={20} />
        </button>

        {/* Zona de ações críticas */}
        <div className="cip-section cip-danger-zone">
          <button className="cip-row cip-danger" onClick={() => onClearChat?.()}>
            <MdDeleteOutline size={20} /> <span>Limpar conversa</span>
          </button>
          <button className="cip-row cip-danger" onClick={() => onBlockContact?.()}>
            <MdBlock size={20} /> <span>Bloquear {name || formatPhoneDisplay(phoneNumber)}</span>
          </button>
          {!isSiteChat && <button className="cip-row cip-danger" onClick={handleReportContact}>
            <MdReport size={20} /> <span>Denunciar contato</span>
          </button>}
          <button className="cip-row cip-danger" onClick={() => onDeleteChat?.()}>
            <MdDeleteOutline size={20} /> <span>Apagar conversa</span>
          </button>
        </div>
      </div>

      {showPhotoViewer && photoUrl && (
        <div className="cip-photo-viewer-overlay" onClick={() => setShowPhotoViewer(false)}>
          <div className="cip-photo-viewer-header" onClick={e => e.stopPropagation()}>
            <button className="cip-icon-btn cip-photo-viewer-btn" onClick={() => setShowPhotoViewer(false)} title="Fechar">
              <MdClose size={24} />
            </button>
            <span>{name || formatPhoneDisplay(phoneNumber)}</span>
            <a
              className="cip-icon-btn cip-photo-viewer-btn"
              href={photoUrl}
              download
              target="_blank"
              rel="noopener noreferrer"
              title="Baixar foto"
              onClick={e => e.stopPropagation()}
            >
              <MdDownload size={22} />
            </a>
          </div>
          <img
            src={photoUrl}
            alt=""
            className="cip-photo-viewer-img"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
};

export default ContactInfoPanel;
