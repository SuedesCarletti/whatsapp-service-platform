/**
 * TemplateManager.js
 *
 * Cria, lista e exclui templates de mensagem (HSM) direto na aplicação,
 * sem precisar abrir o Business Manager da Meta. Usa o CRUD que já existe
 * no backend (backend/api/routes_templates.py: POST/DELETE /api/templates).
 *
 * HEADER: nenhum, texto ou mídia (imagem/vídeo/documento — sobe um exemplo
 * via Resumable Upload API da Meta, precisa de FB_APP_ID configurado em
 * Configurações → App Meta). BODY, FOOTER, BOTÕES (quick reply, URL,
 * telefone). Variáveis do corpo usam var1/var2... com rótulo + exemplo,
 * ver TemplateVariableLabelModel no backend.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  MdAdd, MdDelete, MdRefresh, MdClose, MdCheckCircle, MdError,
  MdPending, MdInfoOutline, MdSend,
} from 'react-icons/md';
import apiService from '../services/api';
import '../styles/TemplateManager.css';

const CATEGORY_OPTIONS = [
  { value: 'UTILITY', label: 'Utilidade' },
  { value: 'MARKETING', label: 'Marketing' },
  { value: 'AUTHENTICATION', label: 'Autenticação' },
];

const LANGUAGE_OPTIONS = [
  { value: 'pt_BR', label: 'Português (BR)' },
  { value: 'en_US', label: 'Inglês (EUA)' },
  { value: 'es_ES', label: 'Espanhol' },
  { value: 'es_MX', label: 'Espanhol (México)' },
];

const STATUS_CONFIG = {
  APPROVED: { label: 'Aprovado', color: '#2FAE60', icon: <MdCheckCircle size={14} /> },
  PENDING:  { label: 'Pendente', color: '#ECB22E', icon: <MdPending size={14} /> },
  REJECTED: { label: 'Rejeitado', color: '#F44336', icon: <MdError size={14} /> },
};

const BUTTON_TYPES = [
  { value: 'QUICK_REPLY',   label: 'Resposta rápida' },
  { value: 'URL',           label: 'Link (URL)' },
  { value: 'PHONE_NUMBER',  label: 'Ligar (telefone)' },
];

const emptyForm = () => ({
  name: '',
  category: 'UTILITY',
  language: 'pt_BR',
  headerType: 'NONE', // NONE | TEXT | IMAGE | VIDEO | DOCUMENT
  headerText: '',
  headerMediaHandle: null,
  headerMediaFileName: '',
  bodyText: '',
  footerText: '',
  buttons: [],
  variables: [],
});

// Números de "varN" (var1, var2...) realmente escritos no texto do corpo —
// com \b (borda de palavra) pra "var1" não confundir com "var10".
function extractVarNumbersInText(text) {
  const matches = (text || '').match(/\bvar(\d+)\b/g) || [];
  const numbers = matches.map(m => parseInt(m.replace('var', ''), 10));
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

// Troca var1, var2... pelo formato {{1}}, {{2}}... que a Meta espera —
// o usuário nunca precisa ver/escrever chaves duplas.
function varTokensToMetaPlaceholders(text, count) {
  let result = text || '';
  for (let i = count; i >= 1; i--) {
    result = result.replace(new RegExp(`\\bvar${i}\\b`, 'g'), `{{${i}}}`);
  }
  return result;
}

function buildComponents(form) {
  const components = [];

  if (form.headerType === 'TEXT' && form.headerText.trim()) {
    components.push({ type: 'HEADER', format: 'TEXT', text: form.headerText.trim() });
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(form.headerType) && form.headerMediaHandle) {
    components.push({ type: 'HEADER', format: form.headerType, example: { header_handle: [form.headerMediaHandle] } });
  }

  const varCount = form.variables.length;
  const bodyComp = { type: 'BODY', text: varTokensToMetaPlaceholders(form.bodyText.trim(), varCount) };
  if (varCount > 0) {
    // Meta exige exemplo pra cada variável do BODY, senão a criação é rejeitada.
    bodyComp.example = { body_text: [form.variables.map((v, i) => v.example.trim() || `exemplo${i + 1}`)] };
  }
  components.push(bodyComp);

  if (form.footerText.trim()) {
    components.push({ type: 'FOOTER', text: form.footerText.trim() });
  }

  if (form.buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: form.buttons.map(b => {
        if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.url };
        if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
        return { type: 'QUICK_REPLY', text: b.text };
      }),
    });
  }

  return components;
}

function validateForm(form) {
  const errors = [];
  if (!/^[a-z0-9_]+$/.test(form.name)) {
    errors.push('Nome deve ter só letras minúsculas, números e underscore (ex: pedido_confirmado).');
  }
  if (!form.bodyText.trim()) {
    errors.push('Corpo da mensagem (BODY) é obrigatório.');
  }
  if (form.bodyText.length > 1024) {
    errors.push('Corpo da mensagem excede 1024 caracteres.');
  }
  if (form.headerType === 'TEXT' && !form.headerText.trim()) {
    errors.push('Escreva o texto do cabeçalho ou mude o tipo pra "Nenhum".');
  }
  if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(form.headerType) && !form.headerMediaHandle) {
    errors.push('Envie um arquivo de exemplo pro cabeçalho (ou mude o tipo pra "Nenhum").');
  }

  const varCount = form.variables.length;
  const usedInText = extractVarNumbersInText(form.bodyText);
  const expected = Array.from({ length: varCount }, (_, i) => i + 1);
  const missingInText = expected.filter(n => !usedInText.includes(n));
  const extraInText = usedInText.filter(n => !expected.includes(n));

  missingInText.forEach(n => errors.push(`Você adicionou a variável var${n} na lista, mas ela não aparece no texto do corpo. Escreva "var${n}" onde quiser que ela apareça.`));
  extraInText.forEach(n => errors.push(`Você escreveu "var${n}" no texto, mas não adicionou essa variável na lista abaixo. Clique em "Adicionar variável".`));

  form.variables.forEach((v, i) => {
    if (!v.label.trim()) errors.push(`Diga o que a var${i + 1} representa (ex: "Nome do cliente").`);
    if (!v.example.trim()) errors.push(`Dê um exemplo de valor pra var${i + 1}.`);
  });

  if (form.buttons.length > 3) {
    errors.push('Máximo de 3 botões por template.');
  }
  form.buttons.forEach((b, i) => {
    if (!b.text.trim()) errors.push(`Botão ${i + 1}: texto obrigatório.`);
    if (b.type === 'URL' && !b.url.trim()) errors.push(`Botão ${i + 1}: URL obrigatória.`);
    if (b.type === 'PHONE_NUMBER' && !b.phone_number.trim()) errors.push(`Botão ${i + 1}: telefone obrigatório.`);
  });
  return errors;
}

const TemplateManager = () => {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [formErrors, setFormErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [deletingName, setDeletingName] = useState(null);
  const [uploadingHeaderMedia, setUploadingHeaderMedia] = useState(false);
  const [headerMediaError, setHeaderMediaError] = useState('');

  useEffect(() => {
    (async () => {
      const all = await apiService.getAccounts();
      const metaAccounts = (all || []).filter(a => (a.provider_type || '').startsWith('meta'));
      setAccounts(metaAccounts);
      if (metaAccounts.length > 0) setAccountId(metaAccounts[0].id);
    })();
  }, []);

  const loadTemplates = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      const { templates: list } = await apiService.getTemplates({ forceRefresh, account_id: accountId || undefined });
      setTemplates(list);
    } catch (e) {
      console.error('Erro ao carregar templates:', e);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await apiService.syncTemplates();
      await loadTemplates(true);
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao sincronizar templates');
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = async (name) => {
    if (!window.confirm(`Excluir o template "${name}"? Isso remove todas as versões/idiomas dele na Meta.`)) return;
    setDeletingName(name);
    try {
      await apiService.deleteTemplate(name, accountId);
      await loadTemplates(true);
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao excluir template');
    } finally {
      setDeletingName(null);
    }
  };

  const addButton = () => {
    if (form.buttons.length >= 3) return;
    setForm(f => ({ ...f, buttons: [...f.buttons, { type: 'QUICK_REPLY', text: '', url: '', phone_number: '' }] }));
  };

  const updateButton = (idx, patch) => {
    setForm(f => ({
      ...f,
      buttons: f.buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    }));
  };

  const removeButton = (idx) => {
    setForm(f => ({ ...f, buttons: f.buttons.filter((_, i) => i !== idx) }));
  };

  const addVariable = () => {
    if (form.variables.length >= 10) return;
    setForm(f => ({ ...f, variables: [...f.variables, { label: '', example: '' }] }));
  };

  const updateVariable = (idx, patch) => {
    setForm(f => ({ ...f, variables: f.variables.map((v, i) => (i === idx ? { ...v, ...patch } : v)) }));
  };

  const removeVariable = (idx) => {
    setForm(f => ({ ...f, variables: f.variables.filter((_, i) => i !== idx) }));
  };

  const handleHeaderMediaChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setHeaderMediaError('');
    setUploadingHeaderMedia(true);
    try {
      const res = await apiService.uploadTemplateHeaderMedia(file, accountId);
      setForm(f => ({ ...f, headerMediaHandle: res.header_handle, headerMediaFileName: file.name }));
    } catch (err) {
      setHeaderMediaError(err?.response?.data?.detail || 'Erro ao enviar o arquivo do cabeçalho');
      setForm(f => ({ ...f, headerMediaHandle: null, headerMediaFileName: '' }));
    } finally {
      setUploadingHeaderMedia(false);
    }
  };

  const handleSubmit = async () => {
    const errors = validateForm(form);
    setFormErrors(errors);
    if (errors.length > 0) return;

    setSubmitting(true);
    try {
      const components = buildComponents(form);
      await apiService.createTemplate({
        name: form.name,
        language: form.language,
        category: form.category,
        components,
        variable_labels: form.variables.map(v => v.label.trim()),
        account_id: accountId,
      });
      setShowForm(false);
      setForm(emptyForm());
      await loadTemplates(true);
    } catch (e) {
      const detail = e?.response?.data?.detail;
      setFormErrors([typeof detail === 'string' ? detail : 'Erro ao criar template na Meta']);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tm-container">
      <div className="tm-toolbar">
        <div className="tm-toolbar-left">
          {accounts.length > 1 && (
            <select
              className="tm-select"
              value={accountId || ''}
              onChange={(e) => setAccountId(Number(e.target.value))}
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.phone_number || `Conta #${a.id}`}</option>
              ))}
            </select>
          )}
          <button className="tm-btn tm-btn-ghost" onClick={handleSync} disabled={syncing}>
            <MdRefresh size={16} className={syncing ? 'tm-spin' : ''} /> Sincronizar
          </button>
        </div>
        <button className="tm-btn tm-btn-primary" onClick={() => { setForm(emptyForm()); setFormErrors([]); setShowForm(true); }}>
          <MdAdd size={18} /> Novo Template
        </button>
      </div>

      {loading ? (
        <div className="tm-empty">Carregando templates...</div>
      ) : templates.length === 0 ? (
        <div className="tm-empty">Nenhum template encontrado. Crie o primeiro com "Novo Template".</div>
      ) : (
        <div className="tm-list">
          {templates.map(t => {
            const st = STATUS_CONFIG[t.status] || { label: t.status, color: '#888', icon: null };
            return (
              <div key={`${t.name}_${t.language}`} className="tm-card">
                <div className="tm-card-main">
                  <div className="tm-card-name">{t.name}</div>
                  <div className="tm-card-meta">
                    <span className="tm-badge" style={{ color: st.color, borderColor: st.color }}>
                      {st.icon} {st.label}
                    </span>
                    <span className="tm-tag">{t.category}</span>
                    <span className="tm-tag">{t.language}</span>
                  </div>
                  {t.rejected_reason && t.rejected_reason !== 'NONE' && (
                    <div className="tm-rejected-reason">
                      <MdInfoOutline size={14} /> {t.rejected_reason}
                    </div>
                  )}
                </div>
                <button
                  className="tm-icon-btn tm-icon-btn-danger"
                  onClick={() => handleDelete(t.name)}
                  disabled={deletingName === t.name}
                  title="Excluir template"
                >
                  <MdDelete size={18} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div className="tm-form-overlay" onClick={(e) => e.target === e.currentTarget && setShowForm(false)}>
          <div className="tm-form-modal">
            <div className="tm-form-header">
              <h3><MdSend size={18} /> Novo Template</h3>
              <button className="tm-icon-btn" onClick={() => setShowForm(false)}><MdClose size={20} /></button>
            </div>

            <div className="tm-form-body">
              {formErrors.length > 0 && (
                <div className="tm-form-errors">
                  {formErrors.map((err, i) => <div key={i}>⚠️ {err}</div>)}
                </div>
              )}

              <div className="tm-form-row">
                <label>Nome (identificador único)</label>
                <input
                  type="text"
                  placeholder="ex: pedido_confirmado"
                  value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))}
                />
              </div>

              <div className="tm-form-row-split">
                <div className="tm-form-row">
                  <label>Categoria</label>
                  <select value={form.category} onChange={(e) => setForm(f => ({ ...f, category: e.target.value }))}>
                    {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="tm-form-row">
                  <label>Idioma</label>
                  <select value={form.language} onChange={(e) => setForm(f => ({ ...f, language: e.target.value }))}>
                    {LANGUAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="tm-form-row">
                <label>Cabeçalho (opcional)</label>
                <select
                  value={form.headerType}
                  onChange={(e) => setForm(f => ({ ...f, headerType: e.target.value, headerMediaHandle: null, headerMediaFileName: '' }))}
                >
                  <option value="NONE">Nenhum</option>
                  <option value="TEXT">Texto</option>
                  <option value="IMAGE">Imagem</option>
                  <option value="VIDEO">Vídeo</option>
                  <option value="DOCUMENT">Documento</option>
                </select>

                {form.headerType === 'TEXT' && (
                  <input
                    type="text"
                    placeholder="Título curto do template"
                    maxLength={60}
                    value={form.headerText}
                    onChange={(e) => setForm(f => ({ ...f, headerText: e.target.value }))}
                  />
                )}

                {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(form.headerType) && (
                  <div className="tm-header-media">
                    <span className="tm-var-hint">
                      <MdInfoOutline size={13} /> Envie um arquivo de exemplo — a Meta usa ele pra revisar o
                      template. Quem for enviar a mensagem depois pode escolher outro arquivo na hora do envio,
                      esse aqui é só o modelo pra aprovação.
                    </span>
                    <input
                      type="file"
                      accept={form.headerType === 'IMAGE' ? 'image/*' : form.headerType === 'VIDEO' ? 'video/*' : '.pdf,.doc,.docx'}
                      onChange={handleHeaderMediaChange}
                      disabled={uploadingHeaderMedia}
                    />
                    {uploadingHeaderMedia && <span className="tm-var-hint">Enviando...</span>}
                    {form.headerMediaFileName && !uploadingHeaderMedia && (
                      <span className="tm-var-hint"><MdCheckCircle size={13} color="#2FAE60" /> {form.headerMediaFileName} — pra trocar, escolha outro arquivo acima.</span>
                    )}
                    {headerMediaError && <span className="tm-var-hint" style={{ color: '#F44336' }}>{headerMediaError}</span>}
                  </div>
                )}
              </div>

              <div className="tm-form-row">
                <label>Corpo da mensagem — escreva var1, var2... onde quiser um dado que muda a cada envio</label>
                <textarea
                  rows={5}
                  placeholder={'Olá var1! Seu pedido #var2 foi confirmado.'}
                  value={form.bodyText}
                  onChange={(e) => setForm(f => ({ ...f, bodyText: e.target.value }))}
                />
                <span className="tm-var-hint">
                  <MdInfoOutline size={13} /> Em vez de nome fixo, você pode deixar um espaço que muda em cada
                  envio — por exemplo o nome do cliente ou o número do pedido. Pra isso, escreva{' '}
                  <code>var1</code> no lugar do primeiro dado, <code>var2</code> no segundo, e assim por diante.
                  Depois, adicione cada uma na lista abaixo (igual você faz com os botões).
                </span>
              </div>

              <div className="tm-form-row">
                <div className="tm-buttons-header">
                  <label>Variáveis usadas no corpo</label>
                  {form.variables.length < 10 && (
                    <button className="tm-btn tm-btn-ghost tm-btn-sm" onClick={addVariable}>
                      <MdAdd size={14} /> Adicionar variável
                    </button>
                  )}
                </div>

                <div className="tm-form-note">
                  <MdInfoOutline size={14} />
                  <span>
                    <strong>Não existe variável pré-pronta</strong> (tipo "nome do cliente automático") — o WhatsApp
                    não sabe o que var1 significa, é só um espaço em branco. É <strong>você</strong> quem decide o
                    que cada uma representa (dando um rótulo abaixo) e é <strong>você (ou quem for enviar)</strong>{' '}
                    quem digita o valor de verdade toda vez que manda a mensagem — pra um cliente vira "Maria", pro
                    outro vira "João". O rótulo só existe pra deixar claro, na hora de enviar, o que digitar em
                    cada campo.
                  </span>
                </div>

                {form.variables.length === 0 && (
                  <span className="tm-var-hint">Nenhuma variável ainda — clique em "Adicionar variável" se quiser usar var1, var2... no texto.</span>
                )}
                {form.variables.map((v, idx) => (
                  <div key={idx} className="tm-var-card">
                    <span className="tm-var-tag">{`var${idx + 1}`}</span>
                    <div className="tm-var-card-fields">
                      <input
                        type="text"
                        placeholder={idx === 0 ? 'O que isso representa? ex: Nome do cliente' : 'O que isso representa?'}
                        value={v.label}
                        onChange={(e) => updateVariable(idx, { label: e.target.value })}
                      />
                      <input
                        type="text"
                        placeholder={idx === 0 ? 'Exemplo de valor: Maria' : 'Exemplo de valor'}
                        value={v.example}
                        onChange={(e) => updateVariable(idx, { example: e.target.value })}
                      />
                    </div>
                    <button className="tm-icon-btn tm-icon-btn-danger" onClick={() => removeVariable(idx)}>
                      <MdDelete size={16} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="tm-form-row">
                <label>Rodapé (opcional)</label>
                <input
                  type="text"
                  placeholder="ex: Responda para falar conosco"
                  maxLength={60}
                  value={form.footerText}
                  onChange={(e) => setForm(f => ({ ...f, footerText: e.target.value }))}
                />
              </div>

              <div className="tm-form-row">
                <div className="tm-buttons-header">
                  <label>Botões (até 3)</label>
                  {form.buttons.length < 3 && (
                    <button className="tm-btn tm-btn-ghost tm-btn-sm" onClick={addButton}>
                      <MdAdd size={14} /> Adicionar botão
                    </button>
                  )}
                </div>
                {form.buttons.map((b, idx) => (
                  <div key={idx} className="tm-button-row">
                    <select value={b.type} onChange={(e) => updateButton(idx, { type: e.target.value })}>
                      {BUTTON_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <input
                      type="text"
                      placeholder="Texto do botão"
                      maxLength={25}
                      value={b.text}
                      onChange={(e) => updateButton(idx, { text: e.target.value })}
                    />
                    {b.type === 'URL' && (
                      <input
                        type="text"
                        placeholder="https://..."
                        value={b.url}
                        onChange={(e) => updateButton(idx, { url: e.target.value })}
                      />
                    )}
                    {b.type === 'PHONE_NUMBER' && (
                      <input
                        type="text"
                        placeholder="+5511999999999"
                        value={b.phone_number}
                        onChange={(e) => updateButton(idx, { phone_number: e.target.value })}
                      />
                    )}
                    <button className="tm-icon-btn tm-icon-btn-danger" onClick={() => removeButton(idx)}>
                      <MdDelete size={16} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="tm-form-note">
                <MdInfoOutline size={14} /> O template fica <strong>PENDENTE</strong> até a Meta aprovar (normalmente até 24h).
              </div>
            </div>

            <div className="tm-form-footer">
              <button className="tm-btn tm-btn-ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button className="tm-btn tm-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Enviando...' : 'Criar Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TemplateManager;
