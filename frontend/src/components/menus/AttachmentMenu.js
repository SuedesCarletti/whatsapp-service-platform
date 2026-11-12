/**
 * AttachmentMenu.js - Menu de tipos de mensagens enviáveis
 * Localização: Input de mensagem (clipe)
 */
import React, { useState, useRef, useEffect } from 'react';
import {
  MdImage,
  MdVideocam,
  MdAudioFile,
  MdDescription,
  MdLocationOn,
  MdContactPhone,
  MdFormatListBulleted,
  MdShoppingBasket,
  MdShoppingCart,
  MdEmail,
  MdDynamicForm,
  MdMyLocation,
  MdVisibilityOff
} from 'react-icons/md';
import { BsPaperclip, BsReply, BsCardImage } from 'react-icons/bs';
import { MdPoll } from 'react-icons/md';
import '../../styles/menus/AttachmentMenu.css';

// Mesmo conjunto de ADVANCED_API_PROVIDERS em App.js / _FULL_API_PROVIDERS em
// routes_baileys.py: Baileys e as libs baseadas em Puppeteer/whatsapp-web.js
// suportam enquete, GIF, visualização única e envio de contato (vCard) — o
// Venom não implementa nenhum desses no provider Python (ver
// backend/providers/venom_provider.py) e por isso fica de fora.
const EXTRAS_PROVIDERS = ['baileys', 'wppconnect', 'whatsapp_web_js'];

const AttachmentMenu = ({
  conversation,
  providerType,        // "baileys" | "wppconnect" | "whatsapp_web_js" | "venom" | "meta_cloud_*" | null
  onSendMedia,
  onSendLocation,
  onSendContact,
  onSendButtons,
  onSendList,
  onSendProduct,
  onSendProductList,
  onSendTemplate,
  onSendCart,
  onSendFlow,
  onRequestLocation,
  onSendCarousel,
  onSendPoll,         // WhatsApp Web only (ver EXTRAS_PROVIDERS)
  onSendViewOnce,     // WhatsApp Web only (ver EXTRAS_PROVIDERS)
  onSendCtaUrl,       // Meta-only
}) => {
  // Mesma convenção usada em ChatArea.js: os 4 variantes de provider_type da
  // Meta começam com "meta_cloud" — qualquer outra coisa (baileys, wppconnect,
  // whatsapp_web_js, venom, ou provider ainda não definido) é WhatsApp Web.
  const isMeta = (providerType || '').startsWith('meta_cloud');
  const supportsExtras = EXTRAS_PROVIDERS.includes(providerType);
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  const isDisabled = !conversation;

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
    if (!isDisabled && action) {
      action();
    }
    setIsOpen(false);
  };

  return (
    <div className="attachment-menu" ref={menuRef}>
      <button
        className="attachment-menu-trigger"
        onClick={() => !isDisabled && setIsOpen(!isOpen)}
        disabled={isDisabled}
        title={isDisabled ? "Selecione uma conversa" : "Mais opções de envio"}
      >
        <BsPaperclip size={24} />
      </button>

      {isOpen && !isDisabled && (
        <div className="attachment-menu-dropdown">
          <div className="attachment-menu-header">
            <span>Enviar</span>
          </div>

          <div className="attachment-menu-items">
            {/* Seção: Mídia Básica */}
            <div className="menu-section">
              <div className="menu-section-title">Mídia</div>

              <button
                className="attachment-menu-item"
                onClick={() => handleMenuClick(() => onSendMedia('image'))}
              >
                <div className="menu-item-icon media">
                  <MdImage size={20} />
                </div>
                <div className="menu-item-content">
                  <div className="menu-item-title">Fotos & Vídeos</div>
                  <div className="menu-item-description">Imagens, vídeos, GIFs</div>
                </div>
              </button>

              <button
                className="attachment-menu-item"
                onClick={() => handleMenuClick(() => onSendMedia('audio'))}
              >
                <div className="menu-item-icon audio">
                  <MdAudioFile size={20} />
                </div>
                <div className="menu-item-content">
                  <div className="menu-item-title">Áudio</div>
                  <div className="menu-item-description">Arquivos de áudio</div>
                </div>
              </button>

              <button
                className="attachment-menu-item"
                onClick={() => handleMenuClick(() => onSendMedia('document'))}
              >
                <div className="menu-item-icon document">
                  <MdDescription size={20} />
                </div>
                <div className="menu-item-content">
                  <div className="menu-item-title">Documentos</div>
                  <div className="menu-item-description">PDF, DOC, XLS, etc</div>
                </div>
              </button>
            </div>

            <div className="menu-separator" />

              {/* 3. Enviar/Solicitar Localização */}
              <div className="menu-section-title">Localização</div>
              <button
                className="attachment-menu-item"
                onClick={() => handleMenuClick(onSendLocation)}
              >
                <div className="menu-item-icon location">
                  <MdLocationOn size={20} />
                </div>
                <div className="menu-item-content">
                  <div className="menu-item-title">Enviar Localização</div>
                  <div className="menu-item-description">Compartilhar minha localização</div>
                </div>
              </button>
              
              {/* Mensagem interativa de solicitação de localização — exclusiva da Meta Cloud API,
                  o protocolo do WhatsApp Web (Baileys) não tem esse tipo de mensagem. */}
              {isMeta && onRequestLocation && (
                <button
                  className="attachment-menu-item"
                  onClick={() => handleMenuClick(onRequestLocation)}
                >
                  <div className="menu-item-icon location-request">
                    <MdMyLocation size={20} />
                  </div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Solicitar Localização</div>
                    <div className="menu-item-description">Pedir localização do cliente</div>
                  </div>
                </button>
              )}

              {(supportsExtras || isMeta) && (
                <button
                  className="attachment-menu-item"
                  onClick={() => handleMenuClick(onSendContact)}
                >
                  <div className="menu-item-icon contact">
                    <MdContactPhone size={20} />
                  </div>
                  <div className="menu-item-content">
                    <div className="menu-item-title">Contato</div>
                    <div className="menu-item-description">Compartilhar vCard</div>
                  </div>
                </button>
              )}

            <div className="menu-separator" />

            {/* Seção: Interativo — WhatsApp Web (Baileys/WPPConnect/whatsapp-web.js); Venom e Meta não suportam */}
            {supportsExtras && (onSendPoll || onSendViewOnce) && (
              <div className="menu-section">
                <div className="menu-section-title">Interativo</div>
                {onSendPoll && (
                  <button
                    className="attachment-menu-item"
                    onClick={() => handleMenuClick(onSendPoll)}
                  >
                    <div className="menu-item-icon poll">
                      <MdPoll size={20} />
                    </div>
                    <div className="menu-item-content">
                      <div className="menu-item-title">Enquete</div>
                      <div className="menu-item-description">Criar votação</div>
                    </div>
                  </button>
                )}
                {onSendViewOnce && (
                  <button
                    className="attachment-menu-item"
                    onClick={() => handleMenuClick(onSendViewOnce)}
                  >
                    <div className="menu-item-icon view-once">
                      <MdVisibilityOff size={20} />
                    </div>
                    <div className="menu-item-content">
                      <div className="menu-item-title">Visualização única</div>
                      <div className="menu-item-description">Foto/vídeo que some após abrir</div>
                    </div>
                  </button>
                )}
              </div>
            )}

            {/* Seção: Interativo — Meta-only */}
            {isMeta && (
              <>
                <div className="menu-section">
                  <div className="menu-section-title">Interativo</div>

                  <button
                    className="attachment-menu-item"
                    onClick={() => handleMenuClick(onSendButtons)}
                  >
                    <div className="menu-item-icon buttons">
                      <BsReply size={20} />
                    </div>
                    <div className="menu-item-content">
                      <div className="menu-item-title">Botões</div>
                      <div className="menu-item-description">Até 3 opções</div>
                    </div>
                  </button>

                  <button
                    className="attachment-menu-item"
                    onClick={() => handleMenuClick(onSendList)}
                  >
                    <div className="menu-item-icon list">
                      <MdFormatListBulleted size={20} />
                    </div>
                    <div className="menu-item-content">
                      <div className="menu-item-title">Lista</div>
                      <div className="menu-item-description">Menu de opções</div>
                    </div>
                  </button>

                  {onSendCtaUrl && (
                    <button
                      className="attachment-menu-item"
                      onClick={() => handleMenuClick(onSendCtaUrl)}
                    >
                      <div className="menu-item-icon cta">
                        <MdEmail size={20} />
                      </div>
                      <div className="menu-item-content">
                        <div className="menu-item-title">Botão com link</div>
                        <div className="menu-item-description">Abre uma URL externa</div>
                      </div>
                    </button>
                  )}
                </div>

                <div className="menu-separator" />

                {/* Business/E-commerce — Meta Cloud apenas */}
                <div className="menu-section">
                  <div className="menu-section-title">Business (Meta)</div>

                  {onSendProduct && (
                    <button
                      className="attachment-menu-item"
                      onClick={() => handleMenuClick(onSendProduct)}
                    >
                      <div className="menu-item-icon product">
                        <MdShoppingBasket size={20} />
                      </div>
                      <div className="menu-item-content">
                        <div className="menu-item-title">Produto</div>
                        <div className="menu-item-description">Do catálogo</div>
                      </div>
                    </button>
                  )}

                  {onSendProductList && (
                    <button
                      className="attachment-menu-item"
                      onClick={() => handleMenuClick(onSendProductList)}
                    >
                      <div className="menu-item-icon product-list">
                        <MdShoppingBasket size={20} />
                      </div>
                      <div className="menu-item-content">
                        <div className="menu-item-title">Lista de Produtos</div>
                        <div className="menu-item-description">Vários produtos</div>
                      </div>
                    </button>
                  )}

                  {onSendCart && (
                    <button
                      className="attachment-menu-item"
                      onClick={() => handleMenuClick(onSendCart)}
                    >
                      <div className="menu-item-icon cart">
                        <MdShoppingCart size={20} />
                      </div>
                      <div className="menu-item-content">
                        <div className="menu-item-title">Carrinho</div>
                        <div className="menu-item-description">Enviar pedido</div>
                      </div>
                    </button>
                  )}

                  {onSendTemplate && (
                    <button
                      className="attachment-menu-item"
                      onClick={() => handleMenuClick(onSendTemplate)}
                    >
                      <div className="menu-item-icon template">
                        <MdEmail size={20} />
                      </div>
                      <div className="menu-item-content">
                        <div className="menu-item-title">Template</div>
                        <div className="menu-item-description">Mensagem aprovada</div>
                      </div>
                    </button>
                  )}

                  {onSendFlow && (
                    <button
                      className="attachment-menu-item"
                      onClick={() => handleMenuClick(onSendFlow)}
                    >
                      <div className="menu-item-icon flow">
                        <MdDynamicForm size={20} />
                      </div>
                      <div className="menu-item-content">
                        <div className="menu-item-title">Formulário</div>
                        <div className="menu-item-description">Flow interativo</div>
                      </div>
                    </button>
                  )}

                  {onSendCarousel && (
                    <button
                      className="attachment-menu-item"
                      onClick={() => handleMenuClick(onSendCarousel)}
                    >
                      <div className="menu-item-icon carousel">
                        <BsCardImage size={20} />
                      </div>
                      <div className="menu-item-content">
                        <div className="menu-item-title">Carrossel</div>
                        <div className="menu-item-description">2-10 cards horizontais</div>
                      </div>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AttachmentMenu;
