/**
 * TemplateSender.js — v2.0
 *
 * Melhorias em relação à versão anterior:
 *  Carrega templates REAIS da Meta API via /api/templates
 *  Fallback automático para exemplos quando API indisponível
 *  Busca e filtro por categoria (MARKETING / UTILITY / AUTHENTICATION)
 *  Badge de origem (API real vs exemplo)
 *  Botão "Sincronizar" para forçar re-fetch
 *  Preview fiel com substituição de variáveis em tempo real
 *  Suporte a HEADER texto e imagem, BODY, FOOTER, BUTTONS
 *  Melhor UX: loading skeleton, empty state, erro tratado
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  MdClose, MdSend, MdSearch, MdRefresh, MdCheckCircle,
  MdError, MdOutlinePhone, MdFilterList, MdInfoOutline,
} from 'react-icons/md';
import { BsFileText, BsImageFill, BsCheckAll, BsUpload } from 'react-icons/bs';
import apiService from '../services/api';
import '../styles/TemplateSender.css';

// ─── Helpers ──────────────────────────────────────────────────────

const CATEGORY_CONFIG = {
  MARKETING:      { label: 'Marketing',      color: '#E01E5A', bg: 'rgba(224,30,90,.12)' },
  UTILITY:        { label: 'Utilidade',      color: '#2FAE60', bg: 'rgba(37,211,102,.12)' },
  AUTHENTICATION: { label: 'Autenticação',   color: '#34B7F1', bg: 'rgba(52,183,241,.12)' },
};

const STATUS_CONFIG = {
  APPROVED: { label: 'Aprovado', color: '#2FAE60' },
  PENDING:  { label: 'Pendente', color: '#ECB22E' },
  REJECTED: { label: 'Rejeitado', color: '#F44336' },
};

/** Extrai índices {{N}} de um texto e retorna os nomes dos campos */
function extractVarNames(components) {
  const vars = {};
  for (const comp of components) {
    if (!['BODY', 'HEADER', 'FOOTER'].includes(comp.type)) continue;
    
    // Suporte para mídia no header
    if (comp.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(comp.format)) {
      vars['header_media_url'] = '';
    }

    const text = comp.text || '';
    const matches = text.match(/\{\{(\d+)\}\}/g) || [];
    matches.forEach(m => {
      const idx = parseInt(m.replace(/[{}]/g, ''), 10);
      vars[`${comp.type.toLowerCase()}_var_${idx}`] = '';
    });
  }
  return vars;
}

/** Substitui {{N}} pelo valor digitado no preview */
function interpolate(text, vars, prefix) {
  if (!text) return '';
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const key = `${prefix}_var_${n}`;
    return vars[key] ? `*${vars[key]}*` : `{{${n}}}`;
  });
}

/** Valida número de telefone */
function isValidPhone(num) {
  return /^\+?[1-9]\d{9,14}$/.test(num.replace(/\D/g, ''));
}

// ─── Componente principal ─────────────────────────────────────────

const TemplateSender = ({ onClose, initialPhoneNumber = '', accountId = null, onSent }) => {
  // ── Estado principal ──
  const [templates,     setTemplates]    = useState([]);
  const [loading,       setLoading]      = useState(true);
  const [syncing,       setSyncing]      = useState(false);
  const [apiSource,     setApiSource]    = useState('');    // 'meta_api' | 'cache' | 'fallback'

  // ── Filtros ──
  const [search,        setSearch]       = useState('');
  const [filterCat,     setFilterCat]    = useState('ALL');

  // ── Seleção / formulário ──
  const [selected,      setSelected]     = useState(null);
  const [templateVars,  setTemplateVars] = useState({});
  const [varLabels,     setVarLabels]    = useState({}); // { "1": "Nome do cliente", ... } — definido na criação do template
  const [phone,         setPhone]        = useState(initialPhoneNumber);

  // ── Envio ──
  const [sending,       setSending]      = useState(false);
  const [sendResult,    setSendResult]   = useState(null); // { ok, message }
  const [error,         setError]        = useState(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);

  // ── Carregar templates ─────────────────────────────────────────
  const loadTemplates = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiService.getTemplates({ forceRefresh });
      setTemplates(data.templates || []);
      setApiSource(data.source || '');
    } catch (err) {
      console.error('[TemplateSender] Erro ao carregar templates:', err);
      setError('Não foi possível carregar os templates. Verifique as credenciais Meta.');
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await apiService.syncTemplates();
      await loadTemplates(true);
    } catch {
      setError('Falha ao sincronizar. Verifique as credenciais Meta.');
    } finally {
      setSyncing(false);
    }
  };

  // ── Filtro / busca ─────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = templates.filter(t => t.status === 'APPROVED');
    if (filterCat !== 'ALL') list = list.filter(t => t.category === filterCat);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.name.toLowerCase().includes(q) ||
        (t.components || []).some(c => (c.text || '').toLowerCase().includes(q))
      );
    }
    return list;
  }, [templates, filterCat, search]);

  // ── Seleção de template ─────────────────────────────────────────
  const handleSelect = (tpl) => {
    setSelected(tpl);

    const vars = extractVarNames(tpl.components || []);

    // Tenta recuperar do localStorage a última imagem usada para este template
    if (vars.hasOwnProperty('header_media_url')) {
      const cachedUrl = localStorage.getItem(`template_media_${tpl.name}`);
      if (cachedUrl) {
        vars['header_media_url'] = cachedUrl;
      }
    }

    setTemplateVars(vars);
    setVarLabels({});
    apiService.getTemplateVariableLabels(tpl.name, tpl.language || 'pt_BR')
      .then(setVarLabels)
      .catch(() => setVarLabels({}));
    setSendResult(null);
    setError(null);
  };

  const handleVarChange = (key, value) => {
    setTemplateVars(prev => ({ ...prev, [key]: value }));
    
    // Salva automaticamente no cache se for a imagem do header
    if (key === 'header_media_url' && selected?.name) {
      localStorage.setItem(`template_media_${selected.name}`, value);
    }
  };

  // ── Envio ────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!selected || !isValidPhone(phone)) return;
    setSending(true);
    setSendResult(null);
    setError(null);

    try {
      // Monta components para a API
      const components = (selected.components || [])
        .filter(c => ['HEADER', 'BODY'].includes(c.type) && (c.text || c.format))
        .map(c => {
          const prefix = c.type.toLowerCase();
          
          if (c.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format)) {
            const url = templateVars['header_media_url'];
            if (!url) return null;
            const paramType = c.format.toLowerCase();
            return {
              type: 'header',
              parameters: [
                {
                  type: paramType,
                  [paramType]: { link: url }
                }
              ]
            };
          }

          const matches = (c.text || '').match(/\{\{(\d+)\}\}/g) || [];
          if (!matches.length) return null;
          return {
            type: c.type.toLowerCase(),
            parameters: matches.map((m) => {
              const n = parseInt(m.replace(/[{}]/g, ''), 10);
              return {
                type: 'text',
                text: templateVars[`${prefix}_var_${n}`] || '',
              };
            }),
          };
        })
        .filter(Boolean);

      const cleanPhone = phone.replace(/\D/g, '');
      await apiService.sendTemplate(
        cleanPhone,
        selected.name,
        selected.language || 'pt_BR',
        components,
        accountId
      );

      setSendResult({ ok: true, message: 'Template enviado com sucesso!' });
      onSent?.();
      setTimeout(onClose, 2200);
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || 'Erro ao enviar template';
      setSendResult({ ok: false, message: msg });
    } finally {
      setSending(false);
    }
  };

  // ── Helpers de UI ────────────────────────────────────────────────
  const canSend = selected && isValidPhone(phone) && !sending && !sendResult?.ok;
  const phoneClean = phone.replace(/\D/g, '');
  const phoneBad   = phone.length > 0 && !isValidPhone(phone);

  // ── Preview do template ──────────────────────────────────────────
  const renderPreview = () => {
    if (!selected) return null;
    const comps = selected.components || [];
    return (
      <div className="ts-preview-wrap">
        <span className="ts-preview-label">Pré-visualização</span>
        <div className="ts-bubble">
          {comps.map((c, i) => {
            if (c.type === 'HEADER') return (
              <div key={i} className="ts-preview-header">
                {c.format === 'IMAGE'
                  ? <div className="ts-preview-img-placeholder"><BsImageFill size={20} /> Imagem do header</div>
                  : <strong>{interpolate(c.text, templateVars, 'header')}</strong>
                }
              </div>
            );
            if (c.type === 'BODY') return (
              <div key={i} className="ts-preview-body">
                {interpolate(c.text, templateVars, 'body').split('\n').map((line, j) => (
                  <span key={j}>{line}<br/></span>
                ))}
              </div>
            );
            if (c.type === 'FOOTER') return (
              <div key={i} className="ts-preview-footer">
                {interpolate(c.text, templateVars, 'footer')}
              </div>
            );
            if (c.type === 'BUTTONS') return (
              <div key={i} className="ts-preview-buttons">
                {(c.buttons || []).map((btn, j) => (
                  <div key={j} className="ts-preview-btn">{btn.text}</div>
                ))}
              </div>
            );
            return null;
          })}
        </div>
      </div>
    );
  };

  // ── Variáveis do template ────────────────────────────────────────
  const varEntries = Object.entries(templateVars);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="ts-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ts-modal">

        {/* Header */}
        <div className="ts-header">
          <div className="ts-header-left">
            <BsFileText size={20} />
            <div>
              <h2>Enviar Template</h2>
              <span className="ts-source-badge">
                {apiSource === 'meta_api' && '✓ Templates da Meta API'}
                {apiSource === 'cache'    && '✓ Cache local (30 min)'}
                {apiSource === 'fallback' && '⚠ Exemplos — configure credenciais'}
                {apiSource === 'stale_cache' && '⚠ Cache desatualizado'}
              </span>
            </div>
          </div>
          <div className="ts-header-actions">
            <button
              className="ts-icon-btn"
              onClick={handleSync}
              disabled={syncing}
              title="Sincronizar templates com a Meta"
            >
              <MdRefresh size={18} className={syncing ? 'ts-spin' : ''} />
            </button>
            <button className="ts-icon-btn" onClick={onClose}>
              <MdClose size={20} />
            </button>
          </div>
        </div>

        <div className="ts-body">

          {/* ── Coluna esquerda: lista de templates ── */}
          <div className="ts-col-list">

            {/* Busca + filtro */}
            <div className="ts-search-row">
              <div className="ts-search-wrap">
                <MdSearch size={16} />
                <input
                  placeholder="Buscar template..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="ts-filter-wrap">
                <MdFilterList size={15} />
                <select value={filterCat} onChange={e => setFilterCat(e.target.value)}>
                  <option value="ALL">Todos</option>
                  <option value="UTILITY">Utilidade</option>
                  <option value="MARKETING">Marketing</option>
                  <option value="AUTHENTICATION">Autenticação</option>
                </select>
              </div>
            </div>

            {/* Lista */}
            <div className="ts-list">
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="ts-skeleton" />
                ))
              ) : filtered.length === 0 ? (
                <div className="ts-empty">
                  <BsFileText size={28} />
                  <p>{search ? 'Nenhum resultado' : 'Nenhum template aprovado'}</p>
                  {apiSource === 'fallback' && (
                    <span>Configure as credenciais Meta nas Configurações</span>
                  )}
                </div>
              ) : (
                filtered.map(tpl => {
                  const cat = CATEGORY_CONFIG[tpl.category] || CATEGORY_CONFIG.UTILITY;
                  const bodyComp = (tpl.components || []).find(c => c.type === 'BODY');
                  const preview = bodyComp?.text?.substring(0, 70) || '';
                  const isSelected = selected?.name === tpl.name;

                  return (
                    <button
                      key={tpl.name}
                      className={`ts-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleSelect(tpl)}
                    >
                      <div className="ts-card-top">
                        <span className="ts-card-name">{tpl.name}</span>
                        <span
                          className="ts-cat-badge"
                          style={{ color: cat.color, background: cat.bg }}
                        >
                          {cat.label}
                        </span>
                      </div>
                      {preview && (
                        <p className="ts-card-preview">
                          {preview}{preview.length === 70 ? '…' : ''}
                        </p>
                      )}
                      {tpl._source === 'fallback' && (
                        <span className="ts-example-badge">exemplo</span>
                      )}
                      {isSelected && <div className="ts-selected-dot" />}
                    </button>
                  );
                })
              )}
            </div>

            <p className="ts-count">
              {!loading && `${filtered.length} template${filtered.length !== 1 ? 's' : ''} encontrado${filtered.length !== 1 ? 's' : ''}`}
            </p>
          </div>

          {/* ── Coluna direita: formulário ── */}
          <div className="ts-col-form">
            {!selected ? (
              <div className="ts-placeholder">
                <BsFileText size={36} />
                <p>Selecione um template ao lado</p>
              </div>
            ) : (
              <>
                {/* Destino */}
                <div className="ts-field">
                  <label><MdOutlinePhone size={14} /> Número de destino *</label>
                  <input
                    type="tel"
                    placeholder="+55 44 99999-9999"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    className={phoneBad ? 'invalid' : ''}
                  />
                  {phoneBad && <small className="ts-field-err">Número inválido (inclua DDD e código do país)</small>}
                </div>

                {/* Variáveis */}
                {varEntries.length > 0 && (
                  <div className="ts-field">
                    <label>Variáveis do template</label>
                    <div className="ts-vars-grid">
                      {varEntries.map(([key]) => {
                        if (key === 'header_media_url') {
                          return (
                            <div key={key} className="ts-var-row" style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                              <span className="ts-var-label">
                                HEADER <strong>Mídia (Imagem/Vídeo)</strong>
                              </span>
                              <div style={{ display: 'flex', gap: '5px' }}>
                                <input
                                  placeholder="Link público ou faça upload ->"
                                  value={templateVars[key]}
                                  onChange={e => handleVarChange(key, e.target.value)}
                                  style={{ flex: 1 }}
                                />
                                <label className="ts-icon-btn" style={{ cursor: 'pointer', padding: '0 10px', background: 'var(--whatsapp-teal)', color: 'white', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  {uploadingMedia ? <MdRefresh className="ts-spin" size={16} /> : <BsUpload size={16} title="Fazer Upload de Arquivo" />}
                                  <input 
                                    type="file" 
                                    accept="image/*,video/*,application/pdf" 
                                    style={{ display: 'none' }}
                                    onChange={async (e) => {
                                      const file = e.target.files[0];
                                      if (!file) return;
                                      setUploadingMedia(true);
                                      try {
                                        const res = await apiService.uploadPublicMedia(file);
                                        if (res && res.url) {
                                          handleVarChange(key, res.url);
                                        }
                                      } catch (err) {
                                        alert("Falha no upload do arquivo.");
                                      } finally {
                                        setUploadingMedia(false);
                                      }
                                    }}
                                  />
                                </label>
                              </div>
                            </div>
                          );
                        }
                        const parts = key.split('_var_');
                        const comp  = parts[0].toUpperCase();
                        const idx   = parts[1];
                        const label = comp === 'BODY' ? varLabels[idx] : null;
                        return (
                          <div key={key} className="ts-var-row">
                            <span className="ts-var-label">
                              {label ? (
                                <>
                                  <strong>{label}</strong> <span className="ts-var-sublabel">({comp.toLowerCase()} {'{{'+idx+'}}'})</span>
                                </>
                              ) : (
                                <>{comp} <strong>{'{{'+idx+'}}'}</strong></>
                              )}
                            </span>
                            <input
                              placeholder={label ? `Digite: ${label}` : `Valor da variável ${idx}`}
                              value={templateVars[key]}
                              onChange={e => handleVarChange(key, e.target.value)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Preview */}
                {renderPreview()}

                {/* Resultado do envio */}
                {sendResult && (
                  <div className={`ts-result ${sendResult.ok ? 'ok' : 'err'}`}>
                    {sendResult.ok
                      ? <><MdCheckCircle size={16} /> {sendResult.message}</>
                      : <><MdError size={16} /> {sendResult.message}</>
                    }
                  </div>
                )}

                {/* Info fallback */}
                {selected._source === 'fallback' && (
                  <div className="ts-info-box">
                    <MdInfoOutline size={14} />
                    <span>
                      Template de exemplo. Para usar seus templates reais, configure as
                      credenciais Meta em Configurações → Credenciais.
                    </span>
                  </div>
                )}

                {/* Botão enviar */}
                <button
                  className="ts-send-btn"
                  onClick={handleSend}
                  disabled={!canSend}
                >
                  {sending ? (
                    <><MdRefresh size={16} className="ts-spin" /> Enviando...</>
                  ) : sendResult?.ok ? (
                    <><BsCheckAll size={16} /> Enviado!</>
                  ) : (
                    <><MdSend size={16} /> Enviar Template</>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TemplateSender;
