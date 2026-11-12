/**
 * SettingsModal.js — Central de Configurações
 * v2.0 — Providers não-oficiais + QR de sessão integrado
 *
 * Abas:
 *   Geral           → tema, idioma, sons, notificações
 *   Contas WA       → lista de contas + ProviderOnboarding + ProviderSelectorComplete
 *                         + SessionQRCode inline para Baileys/Venom/WPPConnect ← NOVO
 *   Minha Conta     → troca de senha do usuário logado (salva em /api/settings/me/password)
 *   Analytics       → AnalyticsDashboard embedded via CSS
 *   Perfil Negócio  → BusinessProfile embedded via CSS
 *   Templates       → TemplateManager (criar/listar/excluir templates Meta)
 *   Catálogo        → CatalogManager (produtos do catálogo Meta)
 *   Flows           → FlowManager (chave de criptografia + criação/publicação)
 *   Usuários        → CRUD + matriz de permissões por role/setor
 *   Automações      → auto-reply, off-hours (salva em /api/settings/automations)
 *
 * Credenciais de provedor (Meta phone_number_id/access_token/business_account_id/
 * catalog_id, bridges) vivem em Contas WA, no cadastro/edição de cada conta —
 * não existe mais um store global separado para isso.
 *
 * ─── Componentes reutilizados (sem duplicação) ───────────────
 *   AnalyticsDashboard       → embedded, CSS override remove overlay
 *   BusinessProfile          → embedded, CSS override remove overlay
 *   ProviderOnboarding       → embedded, handles steps 1→2→3 internamente
 *   ProviderSelectorComplete → embedded, quiz de recomendação
 *   SessionQRCode            → embedded inline em Contas WA (providers não-oficiais)
 *
 * ─── Diferença entre QR Codes ────────────────────────────────
 *   QRCodeManager (menu ⋮)   → QR de MARKETING: link wa.me/ pré-preenchido para clientes
 *   SessionQRCode (aqui)     → QR de SESSÃO: autentica Baileys/Venom/WPPConnect via WA Web
 */

import React, { useState, useEffect } from 'react';
import {
  MdSettings, MdClose, MdSave, MdRefresh, MdAdd, MdDelete,
  MdDarkMode, MdLightMode, MdNotifications, MdNotificationsOff,
  MdLock, MdWarning, MdInfo,
  MdAutoAwesome, MdBolt, MdSchedule,
  MdVisibility, MdVisibilityOff, MdCheckCircle, MdError,
  MdBusiness, MdBarChart, MdPhone, MdQrCode, MdGroup,
  MdHelpOutline, MdEdit, MdArticle, MdStorefront, MdDynamicForm, MdApps, MdSignalCellularAlt, MdWifiTethering,
  MdLabel, MdChat, MdAttachFile, MdWorkOutline, MdListAlt,
} from 'react-icons/md';
import { FaWhatsapp } from 'react-icons/fa';

// ── Componentes existentes — reutilizados sem duplicação ──────
import AnalyticsDashboard      from './AnalyticsDashboard';
import BusinessProfile         from './BusinessProfile';
import ProviderOnboarding      from './Onboarding/ProviderOnboarding';
import ProviderSelectorComplete from './ProviderSelectorComplete';
import WhatsAppLinkPanel       from './WhatsAppLinkPanel'; // ← Vinculação: QR Code + Pairing Code
import TemplateManager         from './TemplateManager';
import CatalogManager          from './CatalogManager';
import FlowManager             from './FlowManager';
import PhoneNumberInfo         from './PhoneNumberInfo';
import SiteChatConfigCard      from './SiteChatConfigCard';

import apiService from '../services/api';
import { requestNotificationPermission, subscribeToPush } from '../utils/desktopNotify';
import { getContrastTextColor } from '../utils/tagColor';
import '../styles/SettingsModal.css';

//  CONSTANTES

const AUTH_STATUS = {
  PENDING:       { label: 'Pendente',     color: '#8696a0', icon: '⏳' },
  QR_REQUIRED:   { label: 'Aguard. QR',  color: '#ECB22E', icon: '📱' },
  AUTHENTICATED: { label: 'Autenticado', color: '#2FAE60', icon: '✅' },
  DISCONNECTED:  { label: 'Desconec.',   color: '#F44336', icon: '❌' },
  BANNED:        { label: 'Banido',      color: '#F44336', icon: '🚫' },
};

// Mapeamento visual mínimo (ícone + cor) — sem duplicar lógica de providers
const PROVIDER_VISUAL = {
  meta_cloud_basic:       { icon: '☁️', color: '#25D366', label: 'Meta Cloud API' },
  meta_cloud_coexistence: { icon: '🔗', color: '#128C7E', label: 'Meta Coexistence' },
  meta_cloud_mmlite:      { icon: '📣', color: '#075E54', label: 'Meta MM Lite' },
  meta_cloud_full:        { icon: '🚀', color: '#34B7F1', label: 'Meta Full Stack' },
  baileys:                { icon: '⚡', color: '#ECB22E', label: 'Baileys' },
  venom:                  { icon: '🦾', color: '#E01E5A', label: 'Venom' },
  whatsapp_web_js:        { icon: '🌐', color: '#FF6B35', label: 'WhatsApp-Web.js' },
  wppconnect:             { icon: '🔌', color: '#9333EA', label: 'WPPConnect' },
  site_chat:              { icon: '🛒', color: '#1B2A49', label: 'Chat do Site' },
};

// Providers que exigem QR Code de SESSÃO (WhatsApp Web) para autenticar
const UNOFFICIAL_PROVIDERS = ['baileys', 'venom', 'wppconnect', 'whatsapp_web_js'];

// Fallback usado antes da 1ª resposta de /api/admin/roles (ou se o usuário logado
// não for admin e não puder listar papéis) — mantém o seletor de Função utilizável.
const DEFAULT_ROLES_FALLBACK = [
  { id: 'admin',      label: '👑 Admin',      color: '#f6c026' },
  { id: 'supervisor', label: '🔵 Supervisor', color: '#34B7F1' },
  { id: 'attendant',  label: '👤 Atendente',  color: '#0EA5A4' },
];

//  COMPONENTE PRINCIPAL

// Aba de Configurações -> permissão(ões) que a liberam. Aba ausente daqui
// ('general' e 'credentials'/Minha Conta) é sempre visível pra qualquer
// usuário logado — a primeira é praticamente inofensiva (tema/idioma/sons
// locais) e a segunda é a troca da própria senha, não dá pra restringir.
// Ver o espelho disso em PERMISSIONS_DEF (AdminPanel.js) — `tab` de cada
// permissão do grupo "Configurações".
const SETTINGS_TAB_PERMS = {
  // feature_qr_manager também libera a aba (2026-09-14, pedido do usuário):
  // quem só tem essa permissão vê uma versão restrita — só as próprias
  // contas vinculadas (user_account_access, já filtrado pelo backend em
  // GET /accounts quando falta feature_view_all_accounts), só
  // conectar/reconectar/desconectar, sem adicionar/excluir/editar
  // credenciais. Ver canManageAccountsFully mais abaixo e a checagem real
  // (não só cosmética) em backend/api/routes_settings.py
  // (_require_account_scope nas rotas de qr/pairing-code/logout).
  accounts:          ['settings_accounts', 'feature_qr_manager'],
  meta_app:          ['settings_meta_app'],
  analytics:         ['settings_analytics'],
  business_profile:  ['settings_business_profile'],
  templates:         ['feature_templates_manage'],
  catalog:           ['settings_catalog'],
  flows:             ['settings_flows'],
  phone_quality:     ['settings_phone_quality'],
  users:             ['settings_users'],
  atendimento:       ['settings_attendance_config'],
  internal_contacts: ['settings_internal_contacts'],
  automations:       ['settings_auto_reply', 'settings_business_hours', 'settings_csat', 'settings_sla'],
};

// Mesma lógica de backend/utils/display_name.py — só pra prévia instantânea
// aqui na tela; o valor que vale de verdade é sempre o que o backend calcula
// (mensagem pro cliente e chat interno são formatados lá, não aqui).
const previewDisplayName = (fullName, fmt) => {
  if (fmt === 'none') return 'sem identificação';
  const name = (fullName || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name || '—';
  const first = parts[0];
  const last = parts[parts.length - 1];
  return fmt === 'initial_last' ? `${first[0]}. ${last}` : `${first} ${last[0]}.`;
};

const SettingsModal = ({
  isOpen, onClose, currentUser, currentUserId, currentTheme, onToggleTheme,
  initialTab, onQuickRepliesChanged, onTagsChanged, statusColors, onStatusColorsChanged,
  permissions = {}, isAdmin = false,
  currentUserFullName = '', currentUserDisplayNameFormat = 'first_initial', onDisplayNameFormatChanged,
  currentUserPhotoUrl = null, onPhotoChanged,
}) => {

  const canSeeSettingsTab = (tabId) => isAdmin
    || !SETTINGS_TAB_PERMS[tabId]
    || SETTINGS_TAB_PERMS[tabId].some(k => permissions?.[k] === true || permissions?.[k] === 'require_approval');

  // Quem só tem feature_qr_manager (não settings_accounts) vê a aba Contas
  // WA, mas numa versão restrita: só conectar/reconectar/desconectar as
  // próprias contas (já filtradas pelo backend em GET /accounts) — sem
  // adicionar, editar, ativar/desativar ou excluir. Enforcement real (não
  // só cosmético) mora em backend/api/routes_settings.py
  // (_require_account_scope nas rotas de qr/pairing-code/logout).
  const canManageAccountsFully = isAdmin || permissions?.settings_accounts === true;

  // ── Aba ativa ────────────────────────────────────────────
  const [tab, setTab] = useState(() => {
    const wanted = initialTab || 'general';
    return canSeeSettingsTab(wanted) ? wanted : 'general';
  });

  // ── Geral ─────────────────────────────────────────────────
  const [notifications, setNotifications] = useState(() => localStorage.getItem('wa-notifications') !== 'false');
  const [soundEnabled,  setSoundEnabled]  = useState(() => localStorage.getItem('wa-sound') !== 'false');
  const [language,      setLanguage]      = useState(() => localStorage.getItem('wa-language') || 'pt-BR');
  // Permissão REAL do navegador (diferente do toggle acima, que é só a
  // preferência do app) — 'default' (nunca perguntou), 'granted' ou
  // 'denied'. Pedir isso sem um clique direto do usuário (ex: só ao logar)
  // o Chrome trata como "de baixo engajamento" e sequer mostra o popup —
  // por isso o pedido de verdade acontece no clique do botão abaixo, igual
  // a permissão de microfone é pedida só quando aperta pra gravar.
  const [browserNotifPermission, setBrowserNotifPermission] = useState(
    () => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')
  );

  // ── Contas WA ─────────────────────────────────────────────
  // flow: 'list' | 'help' | 'add' | 'session_qr'
  //   list        → lista de contas existentes
  //   help        → ProviderSelectorComplete (quiz de recomendação)
  //   add         → ProviderOnboarding (wizard completo)
  //   session_qr  → SessionQRCode inline (Baileys/Venom/WPPConnect) ← NOVO
  const [accounts,        setAccounts]       = useState([]);
  const [accountsLoading, setAccountsLoading]= useState(false);
  const [accountFlow,     setAccountFlow]    = useState('list');
  // providerType vindo do quiz, passado como initialProviderType ao Onboarding
  const [suggestedProvider, setSuggestedProvider] = useState(null);
  // Conta selecionada para QR de sessão { id, account_name, provider_type } ← NOVO
  const [sessionQRAccount, setSessionQRAccount] = useState(null);
  const [editingAccount, setEditingAccount] = useState(null);
  const [creatingFallback, setCreatingFallback] = useState(false);

  // ── Minha Conta (foto de perfil no chat interno) ───────────
  const [myPhotoUrl, setMyPhotoUrl] = useState(currentUserPhotoUrl);
  const [photoSt, setPhotoSt] = useState(null); // null | 'saving' | 'error'
  const [showWhatsAppPhotoForm, setShowWhatsAppPhotoForm] = useState(false);
  const [waPhotoNumber, setWaPhotoNumber] = useState('');
  const [waPhotoAccountId, setWaPhotoAccountId] = useState(null);

  const handlePhotoFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPhotoSt('saving');
    try {
      const res = await apiService.uploadMyPhoto(file);
      setMyPhotoUrl(res.photo_url);
      onPhotoChanged?.(res.photo_url);
      setPhotoSt(null);
    } catch {
      setPhotoSt('error');
    }
  };

  const handleUseWhatsAppPhoto = async () => {
    const digits = waPhotoNumber.replace(/\D/g, '');
    if (!digits || !waPhotoAccountId) return;
    setPhotoSt('saving');
    try {
      const res = await apiService.copyMyPhotoFromWhatsApp(`${digits}@s.whatsapp.net`, waPhotoAccountId);
      setMyPhotoUrl(res.photo_url);
      onPhotoChanged?.(res.photo_url);
      setPhotoSt(null);
      setShowWhatsAppPhotoForm(false);
      setWaPhotoNumber('');
    } catch (err) {
      setPhotoSt('error');
      alert(err?.response?.data?.detail || 'Não foi possível buscar essa foto.');
    }
  };

  // ── Minha Conta (troca de senha) ───────────────────────────
  const [pwdForm,   setPwdForm]   = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [pwdSt,      setPwdSt]     = useState(null); // null | 'saving' | 'ok' | 'error'
  const [pwdErrorMsg, setPwdErrorMsg] = useState('');

  // ── Minha Conta (nome de exibição) ─────────────────────────
  const [displayNameFormat, setDisplayNameFormat] = useState(currentUserDisplayNameFormat);
  const [displayNameSt, setDisplayNameSt] = useState(null); // null | 'saving' | 'ok' | 'error'

  // ── App Meta (Embedded Signup) ──────────────────────────────
  // Credenciais do App da Meta (developers.facebook.com) — servem pra
  // qualquer conta conectar via Embedded Signup, por isso ficam separadas
  // de "Contas WA" (que é por conta) mas dentro de Configurações (não no
  // Painel Admin, pra não ter dois lugares diferentes pra mesma coisa).
  const [metaAppConfig, setMetaAppConfig] = useState(null);
  const [metaAppLoading, setMetaAppLoading] = useState(false);
  const [metaAppSt,      setMetaAppSt]      = useState(null); // null | 'saving' | 'ok' | 'error' | 'forbidden'
  const [metaAppErrorMsg, setMetaAppErrorMsg] = useState('');

  // ── Usuários ──────────────────────────────────────────────
  const [users,      setUsers]     = useState([]);
  const [usersLoad,  setUsersLoad] = useState(false);
  const [newUser,    setNewUser]   = useState({ username: '', password: '', role: 'attendant', sector: '' });
  const [showPwd,    setShowPwd]   = useState(false);
  const [roles,      setRoles]     = useState(DEFAULT_ROLES_FALLBACK);

  // ── Automações ────────────────────────────────────────────
  const [autoReply, setAutoReply] = useState({ enabled: false, message: 'Olá! Recebemos sua mensagem e responderemos em breve. 😊', delay_seconds: 5 });
  const [offHours,  setOffHours]  = useState({ enabled: false, message: 'Nosso atendimento é seg-sex 8h–18h. Retornaremos em breve!', start: '08:00', end: '18:00' });
  const [csat,      setCsat]      = useState({ enabled: false, message: 'De 1 a 5, como você avalia nosso atendimento? Responda só com o número 😊', timeout_hours: 24 });
  const [sla,       setSla]       = useState({ wait_minutes: 10 });

  // ── Atendimento (Etiquetas + Respostas Rápidas) ────────────
  const [internalContacts,     setInternalContacts]     = useState([]);
  const [internalContactsLoad, setInternalContactsLoad] = useState(false);
  const [newInternalPhone,     setNewInternalPhone]     = useState('');
  const [addingInternal,       setAddingInternal]       = useState(false);
  const [tagList,     setTagList]     = useState([]);
  const [tagListLoad, setTagListLoad] = useState(false);
  // scope: 'global' (todo mundo) | 'sector' (só quem tem o mesmo User.sector)
  // | 'personal' (ponto-a-ponto, mesmo modelo de Resposta Rápida — ver
  // sharedWith). taskTitle preenchido = aplicar a etiqueta numa conversa de
  // cliente cria uma tarefa vinculada automaticamente (sem prazo).
  const EMPTY_TAG = { name: '', color: '#0EA5A4', scope: 'global', sector: '', taskTitle: '', taskDescription: '', taskPriority: 'medium', taskDueDays: '', taskAssignedTo: '', sharedWith: [] };
  const [tagForm, setTagForm] = useState(EMPTY_TAG);
  const [editingTagId, setEditingTagId] = useState(null);
  const [savingTag, setSavingTag] = useState(false);
  const [quickReplyList,     setQuickReplyList]     = useState([]);
  const [quickReplyListLoad, setQuickReplyListLoad] = useState(false);
  const [newQr, setNewQr] = useState({ shortcut: '', text: '', media_url: null, media_type: null, media_filename: null, media_mime: null, shared_with: [] });
  const [editingQrId, setEditingQrId] = useState(null);
  const [uploadingQrMedia, setUploadingQrMedia] = useState(false);
  const [qrAgents, setQrAgents] = useState([]); // colegas pra escolher no compartilhamento ponto-a-ponto
  const [draftStatusColors, setDraftStatusColors] = useState(statusColors || { open: '#2FAE60', pending: '#ECB22E', resolved: '#8696A0' });
  const [savingStatusColors, setSavingStatusColors] = useState(false);

  useEffect(() => {
    if (statusColors) setDraftStatusColors(statusColors);
  }, [statusColors]);

  // ── Feedback ──────────────────────────────────────────────
  const [saving,     setSaving]     = useState(false);
  const [saveSt,     setSaveSt]     = useState(null);
  const [showSecret, setShowSecret] = useState({});

  const flash = (st) => { setSaveSt(st); setTimeout(() => setSaveSt(null), 3000); };

  // Helper: headers de autenticação para todos os fetch do Settings
  const authH = (extra = {}) => ({
    Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
    ...extra,
  });

  //  CARREGAR DADOS

  useEffect(() => {
    if (!isOpen) return;
    loadAccounts();
    loadUsers();
    loadAutomations();
    loadRoles();
  }, [isOpen]); // eslint-disable-line

  useEffect(() => {
    if (tab === 'meta_app' && metaAppConfig === null && !metaAppLoading) {
      loadMetaAppConfig();
    }
    if (tab === 'atendimento') {
      loadTagList();
      loadQuickReplyList();
      apiService.getAgents().then(setQrAgents);
    }
    if (tab === 'internal_contacts') {
      loadInternalContacts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const loadAccounts = async () => {
    setAccountsLoading(true);
    try {
      const data = await apiService.getAccounts();
      const raw = Array.isArray(data) ? data : (data.data || []);
      setAccounts(raw.map(acc => ({
        ...acc,
        requires_session_qr: UNOFFICIAL_PROVIDERS.includes(
          (acc.provider_type || '').toLowerCase()
        ),
      })));
    } catch {
      // fallback de demonstração
      setAccounts([{
        id: 1, account_name: 'Conta Principal',
        phone_number: '+55 44 99999-9999',
        provider_type: 'meta_cloud_basic',
        is_active: true,
        authentication_status: 'AUTHENTICATED',
        requires_session_qr: false,
      }]);
    } finally { setAccountsLoading(false); }
  };

  const loadUsers = async () => {
    setUsersLoad(true);
    try {
      const r = await fetch('/api/settings/users', { headers: authH() });
      if (r.ok) {
        const d = await r.json();
        // suporta { success, data: [...] } e { users: [...] } (formato antigo)
        setUsers(d.data || d.users || []);
      }
    } catch {
      setUsers([
        { id: 1, username: 'admin',      role: 'admin',     sector: '',       active: true },
        { id: 2, username: 'atendente1', role: 'attendant', sector: 'Vendas', active: true },
      ]);
    } finally { setUsersLoad(false); }
  };

  const loadAutomations = async () => {
    try {
      const r = await fetch('/api/settings/automations', { headers: authH() });
      if (r.ok) {
        const d = await r.json();
        const data = d.data || d; // suporta ambos formatos
        if (data.auto_reply) setAutoReply(data.auto_reply);
        if (data.off_hours)  setOffHours(data.off_hours);
        if (data.csat)       setCsat(data.csat);
        if (data.sla)        setSla(data.sla);
      }
    } catch { /* usa padrões */ }
  };

  const loadInternalContacts = async () => {
    setInternalContactsLoad(true);
    try { setInternalContacts(await apiService.listInternalContacts()); }
    finally { setInternalContactsLoad(false); }
  };

  const handleAddInternalContact = async () => {
    const phone = newInternalPhone.trim();
    if (!phone || addingInternal) return;
    setAddingInternal(true);
    try {
      await apiService.addInternalContact(phone);
      setNewInternalPhone('');
      await loadInternalContacts();
    } catch (e) {
      alert(e.response?.data?.detail || 'Não foi possível adicionar esse número.');
    } finally {
      setAddingInternal(false);
    }
  };

  const handleRemoveInternalContact = async (contactId) => {
    try {
      await apiService.removeInternalContact(contactId);
      setInternalContacts(prev => prev.filter(c => c.id !== contactId));
    } catch (e) {
      alert('Não foi possível remover.');
    }
  };

  const loadTagList = async () => {
    setTagListLoad(true);
    try { setTagList(await apiService.getTags()); }
    finally { setTagListLoad(false); }
  };

  const loadQuickReplyList = async () => {
    setQuickReplyListLoad(true);
    try { setQuickReplyList(await apiService.getQuickReplies()); }
    finally { setQuickReplyListLoad(false); }
  };

  // Busca os papéis reais (tabela roles, gerenciados no Painel Admin → aba
  // "Papéis"). Requer permissão de admin — se falhar (usuário comum, ou papel
  // ainda não carregou), mantém o fallback fixo pra não travar o seletor.
  const loadRoles = async () => {
    try {
      const r = await fetch('/api/admin/roles', { headers: authH() });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data) && data.length) {
          setRoles(data.map(role => ({ id: role.key, label: role.label, color: role.color })));
        }
      }
    } catch { /* mantém DEFAULT_ROLES_FALLBACK */ }
  };

  //  HANDLERS

  const saveGeneral = async () => {
    setSaving(true);
    try {
      localStorage.setItem('wa-notifications', notifications);
      localStorage.setItem('wa-sound', soundEnabled);
      localStorage.setItem('wa-language', language);
      await fetch('/api/settings/general', {
        method: 'POST',
        headers: authH({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ notifications, sound_enabled: soundEnabled, language }),
      });
      flash('ok');
    } catch { flash('error'); } finally { setSaving(false); }
  };

  const toggleAccount = async (id, cur) => {
    try {
      // Tenta nova rota primeiro (PATCH toggle), depois a antiga
      let r = await fetch(`/api/settings/accounts/${id}/toggle`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
      });
      if (!r.ok) {
        r = await fetch(`/api/auth/accounts/${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
          },
          body: JSON.stringify({ is_active: !cur }),
        });
      }
      loadAccounts();
    } catch { alert('Erro ao atualizar conta.'); }
  };

  const deleteAccountConfirm = async (acc) => {
    // Sessão ainda conectada (Baileys/WPPConnect/etc): desloga primeiro pra não deixar
    // a página do Chrome/socket do bridge órfã rodando pra sempre depois que a conta
    // some do banco — foi exatamente esse tipo de sessão zumbi que causou lentidão antes.
    const isConnected = acc.authentication_status === 'AUTHENTICATED' || acc.is_authenticated;
    const warning = isConnected
      ? `Excluir a conta "${acc.account_name}"?\n\nIsso encerra a sessão do WhatsApp conectada e apaga PERMANENTEMENTE todas as conversas e mensagens dela. Não pode ser desfeito.`
      : `Excluir a conta "${acc.account_name}"?\n\nIsso apaga PERMANENTEMENTE todas as conversas e mensagens dela. Não pode ser desfeito.`;
    if (!window.confirm(warning)) return;
    try {
      if (isConnected) {
        try {
          await fetch(`/api/settings/accounts/${acc.id}/logout`, { method: 'POST', headers: authH() });
        } catch { /* segue pro delete mesmo se o logout falhar */ }
      }
      await apiService.deleteAccount(acc.id);
      loadAccounts();
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao excluir conta.');
    }
  };

  // Cria a conta Baileys fallback (ver fallback_for_account_id) pra uma
  // conta WPPConnect e já abre o painel de QR/pairing code pra ela — o
  // vínculo em si (linha no banco) não basta, precisa ser pareada de
  // verdade num aparelho pra funcionar como fallback de envio.
  const handleCreateFallback = async (acc) => {
    setCreatingFallback(true);
    try {
      const res = await apiService.createFallbackAccount(acc.id);
      const fb = res.data;
      await loadAccounts();
      if (!fb.is_authenticated) {
        setSessionQRAccount({ id: fb.id, account_name: fb.account_name, provider_type: 'baileys' });
        setAccountFlow('session_qr');
      }
    } catch (e) {
      alert(e?.response?.data?.detail || 'Erro ao criar fallback de envio.');
    } finally {
      setCreatingFallback(false);
    }
  };

  // Quando ProviderOnboarding completa com sucesso
  const handleOnboardingComplete = (account) => {
    loadAccounts();
    setSuggestedProvider(null);
    if (account && account.provider_type === 'site_chat' && account.id) {
      setEditingAccount({ ...account, ai_webhook_enabled: false, ai_webhook_url: '', ai_webhook_secret: '', ai_webhook_format: 'generic' });
      setAccountFlow('edit');
      return;
    }
    setAccountFlow('list');
  };

  // Quando ProviderSelectorComplete recomenda um provider
  const handleProviderSelected = (providerType) => {
    setSuggestedProvider(providerType);
    setAccountFlow('add'); // vai direto para o Onboarding no step 2
  };

  // Voltar para a lista de contas
  const backToList = () => {
    setAccountFlow('list');
    setSuggestedProvider(null);
  };

  const changeMyPassword = async () => {
    setPwdErrorMsg('');
    if (!pwdForm.current_password || !pwdForm.new_password) {
      setPwdErrorMsg('Preencha a senha atual e a nova senha.');
      return;
    }
    if (pwdForm.new_password.length < 6) {
      setPwdErrorMsg('A nova senha precisa ter pelo menos 6 caracteres.');
      return;
    }
    if (pwdForm.new_password !== pwdForm.confirm_password) {
      setPwdErrorMsg('A confirmação não bate com a nova senha.');
      return;
    }
    setPwdSt('saving');
    try {
      const r = await fetch('/api/settings/me/password', {
        method: 'POST',
        headers: authH({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ current_password: pwdForm.current_password, new_password: pwdForm.new_password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPwdErrorMsg(d.detail || 'Erro ao trocar a senha.');
        setPwdSt('error');
        return;
      }
      setPwdForm({ current_password: '', new_password: '', confirm_password: '' });
      setPwdSt('ok');
    } catch {
      setPwdErrorMsg('Erro de conexão ao trocar a senha.');
      setPwdSt('error');
    }
  };

  const saveDisplayNameFormat = async (fmt) => {
    setDisplayNameFormat(fmt);
    setDisplayNameSt('saving');
    try {
      const r = await fetch('/api/settings/me/display-name', {
        method: 'PATCH',
        headers: authH({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ format: fmt }),
      });
      if (!r.ok) { setDisplayNameSt('error'); return; }
      setDisplayNameSt('ok');
      onDisplayNameFormatChanged?.(fmt);
    } catch {
      setDisplayNameSt('error');
    }
  };

  const loadMetaAppConfig = async () => {
    setMetaAppLoading(true);
    setMetaAppErrorMsg('');
    try {
      const r = await fetch('/api/admin/config', { headers: authH() });
      if (r.status === 401 || r.status === 403) {
        setMetaAppSt('forbidden');
        return;
      }
      if (!r.ok) throw new Error('load failed');
      const data = await r.json();
      setMetaAppConfig(data);
    } catch {
      setMetaAppErrorMsg('Erro ao carregar configuração.');
      setMetaAppSt('error');
    } finally {
      setMetaAppLoading(false);
    }
  };

  const saveMetaAppConfig = async () => {
    if (!metaAppConfig) return;
    setMetaAppSt('saving');
    setMetaAppErrorMsg('');
    try {
      const r = await fetch('/api/admin/config', {
        method: 'PATCH',
        headers: authH({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(metaAppConfig),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMetaAppErrorMsg(d.detail || 'Erro ao salvar configuração.');
        setMetaAppSt('error');
        return;
      }
      setMetaAppConfig(d);
      setMetaAppSt('ok');
    } catch {
      setMetaAppErrorMsg('Erro de conexão ao salvar.');
      setMetaAppSt('error');
    }
  };

  const addUser = async () => {
    if (!newUser.username || !newUser.password) return;
    try {
      const r = await fetch('/api/settings/users', {
        method: 'POST',
        headers: authH({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(newUser),
      });
      if (r.ok) {
        setNewUser({ username: '', password: '', role: 'attendant', sector: '' });
        loadUsers();
      } else {
        const e = await r.json();
        alert(e.detail || 'Erro ao criar usuário');
      }
    } catch { alert('Erro de conexão.'); }
  };

  const removeUser = async (username) => {
    if (username === 'admin') return alert('Não é possível remover o admin.');
    if (!window.confirm(`Remover "${username}"?`)) return;
    try { await fetch(`/api/settings/users/${username}`, { method: 'DELETE', headers: authH() }); loadUsers(); }
    catch { alert('Erro ao remover.'); }
  };

  const saveAutomations = async () => {
    setSaving(true);
    try {
      await fetch('/api/settings/automations', {
        method: 'POST',
        headers: authH({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ auto_reply: autoReply, off_hours: offHours, csat, sla }),
      });
      flash('ok');
    } catch { flash('error'); } finally { setSaving(false); }
  };

  // ── Etiquetas ───────────────────────────────────────────────
  const handleSaveStatusColors = async () => {
    setSavingStatusColors(true);
    try {
      await apiService.updateStatusColors(draftStatusColors);
      onStatusColorsChanged && onStatusColorsChanged();
      flash('ok');
    } catch (e) {
      alert(e.response?.data?.detail || 'Erro ao salvar as cores de status.');
    } finally {
      setSavingStatusColors(false);
    }
  };

  const handleSaveTag = async () => {
    if (!tagForm.name.trim()) return;
    if (tagForm.scope === 'sector' && !tagForm.sector.trim()) {
      alert('Selecione o setor da etiqueta.');
      return;
    }
    setSavingTag(true);
    try {
      if (editingTagId) await apiService.updateTag(editingTagId, tagForm);
      else await apiService.createTag(tagForm);
      setTagForm(EMPTY_TAG);
      setEditingTagId(null);
      await loadTagList();
      onTagsChanged && onTagsChanged();
    } catch (e) {
      alert(e.response?.data?.detail || 'Erro ao salvar etiqueta.');
    } finally {
      setSavingTag(false);
    }
  };

  const handleEditTagList = (t) => {
    setEditingTagId(t.id);
    setTagForm({
      name: t.name, color: t.color || '#0EA5A4', scope: t.scope || 'global', sector: t.sector || '',
      taskTitle: t.task_title || '', taskDescription: t.task_description || '', taskPriority: t.task_priority || 'medium',
      taskDueDays: t.task_due_days || '', taskAssignedTo: t.task_assigned_to || '',
      sharedWith: t.shared_with || [],
    });
  };

  const toggleTagSharedWith = (userId) => {
    setTagForm(p => {
      const has = (p.sharedWith || []).includes(userId);
      return { ...p, sharedWith: has ? p.sharedWith.filter(id => id !== userId) : [...(p.sharedWith || []), userId] };
    });
  };

  const handleDeleteTagList = async (id) => {
    if (!window.confirm('Apagar esta etiqueta? Ela será removida de todas as conversas.')) return;
    try {
      await apiService.deleteTag(id);
      if (editingTagId === id) { setEditingTagId(null); setTagForm(EMPTY_TAG); }
      await loadTagList();
      onTagsChanged && onTagsChanged();
    } catch (e) { alert(e.response?.data?.detail || 'Erro ao apagar etiqueta.'); }
  };

  // ── Respostas Rápidas ───────────────────────────────────────
  // shared_with: compartilhamento ponto-a-ponto — por padrão vazio (só o
  // autor vê/usa); o autor escolhe colegas específicos pra compartilhar,
  // sem opção de "compartilhar com todo mundo" de uma vez.
  const EMPTY_QR = { shortcut: '', text: '', media_url: null, media_type: null, media_filename: null, media_mime: null, shared_with: [] };

  // Mesma lógica de App.js getFileType — infere image/video/audio/document
  // pelo mimetype pra guardar junto da resposta rápida (ícone na lista).
  const inferQrMediaType = (file) => {
    const type = file.type.split('/')[0];
    if (type === 'image') return (file.type === 'image/webp' || file.name.endsWith('.webp')) ? 'sticker' : 'image';
    if (type === 'video') return 'video';
    if (type === 'audio') return 'audio';
    return 'document';
  };

  const handleQrMediaSelect = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingQrMedia(true);
    try {
      const res = await apiService.uploadPublicMedia(file);
      if (res && res.path) {
        setNewQr(p => ({
          ...p,
          media_url: res.path,
          media_type: inferQrMediaType(file),
          media_filename: file.name,
          media_mime: file.type || 'application/octet-stream',
        }));
      }
    } catch (err) {
      alert('Falha no upload da mídia.');
    } finally {
      setUploadingQrMedia(false);
      e.target.value = '';
    }
  };

  const handleRemoveQrMedia = () => {
    setNewQr(p => ({ ...p, media_url: null, media_type: null, media_filename: null, media_mime: null }));
  };

  const handleSaveQuickReply = async () => {
    const shortcut = newQr.shortcut.trim().replace(/^\//, '');
    const text = newQr.text.trim();
    if (!shortcut || (!text && !newQr.media_url)) return;
    const payload = {
      shortcut, text,
      media_url: newQr.media_url, media_type: newQr.media_type,
      media_filename: newQr.media_filename, media_mime: newQr.media_mime,
      shared_with: newQr.shared_with || [],
    };
    try {
      if (editingQrId) {
        await apiService.updateQuickReply(editingQrId, payload);
      } else {
        await apiService.createQuickReply(payload);
      }
      setNewQr(EMPTY_QR);
      setEditingQrId(null);
      await loadQuickReplyList();
      onQuickRepliesChanged && onQuickRepliesChanged();
    } catch (e) { alert(e.response?.data?.detail || 'Erro ao salvar resposta rápida.'); }
  };

  const handleEditQuickReply = (qr) => {
    setEditingQrId(qr.id);
    setNewQr({
      shortcut: qr.shortcut, text: qr.text || '',
      media_url: qr.media_url || null, media_type: qr.media_type || null,
      media_filename: qr.media_filename || null, media_mime: qr.media_mime || null,
      shared_with: qr.shared_with || [],
    });
  };

  const toggleQrSharedWith = (userId) => {
    setNewQr(p => {
      const has = (p.shared_with || []).includes(userId);
      return { ...p, shared_with: has ? p.shared_with.filter(id => id !== userId) : [...(p.shared_with || []), userId] };
    });
  };

  const handleDeleteQuickReply = async (id) => {
    if (!window.confirm('Apagar esta resposta rápida?')) return;
    try {
      await apiService.deleteQuickReply(id);
      if (editingQrId === id) { setEditingQrId(null); setNewQr(EMPTY_QR); }
      await loadQuickReplyList();
      onQuickRepliesChanged && onQuickRepliesChanged();
    } catch (e) { alert(e.response?.data?.detail || 'Erro ao apagar resposta rápida.'); }
  };

  //  HELPERS

  const getProviderVisual = (id) => PROVIDER_VISUAL[id] || { icon: '📱', color: '#0EA5A4', label: id };

  const TABS = [
    { id: 'general',          icon: <MdSettings size={17} />,    label: 'Geral' },
    { id: 'accounts',         icon: <FaWhatsapp size={16} />,    label: 'Contas WA' },
    { id: 'meta_app',         icon: <MdApps size={17} />,        label: 'App Meta' },
    { id: 'credentials',      icon: <MdLock size={17} />,        label: 'Minha Conta' },
    { id: 'analytics',        icon: <MdBarChart size={17} />,    label: 'Analytics' },
    { id: 'business_profile', icon: <MdBusiness size={17} />,   label: 'Perfil Negócio' },
    { id: 'templates',        icon: <MdArticle size={17} />,     label: 'Templates' },
    { id: 'catalog',          icon: <MdStorefront size={17} />,  label: 'Catálogo' },
    { id: 'flows',            icon: <MdDynamicForm size={17} />, label: 'Flows' },
    { id: 'phone_quality',    icon: <MdSignalCellularAlt size={17} />, label: 'Qualidade do Número' },
    { id: 'users',            icon: <MdGroup size={17} />,       label: 'Usuários' },
    { id: 'atendimento',      icon: <MdLabel size={17} />,       label: 'Atendimento' },
    { id: 'internal_contacts', icon: <MdWorkOutline size={17} />, label: 'Contatos internos' },
    { id: 'automations',      icon: <MdAutoAwesome size={17} />, label: 'Automações' },
  ].filter(t => canSeeSettingsTab(t.id));

  const activeProviderVisual = accounts[0]
    ? getProviderVisual(accounts[0].provider_type)
    : null;

  if (!isOpen) return null;

  //  RENDER

  return (
    <div className="sm-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sm-modal">

        {/* ─── Header ─── */}
        <div className="sm-header">
          <div className="sm-header-left"><MdSettings size={20} /><span>Configurações</span></div>
          <div className="sm-header-right">
            {saveSt === 'ok'    && <span className="sm-flash ok"><MdCheckCircle size={15} /> Salvo</span>}
            {saveSt === 'error' && <span className="sm-flash err"><MdError size={15} /> Erro ao salvar</span>}
            <button className="sm-icon-btn" onClick={onClose}><MdClose size={20} /></button>
          </div>
        </div>

        {/* ─── Body ─── */}
        <div className="sm-body">

          {/* Sidebar */}
          <aside className="sm-sidebar">
            <div className="sm-user-badge">
              <div className="sm-avatar">{(currentUser || 'A')[0].toUpperCase()}</div>
              <div>
                <div className="sm-username">{currentUser || 'Usuário'}</div>
                <div className="sm-userrole">{currentUser === 'admin' ? '👑 Admin' : '👤 Atendente'}</div>
              </div>
            </div>

            <nav className="sm-tabs">
              {TABS.map(t => (
                <button
                  key={t.id}
                  className={`sm-tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => { setTab(t.id); setAccountFlow('list'); }}
                >
                  {t.icon}<span>{t.label}</span>
                </button>
              ))}
            </nav>

            {activeProviderVisual && (
              <div className="sm-active-provider">
                <span className="sm-ap-label">Provedor ativo</span>
                <div className="sm-ap-badge" style={{ borderColor: activeProviderVisual.color }}>
                  <span>{activeProviderVisual.icon}</span>
                  <span>{activeProviderVisual.label}</span>
                </div>
              </div>
            )}
          </aside>

          {/* Conteúdo das abas */}
          <div className="sm-content">

            {/* ════════ GERAL ════════ */}
            {tab === 'general' && (
              <div className="sm-pane">
                <h2 className="sm-title">⚙️ Configurações Gerais</h2>

                <div className="sm-section">
                  <h3>Aparência</h3>
                  <div className="sm-row">
                    <div className="sm-row-info"><span>Tema</span><small>Modo escuro ou claro</small></div>
                    <button className="sm-toggle-btn" onClick={onToggleTheme}>
                      {currentTheme === 'dark' ? <><MdLightMode size={15} /> Modo Claro</> : <><MdDarkMode size={15} /> Modo Escuro</>}
                    </button>
                  </div>
                </div>

                <div className="sm-section">
                  <h3>Idioma</h3>
                  <div className="sm-row">
                    <div className="sm-row-info"><span>Idioma da interface</span></div>
                    <select className="sm-select" value={language} onChange={e => setLanguage(e.target.value)}>
                      <option value="pt-BR">🇧🇷 Português (BR)</option>
                      <option value="en-US">🇺🇸 English</option>
                      <option value="es-ES">🇪🇸 Español</option>
                    </select>
                  </div>
                </div>

                <div className="sm-section">
                  <h3>Notificações e Sons</h3>
                  <div className="sm-row">
                    <div className="sm-row-info"><span>Notificações do navegador</span><small>Alertas para novas mensagens</small></div>
                    <button className={`sm-pill ${notifications ? 'on' : 'off'}`} onClick={() => setNotifications(p => !p)}>
                      {notifications ? <><MdNotifications size={13} /> Ativo</> : <><MdNotificationsOff size={13} /> Inativo</>}
                    </button>
                  </div>
                  {/* Permissão de verdade do NAVEGADOR é separada do toggle acima (que é
                      só a preferência do app) — precisa de um clique dedicado igual a
                      permissão de microfone (só pede quando aperta pra gravar, nunca
                      sozinho ao abrir a tela: o Chrome trata pedido sem gesto direto
                      como "baixo engajamento" e o popup clássico nem aparece). */}
                  {notifications && browserNotifPermission === 'default' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <button
                        type="button"
                        className="sm-pill off"
                        onClick={async () => {
                          const permission = await requestNotificationPermission();
                          setBrowserNotifPermission(permission);
                          if (permission !== 'granted') return;
                          const vapidRes = await apiService.getPushVapidPublicKey().catch(() => null);
                          const publicKey = vapidRes?.data?.public_key;
                          if (!publicKey) return;
                          const subscription = await subscribeToPush(publicKey);
                          if (subscription) apiService.subscribeToPush(subscription).catch(() => {});
                        }}
                      >
                        <MdNotifications size={13} /> Permitir no navegador
                      </button>
                      <small style={{ opacity: 0.7 }}>Ainda não perguntamos ao navegador — clique aqui pra liberar.</small>
                    </div>
                  )}
                  {notifications && browserNotifPermission === 'denied' && (
                    <div style={{ fontSize: 11.5, color: '#e53e3e', marginTop: 6 }}>
                      ⚠️ O navegador bloqueou as notificações deste site (não tem como pedir de novo por aqui). Pra liberar, clique no ícone de cadeado/informação ao lado do endereço na barra do navegador e permita "Notificações" — depois disso volta a funcionar sozinho, sem precisar fazer nada aqui.
                    </div>
                  )}
                  {notifications && browserNotifPermission === 'granted' && (
                    <div style={{ fontSize: 11.5, color: 'var(--whatsapp-green, #25D366)', marginTop: 6 }}>
                      ✅ Permitido pelo navegador.
                    </div>
                  )}
                  {notifications && browserNotifPermission === 'unsupported' && (
                    <div style={{ fontSize: 11.5, color: '#e53e3e', marginTop: 6 }}>
                      ⚠️ Este navegador não suporta notificações desktop (o som de mensagem continua funcionando normalmente).
                    </div>
                  )}
                  {!notifications && (
                    <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 6 }}>
                      Notificações desativadas — clique em "Inativo" acima pra ligar.
                    </div>
                  )}
                  <div className="sm-row" style={{ marginTop: 10 }}>
                    <div className="sm-row-info"><span>Sons</span><small>Som ao receber mensagens</small></div>
                    <button className={`sm-pill ${soundEnabled ? 'on' : 'off'}`} onClick={() => setSoundEnabled(p => !p)}>
                      {soundEnabled ? '🔊 Ativo' : '🔇 Mudo'}
                    </button>
                  </div>
                </div>

                <button className="sm-save-btn" onClick={saveGeneral} disabled={saving}>
                  {saving ? <><MdRefresh size={14} className="spin" /> Salvando...</> : <><MdSave size={14} /> Salvar</>}
                </button>
              </div>
            )}

            {/* ════════ CONTAS WA ════════ */}
            {tab === 'accounts' && (
              <div className="sm-pane">
                <h2 className="sm-title">📱 Contas WhatsApp</h2>

                {/* ── VIEW: Lista de contas ── */}
                {accountFlow === 'list' && (
                  <>
                    <div className="sm-section">
                      <div className="sm-section-hr">
                        <h3>Contas cadastradas</h3>
                        {canManageAccountsFully && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="sm-help-btn" onClick={() => setAccountFlow('help')} title="Não sei qual escolher">
                              <MdHelpOutline size={15} /> Ajuda para escolher
                            </button>
                            {/* Onboarding direto */}
                            <button className="sm-add-btn" onClick={() => setAccountFlow('add')}>
                              <MdAdd size={15} /> Adicionar Conta
                            </button>
                          </div>
                        )}
                      </div>

                      {accountsLoading ? (
                        <p className="sm-loading">Carregando contas...</p>
                      ) : accounts.length === 0 ? (
                        <div className="sm-empty">
                          <FaWhatsapp size={40} />
                          <p>{canManageAccountsFully ? 'Nenhuma conta cadastrada.' : 'Nenhuma conta vinculada ao seu usuário.'}</p>
                          {canManageAccountsFully && (
                            <button className="sm-save-btn" onClick={() => setAccountFlow('add')}>
                              <MdAdd size={14} /> Adicionar Conta
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="sm-acc-list">
                          {accounts.filter(acc => !acc.fallback_for_account_id).map(acc => {
                            const pv = getProviderVisual(acc.provider_type);
                            const st = AUTH_STATUS[acc.authentication_status] || AUTH_STATUS.PENDING;
                            const needsQR     = acc.requires_session_qr || UNOFFICIAL_PROVIDERS.includes((acc.provider_type || '').toLowerCase());
                            const isConnected = acc.authentication_status === 'AUTHENTICATED' || acc.is_authenticated;
                            // Conta Baileys criada só como fallback de envio LID
                            // (ver fallback_for_account_id) não vira card próprio
                            // (filtro acima) — em vez disso vira um selo aqui, na
                            // conta WPPConnect que ela reforça, pra deixar claro
                            // que é a MESMA conta real, não uma conta nova.
                            const fallbackFor = accounts.find(other => other.fallback_for_account_id === acc.id);
                            return (
                              <div key={acc.id} className={`sm-acc-card ${!acc.is_active ? 'inactive' : ''}`}>
                                <div className="sm-acc-icon" style={{ background: pv.color }}>{pv.icon}</div>
                                <div className="sm-acc-info">
                                  <strong>{acc.account_name}</strong>
                                  {acc.provider_type !== 'site_chat' && <span><MdPhone size={11} /> {acc.phone_number}</span>}
                                  <div className="sm-acc-badges">
                                    <span className="sm-provider-chip" style={{ borderColor: pv.color }}>{pv.label}</span>
                                    <span className="sm-status-chip" style={{ color: st.color }}>{st.icon} {st.label}</span>
                                    {fallbackFor && (
                                      <span
                                        className="sm-status-chip"
                                        title={`Reforço de envio (${fallbackFor.account_name}): quando o WhatsApp bloqueia a primeira mensagem pra um contato novo, essa mesma conta tenta reenviar por um segundo caminho automaticamente.`}
                                      >
                                        🔀 Fallback de envio ativo
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="sm-acc-actions">
                                  {/* Providers não-oficiais: botão "Autenticar via QR" */}
                                  {needsQR && !isConnected && (
                                    <button
                                      className="sm-pill sm-pill-qr"
                                      title="Vincular via QR Code ou Código de Pareamento"
                                      onClick={() => {
                                        setSessionQRAccount({
                                          id: acc.id,
                                          account_name: acc.account_name,
                                          provider_type: (acc.provider_type || '').toLowerCase(),
                                        });
                                        setAccountFlow('session_qr');
                                      }}
                                    >
                                      <MdQrCode size={12} /> Vincular WhatsApp
                                    </button>
                                  )}
                                  {/* Providers não-oficiais autenticados: botão desconectar */}
                                  {needsQR && isConnected && (
                                    <button
                                      className="sm-pill sm-pill-danger"
                                      title="Desconectar sessão WhatsApp Web"
                                      onClick={async () => {
                                        if (!window.confirm('Desconectar esta sessão?')) return;
                                        try {
                                          await fetch(`/api/settings/accounts/${acc.id}/logout`, { method: 'POST', headers: authH() });
                                          loadAccounts();
                                        } catch { alert('Erro ao desconectar.'); }
                                      }}
                                    >
                                      Desconectar
                                    </button>
                                  )}
                                  {canManageAccountsFully && (acc.provider_type || '').toLowerCase().startsWith('meta') && (
                                    <button
                                      className="sm-pill small"
                                      title="Verificar se o app está inscrito pra receber mensagem/status dessa conta"
                                      onClick={async () => {
                                        try {
                                          const status = await apiService.getSubscribedApps(acc.id);
                                          if (status.subscribed) {
                                            const appName = status.data?.[0]?.whatsapp_business_api_data?.name || 'App';
                                            alert(`✅ Webhook OK — ${appName} está inscrito e recebendo mensagens dessa conta.`);
                                          } else if (window.confirm('⚠️ O App não está inscrito no webhook dessa conta — por isso mensagens/status podem não estar chegando no sistema.\n\nInscrever agora?')) {
                                            await apiService.subscribeApp(acc.id);
                                            alert('✅ Inscrito com sucesso! Mensagens dessa conta devem começar a chegar.');
                                          }
                                        } catch (e) {
                                          alert(e?.response?.data?.detail || 'Erro ao verificar o webhook.');
                                        }
                                      }}
                                    >
                                      <MdWifiTethering size={12} /> Testar Webhook
                                    </button>
                                  )}
                                  {canManageAccountsFully && ['meta_cloud_mmlite', 'meta_cloud_full'].includes((acc.provider_type || '').toLowerCase()) && (
                                    <button
                                      className="sm-pill small"
                                      title="Verificar se essa conta já aceitou os termos do MM Lite na Meta"
                                      onClick={async () => {
                                        try {
                                          const status = await apiService.getMMLiteStatus(acc.id);
                                          alert(`${status.ready ? '✅' : 'ℹ️'} MM Lite — ${status.onboarding_status}\n\n${status.message}`);
                                        } catch (e) {
                                          alert(e?.response?.data?.detail || 'Erro ao verificar o status do MM Lite.');
                                        }
                                      }}
                                    >
                                      <MdWifiTethering size={12} /> Status MM Lite
                                    </button>
                                  )}
                                  {canManageAccountsFully && ['meta_cloud_mmlite', 'meta_cloud_full'].includes((acc.provider_type || '').toLowerCase()) && (
                                    <button
                                      className="sm-pill small"
                                      title="Ver métricas reais (enviado/entregue/lido) dos templates de marketing dos últimos 7 dias"
                                      onClick={async () => {
                                        try {
                                          const res = await apiService.getMMLiteAnalytics(acc.id, 7);
                                          if (!res.templates?.length) {
                                            alert(res.message || 'Nenhum template MARKETING encontrado.');
                                            return;
                                          }
                                          const lines = res.templates.map(t => {
                                            const pct = v => v == null ? '—' : `${Math.round(v * 100)}%`;
                                            return `${t.name}\n  Enviado: ${t.sent} | Entregue: ${t.delivered} (${pct(t.delivery_rate)}) | Lido: ${t.read} (${pct(t.read_rate)}) | Respondido: ${t.replied} (${pct(t.reply_rate)})`;
                                          });
                                          alert(`📊 MM Lite — últimos 7 dias\n\n${lines.join('\n\n')}`);
                                        } catch (e) {
                                          alert(e?.response?.data?.detail || 'Erro ao buscar analytics do MM Lite.');
                                        }
                                      }}
                                    >
                                      <MdWifiTethering size={12} /> Analytics MM Lite
                                    </button>
                                  )}
                                  {canManageAccountsFully && ['meta_cloud_coexistence', 'meta_cloud_full'].includes((acc.provider_type || '').toLowerCase()) && (
                                    <button
                                      className="sm-pill small"
                                      title="Verificar sincronização com o app WhatsApp Business do celular"
                                      onClick={async () => {
                                        try {
                                          const status = await apiService.getCoexistenceStatus(acc.id);
                                          const pct = status.history_sync.progress_pct;
                                          alert(
                                            `${status.ready ? '✅' : 'ℹ️'} Coexistência\n\n${status.message}\n\n` +
                                            `Histórico: ${status.history_sync.chunks_received} pacote(s)${pct != null ? ` (${pct}%)` : ''}\n` +
                                            `Eventos de sincronização: ${status.app_state_sync.events_received}\n` +
                                            `Ecos de mensagem do app: ${status.message_echoes.echoes_received}`
                                          );
                                        } catch (e) {
                                          alert(e?.response?.data?.detail || 'Erro ao verificar o status da Coexistência.');
                                        }
                                      }}
                                    >
                                      <MdWifiTethering size={12} /> Status Coexistência
                                    </button>
                                  )}
                                  {canManageAccountsFully && (
                                    <button
                                      className="sm-pill small"
                                      title="Editar Conta"
                                      onClick={() => {
                                        setEditingAccount({
                                          ...acc,
                                          meta_phone_number_id: acc.meta_phone_number_id || '',
                                          meta_access_token: acc.meta_access_token || '',
                                          meta_business_account_id: acc.meta_business_account_id || '',
                                          meta_catalog_id: acc.meta_catalog_id || '',
                                          session_id: acc.session_id || '',
                                          wppconnect_url: acc.wppconnect_url || '',
                                          wppconnect_token: acc.wppconnect_token || '',
                                          ai_webhook_enabled: acc.ai_webhook_enabled || false,
                                          ai_webhook_url: acc.ai_webhook_url || '',
                                          ai_webhook_secret: acc.ai_webhook_secret || '',
                                          ai_webhook_format: acc.ai_webhook_format || 'generic'
                                        });
                                        setAccountFlow('edit');
                                      }}
                                    >
                                      <MdEdit size={12} /> Editar
                                    </button>
                                  )}
                                  {canManageAccountsFully && (
                                    <button
                                      className={`sm-pill small ${acc.is_active ? 'on' : 'off'}`}
                                      onClick={() => toggleAccount(acc.id, acc.is_active)}
                                    >
                                      {acc.is_active ? 'Ativo' : 'Inativo'}
                                    </button>
                                  )}
                                  {canManageAccountsFully && (
                                    <button
                                      className="sm-pill small sm-pill-danger"
                                      title="Excluir Conta"
                                      onClick={() => deleteAccountConfirm(acc)}
                                    >
                                      <MdDelete size={12} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="sm-info-box">
                      <MdQrCode size={15} />
                      <span>
                        <strong>Baileys, Venom, WPPConnect, WA-Web.js:</strong> clique em "Autenticar via QR"
                        para conectar via WhatsApp Web. &nbsp;
                        <strong>QR de marketing</strong> (links para clientes): use o <strong>QR Code Manager</strong> no menu lateral (⋮).
                      </span>
                    </div>
                  </>
                )}

                {/* ── VIEW: Quiz de ajuda — ProviderSelectorComplete existente ── */}
                {accountFlow === 'help' && (
                  <div className="settings-embedded-component settings-embedded-selector">
                    <ProviderSelectorComplete
                      onProviderSelected={handleProviderSelected}
                      onCancel={backToList}
                    />
                  </div>
                )}

                {/* ── VIEW: Onboarding completo — ProviderOnboarding existente ── */}
                {accountFlow === 'add' && (
                  <div className="settings-embedded-component settings-embedded-onboarding">
                    <ProviderOnboarding
                      onComplete={handleOnboardingComplete}
                      onCancel={backToList}
                      initialProviderType={suggestedProvider}
                    />
                  </div>
                )}

                {/* ── VIEW: QR ou Pairing Code — WhatsAppLinkPanel NOVO ── */}
                {accountFlow === 'session_qr' && sessionQRAccount && (
                  <div className="sm-session-qr-pane">
                    {/* Botão voltar */}
                    <button className="sm-back-btn" onClick={() => { setAccountFlow('list'); setSessionQRAccount(null); }}>
                      ← Voltar para contas
                    </button>
                    <WhatsAppLinkPanel
                      accountId={sessionQRAccount.id}
                      providerType={sessionQRAccount.provider_type}
                      accountName={sessionQRAccount.account_name}
                      onAuthenticated={() => {
                        loadAccounts();
                        setAccountFlow('list');
                        setSessionQRAccount(null);
                      }}
                      onClose={() => {
                        setAccountFlow('list');
                        setSessionQRAccount(null);
                      }}
                    />
                  </div>
                )}

                {/* ── VIEW: Editar Conta ── */}
                {accountFlow === 'edit' && editingAccount && (
                  <div className="sm-session-qr-pane" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    <button className="sm-back-btn" onClick={() => { setAccountFlow('list'); setEditingAccount(null); }}>
                      ← Voltar para contas
                    </button>
                    <h3 style={{ margin: '0 0 10px 0' }}>Editar Conta</h3>
                    
                    <div className="sm-field">
                      <label>Tipo do Provedor</label>
                      {(editingAccount.provider_type || '').toLowerCase().startsWith('meta_') ? (
                        <>
                          <select
                            value={(editingAccount.provider_type || '').toLowerCase()}
                            onChange={e => setEditingAccount({ ...editingAccount, provider_type: e.target.value })}
                          >
                            <option value="meta_cloud_basic">META CLOUD BASIC</option>
                            <option value="meta_cloud_mmlite">META CLOUD MMLITE</option>
                            <option value="meta_cloud_coexistence">META CLOUD COEXISTENCE</option>
                            <option value="meta_cloud_full">META CLOUD FULL</option>
                          </select>
                          {['meta_cloud_mmlite', 'meta_cloud_full'].includes((editingAccount.provider_type || '').toLowerCase()) && (
                            <small style={{ opacity: 0.7 }}>
                              MM Lite só se aplica a templates categoria MARKETING — a conta precisa ter aceitado os termos na Meta (ver botão "Status MM Lite").
                            </small>
                          )}
                          {['meta_cloud_coexistence', 'meta_cloud_full'].includes((editingAccount.provider_type || '').toLowerCase()) && (
                            <small style={{ opacity: 0.7 }}>
                              Coexistência sincroniza histórico e mensagens do app do celular via webhook da Meta —
                              use o botão "Status Coexistência" na lista de contas pra acompanhar.
                            </small>
                          )}
                        </>
                      ) : (
                        <input
                          type="text"
                          value={editingAccount.provider_type?.toUpperCase() || ''}
                          disabled
                          style={{ opacity: 0.7, cursor: 'not-allowed' }}
                        />
                      )}
                    </div>
                    
                    <div className="sm-field">
                      <label>Nome da Conta</label>
                      <input 
                        type="text" 
                        value={editingAccount.account_name} 
                        onChange={e => setEditingAccount({...editingAccount, account_name: e.target.value})} 
                      />
                    </div>
                    
                    {editingAccount.provider_type !== 'site_chat' && (
                      <div className="sm-field">
                        <label>Número de Telefone</label>
                        <input
                          type="text"
                          value={editingAccount.phone_number}
                          onChange={e => setEditingAccount({...editingAccount, phone_number: e.target.value})}
                        />
                      </div>
                    )}

                    {editingAccount.provider_type === 'site_chat' && editingAccount.id && (
                      <SiteChatConfigCard accountId={editingAccount.id} />
                    )}

                    <div className="sm-field" style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color, #eee)' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={editingAccount.attendance_enabled !== false}
                          onChange={e => setEditingAccount({ ...editingAccount, attendance_enabled: e.target.checked })}
                        />
                        Essa conta participa da fila de atendimento (SLA/tempos)
                      </label>
                      <span style={{ fontSize: '12px', color: '#888', marginTop: '4px', display: 'block' }}>
                        Desligue pra números que não são atendimento ao cliente de verdade (ex: linha interna de
                        TI/Logística falando com fornecedor) — as conversas continuam funcionando normalmente no
                        chat, só saem das contagens de "aguardando cliente", "estourando SLA" e demais métricas do
                        Painel Admin.
                      </span>
                    </div>

                    {/* Fallback de envio (Baileys) — só faz sentido pra WPPConnect,
                        que é onde o "No LID for user" acontece (ver
                        _find_baileys_fallback_account em routes.py). Mostra o
                        vínculo existente (se houver) com status + ações, ou o
                        convite pra criar um novo. */}
                    {editingAccount.provider_type === 'wppconnect' && (() => {
                      const fb = accounts.find(a => a.fallback_for_account_id === editingAccount.id);
                      return (
                        <div className="sm-field" style={{ border: '1px solid var(--border-color, #ddd)', borderRadius: 8, padding: 12 }}>
                          <label style={{ marginBottom: 6, display: 'block' }}>Fallback de envio (Baileys)</label>
                          <p style={{ fontSize: 12, opacity: 0.75, margin: '0 0 10px 0' }}>
                            Quando o WhatsApp bloqueia a primeira mensagem pra um contato novo
                            ("No LID for user"), essa MESMA conta tenta reenviar automaticamente
                            por um segundo aparelho vinculado (Baileys) — não é uma conta nova,
                            fica escondida do trocador de contas e nunca recebe conversas próprias.
                          </p>
                          {fb ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span className="sm-status-chip" style={{ color: fb.is_authenticated ? '#25D366' : '#e67e22' }}>
                                {fb.is_authenticated ? '✅ Vinculado e ativo' : '⏳ Aguardando parear (QR/código)'}
                              </span>
                              {!fb.is_authenticated && (
                                <button
                                  type="button"
                                  className="sm-pill sm-pill-qr"
                                  onClick={() => { setSessionQRAccount({ id: fb.id, account_name: fb.account_name, provider_type: 'baileys' }); setAccountFlow('session_qr'); }}
                                >
                                  <MdQrCode size={12} /> Parear agora
                                </button>
                              )}
                              <button
                                type="button"
                                className="sm-pill sm-pill-danger"
                                onClick={() => deleteAccountConfirm(fb)}
                              >
                                Remover fallback
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="sm-pill sm-pill-qr"
                              disabled={creatingFallback}
                              onClick={() => handleCreateFallback(editingAccount)}
                            >
                              <MdQrCode size={12} /> {creatingFallback ? 'Criando...' : 'Ativar fallback de envio'}
                            </button>
                          )}
                        </div>
                      );
                    })()}

                    {(editingAccount.provider_type?.startsWith('meta_') || editingAccount.provider_type === 'gupshup') && (
                      <>
                        <div className="sm-field">
                          <label>Phone Number ID (Meta)</label>
                          <input 
                            type="text" 
                            value={editingAccount.meta_phone_number_id} 
                            onChange={e => setEditingAccount({...editingAccount, meta_phone_number_id: e.target.value})} 
                          />
                        </div>
                        <div className="sm-field">
                          <label>Access Token (Meta)</label>
                          <input 
                            type="password" 
                            value={editingAccount.meta_access_token} 
                            onChange={e => setEditingAccount({...editingAccount, meta_access_token: e.target.value})} 
                          />
                        </div>
                        <div className="sm-field">
                          <label>Business Account ID (Meta)</label>
                          <input
                            type="text"
                            value={editingAccount.meta_business_account_id}
                            onChange={e => setEditingAccount({...editingAccount, meta_business_account_id: e.target.value})}
                          />
                        </div>
                        <div className="sm-field">
                          <label>Catalog ID (Meta — opcional, para produtos/carrinho)</label>
                          <input
                            type="text"
                            placeholder="ex: 987654321098765"
                            value={editingAccount.meta_catalog_id}
                            onChange={e => setEditingAccount({...editingAccount, meta_catalog_id: e.target.value})}
                          />
                        </div>
                      </>
                    )}

                    {['baileys', 'venom', 'whatsapp_web_js'].includes(editingAccount.provider_type) && (
                      <div className="sm-field">
                        <label>Session ID</label>
                        <input 
                          type="text" 
                          value={editingAccount.session_id} 
                          onChange={e => setEditingAccount({...editingAccount, session_id: e.target.value})} 
                        />
                        <span style={{ fontSize: '12px', color: '#888', marginTop: '4px', display: 'block' }}>
                          Identificador único desta sessão no bridge. Use letras, números e hífens.
                        </span>
                      </div>
                    )}

                    {editingAccount.provider_type === 'wppconnect' && (
                      <>
                        <span style={{ fontSize: '12px', color: '#888', display: 'block', marginBottom: '8px' }}>
                          O bridge do WPPConnect já roda neste servidor. Deixe em branco para usar o padrão local.
                        </span>
                        <div className="sm-field">
                          <label>URL do servidor WPPConnect (opcional)</label>
                          <input
                            type="text"
                            placeholder="padrão: http://localhost:3003"
                            value={editingAccount.wppconnect_url}
                            onChange={e => setEditingAccount({...editingAccount, wppconnect_url: e.target.value})}
                          />
                        </div>
                        <div className="sm-field">
                          <label>Token (opcional)</label>
                          <input
                            type="password"
                            placeholder="deixe em branco para usar o padrão local"
                            value={editingAccount.wppconnect_token}
                            onChange={e => setEditingAccount({...editingAccount, wppconnect_token: e.target.value})}
                          />
                        </div>
                        <div className="sm-field">
                          <label>Session ID</label>
                          <input 
                            type="text" 
                            value={editingAccount.session_id} 
                            onChange={e => setEditingAccount({...editingAccount, session_id: e.target.value})} 
                          />
                        </div>
                      </>
                    )}

                    <div className="sm-field" style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-color, #eee)' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={!!editingAccount.ai_webhook_enabled}
                          onChange={e => setEditingAccount({ ...editingAccount, ai_webhook_enabled: e.target.checked })}
                        />
                        Responder essa conta com um bot/IA externo (n8n, Make, ou outra ferramenta)
                      </label>
                      <span style={{ fontSize: '12px', color: '#888', marginTop: '4px', display: 'block' }}>
                        Quando ligado, toda mensagem que um cliente manda pra esse número é repassada automaticamente
                        pra uma ferramenta de automação escolhida por você, que decide a resposta e manda de volta.
                        Um atendente humano sempre pode assumir a conversa a qualquer momento — o bot pausa sozinho
                        nela quando isso acontece.
                      </span>
                    </div>
                    {editingAccount.ai_webhook_enabled && (
                      <>
                        <div className="sm-field">
                          <label>Formato do webhook</label>
                          <select
                            value={editingAccount.ai_webhook_format || 'generic'}
                            onChange={e => setEditingAccount({ ...editingAccount, ai_webhook_format: e.target.value })}
                          >
                            <option value="generic">Genérico (recomendado p/ qualquer ferramenta nova)</option>
                            <option value="evolution_compat">Compatível com Evolution API (p/ migrar um bot já pronto que fala com a Evolution API)</option>
                          </select>
                          <span style={{ fontSize: '12px', color: '#888', marginTop: '4px', display: 'block' }}>
                            {editingAccount.ai_webhook_format === 'evolution_compat'
                              ? 'Use esse formato só se você já tem um bot/agente pronto, construído pra falar com a Evolution API (mensagens e respostas no formato dela). Ideal pra testar um bot existente antes de decidir migrá-lo de verdade pra cá.'
                              : 'Formato recomendado pra qualquer ferramenta nova (n8n, Make, script próprio, etc.) — mais simples e direto.'}
                          </span>
                        </div>
                        <div className="sm-field">
                          <label>1. URL de recebimento (webhook) da sua ferramenta</label>
                          <input
                            type="text"
                            placeholder="https://seu-n8n.exemplo.com/webhook/..."
                            value={editingAccount.ai_webhook_url || ''}
                            onChange={e => setEditingAccount({ ...editingAccount, ai_webhook_url: e.target.value })}
                          />
                          <span style={{ fontSize: '12px', color: '#888', marginTop: '4px', display: 'block' }}>
                            Cole aqui o endereço que sua ferramenta de automação usa pra receber dados de fora
                            (no n8n, é a URL mostrada dentro do node "Webhook"). Toda mensagem recebida nessa conta
                            (em conversas com o bot ativo) é enviada em POST pra esse endereço, junto com a senha
                            do passo 2 no cabeçalho {editingAccount.ai_webhook_format === 'evolution_compat' ? <code>apikey</code> : <code>Authorization</code>}.
                          </span>
                          {editingAccount.ai_webhook_format === 'evolution_compat' ? (
                            <span style={{ fontSize: '12px', color: '#888', marginTop: '6px', display: 'block' }}>
                              <strong>Recomendado:</strong> configure sua ferramenta pra conferir essa senha antes de
                              aceitar a mensagem. No n8n: abra o node "Webhook" → campo <em>Authentication</em> → escolha
                              <em> Header Auth</em> → crie uma credencial com <strong>Header Name</strong>{' '}
                              <code>apikey</code> e <strong>Header Value</strong> igual à senha do passo 2 (sem "Bearer").
                            </span>
                          ) : (
                            <span style={{ fontSize: '12px', color: '#888', marginTop: '6px', display: 'block' }}>
                              <strong>Recomendado:</strong> configure sua ferramenta pra conferir essa senha antes de
                              aceitar a mensagem — sem isso, qualquer um que descobrir essa URL pode mandar mensagens
                              falsas pro bot. No n8n: abra o node "Webhook" → campo <em>Authentication</em> → escolha
                              <em> Header Auth</em> → crie uma credencial com <strong>Header Name</strong>{' '}
                              <code>Authorization</code> e <strong>Header Value</strong>{' '}
                              <code>Bearer &lt;a senha do passo 2&gt;</code>.
                            </span>
                          )}
                        </div>
                        <div className="sm-field">
                          <label>2. Senha compartilhada</label>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <input
                              type="text"
                              placeholder="clique em Gerar"
                              value={editingAccount.ai_webhook_secret || ''}
                              onChange={e => setEditingAccount({ ...editingAccount, ai_webhook_secret: e.target.value })}
                              style={{ flex: 1 }}
                            />
                            <button
                              type="button"
                              className="sm-pill small"
                              onClick={() => setEditingAccount({ ...editingAccount, ai_webhook_secret: crypto.randomUUID() })}
                            >
                              Gerar
                            </button>
                          </div>
                          <span style={{ fontSize: '12px', color: '#888', marginTop: '4px', display: 'block' }}>
                            Um código secreto pra garantir que só a sua ferramenta consiga enviar respostas em nome
                            do bot. Gere aqui e cole esse mesmo valor lá na configuração da sua ferramenta
                            (normalmente num campo de autenticação/token).
                          </span>
                        </div>

                        {editingAccount.ai_webhook_format === 'evolution_compat' ? (
                          <div className="sm-info-box" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <MdWifiTethering size={15} />
                              <strong>3. Como sua ferramenta manda a resposta de volta</strong>
                            </span>
                            <span>
                              Nesse formato, sua ferramenta chama os mesmos endereços que a Evolution API usa —
                              troque só o domínio pelo do wpp-platform. O <code>{'{instance}'}</code> é o nome
                              desta conta (<code>{editingAccount.account_name || '<nome da conta>'}</code>):
                            </span>
                            <div style={{
                              display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,.15)',
                              borderRadius: 6, padding: '6px 10px', fontFamily: 'monospace', fontSize: '11.5px',
                            }}>
                              <span style={{ flex: 1, wordBreak: 'break-all' }}>
                                POST {window.location.origin}/message/sendText/{editingAccount.account_name || '{instance}'}
                              </span>
                              <button
                                type="button"
                                className="sm-pill small"
                                onClick={() => navigator.clipboard.writeText(`${window.location.origin}/message/sendText/${editingAccount.account_name || '{instance}'}`)}
                              >
                                Copiar
                              </button>
                            </div>
                            <pre style={{
                              margin: 0, fontFamily: 'monospace', fontSize: '11.5px', whiteSpace: 'pre-wrap',
                              background: 'rgba(0,0,0,.15)', borderRadius: 6, padding: '8px 10px',
                            }}>
{`apikey: <a senha do passo 2>
Content-Type: application/json

{
  "number": "5511999999999",
  "text": "resposta que o bot decidiu enviar"
}`}
                            </pre>
                            <span>
                              Também existem <code>/message/sendContact/{'{instance}'}</code> e{' '}
                              <code>/message/sendMedia/{'{instance}'}</code>, no mesmo formato da Evolution API.
                              Se um atendente humano assumiu a conversa enquanto isso, esses endereços respondem
                              com erro (a IA não deve mais falar ali).
                            </span>
                          </div>
                        ) : (
                          <div className="sm-info-box" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <MdWifiTethering size={15} />
                              <strong>3. Como sua ferramenta manda a resposta de volta</strong>
                            </span>
                            <span>
                              Depois de decidir a resposta, sua ferramenta precisa chamar este endereço (funciona pra
                              qualquer ferramenta que fale HTTP — não é exclusivo de nenhuma):
                            </span>
                            <div style={{
                              display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,.15)',
                              borderRadius: 6, padding: '6px 10px', fontFamily: 'monospace', fontSize: '11.5px',
                            }}>
                              <span style={{ flex: 1, wordBreak: 'break-all' }}>
                                POST {window.location.origin}/api/bot/reply
                              </span>
                              <button
                                type="button"
                                className="sm-pill small"
                                onClick={() => navigator.clipboard.writeText(`${window.location.origin}/api/bot/reply`)}
                              >
                                Copiar
                              </button>
                            </div>
                            <pre style={{
                              margin: 0, fontFamily: 'monospace', fontSize: '11.5px', whiteSpace: 'pre-wrap',
                              background: 'rgba(0,0,0,.15)', borderRadius: 6, padding: '8px 10px',
                            }}>
{`Authorization: Bearer <a senha do passo 2>
Content-Type: application/json

{
  "conversation_id": 123,
  "text": "resposta que o bot decidiu enviar"
}`}
                            </pre>
                            <span>
                              O <code>conversation_id</code> já vem preenchido na mensagem que sua ferramenta recebeu
                              no passo 1 — é só devolver o mesmo valor. Se um atendente humano assumiu a conversa
                              enquanto isso, esse endereço responde com erro (a IA não deve mais falar ali).
                            </span>
                          </div>
                        )}
                      </>
                    )}

                    <button
                      className="sm-save-btn"
                      onClick={async () => {
                        try {
                          await apiService.updateAccount(editingAccount.id, editingAccount);
                          loadAccounts();
                          setAccountFlow('list');
                          setEditingAccount(null);
                        } catch (err) {
                          alert('Erro ao atualizar a conta.');
                        }
                      }}
                      style={{ marginTop: '10px' }}
                    >
                      <MdSave size={14} /> Salvar Alterações
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ════════ APP META (Embedded Signup) — config global, não por conta ════════ */}
            {tab === 'meta_app' && (
              <div className="sm-pane">
                <h2 className="sm-title">🧩 App Meta (Embedded Signup)</h2>

                <div className="sm-info-box">
                  <MdInfo size={15} />
                  <span>
                    Credenciais do <strong>App</strong> criado em developers.facebook.com — servem para
                    qualquer conta conectar o próprio WhatsApp Business via Embedded Signup. Por isso ficam
                    separadas de <strong>Contas WA</strong> (onde vive o Phone Number ID/Access Token de
                    cada conta individual), mas ainda aqui dentro de Configurações.
                  </span>
                </div>

                {metaAppSt === 'forbidden' ? (
                  <div className="sm-info-box" style={{ borderColor: '#ECB22E', color: '#ECB22E' }}>
                    <MdWarning size={15} /> <span>Apenas administradores podem ver/editar esta configuração.</span>
                  </div>
                ) : metaAppLoading || !metaAppConfig ? (
                  <p className="sm-loading">Carregando...</p>
                ) : (
                  <>
                    <div className="sm-section">
                      <div className="sm-field">
                        <label>FB App ID</label>
                        <input
                          type="text"
                          placeholder="123456789012345"
                          value={metaAppConfig.fb_app_id || ''}
                          onChange={e => setMetaAppConfig({ ...metaAppConfig, fb_app_id: e.target.value })}
                        />
                      </div>
                      <div className="sm-field">
                        <label>FB App Secret</label>
                        <div className="sm-input-wrap">
                          <input
                            type={showSecret.fb_app_secret ? 'text' : 'password'}
                            placeholder="deixe como está para manter o já salvo"
                            value={metaAppConfig.fb_app_secret || ''}
                            onChange={e => setMetaAppConfig({ ...metaAppConfig, fb_app_secret: e.target.value })}
                          />
                          <button className="sm-eye" onClick={() => setShowSecret(p => ({ ...p, fb_app_secret: !p.fb_app_secret }))}>
                            {showSecret.fb_app_secret ? <MdVisibilityOff size={14} /> : <MdVisibility size={14} />}
                          </button>
                        </div>
                      </div>
                      <div className="sm-field">
                        <label>Embedded Signup Config ID</label>
                        <input
                          type="text"
                          placeholder="configuração de login criada no App Dashboard"
                          value={metaAppConfig.embedded_signup_config_id || ''}
                          onChange={e => setMetaAppConfig({ ...metaAppConfig, embedded_signup_config_id: e.target.value })}
                        />
                      </div>
                      <div className="sm-field">
                        <label>Embedded Signup Config ID — Coexistência (opcional)</label>
                        <input
                          type="text"
                          placeholder="deixe em branco pra usar a mesma configuração acima"
                          value={metaAppConfig.coexistence_embedded_signup_config_id || ''}
                          onChange={e => setMetaAppConfig({ ...metaAppConfig, coexistence_embedded_signup_config_id: e.target.value })}
                        />
                        <small style={{ opacity: 0.7 }}>
                          Normalmente NÃO precisa preencher — a Coexistência usa a mesma configuração de login acima,
                          só muda um parâmetro enviado na hora do login (confirmado no App Dashboard da Meta). Só
                          preencha aqui se você criou de propósito uma configuração separada pra esse caso de uso.
                        </small>
                      </div>
                    </div>

                    <h2 className="sm-title" style={{ marginTop: '10px' }}>📈 Meta Pixel / Conversions API</h2>
                    <div className="sm-info-box">
                      <MdInfo size={15} />
                      <span>
                        Manda sinais de conversão (pedido no catálogo, Flow completado, clique em botão de
                        template MARKETING) pro Business Manager, pra otimizar campanhas de anúncio. Crie/encontre
                        o Pixel em <strong>Gerenciador de Eventos</strong> no Business Manager, e gere um token de
                        acesso da Conversions API para ele.
                      </span>
                    </div>
                    <div className="sm-section">
                      <div className="sm-field">
                        <label>Meta Pixel ID</label>
                        <input
                          type="text"
                          placeholder="ID do Pixel no Gerenciador de Eventos"
                          value={metaAppConfig.meta_pixel_id || ''}
                          onChange={e => setMetaAppConfig({ ...metaAppConfig, meta_pixel_id: e.target.value })}
                        />
                      </div>
                      <div className="sm-field">
                        <label>Conversions API Access Token</label>
                        <div className="sm-input-wrap">
                          <input
                            type={showSecret.meta_conversions_api_token ? 'text' : 'password'}
                            placeholder="deixe como está para manter o já salvo"
                            value={metaAppConfig.meta_conversions_api_token || ''}
                            onChange={e => setMetaAppConfig({ ...metaAppConfig, meta_conversions_api_token: e.target.value })}
                          />
                          <button className="sm-eye" onClick={() => setShowSecret(p => ({ ...p, meta_conversions_api_token: !p.meta_conversions_api_token }))}>
                            {showSecret.meta_conversions_api_token ? <MdVisibilityOff size={14} /> : <MdVisibility size={14} />}
                          </button>
                        </div>
                      </div>
                      <div className="sm-field">
                        <label>Facebook Page ID (opcional, mas exigido pela Meta)</label>
                        <input
                          type="text"
                          placeholder="ID da Página que roda anúncios 'clique para WhatsApp'"
                          value={metaAppConfig.meta_page_id || ''}
                          onChange={e => setMetaAppConfig({ ...metaAppConfig, meta_page_id: e.target.value })}
                        />
                        <small style={{ opacity: 0.7 }}>
                          A Meta rejeita todo evento de conversão do WhatsApp sem isso (ou sem um clique de
                          anúncio real). Só existe se vocês rodam anúncios "clique para WhatsApp" a partir de
                          uma Página do Facebook — sem isso, os eventos ficam pausados (não é um erro nosso).
                        </small>
                      </div>
                    </div>

                    {metaAppSt === 'error' && (
                      <div className="sm-info-box" style={{ borderColor: '#F44336', color: '#F44336' }}>
                        <MdError size={15} /> <span>{metaAppErrorMsg}</span>
                      </div>
                    )}
                    {metaAppSt === 'ok' && (
                      <div className="sm-info-box" style={{ borderColor: '#2FAE60', color: '#2FAE60' }}>
                        <MdCheckCircle size={15} /> <span>Configuração salva.</span>
                      </div>
                    )}

                    <div className="sm-btn-row">
                      <button className="sm-save-btn" onClick={saveMetaAppConfig} disabled={metaAppSt === 'saving'}>
                        {metaAppSt === 'saving' ? <><MdRefresh size={14} className="spin" /> Salvando...</> : <><MdSave size={14} /> Salvar</>}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ════════ MINHA CONTA (troca de senha do usuário logado) ════════ */}
            {tab === 'credentials' && (
              <div className="sm-pane">
                <h2 className="sm-title">🔑 Minha Conta</h2>

                <div className="sm-info-box">
                  <MdInfo size={15} />
                  <span>
                    Credenciais de provedor (Meta, bridges) não ficam mais aqui — cada conta do WhatsApp tem as
                    próprias, cadastradas em <strong>Contas WA</strong>. Esta aba é só para os dados do seu
                    login nesta aplicação.
                  </span>
                </div>

                <div className="sm-section">
                  <h3>Usuário logado</h3>
                  <div className="sm-field">
                    <label>Login</label>
                    <input type="text" value={currentUser || ''} disabled style={{ opacity: 0.7 }} />
                  </div>
                </div>

                <div className="sm-section">
                  <h3>Nome de exibição</h3>
                  <p style={{ fontSize: 12.5, opacity: 0.75, marginTop: -4, marginBottom: 10 }}>
                    Como seu nome aparece pro cliente (nas mensagens de WhatsApp) e pra equipe (no chat interno). Em “Não exibir” as mensagens vão sem o prefixo com seu nome; o chat interno continua mostrando seu nome.
                  </p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {[
                      { key: 'first_initial', label: 'Primeiro nome + inicial' },
                      { key: 'initial_last',  label: 'Inicial + sobrenome' },
                      { key: 'none',          label: 'Não exibir' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        className={`sm-pill ${displayNameFormat === key ? 'on' : 'off'}`}
                        onClick={() => saveDisplayNameFormat(key)}
                        disabled={displayNameSt === 'saving'}
                      >
                        {label} — <strong>{previewDisplayName(currentUserFullName, key)}</strong>
                      </button>
                    ))}
                  </div>
                  {displayNameSt === 'ok' && (
                    <div className="sm-info-box" style={{ borderColor: '#2FAE60', color: '#2FAE60', marginTop: 8 }}>
                      <MdCheckCircle size={15} /> <span>Salvo — vale a partir da próxima mensagem/mensagem interna.</span>
                    </div>
                  )}
                  {displayNameSt === 'error' && (
                    <div className="sm-info-box" style={{ borderColor: '#F44336', color: '#F44336', marginTop: 8 }}>
                      <MdError size={15} /> <span>Erro ao salvar — tenta de novo.</span>
                    </div>
                  )}
                </div>

                <div className="sm-section">
                  <h3>Foto de perfil (chat interno)</h3>
                  <p style={{ fontSize: 12.5, opacity: 0.75, marginTop: -4, marginBottom: 10 }}>
                    Aparece pra equipe no chat interno — na lista de conversas, no cabeçalho e nas notificações.
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{
                      width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
                      background: 'var(--bg-secondary, #eee)', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 20, fontWeight: 600,
                    }}>
                      {myPhotoUrl
                        ? <img src={myPhotoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : (currentUserFullName || '?').charAt(0).toUpperCase()}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label className="sm-pill off" style={{ cursor: 'pointer', textAlign: 'center' }}>
                        Enviar foto
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoFileChange} disabled={photoSt === 'saving'} />
                      </label>
                      <button
                        type="button"
                        className="sm-pill off"
                        onClick={() => setShowWhatsAppPhotoForm(v => !v)}
                        disabled={photoSt === 'saving' || accounts.length === 0}
                        title={accounts.length === 0 ? 'Cadastre uma conta WhatsApp em "Contas WA" primeiro' : undefined}
                      >
                        Usar foto do WhatsApp
                      </button>
                    </div>
                  </div>

                  {showWhatsAppPhotoForm && (
                    <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border-color, #ddd)', borderRadius: 8 }}>
                      <p style={{ fontSize: 12, opacity: 0.75, marginTop: 0 }}>
                        Copia (uma vez só, não fica sincronizando) a foto de perfil pública desse número no
                        WhatsApp — geralmente o seu próprio número.
                      </p>
                      <div className="sm-field">
                        <label>Número (com DDD, com ou sem 55)</label>
                        <input
                          type="text"
                          value={waPhotoNumber}
                          onChange={e => setWaPhotoNumber(e.target.value)}
                          placeholder="11991234567"
                        />
                      </div>
                      <div className="sm-field">
                        <label>Buscar através da conta</label>
                        <select value={waPhotoAccountId || ''} onChange={e => setWaPhotoAccountId(Number(e.target.value) || null)}>
                          <option value="">Selecione...</option>
                          {accounts.filter(acc => !acc.fallback_for_account_id).map(acc => (
                            <option key={acc.id} value={acc.id}>{acc.account_name}</option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        className="sm-pill on"
                        onClick={handleUseWhatsAppPhoto}
                        disabled={photoSt === 'saving' || !waPhotoNumber.trim() || !waPhotoAccountId}
                      >
                        {photoSt === 'saving' ? 'Buscando...' : 'Buscar e usar essa foto'}
                      </button>
                    </div>
                  )}

                  {photoSt === 'error' && (
                    <div className="sm-info-box" style={{ borderColor: '#F44336', color: '#F44336', marginTop: 8 }}>
                      <MdError size={15} /> <span>Erro ao salvar a foto — tenta de novo.</span>
                    </div>
                  )}
                </div>

                <div className="sm-section">
                  <h3>Trocar senha</h3>
                  {[
                    { key: 'current_password', label: 'Senha atual' },
                    { key: 'new_password',     label: 'Nova senha (mín. 6 caracteres)' },
                    { key: 'confirm_password', label: 'Confirmar nova senha' },
                  ].map(({ key, label }) => (
                    <div key={key} className="sm-field">
                      <label>{label}</label>
                      <div className="sm-input-wrap">
                        <input
                          type={showSecret[key] ? 'text' : 'password'}
                          value={pwdForm[key]}
                          onChange={e => { setPwdForm(p => ({ ...p, [key]: e.target.value })); setPwdSt(null); }}
                        />
                        <button className="sm-eye" onClick={() => setShowSecret(p => ({ ...p, [key]: !p[key] }))}>
                          {showSecret[key] ? <MdVisibilityOff size={14} /> : <MdVisibility size={14} />}
                        </button>
                      </div>
                    </div>
                  ))}
                  {pwdSt === 'error' && (
                    <div className="sm-info-box" style={{ borderColor: '#F44336', color: '#F44336' }}>
                      <MdError size={15} /> <span>{pwdErrorMsg}</span>
                    </div>
                  )}
                  {pwdSt === 'ok' && (
                    <div className="sm-info-box" style={{ borderColor: '#2FAE60', color: '#2FAE60' }}>
                      <MdCheckCircle size={15} /> <span>Senha alterada com sucesso.</span>
                    </div>
                  )}
                </div>

                <div className="sm-btn-row">
                  <button className="sm-save-btn" onClick={changeMyPassword} disabled={pwdSt === 'saving'}>
                    {pwdSt === 'saving' ? <><MdRefresh size={14} className="spin" /> Salvando...</> : <><MdSave size={14} /> Trocar senha</>}
                  </button>
                </div>
              </div>
            )}

            {/* ════════ ANALYTICS (AnalyticsDashboard existente, embedded) ════════ */}
            {tab === 'analytics' && (
              <div className="sm-pane sm-pane-flush">
                <div className="settings-embedded-component">
                  <AnalyticsDashboard onClose={() => {}} />
                </div>
              </div>
            )}

            {/* ════════ PERFIL DO NEGÓCIO (BusinessProfile existente, embedded) ════════ */}
            {tab === 'business_profile' && (
              <div className="sm-pane sm-pane-flush">
                <div className="settings-embedded-component">
                  <BusinessProfile onClose={() => {}} />
                </div>
              </div>
            )}

            {/* ════════ TEMPLATES (criar/listar/excluir sem sair do app) ════════ */}
            {tab === 'templates' && (
              <div className="sm-pane sm-pane-flush">
                <div className="settings-embedded-component">
                  <TemplateManager />
                </div>
              </div>
            )}

            {/* ════════ CATÁLOGO (produtos do Commerce Manager, sem sair do app) ════════ */}
            {tab === 'catalog' && (
              <div className="sm-pane sm-pane-flush">
                <div className="settings-embedded-component">
                  <CatalogManager />
                </div>
              </div>
            )}

            {/* ════════ FLOWS (chave + criação/publicação, sem editor visual) ════════ */}
            {tab === 'flows' && (
              <div className="sm-pane sm-pane-flush">
                <div className="settings-embedded-component">
                  <FlowManager />
                </div>
              </div>
            )}

            {/* ════════ QUALIDADE DO NÚMERO ════════ */}
            {tab === 'phone_quality' && (
              <div className="sm-pane">
                <h2 className="sm-title">📶 Qualidade do Número</h2>
                <PhoneNumberInfo />
              </div>
            )}

            {/* ════════ USUÁRIOS ════════ */}
            {/* Matriz de permissões por papel foi migrada para o Painel Admin
                (aba "Papéis") — lá o enforcement é real (backend/api/permissions.py),
                aqui era só uma UI cosmética que não bloqueava nada de verdade. */}
            {tab === 'users' && (
              <div className="sm-pane">
                <h2 className="sm-title">👤 Usuários</h2>

                <div className="sm-section">
                  <h3>Usuários cadastrados</h3>
                  {usersLoad ? <p className="sm-loading">Carregando...</p> : (
                    <div className="sm-user-list">
                      {users.map(u => (
                        <div key={u.id || u.username} className="sm-user-row">
                          <div className="sm-user-av">{u.username[0].toUpperCase()}</div>
                          <div className="sm-user-det">
                            <strong>{u.username}</strong>
                            <span>
                              {roles.find(r => r.id === u.role)?.label || u.role}
                              {u.sector ? ` · ${u.sector}` : ''}
                            </span>
                          </div>
                          {u.username !== 'admin' && (
                            <button className="sm-del-btn" onClick={() => removeUser(u.username)}>
                              <MdDelete size={15} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="sm-section">
                  <h3>Adicionar Usuário</h3>
                  <div className="sm-field"><label>Usuário *</label>
                    <input type="text" placeholder="ex: atendente2" value={newUser.username}
                      onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))} />
                  </div>
                  <div className="sm-field"><label>Senha *</label>
                    <div className="sm-input-wrap">
                      <input type={showPwd ? 'text' : 'password'} placeholder="Senha segura" value={newUser.password}
                        onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))} />
                      <button className="sm-eye" onClick={() => setShowPwd(p => !p)}>
                        {showPwd ? <MdVisibilityOff size={14} /> : <MdVisibility size={14} />}
                      </button>
                    </div>
                  </div>
                  <div className="sm-field"><label>Função</label>
                    <select className="sm-select" value={newUser.role}
                      onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}>
                      {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  </div>
                  <div className="sm-field"><label>Setor / Departamento</label>
                    <input type="text" placeholder="ex: Vendas, Suporte, Financeiro" value={newUser.sector}
                      onChange={e => setNewUser(p => ({ ...p, sector: e.target.value }))} />
                  </div>
                  <button className="sm-save-btn" onClick={addUser} disabled={!newUser.username || !newUser.password}>
                    <MdAdd size={14} /> Adicionar Usuário
                  </button>
                </div>
              </div>
            )}

            {/* ════════ ATENDIMENTO (Etiquetas + Respostas Rápidas) ════════ */}
            {tab === 'atendimento' && (
              <div className="sm-pane">
                <h2 className="sm-title">🏷️ Atendimento</h2>

                <div className="sm-section">
                  <h3><MdLabel size={16} style={{ verticalAlign: -2 }} /> Cores do status</h3>
                  <small>Cor da bolinha na lista de conversas e do seletor de status no chat</small>

                  <div style={{ display: 'flex', gap: 16, margin: '14px 0', flexWrap: 'wrap' }}>
                    {[
                      ['open', 'Aberta'],
                      ['pending', 'Pendente'],
                      ['resolved', 'Resolvida'],
                    ].map(([key, label]) => (
                      <div key={key} className="sm-field" style={{ alignItems: 'center' }}>
                        <label>{label}</label>
                        <input
                          type="color"
                          value={draftStatusColors[key] || '#8696A0'}
                          onChange={e => setDraftStatusColors(p => ({ ...p, [key]: e.target.value }))}
                          style={{ width: 44, height: 34, padding: 2 }}
                        />
                      </div>
                    ))}
                  </div>
                  <button className="sm-save-btn" onClick={handleSaveStatusColors} disabled={savingStatusColors}>
                    <MdSave size={14} /> {savingStatusColors ? 'Salvando...' : 'Salvar cores'}
                  </button>
                </div>

                <div className="sm-section">
                  <h3><MdLabel size={16} style={{ verticalAlign: -2 }} /> Etiquetas</h3>
                  <small>Classificam conversas (ex: "Reclamação", "Orçamento") — aplicadas no cabeçalho do chat. Clique numa etiqueta pra editar.</small>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '14px 0' }}>
                    {tagListLoad ? <small>Carregando...</small> : tagList.length === 0 ? (
                      <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhuma etiqueta visível pra você ainda.</small>
                    ) : tagList.map(t => (
                      <span
                        key={t.id}
                        onClick={() => t.can_manage && handleEditTagList(t)}
                        title={
                          t.scope === 'sector' ? `Setorial — ${t.sector}`
                          : t.scope === 'personal' ? (t.created_by === currentUserId ? `Pessoal — sua, ${t.shared_with?.length ? `compartilhada com ${t.shared_with.length}` : 'só você'}` : `Pessoal — de ${t.created_by_name}, compartilhada com você`)
                          : 'Global'
                        }
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
                          padding: '4px 6px 4px 10px', borderRadius: 12, color: getContrastTextColor(t.color), background: t.color,
                          cursor: t.can_manage ? 'pointer' : 'default', opacity: editingTagId === t.id ? 0.6 : 1,
                          border: editingTagId === t.id ? '2px solid #fff' : '2px solid transparent', outline: editingTagId === t.id ? '1px solid ' + t.color : 'none',
                        }}
                      >
                        {t.scope === 'sector' && <MdWorkOutline size={12} />}
                        {t.scope === 'personal' && <MdLock size={12} />}
                        {t.name}
                        {t.task_title && <MdListAlt size={12} title={`Cria a tarefa "${t.task_title}"`} />}
                        {t.can_manage && (
                          <MdDelete size={14} style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); handleDeleteTagList(t.id); }} />
                        )}
                      </span>
                    ))}
                  </div>

                  <div className="sm-field">
                    <label>Nome</label>
                    <input type="text" value={tagForm.name} placeholder="Nome"
                      onChange={e => setTagForm(p => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div className="sm-row" style={{ gap: 10, alignItems: 'flex-end' }}>
                    <div className="sm-field">
                      <label>Cor</label>
                      <input type="color" value={tagForm.color} onChange={e => setTagForm(p => ({ ...p, color: e.target.value }))}
                        style={{ width: 44, height: 34, padding: 2 }} />
                    </div>
                    <div className="sm-field" style={{ flex: 1 }}>
                      <label>Classificação</label>
                      <select value={tagForm.scope} onChange={e => setTagForm(p => ({ ...p, scope: e.target.value }))}>
                        <option value="global">Global — todo mundo vê e aplica</option>
                        <option value="sector">Setorial — só o setor escolhido</option>
                        <option value="personal">Pessoal — só você (compartilhável)</option>
                      </select>
                    </div>
                  </div>
                  {tagForm.scope === 'sector' && (
                    <div className="sm-field">
                      <label>Setor</label>
                      <select value={tagForm.sector} onChange={e => setTagForm(p => ({ ...p, sector: e.target.value }))}>
                        <option value="">Selecione...</option>
                        {[...new Set(qrAgents.map(a => a.sector).filter(Boolean))].sort().map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {tagForm.scope === 'personal' && (
                    <div className="sm-field">
                      <label>Compartilhar com colegas (opcional — ninguém marcado = só você)</label>
                      {qrAgents.filter(a => a.id !== currentUserId).length === 0 ? (
                        <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhum outro colega ativo pra compartilhar.</small>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 120, overflowY: 'auto' }}>
                          {qrAgents.filter(a => a.id !== currentUserId).map(a => {
                            const checked = (tagForm.sharedWith || []).includes(a.id);
                            return (
                              <label key={a.id} style={{
                                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13,
                                padding: '4px 8px', borderRadius: 6,
                                background: checked ? 'var(--whatsapp-green, #25D366)' : 'var(--bg-tertiary, #f0f0f0)',
                                color: checked ? '#fff' : 'var(--text-primary, #333)',
                              }}>
                                <input type="checkbox" checked={checked} onChange={() => toggleTagSharedWith(a.id)} style={{ margin: 0 }} />
                                {a.full_name || a.email}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="sm-field">
                    <label>Tarefa vinculada (opcional — aplicar a etiqueta numa conversa de cliente já cria essa tarefa junto)</label>
                    <input type="text" value={tagForm.taskTitle} placeholder="Título da tarefa (deixe vazio pra não vincular nenhuma)"
                      onChange={e => setTagForm(p => ({ ...p, taskTitle: e.target.value }))} />
                  </div>
                  {tagForm.taskTitle.trim() && (<>
                    <div className="sm-row" style={{ gap: 10 }}>
                      <div className="sm-field" style={{ flex: 1 }}>
                        <label>Descrição da tarefa (opcional)</label>
                        <input type="text" value={tagForm.taskDescription}
                          onChange={e => setTagForm(p => ({ ...p, taskDescription: e.target.value }))} />
                      </div>
                      <div className="sm-field">
                        <label>Urgência da tarefa</label>
                        <select value={tagForm.taskPriority} onChange={e => setTagForm(p => ({ ...p, taskPriority: e.target.value }))}>
                          <option value="low">Baixa</option>
                          <option value="medium">Média</option>
                          <option value="high">Alta</option>
                          <option value="urgent">Urgente</option>
                        </select>
                      </div>
                    </div>
                    <div className="sm-row" style={{ gap: 10 }}>
                      <div className="sm-field">
                        <label>Prazo (opcional — dias a partir de quando a etiqueta for aplicada)</label>
                        <input type="number" min={1} value={tagForm.taskDueDays} placeholder="Sem prazo"
                          onChange={e => setTagForm(p => ({ ...p, taskDueDays: e.target.value }))} style={{ width: 100 }} />
                      </div>
                      <div className="sm-field" style={{ flex: 1 }}>
                        <label>Responsável (opcional — vazio = quem aplicar a etiqueta)</label>
                        <select value={tagForm.taskAssignedTo} onChange={e => setTagForm(p => ({ ...p, taskAssignedTo: e.target.value }))}>
                          <option value="">Quem aplicar a etiqueta</option>
                          {qrAgents.map(a => (
                            <option key={a.id} value={a.id}>{a.full_name || a.email}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>)}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="sm-save-btn" onClick={handleSaveTag} disabled={savingTag}>
                      {editingTagId ? <><MdSave size={14} /> {savingTag ? 'Salvando...' : 'Salvar edição'}</> : <><MdAdd size={14} /> {savingTag ? 'Criando...' : 'Criar'}</>}
                    </button>
                    {editingTagId && (
                      <button className="sm-save-btn" style={{ background: 'transparent', color: 'inherit' }}
                        onClick={() => { setEditingTagId(null); setTagForm(EMPTY_TAG); }}>
                        Cancelar
                      </button>
                    )}
                  </div>
                </div>

                <div className="sm-section">
                  <h3><MdChat size={16} style={{ verticalAlign: -2 }} /> Respostas Rápidas</h3>
                  <small>Atalho digitado no início da mensagem (ex: "/oi") sugere o texto e/ou a mídia pronta pra inserir — por padrão é só sua; compartilhe com colegas específicos se quiser</small>

                  <div style={{ margin: '14px 0' }}>
                    {quickReplyListLoad ? <small>Carregando...</small> : quickReplyList.length === 0 ? (
                      <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhuma resposta rápida criada ainda.</small>
                    ) : quickReplyList.map(qr => (
                      <div key={qr.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
                        borderBottom: '1px solid var(--border-color, #eee)',
                      }}>
                        <span style={{ fontWeight: 700, color: 'var(--whatsapp-green, #25D366)', minWidth: 70 }}>/{qr.shortcut}</span>
                        <span
                          title={
                            !qr.is_mine ? `Compartilhada por ${qr.created_by_name || 'colega'}`
                              : qr.shared_with?.length ? `Compartilhada com ${qr.shared_with.length} colega(s)`
                              : 'Pessoal — só você vê'
                          }
                          style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10, flexShrink: 0,
                            background: (qr.is_mine ? qr.shared_with?.length > 0 : true) ? 'var(--whatsapp-green, #25D366)' : 'var(--bg-tertiary, #e0e0e0)',
                            color: (qr.is_mine ? qr.shared_with?.length > 0 : true) ? '#fff' : 'var(--text-secondary, #888)',
                          }}
                        >
                          {!qr.is_mine ? `DE ${(qr.created_by_name || '?').split(' ')[0].toUpperCase()}` : qr.shared_with?.length ? `COMPARTILHADA (${qr.shared_with.length})` : 'PESSOAL'}
                        </span>
                        {qr.media_url && <MdAttachFile size={15} title={`Mídia: ${qr.media_filename || qr.media_type}`} style={{ color: 'var(--text-secondary, #888)', flexShrink: 0 }} />}
                        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {qr.text || (qr.media_url ? `[${qr.media_type}] ${qr.media_filename || ''}` : '')}
                        </span>
                        {/* Só o dono edita/apaga — quem recebeu por compartilhamento só usa. */}
                        {qr.is_mine && <MdEdit size={16} style={{ cursor: 'pointer' }} onClick={() => handleEditQuickReply(qr)} />}
                        {qr.is_mine && <MdDelete size={16} style={{ cursor: 'pointer' }} onClick={() => handleDeleteQuickReply(qr.id)} />}
                      </div>
                    ))}
                  </div>

                  <div className="sm-field">
                    <label>Atalho</label>
                    <input type="text" value={newQr.shortcut} placeholder="oi"
                      onChange={e => setNewQr(p => ({ ...p, shortcut: e.target.value }))} />
                  </div>
                  <div className="sm-field">
                    <label>Texto (legenda da mídia, se houver)</label>
                    <textarea rows={2} value={newQr.text}
                      onChange={e => setNewQr(p => ({ ...p, text: e.target.value }))} />
                  </div>
                  <div className="sm-field">
                    <label>Mídia pronta (opcional — imagem, vídeo, áudio ou documento)</label>
                    {newQr.media_url ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                        <MdAttachFile size={16} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {newQr.media_filename} ({newQr.media_type})
                        </span>
                        <MdClose size={16} style={{ cursor: 'pointer' }} title="Remover mídia" onClick={handleRemoveQrMedia} />
                      </div>
                    ) : (
                      <label className="sm-save-btn" style={{ cursor: 'pointer', display: 'inline-flex', width: 'fit-content' }}>
                        {uploadingQrMedia ? 'Enviando...' : <><MdAttachFile size={14} /> Anexar arquivo</>}
                        <input type="file" style={{ display: 'none' }} disabled={uploadingQrMedia} onChange={handleQrMediaSelect} />
                      </label>
                    )}
                  </div>
                  <div className="sm-field">
                    <label>Compartilhar com colegas (opcional — ninguém marcado = só você)</label>
                    {qrAgents.filter(a => a.id !== currentUserId).length === 0 ? (
                      <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhum outro colega ativo pra compartilhar.</small>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 120, overflowY: 'auto' }}>
                        {qrAgents.filter(a => a.id !== currentUserId).map(a => {
                          const checked = (newQr.shared_with || []).includes(a.id);
                          return (
                            <label key={a.id} style={{
                              display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13,
                              padding: '4px 8px', borderRadius: 6,
                              background: checked ? 'var(--whatsapp-green, #25D366)' : 'var(--bg-tertiary, #f0f0f0)',
                              color: checked ? '#fff' : 'var(--text-primary, #333)',
                            }}>
                              <input type="checkbox" checked={checked} onChange={() => toggleQrSharedWith(a.id)} style={{ margin: 0 }} />
                              {a.full_name || a.email}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="sm-save-btn" onClick={handleSaveQuickReply}>
                      {editingQrId ? <><MdSave size={14} /> Salvar edição</> : <><MdAdd size={14} /> Criar</>}
                    </button>
                    {editingQrId && (
                      <button className="sm-save-btn" style={{ background: 'transparent', color: 'inherit' }}
                        onClick={() => { setEditingQrId(null); setNewQr(EMPTY_QR); }}>
                        Cancelar
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ════════ CONTATOS INTERNOS ════════ */}
            {tab === 'internal_contacts' && (
              <div className="sm-pane">
                <h2 className="sm-title">💼 Contatos internos</h2>
                <div className="sm-section">
                  <small>
                    Números/grupos marcados aqui nunca recebem resposta do bot/IA, aviso de
                    fora-do-horário nem pesquisa de CSAT, e não contam pro SLA de atendimento —
                    uso pra colegas, fornecedores ou grupos internos falando pelo número da
                    empresa. Um lugar só pra ver/gerenciar todos, sem precisar abrir conversa por
                    conversa (grupos também podem ser marcados, direto no painel de info do
                    grupo).
                  </small>

                  <div className="sm-row" style={{ gap: 10, alignItems: 'flex-end', margin: '14px 0' }}>
                    <div className="sm-field" style={{ flex: 1 }}>
                      <label>Adicionar por número</label>
                      <input
                        type="text"
                        value={newInternalPhone}
                        placeholder="Ex: 5511999998888"
                        onChange={e => setNewInternalPhone(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleAddInternalContact()}
                      />
                    </div>
                    <button className="sm-save-btn" onClick={handleAddInternalContact} disabled={addingInternal || !newInternalPhone.trim()}>
                      <MdAdd size={14} /> {addingInternal ? 'Adicionando...' : 'Adicionar'}
                    </button>
                  </div>
                  <small style={{ color: 'var(--text-secondary, #888)' }}>
                    Pode adicionar um número que ainda nunca escreveu — fica marcado desde já,
                    então o bot nunca chega a responder nem a primeira mensagem dele.
                  </small>

                  <div style={{ margin: '16px 0' }}>
                    {internalContactsLoad ? <small>Carregando...</small> : internalContacts.length === 0 ? (
                      <small style={{ color: 'var(--text-secondary, #888)' }}>Nenhum contato marcado como interno ainda.</small>
                    ) : internalContacts.map(c => (
                      <div key={c.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
                        borderBottom: '1px solid var(--border-color, #eee)',
                      }}>
                        {c.is_group && (
                          <span title="Grupo" style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10,
                            background: 'var(--bg-tertiary, #e0e0e0)', color: 'var(--text-secondary, #888)', flexShrink: 0,
                          }}>GRUPO</span>
                        )}
                        <span style={{ flex: 1, fontSize: 13 }}>
                          {c.name || c.group_subject || c.phone_number}
                          {c.name || c.group_subject ? (
                            <span style={{ color: 'var(--text-secondary, #888)' }}> · {c.phone_number}</span>
                          ) : null}
                        </span>
                        <MdDelete size={16} style={{ cursor: 'pointer' }} title="Desmarcar" onClick={() => handleRemoveInternalContact(c.id)} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ════════ AUTOMAÇÕES ════════ */}
            {tab === 'automations' && (
              <div className="sm-pane">
                <h2 className="sm-title">🤖 Automações</h2>

                <div className="sm-section">
                  <div className="sm-section-hr">
                    <div>
                      <h3>Auto-resposta</h3>
                      <small>Responde automaticamente ao receber uma mensagem</small>
                    </div>
                    <button className={`sm-pill ${autoReply.enabled ? 'on' : 'off'}`}
                      onClick={() => setAutoReply(p => ({ ...p, enabled: !p.enabled }))}>
                      <MdBolt size={12} /> {autoReply.enabled ? 'Ativo' : 'Inativo'}
                    </button>
                  </div>
                  {autoReply.enabled && (
                    <>
                      <div className="sm-field" style={{ marginTop: 14 }}>
                        <label>Mensagem</label>
                        <textarea rows={3} maxLength={1024} value={autoReply.message}
                          onChange={e => setAutoReply(p => ({ ...p, message: e.target.value }))} />
                        <small>{autoReply.message.length}/1024</small>
                      </div>
                      <div className="sm-field">
                        <label>Atraso antes de responder (segundos)</label>
                        <input type="number" min={0} max={60} value={autoReply.delay_seconds}
                          onChange={e => setAutoReply(p => ({ ...p, delay_seconds: +e.target.value }))} />
                      </div>
                    </>
                  )}
                </div>

                <div className="sm-section">
                  <div className="sm-section-hr">
                    <div>
                      <h3>Fora do Horário</h3>
                      <small>Enviada quando o contato escreve fora do horário comercial</small>
                    </div>
                    <button className={`sm-pill ${offHours.enabled ? 'on' : 'off'}`}
                      onClick={() => setOffHours(p => ({ ...p, enabled: !p.enabled }))}>
                      <MdSchedule size={12} /> {offHours.enabled ? 'Ativo' : 'Inativo'}
                    </button>
                  </div>
                  {offHours.enabled && (
                    <>
                      <div className="sm-field" style={{ marginTop: 14 }}>
                        <label>Mensagem</label>
                        <textarea rows={3} maxLength={1024} value={offHours.message}
                          onChange={e => setOffHours(p => ({ ...p, message: e.target.value }))} />
                      </div>
                      <div className="sm-row" style={{ gap: 16 }}>
                        <div className="sm-field" style={{ flex: 1 }}>
                          <label>Início do horário</label>
                          <input type="time" value={offHours.start}
                            onChange={e => setOffHours(p => ({ ...p, start: e.target.value }))} />
                        </div>
                        <div className="sm-field" style={{ flex: 1 }}>
                          <label>Fim do horário</label>
                          <input type="time" value={offHours.end}
                            onChange={e => setOffHours(p => ({ ...p, end: e.target.value }))} />
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="sm-section">
                  <div className="sm-section-hr">
                    <div>
                      <h3>Pesquisa de Satisfação (CSAT)</h3>
                      <small>Enviada ao cliente quando a conversa é marcada como Resolvida; a resposta (1 a 5) fica salva no histórico de atendimento</small>
                    </div>
                    <button className={`sm-pill ${csat.enabled ? 'on' : 'off'}`}
                      onClick={() => setCsat(p => ({ ...p, enabled: !p.enabled }))}>
                      <MdBolt size={12} /> {csat.enabled ? 'Ativo' : 'Inativo'}
                    </button>
                  </div>
                  {csat.enabled && (
                    <div className="sm-field" style={{ marginTop: 14 }}>
                      <label>Mensagem</label>
                      <textarea rows={3} maxLength={1024} value={csat.message}
                        onChange={e => setCsat(p => ({ ...p, message: e.target.value }))} />
                      <small>O cliente responde só com um número de 1 a 5 — não existe emoji/estrela pré-pronta, é o número puro na mensagem.</small>
                      <label style={{ marginTop: 12, display: 'block' }}>Encerrar automaticamente após (horas)</label>
                      <input type="number" min={0} max={720} style={{ maxWidth: 160 }}
                        value={csat.timeout_hours ?? 24}
                        onChange={e => setCsat(p => ({ ...p, timeout_hours: Math.max(0, +e.target.value || 0) }))} />
                      <small>Se o cliente não responder nesse prazo, a pesquisa se encerra sozinha (sem gravar nota). 0 = nunca expira.</small>
                    </div>
                  )}
                </div>

                <div className="sm-section">
                  <h3>⏱️ SLA de Atendimento</h3>
                  <small>A partir de quantos minutos uma conversa esperando (sem ser atribuída) ou em atendimento (atribuída, ainda não resolvida) fica marcada em vermelho na lista de conversas</small>
                  <div className="sm-field" style={{ marginTop: 14, maxWidth: 160 }}>
                    <label>Minutos</label>
                    <input type="number" min={1} max={1440} value={sla.wait_minutes}
                      onChange={e => setSla(p => ({ ...p, wait_minutes: Math.max(1, +e.target.value || 1) }))} />
                  </div>
                </div>

                <div className="sm-section sm-future">
                  <h3>🔮 Em Breve</h3>
                  <div className="sm-future-tags">
                    {['🤖 Chatbot & IA (em desenvolvimento)', '🔄 Fluxos de automação', '🏷️ Auto-etiquetagem por regra',
                      '🔗 Integração N8N / Zapier'].map(t => <span key={t}>{t}</span>)}
                  </div>
                </div>

                <button className="sm-save-btn" onClick={saveAutomations} disabled={saving}>
                  {saving ? <><MdRefresh size={14} className="spin" /> Salvando...</> : <><MdSave size={14} /> Salvar Automações</>}
                </button>
              </div>
            )}

          </div>{/* /sm-content */}
        </div>{/* /sm-body */}
      </div>{/* /sm-modal */}
    </div>
  );
};

export default SettingsModal;
