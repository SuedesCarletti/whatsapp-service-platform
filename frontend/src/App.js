/**
 * App.js - Componente Principal REFATORADO
 * 
 * VERSÃO COM MENUS REORGANIZADOS
 * - ChatAreaMenu: Ações específicas da conversa
 * - ConversationListMenu: Funções globais
 * - AttachmentMenu: Tipos de mensagens
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import './styles/App.css';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import apiService, { baileysApi } from './services/api';
import { requestNotificationPermission, notifyNewMessage, subscribeToPush } from './utils/desktopNotify';
import wsService from './services/websocket';
import moment from 'moment';

// Componentes de Login e Modais
import LoginScreen from './components/LoginScreen';
import QRCodeManager from './components/QRCodeManager';
import CartBuilder from './components/CartBuilder';
import FlowSender from './components/FlowSender';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import ReportsPanel from './components/ReportsPanel';
import InternalChatArea from './components/InternalChatArea';
import NewInternalChatModal from './components/NewInternalChatModal';
import NewChatModal from './components/NewChatModal';
import InternalGroupManager from './components/InternalGroupManager';
import InternalContactInfoPanel from './components/InternalContactInfoPanel';
import TaskDetailModal from './components/TaskDetailModal';
import PauseTaskModal from './components/PauseTaskModal';
import CancelTaskModal from './components/CancelTaskModal';
import TaskReminderModal from './components/TaskReminderModal';
import TaskModal from './components/TaskModal';
import BusinessProfile from './components/BusinessProfile';
import TemplateSender from './components/TemplateSender';
import LocationSender from './components/LocationSender';
import ContactSender from './components/ContactSender';
import ListSender from './components/ListSender';
import ProductSender from './components/ProductSender';
import ProductListSender from './components/ProductListSender';
import SettingsModal from './components/SettingsModal';
import BaileysProfilePanel from './components/BaileysProfilePanel';
import PollSender from './components/PollSender';
import MediaGallery from './components/MediaGallery';
import MyTasksPanel from './components/MyTasksPanel';
import GroupCreator from './components/GroupCreator';
import BroadcastManagerModal from './components/BroadcastManagerModal';
import GroupManager from './components/GroupManager';
import ParticipantInfoModal from './components/ParticipantInfoModal';
import ContactInfoPanel from './components/ContactInfoPanel';
import IconRail from './components/IconRail';
import StatusViewer from './components/StatusViewer';
import AdminPanel from './components/AdminPanel/AdminPanel';
import NotificationToast from './components/NotificationToast';
import './styles/qr-background-fix.css';
import './styles/modal-contrast-fix.css';

// HELPER FUNCTIONS

const getFileType = (file) => { 
  if (!file) return 'text';
  const type = file.type.split('/')[0];
  if (type === 'image') {
    if (file.type === 'image/webp' || file.name.endsWith('.webp')) {
      return 'sticker';
    }
    return 'image';
  }
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  return 'document';
};

// Providers cujo bridge implementa a "API avançada" (encaminhar, editar,
// apagar, fixar, favoritar mensagem; mutar/arquivar/apagar conversa;
// bloquear contato; criar grupo) — mesmo conjunto que o backend já expõe
// via _FULL_API_PROVIDERS (routes_baileys.py). Até pouco tempo essas ações
// ficavam travadas só pra 'baileys' no front, mesmo o backend já suportando
// wppconnect/whatsapp_web_js — os métodos existiam e funcionavam, só o
// bloqueio no front nunca tinha sido revisado.
const ADVANCED_API_PROVIDERS = new Set(['baileys', 'wppconnect', 'whatsapp_web_js']);

const getInitialTheme = () => {
  const savedTheme = localStorage.getItem('whatsapp-theme');
  if (savedTheme) return savedTheme;
  
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  
  return 'light';
};

// COMPONENTE PRINCIPAL

function App() {
  // ESTADOS
  
  // Autenticação — inicializa direto do localStorage (evita re-login no F5)
  const _savedToken = localStorage.getItem('token');
  const _savedUser  = localStorage.getItem('currentUser');
  const _savedProfile = (() => {
    try { return JSON.parse(localStorage.getItem('currentUserProfile') || 'null'); }
    catch { return null; }
  })();
  const [isLoggedIn,   setIsLoggedIn]   = useState(!!_savedToken);
  const [authToken,    setAuthToken]    = useState(_savedToken || null);
  const [currentUser,  setCurrentUser]  = useState(_savedUser  || null);
  // Perfil completo do usuário logado ({id, email, full_name, is_admin, role, sector}) —
  // currentUser continua sendo só o nome de exibição (usado em outros lugares); isto é
  // o dado real usado para decisões de permissão/UI condicional por papel.
  const [currentUserProfile, setCurrentUserProfile] = useState(_savedProfile);
  
  // Conversas e Mensagens
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  // Paginação de histórico (scroll pro topo do chat): hasMoreMessages parte
  // de um palpite no 1º carregamento (voltou a página cheia = talvez tenha
  // mais) e é corrigido de verdade pela resposta do 1º "carregar mais".
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);

  // Guarda contra clique duplo/repetido em botões de ação que disparam efeito
  // colateral não-idempotente no servidor (marcar resolvida reenvia CSAT pro
  // cliente de verdade, por exemplo). Bug real confirmado: sem isso, um botão
  // sem feedback visual de "processando" levava o usuário a clicar várias
  // vezes em sequência (principalmente com o servidor lento), e cada clique
  // virava uma requisição extra — 6 pesquisas de CSAT idênticas mandadas pro
  // mesmo cliente em ~10s. pendingActionsRef é a fonte da verdade (checagem
  // síncrona, sem esperar o re-render de um setState); pendingVersion só
  // força os componentes que leem isActionPending() a re-renderizar.
  const pendingActionsRef = useRef(new Set());
  const [, setPendingVersion] = useState(0);

  const isActionPending = useCallback((key) => pendingActionsRef.current.has(key), []);

  // Toast não-bloqueante (substitui os antigos alert() de erro de envio —
  // um alert() trava a UI inteira até o usuário clicar OK, o que junto com
  // servidor lento reforçava a sensação de travamento).
  const [toast, setToast] = useState(null);
  const showToast = useCallback((type, message, duration) => setToast({ type, message, key: Date.now(), duration }), []);

  // Lembrete de tarefa pausada — fila em vez de um único slot: se dois
  // lembretes vencerem próximos um do outro (ex: watchdog de 60s pegando
  // dois no mesmo ciclo), o segundo não pode simplesmente sobrescrever o
  // primeiro antes da pessoa ver. Mostra um modal por vez, sempre o mais
  // antigo primeiro (fila FIFO), avança pro próximo só ao fechar o atual.
  const [taskReminderQueue, setTaskReminderQueue] = useState([]);

  // Executa actionFn (deve retornar uma Promise) só se `key` não estiver já
  // em andamento; ignora silenciosamente cliques repetidos enquanto pendente.
  const runGuardedAction = useCallback((key, actionFn) => {
    if (pendingActionsRef.current.has(key)) return;
    pendingActionsRef.current.add(key);
    setPendingVersion(v => v + 1);
    const finish = () => {
      pendingActionsRef.current.delete(key);
      setPendingVersion(v => v + 1);
    };
    Promise.resolve().then(actionFn).then(finish, finish);
  }, []);
  // Atendimento — agentes ativos (atribuição), catálogo de etiquetas e de respostas rápidas
  const [agents, setAgents] = useState([]);
  const [tagCatalog, setTagCatalog] = useState([]);
  const [quickReplies, setQuickReplies] = useState([]);
  const [statusColors, setStatusColors] = useState({ open: '#2FAE60', pending: '#ECB22E', resolved: '#8696A0' });
  const [slaWaitMinutes, setSlaWaitMinutes] = useState(10);
  const [csatEnabled, setCsatEnabled] = useState(false);

  // Chat interno (Equipe) — comunicação entre usuários, sem ligação com conversa de cliente
  const [sidebarView, setSidebarView] = useState('clients'); // 'clients' | 'team'
  const [internalChats, setInternalChats] = useState([]);
  const [selectedInternalChat, setSelectedInternalChat] = useState(null);
  const [internalMessages, setInternalMessages] = useState([]);
  // MediaGallery.js espera mediaUrl/type/timestamp (mesmo formato das
  // mensagens de WhatsApp) — mensagem interna usa media_url/message_type/
  // created_at, por isso o mapeamento aqui em vez de mudar o componente.
  const internalMediaMessages = useMemo(() => internalMessages
    .filter(m => m.media_url)
    .map(m => ({
      wamid: m.id,
      mediaUrl: m.media_url,
      type: m.message_type,
      timestamp: new Date(m.created_at).getTime(),
      filename: m.filename,
    })), [internalMessages]);
  const [internalTasks, setInternalTasks] = useState([]); // tarefas da conversa interna selecionada (chat/grupo da equipe)
  // Painel global "Minhas tarefas" (ícone de Tarefas no IconRail) — todas as
  // tarefas abertas atribuídas a mim/criadas por mim, de qualquer conversa.
  // is_unread de cada item já vem calculado do backend (last_tasks_viewed_at
  // por conversa) — mesma fonte usada pro badge da faixa em InternalChatArea
  // e pro ícone fixo de pendência na Sidebar (via internalChats[].open_tasks_count).
  const [myTasks, setMyTasks] = useState([]);
  const [showMyTasksPanel, setShowMyTasksPanel] = useState(false);
  const refreshMyTasks = useCallback(() => { apiService.getMyTasks().then(setMyTasks); }, []);
  // Criar tarefa a partir do painel global, sem estar em conversa nenhuma —
  // pedido explícito 2026-09-23: tarefa "pra mim mesmo" não deveria forçar
  // nenhum chat (antes usava a DM "Você mesmo" como container obrigatório,
  // poluindo uma conversa pensada só pra anotações com avisos de sistema
  // toda hora). TaskModal abre em modo `standalone`, sem picker de conversa.
  const [showGlobalTaskModal, setShowGlobalTaskModal] = useState(false);
  // Tarefas vinculadas à conversa de CLIENTE aberta agora (faixa "Tarefas
  // da conversa" no ChatArea, mesmo componente visual do chat interno) —
  // controle exclusivo de quem cria, nunca vira nada visível pro cliente.
  const [customerConversationTasks, setCustomerConversationTasks] = useState([]);
  const [showNewInternalChatModal, setShowNewInternalChatModal] = useState(false);
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [internalPresence, setInternalPresence] = useState({}); // { [user_id]: {status, last_seen_at} }
  const [internalTyping, setInternalTyping] = useState(null); // {conversation_id, user_id, user_name} | null
  const internalTypingTimeoutRef = useRef(null);
  const [showInternalGroupManager, setShowInternalGroupManager] = useState(false);
  const [showInternalContactInfo, setShowInternalContactInfo] = useState(false);

  // Tema
  const [theme, setTheme] = useState(getInitialTheme);
  
  // Modais - Funcionalidades Globais (ConversationListMenu)
  const [showQRManager, setShowQRManager] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showBusinessProfile, setShowBusinessProfile] = useState(false);
  const [showTemplateSender, setShowTemplateSender] = useState(false);
  
  // Modais - Funcionalidades de Mensagem (AttachmentMenu)
  const [showCartBuilder, setShowCartBuilder] = useState(false);
  const [showFlowSender, setShowFlowSender] = useState(false);
  const [showLocationSender, setShowLocationSender] = useState(false);
  const [showContactSender, setShowContactSender] = useState(false);
  const [showListSender, setShowListSender] = useState(false);
  const [showProductSender, setShowProductSender] = useState(false);
  const [showProductListSender, setShowProductListSender] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // "Buscar no chat" acionado a partir do painel de Dados do Contato (fora
  // do ChatArea/InternalChatArea) — como a busca em si é estado local de
  // cada um desses componentes (showSearch/searchQuery), incrementar esse
  // contador é o sinal que eles escutam pra abrir a própria barra de busca,
  // sem precisar levantar esse estado todo pra cá.
  const [chatSearchSignal, setChatSearchSignal] = useState(0);
  const [internalChatSearchSignal, setInternalChatSearchSignal] = useState(0);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [showPollSender, setShowPollSender] = useState(false);
  const [showMediaGallery, setShowMediaGallery] = useState(false);
  const [showGroupCreator, setShowGroupCreator] = useState(false);
  const [showBroadcastManager, setShowBroadcastManager] = useState(false);
  const [showProfilePanel, setShowProfilePanel] = useState(false);
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [participantInfo, setParticipantInfo] = useState(null); // { jid, phoneNumber, name, accountId }
  const [showStatusViewer, setShowStatusViewer] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('general');
  const [showContactInfo, setShowContactInfo] = useState(false);

  // Refs para acesso síncrono
  const selectedConversationRef = useRef(selectedConversation);
  const messagesRef = useRef(messages);
  // ID isolado para comparação direta (evita qualquer problema com o objeto completo)
  const selectedConvIdRef = useRef(null);
  const selectedInternalChatIdRef = useRef(null);
  const currentUserProfileRef = useRef(null);
  // Só pra ler is_muted/is_favorite ao vivo dentro do handler de socket de
  // mensagem interna (stableInternalChatMessage), sem precisar recriar esse
  // handler (e re-registrar o listener) toda vez que internalChats muda.
  const internalChatsRef = useRef([]);

  // Ref estável para o handler de nova mensagem (evita re-registro no socket)
  const wsNewMessageHandlerRef = useRef(null);
  const wsUpdateConvRef = useRef(null);
  // Timestamp da última sincronização de mensagens para a conversa ativa
  const lastSyncTimestampRef = useRef(0);
  // Mesmo par (ref + timestamp de sync) do chat de clientes acima, só que
  // pro chat de equipe — ver fallback sync mais abaixo.
  const internalMessagesRef = useRef([]);
  const lastInternalSyncTimestampRef = useRef(0);

  const handleOpenSettings = useCallback(() => {
    setSettingsInitialTab('general');
    setShowSettings(true); // FIX: Logic updated
  }, []);
  
  // EFEITOS
  
  // Token é lido diretamente do localStorage pelo interceptor do axios

  // Atualizar refs quando estado mudar
  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
    selectedConvIdRef.current = selectedConversation?.id ?? null;
  }, [selectedConversation]);

  useEffect(() => {
    selectedInternalChatIdRef.current = selectedInternalChat?.id ?? null;
  }, [selectedInternalChat]);

  useEffect(() => {
    internalChatsRef.current = internalChats;
  }, [internalChats]);

  useEffect(() => {
    currentUserProfileRef.current = currentUserProfile;
  }, [currentUserProfile]);

  // Busca meu próprio status manual (Disponível/Ausente/Ocupado/Offline) ao
  // logar, pra refletir o que foi escolhido numa sessão anterior — sem isso
  // o seletor sempre voltaria pro default "online" a cada reload.
  useEffect(() => {
    if (!currentUserProfile?.id) return;
    apiService.getInternalChatPresence([currentUserProfile.id]).then(presence => {
      setInternalPresence(prev => ({ ...prev, ...presence }));
    });
  }, [currentUserProfile?.id]);

  // Presença de todo mundo que aparece na lista "Equipe" (não só a conversa
  // aberta), pra mostrar a bolinha em cada item da lista, não só no header.
  useEffect(() => {
    const myId = currentUserProfile?.id;
    if (!myId || internalChats.length === 0) return;
    const otherIds = [...new Set(
      internalChats.filter(c => !c.is_group).flatMap(c => (c.participants || []).map(p => p.id)).filter(id => id !== myId)
    )];
    if (otherIds.length === 0) return;
    apiService.getInternalChatPresence(otherIds).then(presence => {
      setInternalPresence(prev => ({ ...prev, ...presence }));
    });
  }, [internalChats, currentUserProfile?.id]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Fallback: quando o sidebar atualiza a conversa ativa com timestamp mais novo,
  // sincroniza o chatarea buscando mensagens silenciosamente.
  useEffect(() => {
    const activeId = selectedConvIdRef.current;
    if (!activeId || !conversations.length) return;

    // eslint-disable-next-line eqeqeq
    const activeConv = conversations.find(c => c.id == activeId);
    if (!activeConv) return;

    const sidebarTs = activeConv.timestamp || 0;
    // Só age se o sidebar tem timestamp novo que ainda não sincronizamos
    if (!sidebarTs || sidebarTs <= lastSyncTimestampRef.current) return;

    const msgs = messagesRef.current;
    const lastMsgTs = msgs.length > 0 ? (msgs[msgs.length - 1]?.timestamp || 0) : 0;

    if (sidebarTs > lastMsgTs) {
      lastSyncTimestampRef.current = sidebarTs;
      const conv = selectedConversationRef.current;
      if (!conv) return;
      apiService.getMessages(conv.id)
        .then(fetched => {
          if (!fetched || fetched.length === 0) return;
          // Só atualiza se realmente há mensagens novas
          if (fetched.length > messagesRef.current.length) {
            console.log(`Fallback sync: ${fetched.length} msgs (era ${messagesRef.current.length})`);
            setMessages(fetched);
          }
        })
        .catch(() => {});
    }
  }, [conversations]);

  // Resetar o timestamp de sincronização ao trocar de conversa
  useEffect(() => {
    lastSyncTimestampRef.current = 0;
  }, [selectedConversation]);

  useEffect(() => {
    internalMessagesRef.current = internalMessages;
  }, [internalMessages]);

  // BUG (2026-09-04): chat de equipe não tinha o equivalente do fallback
  // acima — dependia 100% do evento internal_chat_message chegando certo
  // via WebSocket pra atualizar a conversa aberta; se esse evento
  // específico falhasse por qualquer motivo (rede, corrida, o que for), a
  // conversa ficava parada até trocar de chat ou recarregar a página (o
  // que força um refetch). setInternalChats (a barra lateral) já é
  // atualizada de forma incondicional em todo recebimento — usa isso como
  // sinal de "tem coisa nova que talvez não tenha chegado na tela".
  useEffect(() => {
    const activeId = selectedInternalChatIdRef.current;
    if (!activeId || !internalChats.length) return;

    const activeChat = internalChats.find(c => c.id === activeId);
    const sidebarTs = activeChat?.last_message?.created_at ? new Date(activeChat.last_message.created_at).getTime() : 0;
    if (!sidebarTs || sidebarTs <= lastInternalSyncTimestampRef.current) return;

    const msgs = internalMessagesRef.current;
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const lastMsgTs = lastMsg?.created_at ? new Date(lastMsg.created_at).getTime() : 0;

    if (sidebarTs > lastMsgTs) {
      lastInternalSyncTimestampRef.current = sidebarTs;
      apiService.getInternalChatMessages(activeId)
        .then(fetched => {
          if (!fetched || fetched.length === 0) return;
          if (fetched.length > internalMessagesRef.current.length) {
            console.log(`Fallback sync (chat interno): ${fetched.length} msgs (era ${internalMessagesRef.current.length})`);
            setInternalMessages(fetched);
          }
        })
        .catch(() => {});
    }
  }, [internalChats]);

  // Resetar o timestamp de sincronização ao trocar de conversa interna
  useEffect(() => {
    lastInternalSyncTimestampRef.current = 0;
  }, [selectedInternalChat]);

  // Aplicar tema
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('whatsapp-theme', theme);
  }, [theme]);

  // Rebusca o perfil completo do usuário ao montar (cobre F5 com token salvo mas
  // sem o objeto de perfil em cache, e também refresca is_admin/role caso tenham
  // mudado desde o login).
  useEffect(() => {
    if (!isLoggedIn) return;
    // Notificação desktop simples (só funciona com alguma aba aberta) +
    // Web Push de verdade (chega com o navegador fechado, pedido explícito
    // pros lembretes de tarefa) — subscribeToPush só efetivamente inscreve
    // se a permissão acima foi concedida; em qualquer outro caso devolve
    // null e isso aqui vira um no-op silencioso.
    requestNotificationPermission().then(async (permission) => {
      if (permission !== 'granted') return;
      const vapidRes = await apiService.getPushVapidPublicKey().catch(() => null);
      const publicKey = vapidRes?.data?.public_key;
      if (!publicKey) return;
      const subscription = await subscribeToPush(publicKey);
      if (subscription) apiService.subscribeToPush(subscription).catch(() => {});
    });
    apiService.getMe()
      .then(profile => {
        setCurrentUserProfile(profile);
        localStorage.setItem('currentUserProfile', JSON.stringify(profile));
      })
      .catch(e => console.warn('Não foi possível carregar o perfil do usuário:', e));
    apiService.getAgents().then(setAgents);
    apiService.getTags().then(setTagCatalog);
    apiService.getQuickReplies().then(setQuickReplies);
    apiService.getStatusColors().then(colors => colors && setStatusColors(colors));
    // Carrega cedo (não só ao abrir a aba Equipe) — o modal "Encaminhar" do
    // lado WhatsApp precisa da lista pra oferecer conversas internas como destino.
    apiService.getInternalChats().then(setInternalChats);
    apiService.getMyTasks().then(setMyTasks);
    apiService.getAutomations().then(a => {
      if (a?.sla?.wait_minutes) setSlaWaitMinutes(a.sla.wait_minutes);
      setCsatEnabled(!!a?.csat?.enabled);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);
  
  // HANDLERS DE AUTENTICAÇÃO
  
  const handleLogin = (token, username, userProfile = null) => {
    console.log(`Login efetuado. Usuário: ${username}`);
    localStorage.setItem('token', token);
    localStorage.setItem('currentUser', username);
    if (userProfile) localStorage.setItem('currentUserProfile', JSON.stringify(userProfile));
    setAuthToken(token);
    setCurrentUser(username);
    setCurrentUserProfile(userProfile);
    setIsLoggedIn(true);

    // Auto-selecionar a primeira conta ativa após login
    apiService.getAccounts()
      .then(accounts => {
        const active = accounts.find(a => a.is_active && a.is_authenticated) || accounts.find(a => a.is_active);
        if (active) {
          console.log(`Conta auto-selecionada: #${active.id} (${active.provider_type})`);
          setSelectedAccountId(active.id);
          setSelectedAccount(active);
        } else {
          console.warn('Nenhuma conta ativa encontrada. Cadastre uma conta em Configurações → Contas WA.');
        }
      })
      .catch(e => console.warn('Não foi possível carregar contas:', e));
  };
  
  const handleLogout = () => {
    console.log('Logout efetuado. Limpando sessão.');
    localStorage.removeItem('token');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentUserProfile');
    setIsLoggedIn(false);
    setAuthToken(null);
    setCurrentUser(null);
    setCurrentUserProfile(null);
    setSelectedConversation(null);
    setMessages([]);
    setConversations([]);
    wsService.disconnect();
  };

  // Sessão expirada (401 em endpoint protegido, ex: /api/settings/accounts):
  // volta para a tela de login em vez de deixar a UI presa num estado
  // "logado" com dados protegidos silenciosamente vazios.
  useEffect(() => {
    const onSessionExpired = () => {
      console.warn('⏰ Sessão expirada ou token inválido. Voltando para o login.');
      handleLogout();
    };
    window.addEventListener('auth:session-expired', onSessionExpired);
    return () => window.removeEventListener('auth:session-expired', onSessionExpired);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc desseleciona o chat aberto (clientes ou equipe, conforme a aba
  // ativa) — não mexe em nada se tiver um modal de "nova conversa" aberto
  // (aí o Esc é problema do modal, não da lista de chats).
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (showNewChatModal || showNewInternalChatModal) return;
      if (sidebarView === 'team') {
        setSelectedInternalChat(prev => (prev ? null : prev));
      } else {
        setSelectedConversation(prev => (prev ? null : prev));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarView, showNewChatModal, showNewInternalChatModal]);

  // HANDLERS DE TEMA
  
  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };
  
  // HANDLERS DE CONVERSAS
  
  // silent=true: recarrega os dados sem acender o spinner de loading (que
  // esconde a lista inteira) — usado nos refreshes de fundo (polling 30s,
  // foco de janela, fallback de WS perdido) pra não piscar a sidebar inteira
  // a cada refresh automático. O carregamento inicial e a troca de conta
  // continuam mostrando o spinner normalmente.
  const loadConversations = useCallback(async (accountId = null, { silent = false } = {}) => {
    try {
      if (!silent) setConversationsLoading(true);
      console.log('Carregando conversas... account_id=', accountId);
  
      const conversationsArray = await apiService.getConversations(accountId); // ← mudar aqui
      console.log('Conversas recebidas:', conversationsArray.length);
  
      const processed = conversationsArray.map(conv => {
        const contactName = conv.contact ? conv.contact.name : 'Unknown Contact';
        const contactPhone = conv.contact ? conv.contact.phone_number : '';
        const contactWaId = conv.contact ? conv.contact.wa_id : '';
        const lastMsg = conv.last_message;
        
        return {
          ...conv,
          name: contactName,
          fromNumber: contactWaId || contactPhone,
          waId: contactWaId,
          lastMessage: lastMsg?.message || '',
          timestamp: lastMsg?.timestamp || moment(conv.last_message_at).valueOf(),
          unreadCount: conv.unread_count || 0,
          contact: conv.contact
        };
      });
      
      console.log('Conversas processadas:', processed.length);
      setConversations(processed);
    } catch (error) {
      console.error('Erro ao carregar conversas:', error);
      if (!silent) setConversations([]);
    } finally {
      if (!silent) setConversationsLoading(false);
    }
  }, []);
  
  const updateConversationListLocally = useCallback((newMessageData) => {
    setConversations(prevConversations => {
      const targetConvId = newMessageData.conversation_id;
      
      if (targetConvId === undefined) {
        console.error("updateConversationListLocally falhou: conversation_id é undefined.");
        return prevConversations;
      }
      
      // eslint-disable-next-line eqeqeq
      const index = prevConversations.findIndex(c => c.id == targetConvId);

      let updatedConv = null;
      let otherConvs = [];

      if (index !== -1) {
        const oldConv = prevConversations[index];
        // eslint-disable-next-line eqeqeq
        const isSelected = selectedConvIdRef.current != null && selectedConvIdRef.current == targetConvId;
        const isOutbound = newMessageData.direction === 'outbound' || newMessageData.sender === 'me';
        const incrementUnread = !isSelected && !isOutbound;

        // Som + notificação desktop — só pra mensagem de verdade recebida
        // (nunca eco do que eu mesmo mandei). O SOM toca sempre (mesma lógica
        // do WhatsApp Web: confirma que chegou mesmo com a conversa aberta);
        // só o POPUP é suprimido quando eu já estou literalmente olhando pra
        // essa conversa com a aba em foco (não faz sentido interromper com
        // popup do que já está na tela).
        if (!isOutbound && !oldConv.is_muted) {
          notifyNewMessage({
            title: oldConv.contact?.name || oldConv.name || 'Nova mensagem',
            body: newMessageData.message || newMessageData.message_text || '📎 Mídia',
            tag: `wa-chat-${targetConvId}`,
            onClick: () => handleSelectConversation(oldConv),
            popupSuppressed: isSelected && document.hasFocus(),
            icon: oldConv.contact?.profile_picture_url,
          });
        }

        let newUnreadCount = oldConv.unreadCount + (incrementUnread ? 1 : 0);
        if (isSelected) {
          newUnreadCount = 0;
        }
        
        updatedConv = {
          ...oldConv,
          lastMessage: newMessageData.message || newMessageData.message_text || `[${newMessageData.type}]`,
          timestamp: newMessageData.timestamp,
          unreadCount: newUnreadCount,
          last_message_at: new Date(newMessageData.timestamp),
        };
        
        otherConvs = prevConversations.filter(c => c.id !== targetConvId);
      } else {
        console.warn(`Conversation ID ${targetConvId} não encontrada. Forçando full reload.`);
        loadConversations(null, { silent: true });
        return prevConversations;
      }
      
      const newConversationsList = [updatedConv, ...otherConvs];
      newConversationsList.sort((a, b) => {
        const pinDiff = (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0);
        if (pinDiff !== 0) return pinDiff;
        return moment(b.timestamp).valueOf() - moment(a.timestamp).valueOf();
      });
      
      return newConversationsList;
    });
  }, [loadConversations]);

  // Rajada de mensagens "coladas" no tempo (ex: dezenas de stickers em
  // poucos minutos) não deveria ficar cortada no meio pelo limite bruto de
  // 50 da 1ª página — ver BUG abaixo em loadMessages. 5 min: intervalo
  // curto o bastante pra não confundir com uma pausa real na conversa,
  // longo o bastante pra cobrir uma rajada de envio rápido.
  const BURST_AUTO_LOAD_GAP_MS = 5 * 60 * 1000;
  // Teto de segurança — nunca carrega mais que ~6 páginas extras (300 msgs)
  // sozinho, pra não puxar uma conversa inteira de uma vez só num grupo
  // que nunca para de falar.
  const BURST_AUTO_LOAD_MAX_EXTRA_PAGES = 6;

  const loadMessages = useCallback(async (conversation) => {
    // Conversa "nova" (ainda não existe no banco — usuário abriu "Nova
    // conversa" e digitou um número, mas ainda não mandou a 1ª mensagem):
    // não tem id nenhum ainda pra buscar nada. A conversa/contato reais só
    // nascem quando a 1ª mensagem for enviada de verdade (_get_contact_and_
    // conversation no backend, mesmo caminho get-or-create de sempre).
    if (!conversation.id) {
      setMessages([]);
      setHasMoreMessages(false);
      return [];
    }
    try {
      setMessagesLoading(true);
      console.log('Carregando mensagens da conversa:', conversation.id);

      let msgs = [];

      if (conversation.messages && Array.isArray(conversation.messages) && conversation.messages.length > 0) {
        msgs = conversation.messages;
        console.log(`Usando ${msgs.length} mensagens do cache`);
      } else {
        console.log('Cache vazio, buscando da API...');
        const response = await apiService.getMessages(conversation.id);
        msgs = response || [];
        console.log(`Buscadas ${msgs.length} mensagens da API`);
      }

      // O backend só devolve as 50 mais recentes nesse 1º carregamento (sem
      // before_timestamp) — se voltou a página cheia, pode existir mais
      // histórico.
      let hasMore = msgs.length >= 50;

      // BUG (2026-09-04): confirmado ao vivo — uma rajada de 83 stickers em
      // ~2min ficava com as ~33 primeiras (cronologicamente) escondidas até
      // rolar manualmente pro topo, porque caíam antes do corte bruto de 50.
      // Continua buscando páginas mais antigas sozinho enquanto o intervalo
      // até a próxima for pequeno (mesma rajada) — só para quando achar uma
      // pausa real na conversa ou bater o teto de segurança.
      let extraPages = 0;
      while (hasMore && msgs.length > 0 && extraPages < BURST_AUTO_LOAD_MAX_EXTRA_PAGES) {
        const oldestTs = msgs[0]?.timestamp;
        if (!oldestTs) break;
        const { messages: older, hasMore: moreAfter } = await apiService.getOlderMessages(conversation.id, oldestTs);
        if (!older.length) { hasMore = false; break; }
        const newestOfOlderPage = older[older.length - 1]?.timestamp;
        const gap = newestOfOlderPage ? oldestTs - newestOfOlderPage : Infinity;
        if (gap > BURST_AUTO_LOAD_GAP_MS) {
          hasMore = moreAfter;
          break;
        }
        msgs = [...older, ...msgs];
        hasMore = moreAfter;
        extraPages++;
      }

      // Notas internas (thread privada entre atendentes) entram na mesma
      // timeline, ordenadas junto com as mensagens reais — nunca saem pro
      // WhatsApp, só existem no frontend por is_internal_note.
      const notes = await apiService.getNotes(conversation.id);
      const merged = notes.length
        ? [...msgs, ...notes].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        : msgs;

      setMessages(merged);
      setHasMoreMessages(hasMore);
      return merged;
    } catch (error) {
      console.error('Erro ao carregar mensagens:', error);
      setMessages([]);
      setHasMoreMessages(false);
      return [];
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  // Carrega mensagens mais antigas que a primeira já exibida — acionado pelo
  // ChatArea quando o atendente rola até perto do topo do chat. Faz merge
  // no INÍCIO do array preservando o que já está na tela (dedup por wamid,
  // já que a corrida entre este fetch e um evento de WebSocket concorrente é
  // improvável mas inofensiva se acontecer duas vezes).
  const handleLoadOlderMessages = useCallback(async () => {
    const currentConv = selectedConversationRef.current;
    if (!currentConv || !currentConv.id || typeof currentConv.id === 'string') return;
    if (loadingOlderMessages || !hasMoreMessages) return;

    setLoadingOlderMessages(true);
    try {
      const oldest = messages[0];
      if (!oldest?.timestamp) {
        setHasMoreMessages(false);
        return;
      }
      const { messages: older, hasMore } = await apiService.getOlderMessages(currentConv.id, oldest.timestamp);
      if (older.length > 0) {
        setMessages(prev => {
          const existingWamids = new Set(prev.map(m => m.wamid));
          const deduped = older.filter(m => !existingWamids.has(m.wamid));
          return [...deduped, ...prev];
        });
      }
      setHasMoreMessages(hasMore);
    } catch (error) {
      console.error('Erro ao carregar mensagens antigas:', error);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [messages, loadingOlderMessages, hasMoreMessages]);

  const handleSelectConversation = useCallback(async (conversation) => {
    // Já está nessa conversa — não recarrega nem reseta o scroll
    if (selectedConversationRef.current?.id === conversation.id) return;
    setShowContactInfo(false);
    setShowGroupManager(false);

    // Atualiza os refs imediatamente (síncrono) para que mensagens WebSocket
    // que chegarem durante o await loadMessages() já encontrem o chat correto.
    selectedConversationRef.current = conversation;
    selectedConvIdRef.current = conversation.id;
    setSelectedConversation(conversation);
    if (conversation.account_id) {
      setSelectedAccountId(prev => prev !== conversation.account_id ? conversation.account_id : prev);
    }
    // Guarda contra resposta atrasada de uma troca de conversa rápida (ex:
    // A → B → A de novo antes da 1ª busca voltar) — sem o `if`, a resposta
    // de uma conversa que não é mais a aberta podia sobrescrever a lista
    // certa com a de outra (ou com vazio), fazendo as tarefas "sumirem".
    // Mesmo padrão de guarda por id usado no resto do app (selectedConvIdRef).
    apiService.getCustomerConversationTasks(conversation.id).then(tasks => {
      if (selectedConvIdRef.current === conversation.id) setCustomerConversationTasks(tasks);
    });
    await loadMessages(conversation);

    // Marca TODA a conversa como lida no backend (não só os últimos 50
    // carregados na tela — ver apiService.markConversationRead) sempre que
    // ela tem alguma não lida, segundo o próprio contador que já veio de
    // GET /conversations.
    if (conversation.unread_count > 0) {
      apiService.markConversationRead(conversation.id)
        .then(() => {
          setConversations(prev =>
            prev.map(conv =>
              conv.id === conversation.id
                ? {...conv, unreadCount: 0, unread_count: 0}
                : conv
            )
          );
        })
        .catch(err => console.error('Erro ao marcar como lida:', err));
    }
  }, [loadMessages]);

  // FIX: REMOVIDO BLOCO GLOBAL INCORRETO (linhas 290-307) que causava no-undef
  
  // HANDLERS DE MENSAGENS
  
  const handleSendMessage = useCallback(async (to, text, file, type, caption, reply_to = null) => {
    const currentConversation = selectedConversationRef.current;

    if (!currentConversation) {
      console.warn('Nenhuma conversa selecionada');
      return;
    }

    const effectiveAccountId = currentConversation.account_id || selectedAccountId;
    const localMediaUrl = file ? URL.createObjectURL(file) : undefined;

    // Bolha otimista: aparece na tela IMEDIATAMENTE, com relógio (pending) —
    // nunca espera o round-trip HTTP pra dar qualquer feedback visual (bug
    // anterior: mensagem só surgia depois da resposta voltar, e nesse meio
    // tempo a tela inteira de mensagens ficava com spinner — loading prop do
    // ChatArea incluía este `sending`, então cada envio "piscava" o chat
    // inteiro, resetando o scroll numa conversa longa). O prefixo "temp_" é
    // reconhecido pelo handler de WS (wsNewMessageHandlerRef) pra substituir
    // esta bolha pelo dado real assim que o eco do provider chegar — mesmo se
    // isso acontecer antes da resposta HTTP deste envio resolver.
    const tempWamid = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = {
      wamid: tempWamid,
      message: text || caption || `[${type || 'media'}]`,
      message_text: text || caption || `[${type || 'media'}]`,
      type: type || 'text',
      message_type: type || 'text',
      direction: 'outbound',
      sender: 'me',
      from_number: 'me',
      timestamp: Date.now(),
      status: 'pending',
      conversation_id: currentConversation.id,
      mediaUrl: localMediaUrl,
      caption: caption || undefined,
      filename: file?.name,
      context: reply_to ? { message_id: reply_to } : null,
      reply_to_wamid: reply_to || null,
    };
    setMessages(prev => [...prev, optimisticMessage]);

    try {
      let response;
      console.log(`Enviando via account_id=${effectiveAccountId} (conversa=${currentConversation.id})`);

      if (file) {
        response = await apiService.sendMediaMessage(to, file, getFileType(file), caption, reply_to, effectiveAccountId);
      } else if (text) {
        response = await apiService.sendTextMessage(to, text, reply_to, effectiveAccountId);
      } else {
        console.warn('Nenhum conteúdo para enviar');
        setMessages(prev => prev.filter(m => m.wamid !== tempWamid));
        return;
      }

      console.log('Mensagem enviada:', response);

      // Resposta a uma dúvida de produto: vai só ao site e o resultado aparece no
      // próprio card — não existe mensagem de chat para mostrar.
      if (response?.site_question) {
        setMessages(prev => prev.filter(m => m.wamid !== tempWamid));
        showToast('success', 'Resposta enviada para publicação no site.');
        return;
      }

      // Conversa "nova" (placeholder local, id tipo "new_5511...") acabou de
      // virar uma conversa de verdade no banco com este envio
      // (_get_contact_and_conversation no backend). Busca ela pelo telefone
      // e troca a referência local pelo id real — sem isso, o chat aberto
      // ficava preso no id fake pro resto da sessão (mensagens seguintes não
      // batiam com a conversa recém-criada na lista lateral).
      let effectiveConvId = currentConversation.id;
      if (typeof currentConversation.id === 'string' && currentConversation.id.startsWith('new_')) {
        try {
          const fresh = await apiService.getConversations(effectiveAccountId);
          const digits = (to || '').replace(/\D/g, '');
          const real = (fresh || []).find(c => !c.is_group && (c.contact?.phone_number === digits || c.contact?.wa_id === digits));
          if (real) {
            effectiveConvId = real.id;
            const reconciled = { ...currentConversation, ...real };
            selectedConversationRef.current = reconciled;
            selectedConvIdRef.current = real.id;
            setSelectedConversation(reconciled);
            loadConversations(effectiveAccountId, { silent: true });
          }
        } catch (_) { /* segue com o id local mesmo — próxima ação corrige sozinha */ }
      }

      // Texto de verdade enviado pro WhatsApp — pra mensagem de texto o
      // backend antepõe "*Nome - Setor*" em negrito automaticamente; usa o
      // que ele devolve (response.text) pra bolha já bater com o que o
      // cliente/grupo realmente recebeu, em vez do texto cru digitado.
      // Se o eco de WS já substituiu a bolha temp_ antes desta resposta HTTP
      // voltar (corrida documentada acima), este map() simplesmente não acha
      // nada com wamid===tempWamid e não faz nada — sem duplicar.
      const confirmedMessage = {
        wamid: response.message_id || tempWamid,
        message: response.text || optimisticMessage.message,
        message_text: response.text || optimisticMessage.message_text,
        status: 'sent',
        conversation_id: effectiveConvId,
        media_id: response.media_id,
        mediaUrl: response.media_url || localMediaUrl,
      };
      setMessages(prev => prev.map(m => m.wamid === tempWamid ? { ...m, ...confirmedMessage } : m));
      updateConversationListLocally({ ...optimisticMessage, ...confirmedMessage });
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);
      // Some com a bolha otimista em vez de deixar presa em "pending" pra
      // sempre — o toast (não-bloqueante, diferente do alert() antigo que
      // travava a tela inteira até clicar OK) já demonstra o erro sozinho.
      setMessages(prev => prev.filter(m => m.wamid !== tempWamid));
      const detail = error?.response?.data?.detail || error?.response?.data || error.message || 'Erro desconhecido';
      showToast('error', `Falha ao enviar mensagem:\n${detail}`);
    }
  }, [updateConversationListLocally, loadConversations, showToast]);
  
  const sendButtons = useCallback(async () => {
    const currentConv = selectedConversationRef.current;
    if (!currentConv || !currentConv.contact) {
      console.warn('Nenhuma conversa selecionada para enviar botões.');
      return;
    }
    
    try {
      const response = await apiService.sendInteractiveButtons({
        to: currentConv.contact.wa_id,
        body_text: "Como podemos ajudar? Escolha uma opção:",
        buttons: [
          {id: "btn_info", title: "Informações"},
          {id: "btn_suporte", title: "Suporte"}
        ],
        header_text: "Menu de Opções",
      });
      console.log('Botões interativos enviados:', response);
      loadMessages(currentConv);
    } catch (error) {
      console.error('Erro ao enviar botões:', error);
      alert('Erro ao enviar menu interativo.');
    }
  }, [loadMessages]);

  const sendCtaButton = useCallback(async () => {
    const currentConv = selectedConversationRef.current;
    if (!currentConv || !currentConv.contact) {
      console.warn('Nenhuma conversa selecionada para enviar botão CTA.');
      return;
    }
    const body_text = window.prompt('Texto da mensagem:');
    if (!body_text) return;
    const display_text = window.prompt('Texto do botão:', 'Acessar');
    if (!display_text) return;
    const url = window.prompt('URL do link:');
    if (!url) return;
    try {
      await apiService.sendCtaUrlButton({ to: currentConv.contact.wa_id, body_text, display_text, url, account_id: currentConv.account_id || null });
      console.log('Botão CTA enviado');
      loadMessages(currentConv);
    } catch (error) {
      console.error('Erro ao enviar botão CTA:', error);
      alert('Erro ao enviar botão: ' + (error?.response?.data?.detail || error.message));
    }
  }, [loadMessages]);

  const sendReaction = useCallback(async (messageId, emoji, fromMe = false) => {
    const currentConv = selectedConversationRef.current;
    if (!currentConv || !currentConv.contact) {
      console.warn('Nenhuma conversa selecionada para enviar reação.');
      return;
    }

    try {
      setMessages(prev =>
        prev.map(msg =>
          msg.wamid === messageId
            ? { ...msg, reaction_emoji: emoji }
            : msg
        )
      );

      const response = await apiService.sendReaction({
        to: currentConv.contact.wa_id,
        message_id: messageId,
        emoji: emoji,
        from_me: fromMe,
        account_id: currentConv.account_id || null
      });
      
      console.log('Reação enviada:', response);
    } catch (error) {
      console.error('Erro ao enviar reação:', error);
      setMessages(prev =>
        prev.map(msg =>
          msg.wamid === messageId
            ? { ...msg, reaction_emoji: null }
            : msg
        )
      );
    }
  }, []);

  const removeReaction = useCallback(async (messageId) => {
    const currentConv = selectedConversationRef.current;
    if (!currentConv || !currentConv.contact) return;
    setMessages(prev => prev.map(msg => msg.wamid === messageId ? { ...msg, reaction_emoji: null } : msg));
    try {
      await apiService.removeReaction({ to: currentConv.contact.wa_id, message_id: messageId, account_id: currentConv.account_id || null });
    } catch (error) {
      console.error('Erro ao remover reação:', error);
    }
  }, []);

  // AÇÕES SOBRE MENSAGEM (Baileys) — encaminhar, editar, apagar, fixar, favoritar

  // Encaminhar pra outro número de WhatsApp (protocolo, só Baileys/WPPConnect/
  // whatsapp-web.js) e/ou pra uma ou mais conversas da Equipe (com referência
  // ao contato de origem, ver POST .../forward-to-internal no backend).
  const handleForwardMessage = useCallback((message, opts = {}) => {
    const { toNumber, internalConversationIds } = opts;
    const currentConv = selectedConversationRef.current;
    if (!currentConv) return;

    if (toNumber) {
      const fromJid = currentConv?.contact?.wa_id;
      if (!ADVANCED_API_PROVIDERS.has(selectedAccount?.provider_type)) {
        alert('Encaminhar para outro número disponível apenas para contas Baileys/WPPConnect/whatsapp-web.js no momento.');
      } else if (fromJid) {
        baileysApi.forwardMessage(toNumber.replace(/\D/g, ''), message.wamid, fromJid, selectedAccountId)
          .then(() => console.log('Mensagem encaminhada'))
          .catch(e => alert('Erro ao encaminhar: ' + (e?.response?.data?.detail || e.message)));
      }
    }

    if (internalConversationIds && internalConversationIds.length > 0) {
      apiService.forwardMessageToInternal(currentConv.id, message.wamid, internalConversationIds)
        .catch(e => alert('Erro ao encaminhar pra Equipe: ' + (e?.response?.data?.detail || e.message)));
    }
  }, [selectedAccountId, selectedAccount]);

  const handleEditMessage = useCallback((message, newText) => {
    if (!ADVANCED_API_PROVIDERS.has(selectedAccount?.provider_type)) { alert('Editar não disponível para este tipo de conta.'); return Promise.resolve(); }
    const currentConv = selectedConversationRef.current;
    const jid = currentConv?.contact?.wa_id;
    if (!jid) return Promise.resolve();
    return baileysApi.editMessage(jid, message.wamid, newText, selectedAccountId)
      .then(() => setMessages(prev => prev.map(m => m.wamid === message.wamid ? { ...m, message: newText, message_text: newText } : m)))
      .catch(e => { alert('Erro ao editar: ' + (e?.response?.data?.detail || e.message)); throw e; });
  }, [selectedAccountId, selectedAccount]);

  const handleDeleteMessage = useCallback((message) => {
    if (!ADVANCED_API_PROVIDERS.has(selectedAccount?.provider_type)) { alert('Apagar não disponível para este tipo de conta.'); return; }
    const currentConv = selectedConversationRef.current;
    const jid = currentConv?.contact?.wa_id;
    if (!jid) return;
    if (!window.confirm('Apagar esta mensagem para todos?')) return;
    baileysApi.deleteMessage(jid, message.wamid, true, selectedAccountId)
      .then(() => setMessages(prev => prev.filter(m => m.wamid !== message.wamid)))
      .catch(e => alert('Erro ao apagar: ' + (e?.response?.data?.detail || e.message)));
  }, [selectedAccountId, selectedAccount]);

  // Fixar/favoritar persistem no banco (Message.is_pinned/is_starred) — vale
  // pra qualquer provider, diferente do reflexo no app do celular (só
  // Baileys/WPPConnect/whatsapp-web.js), que o backend tenta em melhor esforço.
  const handlePinMessage = useCallback((message, pinned = true) => {
    const currentConv = selectedConversationRef.current;
    if (!currentConv) return;
    apiService.pinWhatsAppMessage(currentConv.id, message.wamid, pinned)
      .then(() => setMessages(prev => prev.map(m => m.wamid === message.wamid ? { ...m, is_pinned: pinned } : m)))
      .catch(e => alert('Erro ao fixar: ' + (e?.response?.data?.detail || e.message)));
  }, []);

  const handleStarMessage = useCallback((message, starred = true) => {
    const currentConv = selectedConversationRef.current;
    if (!currentConv) return;
    apiService.starWhatsAppMessage(currentConv.id, message.wamid, starred)
      .then(() => setMessages(prev => prev.map(m => m.wamid === message.wamid ? { ...m, is_starred: starred } : m)))
      .catch(e => alert('Erro ao favoritar: ' + (e?.response?.data?.detail || e.message)));
  }, []);

  // Clique no "!" vermelho de uma mensagem com falha (ver ChatArea.js). Uma
  // mensagem RECEBIDA que se perdeu entre o WhatsApp e o banco usa um id
  // numérico de verdade (criada por /bridge/register-failed) — reprocessa
  // o payload original com o MESMO wamid, então o próprio evento de
  // websocket (ver wsNewMessageHandlerRef acima) já atualiza essa tela e
  // qualquer outra aberta na mesma conversa. Uma mensagem ENVIADA que
  // falhou troca de wamid ao ser recuperada (o sintético "failed_out_..."
  // vira o wamid real do WhatsApp) — só a tela de quem clicou é atualizada
  // aqui; outros atendentes olhando a mesma conversa em paralelo veem a
  // correção só ao recarregar (caso raro, não vale a complexidade de
  // sincronizar via websocket por wamid trocado).
  const handleRetryFailedMessage = useCallback((message) => {
    const isOutbound = message.direction === 'outbound' || message.sender === 'me' || message.from_number === 'me';
    const call = isOutbound
      ? apiService.retrySendMessage(message.id)
      : apiService.retryFailedMessage(message.id);
    return call
      .then((res) => {
        if (isOutbound && res?.data?.message) {
          setMessages(prev => prev.map(m => m.wamid === message.wamid ? res.data.message : m));
        }
      })
      .catch(e => alert('Ainda não foi possível recuperar essa mensagem: ' + (e?.response?.data?.detail || e.message)));
  }, []);

  // HANDLERS DO CHATAREA MENU (Ações da Conversa)

  const isBaileys = selectedAccount?.provider_type === 'baileys';
  const supportsAdvancedApi = ADVANCED_API_PROVIDERS.has(selectedAccount?.provider_type);
  // group/metadata, group/participants/*, profile/picture etc. (routes_baileys.py)
  // já aceitam qualquer provider "full API" (Baileys, WPPConnect, WhatsApp-Web.js)
  // via _get_baileys()/_FULL_API_PROVIDERS — só Venom e as variantes Meta Cloud
  // não têm conceito de grupo. GroupManager pode abrir pra esses 3 também.
  const supportsGroupManagement = ['baileys', 'wppconnect', 'whatsapp_web_js']
    .includes(selectedAccount?.provider_type);

  const handleUpdateConversationStatus = useCallback((conversationId, status, options) => {
    runGuardedAction(`status-${conversationId}`, () =>
      apiService.updateConversationStatus(conversationId, status, options)
        .then(() => {
          setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, status } : c));
          setSelectedConversation(prev => prev && prev.id === conversationId ? { ...prev, status } : prev);
        })
        .catch(e => {
          console.error('Erro ao atualizar status da conversa:', e);
          alert('Não foi possível atualizar o status da conversa.');
        })
    );
  }, [runGuardedAction]);

  const handleAssignConversation = useCallback((conversationId, userId) => {
    runGuardedAction(`assign-${conversationId}`, () =>
      apiService.assignConversation(conversationId, userId)
        .then(res => {
          const assignedTo = res?.data?.assigned_to ?? null;
          setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, assigned_to: assignedTo } : c));
          setSelectedConversation(prev => prev && prev.id === conversationId ? { ...prev, assigned_to: assignedTo } : prev);
        })
        .catch(e => {
          console.error('Erro ao atribuir conversa:', e);
          alert(e.response?.data?.detail || 'Não foi possível atribuir a conversa.');
        })
    );
  }, [runGuardedAction]);

  const handleToggleBot = useCallback((conversationId, enabled) => {
    runGuardedAction(`bot-${conversationId}`, () =>
      apiService.updateConversationBot(conversationId, enabled)
        .then(() => {
          setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, bot_enabled: enabled } : c));
          setSelectedConversation(prev => prev && prev.id === conversationId ? { ...prev, bot_enabled: enabled } : prev);
        })
        .catch(e => {
          console.error('Erro ao alternar o bot da conversa:', e);
          alert('Não foi possível alternar o bot dessa conversa.');
        })
    );
  }, [runGuardedAction]);

  const handleChangeSidebarView = useCallback((view) => {
    setSidebarView(view);
    if (view === 'team' && internalChats.length === 0) {
      apiService.getInternalChats().then(setInternalChats);
    }
  }, [internalChats.length]);

  const handleSelectInternalChat = useCallback((chat) => {
    setSelectedInternalChat(chat);
    setInternalTyping(null);
    setShowInternalContactInfo(false);
    setShowInternalGroupManager(false);
    setDetailTaskId(null);
    apiService.getInternalChatMessages(chat.id).then(setInternalMessages);
    apiService.getInternalTasks(chat.id).then(setInternalTasks);
    if (chat.unread_count > 0) {
      apiService.markInternalChatRead(chat.id).then(() => {
        setInternalChats(prev => prev.map(c => c.id === chat.id ? { ...c, unread_count: 0 } : c));
      });
    }
    const otherIds = (chat.participants || []).filter(p => p.id !== currentUserProfile?.id).map(p => p.id);
    if (otherIds.length > 0) {
      apiService.getInternalChatPresence(otherIds).then(presence => {
        setInternalPresence(prev => ({ ...prev, ...presence }));
      });
    }
  }, [currentUserProfile]);

  // Marca as tarefas da conversa como vistas — mesma chamada de quando a
  // faixa de tarefas é expandida (onTasksSeen), mas disparada também ao
  // ABRIR o detalhe de uma tarefa específica (card na timeline, faixa,
  // "Dados do contato/grupo" ou o painel global "Minhas tarefas"). Sem
  // isso, a bolinha vermelha de não-lida nunca some: só marcar quando
  // expande a faixa não cobre entrar direto pelo card ou pelo painel
  // global, os caminhos mais comuns de "ver a tarefa".
  const markConversationTasksSeen = useCallback((conversationId) => {
    apiService.markTasksViewed(conversationId).then(() => {
      setInternalChats(prev => prev.map(c => c.id === conversationId ? { ...c, unread_tasks_count: 0 } : c));
      refreshMyTasks();
    });
  }, [refreshMyTasks]);

  const handleOpenTaskDetail = useCallback((taskId) => {
    setDetailTaskId(taskId);
    if (selectedInternalChat) markConversationTasksSeen(selectedInternalChat.id);
  }, [selectedInternalChat, markConversationTasksSeen]);

  // Abrir detalhe a partir da faixa de tarefas de uma conversa de CLIENTE —
  // sem o conceito de "vista"/badge de não-lida que markConversationTasksSeen
  // trata (isso é só pra chat interno, ver is_unread sempre false pra
  // tarefa de cliente em list_my_tasks).
  const handleOpenCustomerTaskDetail = useCallback((taskId) => {
    setDetailTaskId(taskId);
  }, []);

  // Clique numa tarefa do painel global "Minhas tarefas" (ou no popup de
  // lembrete, ver TaskReminderModal) — navega pra onde a tarefa vive e abre
  // o detalhe: chat interno, conversa de cliente, ou nenhum lugar (pessoal).
  // detailTask (useMemo mais abaixo) só populada depois que
  // internalTasks/customerConversationTasks recarregar pra essa conversa
  // (handleSelectInternalChat/handleSelectConversation já disparam isso) —
  // TaskDetailModal só renderiza quando detailTask existir, então o pior
  // caso é um instante sem o modal até a resposta chegar, não um erro.
  const handleOpenTaskFromPanel = useCallback((task) => {
    if (task.conversation_id) {
      const chat = internalChats.find(c => c.id === task.conversation_id);
      if (!chat) return;
      setSidebarView('team');
      handleSelectInternalChat(chat);
      setDetailTaskId(task.id);
      setShowMyTasksPanel(false);
      markConversationTasksSeen(chat.id);
      return;
    }
    if (task.customer_conversation_id) {
      const conv = conversations.find(c => c.id === task.customer_conversation_id);
      if (conv) {
        setSidebarView('clients');
        handleSelectConversation(conv);
      }
      setDetailTaskId(task.id);
      setShowMyTasksPanel(false);
      return;
    }
    // Pessoal — sem conversa nenhuma pra trocar, só abre o detalhe direto.
    setDetailTaskId(task.id);
    setShowMyTasksPanel(false);
  }, [internalChats, conversations, handleSelectInternalChat, handleSelectConversation, markConversationTasksSeen]);

  const handleInternalTyping = useCallback(() => {
    if (!selectedInternalChat) return;
    wsService.emit('typing', { conversation_id: selectedInternalChat.id });
  }, [selectedInternalChat]);

  const handleChangeMyPresenceStatus = useCallback((status) => {
    const myId = currentUserProfileRef.current?.id;
    if (!myId) return;
    setInternalPresence(prev => ({ ...prev, [myId]: { status, last_seen_at: null } }));
    apiService.setMyPresenceStatus(status).catch(err => {
      console.error('Erro ao atualizar status:', err);
    });
  }, []);

  // Atualiza a prévia da lista (Sidebar → aba Equipe) com a última mensagem
  // enviada/editada/apagada — mesmo formato que _conversation_brief devolve.
  const touchInternalChatPreview = useCallback((conversationId, msgData) => {
    setInternalChats(prev => prev.map(c => c.id === conversationId
      ? { ...c, last_message: { text: msgData.text, message_type: msgData.message_type, sender_id: msgData.sender_id, created_at: msgData.created_at } }
      : c));
  }, []);

  const handleSendInternalMessage = useCallback((text, replyToId) => {
    if (!selectedInternalChat) return;
    apiService.sendInternalChatMessage(selectedInternalChat.id, text, replyToId)
      .then(res => {
        if (!res?.data) return;
        // O eco via WebSocket (mesma mensagem, broadcast pra todos os
        // participantes incluindo quem mandou) pode chegar antes desta
        // resposta HTTP — sem checar se o id já está na lista, a mensagem
        // duplicava na tela até recarregar a página.
        setInternalMessages(prev => (prev.some(m => m.id === res.data.id) ? prev : [...prev, res.data]));
        touchInternalChatPreview(selectedInternalChat.id, res.data);
      })
      .catch(e => {
        console.error('Erro ao enviar mensagem interna:', e);
        alert('Não foi possível enviar a mensagem.');
      });
  }, [selectedInternalChat, touchInternalChatPreview]);

  const handleSendInternalMedia = useCallback((file, messageType, caption, replyToId) => {
    if (!selectedInternalChat) return;
    apiService.sendInternalChatMedia(selectedInternalChat.id, file, messageType, caption, replyToId)
      .then(res => {
        if (!res?.data) return;
        setInternalMessages(prev => (prev.some(m => m.id === res.data.id) ? prev : [...prev, res.data]));
        touchInternalChatPreview(selectedInternalChat.id, res.data);
      })
      .catch(e => {
        console.error('Erro ao enviar mídia interna:', e);
        alert(e.response?.data?.detail || 'Não foi possível enviar o arquivo.');
      });
  }, [selectedInternalChat, touchInternalChatPreview]);

  const handleEditInternalMessage = useCallback((messageId, text) => {
    if (!selectedInternalChat) return;
    apiService.editInternalChatMessage(selectedInternalChat.id, messageId, text)
      .then(res => {
        if (!res?.data) return;
        setInternalMessages(prev => prev.map(m => m.id === messageId ? { ...m, text: res.data.text, is_edited: true } : m));
      })
      .catch(() => alert('Não foi possível editar a mensagem.'));
  }, [selectedInternalChat]);

  const handleDeleteInternalMessage = useCallback((messageId) => {
    if (!selectedInternalChat) return;
    apiService.deleteInternalChatMessage(selectedInternalChat.id, messageId)
      .then(() => {
        setInternalMessages(prev => prev.map(m => m.id === messageId ? { ...m, is_deleted: true, text: 'Mensagem apagada', media_url: null } : m));
      })
      .catch(() => alert('Não foi possível apagar a mensagem.'));
  }, [selectedInternalChat]);

  const handleReactInternalMessage = useCallback((messageId, emoji) => {
    if (!selectedInternalChat) return;
    apiService.reactInternalChatMessage(selectedInternalChat.id, messageId, emoji)
      .then(res => {
        if (!res?.data) return;
        const myReaction = (res.data.reactions.find(r => r.user_ids.includes(currentUserProfile?.id)) || {}).emoji || null;
        setInternalMessages(prev => prev.map(m => m.id === messageId ? { ...m, reactions: res.data.reactions, my_reaction: myReaction } : m));
      })
      .catch(() => {});
  }, [selectedInternalChat, currentUserProfile]);

  const handleStarInternalMessage = useCallback((messageId, starred) => {
    if (!selectedInternalChat) return;
    apiService.starInternalChatMessage(selectedInternalChat.id, messageId, starred)
      .then(() => setInternalMessages(prev => prev.map(m => m.id === messageId ? { ...m, is_starred: starred } : m)))
      .catch(() => {});
  }, [selectedInternalChat]);

  const handlePinInternalMessage = useCallback((messageId, pinned) => {
    if (!selectedInternalChat) return;
    apiService.pinInternalChatMessage(selectedInternalChat.id, messageId, pinned)
      .then(() => setInternalMessages(prev => prev.map(m => m.id === messageId ? { ...m, is_pinned: pinned } : m)))
      .catch(() => {});
  }, [selectedInternalChat]);

  // Cria a tarefa (POST já cria o card na timeline junto) numa conversa
  // qualquer — não precisa ser a aberta agora. Usada pelo composer do
  // InternalChatArea E por handleCreateGlobalTask abaixo quando "+ Nova" em
  // "Minhas tarefas" delegou pra outra pessoa (get-or-create DM com ela
  // antes de chamar aqui). Só atualiza internalMessages/internalTasks
  // (estado da conversa ABERTA) se for essa mesma conversa; o resto (badge/
  // contadores de internalChats, myTasks) chega sozinho pelo eco do próprio
  // websocket (stableInternalChatMessage já recarrega os dois quando
  // message_type é "task", inclusive pra quem criou). Retorna a promise pro
  // TaskModal poder aguardar/mostrar erro antes de fechar.
  const handleCreateTaskInConversation = useCallback((payload, conversationId) => {
    if (!conversationId) return Promise.reject(new Error('Nenhuma conversa selecionada'));
    return apiService.createInternalTask(conversationId, payload).then(res => {
      if (!res?.data) return;
      if (selectedInternalChatIdRef.current === conversationId) {
        setInternalMessages(prev => (prev.some(m => m.id === res.data.id) ? prev : [...prev, res.data]));
        if (res.data.task) setInternalTasks(prev => [...prev, res.data.task]);
      }
      touchInternalChatPreview(conversationId, res.data);
    });
  }, [touchInternalChatPreview]);

  const handleCreateInternalTask = useCallback((payload) => {
    if (!selectedInternalChat) return Promise.reject(new Error('Nenhuma conversa selecionada'));
    return handleCreateTaskInConversation(payload, selectedInternalChat.id);
  }, [selectedInternalChat, handleCreateTaskInConversation]);

  // "+ Nova" no painel global "Minhas tarefas" — abre direto em modo
  // pessoal (standalone), sem nenhuma conversa envolvida (ver TaskModal).
  const handleOpenGlobalTaskModal = useCallback(() => {
    setShowGlobalTaskModal(true);
    setShowMyTasksPanel(false);
  }, []);

  // Cria tarefa pessoal OU vinculada a conversa de cliente (customerConversationId
  // já vem embutido no payload pelo próprio TaskModal quando standalone) —
  // nunca gera card/mensagem em timeline nenhuma, ver create_standalone_task.
  // O próprio backend já faz o broadcast (_broadcast_task) que chega de volta
  // pra quem criou via stableInternalTaskUpdated — por isso os appends locais
  // abaixo checam se o id já existe antes de inserir (senão duplica: o
  // eco do websocket pode chegar antes da promise desta chamada resolver).
  const handleCreateStandaloneTask = useCallback((payload) => {
    return apiService.createStandaloneTask(payload).then(res => res?.data);
  }, []);

  // "+ Nova" em "Minhas tarefas" — pedido explícito 2026-09-23: só a tarefa
  // que fico PRA MIM MESMO não deve vincular a chat nenhum (polui a DM
  // "Você mesmo" à toa). Delegar pra outro colega continua indo pro chat
  // interno com essa pessoa, como sempre foi — ela precisa receber o
  // aviso/card na conversa, não só aparecer some no "Minhas tarefas" dela.
  const handleCreateGlobalTask = useCallback((payload) => {
    const myId = currentUserProfile?.id;
    const isForSomeoneElse = payload.assignedTo && payload.assignedTo !== myId;
    if (!isForSomeoneElse) {
      return handleCreateStandaloneTask(payload).then(task => {
        if (task) setMyTasks(prev => prev.some(t => t.id === task.id) ? prev : [...prev, task]);
        setShowMyTasksPanel(true);
      });
    }
    return apiService.getOrCreateInternalDM(payload.assignedTo).then(res => {
      if (!res?.data) throw new Error('Não foi possível abrir a conversa com essa pessoa.');
      setInternalChats(prev => prev.some(c => c.id === res.data.id) ? prev : [res.data, ...prev]);
      return handleCreateTaskInConversation(payload, res.data.id);
    }).then(() => {
      refreshMyTasks();
      setShowMyTasksPanel(true);
    });
  }, [currentUserProfile, handleCreateStandaloneTask, handleCreateTaskInConversation, refreshMyTasks]);

  const handleCreateCustomerTask = useCallback((payload) => {
    return handleCreateStandaloneTask(payload).then(task => {
      if (task) setCustomerConversationTasks(prev => prev.some(t => t.id === task.id) ? prev : [...prev, task]);
    });
  }, [handleCreateStandaloneTask]);

  // Aplica uma InternalTask atualizada (vinda de qualquer PATCH/subtask/anexo,
  // ou do evento internal_task_updated de outra aba/pessoa) nos dois lugares
  // que guardam uma cópia dela: a lista do painel lateral (internalTasks) e o
  // card embutido na mensagem correspondente na timeline (internalMessages).
  const applyTaskUpdate = useCallback((task) => {
    if (!task) return;
    setInternalTasks(prev => prev.map(t => t.id === task.id ? task : t));
    setInternalMessages(prev => prev.map(m => (m.task && m.task.id === task.id) ? { ...m, task } : m));
    // As mesmas ações (pausar/cancelar/aprovar/concluir/etc, ver handlers
    // abaixo) valem tanto pra tarefa de chat interno quanto pessoal/de
    // conversa de cliente — os dois estados abaixo só têm efeito se a
    // tarefa realmente estiver neles (.map em array sem o id é um no-op).
    setCustomerConversationTasks(prev => prev.map(t => t.id === task.id ? task : t));
    setMyTasks(prev => prev.map(t => t.id === task.id ? { ...task, conversation_name: t.conversation_name, conversation_is_group: t.conversation_is_group, is_unread: t.is_unread } : t));
  }, []);

  // Marca feita/reabre a partir do card compacto (checkbox na timeline ou na
  // lista do painel) — TaskDetailModal usa handleUpdateTaskDetail (mais
  // genérico) pra isso e pros outros campos, esta função fica só pro atalho
  // do checkbox fora do modal.
  const handleToggleInternalTask = useCallback((taskId, status) => {
    apiService.updateInternalTaskStatus(taskId, status)
      .then(res => applyTaskUpdate(res?.data))
      .catch(e => alert(e.response?.data?.detail || 'Não foi possível atualizar a tarefa.'));
  }, [applyTaskUpdate]);

  // Aprovar a conclusão de uma tarefa principal — só quem criou (backend
  // reforça, isto aqui só evita a viagem pro servidor pra quem não pode).
  const handleApproveTask = useCallback((taskId) => {
    runGuardedAction(`task-approve-${taskId}`, () =>
      apiService.approveInternalTask(taskId)
        .then(res => applyTaskUpdate(res?.data))
        .catch(e => alert(e.response?.data?.detail || 'Não foi possível aprovar a tarefa.'))
    );
  }, [applyTaskUpdate, runGuardedAction]);

  // Reprovar a conclusão — desmarca a tarefa (volta pra pending) pra quem é
  // responsável concluir de novo corretamente. Só quem criou (backend reforça).
  const handleRejectTask = useCallback((taskId) => {
    runGuardedAction(`task-reject-${taskId}`, () =>
      apiService.rejectInternalTask(taskId)
        .then(res => applyTaskUpdate(res?.data))
        .catch(e => alert(e.response?.data?.detail || 'Não foi possível reprovar a tarefa.'))
    );
  }, [applyTaskUpdate, runGuardedAction]);

  // Pausar exige justificativa (pedido explícito) — só abre o modal aqui;
  // quem chama a API de fato é handleConfirmPauseTask, no "Pausar" do modal.
  const [pausingTaskId, setPausingTaskId] = useState(null);
  const handleConfirmPauseTask = useCallback((reason, reminderAt) => {
    if (!pausingTaskId) return Promise.resolve();
    return apiService.pauseInternalTask(pausingTaskId, reason, reminderAt)
      .then(res => { applyTaskUpdate(res?.data); setPausingTaskId(null); })
      .catch(e => { alert(e.response?.data?.detail || 'Não foi possível pausar a tarefa.'); throw e; });
  }, [pausingTaskId, applyTaskUpdate]);

  // Retomar não exige justificativa (só pausar exige) — chamada direta,
  // mesmo padrão de aprovar/reprovar.
  const handleResumeTask = useCallback((taskId) => {
    runGuardedAction(`task-resume-${taskId}`, () =>
      apiService.resumeInternalTask(taskId)
        .then(res => applyTaskUpdate(res?.data))
        .catch(e => alert(e.response?.data?.detail || 'Não foi possível retomar a tarefa.'))
    );
  }, [applyTaskUpdate, runGuardedAction]);

  // Cancelar exige justificativa (mesmo padrão de pausar) — só abre o modal
  // aqui; quem chama a API de fato é handleConfirmCancelTask, no "Cancelar
  // tarefa" do modal. Reativar (uncancel) não exige, mesmo padrão de retomar.
  const [cancellingTaskId, setCancellingTaskId] = useState(null);
  const handleConfirmCancelTask = useCallback((reason) => {
    if (!cancellingTaskId) return Promise.resolve();
    return apiService.cancelInternalTask(cancellingTaskId, reason)
      .then(res => { applyTaskUpdate(res?.data); setCancellingTaskId(null); })
      .catch(e => { alert(e.response?.data?.detail || 'Não foi possível cancelar a tarefa.'); throw e; });
  }, [cancellingTaskId, applyTaskUpdate]);

  const handleUncancelTask = useCallback((taskId) => {
    runGuardedAction(`task-uncancel-${taskId}`, () =>
      apiService.uncancelInternalTask(taskId)
        .then(res => applyTaskUpdate(res?.data))
        .catch(e => alert(e.response?.data?.detail || 'Não foi possível reativar a tarefa.'))
    );
  }, [applyTaskUpdate, runGuardedAction]);

  // Estado do TaskDetailModal — guarda só o id, não uma cópia da tarefa: o
  // objeto exibido é sempre derivado de internalTasks (useMemo abaixo), então
  // qualquer PATCH/evento websocket que passe por applyTaskUpdate já reflete
  // no modal aberto, sem precisar de um segundo caminho de sincronização.
  const [detailTaskId, setDetailTaskId] = useState(null);
  const detailTask = useMemo(
    () => internalTasks.find(t => t.id === detailTaskId)
      || customerConversationTasks.find(t => t.id === detailTaskId)
      || myTasks.find(t => t.id === detailTaskId)
      || null,
    [internalTasks, customerConversationTasks, myTasks, detailTaskId]
  );

  const handleUpdateTaskDetail = useCallback((patch) => {
    if (!detailTaskId) return;
    apiService.updateInternalTask(detailTaskId, patch)
      .then(res => applyTaskUpdate(res?.data))
      .catch(e => alert(e.response?.data?.detail || 'Não foi possível atualizar a tarefa.'));
  }, [detailTaskId, applyTaskUpdate]);

  const handleAddTaskSubtask = useCallback((title) => {
    if (!detailTaskId) return;
    apiService.createTaskSubtask(detailTaskId, title)
      .then(res => applyTaskUpdate(res?.data))
      .catch(() => alert('Não foi possível adicionar o item.'));
  }, [detailTaskId, applyTaskUpdate]);

  const handleToggleTaskSubtask = useCallback((subtaskId, isDone) => {
    if (!detailTaskId) return;
    apiService.updateTaskSubtask(detailTaskId, subtaskId, { is_done: isDone })
      .then(res => applyTaskUpdate(res?.data))
      .catch(e => alert(e.response?.data?.detail || 'Não foi possível atualizar o item.'));
  }, [detailTaskId, applyTaskUpdate]);

  const handleDeleteTaskSubtask = useCallback((subtaskId) => {
    if (!detailTaskId) return;
    apiService.deleteTaskSubtask(detailTaskId, subtaskId)
      .then(res => applyTaskUpdate(res?.data))
      .catch(() => alert('Não foi possível remover o item.'));
  }, [detailTaskId, applyTaskUpdate]);

  const handleAddTaskAttachment = useCallback((file) => {
    if (!detailTaskId) return Promise.resolve();
    return apiService.addTaskAttachment(detailTaskId, file)
      .then(res => applyTaskUpdate(res?.data))
      .catch(() => alert('Não foi possível anexar o arquivo.'));
  }, [detailTaskId, applyTaskUpdate]);

  const handleDeleteTaskAttachment = useCallback((attachmentId) => {
    if (!detailTaskId) return;
    apiService.deleteTaskAttachment(detailTaskId, attachmentId)
      .then(res => applyTaskUpdate(res?.data))
      .catch(() => alert('Não foi possível remover o anexo.'));
  }, [detailTaskId, applyTaskUpdate]);

  const handleForwardInternalMessage = useCallback((messageId, targetConversationIds) => {
    if (!selectedInternalChat) return;
    apiService.forwardInternalChatMessage(selectedInternalChat.id, messageId, targetConversationIds)
      .then(res => {
        (res?.data || []).forEach(msgData => touchInternalChatPreview(msgData.conversation_id, msgData));
        alert('Mensagem encaminhada.');
      })
      .catch(() => alert('Não foi possível encaminhar a mensagem.'));
  }, [selectedInternalChat, touchInternalChatPreview]);

  // Encaminha uma mensagem do chat interno pra conversa(s) de cliente — não
  // depende de selectedInternalChat (a mensagem já tem tudo que precisa).
  const handleForwardInternalMessageToWhatsApp = useCallback((messageId, targetWaConversationIds) => {
    apiService.forwardInternalMessageToWhatsApp(messageId, targetWaConversationIds)
      .then(res => {
        const failed = (res?.data || []).filter(r => !r.success);
        if (failed.length > 0) {
          alert(`Falha ao encaminhar para ${failed.length} conversa(s): ${failed.map(f => f.error).join('; ')}`);
        } else {
          alert('Mensagem encaminhada para o(s) cliente(s).');
        }
      })
      .catch(e => alert(e.response?.data?.detail || 'Não foi possível encaminhar para o WhatsApp.'));
  }, []);

  // Card de "encaminhado do cliente X" no chat interno — clicar abre a
  // conversa correspondente no lado WhatsApp.
  const handleOpenWhatsAppConversationFromInternal = useCallback((conversationId) => {
    if (!conversationId) return;
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv) {
      alert('Conversa do cliente não encontrada (pode ter sido removida, ou pertence a uma conta diferente da selecionada agora).');
      return;
    }
    setSidebarView('clients');
    handleSelectConversation(conv);
  }, [conversations, handleSelectConversation]);

  // Mescla campos públicos (nome/foto/participantes) vindos do backend por
  // cima do que já existe localmente — preserva unread_count (que é só meu,
  // o backend não manda) e recalcula my_is_admin a partir da lista nova de
  // participantes (pode ter mudado pra mim também, ex: fui promovido/rebaixado).
  const mergeInternalGroupUpdate = useCallback((data) => {
    const myRow = (data.participants || []).find(p => p.id === currentUserProfile?.id);
    const patch = { ...data, my_is_admin: !!myRow?.is_admin };
    setInternalChats(prev => prev.map(c => c.id === data.id ? { ...c, ...patch } : c));
    setSelectedInternalChat(prev => (prev && prev.id === data.id) ? { ...prev, ...patch } : prev);
  }, [currentUserProfile]);

  const handleLeftInternalGroup = useCallback((conversationId) => {
    setInternalChats(prev => prev.filter(c => c.id !== conversationId));
    setSelectedInternalChat(prev => (prev && prev.id === conversationId) ? null : prev);
  }, []);

  const handleInternalChatCreated = useCallback((chat) => {
    setInternalChats(prev => prev.some(c => c.id === chat.id) ? prev : [chat, ...prev]);
    handleSelectInternalChat(chat);
  }, [handleSelectInternalChat]);

  // Abre (ou cria) a DM com uma pessoa específica e já seleciona ela —
  // usado pelo botão "Conversar" do preview de contato abaixo.
  const handleOpenInternalDM = useCallback((userId) => {
    if (!userId || userId === currentUserProfile?.id) return;
    apiService.getOrCreateInternalDM(userId)
      .then(res => {
        if (res?.data) handleInternalChatCreated(res.data);
      })
      .catch(e => alert('Não foi possível abrir a conversa: ' + (e?.response?.data?.detail || e.message)));
  }, [currentUserProfile, handleInternalChatCreated]);

  // Clicar num participante de grupo (lista de membros ou nome acima da
  // mensagem) mostra PRIMEIRO as informações da pessoa — igual ao WhatsApp,
  // que não pula direto pra DM — com "Conversar" como uma das opções ali
  // dentro (ver InternalContactInfoPanel.js em modo "member").
  const [previewMember, setPreviewMember] = useState(null);
  const handlePreviewMember = useCallback((member) => {
    if (!member || member.id === currentUserProfile?.id) return;
    setPreviewMember(member);
  }, [currentUserProfile]);
  const handleStartChatFromPreview = useCallback((userId) => {
    setPreviewMember(null);
    handleOpenInternalDM(userId);
  }, [handleOpenInternalDM]);

  const handleAddConversationTag = useCallback((conversationId, tagId) => {
    apiService.addConversationTag(conversationId, tagId)
      .then(res => {
        const tags = res?.data?.tags ?? [];
        setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, tags } : c));
        setSelectedConversation(prev => prev && prev.id === conversationId ? { ...prev, tags } : prev);
      })
      .catch(e => console.error('Erro ao aplicar etiqueta:', e));
  }, []);

  const handleRemoveConversationTag = useCallback((conversationId, tagId) => {
    apiService.removeConversationTag(conversationId, tagId)
      .then(res => {
        const tags = res?.data?.tags ?? [];
        setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, tags } : c));
        setSelectedConversation(prev => prev && prev.id === conversationId ? { ...prev, tags } : prev);
      })
      .catch(e => console.error('Erro ao remover etiqueta:', e));
  }, []);

  const handleCreateTag = useCallback((name, color) => {
    apiService.createTag({ name, color })
      .then(res => { if (res?.data) setTagCatalog(prev => [...prev, res.data]); })
      .catch(e => alert(e.response?.data?.detail || 'Não foi possível criar a etiqueta.'));
  }, []);

  const handleSendInternalNote = useCallback((conversationId, text) => {
    apiService.createNote(conversationId, text)
      .then(res => {
        if (res?.data && selectedConversationRef.current?.id === conversationId) {
          setMessages(prev => (prev.some(m => m.id != null && m.id === res.data.id) ? prev : [...prev, res.data]));
        }
      })
      .catch(e => {
        console.error('Erro ao enviar nota interna:', e);
        alert('Não foi possível enviar a nota interna.');
      });
  }, []);

  // Fixar Conversa: flag própria do app (Conversation.is_pinned), não o pin
  // nativo do protocolo WhatsApp — esse aqui funciona pra qualquer provider
  // e pra grupo igual a individual, e é o que a Sidebar usa pra ordenar/
  // mostrar o ícone. Antes disso só chamava baileysApi.pinChat (pin nativo,
  // limitado a 3 chats pelo próprio WhatsApp) e nunca persistia no banco —
  // a Sidebar nunca refletia nada e o próprio menu ficava com o texto
  // "Fixar"/"Desafixar" desatualizado até trocar de conversa e voltar.
  const handlePinChat = useCallback(() => {
    if (!selectedConversation) return;
    const pinned = !selectedConversation.is_pinned;
    apiService.pinConversation(selectedConversation.id, pinned)
      .then(() => {
        setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, is_pinned: pinned } : c));
        setSelectedConversation(prev => prev ? { ...prev, is_pinned: pinned } : prev);
      })
      .catch(e => alert('Erro ao fixar conversa: ' + (e?.response?.data?.detail || e.message)));
  }, [selectedConversation]);

  const handlePinInternalChat = useCallback(() => {
    if (!selectedInternalChat) return;
    const pinned = !selectedInternalChat.is_pinned;
    apiService.pinInternalChat(selectedInternalChat.id, pinned)
      .then(() => {
        setInternalChats(prev => prev.map(c => c.id === selectedInternalChat.id ? { ...c, is_pinned: pinned } : c));
        setSelectedInternalChat(prev => prev ? { ...prev, is_pinned: pinned } : prev);
      })
      .catch(e => alert('Erro ao fixar conversa: ' + (e?.response?.data?.detail || e.message)));
  }, [selectedInternalChat]);

  // Favoritar/silenciar no chat interno são pessoais (InternalConversationParticipant),
  // não broadcast — só afetam a própria pessoa, nunca o resto do grupo/DM.
  const handleFavoriteInternalChat = useCallback(() => {
    if (!selectedInternalChat) return;
    const favorite = !selectedInternalChat.is_favorite;
    apiService.favoriteInternalChat(selectedInternalChat.id, favorite)
      .then(() => {
        setInternalChats(prev => prev.map(c => c.id === selectedInternalChat.id ? { ...c, is_favorite: favorite } : c));
        setSelectedInternalChat(prev => prev ? { ...prev, is_favorite: favorite } : prev);
      })
      .catch(e => alert('Erro ao favoritar conversa: ' + (e?.response?.data?.detail || e.message)));
  }, [selectedInternalChat]);

  const handleMuteInternalChat = useCallback(() => {
    if (!selectedInternalChat) return;
    const muted = !selectedInternalChat.is_muted;
    apiService.muteInternalChat(selectedInternalChat.id, muted)
      .then(() => {
        setInternalChats(prev => prev.map(c => c.id === selectedInternalChat.id ? { ...c, is_muted: muted } : c));
        setSelectedInternalChat(prev => prev ? { ...prev, is_muted: muted } : prev);
      })
      .catch(e => alert('Erro ao silenciar conversa: ' + (e?.response?.data?.detail || e.message)));
  }, [selectedInternalChat]);

  // Flag própria do app (Conversation.is_muted) — mesma correção já feita
  // em handlePinChat: antes chamava só o mute nativo do WhatsApp
  // (baileysApi.muteChat), que não persiste nada aqui pro nosso próprio uso
  // (sound/popup em desktopNotify.js), então "silenciar" nunca fazia efeito
  // de verdade na experiência dentro do app.
  const handleMuteChat = useCallback(() => {
    if (!selectedConversation) return;
    const muted = !selectedConversation.is_muted;
    apiService.muteConversation(selectedConversation.id, muted)
      .then(() => {
        setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, is_muted: muted } : c));
        setSelectedConversation(prev => prev ? { ...prev, is_muted: muted } : prev);
      })
      .catch(e => alert('Erro ao silenciar conversa: ' + (e?.response?.data?.detail || e.message)));
  }, [selectedConversation]);

  const handleArchiveChat = useCallback(() => {
    if (!selectedConversation) return;
    const jid = selectedConversation.contact?.wa_id;
    if (supportsAdvancedApi && jid) {
      const archive = !selectedConversation.is_archived;
      baileysApi.archiveChat(jid, archive, selectedAccountId)
        .then(() => setConversations(prev => prev.map(c =>
          c.id === selectedConversation.id ? { ...c, is_archived: archive } : c
        )))
        .catch(e => console.error('Erro ao arquivar chat:', e));
    } else {
      alert('Arquivar conversa não disponível para este tipo de conta.');
    }
  }, [selectedConversation, supportsAdvancedApi, selectedAccountId]);
  
  const handleMarkAsRead = useCallback(() => {
    const conversation = selectedConversationRef.current;
    if (!conversation || !(conversation.unread_count > 0)) return;
    apiService.markConversationRead(conversation.id)
      .then(() => {
        setConversations(prev =>
          prev.map(conv =>
            conv.id === conversation.id
              ? {...conv, unreadCount: 0, unread_count: 0}
              : conv
          )
        );
      })
      .catch(err => console.error('Erro ao marcar como lida:', err));
  }, []);

  const handleMarkAsUnread = useCallback(() => {
    const conversation = selectedConversationRef.current;
    if (!conversation) return;
    apiService.markConversationUnread(conversation.id)
      .then(() => {
        setConversations(prev =>
          prev.map(conv =>
            conv.id === conversation.id
              ? {...conv, unreadCount: Math.max(conv.unread_count || 0, 1), unread_count: Math.max(conv.unread_count || 0, 1)}
              : conv
          )
        );
      })
      .catch(err => console.error('Erro ao marcar como não lida:', err));
  }, []);

  const handleClearChat = useCallback(() => {
    if (!selectedConversation) return;
    const confirmed = window.confirm('Tem certeza que deseja limpar o histórico deste chat? Esta ação não pode ser desfeita.');
    if (!confirmed) return;
    apiService.clearConversationMessages(selectedConversation.id)
      .then(() => {
        setMessages([]);
        setConversations(prev => prev.map(c =>
          c.id === selectedConversation.id ? { ...c, lastMessage: '', unreadCount: 0 } : c
        ));
      })
      .catch(e => {
        console.error('Erro ao limpar chat:', e);
        alert('Erro ao limpar chat. Tente novamente.');
      });
  }, [selectedConversation]);
  
  const handleDeleteChat = useCallback(() => {
    if (!selectedConversation) return;
    const jid = selectedConversation.contact?.wa_id;
    const confirmed = window.confirm('Tem certeza que deseja excluir este chat permanentemente? Isso irá apagar a conversa no WhatsApp.');
    if (!confirmed) return;
    if (supportsAdvancedApi && jid) {
      baileysApi.deleteChat(jid, selectedAccountId)
        .then(() => {
           alert('Chat excluído com sucesso do WhatsApp.');
           setConversations(prev => prev.filter(c => c.id !== selectedConversation.id));
           setSelectedConversation(null);
        })
        .catch(e => {
           console.error('Erro ao excluir chat:', e);
           alert('Erro ao excluir chat.');
        });
    } else {
      alert('Excluir chat não disponível para este tipo de conta.');
    }
  }, [selectedConversation, supportsAdvancedApi, selectedAccountId]);

  
  const handleBlockContact = useCallback(() => {
    if (!selectedConversation) return;
    const jid = selectedConversation.contact?.wa_id;
    const confirmed = window.confirm('Tem certeza que deseja bloquear este contato?');
    if (!confirmed) return;
    if (supportsAdvancedApi && jid) {
      baileysApi.blockContact(jid, selectedAccountId)
        .then(() => alert('Contato bloqueado com sucesso.'))
        .catch(e => console.error('Erro ao bloquear:', e));
    } else {
      alert('Bloquear contato não disponível para este tipo de conta.');
    }
  }, [selectedConversation, supportsAdvancedApi, selectedAccountId]);
  
  const handleViewContact = useCallback(async () => {
    if (!selectedConversation) return;
    const isGroup = selectedConversation.is_group ||
      (selectedConversation.contact?.wa_id || '').includes('@g.us');
    if (supportsGroupManagement && isGroup) {
      setShowGroupManager(true);
    } else {
      setShowContactInfo(true);
    }
  }, [selectedConversation, supportsGroupManagement]);

  // Clique no header do chat — mesmo painel de "Ver Info do Contato" (grupos
  // continuam abrindo o GroupManager por onViewContact, aqui não distinguimos
  // porque o header já mostra o contato/grupo selecionado atual).
  const handleOpenContactInfo = useCallback(() => {
    handleViewContact();
  }, [handleViewContact]);

  // Abre o modal de info de um participante de grupo (foto + nome salvo/número).
  const handleOpenParticipantInfo = useCallback((message) => {
    const phoneNumber = message.from_number || message.participant_jid?.split('@')[0];
    if (!phoneNumber) return;
    setParticipantInfo({
      jid: message.participant_jid || `${phoneNumber}@s.whatsapp.net`,
      phoneNumber,
      name: message.contact_name || null,
      accountId: selectedConversation?.account_id || selectedAccountId,
    });
  }, [selectedConversation, selectedAccountId]);

  // "Abrir conversa" do modal de participante — cria/abre a conversa 1:1 sem
  // enviar nenhuma mensagem, e seleciona ela localmente. NÃO recarrega a lista
  // do servidor: uma conversa 1:1 sem nenhuma mensagem de propósito não aparece
  // lá (ver get_all_conversations_with_last_message) até a primeira mensagem
  // ser enviada — só assim ela some da ConversationList se o usuário só
  // espiou o contato e saiu sem mandar nada.
  const handleOpenParticipantChat = useCallback(async (phoneNumber, name = null) => {
    if (!phoneNumber) return;
    // Chamado também a partir de um número clicável dentro de uma mensagem
    // (ChatArea.js/InternalChatArea.js, ver utils/phoneLink.js) — nesse
    // caso a aba pode estar em "equipe"; sempre garante que a conversa
    // aberta apareça (é sempre uma conversa de cliente/WhatsApp).
    setSidebarView('clients');
    const accountId = selectedConversation?.account_id || selectedAccountId;
    try {
      const res = await apiService.openConversation(phoneNumber, accountId);
      const conversationId = res?.data?.conversation_id;
      setParticipantInfo(null);
      if (!conversationId) return;
      await handleSelectConversation({
        id: conversationId,
        account_id: accountId,
        is_group: false,
        contact: { wa_id: `${phoneNumber}@s.whatsapp.net`, phone_number: phoneNumber, name: name || null },
        name: name || null,
        fromNumber: phoneNumber,
      });
    } catch (e) {
      console.error('Erro ao abrir conversa do participante:', e);
      alert('Não foi possível abrir a conversa.');
    }
  }, [selectedConversation, selectedAccountId, handleSelectConversation]);

  const handleSearchInChat = useCallback(() => {
    // A busca é tratada internamente no ChatArea (handleToggleSearch)
    // Este handler fica vazio — ChatArea intercepta onSearchInChat antes de chegar aqui
  }, []);

  const handleViewMedia = useCallback(() => {
    if (!selectedConversation) return;
    setShowMediaGallery(true);
  }, [selectedConversation]);

  // BUG: nunca chamava nenhum backend — trocava só o state local, que
  // voltava a false no próximo reload/refresh da lista (Conversation nem
  // tinha coluna is_favorite). Mesma correção de handlePinChat/handleMuteChat.
  const handleToggleFavorite = useCallback(() => {
    if (!selectedConversation) return;
    const favorite = !selectedConversation.is_favorite;
    apiService.favoriteConversation(selectedConversation.id, favorite)
      .then(() => {
        setConversations(prev => prev.map(c => c.id === selectedConversation.id ? { ...c, is_favorite: favorite } : c));
        setSelectedConversation(prev => prev ? { ...prev, is_favorite: favorite } : prev);
      })
      .catch(e => alert('Erro ao favoritar conversa: ' + (e?.response?.data?.detail || e.message)));
  }, [selectedConversation]);

  // Edição manual do nome do contato no painel "Dados do contato" — grava por
  // conta (account_id da conversa aberta, ver ContactAccountName no backend),
  // já que Contact.wa_id é global na plataforma e o mesmo contato pode ter
  // nomes diferentes em contas diferentes da empresa. Reflete em todo lugar
  // que exibe o nome salvo (Sidebar, header do chat etc.) sem precisar
  // recarregar a lista de conversas.
  const handleUpdateContactName = useCallback(async (contactId, name) => {
    if (!contactId || !name) return;
    const res = await apiService.updateContactName(contactId, name, selectedConversationRef.current?.account_id);
    const savedName = res?.data?.saved_name ?? name;
    setConversations(prev => prev.map(c =>
      c.contact?.id === contactId ? { ...c, contact: { ...c.contact, saved_name: savedName } } : c
    ));
    setSelectedConversation(prev =>
      prev && prev.contact?.id === contactId ? { ...prev, contact: { ...prev.contact, saved_name: savedName } } : prev
    );
  }, []);

  // Marca/desmarca o contato como interno (colega/fornecedor falando pelo
  // número da empresa) — daí em diante o backend nunca mais encaminha essa
  // conversa pro bot/IA nem dispara aviso de fora-do-horário/CSAT, e ela sai
  // do cálculo de SLA (ver ContactInfoPanel.js e routes_attendance.py).
  const handleUpdateContactInternal = useCallback(async (contactId, isInternal) => {
    if (!contactId) return;
    const res = await apiService.updateContactInternal(contactId, isInternal);
    const applied = res?.data?.is_internal ?? isInternal;
    setConversations(prev => prev.map(c =>
      c.contact?.id === contactId ? { ...c, contact: { ...c.contact, is_internal: applied } } : c
    ));
    setSelectedConversation(prev =>
      prev && prev.contact?.id === contactId ? { ...prev, contact: { ...prev.contact, is_internal: applied } } : prev
    );
  }, []);

  // Observações internas do atendente sobre o cliente, editadas no painel
  // "Dados do contato" — mesmo padrão do nome/is_internal acima, grava em
  // Contact.notes (nunca sincronizado com o WhatsApp, só uso interno).
  const handleUpdateContactNotes = useCallback(async (contactId, notes) => {
    if (!contactId) return;
    const res = await apiService.updateContactNotes(contactId, notes);
    const applied = res?.data?.notes ?? notes;
    setConversations(prev => prev.map(c =>
      c.contact?.id === contactId ? { ...c, contact: { ...c.contact, notes: applied } } : c
    ));
    setSelectedConversation(prev =>
      prev && prev.contact?.id === contactId ? { ...prev, contact: { ...prev.contact, notes: applied } } : prev
    );
  }, []);

  // HANDLERS DO CONVERSATIONLIST MENU (Funções Globais)
  
  const handleNewChat = useCallback(() => {
    setShowNewChatModal(true);
  }, []);

  // Abre um chat "vazio" pro número digitado — sem mandar nenhuma mensagem
  // sozinho. Se já existe conversa com esse contato na conta atual, só
  // seleciona ela (evita abrir uma segunda conversa "fantasma" pro mesmo
  // número). Contato/conversa reais só nascem no banco quando a 1ª mensagem
  // for enviada de verdade — mesmo get-or-create que _get_contact_and_
  // conversation já faz no backend pra qualquer envio.
  const handleStartNewChat = useCallback((digits, chosenAccountId) => {
    setShowNewChatModal(false);
    const effectiveAccountId = chosenAccountId || selectedAccountId;
    const existing = conversations.find(c =>
      !c.is_group && (c.contact?.phone_number === digits || c.contact?.wa_id === digits) &&
      (!effectiveAccountId || c.account_id === effectiveAccountId)
    );
    if (existing) {
      handleSelectConversation(existing);
      return;
    }
    const placeholder = {
      id: `new_${digits}_${Date.now()}`,
      account_id: effectiveAccountId,
      is_group: false,
      status: 'open',
      assigned_to: null,
      tags: [],
      unread_count: 0,
      last_message_at: null,
      messages: [],
      contact: {
        id: null,
        wa_id: digits,
        name: null,
        saved_name: null,
        push_name: null,
        phone_number: digits,
        profile_picture_url: null,
        is_group: false,
      },
    };
    handleSelectConversation(placeholder);
  }, [conversations, selectedAccountId, handleSelectConversation]);
  
  const handleNewBroadcast = useCallback(() => {
    setShowBroadcastManager(true);
  }, []);
  
  const handleNewGroup = useCallback(() => {
    if (supportsAdvancedApi) {
      setShowGroupCreator(true);
    } else {
      alert('Criação de grupos não disponível para este tipo de conta.');
    }
  }, [supportsAdvancedApi]);

  const handleOpenProfilePanel = useCallback(() => {
    if (isBaileys) {
      setShowProfilePanel(true);
    } else {
      alert('Perfil da conta disponível apenas para contas Baileys no momento.');
    }
  }, [isBaileys]);
  
  const handleManageTemplates = useCallback(() => {
    console.log('Gerenciar templates');
    setShowTemplateSender(true);
  }, []);
  
  const handleSavedMessages = useCallback(() => {
    console.log('Mensagens salvas');
    // TODO: Implementar mensagens salvas
    alert('Funcionalidade "Mensagens Salvas" será implementada em breve!');
  }, []);
  
  const handleManageLabels = useCallback(() => {
    setSettingsInitialTab('atendimento');
    setShowSettings(true);
  }, []);

  const handleRefreshQuickReplies = useCallback(() => {
    apiService.getQuickReplies().then(setQuickReplies);
  }, []);

  const handleRefreshTagCatalog = useCallback(() => {
    apiService.getTags().then(setTagCatalog);
  }, []);

  const handleRefreshStatusColors = useCallback(() => {
    apiService.getStatusColors().then(colors => colors && setStatusColors(colors));
  }, []);
  
  const handleOpenReports = useCallback(() => {
    setShowReports(true);
  }, []);
    
  // WEBSOCKET
  
  // Sempre aponta para a versão mais recente de updateConversationListLocally
  wsUpdateConvRef.current = updateConversationListLocally;

  // Lógica de nova mensagem vive na ref — o socket chama a ref, não recria handler
  wsNewMessageHandlerRef.current = (data) => {
    try {
      const activeId = selectedConvIdRef.current;
      const currentConversation = selectedConversationRef.current;

      // Usa == (loose) para evitar falha por string vs number
      const matchById = data.conversation_id != null && activeId != null &&
        // eslint-disable-next-line eqeqeq
        data.conversation_id == activeId;
      const matchByWaId = data.from_number && data.from_number !== 'me' &&
        currentConversation?.contact?.wa_id &&
        data.from_number === currentConversation.contact.wa_id;

      const isActiveChat = !!(matchById || matchByWaId);

      console.log(
        `📬 WS new_message wamid=${data.wamid} conv=${data.conversation_id} activeId=${activeId} match=${isActiveChat}`
      );

      // Aviso de abertura de protocolo (chat do site): é registro, não mensagem
      // nova — entra na posição cronológica certa (chega depois da mensagem que
      // o abriu) e não mexe na sidebar nem conta como não lida.
      if ((data.wamid || '').startsWith('sysnotif_proto_')) {
        if (isActiveChat) {
          setMessages(prev => {
            if (prev.some(m => m.wamid === data.wamid)) return prev;
            const idx = prev.findIndex(m => (m.timestamp || 0) > (data.timestamp || 0));
            if (idx === -1) return [...prev, data];
            return [...prev.slice(0, idx), data, ...prev.slice(idx)];
          });
        }
        return;
      }

      if (isActiveChat) {
        setMessages(prev => {
          const dupIdx = prev.findIndex(m => m.wamid === data.wamid);
          if (dupIdx !== -1) {
            // Recuperação de mensagem que tinha ficado com "!" de falha (ver
            // ChatArea.js / handleRetryFailedMessage): o backend reprocessa
            // o MESMO wamid e reemite este evento com o conteúdo real. Sem
            // tratar esse caso à parte, a checagem de duplicata original
            // simplesmente descartava o update e a bolha de erro nunca saía
            // da tela mesmo depois do retry ter funcionado.
            if (prev[dupIdx].status === 'failed' && data.status !== 'failed') {
              const updated = [...prev];
              updated[dupIdx] = { ...prev[dupIdx], ...data };
              console.log('Mensagem recuperada (era failed):', data.wamid);
              return updated;
            }
            console.warn('Mensagem duplicada ignorada:', data.wamid);
            return prev;
          }
          // eslint-disable-next-line eqeqeq
          const tempIdx = prev.findIndex(m =>
            m.wamid?.startsWith('temp_') &&
            // eslint-disable-next-line eqeqeq
            m.conversation_id == data.conversation_id &&
            m.type === data.type
          );
          if (tempIdx !== -1) {
            const updated = [...prev];
            updated[tempIdx] = { ...prev[tempIdx], ...data, reply_to_wamid: prev[tempIdx].reply_to_wamid || data.reply_to_wamid };
            console.log('Mensagem temp substituída pelo dado real');
            return updated;
          }
          // Fallback pro caso inverso: a bolha otimista local já tinha um
          // wamid "real" (voltou no response.message_id do envio, não
          // "temp_...") só que num formato diferente do que este eco trouxe
          // — sem isso, duplicava mesmo com os dois checks acima.
          if (data.direction === 'outbound' || data.sender === 'me' || data.from_number === 'me') {
            const echoIdx = prev.findIndex(m =>
              m.direction === 'outbound' &&
              // eslint-disable-next-line eqeqeq
              m.conversation_id == data.conversation_id &&
              (m.message === data.message || m.message_text === data.message_text) &&
              Math.abs((m.timestamp || 0) - (data.timestamp || Date.now())) < 8000
            );
            if (echoIdx !== -1) {
              const updated = [...prev];
              updated[echoIdx] = { ...prev[echoIdx], ...data };
              console.log('Eco do próprio envio casado por conteúdo (wamid divergia), substituindo');
              return updated;
            }
          }
          console.log('Mensagem adicionada ao chat:', data.wamid);
          return [...prev, data];
        });
        wsUpdateConvRef.current?.({ ...data, unreadCount: 0, sender: 'contact' });
      } else {
        console.log('ℹMensagem para conversa não-ativa, atualizando sidebar');
        wsUpdateConvRef.current?.(data);
      }
    } catch (err) {
      console.error('Erro no handler de nova mensagem WS:', err);
    }
  };

  useEffect(() => {
    if (!isLoggedIn) return;

    console.log('Iniciando conexão WebSocket...');
    wsService.connect();

    // Handlers estáveis — registrados UMA vez, lógica sempre atual via refs
    const stableNewMessage = (data) => {
      try { wsNewMessageHandlerRef.current?.(data); }
      catch (err) { console.error('stableNewMessage error:', err); }
    };

    const stableReaction = (data) => {
      console.log('Reação recebida:', data);
      setMessages(prev =>
        prev.map(msg =>
          msg.wamid === data.wamid ? { ...msg, reaction_emoji: data.reaction_emoji } : msg
        )
      );
    };

    const stablePollUpdate = (data) => {
      console.log('Enquete atualizada:', data);
      setMessages(prev =>
        prev.map(msg =>
          msg.wamid === data.wamid ? { ...msg, message: data.message } : msg
        )
      );
    };

    // Cobre tanto edição real de mensagem quanto revogação (delete-for-
    // everyone) — o backend reusa o mesmo evento pros dois casos, já que do
    // ponto de vista do front é a mesma operação: "o texto desta mensagem
    // existente mudou". Antes não existia NENHUM listener pra isso — o
    // backend já emitia message_edit_update, mas a tela só refletia depois
    // de um reload.
    const stableMessageEdit = (data) => {
      console.log('Mensagem editada/revogada:', data);
      setMessages(prev =>
        prev.map(msg =>
          msg.wamid === data.wamid ? { ...msg, message: data.new_text } : msg
        )
      );
    };

    const stableStatus = (data) => {
      console.log('Status atualizado:', data);
      setMessages(prev =>
        prev.map(msg =>
          msg.wamid === data.wamid ? { ...msg, status: data.status } : msg
        )
      );
    };

    const stableTemplateStatus = (data) => {
      const eventType = data.event === 'approved' ? 'success' : 'warning';
      console.log(`[${eventType}] Template "${data.template_name}": ${data.event}`);
    };

    const stableAccountAlert = (data) => {
      console.log(`[warning] Alerta da conta: ${data.alert_type}`);
    };

    const stablePhoneQuality = (data) => {
      const color = data.current_quality === 'GREEN' ? 'success' :
                    data.current_quality === 'YELLOW' ? 'warning' : 'error';
      console.log(`[${color}] Qualidade do número: ${data.current_quality}`);
    };

    // Status/atribuição/tags de uma conversa mudaram (em qualquer aba/atendente)
    // — payload é parcial, só aplica os campos que vieram.
    const stableConversationMeta = (data) => {
      const { conversation_id, ...patch } = data;
      setConversations(prev => prev.map(c => c.id === conversation_id ? { ...c, ...patch } : c));
      setSelectedConversation(prev => prev && prev.id === conversation_id ? { ...prev, ...patch } : prev);
    };

    // Nota interna criada por outro atendente (ou por mim, em outra aba) —
    // só entra na timeline se for da conversa aberta agora.
    const stableInternalNote = (data) => {
      if (selectedConvIdRef.current !== data.conversation_id) return;
      setMessages(prev => (prev.some(m => m.id === data.id) ? prev : [...prev, data]));
    };

    // Mensagem de chat interno (DM/grupo entre usuários) — entregue só pra
    // quem participa (room 'user:{id}', ver identify() em websocket.js), não
    // é broadcast global como o resto do app.
    const stableInternalChatMessage = (data) => {
      setInternalChats(prev => prev.map(c => c.id === data.conversation_id
        ? {
            ...c,
            last_message: { text: data.text, message_type: data.message_type, sender_id: data.sender_id, created_at: data.created_at },
            unread_count: selectedInternalChatIdRef.current === data.conversation_id ? c.unread_count : (c.unread_count || 0) + 1,
          }
        : c));
      // Card de tarefa nova postado nesse mesmo evento (create_internal_task
      // não tem evento de socket próprio) — reconsulta os contadores reais
      // (open_tasks_count/unread_tasks_count por conversa, e a lista global
      // "Minhas tarefas") em vez de incrementar um contador local à parte —
      // assim o ícone fixo da Sidebar e o badge do rail ficam sempre certos,
      // mesmo se a tarefa nova não for atribuída/criada por mim.
      if (data.message_type === 'task') {
        apiService.getInternalChats().then(setInternalChats);
        apiService.getMyTasks().then(setMyTasks);
      }
      // Som + notificação desktop — nunca pra eco da própria mensagem
      // (is_mine, ver _format_internal_message no backend), nem se EU
      // (pessoal — InternalConversationParticipant, não afeta os outros)
      // silenciei essa conversa. O SOM toca sempre; só o POPUP é suprimido
      // se eu já estiver olhando pra essa conversa com a aba em foco agora
      // (ver mesmo comentário no handler de mensagem de WhatsApp acima,
      // updateConversationListLocally).
      const isMuted = internalChatsRef.current.find(c => c.id === data.conversation_id)?.is_muted;
      if (!data.is_mine && !isMuted) {
        notifyNewMessage({
          title: data.sender_name || 'Nova mensagem (Equipe)',
          body: data.message_type === 'task' ? data.text : (data.text || '📎 Mídia'),
          tag: `internal-chat-${data.conversation_id}`,
          popupSuppressed: selectedInternalChatIdRef.current === data.conversation_id && document.hasFocus(),
          icon: data.sender_photo_url,
        });
      }
      // Lembrete de tarefa pausada OU com prazo vencido
      // (task_pause_reminder_watchdog.py / task_due_reminder_watchdog.py) —
      // a notificação desktop acima já dispara, mas exige permissão do
      // navegador e passa despercebida com a aba minimizada/sem foco (e só
      // funciona com alguma aba aberta — o Web Push real, se inscrito, cobre
      // o resto, ver subscribeToPush). Pedido explícito: precisa de um popup
      // central que escureça o fundo e prenda o foco (não um toast de canto,
      // que é fácil de não notar) — por isso entra na fila
      // incondicionalmente (ignora silenciado/aba em foco, ao contrário do
      // resto desta função): é um lembrete que a tarefa gerou sozinha,
      // silenciar a conversa não deveria enterrar o aviso.
      if (data.task_event === 'pause_reminder' || data.task_event === 'due_reminder') {
        setTaskReminderQueue(prev => [...prev, { text: data.text, task: data.task, kind: data.task_event }]);
      }
      if (selectedInternalChatIdRef.current === data.conversation_id) {
        setInternalMessages(prev => (prev.some(m => m.id === data.id) ? prev : [...prev, data]));
        apiService.markInternalChatRead(data.conversation_id).catch(() => {});
      }
    };

    // Fui adicionado a uma DM/grupo novo — aparece na minha lista de Equipe.
    const stableInternalChatCreated = (data) => {
      setInternalChats(prev => prev.some(c => c.id === data.id) ? prev : [data, ...prev]);
    };

    const stableInternalChatEdited = (data) => {
      if (selectedInternalChatIdRef.current !== data.conversation_id) return;
      setInternalMessages(prev => prev.map(m => m.id === data.id ? { ...m, text: data.text, is_edited: data.is_edited } : m));
    };

    const stableInternalChatDeleted = (data) => {
      if (selectedInternalChatIdRef.current !== data.conversation_id) return;
      setInternalMessages(prev => prev.map(m => m.id === data.id ? { ...m, is_deleted: true, text: 'Mensagem apagada', media_url: null } : m));
    };

    const stableInternalChatReaction = (data) => {
      if (selectedInternalChatIdRef.current !== data.conversation_id) return;
      const myReaction = (data.reactions.find(r => r.user_ids.includes(currentUserProfileRef.current?.id)) || {}).emoji || null;
      setInternalMessages(prev => prev.map(m => m.id === data.message_id ? { ...m, reactions: data.reactions, my_reaction: myReaction } : m));
    };

    // Tarefa marcada feita/reaberta por qualquer participante (inclusive em
    // outra aba minha) — só aplica se for da conversa aberta agora, igual ao
    // resto dos eventos de chat interno.
    const stableInternalTaskUpdated = (data) => {
      // Contadores globais (ícone fixo de pendência na Sidebar, badge do
      // rail/painel "Minhas tarefas") precisam atualizar mesmo se a
      // atualização for de uma conversa que não é a que estou vendo agora
      // (ex: concluir uma tarefa numa outra conversa some com o ícone dela).
      // Cobre os 3 tipos de tarefa (interna/de cliente/pessoal) igual.
      apiService.getInternalChats().then(setInternalChats);
      apiService.getMyTasks().then(setMyTasks);
      if (data.conversation_id != null) {
        if (selectedInternalChatIdRef.current !== data.conversation_id) return;
        setInternalTasks(prev => prev.map(t => t.id === data.task.id ? data.task : t));
        setInternalMessages(prev => prev.map(m => (m.task && m.task.id === data.task.id) ? { ...m, task: data.task } : m));
      }
      // Tarefa de conversa de CLIENTE vem por broadcast_customer_task_updated
      // (global, sem participant_ids, ÚNICO caminho — inclusive criação, já
      // que não existe card de timeline pra avisar como no chat interno) —
      // atualiza/insere na faixa se for a conversa de cliente aberta agora.
      if (data.customer_conversation_id != null && selectedConversationRef.current?.id === data.customer_conversation_id) {
        setCustomerConversationTasks(prev => prev.some(t => t.id === data.task.id)
          ? prev.map(t => t.id === data.task.id ? data.task : t)
          : [...prev, data.task]);
      }
    };

    // Lembrete de tarefa PESSOAL ou vinculada a conversa de CLIENTE (sem
    // timeline de chat interno pra postar aviso, ver notify_task_reminder no
    // backend) — entrega direta, mesmo popup central de lembrete das
    // tarefas de chat interno (ver taskReminderQueue acima).
    const stableTaskReminder = (data) => {
      setTaskReminderQueue(prev => [...prev, { text: data.text, task: data.task, kind: data.kind }]);
    };

    const stableInternalChatPresence = (data) => {
      setInternalPresence(prev => ({ ...prev, [data.user_id]: { status: data.status, last_seen_at: data.last_seen_at } }));
    };

    // "Fulano está digitando" — some sozinho depois de 3s sem novo evento
    // (o backend não manda um "parou de digitar" explícito, é assim mesmo no WhatsApp real).
    const stableInternalChatTyping = (data) => {
      if (selectedInternalChatIdRef.current !== data.conversation_id) return;
      setInternalTyping(data);
      clearTimeout(internalTypingTimeoutRef.current);
      internalTypingTimeoutRef.current = setTimeout(() => setInternalTyping(null), 3000);
    };

    // Grupo mudou (nome/foto/admin/participantes) — mescla por cima do que já
    // existe localmente, preservando unread_count e recalculando my_is_admin
    // a partir da lista nova (pode ter mudado pra mim também).
    const stableInternalChatUpdated = (data) => {
      const myRow = (data.participants || []).find(p => p.id === currentUserProfileRef.current?.id);
      const patch = { ...data, my_is_admin: !!myRow?.is_admin };
      setInternalChats(prev => prev.map(c => c.id === data.id ? { ...c, ...patch } : c));
      setSelectedInternalChat(prev => (prev && prev.id === data.id) ? { ...prev, ...patch } : prev);
    };

    // Fui removido de um grupo (ou saí em outra aba) — some da minha lista.
    const stableInternalChatRemoved = (data) => {
      setInternalChats(prev => prev.filter(c => c.id !== data.conversation_id));
      setSelectedInternalChat(prev => (prev && prev.id === data.conversation_id) ? null : prev);
    };

    const stableProductQuestionUpdate = (data) => {
      setMessages(prev => prev.map(m => (m.wamid === data.wamid && m.interactive_payload)
        ? { ...m, interactive_payload: { ...m.interactive_payload, status: data.status, answered_by: data.answered_by, answered_via: data.answered_via, answer: data.answer, error: data.error } }
        : m));
    };

    wsService.on('new_message', stableNewMessage);
    wsService.on('product_question_update', stableProductQuestionUpdate);
    wsService.on('reaction_update', stableReaction);
    wsService.on('poll_update', stablePollUpdate);
    wsService.on('message_edit_update', stableMessageEdit);
    wsService.on('message_status', stableStatus);
    wsService.on('template_status', stableTemplateStatus);
    wsService.on('account_alert', stableAccountAlert);
    wsService.on('phone_quality_update', stablePhoneQuality);
    wsService.on('conversation_meta_update', stableConversationMeta);
    wsService.on('internal_note_created', stableInternalNote);
    wsService.on('internal_chat_message', stableInternalChatMessage);
    wsService.on('internal_chat_created', stableInternalChatCreated);
    wsService.on('internal_chat_message_edited', stableInternalChatEdited);
    wsService.on('internal_chat_message_deleted', stableInternalChatDeleted);
    wsService.on('internal_chat_reaction_updated', stableInternalChatReaction);
    wsService.on('internal_chat_presence', stableInternalChatPresence);
    wsService.on('internal_chat_typing', stableInternalChatTyping);
    wsService.on('internal_chat_updated', stableInternalChatUpdated);
    wsService.on('internal_chat_removed', stableInternalChatRemoved);
    wsService.on('internal_task_updated', stableInternalTaskUpdated);
    wsService.on('task_reminder', stableTaskReminder);

    return () => {
      wsService.off('new_message', stableNewMessage);
      wsService.off('product_question_update', stableProductQuestionUpdate);
      wsService.off('reaction_update', stableReaction);
      wsService.off('poll_update', stablePollUpdate);
      wsService.off('message_edit_update', stableMessageEdit);
      wsService.off('message_status', stableStatus);
      wsService.off('template_status', stableTemplateStatus);
      wsService.off('account_alert', stableAccountAlert);
      wsService.off('phone_quality_update', stablePhoneQuality);
      wsService.off('conversation_meta_update', stableConversationMeta);
      wsService.off('internal_note_created', stableInternalNote);
      wsService.off('internal_chat_message', stableInternalChatMessage);
      wsService.off('internal_chat_created', stableInternalChatCreated);
      wsService.off('internal_chat_message_edited', stableInternalChatEdited);
      wsService.off('internal_chat_message_deleted', stableInternalChatDeleted);
      wsService.off('internal_chat_reaction_updated', stableInternalChatReaction);
      wsService.off('internal_chat_presence', stableInternalChatPresence);
      wsService.off('internal_chat_typing', stableInternalChatTyping);
      wsService.off('internal_chat_updated', stableInternalChatUpdated);
      wsService.off('internal_chat_removed', stableInternalChatRemoved);
      wsService.off('internal_task_updated', stableInternalTaskUpdated);
      wsService.off('task_reminder', stableTaskReminder);
      clearTimeout(internalTypingTimeoutRef.current);
      wsService.disconnect();
    };
  }, [isLoggedIn]);
  
  // CARREGAR CONVERSAS INICIAL + ao trocar conta

  useEffect(() => {
    if (!isLoggedIn) return;

    console.log('Carregando conversas iniciais...');
    loadConversations();
  }, [loadConversations, isLoggedIn]);

  // Auto-selecionar conta ativa no carregamento inicial (cobre o caso de F5 com token salvo)
  // Também sincroniza selectedAccount quando selectedAccountId já existe mas o objeto está null
  useEffect(() => {
    if (!isLoggedIn) return;
    apiService.getAccounts()
      .then(accounts => {
        if (!selectedAccountId) {
          const active = accounts.find(a => a.is_active && a.is_authenticated) || accounts.find(a => a.is_active);
          if (active) {
            console.log(`Conta auto-selecionada (init): #${active.id} (${active.provider_type})`);
            setSelectedAccountId(active.id);
            setSelectedAccount(active);
          } else {
            console.warn('Nenhuma conta ativa. Cadastre em Configurações → Contas WA.');
          }
        } else if (!selectedAccount) {
          const acc = accounts.find(a => a.id === selectedAccountId);
          if (acc) {
            console.log(`selectedAccount sincronizado: #${acc.id} (${acc.provider_type})`);
            setSelectedAccount(acc);
          }
        }
      })
      .catch(e => console.warn('Falha ao carregar contas:', e));
  }, [isLoggedIn]); // eslint-disable-line react-hooks/exhaustive-deps
  
  // REFRESH ON FOCUS + PERIODIC FALLBACK

  useEffect(() => {
    if (!isLoggedIn) return;

    const onFocus = () => {
      console.log('Janela focada — atualizando conversas');
      loadConversations(selectedAccountId || null, { silent: true });
    };

    window.addEventListener('focus', onFocus);
    // Fallback: refresh a cada 30s caso algum evento WebSocket seja perdido
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadConversations(selectedAccountId || null, { silent: true });
      }
    }, 30000);

    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [isLoggedIn, selectedAccountId, loadConversations]);

  // HEALTH CHECK

  useEffect(() => {
    apiService.healthCheck()
      .then(data => {
        console.log('Backend conectado:', data);
      })
      .catch(error => {
        console.error('Erro ao conectar ao backend:', error);
        alert('⚠️ Erro ao conectar ao backend. Verifique se o servidor está rodando.');
      });
  }, []);
  
  const handleSelectAccount = useCallback((accountId, accounts = null) => {
    setSelectedAccountId(accountId);
    loadConversations(accountId);
    if (accounts) {
      const acc = accounts.find(a => a.id === accountId);
      if (acc) setSelectedAccount(acc);
    } else {
      apiService.getAccounts()
        .then(accs => {
          const acc = accs.find(a => a.id === accountId);
          if (acc) setSelectedAccount(acc);
        })
        .catch(() => {});
    }
  }, [loadConversations]);  
  
  // RENDERIZAÇÃO
  
  if (!isLoggedIn) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  // Botão do Painel Admin passa a abrir também pra quem NÃO é is_admin mas
  // tem alguma permissão admin_* liberada (antes era só is_admin, tudo ou
  // nada) — a visibilidade de cada aba dentro do painel é filtrada de novo
  // lá dentro, aqui é só "vale abrir o painel ou nem mostrar o botão".
  const canOpenAdminPanel = !!currentUserProfile?.is_admin || [
    'admin_dashboard', 'settings_users', 'admin_accounts',
    'admin_roles', 'admin_approvals', 'admin_system_config', 'settings_meta_app',
  ].some(k => currentUserProfile?.permissions?.[k] === true || currentUserProfile?.permissions?.[k] === 'require_approval');

  return (
    <div className="app-container">
      {toast && (
        <NotificationToast
          key={toast.key}
          type={toast.type}
          message={toast.message}
          duration={toast.duration}
          onClose={() => setToast(null)}
        />
      )}
      <IconRail
        isBaileys={isBaileys}
        isAdmin={canOpenAdminPanel}
        onOpenStatus={() => setShowStatusViewer(true)}
        onOpenMedia={() => setShowMediaGallery(true)}
        onOpenTasks={() => setShowMyTasksPanel(true)}
        myTasksUnreadCount={myTasks.filter(t => t.is_unread).length}
        onOpenProfile={handleOpenProfilePanel}
        onOpenSettings={handleOpenSettings}
        onOpenAdmin={() => setShowAdminPanel(true)}
        currentTheme={theme}
        toggleTheme={toggleTheme}
        myPhotoUrl={currentUserProfile?.photo_url}
        myFullName={currentUserProfile?.full_name}
        onOpenMyAccount={() => { setSettingsInitialTab('credentials'); setShowSettings(true); }}
      />

      {showAdminPanel ? (
        <AdminPanel
          onClose={() => setShowAdminPanel(false)}
          isAdmin={!!currentUserProfile?.is_admin}
          permissions={currentUserProfile?.permissions || {}}
        />
      ) : (
      <>
      <Sidebar
        conversations={conversations}
        selectedConversation={selectedConversation}
        onSelectConversation={handleSelectConversation}
        loading={conversationsLoading}
        selectedAccountId={selectedAccountId}
        onSelectAccount={handleSelectAccount}
        providerType={selectedAccount?.provider_type || null}
        currentUserId={currentUserProfile?.id || null}
        slaWaitMinutes={slaWaitMinutes}
        statusColors={statusColors}
        tagCatalog={tagCatalog}
        sidebarView={sidebarView}
        onChangeSidebarView={handleChangeSidebarView}
        internalChats={internalChats}
        selectedInternalChatId={selectedInternalChat?.id || null}
        onSelectInternalChat={handleSelectInternalChat}
        onStartNewInternalChat={() => setShowNewInternalChatModal(true)}
        internalPresence={internalPresence}
        myPresenceStatus={internalPresence[currentUserProfile?.id]?.status || 'online'}
        onChangeMyPresenceStatus={handleChangeMyPresenceStatus}
        // ConversationListMenu Props
        onOpenQRManager={() => setShowQRManager(true)}
        onOpenAnalytics={() => setShowAnalytics(true)}
        onOpenBusinessProfile={() => setShowBusinessProfile(true)}
        onNewChat={handleNewChat}
        onNewBroadcast={handleNewBroadcast}
        onNewGroup={handleNewGroup}
        onOpenProfilePanel={handleOpenProfilePanel}
        onManageTemplates={handleManageTemplates}
        onSavedMessages={handleSavedMessages}
        onManageLabels={handleManageLabels}
        onOpenReports={handleOpenReports}
        onOpenSettings={handleOpenSettings}
        onLogout={handleLogout}
        toggleTheme={toggleTheme}
        currentTheme={theme}
      />

      {sidebarView === 'team' ? (
      <InternalChatArea
        conversation={selectedInternalChat}
        messages={internalMessages}
        currentUserId={currentUserProfile?.id || null}
        internalChats={internalChats}
        conversations={conversations}
        onSendMessage={handleSendInternalMessage}
        onSendMedia={handleSendInternalMedia}
        onEditMessage={handleEditInternalMessage}
        onDeleteMessage={handleDeleteInternalMessage}
        onReactMessage={handleReactInternalMessage}
        onStarMessage={handleStarInternalMessage}
        onPinMessage={handlePinInternalMessage}
        onForwardMessage={handleForwardInternalMessage}
        onForwardMessageToWhatsApp={handleForwardInternalMessageToWhatsApp}
        onOpenWhatsAppConversation={handleOpenWhatsAppConversationFromInternal}
        onTyping={handleInternalTyping}
        typingUser={internalTyping?.conversation_id === selectedInternalChat?.id ? internalTyping : null}
        presence={selectedInternalChat && !selectedInternalChat.is_group
          ? internalPresence[selectedInternalChat.participants.find(p => p.id !== currentUserProfile?.id)?.id]
          : null}
        onOpenGroupManager={() => setShowInternalGroupManager(true)}
        onOpenContactInfo={() => setShowInternalContactInfo(true)}
        onTogglePin={handlePinInternalChat}
        onToggleFavorite={handleFavoriteInternalChat}
        onToggleMute={handleMuteInternalChat}
        onViewMedia={() => setShowMediaGallery(true)}
        onOpenMemberChat={handlePreviewMember}
        onOpenChatByPhone={(digits) => handleOpenParticipantChat(digits)}
        openSearchSignal={internalChatSearchSignal}
        onCreateTask={handleCreateInternalTask}
        onToggleTask={handleToggleInternalTask}
        onOpenTask={handleOpenTaskDetail}
        onApproveTask={handleApproveTask}
        onRejectTask={handleRejectTask}
        onPauseTask={setPausingTaskId}
        onResumeTask={handleResumeTask}
        onCancelTask={setCancellingTaskId}
        onUncancelTask={handleUncancelTask}
        tasks={internalTasks}
        currentTheme={theme}
        newTaskCount={internalChats.find(c => c.id === selectedInternalChat?.id)?.unread_tasks_count || 0}
        onTasksSeen={() => {
          if (!selectedInternalChat) return;
          apiService.markTasksViewed(selectedInternalChat.id).then(() => {
            setInternalChats(prev => prev.map(c => c.id === selectedInternalChat.id ? { ...c, unread_tasks_count: 0 } : c));
            refreshMyTasks();
          });
        }}
      />
      ) : showStatusViewer ? (
      <StatusViewer accountId={selectedAccountId} onClose={() => setShowStatusViewer(false)} />
      ) : (
      <ChatArea
        conversation={selectedConversation}
        messages={messages}
        onSendMessage={handleSendMessage}
        loading={messagesLoading}
        onLoadOlderMessages={handleLoadOlderMessages}
        hasMoreMessages={hasMoreMessages}
        loadingOlderMessages={loadingOlderMessages}
        providerType={selectedAccount?.provider_type || null}
        agents={agents}
        currentUserId={currentUserProfile?.id || null}
        onUpdateStatus={handleUpdateConversationStatus}
        csatEnabled={csatEnabled}
        onAssignConversation={handleAssignConversation}
        onToggleBot={handleToggleBot}
        isActionPending={isActionPending}
        tagCatalog={tagCatalog}
        onAddTag={handleAddConversationTag}
        onRemoveTag={handleRemoveConversationTag}
        onCreateTag={handleCreateTag}
        onSendNote={handleSendInternalNote}
        quickReplies={quickReplies}
        internalChats={internalChats}
        statusColors={statusColors}
        onOpenLocationSender={() => setShowLocationSender(true)} // FIX: Changed false to true
        // ChatAreaMenu Props
        onPinChat={handlePinChat}
        onMuteChat={handleMuteChat}
        onArchiveChat={handleArchiveChat}
        onMarkAsRead={handleMarkAsRead}
        onMarkAsUnread={handleMarkAsUnread}
        onClearChat={handleClearChat}
        onDeleteChat={handleDeleteChat}
        onBlockContact={handleBlockContact}
        onViewContact={handleViewContact}
        onSearchInChat={handleSearchInChat}
        onViewMedia={handleViewMedia}
        onToggleFavorite={handleToggleFavorite}
        onOpenContactInfo={handleOpenContactInfo}
        // AttachmentMenu Props (Mensagens)
        onSendButtons={sendButtons}
        onSendReaction={sendReaction}
        onRemoveReaction={removeReaction}
        onSendCtaUrl={sendCtaButton}
        onForwardMessage={handleForwardMessage}
        onEditMessage={handleEditMessage}
        onDeleteMessage={handleDeleteMessage}
        onPinMessage={handlePinMessage}
        onStarMessage={handleStarMessage}
        onRetryFailedMessage={handleRetryFailedMessage}
        onOpenCartBuilder={() => setShowCartBuilder(true)}
        onOpenFlowSender={() => setShowFlowSender(true)}
        onOpenTemplateSender={() => setShowTemplateSender(true)}
        onOpenContactSender={() => setShowContactSender(true)}
        onOpenListSender={() => setShowListSender(true)}
        onOpenProductSender={() => setShowProductSender(true)}
        onOpenProductListSender={() => setShowProductListSender(true)}
        onOpenCarouselSender={() => alert('Carrossel indisponível: a Cloud API só envia carrossel dentro de um template aprovado (componente CAROUSEL), não como mensagem avulsa. Ainda não há um template desse tipo configurado.')}
        onRequestLocation={() => alert('Solicitar Localização em breve')}
        onOpenPollSender={supportsAdvancedApi ? () => setShowPollSender(true) : null}
        // BUG (2026-09-03): travado em isBaileys, mas /api/baileys/profile/*
        // (usado pelo ParticipantInfoModal pra foto/recado) já é genérico —
        // funciona pra qualquer provider (confirmado ao vivo, contas
        // WPPConnect já chamam essa mesma rota pra avatar). Contas reais são
        // todas WPPConnect, então essa trava desligava tanto o clique no
        // remetente de mensagem de grupo quanto o clique no corpo de um
        // cartão de contato (vCard) compartilhado — igual GroupManager, que
        // já usa handleOpenParticipantInfo sem essa trava.
        onOpenParticipantInfo={handleOpenParticipantInfo}
        onOpenParticipantChat={handleOpenParticipantChat}
        currentTheme={theme}
        openSearchSignal={chatSearchSignal}
        tasks={customerConversationTasks}
        onCreateTask={handleCreateCustomerTask}
        onToggleTask={handleToggleInternalTask}
        onOpenTask={handleOpenCustomerTaskDetail}
        onApproveTask={handleApproveTask}
        onRejectTask={handleRejectTask}
        onPauseTask={setPausingTaskId}
        onResumeTask={handleResumeTask}
        onCancelTask={setCancellingTaskId}
        onUncancelTask={handleUncancelTask}
      />
      )}
      {sidebarView === 'team' && showInternalContactInfo && selectedInternalChat && !selectedInternalChat.is_group && (
        <InternalContactInfoPanel
          conversation={selectedInternalChat}
          currentUserId={currentUserProfile?.id || null}
          presence={internalPresence[selectedInternalChat.participants.find(p => p.id !== currentUserProfile?.id)?.id]}
          messages={internalMessages}
          tasks={internalTasks}
          onToggleTask={handleToggleInternalTask}
          onOpenTask={handleOpenTaskDetail}
          onStarMessage={handleStarInternalMessage}
          onPinMessage={handlePinInternalMessage}
          onClose={() => setShowInternalContactInfo(false)}
          onPinChat={handlePinInternalChat}
          onToggleFavorite={handleFavoriteInternalChat}
          onToggleMute={handleMuteInternalChat}
          onSearchInChat={() => setInternalChatSearchSignal(s => s + 1)}
          onViewMedia={() => setShowMediaGallery(true)}
        />
      )}
      {sidebarView === 'team' && previewMember && (
        <InternalContactInfoPanel
          member={previewMember}
          currentUserId={currentUserProfile?.id || null}
          presence={internalPresence[previewMember.id]}
          onClose={() => setPreviewMember(null)}
          onStartChat={handleStartChatFromPreview}
        />
      )}
      {sidebarView === 'team' && showInternalGroupManager && selectedInternalChat?.is_group && (
        <InternalGroupManager
          conversation={selectedInternalChat}
          currentUserId={currentUserProfile?.id || null}
          agents={agents}
          tasks={internalTasks}
          onToggleTask={handleToggleInternalTask}
          onOpenTask={handleOpenTaskDetail}
          onClose={() => setShowInternalGroupManager(false)}
          onGroupUpdated={mergeInternalGroupUpdate}
          onLeftGroup={handleLeftInternalGroup}
          messages={internalMessages}
          onPinMessage={handlePinInternalMessage}
          onOpenDirectChat={(member) => { setShowInternalGroupManager(false); handlePreviewMember(member); }}
        />
      )}
      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          conversation={detailTask.conversation_id ? selectedInternalChat : null}
          currentUserId={currentUserProfile?.id || null}
          onClose={() => setDetailTaskId(null)}
          onUpdate={handleUpdateTaskDetail}
          onAddSubtask={handleAddTaskSubtask}
          onToggleSubtask={handleToggleTaskSubtask}
          onDeleteSubtask={handleDeleteTaskSubtask}
          onAddAttachment={handleAddTaskAttachment}
          onDeleteAttachment={handleDeleteTaskAttachment}
          onApprove={handleApproveTask}
          approving={isActionPending(`task-approve-${detailTask.id}`)}
          onReject={handleRejectTask}
          rejecting={isActionPending(`task-reject-${detailTask.id}`)}
          onPause={setPausingTaskId}
          onResume={handleResumeTask}
          resuming={isActionPending(`task-resume-${detailTask.id}`)}
          onCancel={setCancellingTaskId}
          onUncancel={handleUncancelTask}
          uncancelling={isActionPending(`task-uncancel-${detailTask.id}`)}
        />
      )}
      {pausingTaskId && (
        <PauseTaskModal
          taskTitle={internalTasks.find(t => t.id === pausingTaskId)?.title}
          onClose={() => setPausingTaskId(null)}
          onConfirm={handleConfirmPauseTask}
        />
      )}
      {cancellingTaskId && (
        <CancelTaskModal
          taskTitle={internalTasks.find(t => t.id === cancellingTaskId)?.title}
          onClose={() => setCancellingTaskId(null)}
          onConfirm={handleConfirmCancelTask}
        />
      )}
      {taskReminderQueue.length > 0 && (
        <TaskReminderModal
          reminder={taskReminderQueue[0]}
          onOpenTask={(task) => handleOpenTaskFromPanel(task)}
          onClose={() => setTaskReminderQueue(prev => prev.slice(1))}
        />
      )}
      {showContactInfo && !showStatusViewer && selectedConversation && (
        <ContactInfoPanel
          conversation={selectedConversation}
          messages={messages}
          accountId={selectedConversation?.account_id || selectedAccountId}
          providerType={selectedAccount?.provider_type || null}
          onClose={() => setShowContactInfo(false)}
          onPinChat={handlePinChat}
          onMuteChat={handleMuteChat}
          onToggleFavorite={handleToggleFavorite}
          onSearchInChat={() => setChatSearchSignal(s => s + 1)}
          onClearChat={handleClearChat}
          onDeleteChat={handleDeleteChat}
          onBlockContact={handleBlockContact}
          onViewMedia={handleViewMedia}
          onStarMessage={handleStarMessage}
        onRetryFailedMessage={handleRetryFailedMessage}
          onPinMessage={handlePinMessage}
          onUpdateContactName={handleUpdateContactName}
          onUpdateContactInternal={handleUpdateContactInternal}
          onUpdateContactNotes={handleUpdateContactNotes}
          tasks={customerConversationTasks}
          currentUserId={currentUserProfile?.id || null}
          onToggleTask={handleToggleInternalTask}
          onOpenTask={handleOpenCustomerTaskDetail}
        />
      )}
      {showGroupManager && !showStatusViewer && selectedConversation && (
        <GroupManager
          conversation={selectedConversation}
          accountId={selectedAccountId}
          onClose={() => setShowGroupManager(false)}
          onRefresh={() => loadConversations(selectedAccountId)}
          onOpenParticipantInfo={handleOpenParticipantInfo}
          onUpdateContactInternal={handleUpdateContactInternal}
          messages={messages}
          onPinMessage={handlePinMessage}
          tasks={customerConversationTasks}
          currentUserId={currentUserProfile?.id || null}
          onToggleTask={handleToggleInternalTask}
          onOpenTask={handleOpenCustomerTaskDetail}
        />
      )}
      </>
      )}

      {/* Modais */}
      {showQRManager && <QRCodeManager onClose={() => setShowQRManager(false)} />}
      {showCartBuilder && <CartBuilder contactPhone={selectedConversation?.contact?.phone_number} contactName={selectedConversation?.contact?.name} onClose={() => setShowCartBuilder(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showFlowSender && <FlowSender conversation={selectedConversation} onClose={() => setShowFlowSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showAnalytics && <AnalyticsDashboard onClose={() => setShowAnalytics(false)} />}
      {showReports && <ReportsPanel onClose={() => setShowReports(false)} />}
      {showNewInternalChatModal && (
        <NewInternalChatModal
          agents={agents}
          currentUserId={currentUserProfile?.id || null}
          onClose={() => setShowNewInternalChatModal(false)}
          onCreated={handleInternalChatCreated}
        />
      )}
      {showNewChatModal && (
        <NewChatModal
          accountId={selectedAccountId}
          onClose={() => setShowNewChatModal(false)}
          onStartChat={handleStartNewChat}
        />
      )}
      {showBusinessProfile && <BusinessProfile onClose={() => setShowBusinessProfile(false)} />}
      {showTemplateSender && <TemplateSender accountId={selectedAccountId} initialPhoneNumber={selectedConversation?.contact?.phone_number} onClose={() => setShowTemplateSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showLocationSender && <LocationSender conversation={selectedConversation} onClose={() => setShowLocationSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showContactSender && <ContactSender conversation={selectedConversation} onClose={() => setShowContactSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showListSender && <ListSender conversation={selectedConversation} onClose={() => setShowListSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showProductSender && <ProductSender conversation={selectedConversation} onClose={() => setShowProductSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showProductListSender && <ProductListSender conversation={selectedConversation} onClose={() => setShowProductListSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showSettings && (
        <SettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          currentUser={currentUser}
          currentUserId={currentUserProfile?.id}
          currentUserFullName={currentUserProfile?.full_name}
          currentUserDisplayNameFormat={currentUserProfile?.display_name_format}
          onDisplayNameFormatChanged={(fmt) => setCurrentUserProfile(p => p && ({ ...p, display_name_format: fmt }))}
          currentUserPhotoUrl={currentUserProfile?.photo_url}
          onPhotoChanged={(url) => setCurrentUserProfile(p => p && ({ ...p, photo_url: url }))}
          permissions={currentUserProfile?.permissions || {}}
          isAdmin={!!currentUserProfile?.is_admin}
          currentTheme={theme}
          onToggleTheme={toggleTheme}
          initialTab={settingsInitialTab}
          onQuickRepliesChanged={handleRefreshQuickReplies}
          onTagsChanged={handleRefreshTagCatalog}
          statusColors={statusColors}
          onStatusColorsChanged={handleRefreshStatusColors}
        />
      )}
      {showPollSender && <PollSender conversation={selectedConversation} accountId={selectedAccountId} onClose={() => setShowPollSender(false)} onSent={() => loadMessages(selectedConversation)} />}
      {showMediaGallery && (
        <MediaGallery
          messages={sidebarView === 'team' ? internalMediaMessages : messages}
          onClose={() => setShowMediaGallery(false)}
        />
      )}
      {showMyTasksPanel && (
        <MyTasksPanel
          tasks={myTasks}
          currentUserId={currentUserProfile?.id}
          onClose={() => setShowMyTasksPanel(false)}
          onOpenTask={handleOpenTaskFromPanel}
          onNewTask={handleOpenGlobalTaskModal}
        />
      )}
      {showGlobalTaskModal && (
        <TaskModal
          standalone
          agents={agents}
          currentUserId={currentUserProfile?.id}
          onClose={() => setShowGlobalTaskModal(false)}
          onCreate={handleCreateGlobalTask}
        />
      )}
      {showGroupCreator && <GroupCreator accountId={selectedAccountId} onClose={() => setShowGroupCreator(false)} onRefreshConversations={() => loadConversations(selectedAccountId)} />}
      {showBroadcastManager && <BroadcastManagerModal accountId={selectedAccountId} conversations={conversations} onClose={() => setShowBroadcastManager(false)} />}
      {showProfilePanel && <BaileysProfilePanel accountId={selectedAccountId} onClose={() => setShowProfilePanel(false)} />}
      {participantInfo && (
        <ParticipantInfoModal
          jid={participantInfo.jid}
          phoneNumber={participantInfo.phoneNumber}
          name={participantInfo.name}
          accountId={participantInfo.accountId}
          onClose={() => setParticipantInfo(null)}
          onOpenChat={handleOpenParticipantChat}
        />
      )}
    </div>
  );
}

export default App;
