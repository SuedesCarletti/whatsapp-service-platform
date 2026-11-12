/**
 * GroupCreator.js — Modal para criar grupos WhatsApp (Baileys only)
 */
import React, { useState } from 'react';
import { baileysApi } from '../services/api';

const GroupCreator = ({ accountId, onClose, onRefreshConversations }) => {
  const [mode, setMode] = useState('create'); // 'create' | 'join'
  const [subject, setSubject] = useState('');
  const [participantsText, setParticipantsText] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);

  const handleJoin = async () => {
    setError('');
    if (!inviteLink.trim()) { setError('Cole o link de convite do grupo.'); return; }
    setSending(true);
    try {
      const res = await baileysApi.groupJoinViaLink(inviteLink.trim(), accountId);
      setSuccess(res);
      setTimeout(() => onRefreshConversations?.(), 2000);
    } catch (e) {
      setError('Erro ao entrar no grupo: ' + (e?.response?.data?.detail || e.message || 'tente novamente'));
    } finally {
      setSending(false);
    }
  };

  const handleCreate = async () => {
    setError('');
    const participants = participantsText
      .split(/[\n,;]+/)
      .map(p => p.trim().replace(/\D/g, ''))
      .filter(p => p.length >= 8);

    if (!subject.trim()) { setError('Nome do grupo é obrigatório.'); return; }
    if (participants.length < 1) { setError('Adicione ao menos 1 participante.'); return; }

    setSending(true);
    try {
      const res = await baileysApi.groupCreate(subject.trim(), participants, accountId);
      setSuccess(res);
      // Recarrega lista de conversas para que o grupo apareça no sidebar
      setTimeout(() => onRefreshConversations?.(), 2000);
    } catch (e) {
      setError('Erro ao criar grupo: ' + (e?.response?.data?.detail || e.message || 'tente novamente'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={{ margin: 0 }}>👥 {mode === 'create' ? 'Criar Novo Grupo' : 'Entrar em Grupo'}</h3>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {!success && (
          <div style={styles.tabs}>
            <button
              style={mode === 'create' ? styles.tabActive : styles.tab}
              onClick={() => { setMode('create'); setError(''); }}
            >Criar novo</button>
            <button
              style={mode === 'join' ? styles.tabActive : styles.tab}
              onClick={() => { setMode('join'); setError(''); }}
            >Entrar via link</button>
          </div>
        )}

        <div style={styles.body}>
          {success ? (
            <div style={styles.successBox}>
              <div style={{ fontSize: 40, textAlign: 'center' }}>✅</div>
              <p style={{ textAlign: 'center', fontWeight: 600 }}>{mode === 'create' ? 'Grupo criado com sucesso!' : 'Você entrou no grupo!'}</p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary, #888)', textAlign: 'center' }}>
                O grupo aparecerá na lista de conversas em alguns segundos.<br/>
                Feche este modal e procure o grupo no sidebar.
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-secondary, #aaa)', textAlign: 'center', fontFamily: 'monospace' }}>
                {success.group_jid || success.id || ''}
              </p>
              <button style={styles.sendBtn} onClick={onClose}>Fechar</button>
            </div>
          ) : mode === 'create' ? (
            <>
              <label style={styles.label}>Nome do Grupo</label>
              <input
                style={styles.input}
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Ex: Família, Trabalho, Amigos..."
                maxLength={100}
              />

              <label style={styles.label}>Participantes</label>
              <p style={styles.hint}>
                Informe os números (com DDD e código do país) separados por linha, vírgula ou ponto-e-vírgula.<br />
                Ex: <code>5511999998888</code>
              </p>
              <textarea
                style={styles.textarea}
                value={participantsText}
                onChange={e => setParticipantsText(e.target.value)}
                placeholder={'5511999998888\n5521988887777\n5531977776666'}
                rows={5}
              />

              {error && <p style={styles.error}>{error}</p>}
            </>
          ) : (
            <>
              <label style={styles.label}>Link de convite</label>
              <p style={styles.hint}>Cole o link no formato <code>https://chat.whatsapp.com/XXXXXXXX</code></p>
              <input
                style={styles.input}
                value={inviteLink}
                onChange={e => setInviteLink(e.target.value)}
                placeholder="https://chat.whatsapp.com/..."
              />

              {error && <p style={styles.error}>{error}</p>}
            </>
          )}
        </div>

        {!success && (
          <div style={styles.footer}>
            <button style={styles.cancelBtn} onClick={onClose} disabled={sending}>Cancelar</button>
            <button style={styles.sendBtn} onClick={mode === 'create' ? handleCreate : handleJoin} disabled={sending}>
              {sending ? 'Enviando...' : (mode === 'create' ? 'Criar Grupo' : 'Entrar no Grupo')}
            </button>
          </div>
        )}
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
    background: 'var(--bg-primary, #fff)', borderRadius: 12, width: 440,
    maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '1px solid var(--border-color, #eee)',
  },
  body: { padding: '16px 20px', overflowY: 'auto', flex: 1 },
  tabs: { display: 'flex', gap: 4, padding: '10px 20px 0' },
  tab: {
    flex: 1, padding: '8px 0', background: 'none', border: 'none', borderBottom: '2px solid transparent',
    color: 'var(--text-secondary, #888)', cursor: 'pointer', fontWeight: 600, fontSize: 13,
  },
  tabActive: {
    flex: 1, padding: '8px 0', background: 'none', border: 'none', borderBottom: '2px solid #0EA5A4',
    color: '#0EA5A4', cursor: 'pointer', fontWeight: 600, fontSize: 13,
  },
  footer: {
    display: 'flex', gap: 8, justifyContent: 'flex-end',
    padding: '12px 20px', borderTop: '1px solid var(--border-color, #eee)',
  },
  label: { display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 13 },
  hint: { fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: -4, marginBottom: 8 },
  input: {
    width: '100%', padding: '8px 12px', borderRadius: 8,
    border: '1px solid var(--border-color, #ddd)', marginBottom: 14,
    background: 'var(--bg-secondary, #f5f5f5)', color: 'inherit',
    fontSize: 14, boxSizing: 'border-box',
  },
  textarea: {
    width: '100%', padding: '8px 12px', borderRadius: 8,
    border: '1px solid var(--border-color, #ddd)', marginBottom: 14,
    background: 'var(--bg-secondary, #f5f5f5)', color: 'inherit',
    fontSize: 13, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace',
  },
  closeBtn: {
    background: 'none', border: 'none', fontSize: 18, cursor: 'pointer',
    color: 'var(--text-secondary, #888)',
  },
  sendBtn: {
    background: '#0EA5A4', color: '#fff', border: 'none', borderRadius: 8,
    padding: '8px 20px', cursor: 'pointer', fontWeight: 600, width: '100%',
  },
  cancelBtn: {
    background: 'transparent', border: '1px solid var(--border-color, #ccc)',
    borderRadius: 8, padding: '8px 16px', cursor: 'pointer',
  },
  error: { color: '#e74c3c', fontSize: 13, marginTop: -8 },
  successBox: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', padding: '20px 0' },
};

export default GroupCreator;
