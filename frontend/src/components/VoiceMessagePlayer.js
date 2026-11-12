/**
 * VoiceMessagePlayer — player de áudio estilo WhatsApp: botão play/pause +
 * forma de onda (barrinhas) + contador de tempo. Substitui o <audio controls>
 * nativo do navegador nas bolhas de mensagem de áudio.
 *
 * Não existe dado de amplitude real vindo do backend (Message não tem coluna
 * de waveform) nem lib de visualização no projeto — as barras são uma altura
 * pseudo-aleatória DETERMINÍSTICA por mensagem (seed fixa), só pra dar a
 * mesma leitura visual do WhatsApp; não representam o áudio de verdade.
 * Duração/tempo tocado são lidos direto do elemento <audio> (loadedmetadata/
 * timeupdate), 100% client-side.
 */
import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { BsPlayFill, BsPauseFill } from 'react-icons/bs';

const BAR_COUNT = 40;
const SPEEDS = [1, 1.5, 2];
const SPEED_STORAGE_KEY = 'voicePlayerSpeed';

// Velocidade escolhida fica salva no localStorage e vale pro próximo áudio
// tocado também — mesmo comportamento do WhatsApp (a velocidade "gruda"
// entre mensagens de voz, não é por mensagem).
function getStoredSpeed() {
  try {
    const raw = parseFloat(localStorage.getItem(SPEED_STORAGE_KEY));
    return SPEEDS.includes(raw) ? raw : 1;
  } catch {
    return 1;
  }
}

// PRNG simples e determinístico (mulberry32) — mesma seed sempre gera a
// mesma sequência, então a forma de onda de uma mensagem não muda a cada
// re-render.
function seededBars(seed, count) {
  let s = 0;
  const str = String(seed || 'x');
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  const raw = [];
  for (let i = 0; i < count; i++) {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    raw.push(((t ^ (t >>> 14)) >>> 0) / 4294967296); // 0..1
  }
  // Ruído puro (cada barra 100% independente da vizinha) fica com cara de
  // estática, não de forma de onda de áudio real — passa por um suavizador
  // de média móvel (3 janelas) pra virar uma curva ondulada coerente, mais
  // parecida com o fallback do próprio WhatsApp quando não tem amplitude
  // real calculada.
  let smoothed = raw;
  for (let pass = 0; pass < 3; pass++) {
    const current = smoothed;
    smoothed = current.map((v, i) => {
      const prev = current[i - 1] ?? v;
      const next = current[i + 1] ?? v;
      return (prev + v * 2 + next) / 4;
    });
  }
  const min = Math.min(...smoothed);
  const max = Math.max(...smoothed);
  const range = max - min || 1;
  return smoothed.map(v => 0.2 + ((v - min) / range) * 0.8); // normaliza pra usar toda a faixa 20%-100%
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Bug conhecido do Chrome (e derivados): pra alguns áudios sem duração
// definida no cabeçalho do container — comum em .ogg/opus do WhatsApp — o
// <audio>.duration vem Infinity/NaN logo no loadedmetadata, e só fica certo
// depois de forçar um seek pro "fim". Sem isso a duração ficava sempre
// "0:00" (formatTime já rejeitava Infinity/NaN de propósito, então o bug
// não quebrava a UI, só escondia o valor real). Workaround padrão: manda
// currentTime pra um valor absurdo, espera o primeiro timeupdate (que só
// dispara depois do valor real ficar disponível), lê duration de novo e
// volta o currentTime pra 0.
function fixInfiniteDuration(el, onFixed) {
  const handle = () => {
    el.removeEventListener('timeupdate', handle);
    el.currentTime = 0;
    onFixed(Number.isFinite(el.duration) ? el.duration : 0);
  };
  el.addEventListener('timeupdate', handle);
  el.currentTime = 1e101;
}

const VoiceMessagePlayer = ({ src, seed, style }) => {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(getStoredSpeed);

  const bars = useMemo(() => seededBars(seed, BAR_COUNT), [seed]);
  const progress = duration > 0 ? currentTime / duration : 0;

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = speed;
  }, [speed]);

  const cycleSpeed = useCallback((e) => {
    e.stopPropagation();
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    try { localStorage.setItem(SPEED_STORAGE_KEY, String(next)); } catch {}
  }, [speed]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (isPlaying) el.pause();
    else el.play().catch(() => {});
  }, [isPlaying]);

  const seekToRatio = useCallback((ratio) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const clamped = Math.max(0, Math.min(1, ratio)) * duration;
    el.currentTime = clamped;
    setCurrentTime(clamped);
  }, [duration]);

  // Clique simples E arraste com o mouse: mousedown já faz o seek inicial
  // (cobre o clique) e liga listeners no window (não no elemento) pra
  // continuar seguindo o mouse mesmo se ele sair da área da forma de onda
  // enquanto arrasta, até o mouseup em qualquer lugar da página.
  const handleBarsMouseDown = useCallback((e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    seekToRatio((e.clientX - rect.left) / rect.width);

    const handleMouseMove = (moveEvent) => {
      seekToRatio((moveEvent.clientX - rect.left) / rect.width);
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [seekToRatio]);

  const timeLabel = formatTime(isPlaying || currentTime > 0 ? currentTime : duration);

  return (
    <div className="voice-player" style={style}>
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => { setIsPlaying(false); setCurrentTime(0); }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.playbackRate = speed;
          if (Number.isFinite(el.duration)) setDuration(el.duration || 0);
          else fixInfiniteDuration(el, setDuration);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime || 0)}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        className="voice-player-toggle"
        onClick={togglePlay}
        title={isPlaying ? 'Pausar' : 'Ouvir'}
      >
        {isPlaying ? <BsPauseFill size={18} /> : <BsPlayFill size={18} />}
      </button>
      <div className="voice-player-bars" onMouseDown={handleBarsMouseDown}>
        {bars.map((h, i) => (
          <span
            key={i}
            className="voice-player-bar"
            style={{
              height: `${Math.round(h * 100)}%`,
              backgroundColor: i / BAR_COUNT <= progress ? 'currentColor' : undefined,
            }}
          />
        ))}
      </div>
      <span className="voice-player-time">{timeLabel}</span>
      <button
        type="button"
        className="voice-player-speed"
        onClick={cycleSpeed}
        title="Velocidade de reprodução"
      >
        {speed}x
      </button>
    </div>
  );
};

export default VoiceMessagePlayer;
