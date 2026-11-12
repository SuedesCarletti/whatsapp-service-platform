// frontend/src/components/Onboarding/ProviderOnboarding.js
//
// ALTERAÇÕES NESTA VERSÃO vs anterior:
//   - Step 3 agora usa WhatsAppLinkPanel em vez de QR estático
//     → usuário ESCOLHE: QR Code (câmera) OU Código de pareamento (número)
//   - createdAccount salvo no estado para passar accountId ao WhatsAppLinkPanel
//   - Providers Meta (oficiais) não passam pelo step 3 — onComplete chamado direto
//   - Props mantidas: onComplete, onCancel, initialProviderType
//
import React, { useState } from 'react';
import axios from 'axios';
import WhatsAppLinkPanel from '../WhatsAppLinkPanel';
import EmbeddedSignupButton from './EmbeddedSignupButton';
import '../../styles/ProviderOnboarding.css';

// Providers que precisam de vinculação de sessão (step 3 com WhatsAppLinkPanel)
const UNOFFICIAL_PROVIDERS = ['baileys', 'venom', 'whatsapp_web_js', 'wppconnect'];

// Contas WhatsApp oficiais via Meta — zero risco de banimento (API homologada).
// Em vez de preço fixo (removido — a cobrança real é da própria Meta, variável
// por conversa/mensagem, não uma assinatura fixa nossa), cada tier mostra dois
// termômetros: complexidade de configuração (Simples → exige Análise da Meta)
// e perfil de uso ideal (Suporte/baixo volume → Marketing/alto volume) — ajuda
// a escolher pelo que vai ser usado, não só por uma tabela de preço genérica.
//
// Campo `tier` (Starter/Business/Professional/Enterprise) mantido nos dados
// mas OCULTO do card (ver render abaixo) — enquanto o app é uso interno de
// uma empresa só, não faz sentido linguagem de plano pago. Reativa fácil se
// o app virar multi-empresa/SaaS: é só voltar a renderizar `m.tier`.
const META_ACCOUNTS = [
  {
    type: 'meta_cloud_basic', icon: '☁️', label: 'Meta Cloud API', tier: 'Starter',
    complexityTier: 1, complexityReason: 'Conexão automática via Embedded Signup, ~2 min',
    usageTier: 2, usageReason: 'Atendimento/suporte geral — bom ponto de partida',
  },
  {
    type: 'meta_cloud_coexistence', icon: '🔗', label: 'Meta Coexistence', tier: 'Business', badge: '📱 App + API',
    complexityTier: 3, complexityReason: 'Exige Análise formal do App na Meta (Acesso Avançado)',
    usageTier: 1, usageReason: 'Baixo volume — o app do celular continua sendo o principal',
    inactive: true,
    // Diferente do básico/MM Lite (que conectam a própria Business Manager
    // já verificada neste app), a Coexistência serve pra conectar contas de
    // OUTRAS empresas — isso pede Acesso Avançado às permissões de mensagens/
    // gerenciamento do WhatsApp Business, que a Meta só libera depois de uma
    // Análise formal do App (processo de aprovação dela, com requisitos
    // próprios como política de privacidade pública). Pausado até essa
    // análise ser concluída, não por limitação técnica nossa.
    inactiveReason: 'Pausado: a Coexistência conecta o WhatsApp Business de contas de terceiros (não da sua própria Business Manager) — isso exige Acesso Avançado às permissões de mensagens/gerenciamento do WhatsApp Business, que a Meta só libera após uma Análise formal do App. Volta a ficar disponível assim que essa análise for concluída.',
  },
  {
    type: 'meta_cloud_mmlite', icon: '📣', label: 'Meta MM Lite', tier: 'Professional', badge: 'Marketing',
    complexityTier: 2, complexityReason: 'Conexão automática + aceitar os Termos de Marketing 1x',
    usageTier: 4, usageReason: 'Feito pra marketing em volume — roteamento e custo por mensagem otimizados',
  },
  {
    type: 'meta_cloud_full', icon: '🚀', label: 'Meta Full Stack', tier: 'Enterprise', badge: 'Coex + MM Lite',
    complexityTier: 4, complexityReason: 'Soma a Análise da Meta (Coexistência) + Termos de Marketing (MM Lite)',
    usageTier: 4, usageReason: 'Cobre tanto atendimento híbrido quanto marketing em volume',
    inactive: true,
    // Full Stack é literalmente Coexistência + MM Lite combinados — com a
    // Coexistência pausada (ver meta_cloud_coexistence acima), Full Stack
    // não tem como existir sozinho, pausa junto pelo mesmo motivo de fundo.
    inactiveReason: 'Pausado: o Full Stack inclui a Coexistência (WhatsApp Business de contas de terceiros) como parte dele — como a Coexistência depende de Acesso Avançado da Meta via Análise formal do App, ainda não liberado, o Full Stack fica pausado junto. Volta a ficar disponível assim que essa análise for concluída.',
  },
];

// Bridges não-oficiais, do MENOR pro MAIOR risco de banimento (o card mais
// embaixo é o mais arriscado). Ordem e motivos vêm de auditoria de código +
// pesquisa externa (issues/changelog/reputação de cada biblioteca) feita
// nesta mesma revisão — ver riskDetail/limitations de cada uma.
const BRIDGE_ORDER = ['wppconnect', 'whatsapp_web_js', 'venom', 'baileys'];

const BRIDGE_INFO = {
  wppconnect: {
    icon: '🔌', label: 'WPPConnect', color: '#9333EA',
    riskTier: 1,
    riskLevel: 'Risco moderado-baixo',
    riskReason: 'Abre um navegador de verdade — o mais parecido com uso humano',
    riskDetail: 'O WPPConnect abre um Chrome de verdade por trás dos panos e carrega o WhatsApp Web genuíno nele — é o método mais parecido com uma pessoa realmente usando o WhatsApp Web pelo computador. Ainda assim não é o aplicativo oficial, e o WhatsApp pode notar automação pelo padrão de uso (volume de mensagens, respostas muito rápidas, etc.).',
    automationTier: 4,
    automationReason: 'Mais completo e estável pra fluxos automatizados',
    automationDetail: 'É o bridge com mais recursos disponíveis via API (enquete, grupo, reação, contato, etc.) e o que se manteve mais estável nos testes — boa base pra conectar em fluxos do n8n ou agentes de IA que dependem de disparar e receber vários tipos de evento.',
    limitations: [
      'Não dá pra fixar uma mensagem específica (só a conversa inteira)',
      'Não dá pra ver ou alterar configurações de privacidade',
      'Não acompanha quando um contato específico fica online',
      'Só entra por QR Code — sem código numérico',
    ],
  },
  whatsapp_web_js: {
    icon: '🌐', label: 'WA-Web.js', color: '#FF6B35',
    riskTier: 2,
    riskLevel: 'Risco moderado',
    riskReason: 'Navegador real, mas biblioteca desatualizada no momento',
    riskDetail: 'Mesma ideia do WPPConnect — abre um navegador de verdade com o WhatsApp Web genuíno. É a opção mais usada no mundo todo, o que também a torna a mais visada por sistemas de detecção. Além disso, a versão atual está um pouco atrasada em relação à versão mais recente do WhatsApp Web, o que pode causar comportamentos estranhos até ser corrigida.',
    automationTier: 2,
    automationReason: 'Maior comunidade, mas bugs ativos atrapalham fluxos que dependem deles',
    automationDetail: 'É a biblioteca mais usada do mundo em integrações e tutoriais (inclusive com n8n), então tem bastante exemplo pronto por aí. Mas hoje tem falhas ativas (enquete não registra voto, contatos com identidade nova têm vários problemas) que podem quebrar um fluxo automatizado que dependa desses gatilhos específicos.',
    limitations: [
      'Votos em enquetes não são reconhecidos pela biblioteca',
      'Contatos migrados pro novo formato de identidade do WhatsApp (LID) têm vários problemas: abrir a conversa, apagar mensagem, baixar mídia',
      'Mensagens temporárias (que somem sozinhas) não funcionam, nem em grupo nem individual',
      'Só entra por QR Code — sem código numérico',
    ],
  },
  baileys: {
    icon: '⚡', label: 'Baileys', color: '#ECB22E',
    riskTier: 3,
    riskLevel: 'Risco moderado-alto',
    riskReason: 'Não abre navegador — conversa direto com os servidores',
    riskDetail: 'O Baileys se conecta direto aos servidores do WhatsApp sem abrir um WhatsApp Web de verdade — é como um "atalho". Funciona bem e é o mais maduro e testado dos quatro no dia a dia, mas por não se comportar como um navegador real, pode ser mais fácil pro WhatsApp notar que aquele uso não é normal.',
    automationTier: 3,
    automationReason: 'Leve e direto — ótimo pra escala, mas com desconexões inesperadas',
    automationDetail: 'Por não abrir navegador, é o mais leve e rápido dos quatro pra rodar vários números ao mesmo tempo — bom encaixe pra automação em volume. O ponto fraco é a sessão perder sincronia sozinha de vez em quando, o que pode interromper um fluxo automatizado sem aviso até reconectar.',
    limitations: [
      'Encaminhar mensagens antigas pode falhar (a memória de mensagens recentes é limitada)',
      'Enquetes muito antigas podem não registrar o voto corretamente',
      'De vez em quando a sessão perde sincronia sozinha e precisa reconectar (sem solução definitiva conhecida ainda)',
    ],
  },
  venom: {
    icon: '🦾', label: 'Venom', color: '#E01E5A',
    inactive: true,
    // Arquitetura igual ao WPPConnect/WA-Web (navegador real de verdade) —
    // sem indício de risco de banimento maior que os outros dois baseados
    // em navegador. Estar INATIVO é sobre confiabilidade da biblioteca no
    // momento, não sobre risco de ban — os dois são independentes, por isso
    // o tier acompanha a arquitetura (não o tier máximo por estar desligado).
    riskTier: 2,
    riskLevel: 'Risco moderado',
    riskReason: 'Mesma arquitetura de navegador do WPPConnect/WA-Web',
    riskDetail: 'Assim como o WPPConnect e o WA-Web.js, o Venom abre um navegador de verdade com o WhatsApp Web genuíno — arquitetura parecida, sem indício de que tenha risco de banimento maior que os outros dois baseados em navegador.',
    automationTier: 1,
    automationReason: 'Instável demais pra confiar em automação',
    automationDetail: 'Não recomendado pra fluxo automatizado nenhum no momento — a mesma instabilidade que o deixou inativo (não conseguir mandar mensagem pra contato novo, perder mensagem no histórico) inviabiliza qualquer automação séria em cima dele.',
    inactiveReason: 'Desativado por instabilidade da biblioteca, não por risco de banimento: a versão atual é uma reescrita muito recente (feita em um único dia de desenvolvimento) e ainda falha em tarefas básicas, como mandar mensagem pra um contato novo.',
    limitations: [
      'Não consegue começar uma conversa nova com um contato que nunca falou antes nesta sessão',
      'Enquete, reação, editar/apagar mensagem e compartilhar contato não existem',
      'Nenhuma função de grupo funciona (criar, adicionar/remover participante, etc.)',
      'Marcar como lido, fixar e favoritar mensagens não existem',
    ],
  },
};

// Escala fixa do "termômetro" de risco (verde → vermelho). tier (1-4) define
// quantos segmentos acendem — mais visual e rápido de comparar entre os
// bridges do que só ler um rótulo de texto tipo "risco moderado-alto".
const RISK_SCALE_COLORS = ['#25D366', '#ECB22E', '#FF6B35', '#E01E5A'];

const RiskMeter = ({ tier }) => (
  <div className="risk-meter" role="img" aria-label={`Nível de risco de banimento: ${tier} de ${RISK_SCALE_COLORS.length}`}>
    {RISK_SCALE_COLORS.map((color, i) => (
      <span
        key={i}
        className="risk-meter-segment"
        style={i < tier ? { background: color } : undefined}
      />
    ))}
  </div>
);

// Escala separada — adequação a fluxo automatizado (n8n, agentes de IA e
// afins). Eixo diferente do risco de banimento (um bridge pode ser ótimo
// pra automação e ainda assim arriscado, ou vice-versa — por isso não
// reaproveita a mesma escala). Aqui mais segmentos acesos = melhor, por
// isso a cor é azul (não vermelho, que já é a linguagem de "perigo" na
// escala de risco) e vai de cinza-azulado (fraco) a azul cheio (ótimo).
const AUTOMATION_SCALE_COLORS = ['#5B7A99', '#4B8FD6', '#2E7EE0', '#1565C0'];

const AutomationMeter = ({ tier }) => (
  <div className="automation-meter" role="img" aria-label={`Adequação a automação/IA: ${tier} de ${AUTOMATION_SCALE_COLORS.length}`}>
    {AUTOMATION_SCALE_COLORS.map((color, i) => (
      <span
        key={i}
        className="automation-meter-segment"
        style={i < tier ? { background: color } : undefined}
      />
    ))}
  </div>
);

// Termômetros dos tiers Meta (oficiais) — eixos diferentes dos bridges, já
// que risco de banimento não diferencia entre eles (todos são API homologada,
// risco zero). Complexidade vai de verde (simples) a laranja (exige Análise
// da Meta); Uso ideal vai de roxo claro (suporte/baixo volume) a roxo cheio
// (marketing/alto volume) — cor neutra de propósito, não é "melhor/pior".
const COMPLEXITY_SCALE_COLORS = ['#25D366', '#ECB22E', '#FF6B35', '#E01E5A'];
const USAGE_SCALE_COLORS = ['#B39DDB', '#9575CD', '#7E57C2', '#5E35B1'];

const ComplexityMeter = ({ tier }) => (
  <div className="risk-meter" role="img" aria-label={`Complexidade de configuração: ${tier} de ${COMPLEXITY_SCALE_COLORS.length}`}>
    {COMPLEXITY_SCALE_COLORS.map((color, i) => (
      <span
        key={i}
        className="risk-meter-segment"
        style={i < tier ? { background: color } : undefined}
      />
    ))}
  </div>
);

const UsageMeter = ({ tier }) => (
  <div className="automation-meter" role="img" aria-label={`Perfil de uso ideal: ${tier} de ${USAGE_SCALE_COLORS.length}`}>
    {USAGE_SCALE_COLORS.map((color, i) => (
      <span
        key={i}
        className="automation-meter-segment"
        style={i < tier ? { background: color } : undefined}
      />
    ))}
  </div>
);

const isSiteChatType = (t) => t === 'site_chat';
const siteSlug = (name) =>
  (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';

const ProviderOnboarding = ({ onComplete, onCancel, initialProviderType = null }) => {
  const [step, setStep]         = useState(initialProviderType ? 2 : 1);
  const [formData, setFormData] = useState({
    account_name:   '',
    phone_number:   '',
    provider_type:  initialProviderType || null,
    session_id:     '',
    wppconnect_url:   '',
    wppconnect_token: '',
    meta_phone_number_id:      '',
    meta_access_token:         '',
    meta_business_account_id:  '',
    meta_catalog_id:           '',
  });
  const [loading,        setLoading]        = useState(false);
  const [showManualMetaFields, setShowManualMetaFields] = useState(false);
  const [createdAccount, setCreatedAccount] = useState(null); // ← novo: guarda a conta criada
  const isMetaProvider = !!(formData.provider_type && formData.provider_type.startsWith('meta_'));

  // ─── Step 1: escolha do provider ─────────────────────────

  const handleProviderSelect = (providerType) => {
    if (BRIDGE_INFO[providerType]?.inactive) return; // Venom: card desativado, não navega
    if (META_ACCOUNTS.find(m => m.type === providerType)?.inactive) return; // Coexistência: pausada, não navega
    setFormData(f => ({ ...f, provider_type: providerType }));
    setStep(2);
  };

  // ─── Step 2: configuração da conta ───────────────────────

  const handleAccountSetup = async (e) => {
    e.preventDefault();
    setLoading(true);
 
    try {
      // ── 1. Cria a conta ──────────────────────────────────────────
      // USA /api/settings/accounts em vez de /api/auth/accounts
      const payload = isSiteChatType(formData.provider_type)
        ? { ...formData, phone_number: `site-${siteSlug(formData.account_name)}` }
        : formData;
      const createResp = await axios.post('/api/settings/accounts', payload, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` }
      });
 
      // A resposta pode vir em createResp.data ou createResp.data.data
      const account = createResp.data?.data || createResp.data;
 
      // ── 2. Providers Meta oficiais → onComplete direto ───────────
      if (!UNOFFICIAL_PROVIDERS.includes(formData.provider_type)) {
        onComplete(account);
        return;
      }
 
      // ── 3. Providers não-oficiais → tenta iniciar sessão no bridge
      try {
        await axios.post(
          `/api/auth/accounts/${account.id}/auth/init`,
          {},
          { headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` } }
        );
      } catch {
        // Bridge pode estar offline — WhatsAppLinkPanel trata isso na tela seguinte
      }
 
      setCreatedAccount(account);
      setStep(3);
 
    } catch (error) {
      // ── Mostra o erro REAL da API, não mensagem genérica ─────────
      const status  = error?.response?.status;
      const detail  = error?.response?.data?.detail;
      const message = error?.response?.data?.message;
 
      let msg = 'Erro ao configurar conta.';
 
      if (status === 401) {
        msg = 'Sessão expirada. Faça login novamente.';
      } else if (status === 422) {
        msg = `Dados inválidos: ${detail || 'verifique os campos preenchidos.'}`;
      } else if (status === 503) {
        msg = detail || 'Nenhum usuário admin encontrado. Crie um usuário antes.';
      } else if (status === 500) {
        msg = `Erro interno: ${detail || 'verifique os logs do servidor.'}`;
      } else if (detail) {
        msg = detail;
      } else if (message) {
        msg = message;
      } else if (error.message) {
        msg = error.message;
      }
 
      console.error('[ProviderOnboarding] Erro ao criar conta:', error?.response?.data || error);
      alert(msg);
    } finally {
      setLoading(false);
    }
  };

  // ─── Step 3: vinculação autenticada ──────────────────────

  const handleAuthenticated = (authData) => {
    // Sessão autenticada → conclui onboarding
    onComplete({ ...createdAccount, authenticated: true, ...authData });
  };


  return (
    <div className="onboarding-container">

      {/* ══════════════════════════════════════════════════
          STEP 1 — Escolher provider
      ══════════════════════════════════════════════════ */}
      {step === 1 && (
        <div className="step-provider-selection">
          <h2>Escolha como conectar seu WhatsApp</h2>

          {/* ── Grupo 1: contas WhatsApp oficiais via Meta ── */}
          <h3 className="provider-group-title">📱 Contas WhatsApp via Meta (oficial)</h3>
          <div className="providers-grid">
            {META_ACCOUNTS.map(m => (
              <div
                key={m.type}
                className={`provider-card recommended${m.inactive ? ' inactive' : ''}`}
                onClick={() => handleProviderSelect(m.type)}
                title={m.inactive ? m.inactiveReason : undefined}
              >
                <h3>{m.icon} {m.label}</h3>
                {/* Rótulo de tier (Starter/Business/Professional/Enterprise) escondido
                    enquanto o app for uso interno só desta empresa — não faz sentido
                    mostrar linguagem de plano pago pra quem não vê preço nenhum. O dado
                    continua em META_ACCOUNTS (m.tier) pra reativar fácil se o app virar
                    multi-empresa/SaaS depois. Mantém só o aviso de "Indisponível". */}
                {m.inactive && <p className="tier">Indisponível</p>}
                <p className="risk">{m.inactive ? '🚫 Pausado' : 'Zero Risco de Banimento'}</p>
                {m.inactive ? (
                  <p className="risk-caption">{m.inactiveReason}</p>
                ) : (
                  <>
                    <ComplexityMeter tier={m.complexityTier} />
                    <p className="risk-caption">Complexidade: {m.complexityReason}</p>
                    <UsageMeter tier={m.usageTier} />
                    <p className="risk-caption">Uso ideal: {m.usageReason}</p>
                  </>
                )}
                {m.badge && !m.inactive && <span className="badge">{m.badge}</span>}
              </div>
            ))}
          </div>

          {/* ── Grupo 2: bridges não-oficiais, do menor pro maior risco de ban
              (o de baixo é o mais arriscado — Venom está desativado) ── */}
          <h3 className="provider-group-title">
            🔌 Bridges (não-oficiais)
            <span className="provider-group-subtitle">do menor pro maior risco de banimento</span>
          </h3>
          <div className="providers-grid providers-grid--bridges">
            {BRIDGE_ORDER.map(type => {
              const b = BRIDGE_INFO[type];
              return (
                <div
                  key={type}
                  className={`provider-card risky${b.inactive ? ' inactive' : ''}`}
                  onClick={() => handleProviderSelect(type)}
                  title={b.inactive ? b.inactiveReason : undefined}
                >
                  <h3>{b.icon} {b.label}</h3>
                  {/* "Free"/"Gratuito" escondidos pelo mesmo motivo do grupo Meta acima
                      (uso interno, sem noção de plano/preço pro usuário) — some o rótulo
                      de tier/preço, mantém só o aviso de indisponibilidade quando aplicável. */}
                  {b.inactive && <p className="tier" style={{ color: b.color }}>Indisponível</p>}
                  <RiskMeter tier={b.riskTier} />
                  <p className="risk-caption">{b.inactive ? '🚫 Indisponível' : 'Escala de risco de banimento'}</p>
                  <AutomationMeter tier={b.automationTier} />
                  <p className="risk-caption">Adequação a automação / IA (n8n e afins)</p>
                  {!b.inactive && (
                    <span className="badge" style={{ color: b.color, background: `${b.color}1a` }}>QR / Código</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Grupo 3: chat do site (plugin WooCommerce) — sem número/QR/token ── */}
          <h3 className="provider-group-title">🛒 Chat do site</h3>
          <div className="providers-grid">
            <div className="provider-card recommended" onClick={() => handleProviderSelect('site_chat')}>
              <h3>🛒 Chat do Site (WooCommerce)</h3>
              <p className="risk">Sem número, QR ou token</p>
              <p className="risk-caption">
                Clientes que escrevem pelo chat da sua loja aparecem em Conversas e você responde daqui,
                mesmo painel do WhatsApp. Instala-se um plugin no WordPress.
              </p>
              <span className="badge">Só texto</span>
            </div>
          </div>

          {onCancel && (
            <button className="onboarding-cancel-btn" onClick={onCancel}>
              ← Voltar
            </button>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════
          STEP 2 — Configurar a conta
      ══════════════════════════════════════════════════ */}
      {step === 2 && (
        <div className="step-account-setup">
          <h2>Configurar conta</h2>

          {/* Detalhe do bridge escolhido — primeira coisa visível ao entrar
              nesta etapa, antes de preencher qualquer campo do formulário. */}
          {BRIDGE_INFO[formData.provider_type] && (
            <div className="provider-warning provider-warning--detailed">
              <div className="provider-warning-risk-row">
                <RiskMeter tier={BRIDGE_INFO[formData.provider_type].riskTier} />
                <p className="provider-warning-risk">📊 Escala de risco de banimento</p>
              </div>
              <p>{BRIDGE_INFO[formData.provider_type].riskDetail}</p>

              <div className="provider-warning-risk-row">
                <AutomationMeter tier={BRIDGE_INFO[formData.provider_type].automationTier} />
                <p className="provider-warning-risk">🤖 Escala de adequação a automação / IA (n8n e afins)</p>
              </div>
              <p>{BRIDGE_INFO[formData.provider_type].automationDetail}</p>

              <p className="provider-warning-subtitle">O que não funciona hoje nesse bridge:</p>
              <ul>
                {BRIDGE_INFO[formData.provider_type].limitations.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {isMetaProvider && !showManualMetaFields ? (
            <>
              <EmbeddedSignupButton
                providerType={formData.provider_type}
                onConnected={(accountId) => onComplete({ id: accountId })}
              />
              <div className="onboarding-manual-toggle">
                <button
                  type="button"
                  className="es-link-btn"
                  onClick={() => setShowManualMetaFields(true)}
                >
                  Sou desenvolvedor e prefiro configurar manualmente
                </button>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="onboarding-cancel-btn"
                  onClick={() => initialProviderType ? onCancel?.() : setStep(1)}
                >
                  ← Voltar
                </button>
              </div>
            </>
          ) : (
          <form onSubmit={handleAccountSetup}>

            {isMetaProvider && (
              <div className="form-group">
                <button
                  type="button"
                  className="es-link-btn"
                  onClick={() => setShowManualMetaFields(false)}
                >
                  ← Usar conexão automática em vez disso
                </button>
              </div>
            )}

            {/* Campos comuns */}
            <div className="form-group">
              <label>Nome da conta</label>
              <input
                type="text"
                placeholder="ex: Loja Principal"
                value={formData.account_name}
                required
                onChange={e => setFormData(f => ({ ...f, account_name: e.target.value }))}
              />
            </div>

            {!isSiteChatType(formData.provider_type) && (
              <div className="form-group">
                <label>Número de telefone</label>
                <input
                  type="text"
                  placeholder="+55 11 99999-9999"
                  value={formData.phone_number}
                  required
                  onChange={e => setFormData(f => ({ ...f, phone_number: e.target.value }))}
                />
              </div>
            )}
            {isSiteChatType(formData.provider_type) && (
              <div className="provider-warning">
                <p>
                  Basta um nome. Na próxima tela você baixa o plugin do WordPress já configurado
                  (chave e segredo gerados automaticamente).
                </p>
              </div>
            )}

            {/* Campos Meta Cloud */}
            {isMetaProvider && (
              <>
                <div className="form-group">
                  <label>Phone Number ID</label>
                  <input
                    type="text"
                    placeholder="123456789012345"
                    value={formData.meta_phone_number_id || ''}
                    required
                    onChange={e => setFormData(f => ({ ...f, meta_phone_number_id: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Access Token (permanente)</label>
                  <input
                    type="password"
                    placeholder="EAAxxxxx..."
                    value={formData.meta_access_token || ''}
                    required
                    onChange={e => setFormData(f => ({ ...f, meta_access_token: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Business Account ID</label>
                  <input
                    type="text"
                    placeholder="waba_1234..."
                    value={formData.meta_business_account_id || ''}
                    onChange={e => setFormData(f => ({ ...f, meta_business_account_id: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Catalog ID (opcional — para produtos/carrinho)</label>
                  <input
                    type="text"
                    placeholder="987654321098765"
                    value={formData.meta_catalog_id || ''}
                    onChange={e => setFormData(f => ({ ...f, meta_catalog_id: e.target.value }))}
                  />
                </div>
              </>
            )}

            {/* Session ID — providers não-oficiais sem WPPConnect */}
            {UNOFFICIAL_PROVIDERS.includes(formData.provider_type) &&
             formData.provider_type !== 'wppconnect' && (
              <div className="form-group">
                <label>Session ID</label>
                <input
                  type="text"
                  placeholder="ex: loja-principal-01"
                  value={formData.session_id || ''}
                  onChange={e => setFormData(f => ({ ...f, session_id: e.target.value }))}
                />
                <span className="form-hint">
                  Identificador único desta sessão no bridge. Use letras, números e hífens.
                </span>
              </div>
            )}

            {/* WPPConnect — bridge já roda localmente (porta 3003); estes campos
                só são necessários se você apontar para um servidor diferente */}
            {formData.provider_type === 'wppconnect' && (
              <>
                <span className="form-hint">
                  O bridge do WPPConnect já roda neste servidor. Deixe os campos abaixo em branco
                  para usar o padrão local — só preencha se estiver usando um servidor externo.
                </span>
                <div className="form-group">
                  <label>URL do servidor WPPConnect (opcional)</label>
                  <input
                    type="text"
                    placeholder="padrão: http://localhost:3003"
                    value={formData.wppconnect_url || ''}
                    onChange={e => setFormData(f => ({ ...f, wppconnect_url: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Token (opcional)</label>
                  <input
                    type="password"
                    placeholder="deixe em branco para usar o padrão local"
                    value={formData.wppconnect_token || ''}
                    onChange={e => setFormData(f => ({ ...f, wppconnect_token: e.target.value }))}
                  />
                </div>
                <div className="form-group">
                  <label>Session ID</label>
                  <input
                    type="text"
                    placeholder="ex: loja-principal-01"
                    value={formData.session_id || ''}
                    onChange={e => setFormData(f => ({ ...f, session_id: e.target.value }))}
                  />
                </div>
              </>
            )}

            <div className="form-actions">
              <button
                type="button"
                className="onboarding-cancel-btn"
                onClick={() => initialProviderType ? onCancel?.() : setStep(1)}
              >
                ← Voltar
              </button>
              <button type="submit" disabled={loading}>
                {loading ? 'Configurando...' : 'Continuar →'}
              </button>
            </div>

          </form>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════
          STEP 3 — Vinculação WhatsApp (QR ou Código)
          Apenas para providers não-oficiais.
          WhatsAppLinkPanel oferece a escolha ao usuário.
      ══════════════════════════════════════════════════ */}
      {step === 3 && createdAccount && (
        <div className="step-link-session">
          <WhatsAppLinkPanel
            accountId={createdAccount.id}
            providerType={formData.provider_type}
            accountName={formData.account_name}
            onAuthenticated={handleAuthenticated}
            onClose={onCancel}
          />
        </div>
      )}

    </div>
  );
};

export default ProviderOnboarding;
