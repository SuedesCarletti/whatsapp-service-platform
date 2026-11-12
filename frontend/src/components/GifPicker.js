/**
 * GifPicker — aba "GIFs" do mesmo popover de Emoji/Stickers (ver ChatArea.js).
 * Busca no Giphy (via proxy do backend, /api/giphy/*) com debounce; sem
 * busca digitada, mostra os GIFs em alta. Clicar num GIF manda na hora,
 * igual sticker.
 */
import React, { useEffect, useRef, useState } from 'react';
import apiService from '../services/api';

const GifPicker = ({ onSelectGif }) => {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sendingId, setSendingId] = useState(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    setLoading(true);
    setError(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = query.trim()
          ? await apiService.searchGifs(query.trim())
          : await apiService.trendingGifs();
        setGifs(results);
      } catch (err) {
        setError(err.response?.data?.detail || 'Não foi possível buscar GIFs.');
        setGifs([]);
      } finally {
        setLoading(false);
      }
    }, query.trim() ? 400 : 0);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const handleClick = async (gif) => {
    if (sendingId) return;
    setSendingId(gif.id);
    try {
      await onSelectGif(gif);
    } finally {
      setSendingId(null);
    }
  };

  return (
    <div style={{
      background: 'var(--bg-primary, #fff)', width: 320, height: 350,
      display: 'flex', flexDirection: 'column', borderRadius: '0 0 8px 8px',
    }}>
      <div style={{ padding: 8 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Buscar no Giphy..."
          autoFocus
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px',
            borderRadius: 8, border: '1px solid var(--border-color, #ccc)',
            background: 'var(--bg-secondary, #f5f5f5)', color: 'inherit', fontSize: 13,
          }}
        />
      </div>
      <div className="gif-picker-grid">
        {error && (
          <div className="gif-picker-empty">{error}</div>
        )}
        {!error && !loading && gifs.length === 0 && (
          <div className="gif-picker-empty">Nenhum GIF encontrado.</div>
        )}
        {gifs.map(gif => (
          <div
            key={gif.id}
            className="gif-picker-item"
            style={{
              cursor: sendingId ? 'default' : 'pointer',
              opacity: sendingId && sendingId !== gif.id ? 0.5 : 1,
            }}
            onClick={() => handleClick(gif)}
            title={gif.title || undefined}
          >
            <img src={gif.preview_url} alt="" loading="lazy" />
            {sendingId === gif.id && (
              <div className="gif-picker-item-sending">Enviando...</div>
            )}
          </div>
        ))}
      </div>
      <div style={{
        textAlign: 'center', fontSize: 10, color: 'var(--text-secondary, #888)',
        padding: '4px 0', borderTop: '1px solid var(--border-color, #eee)',
      }}>
        Powered by GIPHY
      </div>
    </div>
  );
};

export default GifPicker;
