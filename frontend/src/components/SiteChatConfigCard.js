import React, { useState, useEffect, useCallback } from 'react';

const authHeaders = (extra = {}) => ({
  Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
  ...extra,
});

const box = {
  border: '1px solid var(--border-color, #e3e6ec)',
  borderRadius: 10,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  background: 'var(--bg-secondary, #f7f8fa)',
};
const row = { display: 'flex', gap: 8, alignItems: 'center' };
const btn = {
  padding: '7px 12px',
  borderRadius: 6,
  border: '1px solid var(--brand-navy, #1B2A49)',
  background: 'var(--brand-navy, #1B2A49)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
};
const btnGhost = { ...btn, background: 'transparent', color: 'var(--brand-navy, #1B2A49)' };

export default function SiteChatConfigCard({ accountId }) {
  const [cfg, setCfg] = useState(null);
  const [origins, setOrigins] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/site-chat/accounts/${accountId}/config`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Falha ao carregar configuração');
      setCfg(d.data);
      setOrigins((d.data.allowed_origins || []).join('\n'));
      setApiBase(d.data.api_base_url || '');
      setTtlHours(d.data.protocol_ttl_hours || 24);
    } catch (e) {
      setMsg(`Erro: ${e.message}`);
    }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg(`${label} copiado.`);
    } catch {
      setMsg('Não foi possível copiar — selecione e copie manualmente.');
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fetch(`/api/site-chat/accounts/${accountId}/config`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          allowed_origins: origins.split('\n').map(s => s.trim()).filter(Boolean),
          api_base_url: apiBase.trim(),
          protocol_ttl_hours: Number(ttlHours) || 24,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Falha ao salvar');
      setMsg('Configuração salva.');
      load();
    } catch (e) {
      setMsg(`Erro: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (!window.confirm('Gerar um novo segredo? O plugin instalado no site deixará de funcionar até você baixar/instalar o plugin novamente (ou colar o novo segredo).')) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await fetch(`/api/site-chat/accounts/${accountId}/rotate-secret`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Falha ao gerar segredo');
      setMsg('Novo segredo gerado.');
      setShowSecret(true);
      load();
    } catch (e) {
      setMsg(`Erro: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadPlugin = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fetch(`/api/site-chat/accounts/${accountId}/plugin.zip`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Falha ao baixar o plugin');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wpp-site-chat.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(`Erro: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) {
    return <div style={box}>{msg || 'Carregando configuração do chat do site...'}</div>;
  }

  const readonlyInput = { flex: 1, fontFamily: 'monospace', fontSize: 12 };

  return (
    <div style={box}>
      <strong>🌐 Chat do Site (WooCommerce)</strong>
      <span style={{ fontSize: 12, color: '#888' }}>
        Baixe o plugin já configurado e instale no WordPress (Plugins → Adicionar novo → Enviar plugin).
        Os visitantes que escreverem pelo chat aparecem em Conversas/Clientes como esta conta.
      </span>

      <div>
        <button type="button" style={btn} onClick={downloadPlugin} disabled={busy}>
          ⬇ Baixar plugin (.zip)
        </button>
      </div>

      <div className="sm-field">
        <label>Site Key</label>
        <div style={row}>
          <input type="text" readOnly value={cfg.site_key} style={readonlyInput} />
          <button type="button" style={btnGhost} onClick={() => copy(cfg.site_key, 'Site Key')}>Copiar</button>
        </div>
      </div>

      <div className="sm-field">
        <label>Site Secret</label>
        <div style={row}>
          <input
            type={showSecret ? 'text' : 'password'}
            readOnly
            value={cfg.site_secret}
            style={readonlyInput}
          />
          <button type="button" style={btnGhost} onClick={() => setShowSecret(v => !v)}>
            {showSecret ? 'Ocultar' : 'Mostrar'}
          </button>
          <button type="button" style={btnGhost} onClick={() => copy(cfg.site_secret, 'Site Secret')}>Copiar</button>
        </div>
        <div style={{ marginTop: 6 }}>
          <button type="button" style={btnGhost} onClick={rotate} disabled={busy}>
            Gerar novo segredo
          </button>
        </div>
      </div>

      <div className="sm-field">
        <label>URL da API (usada pelo plugin)</label>
        <input type="text" value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder="https://app.suaempresa.com.br" />
      </div>

      <div className="sm-field">
        <label>Origens permitidas (uma por linha)</label>
        <textarea
          rows={3}
          value={origins}
          onChange={e => setOrigins(e.target.value)}
          placeholder="https://www.sualoja.com.br"
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
        <span style={{ fontSize: 12, color: '#888' }}>
          Domínios do site autorizados a abrir o chat. Deixe vazio para não restringir.
        </span>
      </div>

      <div className="sm-field">
        <label>Duração do protocolo (horas)</label>
        <input
          type="number"
          min={1}
          max={720}
          value={ttlHours}
          onChange={e => setTtlHours(e.target.value)}
          style={{ width: 120 }}
        />
        <span style={{ fontSize: 12, color: '#888' }}>
          Para o cliente, o chat recomeça do zero depois desse tempo sem atividade (padrão 24h; de 1 a 720h).
          O painel mantém todo o histórico. Vale também para plugins já instalados.
        </span>
      </div>

      <div>
        <button type="button" style={btn} onClick={save} disabled={busy}>Salvar configuração do site</button>
      </div>
      {msg && <span style={{ fontSize: 12 }}>{msg}</span>}
    </div>
  );
}
