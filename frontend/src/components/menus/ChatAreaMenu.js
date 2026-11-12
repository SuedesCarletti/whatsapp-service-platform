/**
 * ChatAreaMenu.js - Menu de ações específicas da conversa atual
 * Localização: Header do ChatArea (3 pontos)
 */
import React, { useState, useRef, useEffect } from 'react';
import {
  MdMoreVert,
  MdPushPin,
  MdNotificationsOff,
  MdArchive,
  MdMarkunread,
  MdDeleteOutline,
  MdBlock,
  MdInfo,
  MdSearch,
  MdImage,
  MdStar,
  MdStarBorder,
  MdGroup
} from 'react-icons/md';
import '../../styles/menus/ChatAreaMenu.css';

const ChatAreaMenu = ({
  conversation,
  providerType,
  onPinChat,
  onMuteChat,
  onArchiveChat,
  onMarkAsRead,
  onMarkAsUnread,
  onClearChat,
  onDeleteChat,
  onBlockContact,
  onLeaveGroup,
  onViewContact,
  onSearchInChat,
  onViewMedia,
  onToggleFavorite
}) => {
  // group/metadata etc. (routes_baileys.py) já aceitam Baileys/WPPConnect/
  // WhatsApp-Web.js — só Venom e Meta Cloud não têm conceito de grupo.
  const supportsGroupManagement = ['baileys', 'wppconnect', 'whatsapp_web_js'].includes(providerType);
  const isGroup = conversation?.is_group || (conversation?.contact?.wa_id || '').includes('@g.us');
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  // Fechar menu ao clicar fora
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleMenuClick = (action) => {
    action();
    setIsOpen(false);
  };

  // Verificar estados da conversa
  const isPinned = conversation?.is_pinned || false;
  const isMuted = conversation?.is_muted || false;
  const isFavorite = conversation?.is_favorite || false;
  const isArchived = conversation?.is_archived || false;
  const hasUnread = conversation?.unread_count > 0;

  return (
    <div className="chat-area-menu" ref={menuRef}>
      <button
        className="chat-area-menu-trigger"
        onClick={() => setIsOpen(!isOpen)}
        title="Opções da Conversa"
      >
        <MdMoreVert size={24} />
      </button>

      {isOpen && (
        <div className="chat-area-menu-dropdown">
          <div className="chat-area-menu-header">
            <span>Opções da Conversa</span>
          </div>

          <div className="chat-area-menu-items">
            {/* Seção: Gerenciamento */}
            <div className="menu-section">
              <div className="menu-section-title">Gerenciar</div>

              <button
                className="chat-area-menu-item"
                onClick={() => handleMenuClick(onPinChat)}
              >
                <MdPushPin size={20} />
                <span>{isPinned ? 'Desafixar' : 'Fixar'} Conversa</span>
              </button>

              <button
                className="chat-area-menu-item"
                onClick={() => handleMenuClick(onMuteChat)}
              >
                <MdNotificationsOff size={20} />
                <span>{isMuted ? 'Ativar' : 'Silenciar'} Notificações</span>
              </button>

              <button
                className="chat-area-menu-item"
                onClick={() => handleMenuClick(onToggleFavorite)}
              >
                {isFavorite ? <MdStar size={20} /> : <MdStarBorder size={20} />}
                <span>{isFavorite ? 'Remover de' : 'Adicionar aos'} Favoritos</span>
              </button>

              {!isArchived && (
                <button
                  className="chat-area-menu-item"
                  onClick={() => handleMenuClick(onArchiveChat)}
                >
                  <MdArchive size={20} />
                  <span>Arquivar Conversa</span>
                </button>
              )}

              {hasUnread ? (
                <button
                  className="chat-area-menu-item"
                  onClick={() => handleMenuClick(onMarkAsRead)}
                >
                  <MdMarkunread size={20} />
                  <span>Marcar como Lida</span>
                </button>
              ) : (
                <button
                  className="chat-area-menu-item"
                  onClick={() => handleMenuClick(onMarkAsUnread)}
                >
                  <MdMarkunread size={20} />
                  <span>Marcar como Não Lida</span>
                </button>
              )}
            </div>

            {/* Separador */}
            <div className="menu-separator" />

            {/* Seção: Informações */}
            <div className="menu-section">
              <div className="menu-section-title">Informações</div>

              <button
                className="chat-area-menu-item"
                onClick={() => handleMenuClick(onViewContact)}
              >
                {supportsGroupManagement && isGroup ? <MdGroup size={20} /> : <MdInfo size={20} />}
                <span>{supportsGroupManagement && isGroup ? 'Gerenciar Grupo' : 'Ver Info do Contato'}</span>
              </button>

              <button
                className="chat-area-menu-item"
                onClick={() => handleMenuClick(onViewMedia)}
              >
                <MdImage size={20} />
                <span>Ver Mídia Compartilhada</span>
              </button>

              <button
                className="chat-area-menu-item"
                onClick={() => handleMenuClick(onSearchInChat)}
              >
                <MdSearch size={20} />
                <span>Buscar no Chat</span>
              </button>
            </div>

            {/* Separador */}
            <div className="menu-separator" />

            {/* Seção: Ações Críticas */}
            <div className="menu-section">
              <button
                className="chat-area-menu-item danger"
                onClick={() => handleMenuClick(onClearChat)}
              >
                <MdDeleteOutline size={20} />
                <span>Limpar Chat Local</span>
              </button>

              <button
                className="chat-area-menu-item danger"
                onClick={() => handleMenuClick(onDeleteChat)}
              >
                <MdDeleteOutline size={20} />
                <span>Excluir Chat (WhatsApp)</span>
              </button>

              {isGroup ? (
                <button
                  className="chat-area-menu-item danger"
                  onClick={() => handleMenuClick(onLeaveGroup)}
                >
                  <MdGroup size={20} />
                  <span>Sair do Grupo</span>
                </button>
              ) : (
                <button
                  className="chat-area-menu-item danger"
                  onClick={() => handleMenuClick(onBlockContact)}
                >
                  <MdBlock size={20} />
                  <span>Bloquear Contato</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatAreaMenu;
