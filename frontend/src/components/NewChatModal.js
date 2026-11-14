/**
 * NewChatModal — "Nova conversa": digita um número e abre o chat vazio, sem
 * mandar nenhuma mensagem sozinho (diferente da versão anterior deste
 * componente, que existia no código mas nunca foi conectado a nada — daí
 * "Novo Chat" sempre cair no alert de "em breve"). Mesmo comportamento do
 * WhatsApp Web real: a conversa/contato só nascem de verdade no banco
 * quando a 1ª mensagem for enviada (_get_contact_and_conversation no
 * backend já faz esse get-or-create, reaproveitado sem precisar de rota nova).
 *
 * Incidente real (2026-09-02): com várias contas WhatsApp ativas ao mesmo
 * tempo, era fácil não perceber qual delas ia mandar a primeira mensagem —
 * o valor default já era o da conta selecionada na sidebar (accountId), mas
 * nada na tela deixava isso visível nem dava chance de escolher outra antes
 * de confirmar. Agora mostra a conta de destino e, havendo mais de uma
 * ativa, permite trocar antes de "Iniciar conversa".
 */
import React, { useState, useEffect } from 'react';
import { BsX, BsSearch } from 'react-icons/bs';
import apiService from '../services/api';

const cleanPhone = (raw) => raw.replace(/\D/g, '');

const NewChatModal = ({ onClose, onStartChat, accountId }) => {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null); // null | 'exists' | 'exists_no_lid' | 'not_found' | 'unknown'
  const [accounts, setAccounts] = useState([]);
  const [chosenAccountId, setChosenAccountId] = useState(accountId || null);

  useEffect(() => {
    apiService.getAccounts()
      .then((list) => setAccounts((list || []).filter((a) => a.is_active)))
      .catch(() => setAccounts([]));
  }, []);

  // Se a conta selecionada na sidebar mudar enquanto o modal está aberto
  // (ou assim que a lista carregar), acompanha — só não sobrescreve depois
  // que o usuário já trocou manualmente no seletor abaixo.
  useEffect(() => {
    setChosenAccountId((prev) => prev ?? accountId ?? null);
  }, [accountId]);

  const handlePhoneChange = (e) => {
    setPhoneNumber(e.target.value);
    setCheckResult(null);
  };

  const handleVerify = async () => {
    const digits = cleanPhone(phoneNumber);
    if (digits.length < 8) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await apiService.checkPhoneExists(digits, chosenAccountId);
      // lid_exists vem null (não checado, provider não-WPPConnect) ou um bool
      // real (2026-09-10): quando false, essa é a PRIMEIRA vez que esta conta
      // fala com esse número e o WhatsApp ainda não expôs o LID (endereçamento
      // novo de multi-device) — o bridge WPPConnect quebra com "No LID for
      // user" ao tentar mandar (bug de lib sem correção disponível, ver
      // backend/api/routes.py::_friendly_send_error). Avisa ANTES de tentar,
      // já que depois de falhar o atendente só via um erro genérico.
      if (res?.exists && res?.lid_exists === false) {
        setCheckResult('exists_no_lid');
      } else {
        setCheckResult(res?.exists ? 'exists' : 'not_found');
      }
    } catch (err) {
      // Verificação é best-effort — nem todo provider/conta suporta (ex.:
      // Meta Cloud API não tem esse endpoint). Não bloqueia iniciar a conversa.
      setCheckResult('unknown');
    } finally {
      setChecking(false);
    }
  };

  const handleStart = () => {
    const digits = cleanPhone(phoneNumber);
    if (digits.length < 8) return;
    onStartChat(digits, chosenAccountId);
  };

  const digits = cleanPhone(phoneNumber);
  const canStart = digits.length >= 8;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Nova conversa</h3>
          <button className="icon-btn" onClick={onClose}><BsX size={24} /></button>
        </div>

        <div className="modal-body">
          {/* Conta de origem: default é sempre a selecionada na sidebar
              (accountId) — só aparece seletor quando há mais de uma conta
              ativa, pra confirmar/trocar antes de mandar a 1ª mensagem. */}
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            Enviar pela conta
          </label>
          {accounts.length > 1 ? (
            <select
              value={chosenAccountId ?? ''}
              onChange={(e) => setChosenAccountId(Number(e.target.value))}
              style={{ width: '100%', marginBottom: 14 }}
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.account_name} ({acc.phone_number})
                </option>
              ))}
            </select>
          ) : accounts.length === 1 ? (
            <div style={{ fontSize: 13, marginBottom: 14, color: 'var(--text-secondary, #888)' }}>
              {accounts[0].account_name} ({accounts[0].phone_number})
            </div>
          ) : null}

          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            Número do WhatsApp (com DDI e DDD)
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="Ex: 5511999999999"
              value={phoneNumber}
              onChange={handlePhoneChange}
              onKeyPress={(e) => e.key === 'Enter' && (canStart ? handleStart() : undefined)}
              autoFocus
              style={{ flex: 1 }}
            />
            <button
              className="es-link-btn"
              onClick={handleVerify}
              disabled={!canStart || checking}
              title="Verificar se o número tem WhatsApp"
              style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
            >
              <BsSearch size={13} /> {checking ? 'Checando...' : 'Verificar'}
            </button>
          </div>

          {/* Incidente real (2026-09-02, repetido 2026-09-03 com "11999990004"
              — 5 tentativas de envio falhando com 500/502 até alguém digitar
              de novo já com 55 na frente): "11999990005" (DDD+número, sem o
              55 do Brasil) foi tratado pelo WhatsApp como número inexistente
              ("No LID for user"). O aviso sozinho não bastava — passava
              despercebido e o atendente insistia tentando enviar do mesmo
              jeito. Mantém a heurística só de aviso (nunca reescreve sozinho
              o que foi digitado), mas agora com um botão de correção de 1
              clique — o atendente ainda vê e confirma o número final antes
              de enviar, só não precisa apagar e redigitar tudo. */}
          {!checkResult && digits.length >= 8 && digits.length < 12 && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: '#ECB22E' }}>
              ⚠️ Esse número parece estar sem o código do país — números do Brasil
              começam com 55 (DDI) + DDD + número. Confira antes de continuar.
              {' '}
              <button
                type="button"
                onClick={() => { setPhoneNumber(`55${digits}`); setCheckResult(null); }}
                style={{ color: 'var(--whatsapp-green, #25D366)', background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
              >
                Adicionar 55 automaticamente
              </button>
            </div>
          )}

          {checkResult === 'exists' && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--whatsapp-green, #25D366)' }}>
              ✓ Número tem WhatsApp.
            </div>
          )}
          {checkResult === 'exists_no_lid' && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: '#ECB22E' }}>
              ⚠️ Número tem WhatsApp, mas esta é a primeira conversa desta conta
              com ele — o envio por aqui pode falhar agora (limitação do
              WhatsApp/WPPConnect, sem correção disponível). Se isso acontecer,
              mande a primeira mensagem pelo WhatsApp oficial (celular ou
              web.whatsapp.com) e <strong>aguarde o cliente responder</strong> antes
              de continuar por aqui — mandar e já tentar seguir sem resposta dele
              ainda pode falhar.
            </div>
          )}
          {checkResult === 'not_found' && (
            <div style={{ marginTop: 10, fontSize: 13, color: '#e53e3e' }}>
              Esse número não parece ter WhatsApp — confira o DDI/DDD antes de continuar.
            </div>
          )}
          {checkResult === 'unknown' && (
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary, #888)' }}>
              Não foi possível verificar (não é obrigatório) — pode iniciar a conversa mesmo assim.
            </div>
          )}

          <button
            className="btn-primary"
            style={{ width: '100%', marginTop: 16 }}
            onClick={handleStart}
            disabled={!canStart}
          >
            Iniciar conversa
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewChatModal;
