/**
 * MediaGallery.js — Galeria de mídias de uma conversa
 */
import React, { useState } from 'react';
import { MdClose, MdImage, MdVideoLibrary, MdAudiotrack, MdDescription, MdDownload, MdArrowBack } from 'react-icons/md';
import moment from 'moment';
import 'moment/locale/pt-br';
import VoiceMessagePlayer from './VoiceMessagePlayer';
import useImageZoom from '../utils/useImageZoom';

moment.locale('pt-br');

const TABS = [
  { key: 'image', label: 'Imagens', icon: <MdImage size={18} /> },
  { key: 'video', label: 'Vídeos', icon: <MdVideoLibrary size={18} /> },
  { key: 'audio', label: 'Áudios', icon: <MdAudiotrack size={18} /> },
  { key: 'document', label: 'Docs', icon: <MdDescription size={18} /> },
];

const MediaGallery = ({ messages = [], onClose }) => {
  const [activeTab, setActiveTab] = useState('image');
  const [lightbox, setLightbox] = useState(null);
  const { isZoomed: zoomIsZoomed, containerHandlers: zoomHandlers, mediaStyle: zoomMediaStyle } = useImageZoom(lightbox?.mediaUrl);

  const mediaMessages = messages.filter(m => m.mediaUrl && TABS.some(t => t.key === m.type));

  const filtered = mediaMessages.filter(m => m.type === activeTab);

  const counts = Object.fromEntries(TABS.map(t => [t.key, mediaMessages.filter(m => m.type === t.key).length]));

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          {lightbox ? (
            <button style={styles.iconBtn} onClick={() => setLightbox(null)}>
              <MdArrowBack size={22} />
            </button>
          ) : (
            <span style={{ fontWeight: 700, fontSize: 16 }}>Mídia Compartilhada</span>
          )}
          <button style={styles.iconBtn} onClick={onClose}><MdClose size={22} /></button>
        </div>

        {/* Lightbox */}
        {lightbox ? (
          <div style={styles.lightboxArea}>
            {lightbox.type === 'image' && (
              <div style={styles.lightboxImgFrame} {...zoomHandlers}>
                <img
                  src={lightbox.mediaUrl}
                  alt=""
                  draggable={false}
                  style={{ ...styles.lightboxImg, ...zoomMediaStyle }}
                  title={zoomIsZoomed ? 'Arraste para navegar · duplo clique para restaurar' : 'Role para ampliar'}
                />
              </div>
            )}
            {lightbox.type === 'video' && (
              <video src={lightbox.mediaUrl} controls style={styles.lightboxImg} />
            )}
            <div style={styles.lightboxMeta}>
              <span>{moment(lightbox.timestamp).format('DD MMM YYYY, HH:mm')}</span>
              <a href={lightbox.mediaUrl} download target="_blank" rel="noopener noreferrer" style={styles.downloadLink}>
                <MdDownload size={18} /> Baixar
              </a>
            </div>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div style={styles.tabs}>
              {TABS.map(t => (
                <button
                  key={t.key}
                  style={{ ...styles.tab, ...(activeTab === t.key ? styles.tabActive : {}) }}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.icon}
                  <span style={{ marginLeft: 4 }}>{t.label}</span>
                  {counts[t.key] > 0 && <span style={styles.badge}>{counts[t.key]}</span>}
                </button>
              ))}
            </div>

            {/* Grid */}
            <div style={styles.grid}>
              {filtered.length === 0 ? (
                <div style={styles.empty}>Nenhuma mídia deste tipo nesta conversa.</div>
              ) : filtered.map((msg, i) => (
                <div
                  key={msg.wamid || i}
                  style={styles.cell}
                  onClick={() => (msg.type === 'image' || msg.type === 'video') ? setLightbox(msg) : null}
                  title={moment(msg.timestamp).format('DD/MM/YYYY HH:mm')}
                >
                  {msg.type === 'image' && (
                    <img src={msg.mediaUrl} alt="" style={styles.thumb} onError={e => { e.target.style.display='none'; }} />
                  )}
                  {msg.type === 'video' && (
                    <div style={styles.videoThumb}>
                      <MdVideoLibrary size={36} color="#fff" />
                    </div>
                  )}
                  {msg.type === 'audio' && (
                    <div style={styles.audioThumb}>
                      <MdAudiotrack size={28} />
                      <VoiceMessagePlayer src={msg.mediaUrl} seed={msg.id} style={{ width: '100%', marginTop: 4 }} />
                    </div>
                  )}
                  {msg.type === 'document' && (
                    <a href={msg.mediaUrl} download target="_blank" rel="noopener noreferrer" style={styles.docThumb}>
                      <MdDescription size={32} color="var(--text-secondary, #888)" />
                      <span style={styles.docName}>{msg.filename || 'Documento'}</span>
                      <MdDownload size={16} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const styles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-primary, #fff)', borderRadius: 12, width: 520,
    maxHeight: '85vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 18px', borderBottom: '1px solid var(--border-color, #eee)',
  },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--text-secondary, #888)', display: 'flex', alignItems: 'center',
  },
  tabs: {
    display: 'flex', gap: 0,
    borderBottom: '1px solid var(--border-color, #eee)',
    overflowX: 'auto',
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '10px 16px', background: 'none', border: 'none',
    cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary, #888)',
    borderBottom: '2px solid transparent', whiteSpace: 'nowrap',
  },
  tabActive: {
    color: '#0EA5A4', borderBottom: '2px solid #0EA5A4', fontWeight: 600,
  },
  badge: {
    background: '#0EA5A4', color: '#fff', borderRadius: 10,
    fontSize: 11, padding: '1px 5px', marginLeft: 4,
  },
  grid: {
    display: 'flex', flexWrap: 'wrap', gap: 4, padding: 12,
    overflowY: 'auto', flex: 1,
  },
  cell: {
    width: 110, height: 110, borderRadius: 8, overflow: 'hidden',
    background: 'var(--bg-secondary, #f0f0f0)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  thumb: { width: '100%', height: '100%', objectFit: 'cover' },
  videoThumb: {
    width: '100%', height: '100%', background: '#1a1a2e',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  audioThumb: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: 8, width: '100%',
  },
  docThumb: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 4, padding: 8, textDecoration: 'none', color: 'inherit', width: '100%',
  },
  docName: {
    fontSize: 11, textAlign: 'center', wordBreak: 'break-word',
    maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  empty: {
    width: '100%', padding: '40px 0', textAlign: 'center',
    color: 'var(--text-secondary, #888)', fontSize: 14,
  },
  lightboxArea: {
    flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12,
    overflowY: 'auto',
  },
  lightboxImgFrame: {
    maxWidth: '100%', maxHeight: '60vh', overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  lightboxImg: { maxWidth: '100%', maxHeight: '60vh', borderRadius: 8 },
  lightboxMeta: {
    display: 'flex', gap: 16, alignItems: 'center', fontSize: 13,
    color: 'var(--text-secondary, #888)',
  },
  downloadLink: {
    display: 'flex', alignItems: 'center', gap: 4,
    color: '#0EA5A4', textDecoration: 'none', fontWeight: 600,
  },
};

export default MediaGallery;
