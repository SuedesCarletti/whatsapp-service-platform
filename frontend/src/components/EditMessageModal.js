/**
 * EditMessageModal — edição de mensagem já enviada no WhatsApp (Baileys/
 * WPPConnect/whatsapp-web.js, ver ADVANCED_API_PROVIDERS no App.js). Antes
 * disso era um window.prompt: cortava mensagens longas, não deixava ver o
 * texto inteiro nem digitar quebra de linha (Enter confirmava o prompt) e
 * não tinha como inserir emoji. Aqui é um textarea de verdade num modal,
 * reaproveitando o EmojiPicker (emoji-picker-react) já usado no composer.
 */
import React, { useState, useRef, useCallback } from 'react';
import { BsX, BsPencil, BsEmojiSmile } from 'react-icons/bs';
import EmojiPicker from 'emoji-picker-react';
import { EMOJI_CATEGORIES_PT, EMOJI_SEARCH_PLACEHOLDER_PT, EMOJI_SEARCH_CLEAR_LABEL_PT, EMOJI_DATA_PT } from '../utils/emojiPickerLocale';

const EditMessageModal = ({ message, theme, onClose, onSave }) => {
  const originalText = message?.message || message?.message_text || '';
  const [text, setText] = useState(originalText);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  const trimmed = text.trim();
  const canSave = trimmed.length > 0 && trimmed !== originalText.trim() && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(text);
    } catch {
      // erro já mostrado (alert) por quem chamou onSave — mantém o modal
      // aberto com o texto digitado pra tentar de novo.
    } finally {
      setSaving(false);
    }
  }, [canSave, onSave, text]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const handleEmojiClick = (emojiData) => {
    const emoji = emojiData.emoji;
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const newText = text.slice(0, start) + emoji + text.slice(end);
      setText(newText);
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(start + emoji.length, start + emoji.length);
      }, 0);
    } else {
      setText(prev => prev + emoji);
    }
    setShowEmojiPicker(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480, position: 'relative', overflow: 'visible' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><BsPencil style={{ verticalAlign: -3, marginRight: 6 }} /> Editar mensagem</h3>
          <button className="modal-close" onClick={onClose}><BsX size={22} /></button>
        </div>

        <div className="modal-body" style={{ padding: '18px 20px' }}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            rows={6}
            style={{ width: '100%', resize: 'vertical', minHeight: 120, lineHeight: 1.4, fontSize: 14 }}
            placeholder="Digite a nova mensagem..."
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <button
              type="button"
              className="icon-button"
              title="Emoji"
              onClick={() => setShowEmojiPicker(v => !v)}
            >
              <BsEmojiSmile size={20} />
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Ctrl+Enter para salvar
            </span>
          </div>
        </div>

        {/* Fora do .modal-body de propósito — ele tem overflow-y:auto, e um
            popover position:absolute dentro de um ancestral com overflow
            auto/hidden fica cortado nas bordas dele (era o bug: a barra do
            picker entrava cortada pra dentro do modal). Ancorado no .modal
            (que não tem overflow), fica livre por cima do footer. */}
        {showEmojiPicker && (
          <div style={{ position: 'absolute', bottom: '64px', left: '20px', zIndex: 1000 }}>
            <EmojiPicker
              onEmojiClick={handleEmojiClick}
              searchDisabled={false}
              height={350}
              width={320}
              theme={theme === 'dark' ? 'dark' : 'light'}
              categories={EMOJI_CATEGORIES_PT}
              emojiData={EMOJI_DATA_PT}
              searchPlaceholder={EMOJI_SEARCH_PLACEHOLDER_PT}
              searchClearButtonLabel={EMOJI_SEARCH_CLEAR_LABEL_PT}
            />
          </div>
        )}

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn-primary" onClick={handleSave} disabled={!canSave}>
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EditMessageModal;
