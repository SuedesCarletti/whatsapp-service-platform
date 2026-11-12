/**
 * Sidebar — Lista de conversas estilo WhatsApp Web
 * Integra AccountSwitcher para filtrar por conta
 */
import React, { useState, useEffect, useMemo, memo, useCallback, useRef } from 'react';
import { BsChatDots, BsPeopleFill, BsPlusLg, BsListCheck, BsPinFill } from 'react-icons/bs';
import { BiSearch } from 'react-icons/bi';
import { MdLabel } from 'react-icons/md';
import moment from 'moment';
import 'moment/locale/pt-br';
import ConversationListMenu from './menus/ConversationListMenu';
import AccountSwitcher from './AccountSwitcher';
import { PresenceDot, PRESENCE_META } from './InternalChatArea';
import apiService, { baileysApi } from '../services/api';
import avatarCache, { PHOTO_CAPABLE_PROVIDERS } from '../utils/avatarCache';
import { isSiteChatId, isSiteChatContact } from '../utils/siteChat';
import { limitAvatarFetch } from '../utils/avatarFetchLimiter';
import { formatElapsed } from '../utils/timeFormat';
import { getContrastTextColor } from '../utils/tagColor';
import useClickOutside from '../utils/useClickOutside';
import '../styles/AccountSwitcher.css';

moment.locale('pt-br');

// Pseudo-id usado no filtro de etiquetas pra representar "sem etiqueta
// nenhuma" — não é um id real da tabela tags (que são inteiros), então nunca
// colide com um tag.id de verdade.
const NO_TAGS_FILTER = '__no_tags__';

// Melhor esforço (não é 100% preciso, é impossível sem NLP de verdade): quando
// a ÚLTIMA mensagem da conversa é claramente um encerramento/agradecimento —
// de qualquer um dos dois lados (cliente ou o próprio atendimento) — o
// cronômetro de SLA não faz mais sentido mostrar, mesmo que o status ainda
// não tenha sido marcado como resolvido manualmente. Pedido do usuário
// 2026-09-01, depois do incidente de resync de backlog que deixou dezenas de
// conversas com badge de espera enganoso.
const CLOSING_PHRASE_PATTERNS = [
  /\bobrigad[oa]\b/i, /\bvaleu\b/i, /\bagrade[çc]/i,
  /\bde nada\b/i, /\bpor nada\b/i, /\bdisponha\b/i, /\bimagina\b/i,
  /\b(at[ée] mais|at[ée] logo|at[ée] a pr[oó]xima)\b/i,
  /\btchau\b/i,
  /atendimento (foi )?finalizado/i, /encerr(amos|ando|ado) (o |seu )?atendimento/i,
];

const looksLikeClosed = (conversation) => {
  const text = conversation?.last_message?.message;
  if (!text || typeof text !== 'string') return false;
  return CLOSING_PHRASE_PATTERNS.some((re) => re.test(text));
};

// ─── helpers fora do componente para referência estável ───────────────────────
const formatTime = (timestamp) => {
  const messageTime = moment(timestamp);
  const now = moment();
  if (now.diff(messageTime, 'days') === 0) return messageTime.format('HH:mm');
  if (now.diff(messageTime, 'days') === 1) return 'Ontem';
  if (now.diff(messageTime, 'days') < 7) return messageTime.format('ddd');
  return messageTime.format('DD/MM/YYYY');
};

const getInitials = (name) => {
  if (!name) return '?';
  const clean = name.trim();
  // Sem contato salvo o "nome" é o telefone formatado (ex: "+55 27 99583-6548")
  // — sem isso, pegava o "+" e o DDD ("+2") em vez de algo que identifique o
  // contato. Usa os 2 últimos dígitos do número, que variam por contato.
  if (/^\+?\d/.test(clean)) {
    const digits = clean.replace(/\D/g, '');
    return digits.slice(-2).toUpperCase() || '?';
  }
  const parts = clean.split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.substring(0, 2).toUpperCase();
};

const truncateMessage = (message, maxLength = 40) => {
  if (!message) return 'Sem mensagens';
  if (message.length <= maxLength) return message;
  return message.substring(0, maxLength) + '...';
};

const formatPhone = (phone) => {
  if (!phone) return null;
  if (isSiteChatId(String(phone))) return null;
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55'))
    return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55'))
    return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,8)}-${d.slice(8)}`;
  if (d.length >= 8) return `+${d}`;
  return phone;
};

// Igual ao WhatsApp Web: na lista só mostra um nome de exibição quando o
// contato está de fato salvo (Contact.saved_name). Sem isso, mostra só o
// número — o "nome do perfil" autodeclarado (push_name/profile.name da Meta)
// só aparece ao abrir os Dados do Contato, não aqui.
const getConvName = (conv) => {
  if (conv.is_group) {
    const name = conv.name || conv.contact?.name;
    return name || 'Grupo';
  }
  const saved = conv.contact?.saved_name;
  if (saved) return saved;
  const phone = conv.fromNumber || conv.contact?.phone_number || conv.contact?.wa_id;
  return formatPhone(phone) || conv.name || conv.contact?.name || (isSiteChatContact(conv.contact) ? 'Visitante do site' : 'Desconhecido');
};

const getLastMessage = (conv) => conv.lastMessage || conv.last_message?.message || '';

const STATUS_COLORS = { open: '#2FAE60', pending: '#ECB22E', resolved: '#8696A0' };
const STATUS_LABELS = { open: 'Aberta', pending: 'Pendente', resolved: 'Resolvida' };

// Relógio de SLA: enquanto a conversa não é resolvida, mostra há quanto
// tempo ela está em cada fase do ciclo de atendimento —
// "esperando" (fila, ninguém atribuído ainda) conta desde created_at;
// "pendente" (atendente já respondeu, aguardando o cliente) conta desde
// pending_since; "em atendimento" (atribuída, aberta, sem resposta do
// atendente ainda) conta desde assigned_at, não desde created_at (bug
// anterior: usava created_at pra esse caso, misturando idade da conversa
// com tempo de atribuição). Fica vermelho passado o limite configurado em
// Configurações → Automações → SLA.
// nowTick (3º arg, não usado no corpo) só existe pra documentar que este
// cálculo depende do relógio real (Date.now()) e precisa ser recomputado
// periodicamente — quem força isso é o componente, passando um valor que
// muda a cada 30s como prop, fazendo o React re-renderizar o memo.
const getSlaBadge = (conversation, slaWaitMinutes, nowTick) => {
  if (conversation.status === 'resolved') return null;
  // Contato interno (colega/fornecedor) não é atendimento a cliente — sem
  // relógio de fila/SLA, é só um chat comum.
  if (conversation.contact?.is_internal) return null;
  // Última mensagem parece encerramento/agradecimento — não faz sentido
  // mostrar "esperando há Xh" numa conversa que na prática já terminou,
  // mesmo que ninguém tenha marcado como resolvida manualmente ainda.
  if (looksLikeClosed(conversation)) return null;

  const isWaiting = !conversation.assigned_to;
  let sinceIso;
  let label;
  if (isWaiting) {
    // queue_since existe quando a conversa VOLTOU pra fila depois de já ter
    // sido trabalhada (reabertura sem responsável, ou liberação manual) —
    // sem esse fallback, uma conversa reaberta mostrava "esperando" desde a
    // criação original (dias atrás) em vez de desde que voltou à fila.
    sinceIso = conversation.queue_since || conversation.created_at;
    label = '⏳ esperando';
  } else if (conversation.status === 'pending' && conversation.pending_since) {
    sinceIso = conversation.pending_since;
    label = '🕐 pendente';
  } else {
    sinceIso = conversation.assigned_at || conversation.created_at;
    label = '🕐 em atendimento';
  }
  if (!sinceIso) return null;

  const elapsedMs = Date.now() - new Date(sinceIso).getTime();
  const minutes = Math.max(0, Math.floor(elapsedMs / 60000));
  const breached = minutes >= (slaWaitMinutes || 10);
  return {
    label: `${label} há ${formatElapsed(minutes)}`,
    breached,
  };
};

// Cada item é memoizado: só re-renderiza se seus próprios dados mudarem,
// eliminando o piscar da lista quando outras conversas são atualizadas.
// nowTick força recomputar o relógio de SLA periodicamente mesmo sem
// nenhum outro dado da conversa ter mudado.
const ConversationItem = memo(({ conversation, isSelected, onClick, providerType, accountId, slaWaitMinutes, nowTick, statusColors }) => {
  const name = getConvName(conversation);
  const time = conversation.timestamp || conversation.last_message_at
    ? formatTime(conversation.timestamp || conversation.last_message_at)
    : '';
  const slaBadge = getSlaBadge(conversation, slaWaitMinutes, nowTick);
  const unread = conversation.unreadCount || conversation.unread_count || 0;

  const jid = conversation.contact?.wa_id || conversation.fromNumber;
  // Se o backend já mandou a URL salva (contacts.profile_picture_url), usa direto —
  // só cai pra busca ao vivo via bridge quando não há nada em cache.
  const [avatarUrl, setAvatarUrl] = useState(
    conversation.contact?.profile_picture_url || avatarCache.get(jid) || null
  );

  useEffect(() => {
    // Grupos também têm foto (ícone do grupo) — profilePictureUrl aceita @g.us
    // normalmente, não é exclusivo de contato individual. Restrito aos
    // providers cujo bridge implementa /profile/picture de verdade (ver
    // PHOTO_CAPABLE_PROVIDERS) — antes disso era exclusivo de 'baileys',
    // deixando a foto de fora na sidebar pra wppconnect/whatsapp_web_js
    // mesmo já funcionando no painel "Dados do contato".
    if (avatarUrl || !PHOTO_CAPABLE_PROVIDERS.has(providerType) || !jid || isSiteChatId(jid)) return;
    if (avatarCache.has(jid)) {
      setAvatarUrl(avatarCache.get(jid));
      return;
    }
    let cancelled = false;
    limitAvatarFetch(() => baileysApi.getProfilePicture(jid, false, accountId))
      .then(res => {
        // res?.success === false = falha do bridge (timeout, sessão caída,
        // rajada de 500 como no incidente 2026-09-11), não "contato sem
        // foto" — não pode gravar null no cache, senão a foto fica marcada
        // como inexistente pro resto da sessão do navegador mesmo existindo.
        if (res?.success === false) return;
        const url = res?.url || null;
        avatarCache.set(jid, url);
        if (!cancelled) setAvatarUrl(url);
      })
      .catch(() => {}); // erro de rede — mesmo motivo, não grava no cache
    return () => { cancelled = true; };
  }, [jid, providerType, accountId, avatarUrl]);

  return (
    <div
      className={`conversation-item ${isSelected ? 'active' : ''} ${conversation.bot_loop_detected ? 'bot-alert' : ''}`}
      onClick={onClick}
      title={conversation.bot_loop_detected ? '🚨 Bot travado/em loop nessa conversa — precisa de um atendente' : undefined}
    >
      <div className="conversation-avatar">
        {avatarUrl
          ? <img src={avatarUrl} alt="" className="conversation-avatar-img" />
          : getInitials(name)}
      </div>
      <div className="conversation-info">
        <div className="conversation-header">
          <span className="conversation-name">
            {conversation.is_pinned && (
              <BsPinFill size={11} style={{ marginRight: 4, opacity: 0.6, verticalAlign: -1 }} title="Conversa fixada" />
            )}
            {name}
            {isSiteChatContact(conversation.contact) && (
              <span
                title="Conversa vinda do chat do site"
                style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8, background: 'var(--brand-navy, #1B2A49)', color: '#fff', verticalAlign: 1 }}
              >
                SITE
              </span>
            )}
          </span>
          <span className="conversation-time">{time}</span>
        </div>
        <div className="conversation-last-message">
          {truncateMessage(getLastMessage(conversation))}
          {unread > 0 && <span className="unread-badge">{unread}</span>}
        </div>
        {conversation.status || conversation.assigned_to || (conversation.tags && conversation.tags.length > 0) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
            {conversation.status && (
              <span
                title={STATUS_LABELS[conversation.status] || conversation.status}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700,
                  color: (statusColors || STATUS_COLORS)[conversation.status] || '#8696A0',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: (statusColors || STATUS_COLORS)[conversation.status] || '#8696A0',
                }} />
                {STATUS_LABELS[conversation.status] || conversation.status}
              </span>
            )}
            {conversation.assigned_to && (
              <span
                title={`Atribuída a ${conversation.assigned_to.full_name}`}
                style={{
                  fontSize: 10, fontWeight: 600, color: '#fff', background: 'var(--whatsapp-green, #25D366)',
                  borderRadius: '50%', width: 16, height: 16, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', flexShrink: 0,
                }}
              >
                {getInitials(conversation.assigned_to.full_name).charAt(0)}
              </span>
            )}
            {(conversation.tags || []).slice(0, 2).map(tag => (
              <span
                key={tag.id}
                style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 10, color: getContrastTextColor(tag.color || '#8696A0'),
                  background: tag.color || '#8696A0', whiteSpace: 'nowrap',
                }}
              >
                {tag.name}
              </span>
            ))}
            {(conversation.tags || []).length > 2 && (
              <span style={{ fontSize: 10, color: 'var(--text-secondary, #8696A0)' }}>+{conversation.tags.length - 2}</span>
            )}
          </div>
        ) : null}
        {slaBadge && (
          <div style={{ fontSize: 10, fontWeight: 600, marginTop: 2, color: slaBadge.breached ? '#e53e3e' : 'var(--text-secondary, #8696A0)' }}>
            {slaBadge.label}
          </div>
        )}
      </div>
    </div>
  );
});

// Resultado da busca por conteúdo de mensagem — cada ocorrência aparece
// individualmente (diferente de ConversationItem, que representa a conversa
// como um todo), identificando quem mandou, quando e em qual conversa/grupo.
const MessageResultItem = ({ result, onClick }) => {
  const headerName = result.is_group ? (result.group_name || result.contact_name) : result.contact_name;
  const preview = result.direction === 'outbound'
    ? `Você: ${result.message}`
    : result.is_group
      ? `${result.sender_name}: ${result.message}`
      : result.message;

  return (
    <div className="conversation-item" onClick={onClick}>
      <div className="conversation-avatar">{getInitials(headerName)}</div>
      <div className="conversation-info">
        <div className="conversation-header">
          <span className="conversation-name">{headerName}</span>
          <span className="conversation-time">{formatTime(result.timestamp)}</span>
        </div>
        <div className="conversation-last-message">
          {truncateMessage(preview, 50)}
        </div>
      </div>
    </div>
  );
};

const Sidebar = ({
  conversations,
  selectedConversation,
  onSelectConversation,
  loading,
  // AccountSwitcher
  selectedAccountId,
  onSelectAccount,
  providerType,
  currentUserId,
  slaWaitMinutes,
  statusColors,
  tagCatalog,
  // Chat interno (Equipe) — separado das conversas de cliente
  sidebarView,
  onChangeSidebarView,
  internalChats,
  selectedInternalChatId,
  onSelectInternalChat,
  onStartNewInternalChat,
  internalPresence,
  myPresenceStatus,
  onChangeMyPresenceStatus,
  // ConversationListMenu
  onOpenQRManager,
  onOpenAnalytics,
  onOpenBusinessProfile,
  onLogout,
  onNewChat,
  onNewBroadcast,
  onNewGroup,
  onManageTemplates,
  onSavedMessages,
  onManageLabels,
  onOpenReports,
  onOpenSettings,
  onOpenProfilePanel,
  // Tema
  currentTheme,
  toggleTheme,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [conversationResults, setConversationResults] = useState([]);
  const [messageResults, setMessageResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // Busca "geral" da Equipe — mesma ideia da busca de Clientes acima, só
  // que restrita às conversas internas do próprio usuário (chat interno é
  // privado, ver GET /internal-chats/search|messages/search).
  const [internalSearchTerm, setInternalSearchTerm] = useState('');
  const [internalConvResults, setInternalConvResults] = useState([]);
  const [internalMsgResults, setInternalMsgResults] = useState([]);
  const [internalSearching, setInternalSearching] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const [tagFilterIds, setTagFilterIds] = useState([]);
  const [showTagFilterPicker, setShowTagFilterPicker] = useState(false);
  // Clicar fora do filtro de etiquetas fecha o dropdown — antes só fechava
  // clicando de novo no botão "Etiquetas".
  const tagFilterRef = useRef(null);
  useClickOutside(tagFilterRef, useCallback(() => setShowTagFilterPicker(false), []), showTagFilterPicker);

  // Só existe pra forçar os badges de SLA (ConversationItem) a recomputarem
  // "há Xmin" periodicamente, mesmo quando nada mais na conversa mudou.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const trimmedSearch = searchTerm.trim();

  // Filtro de fila/atribuição — client-side sobre a lista já carregada, sem
  // rota nova. Só se aplica à navegação normal; a busca (backend) ignora o
  // filtro de propósito, pra não confundir "nenhum resultado" com "filtrado".
  const filteredConversations = useMemo(() => {
    let base;
    switch (statusFilter) {
      case 'mine': base = conversations.filter(c => c.assigned_to?.id === currentUserId); break;
      // Contato interno (colega/fornecedor) não é atendimento a cliente — não
      // deve contar como ticket "não atribuído"/"pendente"/"aberta" na fila.
      case 'unassigned': base = conversations.filter(c => !c.assigned_to && !c.contact?.is_internal); break;
      case 'open': base = conversations.filter(c => (c.status || 'open') === 'open' && !c.contact?.is_internal); break;
      case 'pending': base = conversations.filter(c => c.status === 'pending' && !c.contact?.is_internal); break;
      case 'resolved': base = conversations.filter(c => c.status === 'resolved'); break;
      case 'unread': base = conversations.filter(c => (c.unread_count || 0) > 0); break;
      default: base = conversations;
    }
    // Etiquetas — combina com o filtro de fila acima (E lógico): mostra
    // conversas que já passaram no filtro de fila E têm pelo menos uma das
    // etiquetas marcadas (OU entre etiquetas — marcar 2 mostra as duas).
    // NO_TAGS_FILTER é um pseudo-item ("Sem etiquetas") que entra no mesmo OU:
    // marcar ele junto com uma etiqueta real mostra as duas coisas juntas.
    if (tagFilterIds.length > 0) {
      base = base.filter(c => {
        const tags = c.tags || [];
        if (tags.length === 0 && tagFilterIds.includes(NO_TAGS_FILTER)) return true;
        return tags.some(t => tagFilterIds.includes(t.id));
      });
    }
    // Fixadas sempre no topo — sort estável preserva a ordem relativa (por
    // last_message_at) entre conversas com o mesmo estado de pin. Calculado
    // aqui (não confiando só na ordem que já vem da API) porque atualizações
    // locais em tempo real (nova mensagem, toggle de pin) mexem no array de
    // `conversations` sem reordenar sozinhas.
    return [...base].sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0));
  }, [conversations, statusFilter, currentUserId, tagFilterIds]);

  // Mesma ideia acima, pro lado Equipe.
  const sortedInternalChats = useMemo(
    () => [...(internalChats || [])].sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0)),
    [internalChats]
  );

  // Busca local instantânea por nome/telefone (mesmos campos usados na exibição,
  // incluindo o fallback pro telefone formatado quando o contato não tem nome salvo).
  const matchesLocally = useCallback((conv, term) => {
    const t = term.toLowerCase();
    const name = getConvName(conv).toLowerCase();
    const rawPhone = String(conv.contact?.phone_number || conv.contact?.wa_id || conv.fromNumber || '').toLowerCase();
    return name.includes(t) || rawPhone.includes(t);
  }, []);

  // Busca no backend por conversas (nome/telefone/push_name, campos que a lista
  // local não tem carregados) e por TODAS as ocorrências de mensagens com o
  // termo — debounced pra não disparar uma requisição a cada tecla.
  useEffect(() => {
    if (trimmedSearch.length < 2) {
      setConversationResults([]);
      setMessageResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      Promise.all([
        apiService.searchConversations(trimmedSearch, selectedAccountId),
        apiService.searchMessages(trimmedSearch, selectedAccountId),
      ])
        .then(([convRes, msgRes]) => {
          setConversationResults(convRes || []);
          setMessageResults(msgRes || []);
        })
        .catch(() => {
          setConversationResults([]);
          setMessageResults([]);
        })
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(handle);
  }, [trimmedSearch, selectedAccountId]);

  const trimmedInternalSearch = internalSearchTerm.trim();

  useEffect(() => {
    if (trimmedInternalSearch.length < 2) {
      setInternalConvResults([]);
      setInternalMsgResults([]);
      setInternalSearching(false);
      return;
    }
    setInternalSearching(true);
    const handle = setTimeout(() => {
      Promise.all([
        apiService.searchInternalChats(trimmedInternalSearch),
        apiService.searchInternalMessages(trimmedInternalSearch),
      ])
        .then(([convRes, msgRes]) => {
          setInternalConvResults(convRes || []);
          setInternalMsgResults(msgRes || []);
        })
        .catch(() => {
          setInternalConvResults([]);
          setInternalMsgResults([]);
        })
        .finally(() => setInternalSearching(false));
    }, 350);
    return () => clearTimeout(handle);
  }, [trimmedInternalSearch]);

  // Local (nome, instantâneo) + o que o backend achou a mais, mesma lógica
  // de conversationSectionItems acima.
  const internalConversationSectionItems = trimmedInternalSearch
    ? (() => {
        const term = trimmedInternalSearch.toLowerCase();
        const localMatches = (internalChats || []).filter(c => (c.name || '').toLowerCase().includes(term));
        const byId = new Map(localMatches.map(c => [c.id, c]));
        internalConvResults.forEach(c => {
          if (!byId.has(c.id)) byId.set(c.id, (internalChats || []).find(ic => ic.id === c.id) || c);
        });
        return Array.from(byId.values());
      })()
    : [];

  // Resultado instantâneo (local) + o que o backend achou a mais (push_name/
  // saved_name, campos que não vêm na lista carregada em memória) — deduplicado.
  const localMatches = trimmedSearch ? conversations.filter((conv) => matchesLocally(conv, trimmedSearch)) : conversations;
  const conversationSectionItems = trimmedSearch
    ? (() => {
        const byId = new Map(localMatches.map(c => [c.id, c]));
        conversationResults.forEach(c => {
          if (!byId.has(c.id)) byId.set(c.id, conversations.find(fc => fc.id === c.id) || c);
        });
        return Array.from(byId.values());
      })()
    : conversations;

  // Contadores de não lidas para os botões Clientes/Equipe — somam mesmo a
  // lista que não está em foco no momento, pra alertar sobre mensagem nova
  // em conversas fora da aba atual.
  const clientsUnreadCount = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount || c.unread_count || 0), 0),
    [conversations]
  );
  const teamUnreadCount = useMemo(
    () => (internalChats || []).reduce((sum, c) => sum + (c.unread_count || 0), 0),
    [internalChats]
  );
  const UNREAD_COUNTS = { clients: clientsUnreadCount, team: teamUnreadCount };

  // useCallback garante referência estável para onClick de cada item memoizado
  const handleSelect = useCallback((conv) => onSelectConversation(conv), [onSelectConversation]);

  const handleSelectMessageResult = useCallback((msgResult) => {
    const conv = conversations.find(c => c.id === msgResult.conversation_id);
    if (conv) onSelectConversation(conv);
  }, [conversations, onSelectConversation]);

  return (
    <div className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-header-left">
          <BsChatDots size={24} />
          <h2>Conversas</h2>
        </div>
        {sidebarView !== 'team' && (
          <div className="sidebar-header-account">
            <AccountSwitcher
              selectedAccountId={selectedAccountId}
              onSelectAccount={onSelectAccount}
            />
          </div>
        )}
        <div className="sidebar-header-icons">
          <ConversationListMenu
            providerType={providerType}
            onNewChat={onNewChat}
            onNewBroadcast={onNewBroadcast}
            onNewGroup={onNewGroup}
            onManageTemplates={onManageTemplates}
            onSavedMessages={onSavedMessages}
            onManageLabels={onManageLabels}
            onOpenAnalytics={onOpenAnalytics}
            onOpenBusinessProfile={onOpenBusinessProfile}
            onOpenQRManager={onOpenQRManager}
            onOpenReports={onOpenReports}
            onOpenSettings={onOpenSettings}
            onOpenProfilePanel={onOpenProfilePanel}
            onLogout={onLogout}
          />
        </div>
      </div>

      {/* Clientes (conversas de WhatsApp) x Equipe (chat interno) */}
      <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0' }}>
        {[
          ['clients', <BsChatDots size={13} key="i" />, 'Clientes'],
          ['team', <BsPeopleFill size={13} key="i" />, 'Equipe'],
        ].map(([key, icon, label]) => {
          const isActive = (sidebarView || 'clients') === key;
          const unreadCount = UNREAD_COUNTS[key] || 0;
          return (
            <button
              key={key}
              onClick={() => onChangeSidebarView && onChangeSidebarView(key)}
              style={{
                position: 'relative',
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontSize: 13, fontWeight: 600, padding: '7px 0', borderRadius: 8, cursor: 'pointer',
                border: 'none',
                background: isActive ? 'var(--whatsapp-green, #25D366)' : 'var(--bg-secondary, #f0f0f0)',
                color: isActive ? '#fff' : 'var(--text-secondary, #8696A0)',
              }}
            >
              {icon} {label}
              {unreadCount > 0 && (
                <span
                  style={{
                    position: 'absolute', top: -5, right: -5,
                    background: isActive ? '#fff' : '#e02e2e',
                    color: isActive ? 'var(--whatsapp-green, #25D366)' : '#fff',
                    borderRadius: 999, minWidth: 18, height: 18, padding: '0 5px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, lineHeight: 1,
                    boxShadow: '0 0 0 2px var(--bg-primary, #fff)',
                  }}
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {sidebarView === 'team' ? (
        <div className="conversations-list">
          <div style={{ padding: '10px 12px 0', position: 'relative' }}>
            <button
              onClick={() => setShowStatusPicker(v => !v)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13, fontWeight: 600, padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
                border: '1px solid var(--border-color, #ccc)', background: 'var(--bg-secondary, #f9f9f9)',
                color: 'var(--text-primary, #333)', marginBottom: 8,
              }}
            >
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: (PRESENCE_META[myPresenceStatus] || PRESENCE_META.online).color,
                flexShrink: 0,
              }} />
              {(PRESENCE_META[myPresenceStatus] || PRESENCE_META.online).label}
            </button>
            {showStatusPicker && (
              <div style={{
                position: 'absolute', top: '100%', left: 12, right: 12, zIndex: 1000, marginTop: -4,
                background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)',
                borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', overflow: 'hidden',
              }}>
                {Object.entries(PRESENCE_META).map(([status, meta]) => (
                  <div
                    key={status}
                    onClick={() => { onChangeMyPresenceStatus && onChangeMyPresenceStatus(status); setShowStatusPicker(false); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13,
                      cursor: 'pointer', background: myPresenceStatus === status ? 'var(--bg-secondary, #f0f0f0)' : 'transparent',
                    }}
                  >
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                    {meta.label}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ padding: '2px 12px 10px' }}>
            <button
              onClick={onStartNewInternalChat}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontSize: 13, fontWeight: 600, padding: '8px 0', borderRadius: 8, cursor: 'pointer',
                border: '1px dashed var(--border-color, #ccc)', background: 'transparent',
                color: 'var(--whatsapp-green, #25D366)',
              }}
            >
              <BsPlusLg size={13} /> Nova conversa interna
            </button>
          </div>

          {/* Busca geral (conversas + mensagens) — mesma ideia da busca de
              Clientes, só que restrita ao chat interno privado do usuário. */}
          <div className="search-container">
            <div className="search-box">
              <BiSearch size={20} color="#8696A0" />
              <input
                type="text"
                placeholder="Pesquisar na equipe"
                value={internalSearchTerm}
                onChange={(e) => setInternalSearchTerm(e.target.value)}
              />
            </div>
          </div>

          {trimmedInternalSearch ? (
            <>
              <div className="search-section-title">Conversas</div>
              {internalConversationSectionItems.length === 0 ? (
                <div style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>
                  Nenhuma conversa encontrada
                </div>
              ) : (
                internalConversationSectionItems.map((chat) => (
                  <div
                    key={chat.id}
                    className={`conversation-item ${selectedInternalChatId === chat.id ? 'active' : ''}`}
                    onClick={() => onSelectInternalChat(chat)}
                  >
                    <div className="conversation-avatar">
                      {chat.photo_url
                        ? <img src={chat.photo_url} alt="" className="conversation-avatar-img" />
                        : chat.is_group ? <BsPeopleFill size={18} /> : getInitials(chat.name)}
                    </div>
                    <div className="conversation-info">
                      <div className="conversation-header">
                        <span className="conversation-name">{chat.name}</span>
                      </div>
                      <div className="conversation-last-message">
                        {truncateMessage(chat.last_message?.text || 'Nenhuma mensagem ainda')}
                      </div>
                    </div>
                  </div>
                ))
              )}

              <div className="search-section-title">Mensagens</div>
              {internalSearching && internalMsgResults.length === 0 ? (
                <div style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>Buscando...</div>
              ) : internalMsgResults.length === 0 ? (
                <div style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>
                  Nenhuma mensagem encontrada
                </div>
              ) : (
                internalMsgResults.map((result) => (
                  <div
                    key={result.id}
                    className="conversation-item"
                    onClick={() => {
                      const chat = (internalChats || []).find(c => c.id === result.conversation_id);
                      if (chat) onSelectInternalChat(chat);
                    }}
                  >
                    <div className="conversation-avatar">{getInitials(result.conversation_name)}</div>
                    <div className="conversation-info">
                      <div className="conversation-header">
                        <span className="conversation-name">{result.conversation_name}</span>
                      </div>
                      <div className="conversation-last-message">
                        {result.is_group ? `${result.sender_name}: ` : ''}{truncateMessage(result.text, 50)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </>
          ) : (!internalChats || internalChats.length === 0) ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              Nenhuma conversa com a equipe ainda
            </div>
          ) : (
            sortedInternalChats.map((chat) => (
              <div
                key={chat.id}
                className={`conversation-item ${selectedInternalChatId === chat.id ? 'active' : ''}`}
                onClick={() => onSelectInternalChat(chat)}
              >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div className="conversation-avatar">
                    {chat.photo_url
                      ? <img src={chat.photo_url} alt="" className="conversation-avatar-img" />
                      : chat.is_group ? <BsPeopleFill size={18} /> : getInitials(chat.name)}
                  </div>
                  {!chat.is_group && (() => {
                    const other = (chat.participants || []).find(p => p.id !== currentUserId);
                    const status = other ? internalPresence?.[other.id]?.status : null;
                    return status ? <PresenceDot status={status} size={11} /> : null;
                  })()}
                </div>
                <div className="conversation-info">
                  <div className="conversation-header">
                    <span className="conversation-name">
                      {chat.is_pinned && (
                        <BsPinFill size={11} style={{ marginRight: 4, opacity: 0.6, verticalAlign: -1 }} title="Conversa fixada" />
                      )}
                      {chat.name}
                      {chat.open_tasks_count > 0 && (
                        <BsListCheck
                          size={12}
                          style={{ marginLeft: 5, verticalAlign: -1, opacity: 0.65, color: 'var(--brand-orange, #0EA5A4)' }}
                          title={`${chat.open_tasks_count} tarefa(s) aberta(s)`}
                        />
                      )}
                    </span>
                    {chat.last_message && (
                      <span className="conversation-time">{formatTime(chat.last_message.created_at)}</span>
                    )}
                  </div>
                  <div className="conversation-last-message">
                    {truncateMessage(chat.last_message?.text || 'Nenhuma mensagem ainda')}
                    {chat.unread_count > 0 && <span className="unread-badge">{chat.unread_count}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
      {/* Busca */}
      <div className="search-container">
        <div className="search-box">
          <BiSearch size={20} color="#8696A0" />
          <input
            type="text"
            placeholder="Pesquisar conversa"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* Filtro de fila/atribuição */}
      {!trimmedSearch && (
        <div style={{ display: 'flex', gap: 6, padding: '6px 12px', overflowX: 'auto' }}>
          {[
            ['all', 'Todas'],
            ['mine', 'Minhas'],
            ['unassigned', 'Não atribuídas'],
            ['open', 'Abertas'],
            ['pending', 'Pendentes'],
            ['resolved', 'Resolvidas'],
            ['unread', 'Não lidas'],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              style={{
                flexShrink: 0, fontSize: 12, padding: '4px 10px', borderRadius: 14, cursor: 'pointer',
                border: '1px solid var(--border-color, #ddd)',
                background: statusFilter === key ? 'var(--whatsapp-green, #25D366)' : 'transparent',
                color: statusFilter === key ? '#fff' : 'var(--text-secondary, #8696A0)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Filtro por etiqueta */}
      {!trimmedSearch && (tagCatalog || []).length > 0 && (
        <div style={{ padding: '0 12px 6px', position: 'relative' }} ref={tagFilterRef}>
          <button
            onClick={() => setShowTagFilterPicker(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '4px 10px',
              borderRadius: 14, cursor: 'pointer',
              border: '1px solid var(--border-color, #ddd)',
              background: tagFilterIds.length > 0 ? 'var(--whatsapp-green, #25D366)' : 'transparent',
              color: tagFilterIds.length > 0 ? '#fff' : 'var(--text-secondary, #8696A0)',
            }}
          >
            <MdLabel size={13} />
            {tagFilterIds.length === 0 ? 'Etiquetas' : `Etiquetas (${tagFilterIds.length})`}
          </button>

          {showTagFilterPicker && (
            <div style={{
              position: 'absolute', top: '100%', left: 12, marginTop: 4, minWidth: 200, zIndex: 1000,
              background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)',
              borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', padding: 6, maxHeight: 260, overflowY: 'auto',
            }}>
              {(() => {
                const checked = tagFilterIds.includes(NO_TAGS_FILTER);
                return (
                  <label
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13,
                      cursor: 'pointer', borderRadius: 6, borderBottom: '1px solid var(--border-color, #eee)',
                      marginBottom: 4,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setTagFilterIds(prev => checked
                        ? prev.filter(id => id !== NO_TAGS_FILTER)
                        : [...prev, NO_TAGS_FILTER])}
                    />
                    <span style={{ width: 10, height: 10, borderRadius: '50%', border: '1px solid var(--text-secondary, #8696A0)', flexShrink: 0 }} />
                    Sem etiquetas
                  </label>
                );
              })()}
              {tagCatalog.map(tag => {
                const checked = tagFilterIds.includes(tag.id);
                return (
                  <label
                    key={tag.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 13, cursor: 'pointer', borderRadius: 6 }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setTagFilterIds(prev => checked ? prev.filter(id => id !== tag.id) : [...prev, tag.id])}
                    />
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: tag.color || '#8696A0', flexShrink: 0 }} />
                    {tag.name}
                  </label>
                );
              })}
              {tagFilterIds.length > 0 && (
                <button
                  onClick={() => setTagFilterIds([])}
                  style={{
                    width: '100%', marginTop: 4, padding: '6px 0', fontSize: 12, fontWeight: 600,
                    border: 'none', borderTop: '1px solid var(--border-color, #eee)', background: 'transparent',
                    color: 'var(--text-secondary, #8696A0)', cursor: 'pointer',
                  }}
                >
                  Limpar filtro
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Lista de Conversas */}
      <div className="conversations-list">
        {loading ? (
          <div className="loading-spinner">
            <div className="spinner"></div>
          </div>
        ) : !trimmedSearch ? (
          filteredConversations.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              {conversations.length === 0 ? 'Nenhuma conversa ainda' : 'Nenhuma conversa neste filtro'}
            </div>
          ) : (
            filteredConversations.map((conversation) => (
              <ConversationItem
                key={conversation.id || conversation.wamid || conversation.fromNumber}
                conversation={conversation}
                isSelected={selectedConversation?.id === conversation.id}
                onClick={() => handleSelect(conversation)}
                providerType={providerType}
                accountId={conversation.account_id || selectedAccountId}
                slaWaitMinutes={slaWaitMinutes}
                nowTick={nowTick}
                statusColors={statusColors}
              />
            ))
          )
        ) : (
          <>
            <div className="search-section-title">Conversas</div>
            {conversationSectionItems.length === 0 ? (
              <div style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>
                Nenhuma conversa encontrada
              </div>
            ) : (
              conversationSectionItems.map((conversation) => (
                <ConversationItem
                  key={conversation.id || conversation.wamid || conversation.fromNumber}
                  conversation={conversation}
                  isSelected={selectedConversation?.id === conversation.id}
                  onClick={() => handleSelect(conversation)}
                  providerType={providerType}
                  accountId={conversation.account_id || selectedAccountId}
                  slaWaitMinutes={slaWaitMinutes}
                  nowTick={nowTick}
                  statusColors={statusColors}
                />
              ))
            )}

            <div className="search-section-title">Mensagens</div>
            {searching && messageResults.length === 0 ? (
              <div style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>Buscando...</div>
            ) : messageResults.length === 0 ? (
              <div style={{ padding: '10px 16px', color: 'var(--text-secondary)', fontSize: 13 }}>
                Nenhuma mensagem encontrada
              </div>
            ) : (
              messageResults.map((result) => (
                <MessageResultItem
                  key={result.wamid}
                  result={result}
                  onClick={() => handleSelectMessageResult(result)}
                />
              ))
            )}
          </>
        )}
      </div>
        </>
      )}
    </div>
  );
};

export default Sidebar;
