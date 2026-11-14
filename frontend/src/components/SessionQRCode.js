/**
 * SessionQRCode.js
 * 
 * Exibe o QR Code de sessão para autenticação de providers não-oficiais
 * (Baileys, Venom, WPPConnect) DENTRO de Settings → Contas WA.
 * 
 * DIFERENTE do QRCodeManager (que gera QR codes de marketing da Meta API).
 * Este componente autentica uma sessão WhatsApp Web.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import '../styles/SessionQRCode.css';

const PROVIDER_LABELS = {
  baileys:         { name: 'Baileys',      color: '#ECB22E', emoji: '' },
  venom:           { name: 'Venom',        color: '#E01E5A', emoji: '🦾' },
  wppconnect:      { name: 'WPPConnect',   color: '#9333EA', emoji: '🔌' },
  whatsapp_web_js: { name: 'WA-Web.js',   color: '#FF6B35', emoji: '🌐' },
};

/**
 * @param {Object}   props
 * @param {number}   props.accountId      - ID da conta no banco
 * @param {string}   props.providerType   - "baileys" | "venom" | "wppconnect" | "whatsapp_web_js"
 * @param {string}   props.accountName    - Nome amigável da conta
 * @param {Function} props.onAuthenticated - Chamado quando sessão autenticada com sucesso
 * @param {Function} props.onClose        - Chamado ao fechar/cancelar
 */
const SessionQRCode = ({
  accountId,
  providerType,
  accountName,
  onAuthenticated,
  onClose,
}) => {
  const [phase, setPhase] = useState('loading'); // loading | qr | authenticated | error | offline
  const [qrBase64, setQrBase64] = useState(null);
  const [qrString, setQrString] = useState(null);
  const [instructions, setInstructions] = useState([]);
  const [countdown, setCountdown] = useState(60);
  const [errorMsg, setErrorMsg] = useState('');
  const [phone, setPhone] = useState('');

  const pollRef   = useRef(null);
  const timerRef  = useRef(null);
  const mountedRef = useRef(true);

  const provider = PROVIDER_LABELS[providerType] || {
    name: providerType, color: '#0EA5A4', emoji: '📱'
  };

  // ── Fetch QR do backend ──────────────────────────────
  const fetchQR = useCallback(async () => {
    if (!mountedRef.current) return;
    try {
      const resp = await fetch(`/api/settings/accounts/${accountId}/qr`);
      const json = await resp.json();

      if (!mountedRef.current) return;

      if (!json.success) {
        setPhase('error');
        setErrorMsg(json.message || 'Erro ao obter QR Code');
        return;
      }

      const data = json.data;

      if (data.authenticated) {
        setPhase('authenticated');
        setPhone(data.phone || '');
        clearInterval(pollRef.current);
        clearInterval(timerRef.current);
        if (onAuthenticated) onAuthenticated(data);
        return;
      }

      if (data.status === 'bridge_offline') {
        setPhase('offline');
        setErrorMsg(data.error || 'Serviço bridge não está rodando');
        return;
      }

      if (data.requires_scan && data.qr_base64) {
        setPhase('qr');
        setQrBase64(data.qr_base64);
        setQrString(data.qr_string || '');
        setInstructions(data.instructions || []);
        setCountdown(data.expires_in_seconds || 60);
        return;
      }

      setPhase('error');
      setErrorMsg(data.error || 'Status desconhecido');

    } catch (err) {
      if (!mountedRef.current) return;
      setPhase('error');
      setErrorMsg('Falha na comunicação com o servidor');
    }
  }, [accountId, onAuthenticated]);

  // ── Polling: re-busca QR a cada 5s para detectar scan ─
  const startPolling = useCallback(() => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (mountedRef.current) fetchQR();
    }, 5000);
  }, [fetchQR]);

  // ── Contador regressivo do QR ───────────────────────
  const startCountdown = useCallback((seconds) => {
    clearInterval(timerRef.current);
    setCountdown(seconds);
    timerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          if (mountedRef.current) fetchQR(); // QR expirou — busca novo
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [fetchQR]);

  // ── Init ─────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    fetchQR();
    return () => {
      mountedRef.current = false;
      clearInterval(pollRef.current);
      clearInterval(timerRef.current);
    };
  }, [fetchQR]);

  // Inicia polling/countdown quando QR é exibido
  useEffect(() => {
    if (phase === 'qr') {
      startPolling();
      startCountdown(countdown);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Render ───────────────────────────────────────────

  const handleRetry = () => {
    setPhase('loading');
    setErrorMsg('');
    fetchQR();
  };

  return (
    <div className="sqr-wrapper">
      {/* Header */}
      <div className="sqr-header">
        <div className="sqr-provider-badge" style={{ borderColor: provider.color }}>
          <span className="sqr-provider-emoji">{provider.emoji}</span>
          <span className="sqr-provider-name" style={{ color: provider.color }}>
            {provider.name}
          </span>
        </div>
        <span className="sqr-account-name">{accountName}</span>
      </div>

      {/* Disclaimer não-oficial */}
      <div className="sqr-disclaimer">
        <span className="sqr-disclaimer-icon">⚠️</span>
        <span>
          Provider não-oficial. Uso pode violar os Termos de Serviço do WhatsApp.
          A conta pode ser banida. Use ciente dos riscos.
        </span>
      </div>

      {/* ── Loading ── */}
      {phase === 'loading' && (
        <div className="sqr-center">
          <div className="sqr-spinner" />
          <p className="sqr-status-text">Aguardando QR Code do servidor...</p>
        </div>
      )}

      {/* ── QR Code ── */}
      {phase === 'qr' && (
        <div className="sqr-qr-area">
          <div className="sqr-qr-frame">
            {/* Cantos decorativos */}
            <div className="sqr-corner sqr-corner-tl" />
            <div className="sqr-corner sqr-corner-tr" />
            <div className="sqr-corner sqr-corner-bl" />
            <div className="sqr-corner sqr-corner-br" />

            {/* QR Image */}
            {qrBase64 ? (
              <img
                className="sqr-qr-img"
                src={qrBase64.startsWith('data:') ? qrBase64 : `data:image/png;base64,${qrBase64}`}
                alt="QR Code de sessão WhatsApp"
              />
            ) : (
              /* Fallback: gera QR via API pública com a string bruta */
              qrString && (
                <img
                  className="sqr-qr-img"
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrString)}`}
                  alt="QR Code de sessão WhatsApp"
                />
              )
            )}

            {/* Countdown overlay quando QR está prestes a expirar */}
            {countdown <= 10 && countdown > 0 && (
              <div className="sqr-expiry-overlay">
                <span className="sqr-expiry-num">{countdown}</span>
                <span className="sqr-expiry-label">seg</span>
              </div>
            )}
          </div>

          {/* Barra de progresso */}
          <div className="sqr-progress-bar">
            <div
              className="sqr-progress-fill"
              style={{ width: `${(countdown / 60) * 100}%` }}
            />
          </div>
          <p className="sqr-timer-text">
            QR expira em <strong>{countdown}s</strong> · renova automaticamente
          </p>

          {/* Instruções */}
          <ol className="sqr-instructions">
            {instructions.map((step, i) => (
              <li key={i} className="sqr-instruction-item">
                <span className="sqr-instruction-num">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* ── Autenticado ── */}
      {phase === 'authenticated' && (
        <div className="sqr-center">
          <div className="sqr-success-icon">✓</div>
          <p className="sqr-success-title">Sessão autenticada!</p>
          {phone && (
            <p className="sqr-success-phone">{phone}</p>
          )}
          <p className="sqr-success-sub">
            O número está conectado via {provider.name} e pronto para uso.
          </p>
          <button className="sqr-btn sqr-btn-primary" onClick={onClose}>
            Concluir
          </button>
        </div>
      )}

      {/* ── Bridge offline ── */}
      {phase === 'offline' && (
        <div className="sqr-center">
          <div className="sqr-offline-icon">📡</div>
          <p className="sqr-error-title">Serviço bridge offline</p>
          <p className="sqr-error-msg">{errorMsg}</p>
          <div className="sqr-code-block">
            {providerType === 'baileys' && (
              <code>cd services/baileys-bridge && node index.js</code>
            )}
            {providerType === 'venom' && (
              <code>cd services/venom-bridge && node index.js</code>
            )}
            {(providerType === 'wppconnect' || providerType === 'whatsapp_web_js') && (
              <code>cd services/wppconnect-server && npm start</code>
            )}
          </div>
          <div className="sqr-btn-row">
            <button className="sqr-btn sqr-btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button className="sqr-btn sqr-btn-primary" onClick={handleRetry}>
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      {/* ── Erro genérico ── */}
      {phase === 'error' && (
        <div className="sqr-center">
          <div className="sqr-error-icon">✕</div>
          <p className="sqr-error-title">Falha ao obter QR Code</p>
          <p className="sqr-error-msg">{errorMsg}</p>
          <div className="sqr-btn-row">
            <button className="sqr-btn sqr-btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button className="sqr-btn sqr-btn-primary" onClick={handleRetry}>
              Tentar novamente
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SessionQRCode;
