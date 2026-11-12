/**
 * BaileysProfilePanel.js — Perfil, privacidade e bloqueados da conta Baileys.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { MdClose } from 'react-icons/md';
import { baileysApi } from '../services/api';

const PRIVACY_LABELS = {
  last: 'Visto por último',
  online: 'Status online',
  profile: 'Foto de perfil',
  status: 'Recado (status)',
  readreceipts: 'Confirmação de leitura',
  groupadd: 'Quem pode me adicionar em grupos',
};

const BaileysProfilePanel = ({ accountId, onClose }) => {
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [imageB64, setImageB64] = useState(null);
  const [privacy, setPrivacy] = useState(null);
  const [blocklist, setBlocklist] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const flash = (text) => { setMsg(text); setTimeout(() => setMsg(''), 3000); };

  const loadAll = useCallback(async () => {
    try {
      const priv = await baileysApi.getPrivacySettings(accountId);
      setPrivacy(priv?.settings || priv || {});
    } catch (e) { console.warn('Falha ao carregar privacidade:', e); }
    try {
      const bl = await baileysApi.getBlocklist(accountId);
      setBlocklist(bl?.blocklist || bl?.jids || []);
    } catch (e) { console.warn('Falha ao carregar bloqueados:', e); }
  }, [accountId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const run = async (fn, successMsg) => {
    setBusy(true);
    try {
      const res = await fn();
      // Papel marcado 'require_approval' — a ação não foi aplicada na hora,
      // ficou na fila de aprovação de um admin (ver AdminPanel → Aprovações).
      flash(res?.pending ? '⏳ Enviado para aprovação de um admin.' : successMsg);
    } catch (e) {
      flash('Erro: ' + (e?.response?.data?.detail || e.message || 'tente novamente'));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveName = () => name.trim() && run(() => baileysApi.updateProfileName(name.trim(), accountId), 'Nome atualizado.');
  const handleSaveStatus = () => run(() => baileysApi.updateStatus(status, accountId), 'Recado atualizado.');

  const handlePickPhoto = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => setImageB64(reader.result.split(',')[1] || '');
    reader.readAsDataURL(file);
  };

  const handleSavePhoto = () => imageB64 && run(() => baileysApi.updateProfilePicture(imageB64, accountId), 'Foto de perfil atualizada.');
  const handleRemovePhoto = () => run(() => baileysApi.removeProfilePicture(accountId), 'Foto de perfil removida.');

  const handlePrivacyChange = (setting, value) => {
    setPrivacy(prev => ({ ...prev, [setting]: value }));
    run(() => baileysApi.updatePrivacySetting(setting, value, accountId), 'Privacidade atualizada.');
  };

  const handleUnblock = (jid) =>
    run(() => baileysApi.unblockContact(jid, accountId), 'Contato desbloqueado.').then(() =>
      setBlocklist(prev => prev.filter(j => j !== jid))
    );

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>👤 Perfil da conta</div>
          <button style={styles.iconBtn} onClick={onClose}><MdClose size={20} /></button>
        </div>

        {msg && <div style={styles.flashMsg}>{msg}</div>}

        <div style={styles.body}>
          <div style={styles.section}>
            <div style={styles.sectionTitle}>Foto de perfil</div>
            <input type="file" accept="image/*" onChange={handlePickPhoto} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button style={styles.addBtn} onClick={handleSavePhoto} disabled={busy || !imageB64}>Atualizar foto</button>
              <button style={styles.dangerBtn} onClick={handleRemovePhoto} disabled={busy}>Remover foto</button>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Nome de exibição</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...styles.input, flex: 1 }} value={name} onChange={e => setName(e.target.value)} placeholder="Seu nome no WhatsApp" />
              <button style={styles.addBtn} onClick={handleSaveName} disabled={busy}>Salvar</button>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Recado (status)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...styles.input, flex: 1 }} value={status} onChange={e => setStatus(e.target.value)} placeholder="Disponível" />
              <button style={styles.addBtn} onClick={handleSaveStatus} disabled={busy}>Salvar</button>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Privacidade</div>
            {privacy === null ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary, #888)' }}>Carregando...</div>
            ) : Object.keys(PRIVACY_LABELS).map(key => (
              <div key={key} style={styles.toggleRow}>
                <div style={{ fontSize: 13 }}>{PRIVACY_LABELS[key]}</div>
                <select
                  style={styles.select}
                  value={privacy[key] || 'all'}
                  onChange={e => handlePrivacyChange(key, e.target.value)}
                  disabled={busy}
                >
                  <option value="all">Todos</option>
                  <option value="contacts">Meus contatos</option>
                  <option value="contact_blacklist">Contatos, exceto...</option>
                  <option value="none">Ninguém</option>
                </select>
              </div>
            ))}
          </div>

          <div style={styles.section}>
            <div style={styles.sectionTitle}>Contatos bloqueados</div>
            {blocklist.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary, #888)' }}>Nenhum contato bloqueado.</div>
            ) : blocklist.map(jid => (
              <div key={jid} style={styles.toggleRow}>
                <div style={{ fontSize: 13 }}>{String(jid).split('@')[0]}</div>
                <button style={styles.dangerBtn} onClick={() => handleUnblock(jid)} disabled={busy}>Desbloquear</button>
              </div>
            ))}
          </div>
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
    background: 'var(--bg-primary, #fff)', borderRadius: 12, width: 460,
    maxHeight: '85vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 18px', borderBottom: '1px solid var(--border-color, #eee)',
  },
  iconBtn: { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #888)', display: 'flex' },
  body: { flex: 1, overflowY: 'auto', padding: '12px 18px' },
  flashMsg: { background: '#0EA5A4', color: '#fff', padding: '8px 18px', fontSize: 13 },
  section: { marginBottom: 18 },
  sectionTitle: { fontWeight: 700, fontSize: 13, marginBottom: 8, color: 'var(--text-secondary, #666)' },
  input: {
    padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-color, #ddd)',
    background: 'var(--bg-secondary, #f5f5f5)', color: 'inherit', fontSize: 13,
  },
  select: {
    padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border-color, #ddd)',
    background: 'var(--bg-secondary, #f5f5f5)', color: 'inherit', fontSize: 12,
  },
  addBtn: { background: '#0EA5A4', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' },
  dangerBtn: { background: 'transparent', border: '1px solid #e74c3c', color: '#e74c3c', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 12 },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-color, #f0f0f0)' },
};

export default BaileysProfilePanel;
