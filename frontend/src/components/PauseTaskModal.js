/**
 * PauseTaskModal — pedir a justificativa obrigatória antes de pausar uma
 * tarefa (InternalTask). Mesmo padrão de "textarea + botão desabilitado até
 * ter texto" do EditMessageModal.js — pausar sem motivo não é permitido
 * (o backend também recusa, ver pause_internal_task em
 * routes_internal_chat.py), então o botão Pausar só habilita com texto.
 */
import React, { useState, useCallback } from 'react';
import { BsX, BsPauseFill } from 'react-icons/bs';

const PauseTaskModal = ({ taskTitle, onClose, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [reminderAt, setReminderAt] = useState('');
  const [saving, setSaving] = useState(false);

  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && !saving;

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setSaving(true);
    try {
      await onConfirm(trimmed, reminderAt ? new Date(reminderAt).toISOString() : undefined);
    } catch {
      // erro já mostrado (alert) por quem chamou onConfirm — mantém o
      // modal aberto com o texto digitado pra tentar de novo.
    } finally {
      setSaving(false);
    }
  }, [canConfirm, onConfirm, trimmed, reminderAt]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3><BsPauseFill style={{ verticalAlign: -3, marginRight: 6 }} /> Pausar tarefa</h3>
          <button className="modal-close" onClick={onClose}><BsX size={22} /></button>
        </div>

        <div className="modal-body" style={{ padding: '18px 20px' }}>
          {taskTitle && (
            <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 10 }}>
              "{taskTitle}"
            </div>
          )}
          <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', marginBottom: 6 }}>
            Justificativa (obrigatória)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            rows={4}
            style={{ width: '100%', resize: 'vertical', minHeight: 90, lineHeight: 1.4, fontSize: 14 }}
            placeholder="Por que essa tarefa está sendo pausada?"
          />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
            Ctrl+Enter para pausar
          </div>

          <label style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, display: 'block', margin: '14px 0 6px' }}>
            Lembrar-me em (opcional)
          </label>
          <input
            type="datetime-local"
            value={reminderAt}
            onChange={(e) => setReminderAt(e.target.value)}
            style={{ width: '100%' }}
          />
          <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 4 }}>
            Nessa data um aviso aparece na conversa pra não esquecer a tarefa pausada.
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn-primary" onClick={handleConfirm} disabled={!canConfirm}>
            {saving ? 'Pausando...' : 'Pausar tarefa'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PauseTaskModal;
