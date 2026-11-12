/**
 * FlowSender Component - Interface para enviar Flows (formulários interativos)
 *
 * Flows permitem criar formulários complexos no WhatsApp. Ao digitar o Flow
 * ID, buscamos automaticamente os campos definidos nesse Flow (o FLOW_JSON
 * já publicado na Meta) e montamos um formulário de verdade — sem o usuário
 * precisar escrever JSON na mão. Quando não é possível descobrir os campos
 * (Flow sem JSON publicado, etc.), cai no modo avançado com JSON cru.
 */
import React, { useState, useEffect } from 'react';
import { MdClose, MdSend, MdRefresh, MdInfoOutline } from 'react-icons/md';
import { BsFileText } from 'react-icons/bs';
import apiService, { api } from '../services/api';
import '../styles/FlowSender.css';

const FlowSender = ({ conversation, onClose, onSent }) => {
  const [flowId, setFlowId] = useState('');
  const [flowCta, setFlowCta] = useState('Preencher Formulário');
  const [screen, setScreen] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [footerText, setFooterText] = useState('');

  // Flows publicados disponíveis pra escolher numa lista (em vez de colar o ID na mão)
  const [availableFlows, setAvailableFlows] = useState([]);
  const [loadingFlows, setLoadingFlows] = useState(true);
  const [useManualId, setUseManualId] = useState(false);

  // Campos descobertos automaticamente a partir do FLOW_JSON do Flow.
  // null = ainda não buscou; [] = buscou e não achou nenhum campo.
  const [discoveredFields, setDiscoveredFields] = useState(null);
  const [discoveredScreenId, setDiscoveredScreenId] = useState(null);
  const [fieldValues, setFieldValues] = useState({});
  const [fetchingFields, setFetchingFields] = useState(false);
  const [fieldsFetchError, setFieldsFetchError] = useState(null);
  const [advancedMode, setAdvancedMode] = useState(false);

  // Flow Action Payload (dados pré-preenchidos) — modo avançado (JSON cru)
  const [actionPayload, setActionPayload] = useState('{}');

  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  // Validar JSON do payload
  const isValidJSON = (str) => {
    try {
      JSON.parse(str);
      return true;
    } catch (e) {
      return false;
    }
  };

  useEffect(() => {
    (async () => {
      setLoadingFlows(true);
      try {
        const res = await apiService.getFlows();
        const published = (res.data || []).filter(f => f.status === 'PUBLISHED');
        setAvailableFlows(published);
        if (published.length === 0) setUseManualId(true); // nada publicado ainda — só resta colar o ID
      } catch (e) {
        setUseManualId(true);
      } finally {
        setLoadingFlows(false);
      }
    })();
  }, []);

  const handlePickFlow = (id) => {
    setFlowId(id);
    if (id) fetchFields(id);
  };

  const fetchFields = async (idOverride) => {
    const id = (idOverride || flowId).trim();
    if (!id) return;
    setFetchingFields(true);
    setFieldsFetchError(null);
    try {
      const res = await apiService.getFlowFields(id);
      const fields = res.fields || [];
      setDiscoveredFields(fields);
      setDiscoveredScreenId(res.screen_id || null);
      setFieldValues(Object.fromEntries(fields.map(f => [f.name, ''])));
      if (fields.length === 0) {
        setAdvancedMode(true); // nada pra mostrar automaticamente — cai no JSON
      } else {
        setAdvancedMode(false);
      }
    } catch (e) {
      setDiscoveredFields([]);
      setFieldsFetchError('Não conseguimos buscar os campos automaticamente desse Flow.');
      setAdvancedMode(true);
    } finally {
      setFetchingFields(false);
    }
  };

  const buildPayloadFromFields = () => {
    const payload = {};
    (discoveredFields || []).forEach(f => { payload[f.name] = fieldValues[f.name] || ''; });
    return payload;
  };

  // A Meta (e nosso backend) exigem flow_action_payload no formato
  // {screen, data} — nunca os dados soltos. Sem isso o request quebra com
  // 422 antes mesmo de chegar na Meta.
  const getErrorMessage = (err) => {
    const detail = err?.response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map(d => d?.msg || JSON.stringify(d)).join('; ');
    if (detail) return JSON.stringify(detail);
    return err?.message || 'Erro ao enviar Flow';
  };

  const handleSend = async () => {
    // Validações
    if (!conversation || !conversation.contact) {
      setError('Selecione uma conversa primeiro');
      return;
    }

    if (!flowId.trim()) {
      setError('Flow ID é obrigatório');
      return;
    }

    if (!bodyText.trim()) {
      setError('Texto do corpo é obrigatório');
      return;
    }

    const screenId = discoveredScreenId || screen.trim();
    if (!screenId) {
      setError('Não conseguimos identificar a tela inicial do Flow — preencha o campo "Screen ID" manualmente.');
      return;
    }

    const usingFields = discoveredFields && discoveredFields.length > 0 && !advancedMode;
    let flowData;

    if (usingFields) {
      const missing = discoveredFields.filter(f => f.required && !(fieldValues[f.name] || '').trim());
      if (missing.length > 0) {
        setError(`Preencha os campos obrigatórios: ${missing.map(f => f.label).join(', ')}`);
        return;
      }
      flowData = buildPayloadFromFields();
    } else if (!isValidJSON(actionPayload)) {
      setError('Dados pré-preenchidos devem ser um JSON válido');
      return;
    } else {
      flowData = JSON.parse(actionPayload);
    }

    try {
      setSending(true);
      setError(null);

      const payload = {
        to: conversation.contact.wa_id,
        flow_id: flowId,
        flow_cta: flowCta,
        body_text: bodyText,
        flow_action_payload: { screen: screenId, data: flowData },
      };

      if (headerText) payload.header_text = headerText;
      if (footerText) payload.footer_text = footerText;

      const response = await api.post('/api/extended/send/flow', payload);

      console.log('Flow enviado:', response.data);
      setSuccess(true);
      onSent?.();

      // Limpar formulário após 2 segundos e fechar
      setTimeout(() => {
        setSuccess(false);
        handleClose();
      }, 2000);

    } catch (err) {
      console.error('Erro ao enviar Flow:', err);
      setError(getErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    // Resetar estados
    setFlowId('');
    setFlowCta('Preencher Formulário');
    setScreen('');
    setBodyText('');
    setHeaderText('');
    setFooterText('');
    setActionPayload('{}');
    setDiscoveredFields(null);
    setDiscoveredScreenId(null);
    setFieldValues({});
    setFieldsFetchError(null);
    setAdvancedMode(false);
    setError(null);
    setSuccess(false);
    onClose();
  };

  // Exemplos de payload (modo avançado)
  const examplePayloads = {
    empty: '{}',
    registration: JSON.stringify({
      name: '',
      email: '',
      phone: ''
    }, null, 2),
    appointment: JSON.stringify({
      date: '',
      time: '',
      service: ''
    }, null, 2),
    feedback: JSON.stringify({
      rating: '',
      comment: ''
    }, null, 2)
  };

  const loadExample = (type) => {
    setActionPayload(examplePayloads[type]);
  };

  const hasFields = discoveredFields && discoveredFields.length > 0;

  return (
    <div className="flow-sender-overlay" onClick={handleClose}>
      <div className="flow-sender-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flow-sender-header">
          <div className="flow-sender-title">
            <BsFileText size={24} />
            <h2>Enviar Flow</h2>
          </div>
          <button className="flow-sender-close" onClick={handleClose}>
            <MdClose size={24} />
          </button>
        </div>

        {/* Body */}
        <div className="flow-sender-body">
          {/* Informações do destinatário */}
          <div className="flow-sender-recipient">
            <span className="flow-sender-label">Enviar para:</span>
            <span className="flow-sender-contact">
              {conversation?.contact?.name || 'Selecione uma conversa'}
            </span>
          </div>

          {/* Flow */}
          <div className="flow-sender-field">
            <label>Flow *</label>

            {loadingFlows ? (
              <small>Carregando flows publicados...</small>
            ) : !useManualId ? (
              <>
                <select
                  value={flowId}
                  onChange={(e) => handlePickFlow(e.target.value)}
                >
                  <option value="">Selecione um Flow...</option>
                  {availableFlows.map(f => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
                {fetchingFields && <small>Buscando os campos desse Flow...</small>}
                <button type="button" className="flow-sender-example-btn" onClick={() => setUseManualId(true)} style={{ marginTop: 6 }}>
                  Colar o ID manualmente
                </button>
              </>
            ) : (
              <>
                <span className="flow-sender-help">
                  {availableFlows.length === 0
                    ? 'Nenhum Flow publicado encontrado — cole o ID manualmente (Configurações → Flows, ou Meta Business Manager)'
                    : 'Cole o Flow ID (ex: de outra conta)'}
                </span>
                <div className="flow-sender-id-row">
                  <input
                    type="text"
                    placeholder="Ex: 123456789012345"
                    value={flowId}
                    onChange={(e) => { setFlowId(e.target.value); setDiscoveredFields(null); setDiscoveredScreenId(null); }}
                    onBlur={() => fetchFields()}
                  />
                  <button
                    type="button"
                    className="flow-sender-fetch-btn"
                    onClick={() => fetchFields()}
                    disabled={!flowId.trim() || fetchingFields}
                    title="Buscar campos deste Flow"
                  >
                    <MdRefresh size={16} className={fetchingFields ? 'flow-sender-spin' : ''} />
                  </button>
                </div>
                {availableFlows.length > 0 && (
                  <button type="button" className="flow-sender-example-btn" onClick={() => setUseManualId(false)} style={{ marginTop: 6 }}>
                    ← Escolher da lista
                  </button>
                )}
              </>
            )}
          </div>

          {/* Flow CTA */}
          <div className="flow-sender-field">
            <label>
              Texto do Botão *
            </label>
            <input
              type="text"
              placeholder="Ex: Preencher Formulário"
              value={flowCta}
              onChange={(e) => setFlowCta(e.target.value)}
              maxLength={20}
            />
            <small>{flowCta.length}/20 caracteres</small>
          </div>

          {/* Body Text */}
          <div className="flow-sender-field">
            <label>
              Texto do Corpo *
            </label>
            <textarea
              placeholder="Ex: Por favor, preencha este formulário para continuar"
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={3}
              maxLength={1024}
            />
            <small>{bodyText.length}/1024 caracteres</small>
          </div>

          {/* Header Text (Opcional) */}
          <div className="flow-sender-field">
            <label>
              Cabeçalho
              <span className="flow-sender-optional">(opcional)</span>
            </label>
            <input
              type="text"
              placeholder="Ex: Cadastro de Cliente"
              value={headerText}
              onChange={(e) => setHeaderText(e.target.value)}
              maxLength={60}
            />
            <small>{headerText.length}/60 caracteres</small>
          </div>

          {/* Footer Text (Opcional) */}
          <div className="flow-sender-field">
            <label>
              Rodapé
              <span className="flow-sender-optional">(opcional)</span>
            </label>
            <input
              type="text"
              placeholder="Ex: Seus dados estão seguros"
              value={footerText}
              onChange={(e) => setFooterText(e.target.value)}
              maxLength={60}
            />
            <small>{footerText.length}/60 caracteres</small>
          </div>

          {/* Screen (Opcional) */}
          <div className="flow-sender-field">
            <label>
              Screen ID
              <span className="flow-sender-optional">(opcional)</span>
            </label>
            <input
              type="text"
              placeholder="Ex: REGISTRATION_SCREEN"
              value={screen}
              onChange={(e) => setScreen(e.target.value)}
            />
          </div>

          {/* Campos pré-preenchidos — automáticos ou modo avançado (JSON) */}
          <div className="flow-sender-field">
            <label>
              Dados pré-preenchidos
              <span className="flow-sender-help">
                (o que já vai vir preenchido quando o cliente abrir o formulário)
              </span>
            </label>

            {fetchingFields && <small>Buscando os campos desse Flow...</small>}
            {fieldsFetchError && <small className="error-text">{fieldsFetchError}</small>}

            {hasFields && !advancedMode ? (
              <>
                <span className="flow-sender-var-hint">
                  <MdInfoOutline size={13} /> Esses são os campos que esse Flow espera. Preencha o que
                  já souber sobre o cliente — o resto ele preenche direto no formulário.
                </span>
                {discoveredFields.map(f => (
                  <div key={f.name} className="flow-sender-dynamic-field">
                    <label>
                      {f.label}{f.required && ' *'}
                      <span className="flow-sender-field-name">{f.name}</span>
                    </label>
                    <input
                      type="text"
                      value={fieldValues[f.name] || ''}
                      onChange={(e) => setFieldValues(v => ({ ...v, [f.name]: e.target.value }))}
                      placeholder={f.required ? 'obrigatório' : 'opcional'}
                    />
                  </div>
                ))}
                <button type="button" className="flow-sender-example-btn" onClick={() => setAdvancedMode(true)}>
                  Prefiro editar como JSON
                </button>
              </>
            ) : (
              <>
                {hasFields && (
                  <button type="button" className="flow-sender-example-btn" onClick={() => setAdvancedMode(false)}>
                    ← Usar os campos detectados
                  </button>
                )}
                {/* Botões de exemplo */}
                <div className="flow-sender-examples">
                  <button type="button" onClick={() => loadExample('empty')} className="flow-sender-example-btn">Vazio</button>
                  <button type="button" onClick={() => loadExample('registration')} className="flow-sender-example-btn">Cadastro</button>
                  <button type="button" onClick={() => loadExample('appointment')} className="flow-sender-example-btn">Agendamento</button>
                  <button type="button" onClick={() => loadExample('feedback')} className="flow-sender-example-btn">Feedback</button>
                </div>

                <textarea
                  placeholder='{"campo1": "valor1", "campo2": "valor2"}'
                  value={actionPayload}
                  onChange={(e) => setActionPayload(e.target.value)}
                  rows={6}
                  className={!isValidJSON(actionPayload) ? 'invalid' : ''}
                />
                {!isValidJSON(actionPayload) && (
                  <small className="error-text">JSON inválido</small>
                )}
              </>
            )}
          </div>

          {/* Mensagens de erro/sucesso */}
          {error && (
            <div className="flow-sender-error">
              ⚠️ {error}
            </div>
          )}

          {success && (
            <div className="flow-sender-success">
              ✅ Flow enviado com sucesso!
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flow-sender-footer">
          <button
            className="flow-sender-btn-cancel"
            onClick={handleClose}
            disabled={sending}
          >
            Cancelar
          </button>
          <button
            className="flow-sender-btn-send"
            onClick={handleSend}
            disabled={sending || !flowId || !bodyText || ((!hasFields || advancedMode) && !isValidJSON(actionPayload))}
          >
            {sending ? (
              <>
                <div className="flow-sender-spinner" />
                Enviando...
              </>
            ) : (
              <>
                <MdSend />
                Enviar Flow
              </>
            )}
          </button>
        </div>

        {/* Instruções */}
        <div className="flow-sender-instructions">
          <strong>📖 Como obter o Flow ID:</strong>
          <ol>
            <li>Acesse <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer">Meta Business Manager</a> (ou Configurações → Flows, aqui no app)</li>
            <li>Navegue até WhatsApp Manager → Flows</li>
            <li>Crie ou selecione um Flow existente</li>
            <li>Publique o Flow</li>
            <li>Copie o Flow ID de 15 dígitos e cole aqui — os campos aparecem automaticamente</li>
          </ol>
        </div>
      </div>
    </div>
  );
};

export default FlowSender;
