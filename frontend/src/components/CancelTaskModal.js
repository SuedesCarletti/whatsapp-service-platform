/**
 * CancelTaskModal — pedir a justificativa obrigatória antes de cancelar uma
 * tarefa (InternalTask). Mesmo padrão do PauseTaskModal.js (textarea +
 * botão desabilitado até ter texto) — cancelar sem motivo não é permitido
 * (o backend também recusa, ver cancel_internal_task em
 * routes_internal_chat.py), sem lembrete (não faz sentido lembrar de uma
 * tarefa que não vai acontecer).
 */
import React, { useState, useCallback } from 'react';
import { BsX, BsXCircle } from 'react-icons/bs';

const CancelTaskModal = ({ taskTitle, onClose, onConfirm }) => {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && !saving;

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setSaving(true);
    try {
      await onConfirm(trimmed);
    } catch {
      // erro já mostrado (alert) por quem chamou onConfirm — mantém o
      // modal aberto com o texto digitado pra tentar de novo.
    } finally {
      setSaving(false);
    }
  }, [canConfirm, onConfirm, trimmed]);

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
          <h3><BsXCircle style={{ verticalAlign: -3, marginRight: 6 }} /> Cancelar tarefa</h3>
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
            placeholder="Por que essa tarefa está sendo cancelada?"
          />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
            Ctrl+Enter para cancelar a tarefa
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Voltar</button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            style={{
              padding: '8px 16px', borderRadius: 6, border: '1px solid #e53e3e',
              background: '#e53e3e', color: '#fff', fontWeight: 600,
              opacity: canConfirm ? 1 : 0.6, cursor: canConfirm ? 'pointer' : 'default',
            }}
          >
            {saving ? 'Cancelando...' : 'Cancelar tarefa'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CancelTaskModal;
