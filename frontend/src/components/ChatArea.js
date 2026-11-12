/**
 * ChatArea.js - Área Principal de Chat
 * 
 * FUNCIONALIDADES COMPLETAS:
 * - Envio de mensagens (texto, mídia, stickers)
 * - Replies (responder mensagens)
 * - Reações com emojis
 * - Menu de ações (copiar, responder, reagir)
 * - Suporte a múltiplos tipos de mensagem
 * - NOVO: Formatação de texto (Markdown)
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { BsThreeDotsVertical, BsChevronDown, BsEmojiSmile, BsReply, BsX, BsMicFill, BsStopFill, BsArrowRight, BsPencil, BsTrash, BsPin, BsPinFill, BsStar, BsPlayFill, BsPauseFill } from 'react-icons/bs';
import { IoSendSharp } from 'react-icons/io5';
import EmojiPicker from 'emoji-picker-react';
import {
  MdImage,
  MdDescription,
  MdContentCopy,
  MdLocationOn,
  MdContactPhone,
  MdSearch,
  MdLock,
  MdLockOpen,
  MdRefresh,
  MdPriorityHigh,
  MdGifBox,
} from 'react-icons/md';
import { BiCheck, BiCheckDouble, BiTime } from 'react-icons/bi';
import { FiDownload } from 'react-icons/fi';
import moment from 'moment';
import 'moment/locale/pt-br';
import ChatAreaMenu from './menus/ChatAreaMenu';
import AttachmentMenu from './menus/AttachmentMenu';
import StickerPicker from './StickerPicker';
import GifPicker from './GifPicker';
import EditMessageModal from './EditMessageModal';
import TaskModal from './TaskModal';
import { getContrastTextColor } from '../utils/tagColor';
import { getRecipientJid } from '../utils/recipient';
import { emojiOnlyClass } from '../utils/emojiSize';
import { EMOJI_CATEGORIES_PT, EMOJI_SEARCH_PLACEHOLDER_PT, EMOJI_SEARCH_CLEAR_LABEL_PT, EMOJI_DATA_PT } from '../utils/emojiPickerLocale';
import apiService, { baileysApi } from '../services/api';
import avatarCache, { PHOTO_CAPABLE_PROVIDERS } from '../utils/avatarCache';
import { limitAvatarFetch } from '../utils/avatarFetchLimiter';
import { isSiteChatId, isSiteChatContact, SITE_CHAT_LABEL } from '../utils/siteChat';
import useClickOutside from '../utils/useClickOutside';
import { linkifyPhoneNumbers, extractPhoneFromClick, normalizePhoneDigits } from '../utils/phoneLink';
import { formatElapsed } from '../utils/timeFormat';
import { formatFileSize, getFileTypeIcon } from '../utils/fileType';
import ImageLightbox from './ImageLightbox';
import VoiceMessagePlayer from './VoiceMessagePlayer';
import { TASK_PRIORITY_META, formatTaskDue } from './InternalChatArea';

moment.locale('pt-br');

const formatPhoneDisplay = (phone) => {
  if (!phone) return '';
  if (isSiteChatId(String(phone))) return '';
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55'))
    return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55'))
    return `+${d.slice(0,2)} ${d.slice(2,4)} ${d.slice(4,8)}-${d.slice(8)}`;
  if (d.length >= 8) return `+${d}`;
  return phone;
};

// Estilos da renderização de mensagens interativas (lista/botões/CTA-URL) enviadas
// pela Cloud API — cartão com corpo + opções, no lugar do texto genérico anterior.
const productQuestionStyles = {
  card: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 260, maxWidth: 420 },
  badge: { fontSize: '0.72em', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 },
  product: { display: 'flex', gap: 10, padding: 8, borderRadius: 8, background: 'rgba(0,0,0,0.05)' },
  image: { width: 84, height: 84, objectFit: 'contain', borderRadius: 6, background: '#fff', flexShrink: 0, cursor: 'zoom-in' },
  name: { fontWeight: 700, fontSize: '0.92em', lineHeight: 1.25 },
  meta: { fontSize: '0.78em', color: 'var(--text-secondary, #888)' },
  stock: { display: 'inline-block', alignSelf: 'flex-start', marginTop: 2, padding: '2px 8px', borderRadius: 10, fontSize: '0.75em', fontWeight: 700 },
  specs: { fontSize: '0.8em', borderCollapse: 'collapse', width: '100%' },
  question: { fontSize: '0.98em', fontWeight: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  answered: { fontSize: '0.85em', padding: '6px 8px', borderRadius: 6, background: 'rgba(37, 211, 102, 0.15)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  link: { fontSize: '0.82em', fontWeight: 600 },
  hint: { fontSize: '0.78em', opacity: 0.75, lineHeight: 1.35 },
  error: { fontSize: '0.8em', padding: '5px 8px', borderRadius: 6, background: 'rgba(220, 53, 69, 0.15)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  action: { alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 16, border: 'none', cursor: 'pointer', fontSize: '0.85em', fontWeight: 600, background: 'rgba(37, 211, 102, 0.18)', color: 'inherit' },
};

const STOCK_COLORS = {
  instock: { background: 'rgba(37, 211, 102, 0.2)', color: '#1a7f45' },
  onbackorder: { background: 'rgba(255, 165, 0, 0.2)', color: '#a86400' },
  outofstock: { background: 'rgba(220, 53, 69, 0.18)', color: '#b02a37' },
};

const interactiveStyles = {
  card: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 },
  header: { fontWeight: 700, fontSize: '0.95em' },
  body: { fontSize: '0.95em' },
  footer: { fontSize: '0.75em', color: 'var(--text-secondary, #888)' },
  divider: { borderTop: '1px solid var(--border-color, rgba(0,0,0,0.1))', margin: '6px 0' },
  section: { marginBottom: 6 },
  sectionTitle: { fontSize: '0.75em', fontWeight: 700, color: 'var(--text-secondary, #888)', textTransform: 'uppercase', marginBottom: 2 },
  row: { padding: '4px 0' },
  rowTitle: { fontSize: '0.9em', fontWeight: 600 },
  rowDescription: { fontSize: '0.8em', color: 'var(--text-secondary, #888)' },
  buttonRow: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  actionPill: {
    display: 'inline-block', alignSelf: 'flex-start', marginTop: 4,
    padding: '6px 12px', borderRadius: 16, fontSize: '0.85em', fontWeight: 600,
    background: 'rgba(37, 211, 102, 0.15)', color: 'rgb(37, 211, 102)',
  },
  actionLink: { textDecoration: 'none', cursor: 'pointer' },
};

// Igual ao WhatsApp Web: no header só mostra um nome de exibição quando o
// contato está de fato salvo (Contact.saved_name). Sem isso, mostra só o
// número — o "nome do perfil" autodeclarado (push_name/profile.name da Meta)
// só aparece ao abrir os Dados do Contato, não aqui.
const getDisplayName = (conv) => {
  if (!conv) return 'Desconhecido';
  if (conv.is_group) {
    const name = conv.name || conv.contact?.name;
    return name || 'Grupo';
  }
  const saved = conv.contact?.saved_name;
  if (saved) return saved;
  const phone = conv.fromNumber || conv.contact?.phone_number || conv.contact?.wa_id;
  return formatPhoneDisplay(phone) || conv.name || conv.contact?.name || (isSiteChatContact(conv.contact) ? 'Visitante do site' : 'Desconhecido');
};

const ChatArea = ({
  conversation,
  messages,
  onSendMessage,
  loading,
  onLoadOlderMessages,
  hasMoreMessages,
  loadingOlderMessages,
  // Props de menus e ações
  onOpenQRManager,
  onOpenContactInfo,
  onOpenCartBuilder,
  onOpenFlowSender,
  onOpenAnalytics,
  onOpenBusinessProfile,
  onSendButtons,
  onSendCtaUrl,
  onSendReaction,
  onRemoveReaction,
  onForwardMessage,
  onEditMessage,
  onDeleteMessage,
  onPinMessage,
  onStarMessage,
  onRetryFailedMessage,
  onOpenTemplateSender,
  onOpenLocationSender,
  onOpenContactSender,
  onOpenListSender,
  onOpenProductSender,
  onOpenProductListSender,
  onOpenCarouselSender,
  onRequestLocation,
  onOpenPollSender,
  providerType,
  // Props do ChatAreaMenu
  onPinChat,
  onMuteChat,
  onArchiveChat,
  onMarkAsRead,
  onMarkAsUnread,
  onClearChat,
  onDeleteChat,
  onBlockContact,
  onLeaveGroup,
  onViewContact,
  onSearchInChat,
  onViewMedia,
  onToggleFavorite,
  onOpenParticipantInfo,
  onOpenParticipantChat,
  // Atendimento — fila/atribuição/status
  agents,
  currentUserId,
  onUpdateStatus,
  csatEnabled,
  onAssignConversation,
  onToggleBot,
  isActionPending,
  tagCatalog,
  onAddTag,
  onRemoveTag,
  onCreateTag,
  onSendNote,
  quickReplies,
  internalChats,
  statusColors,
  currentTheme,
  openSearchSignal,
  // Tarefas vinculadas a esta conversa de CLIENTE — controle exclusivo de
  // quem cria, nunca chega nada disso pro cliente (ver create_standalone_task
  // no backend). Mesma faixa colapsável "Tarefas da conversa" do chat
  // interno (InternalChatArea.js), reaproveitando as ações genéricas
  // (pausar/cancelar/aprovar/etc já funcionam pra qualquer tipo de tarefa).
  tasks,
  onCreateTask,
  onToggleTask,
  onOpenTask,
  onApproveTask,
  onRejectTask,
  onPauseTask,
  onResumeTask,
  onCancelTask,
  onUncancelTask,
}) => {
  const emojiPickerTheme = currentTheme === 'dark' ? 'dark' : 'light';
  // ESTADOS
  const [messageText, setMessageText] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragCounterRef = useRef(0);
  const [sending, setSending] = useState(false);
  // 'gif' | 'view-once' | null — próximo arquivo selecionado deve ser enviado
  // por um caminho especial (Baileys) em vez do fluxo padrão de mídia.
  const [pendingSpecialType, setPendingSpecialType] = useState(null);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [groupParticipants, setGroupParticipants] = useState([]);
  const [mentionedJids, setMentionedJids] = useState([]);
  // wamid da mensagem cujo popover de reação está aberto — mostra a aba de
  // emoji completa direto (reusa o EmojiPicker do composer), sem etapa
  // intermediária de lista fixa (ver renderEmojiPicker).
  const [showEmojiPicker, setShowEmojiPicker] = useState(null);
  // wamid da mensagem com "!" de falha em recuperação — desabilita o clique
  // repetido e mostra o spinner só nela enquanto o retry está em voo.
  const [retryingWamid, setRetryingWamid] = useState(null);
  // Imagem/vídeo em tela cheia (ver ImageLightbox) — antes clicar numa
  // imagem de mensagem não fazia nada.
  const [lightboxMedia, setLightboxMedia] = useState(null); // { src, type } | null
  // Mensagem sendo editada — abre o EditMessageModal (textarea + emoji) em
  // vez do window.prompt antigo, que cortava mensagem longa e não deixava
  // digitar quebra de linha (Enter confirmava o prompt).
  const [editingMessage, setEditingMessage] = useState(null);
  const [showInputEmojiPicker, setShowInputEmojiPicker] = useState(false);
  // Composer inteiro (campo + botões + popover) — clicar fora dele fecha o
  // popover de emoji/sticker/GIF, igual clicar fora de qualquer outro menu
  // do app. Antes só fechava clicando de novo no botão que abriu.
  const composerRef = useRef(null);
  useClickOutside(composerRef, useCallback(() => setShowInputEmojiPicker(false), []), showInputEmojiPicker);
  const [replyingTo, setReplyingTo] = useState(null);
  // Dúvidas de produto ainda sem resposta nesta conversa: sem "Responder" explícito, o texto
  // digitado iria pro chat do site — então o envio pergunta o destino (uma vez por conjunto de dúvidas).
  const [destChooser, setDestChooser] = useState(false);
  const forcedReplyRef = useRef(null);
  const chatChoiceKeyRef = useRef('');
  const openQuestionCards = useMemo(
    () => (messages || []).filter(m => m.interactive_payload?.type === 'product_question'
      && ['pending', 'delivery_failed'].includes(m.interactive_payload?.status || 'pending')),
    [messages]
  );
  const destKey = `${conversation?.id}:${openQuestionCards.map(m => m.wamid).join(',')}`;
  const [showMessageMenu, setShowMessageMenu] = useState(null);
  // Popover "mandar pesquisa de satisfação?" ao clicar em Resolvida — só
  // aparece quando o CSAT está ligado nas automações (senão não tem o que
  // perguntar, sempre resolve direto).
  const [showCsatChoice, setShowCsatChoice] = useState(false);
  const [menuDirection, setMenuDirection] = useState('open-upwards');
  const [menuHAlign, setMenuHAlign] = useState(null); // null | 'left' | 'right' — força alinhamento quando o padrão sent/received estouraria a tela
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [headerAvatarUrl, setHeaderAvatarUrl] = useState(null);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const [emojiPickerTab, setEmojiPickerTab] = useState('emoji');
  const [savedStickers, setSavedStickers] = useState([]);
  const [forwardTarget, setForwardTarget] = useState(null);
  const [forwardToNumber, setForwardToNumber] = useState('');
  const [forwardInternalIds, setForwardInternalIds] = useState([]);
  const [showTaskModal, setShowTaskModal] = useState(false);
  // Mesma chave/preferência global do chat interno (InternalChatArea.js) —
  // é sobre como a pessoa gosta de ver a interface, não sobre esta
  // conversa específica.
  const [tasksStripCollapsed, setTasksStripCollapsed] = useState(
    () => localStorage.getItem('wa-tasks-strip-collapsed') === 'true'
  );
  const toggleTasksStrip = () => {
    setTasksStripCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('wa-tasks-strip-collapsed', String(next)); } catch { /* localStorage indisponível — só não persiste */ }
      return next;
    });
  };
  const openTasks = (tasks || []).filter(t => t.status !== 'done' && t.status !== 'cancelled');

  // Galeria pessoal de stickers — independente da conversa aberta, busca uma vez.
  useEffect(() => {
    apiService.getSavedStickers().then(setSavedStickers);
  }, []);

  // Tick pros cronômetros de SLA (atribuição/pendente) na barra de atendimento
  // — força recomputar "há Xh" periodicamente mesmo sem nenhum dado da
  // conversa ter mudado, mesmo padrão do nowTick em Sidebar.js.
  const [slaTick, setSlaTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSlaTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const handleSelectSticker = async (sticker) => {
    setShowInputEmojiPicker(false);
    if (conversation.status === 'resolved') {
      const confirmReopen = window.confirm('Esta conversa está marcada como resolvida. Deseja reabrir o atendimento e enviar a mensagem?');
      if (!confirmReopen) return;
      try {
        await apiService.updateConversationStatus(conversation.id, 'pending');
      } catch (err) {
        console.error('Erro ao reabrir atendimento:', err);
        alert('Não foi possível reabrir o atendimento — mensagem não enviada.');
        return;
      }
    }
    try {
      const blob = await fetch(sticker.media_url).then(r => r.blob());
      const file = new File([blob], 'sticker.webp', { type: sticker.mime_type || 'image/webp' });
      onSendMessage(getRecipientJid(conversation), null, file, 'sticker', '', replyingTo?.wamid || null);
      if (replyingTo) cancelReply();
    } catch (err) {
      console.error('Erro ao reenviar sticker salvo:', err);
      alert('Não foi possível reenviar esse sticker.');
    }
  };

  // GIF do Giphy (aba do popover de emoji/sticker) — baixa o arquivo da URL
  // do Giphy e manda por baileysApi.sendGif (genérica pra qualquer provider
  // com API avançada, apesar do nome).
  const handleSelectGif = async (gif) => {
    if (conversation.status === 'resolved') {
      const confirmReopen = window.confirm('Esta conversa está marcada como resolvida. Deseja reabrir o atendimento e enviar a mensagem?');
      if (!confirmReopen) return;
      try {
        await apiService.updateConversationStatus(conversation.id, 'pending');
      } catch (err) {
        console.error('Erro ao reabrir atendimento:', err);
        alert('Não foi possível reabrir o atendimento — mensagem não enviada.');
        return;
      }
    }
    try {
      const blob = await fetch(gif.url).then(r => r.blob());
      const file = new File([blob], `${gif.id}.gif`, { type: 'image/gif' });
      const file_b64 = await fileToBase64(file);
      await baileysApi.sendGif({
        to: getRecipientJid(conversation), file_b64, caption: '',
        account_id: conversation?.account_id, reply_to: replyingTo?.wamid || null,
      });
      setShowInputEmojiPicker(false);
      if (replyingTo) cancelReply();
    } catch (err) {
      console.error('Erro ao enviar GIF do Giphy:', err);
      alert('Não foi possível enviar esse GIF.');
    }
  };

  const handleStickerCreated = (sticker) => {
    setSavedStickers(prev => [sticker, ...prev]);
  };

  const handleDeleteSavedSticker = (id) => {
    apiService.deleteSavedSticker(id).then(() => {
      setSavedStickers(prev => prev.filter(s => s.id !== id));
    });
  };

  const handleSaveStickerFromMessage = (message) => {
    apiService.saveSticker(message.mediaUrl, message.mime_type, message.wamid)
      .then(res => {
        if (res?.data) setSavedStickers(prev => (prev.some(s => s.id === res.data.id) ? prev : [res.data, ...prev]));
      })
      .catch(() => alert('Não foi possível salvar esse sticker.'));
  };

  // Foto do cabeçalho — funciona tanto para contato individual quanto para grupo
  // (profilePictureUrl aceita @g.us normalmente no Baileys).
  useEffect(() => {
    const jid = conversation?.contact?.wa_id;
    const cached = conversation?.contact?.profile_picture_url || (jid ? avatarCache.get(jid) : null) || null;
    setHeaderAvatarUrl(cached);
    if (cached || !jid || !PHOTO_CAPABLE_PROVIDERS.has(providerType)) return;
    let cancelled = false;
    limitAvatarFetch(() => baileysApi.getProfilePicture(jid, false, conversation?.account_id))
      .then(res => {
        // res?.success === false = falha do bridge (timeout, sessão caída,
        // rajada de 500 como no incidente 2026-09-11), não "contato sem
        // foto" — não pode gravar null no cache, senão a foto fica marcada
        // como inexistente pro resto da sessão do navegador mesmo existindo.
        if (res?.success === false) return;
        const url = res?.url || null;
        avatarCache.set(jid, url);
        if (!cancelled) setHeaderAvatarUrl(url);
      })
      .catch(() => {}); // erro de rede — mesmo motivo, não grava no cache
    return () => { cancelled = true; };
  }, [conversation?.contact?.wa_id, conversation?.account_id, providerType]);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const menuRef = useRef(null);
  // renderEmojiPicker() é irmão do menu de ações no JSX (não filho) — sem
  // esse ref, o handler de clique-fora só olhava menuRef.contains(target) e
  // fechava tudo no primeiro toque dentro do picker (mesmo no "+", mesmo só
  // clicando na busca do EmojiPicker completo), antes de dar tempo de
  // selecionar qualquer coisa. Bug real reportado ao vivo (2026-09-10).
  const emojiPickerContainerRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);
  const discardRecordingRef = useRef(false);
  const audioPreviewRef = useRef(null);
  const [isAudioPreviewPlaying, setIsAudioPreviewPlaying] = useState(false);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState(null);

  // URL do blob só existe enquanto o preview do áudio gravado/anexado está
  // na tela — cria ao selecionar, revoga ao trocar/remover (senão vaza
  // memória, um object URL por gravação nunca liberado).
  useEffect(() => {
    if (!selectedFile || !selectedFile.type.startsWith('audio/')) {
      setAudioPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setAudioPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);
  const inputRef = useRef(null);
  // Refs estáveis para callbacks usados dentro do onstop (evita stale closure)
  const onSendMessageRef = useRef(onSendMessage);
  const conversationRef   = useRef(conversation);
  useEffect(() => { onSendMessageRef.current = onSendMessage; }, [onSendMessage]);
  useEffect(() => { conversationRef.current  = conversation;  }, [conversation]);

  // Divisor de data flutuante: fica embutido no chat (normal, sem sticky)
  // enquanto seu dia estiver na tela; só "sobe" pra um selo fixo no topo
  // quando o próprio divisor daquele dia já rolou pra fora da vista — ou
  // seja, só troca de data depois de passar a última mensagem do dia
  // anterior, nunca dois ao mesmo tempo (cada divisor tem só 1 instância no
  // DOM, controlada por estado — elimina qualquer sobreposição visual).
  const messagesContainerRef = useRef(null);
  const [floatingDateLabel, setFloatingDateLabel] = useState(null);
  // Botão "ir para o final" — só aparece depois de rolar pra cima o
  // suficiente (mesmo comportamento do WhatsApp Web real).
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const SCROLL_TO_BOTTOM_THRESHOLD = 200;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const recomputeFloatingDate = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const dividers = container.querySelectorAll('.date-divider:not(.date-divider-floating)');
    let current = null;
    let currentStillVisible = false;
    dividers.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top - containerTop <= 4) {
        current = el.dataset.label;
        currentStillVisible = rect.bottom - containerTop > 4;
      }
    });
    setFloatingDateLabel(currentStillVisible ? null : current);
  }, []);

  useEffect(() => {
    // Espera o scroll-pro-fim automático (ver efeito de mensagens novas)
    // terminar antes de calcular, senão mede a posição errada (pré-scroll).
    const t = setTimeout(recomputeFloatingDate, 80);
    return () => clearTimeout(t);
  }, [messages, recomputeFloatingDate]);

  // Paginação: rolar perto do topo do chat dispara carregar mensagens mais
  // antigas. Preserva a posição de leitura (não deixa "pular" a tela) —
  // mede scrollHeight/scrollTop ANTES de pedir mais, e depois que o React
  // termina de prependar as novas mensagens no início, recoloca o scroll na
  // mesma mensagem que estava visível (scrollHeight cresceu por cima).
  const loadingOlderRef = useRef(false);
  const handleMessagesScroll = useCallback(() => {
    recomputeFloatingDate();
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowScrollToBottom(distanceFromBottom > SCROLL_TO_BOTTOM_THRESHOLD);
    if (!onLoadOlderMessages) return;
    if (
      container.scrollTop < 60 &&
      hasMoreMessages &&
      !loadingOlderMessages &&
      !loadingOlderRef.current
    ) {
      loadingOlderRef.current = true;
      const prevScrollHeight = container.scrollHeight;
      const prevScrollTop = container.scrollTop;
      Promise.resolve(onLoadOlderMessages()).finally(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (messagesContainerRef.current) {
              messagesContainerRef.current.scrollTop =
                messagesContainerRef.current.scrollHeight - prevScrollHeight + prevScrollTop;
            }
            loadingOlderRef.current = false;
          });
        });
      });
    }
  }, [recomputeFloatingDate, onLoadOlderMessages, hasMoreMessages, loadingOlderMessages]);

  // Caixa de mensagem cresce em altura conforme o texto quebra linha (digitado
  // ou via Shift+Enter) — igual ao WhatsApp. Reseta pra 'auto' antes de medir
  // scrollHeight (senão o cálculo usa a altura antiga e nunca encolhe de
  // volta ao apagar texto), com um teto de 120px (~5 linhas) depois do qual
  // vira scroll interno em vez de continuar crescendo.
  const MESSAGE_INPUT_MAX_HEIGHT = 120;
  useEffect(() => {
    const el = inputRef.current;
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MESSAGE_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [messageText]);

  // Refs para controle inteligente de scroll
  const prevConversationIdRef = useRef(null);
  // -1 = aguardando primeiro carregamento de mensagens para este chat
  const prevMsgCountRef = useRef(0);

  // EFFECTS

  // Auto-scroll com três comportamentos distintos:
  // 1. Troca de conversa → marca count=-1 e aguarda as mensagens do novo chat carregarem
  // 2. Mensagens carregam pela primeira vez (count=-1) → scroll instant (sem animação)
  // 3. Nova mensagem chega NO FIM (count aumenta, última msg mudou) → scroll smooth
  // 4. Mensagens antigas foram PREPENDADAS no início (count aumenta, última
  //    msg é a MESMA de antes) → não mexe no scroll aqui; a posição de
  //    leitura é preservada manualmente pelo próprio handler de "carregar
  //    mais antigas" (handleMessagesScroll), que sabe o scrollHeight antes/depois.
  // 5. Reação ou status atualizado (count igual) → SEM scroll (evita piscar)
  const prevLastWamidRef = useRef(null);
  useEffect(() => {
    const convId = conversation?.id ?? null;
    const isConvChange = convId !== prevConversationIdRef.current;

    if (isConvChange) {
      // Conversa trocou: reset count para sinalizar "aguardando novo carregamento"
      prevConversationIdRef.current = convId;
      prevMsgCountRef.current = -1;
      prevLastWamidRef.current = null;
      setShowScrollToBottom(false);
      return; // Ainda são as mensagens antigas; aguarda próximo render com msgs novas
    }

    const hasNewMsg = messages.length > prevMsgCountRef.current;
    if (hasNewMsg) {
      // Se prevMsgCount era -1, é a carga inicial do novo chat → instant
      const isFirstLoad = prevMsgCountRef.current === -1;
      const newLastWamid = messages[messages.length - 1]?.wamid;
      const wasPrepend = !isFirstLoad && newLastWamid === prevLastWamidRef.current;

      if (!wasPrepend) {
        // Duplo rAF garante que o DOM terminou o layout antes de rolar,
        // evitando o scroll parar a 75% em conversas longas.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({
              behavior: isFirstLoad ? 'instant' : 'smooth',
            });
          });
        });
      }
      prevMsgCountRef.current = messages.length;
      prevLastWamidRef.current = newLastWamid;
    }
    // Se count não aumentou (reação/status) → nenhuma ação
  }, [messages, conversation]);

  // Fechar menu ao clicar fora
  useEffect(() => {
    const handleClickOutside = (event) => {
      const insideMenu  = menuRef.current && menuRef.current.contains(event.target);
      const insidePicker = emojiPickerContainerRef.current && emojiPickerContainerRef.current.contains(event.target);
      if (!insideMenu && !insidePicker) {
        setShowMessageMenu(null);
        setShowEmojiPicker(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // HELPER FUNCTIONS

  /**
   * NOVO: Converte texto com formatação Markdown para HTML
   * Suporta: *negrito*, _itálico_, ~tachado~, `código`
   */
  const parseMarkdown = (text) => {
    if (!text) return '';
    
    let parsed = text;

    // -1. Números de telefone clicáveis (igual ao WhatsApp) — antes dos
    // passos de URL/imagem abaixo, pro regex de telefone (só dígitos/
    // espaço/traço/parênteses) não competir com eles.
    parsed = linkifyPhoneNumbers(parsed);

    // 0. Reescrever URLs do ngrok para caminhos locais relativos para evitar bloqueio do ngrok no navegador
    parsed = parsed.replace(/https?:\/\/[a-zA-Z0-9-]+\.ngrok-free\.dev\/uploads\//g, '/uploads/');
    parsed = parsed.replace(/https?:\/\/[a-zA-Z0-9-]+\.ngrok\.app\/uploads\//g, '/uploads/');
    parsed = parsed.replace(/https?:\/\/[a-zA-Z0-9-]+\.ngrok\.io\/uploads\//g, '/uploads/');
    
    // 1. Imagens a partir de URL: links terminando em .png, .jpg, .jpeg, .webp, .gif
    // Atualizado para suportar caminhos absolutos locais começando com /uploads/
    parsed = parsed.replace(/((?:https?:\/\/[^\s<]+?|\/uploads\/[^\s<]+?)\.(?:png|jpe?g|webp|gif)(?:\?[^\s<]+)?)/gi, '<br/><img src="$1" style="max-width: 100%; max-height: 250px; border-radius: 8px; margin-top: 5px; object-fit: contain;" /><br/>');
    
    // 2. Links normais (que não foram processados como imagem acima)
    parsed = parsed.replace(/(?<!src=")(https?:\/\/[^\s<]+)/gi, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: #34b7f1; text-decoration: underline;">$1</a>');
    
    // 3. Negrito: *texto* ou **texto**
    parsed = parsed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    parsed = parsed.replace(/(?<![a-zA-Z0-9>:])\*(.+?)\*(?![a-zA-Z0-9<])/g, '<strong>$1</strong>');
    
    // 4. Itálico: _texto_ (não aplica se fizer parte de uma URL já dentro de um href="" ou src="")
    // Uma forma segura é não aplicar itálico se o _ estiver grudado em letras de ambos os lados e também lidar com os links antes
    // Como os links já viraram tags HTML, as regex podem acidentalmente pegar coisas dentro das tags.
    // Vamos usar um truque para não aplicar dentro de tags:
    parsed = parsed.replace(/(?<![a-zA-Z0-9\/"=])_(.+?)_(?![a-zA-Z0-9"=<])/g, '<em>$1</em>');
    
    // 5. Tachado: ~texto~
    parsed = parsed.replace(/~(.+?)~/g, '<del>$1</del>');
    
    // 6. Código inline: `código`
    parsed = parsed.replace(/`(.+?)`/g, '<code>$1</code>');
    
    // 7. Quebras de linha
    parsed = parsed.replace(/\n/g, '<br/>');
    
    return parsed;
  };

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

  const formatMessageTime = (timestamp) => {
    return moment(timestamp).format('HH:mm');
  };

  // Rótulo do divisor de data, igual ao WhatsApp: Hoje / Ontem / nome do dia
  // da semana (até 6 dias atrás) / DD/MM/AAAA pra qualquer coisa mais antiga
  // (ex: mensagens trazidas pelo backfill de histórico).
  const formatDateDivider = (timestamp) => {
    const msgDay = moment(timestamp).startOf('day');
    const today = moment().startOf('day');
    const diffDays = today.diff(msgDay, 'days');

    if (diffDays === 0) return 'Hoje';
    if (diffDays === 1) return 'Ontem';
    if (diffDays >= 2 && diffDays <= 6) {
      const weekday = msgDay.format('dddd');
      return weekday.charAt(0).toUpperCase() + weekday.slice(1);
    }
    return msgDay.format('DD/MM/YYYY');
  };

  // HANDLERS

  const applyPickedFile = (file) => {
    if (!file) return;
    setSelectedFile(file);

    // Preview para imagens
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setFilePreview(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFileSelect = (e) => {
    applyPickedFile(e.target.files[0]);
  };

  // Ctrl+V no campo de mensagem — cola imagem/arquivo copiado (print,
  // arquivo do explorador, etc.) igual anexar pelo clipe. Deixa colar texto
  // normalmente quando não há arquivo no clipboard.
  const handleComposerPaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          applyPickedFile(file);
          return;
        }
      }
    }
  };

  // Arrastar um arquivo do explorador direto pro chat — não existia nenhum
  // handler de drag-and-drop antes (só clique no clipe ou colar do
  // clipboard). dragCounterRef conta entra/sai porque dragenter/dragleave
  // disparam pra cada elemento filho sobrevoado, não só a borda externa do
  // chat-area — sem o contador o overlay pisca ao passar por cima de
  // mensagens/bolhas durante o arraste.
  const handleChatDragEnter = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDraggingFile(true);
  };
  const handleChatDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleChatDragLeave = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDraggingFile(false);
  };
  const handleChatDrop = (e) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingFile(false);
    const file = e.dataTransfer?.files?.[0];
    applyPickedFile(file);
  };

  const handleOpenFileInput = (specialType = null) => {
    setPendingSpecialType(specialType);
    fileInputRef.current?.click();
  };

  const typingTimeoutRef = useRef(null);
  const lastComposingSentRef = useRef(0);

  const notifyTyping = () => {
    if (providerType !== 'baileys' || !conversation?.contact?.wa_id) return;
    const jid = conversation.contact.wa_id;
    const now = Date.now();
    if (now - lastComposingSentRef.current > 3000) {
      lastComposingSentRef.current = now;
      baileysApi.sendPresence(jid, 'composing', conversation?.account_id).catch(() => {});
    }
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      baileysApi.sendPresence(jid, 'paused', conversation?.account_id).catch(() => {});
    }, 3000);
  };

  const isGroupChatConv =
    conversation?.is_group ||
    conversation?.group_jid ||
    (conversation?.contact?.wa_id || '').includes('@g.us');

  // Só a Cloud API oficial da Meta tem a janela de 24h de atendimento —
  // fora dela, mensagem livre é rejeitada pela própria Meta (erro 131047),
  // só template passa. Baileys/Venom/WPPConnect/whatsapp-web.js (sessões
  // não-oficiais) não têm essa restrição.
  const isMetaCloudProvider = (providerType || '').startsWith('meta_cloud');
  // Chat do site (plugin WooCommerce): só texto — sem anexos, áudio, stickers/GIFs nem reações do WhatsApp.
  const isSiteChat = providerType === 'site_chat' || isSiteChatContact(conversation?.contact);
  const lastInboundTimestamp = isMetaCloudProvider
    ? messages.reduce((latest, m) => (
        m.direction === 'inbound' && m.timestamp > latest ? m.timestamp : latest
      ), 0)
    : 0;
  const isOutside24hWindow = isMetaCloudProvider && (
    lastInboundTimestamp === 0 || (Date.now() - lastInboundTimestamp) > 24 * 60 * 60 * 1000
  );

  const openMentionPicker = async () => {
    if (!showMentionPicker && groupParticipants.length === 0) {
      try {
        const res = await baileysApi.groupGetMetadata(conversation.contact.wa_id, conversation?.account_id);
        const meta = res?.metadata ?? res;
        setGroupParticipants(meta?.participants || []);
      } catch (e) {
        console.error('Erro ao carregar participantes do grupo:', e);
      }
    }
    setShowMentionPicker(v => !v);
  };

  const toggleMention = (jid) => {
    setMentionedJids(prev => {
      if (prev.includes(jid)) return prev.filter(j => j !== jid);
      setMessageText(t => `${t}${t.endsWith(' ') || !t ? '' : ' '}@${jid.split('@')[0]} `);
      return [...prev, jid];
    });
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Fila de envio: o composer nunca fica bloqueado esperando o round-trip
  // de uma mensagem anterior. Cada handleSend só empilha um job aqui e
  // libera o input na hora — os jobs saem um de cada vez, na ordem que
  // foram digitados/enviados (Enter várias vezes seguidas = várias
  // mensagens na fila, não uma travada esperando a UI "voltar").
  const sendQueueRef = useRef([]);
  const isSendingQueueRef = useRef(false);

  const runSendQueue = useCallback(async () => {
    if (isSendingQueueRef.current) return;
    isSendingQueueRef.current = true;
    setSending(true);
    while (sendQueueRef.current.length > 0) {
      const job = sendQueueRef.current.shift();
      try {
        await job();
      } catch (error) {
        // onSendMessage() (caminho principal) já trata o próprio erro com um
        // toast — chega aqui só nos caminhos que chamam baileysApi.* direto
        // (gif/view-once/menções), que ainda não têm bolha otimista própria.
        console.error('Erro ao enviar mensagem:', error);
        const detail = error?.response?.data?.detail;
        alert(typeof detail === 'string' ? detail : 'Erro ao enviar mensagem');
      }
    }
    isSendingQueueRef.current = false;
    setSending(false);
  }, []);

  const handleSend = async () => {
    if (!messageText.trim() && !selectedFile) return;
    if (!conversation) return;

    // Modo nota interna: nunca vai pro WhatsApp, não checa janela de 24h nem
    // mídia — é só um recado entre atendentes na mesma timeline do chat.
    if (noteMode) {
      if (messageText.trim() && onSendNote) onSendNote(conversation.id, messageText.trim());
      setMessageText('');
      return;
    }

    const replyTarget = forcedReplyRef.current || replyingTo;
    forcedReplyRef.current = null;
    if (!replyTarget && !selectedFile && openQuestionCards.length > 0 && chatChoiceKeyRef.current !== destKey) {
      setDestChooser(true);
      return;
    }

    if (replyTarget?.interactive_payload?.type === 'product_question' && selectedFile) {
      alert('Dúvida de produto só aceita resposta em texto (ela é publicada no site). Remova o anexo ou cancele o "Responder".');
      return;
    }

    if (isOutside24hWindow) {
      alert('Fora da janela de 24h de atendimento — envie um template para reabrir a conversa antes de mandar mensagem livre.');
      return;
    }

    // Responder uma conversa já resolvida não reabre sozinho — confirma antes,
    // já que "resolvida" é um estado que alguém fechou de propósito.
    if (conversation.status === 'resolved') {
      const confirmReopen = window.confirm('Esta conversa está marcada como resolvida. Deseja reabrir o atendimento e enviar a mensagem?');
      if (!confirmReopen) return;
      try {
        await apiService.updateConversationStatus(conversation.id, 'pending');
      } catch (err) {
        console.error('Erro ao reabrir atendimento:', err);
        alert('Não foi possível reabrir o atendimento — mensagem não enviada.');
        return;
      }
    }

    clearTimeout(typingTimeoutRef.current);
    if (providerType === 'baileys' && conversation?.contact?.wa_id) {
      baileysApi.sendPresence(conversation.contact.wa_id, 'paused', conversation?.account_id).catch(() => {});
    }

    // Captura os valores ANTES de limpar — precisa deles pra montar a
    // chamada de envio depois que o input já esvaziou.
    const recipient = getRecipientJid(conversation);
    const textToSend = messageText;
    const fileToSend = selectedFile;
    const specialType = pendingSpecialType;
    const mentions = mentionedJids;
    const replyTo = replyTarget?.wamid;

    // Limpa o compose ANTES de mandar (não depois do await) — igual ao
    // WhatsApp de verdade: o campo esvazia na hora do clique, sem esperar o
    // servidor confirmar. onSendMessage() já cuida do feedback visual do
    // envio em si (bolha otimista com relógio → confirmado/falhou), então
    // não há mais motivo pra segurar o campo até o round-trip terminar.
    setMessageText('');
    setSelectedFile(null);
    setFilePreview(null);
    setReplyingTo(null);
    setPendingSpecialType(null);
    setMentionedJids([]);

    // Empilha o envio de verdade e sai — não espera o await aqui, é isso
    // que deixava o composer preso até a resposta do servidor chegar.
    sendQueueRef.current.push(async () => {
      if (fileToSend && specialType === 'view-once') {
        const file_b64 = await fileToBase64(fileToSend);
        const mediaKind = fileToSend.type.startsWith('video/') ? 'video' : 'image';
        await baileysApi.sendViewOnce({ to: recipient, media_type: mediaKind, file_b64, mime_type: fileToSend.type, caption: textToSend, account_id: conversation?.account_id });
      } else if (fileToSend) {
        await onSendMessage(
          recipient,
          null,
          fileToSend,
          getFileType(fileToSend),
          textToSend, // caption
          replyTo
        );
      } else if (mentions.length > 0) {
        await baileysApi.sendWithMentions(recipient, textToSend, mentions, replyTo || null, conversation?.account_id);
      } else {
        await onSendMessage(
          recipient,
          textToSend,
          null,
          null,
          null,
          replyTo
        );
      }
    });
    runSendQueue();
  };

  const handleEmojiSelect = useCallback((emojiData) => {
    const emoji = emojiData.emoji;
    const input = inputRef.current;
    if (input) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const newText = messageText.slice(0, start) + emoji + messageText.slice(end);
      setMessageText(newText);
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(start + emoji.length, start + emoji.length);
      }, 0);
    } else {
      setMessageText(prev => prev + emoji);
    }
  }, [messageText]);

  const handleStartRecording = async () => {
    let stream = null;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Gravação de áudio requer HTTPS. Acesse o app via HTTPS ou use localhost.');
        return;
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];

      // Detecta o melhor formato suportado pelo browser
      // WhatsApp exige ogg/opus; webm como fallback apenas se ogg não suportado
      const preferredMime = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/webm', '']
        .find(m => m === '' || MediaRecorder.isTypeSupported(m));
      const recorderOptions = preferredMime ? { mimeType: preferredMime } : {};
      const recorder = new MediaRecorder(stream, recorderOptions);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        mediaRecorderRef.current = null;
        clearInterval(recordingTimerRef.current);
        setRecordingSeconds(0);

        // Lixeira durante a gravação (handleCancelRecording) usa o mesmo
        // MediaRecorder.stop() pra liberar o microfone, mas marca esse flag
        // antes — aqui só descarta os pedaços gravados e sai, sem virar
        // prévia nem selectedFile nenhum.
        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          audioChunksRef.current = [];
          return;
        }

        // BUG (2026-09-04): antes mandava o áudio na hora, direto do onstop
        // — sem prévia, sem play/pause pra conferir antes, sem like como
        // desistir sem mandar (só dava pra cancelar ANTES de parar). Igual
        // ao WhatsApp de verdade: parar só encerra a gravação e abre uma
        // prévia (reaproveita o preview de arquivo já existente, que já tem
        // a lixeira de "remover" — só falta o play/pause, adicionado no
        // preview mais abaixo pro caso de ser áudio) — só o botão de
        // enviar manda de fato.
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const ext  = mimeType.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `audio_${Date.now()}.${ext}`, { type: mimeType });
        console.log(`Áudio gravado: ${file.name}, tamanho: ${file.size} bytes, tipo: ${mimeType}`);
        setSelectedFile(file);
        setFilePreview(null);
      };

      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds(s => s + 1);
      }, 1000);
    } catch (err) {
      console.error('Erro ao iniciar gravação:', err);
      if (stream) stream.getTracks().forEach(t => t.stop());
      alert('Não foi possível acessar o microfone.');
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Lixeira durante a gravação — descarta sem virar prévia (diferente de
  // parar, que encerra e abre a prévia pra ouvir/decidir antes de mandar).
  const handleCancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      discardRecordingRef.current = true;
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleAddReaction = async (wamid, emoji, fromMe = false, currentReaction = null) => {
    if (!conversation) return;
    try {
      if (currentReaction === emoji) {
        console.log(`Removendo reação da mensagem ${wamid}`);
        await onRemoveReaction?.(wamid);
        setShowEmojiPicker(null);
        return;
      }
      console.log(`Adicionando reação ${emoji} à mensagem ${wamid}`);
      await onSendReaction(wamid, emoji, fromMe);
      setShowEmojiPicker(null);
      console.log('Reação enviada com sucesso');
    } catch (error) {
      console.error('Erro ao enviar reação:', error);
      alert('Erro ao enviar reação');
    }
  };

  const handleOpenMessageMenu = (e, message) => {
    e.stopPropagation();
    
    if (showMessageMenu === message.wamid) {
      setShowMessageMenu(null);
      return;
    }

    setShowMessageMenu(message.wamid);
    setMenuDirection('open-upwards');
    setMenuHAlign(null);

    setTimeout(() => {
      if (menuRef.current) {
        const rect = menuRef.current.getBoundingClientRect();
        setMenuDirection(rect.top < 40 ? 'open-downwards' : 'open-upwards');
        // O menu de mensagens recebidas cresce pra esquerda a partir do
        // botão de ações — em bolhas estreitas perto da borda esquerda do
        // CHAT (não da janela — a sidebar ocupa boa parte da tela antes
        // disso), isso jogava o menu por trás da sidebar. Mesma ideia do
        // flip vertical acima, mas horizontal, contra o limite real da
        // área de chat em vez de x=0 da janela.
        const chatBounds = menuRef.current.closest('.chat-area')?.getBoundingClientRect();
        const leftBound = chatBounds ? chatBounds.left : 0;
        const rightBound = chatBounds ? chatBounds.right : window.innerWidth;
        if (rect.left < leftBound + 8) setMenuHAlign('left');
        else if (rect.right > rightBound - 8) setMenuHAlign('right');
        else setMenuHAlign(null);
      }
    }, 0);
  };

  const handleReplyToMessage = (message) => {
    setReplyingTo(message);
    setShowMessageMenu(null);
    document.querySelector('.message-input-box textarea')?.focus();
  };

  const cancelReply = () => {
    setReplyingTo(null);
  };

  const handleToggleSearch = () => {
    setShowSearch(v => !v);
    setSearchQuery('');
  };

  // "Buscar no chat" acionado a partir de ContactInfoPanel.js (fora deste
  // componente) — sinal (contador crescente) em vez de boolean pra
  // disparar toda vez que a pessoa clicar de novo lá, mesmo que a busca já
  // esteja aberta aqui.
  useEffect(() => {
    if (openSearchSignal) setShowSearch(true);
  }, [openSearchSignal]);

  const handleCopyMessage = (message) => {
    const textToCopy = message.message || message.message_text || message.caption || '';
    navigator.clipboard.writeText(textToCopy);
    setShowMessageMenu(null);
    console.log('Texto copiado!');
  };

  // Encaminhar: pra outro número de WhatsApp (texto livre, igual antes) e/ou
  // pra uma ou mais conversas da Equipe — com referência ao contato de
  // origem (quem recebe no chat interno vê um card clicável de volta pro
  // cliente).
  const openForwardModal = (message) => {
    setForwardTarget(message);
    setForwardToNumber('');
    setForwardInternalIds([]);
  };

  const confirmForwardMessage = () => {
    if (!forwardTarget) return;
    const toNumber = forwardToNumber.trim();
    if (!toNumber && forwardInternalIds.length === 0) return;
    onForwardMessage?.(forwardTarget, { toNumber: toNumber || null, internalConversationIds: forwardInternalIds });
    setForwardTarget(null);
  };

  // RENDER FUNCTIONS

  // Clique no "!" vermelho (ver renderDeliveryFailedBadge). Cobre os dois
  // sentidos: mensagem recebida que se perdeu entre o WhatsApp e o banco, e
  // mensagem nossa que falhou ao enviar — App.js (onRetryFailedMessage)
  // decide qual endpoint chamar a partir de message.direction.
  const handleRetryClick = (message, e) => {
    e.stopPropagation();
    if (retryingWamid || !onRetryFailedMessage) return;
    setRetryingWamid(message.wamid);
    Promise.resolve(onRetryFailedMessage(message)).finally(() => setRetryingWamid(null));
  };

  // Igual ao WhatsApp real: "!" vermelho sempre voltado para o centro da
  // coluna de conversa — à direita da bolha recebida (que fica à esquerda
  // da tela) e à esquerda da bolha enviada (que fica à direita).
  const renderDeliveryFailedBadge = (message, isSent) => {
    if (message.status !== 'failed') return null;
    const isRetrying = retryingWamid === message.wamid;
    return (
      <button
        className={`message-delivery-failed-badge ${isSent ? 'sent' : 'received'}`}
        onClick={(e) => handleRetryClick(message, e)}
        disabled={isRetrying}
        title="Não foi possível entregar esta mensagem — toque para tentar novamente"
      >
        {isRetrying ? <MdRefresh size={13} className="spin" /> : <MdPriorityHigh size={13} />}
      </button>
    );
  };

  const renderMessageStatus = (message) => {
    if (message.direction !== 'outbound') return null;

    const status = message.status || 'sent';

    switch (status) {
      case 'pending':
        return <BiTime size={16} className="message-status-icon pending" />;
      case 'sent':
        return <BiCheck size={16} className="message-status-icon" />;
      case 'delivered':
        return <BiCheckDouble size={16} className="message-status-icon" />;
      case 'read':
        return <BiCheckDouble size={16} className="message-status-icon read" />;
      case 'failed':
        return <span className="message-status-icon failed">!</span>;
      default:
        return null;
    }
  };

  const renderReaction = (message) => {
    if (!message.reaction_emoji) return null;

    return (
      <div className="message-reaction">
        {message.reaction_emoji}
      </div>
    );
  };

  // Notificações de grupo (adicionado/removido/promovido etc.) trazem números
  // de telefone cru como texto quando o contato não está salvo (ex: "5544...
  // adicionou 5511... ao grupo") — aqui a gente detecta esses trechos e vira
  // botão clicável pra abrir o ParticipantInfoModal (mesmo fluxo do nome do
  // remetente em mensagens de grupo), em vez de deixar como texto morto.
  const renderNotificationText = (text) => {
    const parts = String(text || '').split(/(\d{10,15})/g);
    return parts.map((part, i) => {
      if (/^\d{10,15}$/.test(part)) {
        return (
          <span
            key={i}
            className="system-notification-phone-link"
            onClick={(e) => {
              if (!onOpenParticipantInfo) return;
              e.stopPropagation();
              onOpenParticipantInfo({ participant_jid: `${part}@s.whatsapp.net` });
            }}
          >
            {formatPhoneDisplay(part)}
          </span>
        );
      }
      return <React.Fragment key={i}>{part}</React.Fragment>;
    });
  };

  // Clicar na citação leva até a mensagem original — igual ao WhatsApp de
  // verdade. Só funciona se ela já estiver carregada na tela (`messages`
  // atual); sem isso, `renderReplyIndicator` já cai no placeholder "Mensagem
  // anterior" abaixo, que não tem pra onde levar mesmo. Destaque temporário
  // (classe CSS, remove sozinha) só pra confirmar visualmente qual bolha é.
  const scrollToMessage = (wamid) => {
    const el = document.getElementById(`msg-${wamid}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('message-highlight');
    setTimeout(() => el.classList.remove('message-highlight'), 1500);
  };

  const renderReplyIndicator = (message) => {
    if (!message.context && !message.reply_to_wamid) return null;

    const replyToWamid = message.context?.message_id || message.reply_to_wamid;
    const originalMessage = messages.find(m => m.wamid === replyToWamid);

    if (originalMessage) {
      const replyText = originalMessage.message ||
                       originalMessage.message_text ||
                       originalMessage.caption ||
                       `[${originalMessage.type || 'Mídia'}]`;
      return (
        <div
          className="reply-indicator"
          onClick={(e) => { e.stopPropagation(); scrollToMessage(replyToWamid); }}
          style={{ cursor: 'pointer' }}
          title="Ir para a mensagem original"
        >
          <div className="reply-line"></div>
          <div className="reply-content">
            <div className="reply-author">
              {(originalMessage.direction === 'outbound' || originalMessage.sender === 'me' || originalMessage.from_number === 'me')
                ? 'Você'
                : (originalMessage.contact_name || originalMessage.push_name || conversation.contact?.name || 'Contato')}
            </div>
            <div className="reply-text">{replyText.substring(0, 50)}{replyText.length > 50 ? '...' : ''}</div>
          </div>
        </div>
      );
    }

    // Mensagem original não está no histórico carregado — mostra placeholder
    const isMyReply = message.context?.from_me ?? (message.direction === 'outbound');
    return (
      <div className="reply-indicator reply-indicator--unknown">
        <div className="reply-line"></div>
        <div className="reply-content">
          <div className="reply-author">{isMyReply ? 'Você' : (conversation.contact?.name || 'Contato')}</div>
          <div className="reply-text reply-text--faded">Mensagem anterior</div>
        </div>
      </div>
    );
  };

  // BUG (2026-09-10, reportado ao vivo): a lista fixa de 10 emojis + "+"
  // intermediária era redundante com a régua rápida do menu de ações (6
  // emojis + carinha "Mais emojis" logo acima do "Responder") — clicar na
  // carinha mostrava essa segunda lista quase igual, só pra então precisar
  // de mais um clique no "+" pra chegar na aba de emoji de verdade.
  // Removida: a carinha agora abre a aba completa direto, sem etapa
  // intermediária. A régua rápida (message-action-menu-reactions, em
  // renderMessageMenu) já cobre "os que estão na barra acima de responder".
  const renderEmojiPicker = (wamid, fromMe = false, currentReaction = null) => {
    return (
      <div className="emoji-picker emoji-picker--full" ref={emojiPickerContainerRef}>
        <EmojiPicker
          onEmojiClick={(emojiData) => { handleAddReaction(wamid, emojiData.emoji, fromMe, currentReaction); setShowEmojiPicker(null); }}
          searchDisabled={false}
          height={350}
          width={320}
          theme={emojiPickerTheme}
          categories={EMOJI_CATEGORIES_PT}
          emojiData={EMOJI_DATA_PT}
          searchPlaceholder={EMOJI_SEARCH_PLACEHOLDER_PT}
          searchClearButtonLabel={EMOJI_SEARCH_CLEAR_LABEL_PT}
        />
      </div>
    );
  };

  const renderMessageMenu = (message) => {
    if (showMessageMenu !== message.wamid) return null;

    const directionClass = menuDirection === 'open-downwards'
      ? 'open-downwards'
      : 'open-upwards';
    const hAlignClass = menuHAlign ? `force-align-${menuHAlign}` : '';

    const fromMe = message.direction === 'outbound' || message.from_number === 'me';

    return (
      <div
        className={`message-action-menu ${directionClass} ${hAlignClass}`}
        ref={menuRef}
      >
        {/* Régua de reações rápidas — igual ao handoff: emojis direto no topo
            do menu, sem precisar de um passo "Reagir" separado. */}
        {!isSiteChat && <div className="message-action-menu-reactions">
          {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji) => (
            <button
              key={emoji}
              className="message-action-menu-reaction-btn"
              onClick={() => { handleAddReaction(message.wamid, emoji, fromMe, message.reaction_emoji); setShowMessageMenu(null); }}
            >
              {emoji}
            </button>
          ))}
          <button
            className="message-action-menu-reaction-btn"
            title="Mais emojis"
            onClick={() => setShowEmojiPicker(message.wamid)}
          >
            <BsEmojiSmile size={16} />
          </button>
        </div>}
        <button onClick={() => handleReplyToMessage(message)}>
          <BsReply /> Responder
        </button>
        <button onClick={() => { setShowMessageMenu(null); openForwardModal(message); }}>
          <BsArrowRight /> Encaminhar
        </button>
        {message.type === 'sticker' && message.mediaUrl && (
          <button onClick={() => { setShowMessageMenu(null); handleSaveStickerFromMessage(message); }}>
            🎭 Salvar sticker
          </button>
        )}
        {(message.message || message.message_text || message.caption) && (
          <button onClick={() => handleCopyMessage(message)}>
            <MdContentCopy /> Copiar texto
          </button>
        )}
        {message.direction === 'outbound' && (message.message || message.message_text) && (
          <button onClick={() => { setShowMessageMenu(null); setEditingMessage(message); }}>
            <BsPencil /> Editar
          </button>
        )}
        <button onClick={() => { setShowMessageMenu(null); onPinMessage?.(message, !message.is_pinned); }}>
          <BsPin /> {message.is_pinned ? 'Desafixar' : 'Fixar na conversa'}
        </button>
        <button onClick={() => { setShowMessageMenu(null); onStarMessage?.(message, !message.is_starred); }}>
          <BsStar /> {message.is_starred ? 'Desfavoritar' : 'Adicionar aos favoritos'}
        </button>
        {message.direction === 'outbound' && (
          <button className="message-action-menu-danger" onClick={() => { setShowMessageMenu(null); onDeleteMessage?.(message); }}>
            <BsTrash /> Apagar para todos
          </button>
        )}
      </div>
    );
  };

  const renderMessageContent = (message) => {
    // ENQUETE — não é um message_type próprio (evita migração de schema),
    // vem dentro de interactive_payload mesmo com type continuando 'text'.
    // Checada antes de tudo pra não cair no bloco de texto genérico abaixo.
    if (message.interactive_payload?.type === 'poll') {
      const p = message.interactive_payload;
      // votes/total_voters só existem depois que alguém vota (chega via
      // webhook separado de /poll-vote) — sem voto ainda, cai no estático.
      const voteMap = {};
      (p.votes || []).forEach(v => { voteMap[v.name] = v.count; });
      const maxVotes = Math.max(0, ...(p.votes || []).map(v => v.count));

      return (
        <div className="message-content" style={interactiveStyles.card}>
          <div style={interactiveStyles.header}>📊 {p.question}</div>
          <div style={interactiveStyles.divider} />
          {(p.options || []).map((opt, idx) => {
            const count = voteMap[opt] || 0;
            const isLeading = p.votes && count > 0 && count === maxVotes;
            return (
              <div key={idx} style={interactiveStyles.row}>
                <span style={interactiveStyles.rowTitle}>
                  {isLeading ? '☑️' : '☐'} {opt}
                  {p.votes ? ` — ${count} voto${count === 1 ? '' : 's'}` : ''}
                </span>
              </div>
            );
          })}
          {typeof p.total_voters === 'number' && (
            <div style={interactiveStyles.footer}>👥 {p.total_voters} pessoa{p.total_voters === 1 ? '' : 's'} votou/votaram</div>
          )}
        </div>
      );
    }

    // DÚVIDA DE PRODUTO do site — também vem em interactive_payload (type
    // continua 'text'). Mostra imagem, specs, link e estoque pro atendente
    // responder sem abrir o site.
    if (message.interactive_payload?.type === 'product_question') {
      const q = message.interactive_payload;
      const prod = q.product || {};
      const stock = prod.stock || {};
      const answered = q.status === 'answered';
      return (
        <div className="message-content" style={productQuestionStyles.card}>
          <div style={productQuestionStyles.badge}>
            ❓ Dúvida de produto {answered
              ? `· ✅ respondida ${q.answered_via === 'site' ? 'no site (WordPress)' : 'pelo painel'}`
              : q.status === 'sending' ? '· ⏳ publicando no site…'
              : q.status === 'delivery_failed' ? '· ⚠️ falha ao publicar no site'
              : '· aguardando resposta'}
          </div>
          {!answered && (
            <div style={productQuestionStyles.hint}>
              Pública no site e fora do chat box do cliente. “Responder” abaixo publica a resposta no site;
              o que for digitado sem “Responder” neste card vai para o chat box.
            </div>
          )}
          <div style={productQuestionStyles.product}>
            {prod.image && (
              <img
                src={prod.image}
                alt={prod.name}
                style={productQuestionStyles.image}
                onClick={() => window.open(prod.image, '_blank', 'noopener')}
              />
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={productQuestionStyles.name}>{prod.name}</div>
              <div style={productQuestionStyles.meta}>
                {prod.sku ? `SKU ${prod.sku}` : ''}{prod.sku && prod.price ? ' · ' : ''}{prod.price || ''}
              </div>
              {stock.label && (
                <span style={{ ...productQuestionStyles.stock, ...(STOCK_COLORS[stock.status] || { background: 'rgba(0,0,0,0.08)' }) }}>
                  📦 {stock.label}
                </span>
              )}
              {prod.url && (
                <div>
                  <a href={prod.url} target="_blank" rel="noopener noreferrer" style={productQuestionStyles.link}>
                    🔗 Abrir página do produto
                  </a>
                </div>
              )}
            </div>
          </div>
          {prod.summary && <div style={productQuestionStyles.meta}>{prod.summary}</div>}
          {(prod.specs || []).length > 0 && (
            <details>
              <summary style={{ cursor: 'pointer', fontSize: '0.8em', fontWeight: 700 }}>
                Especificações técnicas ({prod.specs.length})
              </summary>
              <table style={productQuestionStyles.specs}>
                <tbody>
                  {prod.specs.map((sp, i) => (
                    <tr key={i}>
                      <td style={{ padding: '2px 8px 2px 0', color: 'var(--text-secondary, #888)', verticalAlign: 'top' }}>{sp.name}</td>
                      <td style={{ padding: '2px 0' }}>{sp.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <div style={productQuestionStyles.question}>“{q.question}”</div>
          {answered ? (
            <div style={productQuestionStyles.answered}>
              <strong>{q.answered_by || 'Atendente'}:</strong> {q.answer}
            </div>
          ) : (
            <>
              {q.status === 'delivery_failed' && q.error && (
                <div style={productQuestionStyles.error}>Não foi possível publicar no site: {q.error}</div>
              )}
              <button type="button" style={productQuestionStyles.action} onClick={() => handleReplyToMessage(message)}>
                ↩ {q.status === 'delivery_failed' ? 'Responder de novo no site' : 'Responder no site'}
              </button>
            </>
          )}
        </div>
      );
    }

    // STICKER
    if (message.type === 'sticker') {
      if (!message.mediaUrl) {
        return <div className="message-content">[Sticker não disponível]</div>;
      }
      return (
        <div className="message-sticker">
          <img 
            src={message.mediaUrl} 
            alt="Sticker" 
            style={{ 
              maxWidth: '200px', 
              maxHeight: '200px',
              display: 'block'
            }} 
          />
        </div>
      );
    }

    // MÍDIA (imagem, vídeo)
    if ((message.type === 'image' || message.type === 'video') && message.mediaUrl) {
      return (
        <div className="message-media">
          {message.type === 'image' ? (
            <img
              src={message.mediaUrl}
              alt="Imagem"
              style={{ cursor: 'zoom-in' }}
              onClick={() => setLightboxMedia({ src: message.mediaUrl, type: 'image' })}
              onError={(e) => {
                e.target.style.display = 'none';
                e.target.parentElement.innerHTML = '<div class="media-error">⚠️ Mídia indisponível</div>';
              }}
            />
          ) : (
            <video src={message.mediaUrl} controls />
          )}
          {message.caption && (
            <div 
              className="message-caption"
              dangerouslySetInnerHTML={{ __html: parseMarkdown(message.caption) }}
            />
          )}
        </div>
      );
    }

    // ÁUDIO
    if (message.type === 'audio' && message.mediaUrl) {
      return (
        <div className="message-media">
          <VoiceMessagePlayer src={message.mediaUrl} seed={message.id} />
        </div>
      );
    }

    // DOCUMENTO — imagem mandada "como arquivo" mostra a própria imagem;
    // senão ícone por tipo (pdf/word/excel/etc) + nome real + tamanho —
    // igual ao preview do WhatsApp de verdade (antes: ícone genérico único
    // pra tudo, nome às vezes "esquisito" — ver fix em webhook_handler.py —
    // e sem tamanho).
    if (message.type === 'document' && message.mediaUrl) {
      const sizeLabel = formatFileSize(message.file_size);
      // Alguém manda uma imagem "como arquivo" (sem compressão) pra não
      // perder qualidade — ainda é uma imagem de verdade, mostra ela mesma
      // em vez de qualquer ícone/miniatura gerada.
      if ((message.mime_type || '').startsWith('image/')) {
        return (
          <div className="message-media">
            <img
              src={message.mediaUrl}
              alt={message.filename || 'Imagem'}
              style={{ cursor: 'zoom-in' }}
              onClick={() => setLightboxMedia({ src: message.mediaUrl, type: 'image' })}
              onError={(e) => {
                e.target.style.display = 'none';
                e.target.parentElement.innerHTML = '<div class="media-error">⚠️ Mídia indisponível</div>';
              }}
            />
            {message.filename && <div className="message-caption">{message.filename}</div>}
          </div>
        );
      }
      return (
        <div className="message-document">
          {getFileTypeIcon(message.filename, message.mime_type)}
          <div>
            <div className="message-document-name">{message.filename || 'Documento'}</div>
            <div className="message-document-meta">
              {sizeLabel && <span className="message-document-size">{sizeLabel}</span>}
              <a href={message.mediaUrl} download target="_blank" rel="noopener noreferrer">
                <FiDownload /> Download
              </a>
            </div>
          </div>
        </div>
      );
    }

    // LOCALIZAÇÃO
    if (message.type === 'location' && message.location) {
      const { latitude, longitude, name, address } = message.location;
      const mapUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
      
      return (
        <div className="message-location">
          <MdLocationOn size={20} />
          <div className="location-header">{name || 'Localização'}</div>
          {address && <div className="location-address">{address}</div>}
          <a href={mapUrl} target="_blank" rel="noopener noreferrer">
            Ver no Google Maps
          </a>
        </div>
      );
    }

    // CONTATO
    if (message.type === 'contacts' && message.contacts) {
      return (
        <div className="message-contacts">
          {message.contacts.map((contact, idx) => (
            <div key={idx} className="contact-card">
              <MdContactPhone size={20} />
              <div className="contact-name">{contact.name?.formatted_name || 'Contato'}</div>
              {contact.phones && contact.phones.map((phone, i) => (
                <div key={i} className="contact-phone">📱 {phone.phone}</div>
              ))}
            </div>
          ))}
        </div>
      );
    }

    // MENSAGENS INTERATIVAS (lista, botões, CTA-URL) enviadas pela Cloud API.
    // Sem interactive_payload (mensagens antigas ou de outro provider) cai no
    // texto genérico normal, no bloco de TEXTO abaixo.
    if (message.type === 'interactive' && message.interactive_payload) {
      const p = message.interactive_payload;

      if (p.kind === 'list') {
        return (
          <div className="message-content" style={interactiveStyles.card}>
            {p.header_text && <div style={interactiveStyles.header}>{p.header_text}</div>}
            <div
              style={interactiveStyles.body}
              dangerouslySetInnerHTML={{ __html: parseMarkdown(p.body_text || '') }}
            />
            {p.footer_text && <div style={interactiveStyles.footer}>{p.footer_text}</div>}
            <div style={interactiveStyles.divider} />
            {(p.sections || []).map((section, sIdx) => (
              <div key={sIdx} style={interactiveStyles.section}>
                {section.title && <div style={interactiveStyles.sectionTitle}>{section.title}</div>}
                {(section.rows || []).map((row, rIdx) => (
                  <div key={rIdx} style={interactiveStyles.row}>
                    <div style={interactiveStyles.rowTitle}>{row.title}</div>
                    {row.description && <div style={interactiveStyles.rowDescription}>{row.description}</div>}
                  </div>
                ))}
              </div>
            ))}
            <div style={interactiveStyles.actionPill}>📋 {p.button_text || 'Ver opções'}</div>
          </div>
        );
      }

      if (p.kind === 'buttons') {
        return (
          <div className="message-content" style={interactiveStyles.card}>
            {p.header_text && <div style={interactiveStyles.header}>{p.header_text}</div>}
            <div
              style={interactiveStyles.body}
              dangerouslySetInnerHTML={{ __html: parseMarkdown(p.body_text || '') }}
            />
            {p.footer_text && <div style={interactiveStyles.footer}>{p.footer_text}</div>}
            <div style={interactiveStyles.divider} />
            <div style={interactiveStyles.buttonRow}>
              {(p.buttons || []).map((btn, i) => (
                <div key={i} style={interactiveStyles.actionPill}>{btn.title}</div>
              ))}
            </div>
          </div>
        );
      }

      if (p.kind === 'cta_url') {
        return (
          <div className="message-content" style={interactiveStyles.card}>
            {p.header_text && <div style={interactiveStyles.header}>{p.header_text}</div>}
            <div
              style={interactiveStyles.body}
              dangerouslySetInnerHTML={{ __html: parseMarkdown(p.body_text || '') }}
            />
            {p.footer_text && <div style={interactiveStyles.footer}>{p.footer_text}</div>}
            <div style={interactiveStyles.divider} />
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...interactiveStyles.actionPill, ...interactiveStyles.actionLink }}
            >
              🔗 {p.display_text || p.url}
            </a>
          </div>
        );
      }
    }

    // CONTATO (vCard) recebido/enviado via Cloud API ou bridges não-oficiais —
    // "contact"/"contacts" não é um MessageType próprio no banco (ver
    // webhook_handler.py::_format_contact_card_text e routes.py /send/contacts),
    // então chega aqui como texto puro "Nome\ntel1, tel2". Sem isso caía
    // no bloco de TEXTO abaixo e virava uma bolha de texto crua e feia.
    const rawTextContent = message.message || message.message_text || '';
    const contactBlocks = rawTextContent.startsWith('📇 ')
      ? rawTextContent.split(/\n\n(?=📇 )/)
      : [];
    const contactCards = contactBlocks
      .map(b => b.match(/^📇 (.+?)(?:\n📱 (.+))?$/s))
      .filter(Boolean);
    if (contactCards.length > 0 && contactCards.length === contactBlocks.length) {
      return (
        <div className="message-contacts">
          {contactCards.map(([, rawName, contactPhones], cardIdx) => {
            const phones = (contactPhones || '').split(',').map(p => p.trim()).filter(Boolean);
            const primaryPhone = phones[0] || '';
            // Sem FN no vCard, o nome vem igual ao próprio telefone (ver
            // _format_contact_card_text) — mostrar os dois é redundante (e foi
            // isso que ficou estranho comparado ao WhatsApp nativo, que só mostra
            // uma vez). Se o "nome" não passa de um telefone já listado, usa ele
            // como título único e não repete a lista de telefones.
            const nameIsJustAPhone = phones.some(p => p.replace(/\D/g, '') === rawName.replace(/\D/g, ''));
            const displayName = rawName || primaryPhone || 'Contato';
            const showPhoneList = !nameIsJustAPhone && phones.length > 0;
            // Mesmo dado que o clique num participante de grupo já usa (ver
            // onOpenParticipantInfo mais abaixo) — abre o modal de "info do
            // contato" (foto + nome salvo/número), de onde também dá pra abrir a
            // conversa. from_number precisa ser só dígitos (o vCard traz formatado,
            // ex. "+55 44 8414-6379").
            const openInfo = () => {
              if (!onOpenParticipantInfo || !primaryPhone) return;
              const clean = primaryPhone.replace(/\D/g, '');
              if (!clean) return;
              onOpenParticipantInfo({
                participant_jid: `${clean}@s.whatsapp.net`,
                from_number: clean,
                contact_name: nameIsJustAPhone ? null : rawName,
              });
            };
            return (
              <div
                key={cardIdx}
                className={`contact-card${onOpenParticipantInfo ? ' contact-card-clickable' : ''}`}
                onClick={openInfo}
                title={onOpenParticipantInfo ? 'Ver informações do contato' : undefined}
              >
                <div className="contact-card-header">
                  <div className="contact-card-avatar"><MdContactPhone size={22} /></div>
                  <div className="contact-card-identity">
                    <div className="contact-name">{displayName}</div>
                    {showPhoneList && phones.map((phone, i) => (
                      <div key={i} className="contact-phone">{phone}</div>
                    ))}
                  </div>
                </div>
                {onOpenParticipantChat && primaryPhone && (
                  <button
                    className="contact-chat-btn-full"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenParticipantChat(primaryPhone.replace(/\D/g, ''), nameIsJustAPhone ? null : rawName);
                    }}
                  >
                    Conversar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    // TEXTO (com suporte a Markdown)
    const textContent = rawTextContent;

    if (!textContent) {
      return <div className="message-content">[Sem conteúdo]</div>;
    }

    return (
      <div
        className={`message-content ${emojiOnlyClass(textContent)}`.trim()}
        dangerouslySetInnerHTML={{ __html: parseMarkdown(textContent) }}
      />
    );
  };

  // RENDER PRINCIPAL

  if (!conversation) {
    return (
      <div className="chat-area empty-state">
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <BsThreeDotsVertical size={60} />
          <h3>Selecione uma conversa</h3>
          <p>Escolha uma conversa na lista para começar</p>
        </div>
      </div>
    );
  }

  // Respostas rápidas: digitar "/atalho" no início do composer sugere os
  // atalhos que batem — clicar substitui o texto inteiro pelo texto salvo
  // (ou, se o atalho tem mídia anexada, baixa ela e joga no anexo do
  // composer, igual escolher um arquivo pelo clipe — usuário ainda confere/
  // ajusta a legenda antes de mandar).
  const quickReplyMatches = messageText.startsWith('/') && !messageText.slice(1).includes(' ')
    ? (quickReplies || []).filter(qr => qr.shortcut.toLowerCase().startsWith(messageText.slice(1).toLowerCase()))
    : [];

  const applyQuickReply = async (qr) => {
    if (!qr.media_url) {
      setMessageText(qr.text || '');
      inputRef.current?.focus();
      return;
    }
    try {
      const blob = await apiService.fetchMediaBlob(qr.media_url);
      const file = new File([blob], qr.media_filename || 'arquivo', { type: qr.media_mime || blob.type || 'application/octet-stream' });
      setSelectedFile(file);
      setMessageText(qr.text || '');
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onloadend = () => setFilePreview(reader.result);
        reader.readAsDataURL(file);
      } else {
        setFilePreview(null);
      }
      inputRef.current?.focus();
    } catch (e) {
      console.error('Erro ao carregar mídia da resposta rápida:', e);
      alert('Não foi possível carregar a mídia dessa resposta rápida.');
    }
  };

  // Estado "em andamento" dos botões de status/atribuição/bot dessa conversa
  // — desabilita e esmaece o controle enquanto a requisição não volta, pra
  // não deixar clique repetido virar ação duplicada no servidor.
  const statusPending = !!(isActionPending && conversation && isActionPending(`status-${conversation.id}`));
  const assignPending = !!(isActionPending && conversation && isActionPending(`assign-${conversation.id}`));
  const botPending = !!(isActionPending && conversation && isActionPending(`bot-${conversation.id}`));

  return (
    <div
      className="chat-area"
      onDragEnter={handleChatDragEnter}
      onDragOver={handleChatDragOver}
      onDragLeave={handleChatDragLeave}
      onDrop={handleChatDrop}
    >
      {isDraggingFile && (
        <div className="chat-drop-overlay">
          <div className="chat-drop-overlay-box">📎 Solte o arquivo aqui para enviar</div>
        </div>
      )}
      {/* ============================================ */}
      {/* HEADER */}
      {/* ============================================ */}
      <div className="chat-header">
        <div className="contact-info" onClick={onOpenContactInfo} role="button" tabIndex={0}>
          <div className="contact-avatar">
            {headerAvatarUrl
              ? <img src={headerAvatarUrl} alt="" className="conversation-avatar-img" />
              : ((getDisplayName(conversation)).charAt(0) || '?')}
          </div>
          <div>
            <div className="contact-name">
              {getDisplayName(conversation)}
            </div>
            <div className="contact-status">
              {isSiteChat ? `🌐 ${SITE_CHAT_LABEL}` : formatPhoneDisplay(conversation.contact?.phone_number || conversation.contact?.wa_id || conversation.fromNumber)}
            </div>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="chat-area-menu-trigger"
            onClick={handleToggleSearch}
            title="Buscar no chat"
          >
            <MdSearch size={22} />
          </button>
          <ChatAreaMenu
            conversation={conversation}
            providerType={providerType}
            onPinChat={onPinChat}
            onMuteChat={onMuteChat}
            onArchiveChat={onArchiveChat}
            onMarkAsRead={onMarkAsRead}
            onMarkAsUnread={onMarkAsUnread}
            onClearChat={onClearChat}
            onDeleteChat={onDeleteChat}
            onBlockContact={onBlockContact}
            onLeaveGroup={onLeaveGroup}
            onViewContact={onViewContact}
            onSearchInChat={handleToggleSearch}
            onViewMedia={onViewMedia}
            onToggleFavorite={onToggleFavorite}
          />
        </div>
      </div>

      {/* ============================================ */}
      {/* BARRA DE ATENDIMENTO (status/atribuição) */}
      {/* ============================================ */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px',
        background: 'var(--bg-secondary, #f5f5f5)', borderBottom: '1px solid var(--border-color, #eee)',
        fontSize: 13, flexWrap: 'wrap',
      }}>
        {/* Contato interno (colega/fornecedor) não é atendimento a cliente — sem
            ticket, status ou atribuição faz sentido, vira um chat comum. */}
        {!conversation.contact?.is_internal && (<>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-tertiary, #8B99A8)' }}>
          Status
        </span>
        <div style={{ position: 'relative' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)', borderRadius: 20, padding: 3, opacity: statusPending ? 0.55 : 1, transition: 'opacity .15s ease' }}>
          {[
            ['open', 'Aberta'],
            ['pending', 'Pendente'],
            ['resolved', 'Resolvida'],
          ].map(([value, label]) => {
            const active = (conversation.status || 'open') === value;
            const color = (statusColors || { open: '#2FAE60', pending: '#ECB22E', resolved: '#8696A0' })[value];
            return (
              <button
                key={value}
                type="button"
                disabled={statusPending}
                onClick={() => {
                  // Resolver com CSAT ligado (e cliente de verdade, não grupo/
                  // interno — mesma exclusão que o backend já aplica) pergunta
                  // primeiro se manda a pesquisa; o resto dos casos resolve direto,
                  // igual sempre foi.
                  const asksAboutCsat = value === 'resolved' && (conversation.status || 'open') !== 'resolved'
                    && csatEnabled && !conversation.is_group && !conversation.contact?.is_internal;
                  if (asksAboutCsat) {
                    setShowCsatChoice(true);
                  } else {
                    onUpdateStatus && onUpdateStatus(conversation.id, value);
                  }
                }}
                style={{
                  border: 'none', borderRadius: 16, padding: '4px 12px', fontSize: 12, fontWeight: 700,
                  cursor: statusPending ? 'wait' : 'pointer',
                  color: active ? '#fff' : 'var(--text-secondary, #666)',
                  background: active ? color : 'transparent',
                  transition: 'background-color .15s ease, color .15s ease',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {showCsatChoice && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 1000, minWidth: 240,
            background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', padding: 10,
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary, inherit)' }}>
              Enviar pesquisa de satisfação?
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => { setShowCsatChoice(false); onUpdateStatus && onUpdateStatus(conversation.id, 'resolved', { sendCsat: true }); }}
                style={{
                  flex: 1, border: 'none', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontWeight: 700,
                  cursor: 'pointer', background: 'var(--whatsapp-green, #25D366)', color: '#fff',
                }}
              >
                Sim, enviar
              </button>
              <button
                type="button"
                onClick={() => { setShowCsatChoice(false); onUpdateStatus && onUpdateStatus(conversation.id, 'resolved', { sendCsat: false }); }}
                style={{
                  flex: 1, border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: '6px 8px',
                  fontSize: 12, fontWeight: 700, cursor: 'pointer', background: 'transparent',
                  color: 'var(--text-secondary, #666)',
                }}
              >
                Não enviar
              </button>
            </div>
          </div>
        )}
        </div>

        <div style={{ marginLeft: 'auto', position: 'relative', opacity: assignPending ? 0.55 : 1, transition: 'opacity .15s ease' }}>
          <select
            value={conversation.assigned_to?.id || ''}
            disabled={assignPending}
            onChange={(e) => onAssignConversation && onAssignConversation(conversation.id, e.target.value ? Number(e.target.value) : null)}
            title="Atribuída a"
            style={{
              appearance: 'none', WebkitAppearance: 'none', border: '1px solid var(--border-color, #ddd)', borderRadius: 20,
              padding: conversation.assigned_to ? '3px 24px 3px 30px' : '4px 24px 4px 12px', fontSize: 12, fontWeight: 700,
              background: 'var(--bg-primary, #fff)', color: 'var(--text-primary, inherit)',
              cursor: assignPending ? 'wait' : 'pointer', maxWidth: 200,
            }}
          >
            <option value="">Não atribuída</option>
            {currentUserId && conversation.assigned_to?.id !== currentUserId && (
              <option value={currentUserId}>Pegar para mim</option>
            )}
            {(agents || []).filter(a => a.id !== currentUserId).map(a => (
              <option key={a.id} value={a.id}>{a.full_name}</option>
            ))}
            {currentUserId && conversation.assigned_to?.id === currentUserId && (
              <option value={currentUserId}>Você</option>
            )}
          </select>
          {conversation.assigned_to && (
            <span style={{
              position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)',
              width: 18, height: 18, borderRadius: '50%', background: 'var(--brand-orange, #0EA5A4)',
              color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center',
              justifyContent: 'center', pointerEvents: 'none',
            }}>
              {conversation.assigned_to.full_name.split(' ').filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase()}
            </span>
          )}
        </div>

        {conversation.assigned_at && conversation.status !== 'resolved' && (() => {
          void slaTick; // força recomputar a cada 30s
          const minutes = Math.max(0, Math.floor((Date.now() - new Date(conversation.assigned_at).getTime()) / 60000));
          return (
            <span
              title="Tempo desde a atribuição"
              style={{
                borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 600,
                background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)', color: 'var(--text-secondary, #8696A0)',
              }}
            >
              👤 há {formatElapsed(minutes)}
            </span>
          );
        })()}

        {conversation.status === 'pending' && conversation.pending_since && (() => {
          void slaTick;
          const minutes = Math.max(0, Math.floor((Date.now() - new Date(conversation.pending_since).getTime()) / 60000));
          return (
            <span
              title="Tempo aguardando resposta do cliente"
              style={{
                borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 600,
                background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)', color: 'var(--text-secondary, #8696A0)',
              }}
            >
              🕐 pendente há {formatElapsed(minutes)}
            </span>
          );
        })()}
        </>)}

        <button
          type="button"
          disabled={botPending}
          className={conversation.bot_loop_detected ? 'bot-alert-button' : undefined}
          onClick={() => onToggleBot && onToggleBot(conversation.id, !(conversation.bot_enabled ?? true))}
          title={
            conversation.bot_loop_detected
              ? '🚨 Bot travado ou em loop nessa conversa — clique pra assumir (pausa o bot)'
              : (conversation.bot_enabled ?? true) ? 'Bot/IA respondendo essa conversa — clique pra pausar' : 'Bot/IA pausado nessa conversa — clique pra retomar'
          }
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', borderRadius: 12,
            padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: botPending ? 'wait' : 'pointer', color: '#fff',
            opacity: botPending ? 0.55 : 1, transition: 'opacity .15s ease',
            background: conversation.bot_loop_detected ? '#e53e3e' : (conversation.bot_enabled ?? true) ? '#2FAE60' : '#8696A0',
          }}
        >
          {conversation.bot_loop_detected ? '🚨 Bot travado — assumir' : `🤖 ${(conversation.bot_enabled ?? true) ? 'Bot ativo' : 'Bot pausado'}`}
        </button>

        {!(conversation.bot_enabled ?? true) && conversation.bot_handoff_at && (() => {
          void slaTick;
          const minutes = Math.max(0, Math.floor((Date.now() - new Date(conversation.bot_handoff_at).getTime()) / 60000));
          return (
            <span
              title="Tempo desde que um atendente assumiu a conversa do bot"
              style={{
                borderRadius: 12, padding: '3px 10px', fontSize: 12, fontWeight: 600,
                background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)', color: 'var(--text-secondary, #8696A0)',
              }}
            >
              🤖→👤 assumido há {formatElapsed(minutes)}
            </span>
          );
        })()}

        {(conversation.tags || []).map(tag => (
          <span
            key={tag.id}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
              padding: '3px 4px 3px 10px', borderRadius: 12, color: getContrastTextColor(tag.color || '#8696A0'), background: tag.color || '#8696A0',
            }}
          >
            {tag.name}
            <span
              onClick={() => onRemoveTag && onRemoveTag(conversation.id, tag.id)}
              style={{ cursor: 'pointer', padding: '0 6px', opacity: 0.85 }}
              title="Remover etiqueta"
            >
              ✕
            </span>
          </span>
        ))}

        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowTagPicker(v => !v)}
            title="Adicionar etiqueta"
            style={{
              border: '1px dashed var(--border-color, #ccc)', borderRadius: 12, padding: '3px 10px',
              fontSize: 12, background: 'transparent', color: 'var(--text-secondary, #8696A0)', cursor: 'pointer',
            }}
          >
            + Etiqueta
          </button>
          {showTagPicker && (
            <div style={{
              // right:0 (não left:0) — o botão "+ Etiqueta" fica perto da
              // borda direita do cabeçalho (a atribuição antes dele usa
              // marginLeft:auto), então abrir pra direita jogava esse menu
              // pra fora da tela.
              position: 'absolute', top: '110%', right: 0, zIndex: 20, background: 'var(--bg-primary, #fff)',
              border: '1px solid var(--border-color, #ddd)', borderRadius: 8, minWidth: 180, maxHeight: 220,
              overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            }}>
              {(tagCatalog || []).filter(t => !(conversation.tags || []).some(ct => ct.id === t.id)).map(t => (
                <div
                  key={t.id}
                  onClick={() => { onAddTag && onAddTag(conversation.id, t.id); setShowTagPicker(false); }}
                  style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: t.color || '#8696A0' }} />
                  {t.name}
                </div>
              ))}
              <div
                onClick={() => {
                  const name = window.prompt('Nome da nova etiqueta:');
                  if (name && name.trim() && onCreateTag) {
                    const palette = ['#25D366', '#34B7F1', '#f6c026', '#e53e3e', '#8e44ad', '#8696A0'];
                    onCreateTag(name.trim(), palette[Math.floor(Math.random() * palette.length)]);
                  }
                  setShowTagPicker(false);
                }}
                style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', borderTop: '1px solid var(--border-color, #eee)', color: 'var(--whatsapp-green, #25D366)', fontWeight: 600 }}
              >
                + Nova etiqueta
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============================================ */}
      {/* TAREFAS DA CONVERSA (controle exclusivo de quem cria — nunca chega */}
      {/* nada disso pro cliente, ver create_standalone_task no backend)    */}
      {/* ============================================ */}
      {(() => {
        if (openTasks.length === 0 && !onCreateTask) return null;
        return (
          <div className="conversation-tasks-strip">
            <div className="conversation-tasks-strip-header">
              <button
                type="button"
                className="conversation-tasks-strip-toggle"
                onClick={toggleTasksStrip}
                title={tasksStripCollapsed ? 'Expandir tarefas' : 'Recolher tarefas'}
              >
                <BsChevronDown style={{ transform: tasksStripCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }} />
                <span>Tarefas da conversa</span>
              </button>
              {onCreateTask && (
                <button onClick={() => setShowTaskModal(true)}>+ Nova</button>
              )}
            </div>
            {openTasks.length > 0 && !tasksStripCollapsed && (
              <div className="conversation-tasks-strip-list">
                {openTasks.map(task => {
                  const doneSubtasks = (task.subtasks || []).filter(s => s.is_done).length;
                  const due = formatTaskDue(task.due_at);
                  const canComplete = currentUserId === task.created_by?.id || currentUserId === task.assigned_to?.id;
                  const isPaused = task.status === 'paused';
                  return (
                    <div
                      key={task.id}
                      className={`conversation-tasks-strip-item${isPaused ? ' paused' : ''}`}
                      onClick={() => onOpenTask?.(task.id)}
                    >
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={!canComplete || isPaused}
                        title={isPaused ? 'Tarefa pausada — retome antes de concluir' : (canComplete ? undefined : 'Só quem criou ou é responsável pode concluir')}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => { e.stopPropagation(); onToggleTask?.(task.id, 'done'); }}
                      />
                      <div className="conversation-tasks-strip-item-content">
                        <div className="conversation-tasks-strip-item-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            title={(TASK_PRIORITY_META[task.priority] || TASK_PRIORITY_META.medium).label}
                            style={{
                              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                              background: (TASK_PRIORITY_META[task.priority] || TASK_PRIORITY_META.medium).color,
                            }}
                          />
                          {isPaused && <span title="Pausada" style={{ flexShrink: 0 }}>⏸️</span>}
                          {task.title}
                        </div>
                        <div className="conversation-tasks-strip-item-meta">
                          {isPaused && (
                            <span className="conversation-tasks-strip-item-paused-tag">
                              Pausada{task.paused_by?.full_name ? ` por ${task.paused_by.full_name}` : ''}
                            </span>
                          )}
                          {[task.assigned_to?.full_name, due, task.subtasks?.length ? `${doneSubtasks}/${task.subtasks.length} subtarefas` : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* ============================================ */}
      {/* BUSCA NO CHAT */}
      {/* ============================================ */}
      {showSearch && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--bg-secondary, #f5f5f5)', borderBottom: '1px solid var(--border-color, #eee)' }}>
          <input
            autoFocus
            type="text"
            placeholder="Buscar mensagens..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ flex: 1, padding: '6px 10px', borderRadius: 20, border: '1px solid var(--border-color, #ddd)', background: 'var(--bg-primary, #fff)', color: 'inherit', fontSize: 14 }}
          />
          <button onClick={handleToggleSearch} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #888)', fontSize: 18 }}>✕</button>
        </div>
      )}

      {destChooser && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDestChooser(false)}>
          <div style={{ background: 'var(--bg-primary, #fff)', color: 'inherit', borderRadius: 12, padding: 20, width: 'min(460px, 92vw)', boxShadow: '0 10px 40px rgba(0,0,0,.3)' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Para onde vai esta mensagem?</div>
            <div style={{ fontSize: 13, opacity: .75, marginBottom: 14 }}>
              Este cliente tem {openQuestionCards.length === 1 ? 'uma dúvida de produto sem resposta' : `${openQuestionCards.length} dúvidas de produto sem resposta`}. A resposta de uma dúvida é publicada só no site; o chat é a conversa do chat box.
            </div>
            {openQuestionCards.map(card => (
              <button key={card.wamid} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, padding: '10px 12px', borderRadius: 8, border: '1.5px solid #F05A28', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                onClick={() => { forcedReplyRef.current = card; setDestChooser(false); handleSend(); }}>
                <b>Responder a dúvida (publica no site)</b>
                <div style={{ fontSize: 12, opacity: .75, marginTop: 2 }}>{(card.message || card.message_text || '').replace(/^❓\s*/, '').slice(0, 110)}</div>
              </button>
            ))}
            <button style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border-color, #ccc)', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
              onClick={() => { chatChoiceKeyRef.current = destKey; setDestChooser(false); handleSend(); }}>
              <b>Enviar no chat do site</b>
              <div style={{ fontSize: 12, opacity: .75, marginTop: 2 }}>O cliente vê no chat box, não na página do produto</div>
            </button>
            <button style={{ background: 'none', border: 'none', color: 'inherit', opacity: .7, cursor: 'pointer', padding: 6 }} onClick={() => setDestChooser(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {/* ============================================ */}
      {/* REPLY CONTEXT BAR */}
      {/* ============================================ */}
      {replyingTo && (
        <div className="reply-context-bar">
          <div className="reply-context-content">
            <BsReply size={16} />
            <div>
              <div className="reply-context-label">
                {replyingTo.interactive_payload?.type === 'product_question' && replyingTo.interactive_payload?.status !== 'answered'
                  ? 'Respondendo dúvida de produto — será publicada SÓ no site (não vai para o chat box do cliente):'
                  : 'Respondendo a:'}
              </div>
              <div className="reply-context-text">
                {replyingTo.message || 
                 replyingTo.message_text || 
                 replyingTo.caption || 
                 '[Mídia]'}
              </div>
            </div>
          </div>
          <button className="cancel-reply-btn" onClick={cancelReply}>
            <BsX size={24} />
          </button>
        </div>
      )}

      {/* ============================================ */}
      {/* ÁREA DE MENSAGENS */}
      {/* ============================================ */}
      <div
        className="messages-container"
        onClick={(e) => {
          const phone = extractPhoneFromClick(e.target);
          if (phone && onOpenParticipantChat) {
            onOpenParticipantChat(normalizePhoneDigits(phone), null);
            return;
          }
          onMarkAsRead?.(e);
        }}
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
      >
        {floatingDateLabel && (
          <div className="date-divider date-divider-floating">
            <span>{floatingDateLabel}</span>
          </div>
        )}
        {loadingOlderMessages && (
          <div style={{ textAlign: 'center', padding: '8px 0 14px' }}>
            <div className="spinner" style={{ width: 18, height: 18, margin: '0 auto' }} />
          </div>
        )}
        {loading ? (
          <div className="loading-spinner">
            <div className="spinner"></div>
          </div>
        ) : messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px' }}>
            Nenhuma mensagem ainda. Comece a conversa!
          </div>
        ) : (
          messages
          .filter(msg => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.toLowerCase();
            const text = (msg.message || msg.message_text || msg.caption || '').toLowerCase();
            return text.includes(q);
          })
          .map((message, index, visibleMessages) => {
            // Divisor de data (sticky): aparece quando o dia da mensagem
            // muda em relação à anterior — cobre tanto tráfego normal
            // quanto histórico trazido fora de ordem pelo backfill.
            const prevMessage = index > 0 ? visibleMessages[index - 1] : null;
            const showDateDivider =
              !!message.timestamp &&
              (!prevMessage || !moment(message.timestamp).isSame(prevMessage.timestamp, 'day'));
            const dateDivider = showDateDivider ? (
              <div key={`date-${message.wamid || index}`} className="date-divider" data-label={formatDateDivider(message.timestamp)}>
                <span>{formatDateDivider(message.timestamp)}</span>
              </div>
            ) : null;

            // Notificação de sistema do grupo (participante removido/promovido,
            // nome alterado, etc.) — sem bolha, centralizada, como no WhatsApp.
            if ((message.wamid || '').startsWith('sysnotif_')) {
              return (
                <React.Fragment key={message.wamid || index}>
                  {dateDivider}
                  <div className="system-notification">
                    <div className="system-notification-text">
                      {renderNotificationText(message.message || message.message_text)}
                    </div>
                  </div>
                </React.Fragment>
              );
            }

            // Nota interna entre atendentes — nunca saiu pro WhatsApp, visual
            // distinto (fundo amarelo, alinhada à esquerda) pra nunca ser
            // confundida com uma mensagem real trocada com o cliente.
            if (message.is_internal_note) {
              return (
                <React.Fragment key={message.id || index}>
                  {dateDivider}
                  <div className="message received" style={{ alignSelf: 'flex-start' }}>
                    <div className="message-bubble-container">
                      <div
                        className="message-bubble"
                        style={{ background: '#fef6d8', border: '1px solid #f0dfa0', color: '#5c4a00' }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2, opacity: 0.75 }}>
                          🔒 Nota interna — {message.author}
                        </div>
                        {/* color inline nos dois abaixo é necessário — .message-content
                            e .message-footer têm cor própria vinda do tema (clara no
                            escuro), que sobrescreve a cor herdada da bolha amarela e
                            deixava o texto/horário da nota ilegível no modo escuro. */}
                        <div className="message-content" style={{ whiteSpace: 'pre-wrap', color: '#5c4a00' }}>{message.text}</div>
                        <div className="message-footer" style={{ color: 'rgba(92,74,0,0.7)' }}>
                          <span className="message-time">{formatMessageTime(message.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            }

            const isSent =
              message.direction === 'outbound' ||
              message.from_number === 'meu_numero' ||
              message.from_number === 'me';

            const isGroupChat =
              conversation?.is_group ||
              conversation?.group_jid ||
              message.is_group ||
              message.group_jid ||
              (conversation?.contact?.wa_id || '').includes('@g.us') ||
              (conversation?.contact?.phone_number || '').length > 15;

            return (
              <React.Fragment key={message.wamid || index}>
                {dateDivider}
                <div
                  id={message.wamid ? `msg-${message.wamid}` : undefined}
                  className={`message ${isSent ? 'sent' : 'received'}`}
                >
                <div className="message-bubble-container">
                  {renderDeliveryFailedBadge(message, isSent)}
                  <div
                    className={`message-bubble${message.status === 'failed' ? ' delivery-failed' : ''}`}
                    onContextMenu={(e) => {
                      // BUG (2026-09-03): sempre abria o menu customizado, mesmo
                      // com um trecho de texto selecionado dentro da bolha —
                      // impedia usar o "Copiar" nativo do navegador (que respeita
                      // a seleção parcial); o menu customizado só copia a bolha
                      // inteira. Com seleção ativa dentro desta bolha, deixa o
                      // menu nativo do navegador aparecer em vez do nosso.
                      const selection = window.getSelection();
                      const hasSelectionHere = !!selection && selection.toString().trim().length > 0 &&
                        (e.currentTarget.contains(selection.anchorNode) || e.currentTarget.contains(selection.focusNode));
                      if (hasSelectionHere) return;
                      e.preventDefault();
                      handleOpenMessageMenu(e, message);
                    }}
                  >
                    {/* Indicador de Reply */}
                    {renderReplyIndicator(message)}

                    {/* Remetente em mensagens de grupo recebidas.
                        Igual ao WhatsApp: nome só aparece se o contato está salvo
                        (contact_name vem vazio do backend quando não está); caso
                        contrário mostra só o número. Nunca usa push_name (nome
                        autodeclarado) como se fosse nome salvo. */}
                    {isGroupChat && !isSent && (
                      <div
                        className="message-participant"
                        onClick={(e) => {
                          if (!onOpenParticipantInfo) return;
                          e.stopPropagation();
                          onOpenParticipantInfo(message);
                        }}
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: 'bold',
                          color: 'rgb(37, 211, 102)',
                          marginBottom: '4px',
                          cursor: onOpenParticipantInfo ? 'pointer' : 'default',
                        }}
                      >
                        {message.contact_name
                          || formatPhoneDisplay(message.from_number || message.participant_jid?.split('@')[0])
                          || '?'}
                      </div>
                    )}

                    {/* Conteúdo da Mensagem */}
                    {renderMessageContent(message)}
                    
                    {/* Footer (Hora + Status) */}
                    <div className="message-footer">
                      {message.is_pinned && <BsPinFill size={11} style={{ marginRight: 4, opacity: 0.7 }} title="Fixada" />}
                      <span className="message-time">
                        {formatMessageTime(message.timestamp)}
                      </span>
                      {renderMessageStatus(message)}
                    </div>

                    {/* Reação */}
                    {renderReaction(message)}
                  </div>

                  {/* Botão de Ações — seta pra baixo sobreposta no canto da
                      bolha, igual ao WhatsApp real (não "3 pontos" ao lado) */}
                  <button
                    className="message-actions-button"
                    onClick={(e) => handleOpenMessageMenu(e, message)}
                    title="Ações"
                  >
                    <BsChevronDown size={14} />
                  </button>

                  {/* Menu de Ações */}
                  {renderMessageMenu(message)}

                  {/* Emoji Picker */}
                  {showEmojiPicker === message.wamid && renderEmojiPicker(message.wamid, message.direction === 'outbound' || message.from_number === 'me', message.reaction_emoji)}
                </div>
                </div>
              </React.Fragment>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {showScrollToBottom && (
        <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title="Ir para o final da conversa">
          <BsChevronDown size={20} />
        </button>
      )}

      {/* ============================================ */}
      {/* PREVIEW DE ARQUIVO */}
      {/* ============================================ */}
      {selectedFile && (
        <div className="file-preview-container">
          <div className="file-preview-content">
            {filePreview ? (
              <img src={filePreview} alt="Preview" className="file-preview-image" />
            ) : audioPreviewUrl ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px' }}>
                <button
                  className="icon-button"
                  onClick={() => {
                    const el = audioPreviewRef.current;
                    if (!el) return;
                    if (isAudioPreviewPlaying) el.pause();
                    else el.play();
                  }}
                  title={isAudioPreviewPlaying ? 'Pausar' : 'Ouvir gravação'}
                  style={{ padding: 4 }}
                >
                  {isAudioPreviewPlaying ? <BsPauseFill size={20} /> : <BsPlayFill size={20} />}
                </button>
                <span style={{ fontSize: '0.9rem' }}>🎵 Áudio gravado</span>
                <audio
                  ref={audioPreviewRef}
                  src={audioPreviewUrl}
                  onPlay={() => setIsAudioPreviewPlaying(true)}
                  onPause={() => setIsAudioPreviewPlaying(false)}
                  onEnded={() => setIsAudioPreviewPlaying(false)}
                  style={{ display: 'none' }}
                />
              </div>
            ) : (
              <span style={{ padding: '0 8px', fontSize: '0.9rem' }}>
                📄 {selectedFile.name}
              </span>
            )}
            <button
              className="remove-file-btn"
              title="Excluir"
              onClick={() => {
                audioPreviewRef.current?.pause();
                setIsAudioPreviewPlaying(false);
                setSelectedFile(null);
                setFilePreview(null);
              }}
            >
              <BsX size={20} />
            </button>
          </div>
        </div>
      )}

      {/* ============================================ */}
      {/* INPUT DE MENSAGEM */}
      {/* ============================================ */}
      {isOutside24hWindow && (
        <div className="window-warning-banner">
          ⏰ Fora da janela de 24h de atendimento — a Meta só entrega mensagem de template pra este contato agora. Use o envio de template até ele responder de novo.
        </div>
      )}

      <div className="message-input-container" style={{ position: 'relative' }} ref={composerRef}>
        {/* Emoji + Stickers — mesmo popover, com abas (igual ao design: um
            botão só no composer, não um separado pra cada). */}
        {showInputEmojiPicker && (
          <div className="emoji-sticker-popover" style={{ position: 'absolute', bottom: '60px', left: '0', zIndex: 1000 }}>
            <div className="emoji-sticker-tabs">
              <button
                className={emojiPickerTab === 'emoji' ? 'active' : ''}
                onClick={() => setEmojiPickerTab('emoji')}
              >
                <BsEmojiSmile size={16} /> Emoji
              </button>
              {!isSiteChat && <>
              <button
                className={emojiPickerTab === 'sticker' ? 'active' : ''}
                onClick={() => setEmojiPickerTab('sticker')}
              >
                🎭 Stickers
              </button>
              <button
                className={emojiPickerTab === 'gif' ? 'active' : ''}
                onClick={() => setEmojiPickerTab('gif')}
              >
                <MdGifBox size={16} /> GIFs
              </button>
              </>}
            </div>
            {emojiPickerTab === 'emoji' ? (
              <EmojiPicker
                onEmojiClick={handleEmojiSelect}
                searchDisabled={false}
                height={350}
                width={320}
                theme={emojiPickerTheme}
                categories={EMOJI_CATEGORIES_PT}
                emojiData={EMOJI_DATA_PT}
                searchPlaceholder={EMOJI_SEARCH_PLACEHOLDER_PT}
                searchClearButtonLabel={EMOJI_SEARCH_CLEAR_LABEL_PT}
              />
            ) : emojiPickerTab === 'sticker' ? (
              <StickerPicker
                stickers={savedStickers}
                onSelectSticker={handleSelectSticker}
                onStickerCreated={handleStickerCreated}
                onDeleteSticker={handleDeleteSavedSticker}
              />
            ) : (
              <GifPicker onSelectGif={handleSelectGif} />
            )}
          </div>
        )}

        {/* Sugestões de resposta rápida ("/atalho") */}
        {quickReplyMatches.length > 0 && (
          <div style={{
            position: 'absolute', bottom: '52px', left: '50px', zIndex: 1000, minWidth: 260, maxWidth: 380,
            maxHeight: 220, overflowY: 'auto', background: 'var(--bg-primary, #fff)',
            border: '1px solid var(--border-color, #ddd)', borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}>
            {quickReplyMatches.map(qr => (
              <div
                key={qr.id}
                onClick={() => applyQuickReply(qr)}
                style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid var(--border-color, #eee)' }}
              >
                <div style={{ fontWeight: 600, color: 'var(--whatsapp-green, #25D366)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  /{qr.shortcut}
                  {qr.media_url && <MdImage size={13} title="Inclui mídia" />}
                </div>
                <div style={{ color: 'var(--text-secondary, #888)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {qr.text || (qr.media_url ? qr.media_filename || `[${qr.media_type}]` : '')}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Botão Emoji — abre o popover com abas Emoji/Stickers */}
        <button
          className="icon-button"
          onClick={() => setShowInputEmojiPicker(v => !v)}
          title="Emoji e stickers"
        >
          <BsEmojiSmile size={24} />
        </button>

        {/* Alterna modo nota interna — o que for digitado vira um recado só
            pra equipe (nunca sai pro WhatsApp) em vez de mensagem real. */}
        <button
          className="icon-button"
          onClick={() => setNoteMode(v => !v)}
          title={noteMode ? 'Modo nota interna ativo — clique para voltar a enviar mensagens' : 'Enviar nota interna (só a equipe vê)'}
          style={noteMode ? { color: '#b8860b' } : undefined}
        >
          {noteMode ? <MdLock size={22} /> : <MdLockOpen size={22} />}
        </button>

        {/* Mencionar participante (grupos Baileys) */}
        {isGroupChatConv && providerType === 'baileys' && (
          <div style={{ position: 'relative' }}>
            <button className="icon-button" onClick={openMentionPicker} title="Mencionar participante">
              @
            </button>
            {showMentionPicker && (
              <div style={{
                position: 'absolute', bottom: '44px', left: 0, zIndex: 1000,
                background: 'var(--bg-primary, #fff)', border: '1px solid var(--border-color, #ddd)',
                borderRadius: 8, minWidth: 220, maxHeight: 260, overflowY: 'auto',
                boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
              }}>
                {groupParticipants.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 13, color: 'var(--text-secondary, #888)' }}>Carregando...</div>
                ) : groupParticipants.map(p => (
                  <div
                    key={p.id}
                    onClick={() => toggleMention(p.id)}
                    style={{
                      padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                      background: mentionedJids.includes(p.id) ? 'var(--bg-hover, #f0f0f0)' : 'transparent',
                    }}
                  >
                    {mentionedJids.includes(p.id) ? '✓ ' : ''}{p.id.split('@')[0]}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Menu de Anexos — some no modo nota interna (nota é texto puro) */}
        {!noteMode && !isSiteChat && (
          <AttachmentMenu
            conversation={conversation}
            providerType={providerType}
            onSendMedia={handleOpenFileInput}
            onSendViewOnce={() => handleOpenFileInput('view-once')}
            onSendLocation={onOpenLocationSender}
            onRequestLocation={onRequestLocation}
            onSendContact={onOpenContactSender}
            onSendButtons={onSendButtons}
            onSendCtaUrl={onSendCtaUrl}
            onSendList={onOpenListSender}
            onSendProduct={onOpenProductSender}
            onSendProductList={onOpenProductListSender}
            onSendTemplate={onOpenTemplateSender}
            onSendCart={onOpenCartBuilder}
            onSendFlow={onOpenFlowSender}
            onSendCarousel={onOpenCarouselSender}
            onSendPoll={onOpenPollSender}
          />
        )}

        {/* Input de Arquivo (oculto) */}
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
          accept="image/*,image/webp,video/*,audio/*,.pdf,.doc,.docx"
        />

        {/* Campo de Texto */}
        <div className="message-input-box" style={noteMode ? { background: '#fef6d8' } : undefined}>
          {isRecording ? (
            <span style={{ color: '#e53e3e', fontWeight: 500, padding: '0 8px' }}>
              🔴 Gravando... {recordingSeconds}s
            </span>
          ) : (
            <textarea
              ref={inputRef}
              rows={1}
              spellCheck="true"
              lang="pt-BR"
              className={noteMode ? 'note-mode-input' : undefined}
              placeholder={
                noteMode ? '🔒 Nota interna — só a equipe vê...'
                : isOutside24hWindow ? 'Envie um template para reabrir a conversa'
                : 'Digite uma mensagem'
              }
              value={messageText}
              onChange={(e) => { setMessageText(e.target.value); if (!noteMode) notifyTyping(); }}
              onKeyDown={(e) => {
                // Enter sozinho envia; Shift+Enter OU Alt+Enter quebra linha.
                // BUG (2026-09-03): só checava !e.shiftKey — Alt+Enter caía no
                // mesmo caminho do Enter puro e enviava a mensagem em vez de
                // quebrar linha. Corrigido excluindo altKey também — MAS
                // deixar o navegador inserir a quebra sozinho (como já
                // funciona pra Shift+Enter) não funcionou pra Alt+Enter: o
                // navegador/SO trata esse atalho de outro jeito e nunca
                // insere o "\n" no textarea. Pra Alt+Enter especificamente,
                // insere a quebra manualmente em vez de depender do
                // navegador — não depende de adivinhar por que o nativo falha.
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  handleSend();
                  return;
                }
                if (e.key === 'Enter' && e.altKey) {
                  e.preventDefault();
                  const el = e.target;
                  const start = el.selectionStart ?? messageText.length;
                  const end = el.selectionEnd ?? messageText.length;
                  const newText = messageText.slice(0, start) + '\n' + messageText.slice(end);
                  setMessageText(newText);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = start + 1;
                  });
                }
              }}
              onPaste={handleComposerPaste}
              onFocus={() => setShowInputEmojiPicker(false)}
              disabled={isOutside24hWindow && !noteMode}
              // Fundo do modo nota é sempre um amarelo claro fixo (efeito
              // "post-it", independente do tema) — sem forçar a cor do texto
              // aqui também, o tema escuro herda --text-primary (quase
              // branco) e o texto digitado fica invisível sobre o amarelo claro.
              style={noteMode ? { color: '#3a2f00' } : undefined}
            />
          )}
        </div>

        {/* Lixeira — só durante a gravação, descarta sem virar prévia
            (diferente do botão de parar, que abre a prévia pra ouvir antes
            de decidir). Igual ao WhatsApp: cancelar e parar são ações
            separadas. */}
        {isRecording && (
          <button
            className="icon-button"
            onClick={handleCancelRecording}
            title="Descartar gravação"
            style={{ color: '#e53e3e' }}
          >
            <BsTrash size={20} />
          </button>
        )}

        {/* Botão Microfone / Parar Gravação */}
        {!messageText.trim() && !selectedFile && !isOutside24hWindow && !noteMode && !isSiteChat && (
          <button
            className="icon-button"
            onClick={isRecording ? handleStopRecording : handleStartRecording}
            title={isRecording ? 'Parar gravação' : 'Gravar áudio'}
            style={{ color: isRecording ? '#e53e3e' : undefined }}
          >
            {isRecording ? <BsStopFill size={22} /> : <BsMicFill size={22} />}
          </button>
        )}

        {/* Botão de Enviar */}
        <button
          className="send-button"
          onClick={handleSend}
          disabled={(isOutside24hWindow && !noteMode) || (!messageText.trim() && !selectedFile)}
        >
          {sending && !messageText.trim() && !selectedFile ? (
            <div className="spinner" style={{ width: '20px', height: '20px' }} />
          ) : (
            <IoSendSharp size={24} />
          )}
        </button>
      </div>

      {forwardTarget && (
        <div
          onClick={() => setForwardTarget(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 380, maxWidth: '90vw', maxHeight: '80vh', overflowY: 'auto', background: 'var(--bg-primary, #fff)', borderRadius: 8, padding: 16 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>Encaminhar mensagem</h3>
              <button onClick={() => setForwardTarget(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary, #888)' }}>
                <BsX size={22} />
              </button>
            </div>

            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)' }}>Outro número de WhatsApp (opcional)</label>
            <input
              type="text"
              placeholder="Ex: 5511999999999"
              value={forwardToNumber}
              onChange={(e) => setForwardToNumber(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', margin: '4px 0 12px', borderRadius: 6, border: '1px solid var(--border-color, #ccc)', background: 'var(--bg-primary, #fff)', color: 'var(--text-primary, #333)' }}
            />

            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)' }}>Equipe (opcional)</label>
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: 8, margin: '4px 0 12px' }}>
              {(internalChats || []).length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary, #888)' }}>Nenhuma conversa interna.</div>
              ) : internalChats.map(c => (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 14, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={forwardInternalIds.includes(c.id)}
                    onChange={() => setForwardInternalIds(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}
                  />
                  {c.name}
                </label>
              ))}
            </div>

            <button
              onClick={confirmForwardMessage}
              disabled={!forwardToNumber.trim() && forwardInternalIds.length === 0}
              className="send-button"
              style={{ width: '100%', borderRadius: 6, opacity: (!forwardToNumber.trim() && forwardInternalIds.length === 0) ? 0.5 : 1 }}
            >
              Encaminhar
            </button>
          </div>
        </div>
      )}

      {lightboxMedia && (
        <ImageLightbox
          src={lightboxMedia.src}
          type={lightboxMedia.type}
          onClose={() => setLightboxMedia(null)}
        />
      )}

      {editingMessage && (
        <EditMessageModal
          message={editingMessage}
          theme={emojiPickerTheme}
          onClose={() => setEditingMessage(null)}
          onSave={async (newText) => {
            await onEditMessage?.(editingMessage, newText);
            setEditingMessage(null);
          }}
        />
      )}

      {showTaskModal && (
        <TaskModal
          standalone
          customerConversationId={conversation.id}
          currentUserId={currentUserId}
          onClose={() => setShowTaskModal(false)}
          onCreate={(payload) => onCreateTask(payload)}
        />
      )}
    </div>
  );
};

export default ChatArea;
