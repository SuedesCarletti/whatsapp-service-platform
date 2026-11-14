/**
 * InternalChatArea — chat interno entre usuários da equipe (DM ou grupo),
 * sem ligação nenhuma com conversa de cliente/WhatsApp. Reaproveita classes
 * CSS de ChatArea (chat-area/message-bubble/message-action-menu/etc, App.css)
 * pra ficar visualmente consistente, e a mesma galeria de stickers pessoal
 * (StickerPicker.js) — mas é um componente próprio, sem os recursos
 * específicos de WhatsApp (templates, catálogo, janela de 24h).
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  BsPeopleFill, BsReply, BsX, BsEmojiSmile, BsArrowRight, BsPencil, BsTrash,
  BsStar, BsStarFill, BsPin, BsPinFill, BsMicFill, BsStopFill, BsPaperclip, BsChevronDown,
  BsChatDots, BsListCheck, BsPlayFill, BsPauseFill,
} from 'react-icons/bs';
import { MdContentCopy, MdGifBox } from 'react-icons/md';
import { BiCheckDouble } from 'react-icons/bi';
import { FiDownload } from 'react-icons/fi';
import { IoSendSharp } from 'react-icons/io5';
import EmojiPicker from 'emoji-picker-react';
import moment from 'moment';
import 'moment/locale/pt-br';
import StickerPicker from './StickerPicker';
import GifPicker from './GifPicker';
import InternalChatAreaMenu from './menus/InternalChatAreaMenu';
import TaskModal from './TaskModal';
import ImageLightbox from './ImageLightbox';
import VoiceMessagePlayer from './VoiceMessagePlayer';
import apiService from '../services/api';
import { formatFileSize, getFileTypeIcon } from '../utils/fileType';
import { emojiOnlyClass } from '../utils/emojiSize';
import { EMOJI_CATEGORIES_PT, EMOJI_SEARCH_PLACEHOLDER_PT, EMOJI_SEARCH_CLEAR_LABEL_PT, EMOJI_DATA_PT } from '../utils/emojiPickerLocale';
import useClickOutside from '../utils/useClickOutside';
import { renderTextWithPhoneLinks, normalizePhoneDigits } from '../utils/phoneLink';

moment.locale('pt-br');

const getInitials = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};

const getFileType = (file) => {
  const mime = file.type || '';
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
};

// Igual ao handoff ("hoje, 17:00" / "amanhã, 12:00" / "ontem, 09:00"): dia
// relativo em minúsculo pros próximos dias, senão data curta.
export const formatTaskDue = (iso) => {
  if (!iso) return null;
  const m = moment(iso);
  const time = m.format('HH:mm');
  const days = m.clone().startOf('day').diff(moment().startOf('day'), 'days');
  if (days === 0) return `hoje, ${time}`;
  if (days === 1) return `amanhã, ${time}`;
  if (days === -1) return `ontem, ${time}`;
  return `${m.format('DD/MM')}, ${time}`;
};

export const formatLastSeen = (iso) => {
  if (!iso) return 'offline';
  const m = moment(iso);
  const now = moment();
  if (now.diff(m, 'days') === 0) return `visto por último hoje às ${m.format('HH:mm')}`;
  if (now.diff(m, 'days') === 1) return `visto por último ontem às ${m.format('HH:mm')}`;
  return `visto por último em ${m.format('DD/MM/YYYY [às] HH:mm')}`;
};

// Status manual estilo Slack/Teams — cor da bolinha e rótulo exibido no
// header. "offline" cobre tanto quem realmente desconectou quanto quem
// escolheu aparecer como offline (mesma regra do backend).
export const PRESENCE_META = {
  online: { color: '#2FAE60', label: 'Disponível' },
  away: { color: '#ECB22E', label: 'Ausente' },
  busy: { color: '#e53e3e', label: 'Ocupado' },
  offline: { color: '#8696A0', label: 'Offline' },
};

export const PresenceDot = ({ status, size = 12 }) => {
  const meta = PRESENCE_META[status] || PRESENCE_META.offline;
  return (
    <div style={{
      position: 'absolute', bottom: -1, right: -1, width: size, height: size, borderRadius: '50%',
      background: meta.color, border: '2px solid var(--bg-primary, #fff)', boxSizing: 'content-box',
    }} />
  );
};

// low|medium|high|urgent — mesma convenção usada no backend (TASK_PRIORITIES).
export const TASK_PRIORITY_META = {
  low: { label: 'Baixa', color: '#8a8f98' },
  medium: { label: 'Média', color: '#3b82f6' },
  high: { label: 'Alta', color: '#f59e0b' },
  urgent: { label: 'Urgente', color: '#e53e3e' },
};

export const TaskPriorityBadge = ({ priority, style }) => {
  const meta = TASK_PRIORITY_META[priority] || TASK_PRIORITY_META.medium;
  return (
    <span style={{
      display: 'inline-block', fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 9,
      color: '#fff', background: meta.color, lineHeight: '15px', ...style,
    }}>
      {meta.label}
    </span>
  );
};

const InternalChatArea = ({
  conversation, messages, currentUserId, internalChats, conversations,
  onSendMessage, onSendMedia, onEditMessage, onDeleteMessage,
  onReactMessage, onStarMessage, onPinMessage, onForwardMessage, onForwardMessageToWhatsApp,
  onOpenGroupManager, onOpenContactInfo, onOpenWhatsAppConversation, onTyping, typingUser, presence, currentTheme,
  onCreateTask, onToggleTask, onOpenTask, onApproveTask, onRejectTask, onPauseTask, onResumeTask, onCancelTask, onUncancelTask, tasks,
  newTaskCount, onTasksSeen, onTogglePin, onOpenChatByPhone,
  onToggleFavorite, onToggleMute, onViewMedia, onOpenMemberChat, openSearchSignal,
}) => {
  const emojiPickerTheme = currentTheme === 'dark' ? 'dark' : 'light';
  const [lightboxMedia, setLightboxMedia] = useState(null); // { src, type } | null — ver ImageLightbox
  const [text, setText] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [showMessageMenu, setShowMessageMenu] = useState(null);
  const [menuDirection, setMenuDirection] = useState('open-upwards');
  const [menuHAlign, setMenuHAlign] = useState(null);
  const menuRef = useRef(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(null);
  const [showInputEmojiPicker, setShowInputEmojiPicker] = useState(false);
  // Buscar no Chat — paridade com ChatArea.js::handleToggleSearch (filtro
  // simples nas mensagens já carregadas, sem chamada nova ao backend).
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const handleToggleSearch = () => {
    setShowSearch(v => !v);
    setSearchQuery('');
  };
  // "Buscar no chat" acionado a partir de InternalContactInfoPanel.js (fora
  // deste componente) — mesmo sinal por contador de ChatArea.js.
  useEffect(() => {
    if (openSearchSignal) setShowSearch(true);
  }, [openSearchSignal]);
  // Mesma paridade de ChatArea.js: clicar fora do composer fecha o popover
  // de emoji/sticker/GIF, não só clicar de novo no botão que abriu.
  const composerRef = useRef(null);
  useClickOutside(composerRef, useCallback(() => setShowInputEmojiPicker(false), []), showInputEmojiPicker);
  const [emojiPickerTab, setEmojiPickerTab] = useState('emoji');
  const [forwardTarget, setForwardTarget] = useState(null);
  const [selectedTargetIds, setSelectedTargetIds] = useState([]);
  const [selectedWaTargetIds, setSelectedWaTargetIds] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [savedStickers, setSavedStickers] = useState([]);
  const [showTaskModal, setShowTaskModal] = useState(false);
  // Arquivo colado/arrastado/anexado, ainda não enviado — mesma paridade do
  // ChatArea.js: mostra prévia acima do composer, só envia no submit
  // explícito (antes ia direto pro onSendMedia dentro do próprio handler de
  // paste/anexo, sem chance da pessoa ver o que ia mandar antes de enviar).
  const [selectedFile, setSelectedFile] = useState(null);
  const [filePreview, setFilePreview] = useState(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragCounterRef = useRef(0);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);
  const discardRecordingRef = useRef(false);
  const audioPreviewRef = useRef(null);
  const [pendingAudio, setPendingAudio] = useState(null); // { file, url } | null — prévia após parar de gravar, antes de enviar
  const [isAudioPreviewPlaying, setIsAudioPreviewPlaying] = useState(false);
  const lastTypingSentRef = useRef(0);

  const handleTextChange = (e) => {
    setText(e.target.value);
    const now = Date.now();
    if (onTyping && now - lastTypingSentRef.current > 2000) {
      lastTypingSentRef.current = now;
      onTyping();
    }
  };

  const handleEmojiSelect = (emojiData) => {
    const emoji = emojiData.emoji;
    const input = inputRef.current;
    if (input) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const newText = text.slice(0, start) + emoji + text.slice(end);
      setText(newText);
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(start + emoji.length, start + emoji.length);
      }, 0);
    } else {
      setText(prev => prev + emoji);
    }
  };

  useEffect(() => {
    apiService.getSavedStickers().then(setSavedStickers);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    // Troca de conversa cancela qualquer resposta/edição em andamento da anterior.
    setReplyingTo(null);
    setEditingMessage(null);
    setText('');
    setShowScrollToBottom(false);
  }, [conversation?.id]);

  // Botão "ir para o final" — mesmo comportamento de ChatArea.js (clientes).
  const messagesContainerRef = useRef(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowScrollToBottom(distanceFromBottom > 200);
  };
  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });

  // Paridade com ChatArea.js: caixa de mensagem cresce em altura conforme o
  // texto quebra linha — mesmo teto de 120px (~5 linhas), depois vira
  // scroll interno. Antes o campo era um <input> de uma linha só, que nem
  // permitia digitar quebra de linha (Enter sempre enviava, sem alternativa).
  const MESSAGE_INPUT_MAX_HEIGHT = 120;
  useEffect(() => {
    const el = inputRef.current;
    if (!el || el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MESSAGE_INPUT_MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MESSAGE_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  // Em GRUPO, só mostra as tarefas da própria pessoa (criadas por ela ou
  // atribuídas a ela) — sem isso, a faixa de um grupo grande virava uma
  // lista de tarefas de todo mundo. Em DM (1:1) mantém as duas. Calculado
  // aqui (não só dentro do JSX) porque o efeito de redimensionamento
  // abaixo precisa saber se a lista está de fato renderizada.
  const openTasksAll = (tasks || []).filter(t => t.status !== 'done' && t.status !== 'cancelled');
  const openTasks = conversation?.is_group
    ? openTasksAll.filter(t => t.created_by?.id === currentUserId || t.assigned_to?.id === currentUserId)
    : openTasksAll;

  // Faixa de tarefas recolhida/expandida — preferência global (não por
  // conversa: é sobre como você gosta de ver a interface, não sobre uma
  // thread específica), cacheada em localStorage igual outras preferências
  // de UI (ver wa-notifications/wa-sound em SettingsModal.js).
  const [tasksStripCollapsed, setTasksStripCollapsed] = useState(
    () => localStorage.getItem('wa-tasks-strip-collapsed') === 'true'
  );

  const toggleTasksStrip = () => {
    setTasksStripCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('wa-tasks-strip-collapsed', String(next)); } catch { /* localStorage indisponível — só não persiste */ }
      if (!next) onTasksSeen?.();
      return next;
    });
  };

  // Fechar menu de ações da mensagem ao clicar fora — paridade com ChatArea.js
  // (clientes), que já tinha isso; aqui só fechava clicando de novo no botão.
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowMessageMenu(null);
        setShowEmojiPicker(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!conversation) {
    return (
      <div className="chat-area empty-state">
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
          <BsPeopleFill size={60} />
          <h3>Chat interno</h3>
          <p>Escolha uma conversa da equipe ou inicie uma nova</p>
        </div>
      </div>
    );
  }

  const handleSend = () => {
    const trimmed = text.trim();
    if (editingMessage) {
      if (!trimmed) return;
      onEditMessage(editingMessage.id, trimmed);
      setEditingMessage(null);
      setText('');
      return;
    }
    if (!trimmed && !selectedFile) return;
    if (selectedFile) {
      onSendMedia(selectedFile, getFileType(selectedFile), trimmed, replyingTo?.id || null);
      setSelectedFile(null);
      setFilePreview(null);
    } else {
      onSendMessage(trimmed, replyingTo?.id || null);
    }
    setReplyingTo(null);
    setText('');
  };

  // Só põe o arquivo em prévia (acima do composer) — quem manda de fato é
  // handleSend, no clique/Enter. Compartilhado por anexo pelo clipe, colar
  // (Ctrl+V) e arrastar-e-soltar.
  const applyPickedFile = (file) => {
    if (!file) return;
    setSelectedFile(file);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => setFilePreview(reader.result);
      reader.readAsDataURL(file);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    applyPickedFile(file);
  };

  // Ctrl+V no campo de mensagem — mesma paridade do chat de clientes: colar
  // uma imagem/arquivo do clipboard só põe em prévia, não envia sozinho.
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

  // Arrastar um arquivo do explorador de arquivos direto pro chat — não
  // existia nenhum handler de drag-and-drop antes (nem aqui nem no
  // ChatArea.js). dragCounterRef conta entra/sai porque dragenter/dragleave
  // disparam pra cada elemento filho sobrevoado, não só a borda externa —
  // sem o contador o overlay pisca ao passar por cima de mensagens/bolhas.
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

  // GIF do Giphy (aba do popover, igual ChatArea.js) — aqui não existe o
  // conceito de "mensagem GIF" do protocolo WhatsApp (send_gif), então basta
  // mandar como mídia comum tipo 'image': o navegador já anima um .gif
  // normalmente num <img>, sem precisar de tratamento especial.
  const handleSelectGif = async (gif) => {
    setShowInputEmojiPicker(false);
    try {
      const blob = await fetch(gif.url).then(r => r.blob());
      const file = new File([blob], `${gif.id}.gif`, { type: 'image/gif' });
      onSendMedia(file, 'image', '', replyingTo?.id || null);
      setReplyingTo(null);
    } catch (err) {
      console.error('Erro ao enviar GIF do Giphy:', err);
      alert('Não foi possível enviar esse GIF.');
    }
  };

  const handleSelectSticker = async (sticker) => {
    setShowInputEmojiPicker(false);
    try {
      const blob = await fetch(sticker.media_url).then(r => r.blob());
      const file = new File([blob], 'sticker.webp', { type: sticker.mime_type || 'image/webp' });
      onSendMedia(file, 'sticker', '', replyingTo?.id || null);
      setReplyingTo(null);
    } catch (err) {
      console.error('Erro ao reenviar sticker:', err);
    }
  };

  // Paridade com o chat de clientes (ChatArea.js): salvar um sticker recebido
  // na galeria pessoal, e copiar o texto de uma mensagem.
  const handleSaveStickerFromMessage = (msg) => {
    apiService.saveSticker(msg.media_url, msg.mime_type, `internal_${msg.id}`)
      .then(res => {
        if (res?.data) setSavedStickers(prev => (prev.some(s => s.id === res.data.id) ? prev : [res.data, ...prev]));
      })
      .catch(() => alert('Não foi possível salvar esse sticker.'));
  };

  const handleCopyMessage = (msg) => {
    navigator.clipboard.writeText(msg.text || '');
    setShowMessageMenu(null);
  };

  // Mesma lógica do chat de clientes (ChatArea.js): abre pra cima por
  // padrão, mas se não sobrar espaço acima (mensagem perto do topo da
  // tela) troca pra abrir pra baixo — sem isso o menu ficava cortado fora
  // da tela em qualquer mensagem no topo da conversa.
  const handleOpenMessageMenu = (e, msgId) => {
    e.stopPropagation();
    if (showMessageMenu === msgId) {
      setShowMessageMenu(null);
      return;
    }
    setShowMessageMenu(msgId);
    setMenuDirection('open-upwards');
    setMenuHAlign(null);
    setTimeout(() => {
      if (menuRef.current) {
        const rect = menuRef.current.getBoundingClientRect();
        setMenuDirection(rect.top < 40 ? 'open-downwards' : 'open-upwards');
        const chatBounds = menuRef.current.closest('.chat-area')?.getBoundingClientRect();
        const leftBound = chatBounds ? chatBounds.left : 0;
        const rightBound = chatBounds ? chatBounds.right : window.innerWidth;
        if (rect.left < leftBound + 8) setMenuHAlign('left');
        else if (rect.right > rightBound - 8) setMenuHAlign('right');
        else setMenuHAlign(null);
      }
    }, 0);
  };

  const handleStartRecording = async () => {
    let stream = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        alert('Gravação de áudio requer HTTPS. Acesse o app via HTTPS ou use localhost.');
        return;
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const preferredMime = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/webm', '']
        .find(m => m === '' || MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, preferredMime ? { mimeType: preferredMime } : {});
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        mediaRecorderRef.current = null;
        clearInterval(recordingTimerRef.current);
        setRecordingSeconds(0);

        if (discardRecordingRef.current) {
          discardRecordingRef.current = false;
          audioChunksRef.current = [];
          return;
        }

        // BUG (2026-09-04): antes mandava o áudio na hora, direto do onstop
        // — sem prévia, sem play/pause pra conferir, sem como desistir sem
        // mandar depois de já ter parado (só dava pra cancelar ANTES de
        // parar). Igual ao WhatsApp de verdade: parar só encerra a
        // gravação e abre uma prévia (play/pause + lixeira); só o botão de
        // enviar manda de fato (ver pendingAudio mais abaixo).
        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `audio_${Date.now()}.${ext}`, { type: mimeType });
        setPendingAudio({ file, url: URL.createObjectURL(blob) });
      };

      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds(s => s + 1), 1000);
    } catch (err) {
      console.error('Erro ao iniciar gravação:', err);
      if (stream) stream.getTracks().forEach(t => t.stop());
      alert('Não foi possível acessar o microfone.');
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

  const handleSendPendingAudio = () => {
    if (!pendingAudio) return;
    onSendMedia(pendingAudio.file, 'audio', '', replyingTo?.id || null);
    URL.revokeObjectURL(pendingAudio.url);
    setPendingAudio(null);
    setIsAudioPreviewPlaying(false);
    setReplyingTo(null);
  };

  const handleDiscardPendingAudio = () => {
    if (!pendingAudio) return;
    audioPreviewRef.current?.pause();
    URL.revokeObjectURL(pendingAudio.url);
    setPendingAudio(null);
    setIsAudioPreviewPlaying(false);
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const openForwardModal = (msg) => {
    setForwardTarget(msg);
    setSelectedTargetIds([]);
    setSelectedWaTargetIds([]);
    setShowMessageMenu(null);
  };

  const confirmForward = () => {
    if (!forwardTarget) return;
    if (selectedTargetIds.length === 0 && selectedWaTargetIds.length === 0) return;
    if (selectedTargetIds.length > 0) onForwardMessage(forwardTarget.id, selectedTargetIds);
    if (selectedWaTargetIds.length > 0) onForwardMessageToWhatsApp?.(forwardTarget.id, selectedWaTargetIds);
    setForwardTarget(null);
  };

  const getWaConvName = (c) => c.contact?.saved_name || c.contact?.phone_number || c.contact?.wa_id || c.name || 'Contato';

  const renderStatus = (msg) => {
    if (!msg.is_mine) return null;
    return msg.read_by_all
      ? <BiCheckDouble size={16} className="message-status-icon read" />
      : <BiCheckDouble size={16} className="message-status-icon" />;
  };

  const renderContent = (msg) => {
    if (msg.is_deleted) {
      return <div className="message-content" style={{ fontStyle: 'italic', opacity: 0.6 }}>🚫 Mensagem apagada</div>;
    }
    switch (msg.message_type) {
      case 'image':
        return (
          <div className="message-media">
            <img src={msg.media_url} alt="" style={{ maxWidth: 260, borderRadius: 8, cursor: 'zoom-in', display: 'block' }}
              onClick={() => setLightboxMedia({ src: msg.media_url, type: 'image' })} />
            {msg.text && <div className="message-caption">{msg.text}</div>}
          </div>
        );
      case 'video':
        return (
          <div className="message-media">
            <video src={msg.media_url} controls style={{ maxWidth: 260, borderRadius: 8 }} />
            {msg.text && <div className="message-caption">{msg.text}</div>}
          </div>
        );
      case 'audio':
        return <VoiceMessagePlayer src={msg.media_url} seed={msg.id} style={{ maxWidth: 260 }} />;
      case 'sticker':
        return <img src={msg.media_url} alt="" style={{ width: 130, height: 130, objectFit: 'contain', display: 'block' }} />;
      case 'document': {
        // Imagem mandada "como arquivo" mostra a própria imagem; senão
        // ícone por tipo + nome + download — antes era um ícone genérico
        // único (MdDescription) igual pra qualquer extensão, sem diferenciar
        // pdf/word/excel/zip/etc.
        const sizeLabel = formatFileSize(msg.file_size);
        if ((msg.mime_type || '').startsWith('image/')) {
          return (
            <div className="message-media">
              <img src={msg.media_url} alt={msg.filename || ''} style={{ maxWidth: 260, borderRadius: 8, cursor: 'zoom-in', display: 'block' }}
                onClick={() => setLightboxMedia({ src: msg.media_url, type: 'image' })} />
              {msg.filename && <div className="message-caption">{msg.filename}</div>}
            </div>
          );
        }
        return (
          <div className="message-document">
            {getFileTypeIcon(msg.filename, msg.mime_type)}
            <div>
              <div className="message-document-name">{msg.filename || 'Documento'}</div>
              <div className="message-document-meta">
                {sizeLabel && <span className="message-document-size">{sizeLabel}</span>}
                <a href={msg.media_url} download target="_blank" rel="noopener noreferrer">
                  <FiDownload /> Download
                </a>
              </div>
            </div>
          </div>
        );
      }
      case 'task': {
        const t = msg.task;
        if (!t) return <div className="message-content">📋 {msg.text}</div>;
        // Aviso de evento (concluída/aprovada/reprovada/reaberta/próxima
        // ocorrência) — texto simples clicável, NÃO o card completo. Sem essa
        // distinção, toda mensagem da tarefa (criação, conclusão, aprovação...)
        // renderizava o mesmo card com o estado AO VIVO — depois de aprovada,
        // até o aviso antigo de "concluída" passava a mostrar "aprovada"
        // também, os avisos ficavam todos idênticos/redundantes.
        if (msg.task_event) {
          return (
            <div
              className="message-content"
              onClick={() => onOpenTask?.(t.id)}
              style={{ cursor: onOpenTask ? 'pointer' : 'default' }}
            >
              {msg.text}
            </div>
          );
        }
        const isDone = t.status === 'done';
        const isPaused = t.status === 'paused';
        const isCancelled = t.status === 'cancelled';
        const doneSubtasks = (t.subtasks || []).filter(s => s.is_done).length;
        const totalSubtasks = (t.subtasks || []).length;
        const attachmentCount = (t.attachments || []).length;
        const canComplete = currentUserId === t.created_by?.id || currentUserId === t.assigned_to?.id;
        // Só quem criou aprova/reprova — o responsável concluir e também
        // poder auto-aprovar esvaziaria o sentido da aprovação.
        const canApprove = isDone && !t.approved_by && currentUserId === t.created_by?.id;
        return (
          <div className="message-contacts">
            <div
              className="contact-card"
              onClick={() => onOpenTask?.(t.id)}
              style={{ cursor: onOpenTask ? 'pointer' : 'default' }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <input
                  type="checkbox" checked={isDone}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => onToggleTask?.(t.id, isDone ? 'pending' : 'done')}
                  style={{ marginTop: 3, cursor: (onToggleTask && canComplete && !isPaused && !isCancelled) ? 'pointer' : 'default', flexShrink: 0 }}
                  disabled={!onToggleTask || !canComplete || isPaused || isCancelled}
                  title={isPaused ? 'Tarefa pausada — retome antes de concluir' : isCancelled ? 'Tarefa cancelada — reative antes de concluir' : (canComplete ? undefined : 'Só quem criou ou é responsável pode concluir')}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <div className="contact-name" style={{ textDecoration: (isDone || isCancelled) ? 'line-through' : 'none', opacity: (isDone || isCancelled) ? 0.6 : 1 }}>
                      {t.title}
                    </div>
                    <TaskPriorityBadge priority={t.priority} />
                  </div>
                  {t.description && (
                    <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 2 }}>
                      {t.description} {t.description_edited && <span style={{ opacity: 0.6, fontStyle: 'italic' }}>(editado)</span>}
                    </div>
                  )}
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {t.assigned_to && <span>👤 {t.assigned_to.full_name}</span>}
                    {t.due_at && <span>⏰ {moment(t.due_at).format('DD/MM HH:mm')}</span>}
                    {totalSubtasks > 0 && <span>☑️ {doneSubtasks}/{totalSubtasks}</span>}
                    {attachmentCount > 0 && <span>📎 {attachmentCount}</span>}
                  </div>
                  {isDone && t.completed_by && (
                    <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Concluída por {t.completed_by.full_name}</div>
                  )}
                  {t.approved_by && (
                    <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>👍 Aprovada por {t.approved_by.full_name}</div>
                  )}
                  {isPaused && (
                    <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                      ⏸️ Pausada por {t.paused_by?.full_name || 'alguém'}{t.pause_reason ? `: ${t.pause_reason}` : ''}
                    </div>
                  )}
                  {isCancelled && (
                    <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2, color: '#e53e3e' }}>
                      🚫 Cancelada por {t.cancelled_by?.full_name || 'alguém'}{t.cancel_reason ? `: ${t.cancel_reason}` : ''}
                    </div>
                  )}
                  {canComplete && !isDone && (
                    <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                      {isPaused ? (
                        <button
                          onClick={() => onResumeTask?.(t.id)}
                          style={{
                            background: 'none', color: 'var(--brand-orange, var(--whatsapp-green))',
                            border: '1px solid var(--brand-orange, var(--whatsapp-green))',
                            borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                          }}
                        >
                          ▶️ Retomar
                        </button>
                      ) : isCancelled ? (
                        <button
                          onClick={() => onUncancelTask?.(t.id)}
                          style={{
                            background: 'none', color: '#e53e3e', border: '1px solid #e53e3e',
                            borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                          }}
                        >
                          ↩️ Reativar
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => onPauseTask?.(t.id)}
                            style={{
                              background: 'none', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
                              borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                            }}
                          >
                            ⏸️ Pausar
                          </button>
                          <button
                            onClick={() => onCancelTask?.(t.id)}
                            style={{
                              background: 'none', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
                              borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                            }}
                          >
                            🚫 Cancelar
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {canApprove && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); onApproveTask?.(t.id); }}
                        style={{
                          background: 'var(--brand-orange, var(--whatsapp-green))', color: '#fff',
                          border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        Aprovar
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onRejectTask?.(t.id); }}
                        style={{
                          background: 'none', color: '#e53e3e', border: '1px solid #e53e3e',
                          borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        }}
                      >
                        Reprovar
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      }
      default:
        return (
          <div
            className={`message-content ${emojiOnlyClass(msg.text)}`.trim()}
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {onOpenChatByPhone
              ? renderTextWithPhoneLinks(msg.text, (digits) => onOpenChatByPhone(normalizePhoneDigits(digits)))
              : msg.text}
          </div>
        );
    }
  };

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
      <div className="chat-header">
        <div
          className="contact-info"
          onClick={conversation.is_group ? onOpenGroupManager : onOpenContactInfo}
          role="button" tabIndex={0}
        >
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <div className="contact-avatar">
              {conversation.photo_url
                ? <img src={conversation.photo_url} alt="" className="conversation-avatar-img" />
                : conversation.is_group ? <BsPeopleFill size={20} /> : getInitials(conversation.name)}
            </div>
            {!conversation.is_group && <PresenceDot status={presence?.status || 'offline'} />}
          </div>
          <div>
            <div className="contact-name">{conversation.name}</div>
            <div className="contact-status">
              {typingUser
                ? <span style={{ color: 'var(--whatsapp-green, #25D366)' }}>{conversation.is_group ? `${typingUser.user_name} está digitando...` : 'digitando...'}</span>
                : conversation.is_group
                  ? `${conversation.participants.length} participantes`
                  : presence?.status && presence.status !== 'offline'
                    ? PRESENCE_META[presence.status]?.label || 'Disponível'
                    : formatLastSeen(presence?.last_seen_at)}
            </div>
          </div>
        </div>
        <div className="header-actions">
          <InternalChatAreaMenu
            conversation={conversation}
            onPinChat={onTogglePin}
            onFavoriteChat={onToggleFavorite}
            onMuteChat={onToggleMute}
            onSearchInChat={handleToggleSearch}
            onViewMedia={onViewMedia}
          />
        </div>
      </div>

      {/* Tarefa concluída sai da faixa — ela já cumpriu o papel de "coisa em
          aberto nessa conversa" e vira só o card na timeline + a mensagem
          de aprovação. Em GRUPO, só mostra as tarefas da própria pessoa
          (criadas por ela ou atribuídas a ela) — sem isso, a faixa de um
          grupo grande virava uma lista de tarefas de todo mundo, sem
          relação com o que essa pessoa específica precisa fazer. Em DM
          (1:1) mantém mostrando as duas, já que só tem vocês dois mesmo. */}
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
                <span>{conversation.is_group ? 'Suas tarefas nesta conversa' : 'Tarefas da conversa'}</span>
                {tasksStripCollapsed && newTaskCount > 0 && (
                  <span className="conversation-tasks-strip-badge">{newTaskCount > 99 ? '99+' : newTaskCount}</span>
                )}
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

      <div className="messages-container" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '20px' }}>
            Nenhuma mensagem ainda. Diga oi!
          </div>
        ) : (
          messages
          .filter(msg => !searchQuery.trim() || (msg.text || '').toLowerCase().includes(searchQuery.trim().toLowerCase()))
          .map((msg) => (
            <div key={msg.id} id={`internal-msg-${msg.id}`} className={`message ${msg.is_mine ? 'sent' : 'received'}`}>
              <div className="message-bubble-container">
                <div className="message-bubble" style={{ position: 'relative' }}>
                  {conversation.is_group && !msg.is_mine && !msg.is_deleted && (
                    <div
                      className="message-participant"
                      style={{ fontWeight: 600, fontSize: 12, marginBottom: 2, cursor: onOpenMemberChat ? 'pointer' : undefined }}
                      onClick={(e) => {
                        e.stopPropagation();
                        const member = (conversation.participants || []).find(p => p.id === msg.sender_id);
                        onOpenMemberChat?.(member || { id: msg.sender_id, full_name: msg.sender_name });
                      }}
                      title={onOpenMemberChat ? 'Clique para ver o contato' : undefined}
                    >
                      {msg.sender_name}
                    </div>
                  )}
                  {msg.reply_to && (
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        const el = document.getElementById(`internal-msg-${msg.reply_to.id}`);
                        if (!el) return;
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.classList.add('message-highlight');
                        setTimeout(() => el.classList.remove('message-highlight'), 1500);
                      }}
                      title="Ir para a mensagem original"
                      style={{
                        borderLeft: '3px solid var(--whatsapp-green, #25D366)', paddingLeft: 6, marginBottom: 4,
                        opacity: 0.8, fontSize: 12, background: 'rgba(0,0,0,0.04)', borderRadius: 4, padding: '3px 6px',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{msg.reply_to.sender_name}</div>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.reply_to.text}</div>
                    </div>
                  )}

                  {msg.forwarded_from_whatsapp && (
                    <div
                      onClick={() => onOpenWhatsAppConversation?.(msg.forwarded_from_whatsapp.conversation_id)}
                      title="Abrir conversa do cliente"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
                        fontSize: 12, background: 'rgba(37,211,102,0.12)', borderRadius: 4, padding: '4px 6px',
                        cursor: onOpenWhatsAppConversation ? 'pointer' : 'default',
                      }}
                    >
                      <BsChatDots size={12} style={{ flexShrink: 0, color: 'var(--whatsapp-green, #25D366)' }} />
                      <div style={{ overflow: 'hidden' }}>
                        <div style={{ fontWeight: 600, color: 'var(--whatsapp-green, #25D366)' }}>
                          Encaminhado de {msg.forwarded_from_whatsapp.contact_name || msg.forwarded_from_whatsapp.contact_phone || 'cliente'}
                        </div>
                        {msg.forwarded_from_whatsapp.contact_name && msg.forwarded_from_whatsapp.contact_phone && (
                          <div style={{ opacity: 0.75 }}>{msg.forwarded_from_whatsapp.contact_phone}</div>
                        )}
                      </div>
                    </div>
                  )}

                  {renderContent(msg)}

                  <div className="message-footer">
                    {msg.is_pinned && <BsPinFill size={11} style={{ marginRight: 4, opacity: 0.7 }} title="Fixada" />}
                    {msg.is_edited && !msg.is_deleted && (
                      <span style={{ fontSize: 11, color: 'var(--text-secondary, #888)', marginRight: 4 }}>editado</span>
                    )}
                    <span className="message-time">{moment(msg.created_at).format('HH:mm')}</span>
                    {renderStatus(msg)}
                  </div>

                  {msg.reactions && msg.reactions.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      {msg.reactions.map(r => (
                        <span
                          key={r.emoji}
                          onClick={() => onReactMessage(msg.id, msg.my_reaction === r.emoji ? null : r.emoji)}
                          style={{
                            fontSize: 12, background: 'var(--bg-secondary, #eee)', borderRadius: 10, padding: '1px 6px',
                            cursor: 'pointer', border: msg.my_reaction === r.emoji ? '1px solid var(--whatsapp-green, #25D366)' : '1px solid transparent',
                          }}
                        >
                          {r.emoji} {r.user_ids.length}
                        </span>
                      ))}
                    </div>
                  )}

                  {!msg.is_deleted && (
                    <button
                      className="message-actions-button"
                      onClick={(e) => handleOpenMessageMenu(e, msg.id)}
                      title="Ações"
                    >
                      <BsChevronDown size={14} />
                    </button>
                  )}

                  {showMessageMenu === msg.id && (
                    <div className={`message-action-menu ${menuDirection} ${menuHAlign ? `force-align-${menuHAlign}` : ''}`} ref={menuRef}>
                      <div className="message-action-menu-reactions">
                        {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji) => (
                          <button
                            key={emoji}
                            className="message-action-menu-reaction-btn"
                            onClick={() => { onReactMessage(msg.id, emoji); setShowMessageMenu(null); }}
                          >
                            {emoji}
                          </button>
                        ))}
                        <button
                          className="message-action-menu-reaction-btn"
                          title="Mais emojis"
                          onClick={() => { setShowEmojiPicker(msg.id); setShowMessageMenu(null); }}
                        >
                          <BsEmojiSmile size={16} />
                        </button>
                      </div>
                      <button onClick={() => { setReplyingTo(msg); setShowMessageMenu(null); }}>
                        <BsReply /> Responder
                      </button>
                      <button onClick={() => openForwardModal(msg)}>
                        <BsArrowRight /> Encaminhar
                      </button>
                      {msg.message_type === 'sticker' && msg.media_url && (
                        <button onClick={() => { setShowMessageMenu(null); handleSaveStickerFromMessage(msg); }}>
                          🎭 Salvar sticker
                        </button>
                      )}
                      {msg.message_type === 'text' && msg.text && (
                        <button onClick={() => handleCopyMessage(msg)}>
                          <MdContentCopy /> Copiar texto
                        </button>
                      )}
                      {msg.is_mine && msg.message_type === 'text' && (
                        <button onClick={() => { setEditingMessage(msg); setText(msg.text); setShowMessageMenu(null); }}>
                          <BsPencil /> Editar
                        </button>
                      )}
                      <button onClick={() => { onPinMessage?.(msg.id, !msg.is_pinned); setShowMessageMenu(null); }}>
                        {msg.is_pinned ? <BsPinFill /> : <BsPin />} {msg.is_pinned ? 'Desafixar' : 'Fixar na conversa'}
                      </button>
                      <button onClick={() => { onStarMessage(msg.id, !msg.is_starred); setShowMessageMenu(null); }}>
                        {msg.is_starred ? <BsStarFill /> : <BsStar />} {msg.is_starred ? 'Desfavoritar' : 'Adicionar aos favoritos'}
                      </button>
                      {msg.is_mine && (
                        <button className="message-action-menu-danger" onClick={() => { if (window.confirm('Apagar esta mensagem?')) onDeleteMessage(msg.id); setShowMessageMenu(null); }}>
                          <BsTrash /> Apagar para todos
                        </button>
                      )}
                    </div>
                  )}

                  {showEmojiPicker === msg.id && (
                    <div style={{ position: 'absolute', bottom: '100%', right: 0, zIndex: 1000 }}>
                      <EmojiPicker
                        onEmojiClick={(e) => { onReactMessage(msg.id, e.emoji); setShowEmojiPicker(null); }}
                        reactionsDefaultOpen={false}
                        height={350}
                        width={300}
                        theme={emojiPickerTheme}
                        categories={EMOJI_CATEGORIES_PT}
                        emojiData={EMOJI_DATA_PT}
                        searchPlaceholder={EMOJI_SEARCH_PLACEHOLDER_PT}
                        searchClearButtonLabel={EMOJI_SEARCH_CLEAR_LABEL_PT}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {showScrollToBottom && (
        <button className="scroll-to-bottom-btn" onClick={scrollToBottom} title="Ir para o final da conversa">
          <BsChevronDown size={20} />
        </button>
      )}

      {replyingTo && (
        <div className="reply-context-bar">
          <div className="reply-context-content">
            <BsReply size={16} />
            <div>
              <div className="reply-context-label">Respondendo a {replyingTo.sender_name}:</div>
              <div className="reply-context-text">{replyingTo.is_deleted ? 'Mensagem apagada' : (replyingTo.text || `[${replyingTo.message_type}]`)}</div>
            </div>
          </div>
          <button className="cancel-reply-btn" onClick={() => setReplyingTo(null)}><BsX size={24} /></button>
        </div>
      )}

      {editingMessage && (
        <div className="reply-context-bar">
          <div className="reply-context-content">
            <BsPencil size={16} />
            <div>
              <div className="reply-context-label">Editando mensagem</div>
              <div className="reply-context-text">{editingMessage.text}</div>
            </div>
          </div>
          <button className="cancel-reply-btn" onClick={() => { setEditingMessage(null); setText(''); }}><BsX size={24} /></button>
        </div>
      )}

      {selectedFile && (
        <div className="file-preview-container">
          <div className="file-preview-content">
            {filePreview ? (
              <img src={filePreview} alt="Preview" className="file-preview-image" />
            ) : (
              <span style={{ padding: '0 8px', fontSize: '0.9rem' }}>
                📄 {selectedFile.name}
              </span>
            )}
            <button
              className="remove-file-btn"
              title="Excluir"
              onClick={() => { setSelectedFile(null); setFilePreview(null); }}
            >
              <BsX size={20} />
            </button>
          </div>
        </div>
      )}

      <div className="message-input-container" style={{ position: 'relative' }} ref={composerRef}>
        {showInputEmojiPicker && (
          <div className="emoji-sticker-popover" style={{ position: 'absolute', bottom: '60px', left: '0', zIndex: 1000 }}>
            <div className="emoji-sticker-tabs">
              <button
                className={emojiPickerTab === 'emoji' ? 'active' : ''}
                onClick={() => setEmojiPickerTab('emoji')}
              >
                <BsEmojiSmile size={16} /> Emoji
              </button>
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
                onStickerCreated={(s) => setSavedStickers(prev => [s, ...prev])}
                onDeleteSticker={(id) => apiService.deleteSavedSticker(id).then(() => setSavedStickers(prev => prev.filter(s => s.id !== id)))}
              />
            ) : (
              <GifPicker onSelectGif={handleSelectGif} />
            )}
          </div>
        )}

        <button className="icon-button" onClick={() => setShowInputEmojiPicker(v => !v)} title="Emoji e stickers">
          <BsEmojiSmile size={24} />
        </button>

        <button className="icon-button" onClick={() => fileInputRef.current?.click()} title="Anexar arquivo">
          <BsPaperclip size={22} />
        </button>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileChange} />

        {onCreateTask && (
          <button className="icon-button" onClick={() => setShowTaskModal(true)} title="Nova tarefa">
            <BsListCheck size={22} />
          </button>
        )}

        <div className="message-input-box" style={{ flex: 1 }}>
          {isRecording ? (
            <span style={{ color: '#e53e3e', fontWeight: 500, padding: '0 8px' }}>🔴 Gravando... {recordingSeconds}s</span>
          ) : pendingAudio ? (
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
                src={pendingAudio.url}
                onPlay={() => setIsAudioPreviewPlaying(true)}
                onPause={() => setIsAudioPreviewPlaying(false)}
                onEnded={() => setIsAudioPreviewPlaying(false)}
                style={{ display: 'none' }}
              />
              <button
                className="icon-button" onClick={handleDiscardPendingAudio} title="Excluir gravação"
                style={{ color: '#e53e3e', padding: 4, marginLeft: 'auto' }}
              >
                <BsTrash size={16} />
              </button>
            </div>
          ) : (
            <textarea
              ref={inputRef}
              rows={1}
              spellCheck="true"
              lang="pt-BR"
              placeholder={editingMessage ? 'Editar mensagem...' : 'Digite uma mensagem'}
              value={text}
              onChange={handleTextChange}
              onKeyDown={(e) => {
                // Mesma paridade do ChatArea.js: Enter sozinho envia;
                // Shift+Enter quebra linha (comportamento nativo do
                // textarea); Alt+Enter também quebra linha, mas inserida
                // manualmente — o navegador/SO não trata esse atalho como
                // Enter normal, então depender do nativo não funciona.
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  handleSend();
                  return;
                }
                if (e.key === 'Enter' && e.altKey) {
                  e.preventDefault();
                  const el = e.target;
                  const start = el.selectionStart ?? text.length;
                  const end = el.selectionEnd ?? text.length;
                  const newText = text.slice(0, start) + '\n' + text.slice(end);
                  setText(newText);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = start + 1;
                  });
                }
              }}
              onPaste={handleComposerPaste}
              onFocus={() => setShowInputEmojiPicker(false)}
            />
          )}
        </div>

        {/* Lixeira — só durante a gravação, descarta sem virar prévia
            (diferente de parar, que abre a prévia pra ouvir antes de
            decidir). Igual ao WhatsApp: cancelar e parar são ações separadas. */}
        {isRecording && (
          <button className="icon-button" onClick={handleCancelRecording} title="Descartar gravação" style={{ color: '#e53e3e' }}>
            <BsTrash size={20} />
          </button>
        )}

        {!text.trim() && !isRecording && !pendingAudio && !selectedFile && (
          <button className="icon-button" onClick={handleStartRecording} title="Gravar áudio">
            <BsMicFill size={22} />
          </button>
        )}
        {isRecording && (
          <button className="icon-button" onClick={handleStopRecording} title="Parar gravação" style={{ color: '#e53e3e' }}>
            <BsStopFill size={22} />
          </button>
        )}

        <button
          className="send-button"
          onClick={() => pendingAudio ? handleSendPendingAudio() : handleSend()}
          disabled={!text.trim() && !pendingAudio && !selectedFile}
        >
          <IoSendSharp size={24} />
        </button>
      </div>

      {forwardTarget && (
        <div className="modal-overlay" onClick={() => setForwardTarget(null)}>
          <div className="modal-content" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Encaminhar mensagem</h3>
              <button className="icon-btn" onClick={() => setForwardTarget(null)}><BsX size={24} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)', margin: '4px 0' }}>Equipe</div>
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: 8 }}>
                {(internalChats || []).filter(c => c.id !== conversation.id).map(c => (
                  <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 14, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedTargetIds.includes(c.id)}
                      onChange={() => setSelectedTargetIds(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
              {onForwardMessageToWhatsApp && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #888)', margin: '10px 0 4px' }}>Clientes (WhatsApp)</div>
                  <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border-color, #ddd)', borderRadius: 6, padding: 8 }}>
                    {(conversations || []).filter(c => !c.is_group).map(c => (
                      <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 14, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selectedWaTargetIds.includes(c.id)}
                          onChange={() => setSelectedWaTargetIds(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}
                        />
                        {getWaConvName(c)}
                      </label>
                    ))}
                  </div>
                </>
              )}
              <button
                className="btn-primary" style={{ width: '100%', marginTop: 10 }} onClick={confirmForward}
                disabled={selectedTargetIds.length === 0 && selectedWaTargetIds.length === 0}
              >
                Encaminhar
              </button>
            </div>
          </div>
        </div>
      )}

      {showTaskModal && (
        <TaskModal
          conversation={conversation}
          currentUserId={currentUserId}
          onClose={() => setShowTaskModal(false)}
          onCreate={(payload) => onCreateTask(payload)}
        />
      )}

      {lightboxMedia && (
        <ImageLightbox
          src={lightboxMedia.src}
          type={lightboxMedia.type}
          onClose={() => setLightboxMedia(null)}
        />
      )}
    </div>
  );
};

export default InternalChatArea;
