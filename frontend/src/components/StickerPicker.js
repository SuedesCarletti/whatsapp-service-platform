/**
 * StickerPicker — popover com a galeria pessoal de stickers salvos, ao lado
 * do emoji no composer (igual ao WhatsApp Web: emoji e sticker no mesmo
 * lugar). Clicar num sticker manda na hora; "+" converte uma imagem própria
 * em sticker novo (Pillow no backend) e já guarda na galeria.
 */
import React, { useRef, useState } from 'react';
import { BsPlusLg, BsX } from 'react-icons/bs';
import apiService from '../services/api';

const StickerPicker = ({ stickers, onSelectSticker, onStickerCreated, onDeleteSticker }) => {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const convertRes = await apiService.convertToSticker(file);
      if (!convertRes?.data) {
        alert(convertRes?.message || 'Não foi possível converter essa imagem em sticker.');
        return;
      }
      const saveRes = await apiService.saveSticker(convertRes.data.media_url, convertRes.data.mime_type);
      if (saveRes?.data) onStickerCreated(saveRes.data);
    } catch (err) {
      alert(err.response?.data?.detail || 'Erro ao criar sticker.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{
      background: 'var(--bg-primary, #fff)', width: 320, height: 350,
      display: 'flex', flexDirection: 'column', borderRadius: '0 0 8px 8px',
    }}>
      <div className="sticker-picker-grid">
        <button
          className="sticker-picker-add-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Criar sticker a partir de uma imagem"
        >
          {uploading ? '…' : <BsPlusLg size={20} />}
        </button>
        {stickers.map(s => (
          <div key={s.id} className="sticker-picker-item">
            <img
              src={s.media_url}
              alt=""
              onClick={() => onSelectSticker(s)}
            />
            <span
              className="sticker-picker-remove-btn"
              onClick={(e) => { e.stopPropagation(); onDeleteSticker(s.id); }}
              title="Remover da galeria"
            >
              <BsX size={12} />
            </span>
          </div>
        ))}
        {stickers.length === 0 && (
          <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--text-secondary, #888)', padding: '8px 2px' }}>
            Nenhum sticker salvo ainda. Clique em "+" pra criar um, ou salve um que alguém te mandar.
          </div>
        )}
      </div>
      <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileChange} />
    </div>
  );
};

export default StickerPicker;
