/**
 * WhatsAppLinkPanel.js
 *
 * Componente de vinculação de sessão WhatsApp para providers não-oficiais
 * (Baileys, Venom, WPPConnect) — exibido em Settings → Contas WA.
 *
 * Suporta dois métodos:
 *
 *  QR Code      → Escanear com a câmera do celular (método clássico)
 *  Código       → Digitar número → WhatsApp envia código de 8 dígitos
 *                    (método "Vincular com número de telefone")
 *
 * O usuário escolhe livremente entre os dois. Ambos levam ao mesmo resultado:
 * sessão WhatsApp Web autenticada, pronta para o sistema usar.
 *
 * DIFERENTE do QRCodeManager (que gera QR de marketing da Meta API).
 * Este componente AUTENTICA o número no sistema.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MdQrCode, MdPhone, MdRefresh, MdClose, MdCheckCircle, MdError } from 'react-icons/md';
import '../styles/WhatsAppLinkPanel.css';

// ─── Constantes ───────────────────────────────────────────────

const PROVIDER_LABELS = {
  baileys:         { name: 'Baileys',    color: '#ECB22E', icon: '⚡' },
  venom:           { name: 'Venom',      color: '#E01E5A', icon: '🦾' },
  wppconnect:      { name: 'WPPConnect', color: '#9333EA', icon: '🔌' },
  whatsapp_web_js: { name: 'WA-Web.js',  color: '#FF6B35', icon: '🌐' },
};

const METHOD_QR   = 'qr';
const METHOD_CODE = 'code';

// ─── Componente principal ─────────────────────────────────────

/**
 * @param {number}   accountId       ID da conta no banco
 * @param {string}   providerType    "baileys" | "venom" | "wppconnect" | "whatsapp_web_js"
 * @param {string}   accountName     Nome amigável da conta
 * @param {Function} onAuthenticated Chamado quando sessão autenticada
 * @param {Function} onClose         Chamado ao cancelar/fechar
 */
const WhatsAppLinkPanel = ({
  accountId,
  providerType,
  accountName,
  onAuthenticated,
  onClose,
}) => {
  // ── Método selecionado ──────────────────────────────────────
  const [method, setMethod] = useState(null);          // null | 'qr' | 'code'

  // ── Estado QR ──────────────────────────────────────────────
  const [qrPhase,   setQrPhase]   = useState('idle');  // idle|loading|qr|auth|error|offline
  const [qrBase64,  setQrBase64]  = useState(null);
  const [qrString,  setQrString]  = useState(null);
  const [qrInstructions, setQrInstructions] = useState([]);
  const [qrCountdown, setQrCountdown] = useState(60);

  // ── Estado Código ────────────────────────────────────────────
  const [codePhase,  setCodePhase]  = useState('idle'); // idle|loading|showing|auth|error
  const [phoneInput, setPhoneInput] = useState('');
  const [pairingCode, setPairingCode] = useState('');   // "ABCD-1234"
  const [codeInstructions, setCodeInstructions] = useState([]);
  const [codeCountdown, setCodeCountdown] = useState(60);
  const [codeExpired, setCodeExpired] = useState(false);

  // ── Shared ───────────────────────────────────────────────────
  const [errorMsg,    setErrorMsg]    = useState('');
  const [authPhone,   setAuthPhone]   = useState('');

  const pollRef   = useRef(null);
  // Sessão nova (primeira vez conectando o número): o bridge só tem uns 15s
  // pra terminar de subir a sessão e gerar o QR na PRIMEIRA chamada de
  // /qr — se não der tempo, ele responde um status transitório (ex:
  // "starting") sem QR nenhum. Sem retry automático, isso virava erro
  // definitivo e só um F5 (que remonta o componente) resolvia, porque por
  // essa altura a sessão iniciada em background já tinha subido de verdade.
  const qrAutoRetryRef   = useRef(0);
  const codeAutoRetryRef = useRef(0);
  const MAX_AUTO_RETRIES = 10; // ~20s de tentativas (2s de intervalo) cobre a folga do bridge
  const timerRef  = useRef(null);
  const mountedRef = useRef(true);

  const provider = PROVIDER_LABELS[providerType] || { name: providerType, color: '#0EA5A4', icon: '📱' };

  // ── Cleanup ─────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearInterval(pollRef.current);
      clearInterval(timerRef.current);
    };
  }, []);

  // ── Helpers ─────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      if (!mountedRef.current) return;
      try {
        const resp = await fetch(`/api/settings/accounts/${accountId}/auth-status`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
        });        
        const json = await resp.json();
        if (json?.data?.authenticated) {
          clearInterval(pollRef.current);
          clearInterval(timerRef.current);
          if (!mountedRef.current) return;
          setAuthPhone(json.data.phone || '');
          if (method === METHOD_QR)   setQrPhase('auth');
          if (method === METHOD_CODE) setCodePhase('auth');
          if (onAuthenticated) onAuthenticated(json.data);
        }
      } catch {/* ignora erros de polling */}
    }, 3000);
  }, [accountId, method, onAuthenticated]);

  const startCountdown = useCallback((seconds, onExpire, setCounter) => {
    clearInterval(timerRef.current);
    let remaining = seconds;
    timerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      remaining -= 1;
      setCounter(remaining);          // ← setter passado como argumento
      if (remaining <= 0) {
        clearInterval(timerRef.current);
        if (onExpire) onExpire();
      }
    }, 1000);
  }, []);                             // ← sem dependência de method

  // MÉTODO QR CODE

  const fetchQR = useCallback(async () => {
    if (!mountedRef.current) return;
    setQrPhase('loading');
    setErrorMsg('');
    try {
      const resp = await fetch(`/api/settings/accounts/${accountId}/qr`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
      });
      const json = await resp.json();
      if (!mountedRef.current) return;

      if (!json.success) {
        setQrPhase('error');
        setErrorMsg(json.message || 'Erro ao obter QR Code');
        return;
      }

      const data = json.data;

      if (data.authenticated) {
        setQrPhase('auth');
        setAuthPhone(data.phone || '');
        clearInterval(pollRef.current);
        if (onAuthenticated) onAuthenticated(data);
        return;
      }

      if (data.status === 'bridge_offline') {
        setQrPhase('offline');
        setErrorMsg(data.error || 'Bridge offline');
        return;
      }

      if (data.requires_scan) {
        qrAutoRetryRef.current = 0;
        setQrPhase('qr');
        setQrBase64(data.qr_base64 || null);
        setQrString(data.qr_string || '');
        setQrInstructions(data.instructions || []);
        setQrCountdown(data.expires_in_seconds || 60);
        startPolling();
        startCountdown(data.expires_in_seconds || 60, () => {
          if (mountedRef.current) fetchQR();
        }, setQrCountdown);                 // ← passa setQrCountdown
        return;
      }

      // Status transitório (ex: "starting") — a sessão ainda está subindo no
      // bridge, ainda não gerou QR. Tenta de novo em vez de já desistir.
      if (qrAutoRetryRef.current < MAX_AUTO_RETRIES) {
        qrAutoRetryRef.current += 1;
        setQrPhase('loading');
        setTimeout(() => { if (mountedRef.current) fetchQR(); }, 2000);
        return;
      }

      setQrPhase('error');
      setErrorMsg(data.error || 'Status desconhecido');
    } catch {
      if (mountedRef.current) {
        setQrPhase('error');
        setErrorMsg('Falha de comunicação com o servidor');
      }
    }
  }, [accountId, onAuthenticated, startPolling, startCountdown]);

  const handleSelectQR = () => {
    setMethod(METHOD_QR);
    setQrPhase('idle');
    qrAutoRetryRef.current = 0;
    // Inicia fetch automaticamente
    setTimeout(() => fetchQR(), 50);
  };

  // MÉTODO CÓDIGO DE PAREAMENTO

  const requestPairingCode = useCallback(async () => {
    const digits = phoneInput.replace(/\D/g, '');
    if (digits.length < 10) return;

    setCodePhase('loading');
    setErrorMsg('');
    setPairingCode('');
    setCodeExpired(false);

    try {
      const resp = await fetch(`/api/settings/accounts/${accountId}/pairing-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
        },
        body: JSON.stringify({ phone_number: digits }),
      });
      const json = await resp.json();
      if (!mountedRef.current) return;

      if (!json.success || !json.data?.pairing_code) {
        // Mesma corrida da sessão nova do QR — na primeira chamada o bridge
        // pode ainda não ter terminado de subir a sessão pra gerar o código.
        if (codeAutoRetryRef.current < MAX_AUTO_RETRIES) {
          codeAutoRetryRef.current += 1;
          setTimeout(() => { if (mountedRef.current) requestPairingCode(); }, 2000);
          return;
        }
        setCodePhase('error');
        setErrorMsg(json.detail || json.data?.error || 'Falha ao obter código');
        return;
      }

      codeAutoRetryRef.current = 0;
      const data = json.data;
      setCodePhase('showing');
      setPairingCode(data.pairing_code);
      setCodeInstructions(data.instructions || []);
      setCodeCountdown(data.expires_in_seconds || 60);

      startPolling();
      startCountdown(data.expires_in_seconds || 60, () => {
        if (mountedRef.current) setCodeExpired(true);
      }, setCodeCountdown);  
    } catch {
      if (mountedRef.current) {
        setCodePhase('error');
        setErrorMsg('Falha de comunicação com o servidor');
      }
    }
  }, [accountId, phoneInput, startPolling, startCountdown]);

  const handleSelectCode = () => {
    setMethod(METHOD_CODE);
    setCodePhase('idle');
    setPairingCode('');
    setCodeExpired(false);
  };

  const handleRetry = () => {
    clearInterval(pollRef.current);
    clearInterval(timerRef.current);
    setErrorMsg('');
    if (method === METHOD_QR) {
      qrAutoRetryRef.current = 0;
      setQrPhase('idle');
      fetchQR();
    } else {
      codeAutoRetryRef.current = 0;
      setCodePhase('idle');
      setPairingCode('');
      setCodeExpired(false);
    }
  };

  const handleBack = () => {
    clearInterval(pollRef.current);
    clearInterval(timerRef.current);
    setMethod(null);
    setQrPhase('idle');
    setCodePhase('idle');
    setPairingCode('');
    setErrorMsg('');
    setCodeExpired(false);
  };

  // ── Helpers de validação do telefone ─────────────────────────
  const isPhoneValid = phoneInput.replace(/\D/g, '').length >= 10;

  // RENDER

  return (
    <div className="wlp-wrapper">

      {/* ── Header ── */}
      <div className="wlp-header">
        <div className="wlp-provider-badge" style={{ borderColor: provider.color }}>
          <span>{provider.icon}</span>
          <span style={{ color: provider.color }}>{provider.name}</span>
        </div>
        <span className="wlp-account-name">{accountName}</span>
      </div>

      {/* ── Disclaimer ── */}
      <div className="wlp-disclaimer">
        <span>⚠️</span>
        <span>Provider não-oficial. Uso pode violar os Termos de Serviço do WhatsApp.</span>
      </div>

      {/* ════════════════════════════════════════════
          SELETOR DE MÉTODO (tela inicial)
      ════════════════════════════════════════════ */}
      {!method && (
        <div className="wlp-method-select">
          <p className="wlp-method-title">Como deseja vincular este número?</p>

          <button className="wlp-method-card" onClick={handleSelectQR}>
            <div className="wlp-method-icon wlp-method-icon-qr">
              <MdQrCode size={28} />
            </div>
            <div className="wlp-method-info">
              <strong>QR Code</strong>
              <span>Escaneie com a câmera do celular</span>
            </div>
            <span className="wlp-method-arrow">→</span>
          </button>

          <button className="wlp-method-card" onClick={handleSelectCode}>
            <div className="wlp-method-icon wlp-method-icon-code">
              <MdPhone size={28} />
            </div>
            <div className="wlp-method-info">
              <strong>Código de pareamento</strong>
              <span>Digite o número → receba código de 8 dígitos no WhatsApp</span>
            </div>
            <span className="wlp-method-arrow">→</span>
          </button>

          <p className="wlp-method-hint">
            Ambos os métodos têm o mesmo resultado. O QR é mais rápido, o código
            é útil quando a câmera não está disponível.
          </p>
        </div>
      )}

      {/* ════════════════════════════════════════════
          MÉTODO QR CODE
      ════════════════════════════════════════════ */}
      {method === METHOD_QR && (
        <div className="wlp-method-content">
          <button className="wlp-back-btn" onClick={handleBack}>← Voltar</button>

          {/* Loading */}
          {qrPhase === 'loading' && (
            <div className="wlp-center">
              <div className="wlp-spinner" />
              <p>Gerando QR Code...</p>
            </div>
          )}

          {/* QR exibido */}
          {qrPhase === 'qr' && (
            <div className="wlp-qr-area">
              <div className="wlp-qr-frame">
                <div className="wlp-corner wlp-corner-tl" />
                <div className="wlp-corner wlp-corner-tr" />
                <div className="wlp-corner wlp-corner-bl" />
                <div className="wlp-corner wlp-corner-br" />

                {qrBase64 ? (
                  <img
                    className="wlp-qr-img"
                    src={qrBase64.startsWith('data:') ? qrBase64 : `data:image/png;base64,${qrBase64}`}
                    alt="QR Code WhatsApp"
                  />
                ) : qrString ? (
                  <img
                    className="wlp-qr-img"
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrString)}`}
                    alt="QR Code WhatsApp"
                  />
                ) : (
                  <div className="wlp-spinner" />
                )}

                {qrCountdown <= 10 && qrCountdown > 0 && (
                  <div className="wlp-expiry-overlay">
                    <span className="wlp-expiry-num">{qrCountdown}</span>
                    <span>seg</span>
                  </div>
                )}
              </div>

              <div className="wlp-progress-bar">
                <div className="wlp-progress-fill" style={{ width: `${(qrCountdown / 60) * 100}%` }} />
              </div>
              <p className="wlp-timer-txt">Expira em <strong>{qrCountdown}s</strong> · renova automaticamente</p>

              <ol className="wlp-steps">
                {qrInstructions.map((s, i) => (
                  <li key={i}>
                    <span className="wlp-step-num">{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Autenticado */}
          {qrPhase === 'auth' && (
            <div className="wlp-center wlp-auth-ok">
              <div className="wlp-success-ring"><MdCheckCircle size={32} /></div>
              <p className="wlp-auth-title">Sessão autenticada!</p>
              {authPhone && <p className="wlp-auth-phone">{authPhone}</p>}
              <p className="wlp-auth-sub">
                O número está conectado via {provider.name} e pronto para uso.
              </p>
              <button className="wlp-btn wlp-btn-primary" onClick={onClose}>Concluir</button>
            </div>
          )}

          {/* Offline / Erro */}
          {(qrPhase === 'offline' || qrPhase === 'error') && (
            <div className="wlp-center">
              <div className={`wlp-err-icon ${qrPhase === 'offline' ? 'warn' : 'err'}`}>
                {qrPhase === 'offline' ? '📡' : '✕'}
              </div>
              <p className="wlp-err-title">
                {qrPhase === 'offline' ? 'Bridge offline' : 'Falha ao obter QR Code'}
              </p>
              <p className="wlp-err-msg">{errorMsg}</p>
              {qrPhase === 'offline' && (
                <div className="wlp-code-block">
                  <code>{getBridgeCommand(providerType)}</code>
                </div>
              )}
              <div className="wlp-btn-row">
                <button className="wlp-btn wlp-btn-secondary" onClick={handleBack}>Voltar</button>
                <button className="wlp-btn wlp-btn-primary" onClick={handleRetry}>Tentar novamente</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════
          MÉTODO CÓDIGO DE PAREAMENTO
      ════════════════════════════════════════════ */}
      {method === METHOD_CODE && (
        <div className="wlp-method-content">
          <button className="wlp-back-btn" onClick={handleBack}>← Voltar</button>

          {/* Entrada do número */}
          {codePhase === 'idle' && (
            <div className="wlp-code-form">
              <p className="wlp-code-form-title">
                Digite o número do WhatsApp que será vinculado
              </p>
              <div className="wlp-phone-field">
                <span className="wlp-phone-prefix">+</span>
                <input
                  type="tel"
                  placeholder="55 44 99999-9999"
                  value={phoneInput}
                  onChange={e => setPhoneInput(e.target.value)}
                  autoFocus
                />
              </div>
              <p className="wlp-phone-hint">
                Inclua o código do país. Ex: <strong>55 44 99999-9999</strong>
              </p>
              <button
                className="wlp-btn wlp-btn-primary"
                onClick={requestPairingCode}
                disabled={!isPhoneValid}
              >
                <MdPhone size={16} /> Solicitar código
              </button>
            </div>
          )}

          {/* Loading */}
          {codePhase === 'loading' && (
            <div className="wlp-center">
              <div className="wlp-spinner" />
              <p>Solicitando código...</p>
            </div>
          )}

          {/* Código exibido */}
          {codePhase === 'showing' && !codeExpired && (
            <div className="wlp-pairing-display">
              <p className="wlp-pairing-label">Seu código de pareamento</p>

              <div className="wlp-pairing-code">
                {pairingCode.split('-').map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="wlp-pairing-dash">-</span>}
                    <span className="wlp-pairing-part">{part}</span>
                  </React.Fragment>
                ))}
              </div>

              <div className="wlp-progress-bar" style={{ marginTop: 10 }}>
                <div className="wlp-progress-fill" style={{ width: `${(codeCountdown / 60) * 100}%` }} />
              </div>
              <p className="wlp-timer-txt">Expira em <strong>{codeCountdown}s</strong></p>

              <ol className="wlp-steps">
                {codeInstructions.map((s, i) => (
                  <li key={i}>
                    <span className="wlp-step-num">{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>

              <p className="wlp-pairing-hint">
                Aguardando você inserir o código no WhatsApp...
                <span className="wlp-dot-pulse" />
              </p>
            </div>
          )}

          {/* Código expirado */}
          {codePhase === 'showing' && codeExpired && (
            <div className="wlp-center">
              <div className="wlp-err-icon warn">⏱</div>
              <p className="wlp-err-title">Código expirado</p>
              <p className="wlp-err-msg">O código de 8 dígitos expirou. Solicite um novo.</p>
              <div className="wlp-btn-row">
                <button className="wlp-btn wlp-btn-secondary" onClick={handleBack}>Voltar</button>
                <button className="wlp-btn wlp-btn-primary" onClick={requestPairingCode}>
                  <MdRefresh size={15} /> Novo código
                </button>
              </div>
            </div>
          )}

          {/* Autenticado */}
          {codePhase === 'auth' && (
            <div className="wlp-center wlp-auth-ok">
              <div className="wlp-success-ring"><MdCheckCircle size={32} /></div>
              <p className="wlp-auth-title">Pareamento concluído!</p>
              {authPhone && <p className="wlp-auth-phone">{authPhone}</p>}
              <p className="wlp-auth-sub">
                O número está conectado via {provider.name} e pronto para uso.
              </p>
              <button className="wlp-btn wlp-btn-primary" onClick={onClose}>Concluir</button>
            </div>
          )}

          {/* Erro */}
          {codePhase === 'error' && (
            <div className="wlp-center">
              <div className="wlp-err-icon err"><MdError size={22} /></div>
              <p className="wlp-err-title">Falha ao obter código</p>
              <p className="wlp-err-msg">{errorMsg}</p>
              <div className="wlp-btn-row">
                <button className="wlp-btn wlp-btn-secondary" onClick={handleBack}>Voltar</button>
                <button className="wlp-btn wlp-btn-primary" onClick={() => { setCodePhase('idle'); setErrorMsg(''); }}>
                  Tentar novamente
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Helper ──────────────────────────────────────────────────
function getBridgeCommand(providerType) {
  if (providerType === 'baileys')         return 'cd services/baileys-bridge && node index.js';
  if (providerType === 'venom')           return 'cd services/venom-bridge && node index.js';
  if (providerType === 'wppconnect')      return 'cd services/wppconnect-bridge && node index.js';
  if (providerType === 'whatsapp_web_js') return 'cd services/wa-web-bridge && node index.js';
  return 'cd services/wppconnect-bridge && node index.js';
}

export default WhatsAppLinkPanel;
