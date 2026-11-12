/**
 * PhoneNumberInfo.js
 *
 * Qualidade e status do(s) número(s) do WhatsApp Business da conta —
 * GET /api/extended/phone/list, que já existia no backend mas não tinha
 * nenhuma tela (mostra mais detalhe que /phone/info: nome verificado,
 * throughput, e a URL de webhook que a Meta tem configurada de verdade).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { MdRefresh, MdCheckCircle, MdWarning, MdError, MdHelpOutline } from 'react-icons/md';
import apiService from '../services/api';
import '../styles/PhoneNumberInfo.css';

const QUALITY_CONFIG = {
  GREEN:   { label: 'Boa', color: '#2FAE60', icon: <MdCheckCircle size={16} /> },
  YELLOW:  { label: 'Média — atenção', color: '#ECB22E', icon: <MdWarning size={16} /> },
  RED:     { label: 'Baixa — risco de restrição', color: '#F44336', icon: <MdError size={16} /> },
  UNKNOWN: { label: 'Desconhecida (número novo/sem volume)', color: '#8696A0', icon: <MdHelpOutline size={16} /> },
};

const VERIFICATION_LABEL = {
  VERIFIED: 'Verificado',
  EXPIRED: 'Verificação expirada',
  PENDING: 'Verificação pendente',
  NOT_VERIFIED: 'Não verificado',
};

const PhoneNumberInfo = () => {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const all = await apiService.getAccounts();
      const metaAccounts = (all || []).filter(a => (a.provider_type || '').startsWith('meta'));
      setAccounts(metaAccounts);
      if (metaAccounts.length > 0) setAccountId(metaAccounts[0].id);
    })();
  }, []);

  const load = useCallback(async () => {
    if (!accountId && accounts.length > 0) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiService.getPhoneNumberList(accountId);
      setNumbers(data);
    } catch (e) {
      setError(e?.response?.data?.detail || 'Erro ao buscar informações do número.');
      setNumbers([]);
    } finally {
      setLoading(false);
    }
  }, [accountId, accounts.length]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="pni-container">
      <div className="pni-toolbar">
        {accounts.length > 1 && (
          <select className="pni-select" value={accountId || ''} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number || `Conta #${a.id}`}</option>)}
          </select>
        )}
        <button className="pni-btn" onClick={load} disabled={loading}>
          <MdRefresh size={16} className={loading ? 'pni-spin' : ''} /> Atualizar
        </button>
      </div>

      {error && <div className="pni-error">⚠️ {error}</div>}

      {loading ? (
        <div className="pni-empty">Carregando...</div>
      ) : numbers.length === 0 ? (
        <div className="pni-empty">Nenhum número encontrado para essa conta.</div>
      ) : (
        <div className="pni-list">
          {numbers.map(n => {
            const quality = QUALITY_CONFIG[n.quality_rating] || QUALITY_CONFIG.UNKNOWN;
            return (
              <div key={n.id} className="pni-card">
                <div className="pni-card-header">
                  <div>
                    <div className="pni-name">{n.verified_name || 'Sem nome verificado'}</div>
                    <div className="pni-phone">{n.display_phone_number}</div>
                  </div>
                  <span className="pni-quality-badge" style={{ color: quality.color, borderColor: quality.color }}>
                    {quality.icon} {quality.label}
                  </span>
                </div>

                <div className="pni-grid">
                  <div className="pni-field">
                    <span className="pni-field-label">Verificação</span>
                    <span>{VERIFICATION_LABEL[n.code_verification_status] || n.code_verification_status || '—'}</span>
                  </div>
                  <div className="pni-field">
                    <span className="pni-field-label">Plataforma</span>
                    <span>{n.platform_type || '—'}</span>
                  </div>
                  <div className="pni-field">
                    <span className="pni-field-label">Volume (throughput)</span>
                    <span>{n.throughput?.level || '—'}</span>
                  </div>
                  <div className="pni-field pni-field-wide">
                    <span className="pni-field-label">Webhook configurado</span>
                    <span className="pni-webhook-url">{n.webhook_configuration?.application || 'Nenhum'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PhoneNumberInfo;
