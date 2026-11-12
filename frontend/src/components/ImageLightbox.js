/**
 * ImageLightbox — visualização em tela cheia de uma imagem/vídeo de
 * mensagem, dentro do próprio app (igual ao comportamento real do
 * WhatsApp Web ao clicar numa foto). Reutilizado por ChatArea.js (clientes)
 * e InternalChatArea.js (equipe) — antes, clicar na imagem da mensagem não
 * fazia nada em Clientes, e em Equipe abria numa aba nova do navegador
 * (sujeito a bloqueio de pop-up e sem o "clique fora fecha" esperado).
 */
import React, { useEffect } from 'react';
import { MdClose, MdDownload } from 'react-icons/md';
import useImageZoom from '../utils/useImageZoom';

const ImageLightbox = ({ src, type = 'image', onClose }) => {
  const { isZoomed, containerHandlers, mediaStyle } = useImageZoom(src);

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!src) return null;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <button style={styles.closeBtn} onClick={onClose} title="Fechar (Esc)">
        <MdClose size={26} />
      </button>
      <a
        href={src}
        download
        target="_blank"
        rel="noopener noreferrer"
        style={styles.downloadBtn}
        onClick={(e) => e.stopPropagation()}
        title="Baixar"
      >
        <MdDownload size={22} />
      </a>
      <div
        style={styles.content}
        onClick={(e) => e.stopPropagation()}
        {...(type === 'video' ? {} : containerHandlers)}
      >
        {type === 'video' ? (
          <video src={src} controls autoPlay style={styles.media} />
        ) : (
          <img
            src={src}
            alt=""
            draggable={false}
            style={{ ...styles.media, ...mediaStyle }}
            title={isZoomed ? 'Arraste para navegar · duplo clique para restaurar' : 'Role para ampliar'}
          />
        )}
      </div>
    </div>
  );
};

const styles = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2000, cursor: 'zoom-out', overflow: 'hidden',
  },
  content: {
    maxWidth: '92vw', maxHeight: '92vh', cursor: 'default',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  media: {
    maxWidth: '92vw', maxHeight: '92vh', borderRadius: 4,
    boxShadow: '0 8px 40px rgba(0,0,0,0.5)', objectFit: 'contain',
  },
  closeBtn: {
    position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,0.12)',
    border: 'none', borderRadius: '50%', width: 40, height: 40,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', cursor: 'pointer', zIndex: 1,
  },
  downloadBtn: {
    position: 'absolute', top: 16, right: 66, background: 'rgba(255,255,255,0.12)',
    border: 'none', borderRadius: '50%', width: 40, height: 40,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', cursor: 'pointer', zIndex: 1, textDecoration: 'none',
  },
};

export default ImageLightbox;
