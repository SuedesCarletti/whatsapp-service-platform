/**
 * InternalContactInfoPanel — painel lateral "Dados do contato" pro chat
 * interno (1:1 entre membros da equipe), mesmo estilo/CSS do ContactInfoPanel
 * usado no chat de cliente (renderizado como irmão do InternalChatArea, não
 * como modal — igual ao WhatsApp Web).
 *
 * Dois modos:
 *  - `conversation` (DM já existente, aberta): mostra tudo — fixar/
 *    favoritar/silenciar essa conversa, buscar, mídia, tarefas, mensagens
 *    fixadas/favoritas.
 *  - `member` (preview de alguém com quem ainda não tem DM — clicado num
 *    participante da lista de um grupo ou no nome acima da mensagem dele):
 *    card simples com "Conversar" — igual ao WhatsApp, que mostra o
 *    contato primeiro e só abre o chat se você pedir.
 */
import React from 'react';
import { MdArrowBack, MdEmail, MdStar, MdStarBorder, MdSearch, MdChat, MdNotifications, MdNotificationsOff } from 'react-icons/md';
import { BsBriefcase, BsPinFill, BsPin, BsListCheck } from 'react-icons/bs';
import moment from 'moment';
import { PresenceDot, PRESENCE_META, formatLastSeen } from './InternalChatArea';
import '../styles/ContactInfoPanel.css';

const getInitials = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const InternalContactInfoPanel = ({
  conversation, member: memberProp, currentUserId, presence, messages = [], tasks = [],
  onToggleTask, onOpenTask, onStarMessage, onPinMessage, onClose, onStartChat,
  onPinChat, onToggleFavorite, onToggleMute, onSearchInChat, onViewMedia,
}) => {
  // DM consigo mesmo: não tem "outro" participante — cai pro próprio
  // usuário (único participante da conversa nesse caso).
  const other = memberProp
    || (conversation?.participants || []).find(p => p.id !== currentUserId)
    || (conversation?.participants || []).find(p => p.id === currentUserId);
  if (!other) return null;

  // Modo preview (member, sem conversation ainda): sem chat de verdade
  // ainda, então sem fixar/favoritar/silenciar/buscar/mídia/tarefas — só
  // dados da pessoa + "Conversar", igual o card de contato do WhatsApp
  // antes da primeira mensagem.
  const isPreview = !conversation;

  const starredMessages = messages.filter(m => m.is_starred && !m.is_deleted);
  const pinnedMessages = messages.filter(m => m.is_pinned && !m.is_deleted);
  const isPinned = conversation?.is_pinned || false;
  const isFavorite = conversation?.is_favorite || false;
  const isMuted = conversation?.is_muted || false;

  const statusLabel = presence?.status && presence.status !== 'offline'
    ? (PRESENCE_META[presence.status]?.label || 'Disponível')
    : formatLastSeen(presence?.last_seen_at);

  return (
    <div className="contact-info-panel">
      <div className="cip-header">
        <button className="cip-icon-btn" onClick={onClose} title="Voltar">
          <MdArrowBack size={22} />
        </button>
        <span>Dados do contato</span>
      </div>

      <div className="cip-body">
        <div className="cip-profile">
          <div className="cip-avatar" style={{ position: 'relative' }}>
            {(memberProp?.photo_url || conversation?.photo_url)
              ? <img src={memberProp?.photo_url || conversation?.photo_url} alt="" />
              : <span>{getInitials(other.full_name)}</span>}
            {!isPreview && <PresenceDot status={presence?.status || 'offline'} size={18} />}
          </div>
          <div className="cip-name">{other.full_name}</div>
          {!isPreview && <div className="cip-phone-secondary">{statusLabel}</div>}
        </div>

        {isPreview && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 16px 8px' }}>
            <button
              onClick={() => onStartChat?.(other.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderRadius: 20,
                border: 'none', background: 'var(--whatsapp-green, #25D366)', color: '#fff',
                fontWeight: 600, fontSize: 14, cursor: 'pointer',
              }}
            >
              <MdChat size={18} /> Conversar
            </button>
          </div>
        )}

        <div className="cip-section">
          {other.email && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, marginBottom: other.sector ? 12 : 0 }}>
              <MdEmail size={18} style={{ opacity: 0.6, flexShrink: 0 }} /> {other.email}
            </div>
          )}
          {other.sector && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 }}>
              <BsBriefcase size={16} style={{ opacity: 0.6, flexShrink: 0 }} /> {other.sector}
            </div>
          )}
        </div>

        {!isPreview && (
          <>
            {/* Buscar no chat */}
            <button className="cip-row" onClick={() => onSearchInChat?.()}>
              <div className="cip-row-main">
                <span className="cip-row-label">Buscar no chat</span>
              </div>
              <MdSearch size={20} />
            </button>

            {/* Mídia compartilhada */}
            <button className="cip-row" onClick={() => onViewMedia?.()}>
              <div className="cip-row-main">
                <span className="cip-row-label">Mídia compartilhada</span>
              </div>
              <MdChevronRightIcon />
            </button>

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
                            <div className="cip-starred-text" style={{ textDecoration: (t.status === 'done' || t.status === 'cancelled') ? 'line-through' : 'none', opacity: (t.status === 'done' || t.status === 'cancelled') ? 0.6 : 1 }}>
                              {t.title} {t.status === 'paused' && <span style={{ fontSize: 11, opacity: 0.7 }}>⏸️ pausada</span>} {t.status === 'cancelled' && <span style={{ fontSize: 11, opacity: 0.7, color: '#e53e3e' }}>🚫 cancelada</span>}
                            </div>
                            <div className="cip-starred-footer">
                              <span>
                                {t.assigned_to ? `👤 ${t.assigned_to.full_name}` : ''}
                                {t.due_at ? `${t.assigned_to ? ' · ' : ''}⏰ ${moment(t.due_at).format('DD/MM HH:mm')}` : ''}
                                {totalSubtasks > 0 ? ` ${(t.assigned_to || t.due_at) ? '· ' : ''}☑️ ${doneSubtasks}/${totalSubtasks}` : ''}
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

            <div className="cip-section">
              <div className="cip-section-title">
                <MdStar size={16} /> Mensagens favoritas ({starredMessages.length})
              </div>
              {starredMessages.length === 0 ? (
                <div className="cip-empty">Nenhuma mensagem favoritada.</div>
              ) : (
                <div className="cip-starred-list">
                  {starredMessages.map((m, i) => (
                    <div key={m.id || i} className="cip-starred-item">
                      <div className="cip-starred-text">{m.text || (m.message_type !== 'text' ? `[${m.message_type}]` : '')}</div>
                      <div className="cip-starred-footer">
                        <span>{moment(m.created_at).format('DD/MM/YYYY HH:mm')}</span>
                        <button className="cip-unstar-btn" title="Remover dos favoritos" onClick={() => onStarMessage?.(m.id, false)}>
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
            <button className="cip-row" onClick={() => onToggleMute?.()}>
              <div className="cip-row-main">
                <span className="cip-row-label">Silenciar notificações</span>
              </div>
              <span className={`cip-switch ${isMuted ? 'on' : ''}`}>
                {isMuted ? <MdNotificationsOff size={18} /> : <MdNotifications size={18} />}
              </span>
            </button>

            {/* Favoritar */}
            <button className="cip-row" onClick={() => onToggleFavorite?.()}>
              <div className="cip-row-main">
                <span className="cip-row-label">{isFavorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}</span>
              </div>
              {isFavorite ? <MdStar size={20} color="var(--whatsapp-green)" /> : <MdStarBorder size={20} />}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

// Pequeno "›" — evita puxar mais um ícone só pra isso, mesmo efeito visual
// do cip-row-chevron usado em ContactInfoPanel.js.
const MdChevronRightIcon = () => <span style={{ opacity: 0.5, fontSize: 20 }}>›</span>;

export default InternalContactInfoPanel;
