/**
 * FlowManager.js
 *
 * Gestão de WhatsApp Flows: chave de criptografia do canal de dados,
 * criação/publicação de Flows e upload do FLOW_JSON. Sem editor visual —
 * o JSON das telas é desenhado no Flow Builder da própria Meta (ou escrito
 * à mão) e colado aqui; o que faltava era só a infraestrutura de backend
 * (chave + endpoint criptografado), que já está ativa.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { MdAdd, MdDelete, MdRocketLaunch, MdUpload, MdVpnKey, MdRefresh, MdClose, MdCheckCircle, MdError, MdLink } from 'react-icons/md';
import apiService from '../services/api';
import '../styles/FlowManager.css';

const CATEGORY_OPTIONS = [
  'SIGN_UP', 'SIGN_IN', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION',
  'CONTACT_US', 'CUSTOMER_SUPPORT', 'SURVEY', 'OTHER',
];

const STATUS_COLOR = { DRAFT: '#ECB22E', PUBLISHED: '#2FAE60', DEPRECATED: '#888', BLOCKED: '#F44336', THROTTLED: '#F44336' };

const FlowManager = () => {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(null);

  const [keyStatus, setKeyStatus] = useState(null);
  const [generatingKey, setGeneratingKey] = useState(false);

  const [flows, setFlows] = useState([]);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategories, setNewCategories] = useState([]);
  const [newEndpointUri, setNewEndpointUri] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  const [jsonModalFlow, setJsonModalFlow] = useState(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [uploadingJson, setUploadingJson] = useState(false);
  const [publishingId, setPublishingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const [endpointModalFlow, setEndpointModalFlow] = useState(null);
  const [endpointUriInput, setEndpointUriInput] = useState('');
  const [endpointError, setEndpointError] = useState('');
  const [savingEndpoint, setSavingEndpoint] = useState(false);

  useEffect(() => {
    (async () => {
      const all = await apiService.getAccounts();
      const metaAccounts = (all || []).filter(a => (a.provider_type || '').startsWith('meta'));
      setAccounts(metaAccounts);
      if (metaAccounts.length > 0) setAccountId(metaAccounts[0].id);
    })();
  }, []);

  const loadKeyStatus = useCallback(async () => {
    try {
      const res = await apiService.getFlowKeysStatus(accountId);
      setKeyStatus(res);
    } catch (e) {
      setKeyStatus(null);
    }
  }, [accountId]);

  const loadFlows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiService.getFlows(accountId);
      setFlows(res.data || []);
    } catch (e) {
      console.error('Erro ao carregar flows:', e);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { if (accountId) { loadKeyStatus(); loadFlows(); } }, [accountId, loadKeyStatus, loadFlows]);

  const handleGenerateKey = async () => {
    setGeneratingKey(true);
    try {
      await apiService.generateFlowKeys(accountId);
      await loadKeyStatus();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao gerar/registrar chave');
    } finally {
      setGeneratingKey(false);
    }
  };

  const toggleCategory = (cat) => {
    setNewCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  };

  const handleCreate = async () => {
    if (!newName.trim() || newCategories.length === 0) {
      setCreateError('Preencha o nome e selecione ao menos uma categoria.');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      await apiService.createFlow({ name: newName.trim(), categories: newCategories, endpoint_uri: newEndpointUri.trim() || null }, accountId);
      setShowCreate(false);
      setNewName('');
      setNewCategories([]);
      setNewEndpointUri('');
      await loadFlows();
    } catch (e) {
      setCreateError(e?.response?.data?.detail || 'Erro ao criar Flow');
    } finally {
      setCreating(false);
    }
  };

  const openJsonModal = (flow) => {
    setJsonModalFlow(flow);
    setJsonText('');
    setJsonError('');
  };

  const openEndpointModal = (flow) => {
    setEndpointModalFlow(flow);
    setEndpointUriInput('');
    setEndpointError('');
  };

  const handleSaveEndpointUri = async () => {
    if (!endpointUriInput.trim().startsWith('http')) {
      setEndpointError('Cole a URL completa (começando com https://).');
      return;
    }
    setSavingEndpoint(true);
    setEndpointError('');
    try {
      await apiService.setFlowEndpointUri(endpointModalFlow.id, endpointUriInput.trim(), accountId);
      setEndpointModalFlow(null);
    } catch (e) {
      setEndpointError(e?.response?.data?.detail || 'Erro ao salvar o endpoint');
    } finally {
      setSavingEndpoint(false);
    }
  };

  const handleUploadJson = async () => {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setJsonError('JSON inválido — verifique a sintaxe.');
      return;
    }
    setUploadingJson(true);
    setJsonError('');
    try {
      await apiService.uploadFlowJson(jsonModalFlow.id, parsed, accountId);
      setJsonModalFlow(null);
      await loadFlows();
    } catch (e) {
      setJsonError(e?.response?.data?.detail || 'Erro ao subir JSON do Flow');
    } finally {
      setUploadingJson(false);
    }
  };

  const handlePublish = async (flowId) => {
    if (!window.confirm('Publicar esse Flow? Depois de publicado, telas não podem mais ser removidas (só adicionadas/desativadas).')) return;
    setPublishingId(flowId);
    try {
      await apiService.publishFlow(flowId, accountId);
      await loadFlows();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao publicar Flow');
    } finally {
      setPublishingId(null);
    }
  };

  const handleDelete = async (flowId) => {
    if (!window.confirm('Excluir esse Flow?')) return;
    setDeletingId(flowId);
    try {
      await apiService.deleteFlow(flowId, accountId);
      await loadFlows();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao excluir Flow');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="fm-container">
      {accounts.length > 1 && (
        <select className="fm-select" value={accountId || ''} onChange={(e) => setAccountId(Number(e.target.value))}>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.phone_number || `Conta #${a.id}`}</option>)}
        </select>
      )}

      <div className="fm-key-card">
        <div className="fm-key-left">
          <MdVpnKey size={18} />
          <div>
            <div className="fm-key-title">Chave de criptografia do canal de dados</div>
            <div className="fm-key-sub">
              {keyStatus?.meta_signature_status === 'VALID' ? (
                <span className="fm-status-ok"><MdCheckCircle size={13} /> Registrada e válida na Meta</span>
              ) : keyStatus ? (
                <span className="fm-status-warn"><MdError size={13} /> {keyStatus.meta_signature_status || 'Não registrada'} — gere uma chave antes de publicar Flows com telas dinâmicas</span>
              ) : (
                'Carregando...'
              )}
            </div>
          </div>
        </div>
        <button className="fm-btn fm-btn-ghost" onClick={handleGenerateKey} disabled={generatingKey}>
          <MdRefresh size={16} className={generatingKey ? 'fm-spin' : ''} /> {keyStatus?.local_key_exists ? 'Regerar' : 'Gerar chave'}
        </button>
      </div>

      <div className="fm-toolbar">
        <span className="fm-count">{flows.length} flow(s)</span>
        <button className="fm-btn fm-btn-primary" onClick={() => { setShowCreate(true); setCreateError(''); }}>
          <MdAdd size={18} /> Novo Flow
        </button>
      </div>

      {loading ? (
        <div className="fm-empty">Carregando flows...</div>
      ) : flows.length === 0 ? (
        <div className="fm-empty">Nenhum Flow criado ainda.</div>
      ) : (
        <div className="fm-list">
          {flows.map(f => (
            <div key={f.id} className="fm-card">
              <div className="fm-card-main">
                <div className="fm-card-name">{f.name}</div>
                <div className="fm-card-meta">
                  <span className="fm-badge" style={{ color: STATUS_COLOR[f.status] || '#888', borderColor: STATUS_COLOR[f.status] || '#888' }}>
                    {f.status}
                  </span>
                  {(f.categories || []).map(c => <span key={c} className="fm-tag">{c}</span>)}
                </div>
                {f.validation_errors && f.validation_errors.length > 0 && (
                  <div className="fm-validation-errors">
                    {f.validation_errors.map((e, i) => <div key={i}>⚠️ {typeof e === 'string' ? e : JSON.stringify(e)}</div>)}
                  </div>
                )}
              </div>
              <div className="fm-card-actions">
                <button className="fm-icon-btn" onClick={() => openEndpointModal(f)} title="Definir endpoint de dados">
                  <MdLink size={16} />
                </button>
                <button className="fm-icon-btn" onClick={() => openJsonModal(f)} title="Subir FLOW_JSON">
                  <MdUpload size={16} />
                </button>
                {f.status === 'DRAFT' && (
                  <button className="fm-icon-btn" onClick={() => handlePublish(f.id)} disabled={publishingId === f.id} title="Publicar">
                    <MdRocketLaunch size={16} />
                  </button>
                )}
                <button className="fm-icon-btn fm-icon-btn-danger" onClick={() => handleDelete(f.id)} disabled={deletingId === f.id} title="Excluir">
                  <MdDelete size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="fm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowCreate(false)}>
          <div className="fm-modal">
            <div className="fm-modal-header">
              <h3>Novo Flow</h3>
              <button className="fm-icon-btn" onClick={() => setShowCreate(false)}><MdClose size={20} /></button>
            </div>
            <div className="fm-modal-body">
              {createError && <div className="fm-error">⚠️ {createError}</div>}
              <div className="fm-form-row">
                <label>Nome</label>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ex: agendamento_consulta" />
              </div>
              <div className="fm-form-row">
                <label>Categorias</label>
                <div className="fm-category-grid">
                  {CATEGORY_OPTIONS.map(cat => (
                    <label key={cat} className={`fm-category-chip ${newCategories.includes(cat) ? 'active' : ''}`}>
                      <input type="checkbox" checked={newCategories.includes(cat)} onChange={() => toggleCategory(cat)} />
                      {cat}
                    </label>
                  ))}
                </div>
              </div>
              <div className="fm-form-row">
                <label>Endpoint de dados (opcional — obrigatório para telas dinâmicas)</label>
                <input
                  type="text"
                  value={newEndpointUri}
                  onChange={(e) => setNewEndpointUri(e.target.value)}
                  placeholder="https://seu-dominio.com/api/webhook/flows/SEU_PHONE_NUMBER_ID"
                />
              </div>
            </div>
            <div className="fm-modal-footer">
              <button className="fm-btn fm-btn-ghost" onClick={() => setShowCreate(false)}>Cancelar</button>
              <button className="fm-btn fm-btn-primary" onClick={handleCreate} disabled={creating}>
                {creating ? 'Criando...' : 'Criar Flow'}
              </button>
            </div>
          </div>
        </div>
      )}

      {endpointModalFlow && (
        <div className="fm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setEndpointModalFlow(null)}>
          <div className="fm-modal">
            <div className="fm-modal-header">
              <h3>Endpoint de dados — {endpointModalFlow.name}</h3>
              <button className="fm-icon-btn" onClick={() => setEndpointModalFlow(null)}><MdClose size={20} /></button>
            </div>
            <div className="fm-modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                URL pública que a Meta vai chamar quando esse Flow precisar trocar dados com o servidor.
                Formato: <code>https://seu-dominio.com/api/webhook/flows/SEU_PHONE_NUMBER_ID</code>
              </p>
              {endpointError && <div className="fm-error">⚠️ {endpointError}</div>}
              <input
                type="text"
                placeholder="https://seu-dominio.com/api/webhook/flows/..."
                value={endpointUriInput}
                onChange={(e) => setEndpointUriInput(e.target.value)}
              />
            </div>
            <div className="fm-modal-footer">
              <button className="fm-btn fm-btn-ghost" onClick={() => setEndpointModalFlow(null)}>Cancelar</button>
              <button className="fm-btn fm-btn-primary" onClick={handleSaveEndpointUri} disabled={savingEndpoint}>
                {savingEndpoint ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {jsonModalFlow && (
        <div className="fm-modal-overlay" onClick={(e) => e.target === e.currentTarget && setJsonModalFlow(null)}>
          <div className="fm-modal fm-modal-wide">
            <div className="fm-modal-header">
              <h3>FLOW_JSON — {jsonModalFlow.name}</h3>
              <button className="fm-icon-btn" onClick={() => setJsonModalFlow(null)}><MdClose size={20} /></button>
            </div>
            <div className="fm-modal-body">
              {jsonError && <div className="fm-error">⚠️ {jsonError}</div>}
              <textarea
                className="fm-json-textarea"
                rows={16}
                placeholder='{"version": "6.3", "screens": [...]}'
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
              />
            </div>
            <div className="fm-modal-footer">
              <button className="fm-btn fm-btn-ghost" onClick={() => setJsonModalFlow(null)}>Cancelar</button>
              <button className="fm-btn fm-btn-primary" onClick={handleUploadJson} disabled={uploadingJson}>
                {uploadingJson ? 'Enviando...' : 'Enviar JSON'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FlowManager;
