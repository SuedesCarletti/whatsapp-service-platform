/**
 * ConversationListMenu.js - Menu de funcionalidades globais
 * Localização: Header da Sidebar (3 pontos)
 */
import React, { useState, useRef, useEffect } from 'react';
import {
  MdMoreVert,
  MdChat,
  MdCampaign,
  MdGroup,
  MdEmail,
  MdBookmark,
  MdLabel,
  MdAnalytics,
  MdBusiness,
  MdQrCode2,
  MdAssessment,
  MdLogout
} from 'react-icons/md';
import '../../styles/menus/ConversationListMenu.css';

const ConversationListMenu = ({
  providerType,
  onNewChat,
  onNewBroadcast,
  onNewGroup,
  onManageTemplates,
  onSavedMessages,
  onManageLabels,
  onOpenAnalytics,
  onOpenBusinessProfile,
  onOpenQRManager,
  onOpenReports,
  onOpenSettings,
  onOpenProfilePanel,
  onLogout
}) => {
  const isBaileys = providerType === 'baileys';
  const isMeta = providerType && !isBaileys;
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

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
    if (action) {
      action();
    }
    setIsOpen(false);
  };

  return (
    <div className="conversation-list-menu" ref={menuRef}>
      <button
        className="conversation-list-menu-trigger"
        onClick={() => setIsOpen(!isOpen)}
        title="Menu Geral"
      >
        <MdMoreVert size={24} />
      </button>

      {isOpen && (
        <div className="conversation-list-menu-dropdown">
          <div className="conversation-list-menu-header">
            <span>Menu Geral</span>
          </div>

          <div className="conversation-list-menu-items">
            {/* Seção: Criar Novo */}
            <div className="menu-section">
              <div className="menu-section-title">Criar Novo</div>

              <button
                className="conversation-list-menu-item"
                onClick={() => handleMenuClick(onNewChat)}
              >
                <div className="menu-item-icon new-chat"><MdChat size={18} /></div>
                <div className="menu-item-content">
                  <div className="menu-item-title">Nova Conversa</div>
                  <div className="menu-item-description">Iniciar chat individual</div>
                </div>
              </button>

              {/* Novo Grupo — apenas Baileys */}
              {isBaileys && onNewGroup && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onNewGroup)}
                >
                  <div className="menu-item-icon group"><MdGroup size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Novo Grupo</div>
                    <div className="menu-item-description">Criar grupo de conversa</div>
                  </div>
                </button>
              )}

              {/* Nova Transmissão — funciona igual nos 4 bridges + Meta (é só
                  múltiplos sends individuais, não depende de recurso de
                  protocolo específico do Baileys) */}
              {onNewBroadcast && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onNewBroadcast)}
                >
                  <div className="menu-item-icon broadcast"><MdCampaign size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Nova Transmissão</div>
                    <div className="menu-item-description">Enviar para vários contatos</div>
                  </div>
                </button>
              )}
            </div>

            <div className="menu-separator" />

            {/* Seção: Gerenciar */}
            <div className="menu-section">
              <div className="menu-section-title">Gerenciar</div>

              {/* Templates — apenas Meta */}
              {isMeta && onManageTemplates && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onManageTemplates)}
                >
                  <div className="menu-item-icon templates"><MdEmail size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Templates</div>
                    <div className="menu-item-description">Mensagens pré-aprovadas</div>
                  </div>
                </button>
              )}

              {onSavedMessages && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onSavedMessages)}
                >
                  <div className="menu-item-icon saved"><MdBookmark size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Mensagens Salvas</div>
                    <div className="menu-item-description">Suas mensagens favoritas</div>
                  </div>
                </button>
              )}

              {onManageLabels && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onManageLabels)}
                >
                  <div className="menu-item-icon labels"><MdLabel size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Etiquetas</div>
                    <div className="menu-item-description">Organizar conversas</div>
                  </div>
                </button>
              )}
            </div>

            <div className="menu-separator" />

            {/* Seção: Business */}
            <div className="menu-section">
              <div className="menu-section-title">Business</div>

              {onOpenAnalytics && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onOpenAnalytics)}
                >
                  <div className="menu-item-icon analytics"><MdAnalytics size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Analytics</div>
                    <div className="menu-item-description">Métricas e estatísticas</div>
                  </div>
                </button>
              )}

              {/* Perfil do Negócio — apenas Meta */}
              {isMeta && onOpenBusinessProfile && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onOpenBusinessProfile)}
                >
                  <div className="menu-item-icon business"><MdBusiness size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Perfil do Negócio</div>
                    <div className="menu-item-description">Editar informações</div>
                  </div>
                </button>
              )}

              {/* QR Codes — apenas Baileys (autenticação via QR) */}
              {isBaileys && onOpenQRManager && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onOpenQRManager)}
                >
                  <div className="menu-item-icon qr"><MdQrCode2 size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Conectar via QR</div>
                    <div className="menu-item-description">Escanear QR do WhatsApp</div>
                  </div>
                </button>
              )}

              {onOpenReports && (
                <button
                  className="conversation-list-menu-item"
                  onClick={() => handleMenuClick(onOpenReports)}
                >
                  <div className="menu-item-icon reports"><MdAssessment size={18} /></div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Relatórios</div>
                    <div className="menu-item-description">Exportar dados</div>
                  </div>
                </button>
              )}
            </div>

            <div className="menu-separator" />

            {/* Seção: Sistema */}
            <div className="menu-section">
              {onLogout && (
                <button
                  className="conversation-list-menu-item logout-item"
                  onClick={() => handleMenuClick(onLogout)}
                >
                  <div className="menu-item-icon logout">
                    <MdLogout size={18} />
                  </div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Sair</div>
                    <div className="menu-item-description">Encerrar sessão</div>
                  </div>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConversationListMenu;
