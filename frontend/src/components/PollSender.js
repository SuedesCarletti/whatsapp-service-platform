/**
 * PollSender.js — Modal para enviar enquetes (Baileys only)
 */
import React, { useState } from 'react';
import { baileysApi } from '../services/api';
import { getRecipientJid } from '../utils/recipient';

const PollSender = ({ conversation, accountId, onClose, onSent }) => {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [selectableCount, setSelectableCount] = useState(1);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const to = getRecipientJid(conversation);

  const updateOption = (i, val) =>
    setOptions(prev => prev.map((o, idx) => (idx === i ? val : o)));

  const addOption = () => {
    if (options.length < 12) setOptions(prev => [...prev, '']);
  };

  const removeOption = (i) => {
    if (options.length > 2) setOptions(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleSend = async () => {
    const filled = options.filter(o => o.trim());
    if (!question.trim()) { setError('Pergunta obrigatória.'); return; }
    if (filled.length < 2) { setError('Mínimo 2 opções.'); return; }
    if (!to) { setError('Destinatário não encontrado.'); return; }
    setSending(true);
    setError('');
    try {
      await baileysApi.sendPoll(to, question.trim(), filled, selectableCount, accountId);
      onSent?.();
      onClose();
    } catch (e) {
      setError('Erro ao enviar enquete: ' + (e.message || 'tente novamente'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={{ margin: 0 }}>📊 Criar Enquete</h3>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.body}>
          <label style={styles.label}>Pergunta</label>
          <input
            style={styles.input}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="Digite a pergunta..."
            maxLength={255}
          />

          <label style={styles.label}>Opções</label>
          {options.map((opt, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                style={{ ...styles.input, flex: 1, marginBottom: 0 }}
                value={opt}
                onChange={e => updateOption(i, e.target.value)}
                placeholder={`Opção ${i + 1}`}
                maxLength={100}
              />
              {options.length > 2 && (
                <button style={styles.removeBtn} onClick={() => removeOption(i)}>✕</button>
              )}
            </div>
          ))}
          {options.length < 12 && (
            <button style={styles.addBtn} onClick={addOption}>+ Adicionar opção</button>
          )}

          <label style={styles.label}>Respostas permitidas por pessoa</label>
          <select
            style={styles.input}
            value={selectableCount}
            onChange={e => setSelectableCount(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>

          {error && <p style={styles.error}>{error}</p>}
        </div>

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose} disabled={sending}>Cancelar</button>
          <button style={styles.sendBtn} onClick={handleSend} disabled={sending}>
            {sending ? 'Enviando...' : 'Enviar Enquete'}
          </button>
        </div>
      </div>
    </div>
  );
};

const styles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-primary, #fff)', borderRadius: 12, width: 420,
    maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '1px solid var(--border-color, #eee)',
  },
  body: { padding: '16px 20px', overflowY: 'auto', flex: 1 },
  footer: {
    display: 'flex', gap: 8, justifyContent: 'flex-end',
    padding: '12px 20px', borderTop: '1px solid var(--border-color, #eee)',
  },
  label: { display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 13 },
  input: {
    width: '100%', padding: '8px 12px', borderRadius: 8,
    border: '1px solid var(--border-color, #ddd)', marginBottom: 14,
    background: 'var(--bg-secondary, #f5f5f5)', color: 'inherit',
    fontSize: 14, boxSizing: 'border-box',
  },
  closeBtn: {
    background: 'none', border: 'none', fontSize: 18, cursor: 'pointer',
    color: 'var(--text-secondary, #888)',
  },
  removeBtn: {
    background: '#ff4d4d', color: '#fff', border: 'none', borderRadius: 6,
    padding: '0 10px', cursor: 'pointer',
  },
  addBtn: {
    background: 'none', border: '1px dashed var(--border-color, #ccc)',
    borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
    color: 'var(--text-secondary, #666)', marginBottom: 14, width: '100%',
  },
  sendBtn: {
    background: '#0EA5A4', color: '#fff', border: 'none', borderRadius: 8,
    padding: '8px 20px', cursor: 'pointer', fontWeight: 600,
  },
  cancelBtn: {
    background: 'transparent', border: '1px solid var(--border-color, #ccc)',
    borderRadius: 8, padding: '8px 16px', cursor: 'pointer',
  },
  error: { color: '#e74c3c', fontSize: 13, marginTop: -8 },
};

export default PollSender;
