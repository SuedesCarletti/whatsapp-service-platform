import React, { useState, useEffect } from 'react';
import { MdClose, MdChat } from 'react-icons/md';
import { baileysApi } from '../services/api';
import { limitAvatarFetch } from '../utils/avatarFetchLimiter';

const formatPhoneDisplay = (phone) => {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55'))
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55'))
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length >= 8) return `+${d}`;
  return phone;
};

// jid: JID de telefone do participante (ex: 5544...@s.whatsapp.net)
// name: nome salvo na agenda (contact_name vindo do backend) — null se não salvo
const ParticipantInfoModal = ({ jid, phoneNumber, name, accountId, onClose, onOpenChat }) => {
  const [photoUrl, setPhotoUrl] = useState(null);
  const [about, setAbout] = useState(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPhotoUrl(null);
    setAbout(null);
    if (!jid) return;
    // Incidente 2026-09-11: essa busca (e as de GroupManager.js/
    // ContactInfoPanel.js) não passava pelo limitAvatarFetch já usado em
    // Sidebar.js/ChatArea.js — ver comentário completo em GroupManager.js.
    limitAvatarFetch(() => baileysApi.getProfilePicture(jid, false, accountId))
      .then(res => {
        if (!cancelled && res?.url) setPhotoUrl(res.url);
      })
      .catch(() => {});
    baileysApi.getUserStatus(jid, accountId)
      .then(res => {
        if (!cancelled && res?.status) setAbout(res.status);
      })
      .catch(() => { /* contato pode não ter recado público */ });
    return () => { cancelled = true; };
  }, [jid, accountId]);

  const displayPhone = formatPhoneDisplay(phoneNumber);
  const isSaved = !!name;

  const handleOpenChat = async () => {
    if (!phoneNumber || opening) return;
    setOpening(true);
    try {
      await onOpenChat(phoneNumber, name);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <button style={styles.closeBtn} onClick={onClose}>
          <MdClose size={22} />
        </button>

        <div style={styles.avatar}>
          {photoUrl ? (
            <img src={photoUrl} alt="" style={styles.avatarImg} />
          ) : (
            <span>{(isSaved ? name : displayPhone || '?').charAt(0).toUpperCase()}</span>
          )}
        </div>

        {isSaved && <div style={styles.name}>{name}</div>}
        <div style={isSaved ? styles.phoneSecondary : styles.phonePrimary}>
          {displayPhone || 'Número desconhecido'}
        </div>
        {about && <div style={styles.about}>{about}</div>}

        <button style={styles.openChatBtn} onClick={handleOpenChat} disabled={!phoneNumber || opening}>
          <MdChat size={18} />
          {opening ? 'Abrindo...' : 'Abrir conversa'}
        </button>
      </div>
    </div>
  );
};

const styles = {
  overlay: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-primary, #fff)', color: 'inherit', borderRadius: 12,
    width: 320, maxWidth: '90%', padding: '28px 20px 20px',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    boxShadow: '0 4px 20px rgba(0,0,0,0.2)', position: 'relative',
  },
  closeBtn: {
    position: 'absolute', top: 10, right: 10,
    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #888)',
  },
  avatar: {
    width: 88, height: 88, borderRadius: '50%', background: 'rgb(37, 211, 102)',
    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 32, fontWeight: 600, overflow: 'hidden', marginBottom: 8,
  },
  avatarImg: { width: '100%', height: '100%', objectFit: 'cover' },
  name: { fontSize: 18, fontWeight: 600, textAlign: 'center' },
  phonePrimary: { fontSize: 18, fontWeight: 600, textAlign: 'center' },
  phoneSecondary: { fontSize: 14, color: 'var(--text-secondary, #888)', textAlign: 'center' },
  about: { fontSize: 13, color: 'var(--text-secondary, #888)', textAlign: 'center', marginTop: 4, fontStyle: 'italic' },
  openChatBtn: {
    marginTop: 16, display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgb(37, 211, 102)', color: '#fff', border: 'none',
    borderRadius: 24, padding: '10px 20px', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', width: '100%', justifyContent: 'center',
  },
};

export default ParticipantInfoModal;
