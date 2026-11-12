/**
 * InternalChatAreaMenu.js - Menu de ações da conversa interna (Equipe)
 * Paridade com ChatAreaMenu.js (clientes) — Fixar, Favoritar, Silenciar,
 * Buscar no Chat, Ver Mídia Compartilhada. Sem Arquivar/Bloquear/Excluir/
 * Sair do Grupo aqui — não fazem parte do chat interno.
 */
import React, { useState, useRef } from 'react';
import { MdMoreVert, MdPushPin, MdNotificationsOff, MdNotificationsActive, MdSearch, MdImage, MdStar, MdStarBorder } from 'react-icons/md';
import useClickOutside from '../../utils/useClickOutside';
import '../../styles/menus/ChatAreaMenu.css';

const InternalChatAreaMenu = ({ conversation, onPinChat, onFavoriteChat, onMuteChat, onSearchInChat, onViewMedia }) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  useClickOutside(menuRef, () => setIsOpen(false), isOpen);

  const handleMenuClick = (action) => {
    action?.();
    setIsOpen(false);
  };

  const isPinned = conversation?.is_pinned || false;
  const isFavorite = conversation?.is_favorite || false;
  const isMuted = conversation?.is_muted || false;

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
            <div className="menu-section">
              <button className="chat-area-menu-item" onClick={() => handleMenuClick(onPinChat)}>
                <MdPushPin size={20} />
                <span>{isPinned ? 'Desafixar' : 'Fixar'} Conversa</span>
              </button>

              <button className="chat-area-menu-item" onClick={() => handleMenuClick(onFavoriteChat)}>
                {isFavorite ? <MdStar size={20} /> : <MdStarBorder size={20} />}
                <span>{isFavorite ? 'Remover de' : 'Adicionar aos'} Favoritos</span>
              </button>

              <button className="chat-area-menu-item" onClick={() => handleMenuClick(onMuteChat)}>
                {isMuted ? <MdNotificationsActive size={20} /> : <MdNotificationsOff size={20} />}
                <span>{isMuted ? 'Ativar' : 'Silenciar'} Notificações</span>
              </button>
            </div>

            <div className="menu-separator" />

            <div className="menu-section">
              <button className="chat-area-menu-item" onClick={() => handleMenuClick(onSearchInChat)}>
                <MdSearch size={20} />
                <span>Buscar no Chat</span>
              </button>

              <button className="chat-area-menu-item" onClick={() => handleMenuClick(onViewMedia)}>
                <MdImage size={20} />
                <span>Ver Mídia Compartilhada</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default InternalChatAreaMenu;
