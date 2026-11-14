/**
 * API Service - Comunicação com Backend Python (FastAPI)
 * 
 * VERSÃO CORRIGIDA - Trata corretamente o formato de resposta do backend
 * 
 * IMPORTANTE: Todas as rotas da API têm prefixo /api
 * - Em desenvolvimento: http://localhost:8000/api/*
 * - Em produção: https://seu-dominio.railway.app/api/*
 */
import axios from 'axios';

/**
 * Detecta automaticamente a URL base
 */
function getBaseURL() {
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  if (isLocalhost) {
    // Desenvolvimento local
    return process.env.REACT_APP_API_URL || 'http://localhost:8000';
  }
  
  // Produção (Railway) - URL relativa
  return '';
}

const API_URL = getBaseURL();

// Configurar axios com prefixo /api
const api = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Interceptor para logs (apenas em desenvolvimento)
if (process.env.NODE_ENV === 'development') {
  api.interceptors.request.use(
    config => {
      console.log('API Request:', config.method.toUpperCase(), config.url);
      return config;
    },
    error => {
      console.error('API Request Error:', error);
      return Promise.reject(error);
    }
  );

  api.interceptors.response.use(
    response => {
      console.log('API Response:', response.config.url, response.status);
      return response;
    },
    error => {
      console.error('API Response Error:', error.response?.status, error.message);
      return Promise.reject(error);
    }
  );
}

// Token de autenticação SEMPRE adicionado (produção e dev)
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    if (config.headers && config.headers.set) {
      config.headers.set('Authorization', `Bearer ${token}`);
    } else {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
  }
  return config;
});

// Sessão expirada/token inválido: limpa a sessão local e avisa o app para
// voltar à tela de login, em vez de deixar a UI presa num estado "logado"
// com contas/dados protegidos silenciosamente vazios (ver 401 em /api/settings/accounts).
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';
    const isAuthEndpoint = url.includes('/api/auth/login') || url.includes('/api/auth/register');

    if (status === 401 && !isAuthEndpoint && localStorage.getItem('token')) {
      localStorage.removeItem('token');
      localStorage.removeItem('currentUser');
      window.dispatchEvent(new CustomEvent('auth:session-expired'));
    }

    return Promise.reject(error);
  }
);

/**
 * API Service
 * 
 * NOTA: Todos os endpoints têm prefixo /api/
 */
const apiService = {
  /**
   * Health Check
   */
  healthCheck: async () => {
    const response = await api.get('/api/health');
    return response.data;
  },

  /**
   * Obter informações da API
   */
  getApiInfo: async () => {
    const response = await api.get('/api');
    return response.data;
  },

  /**
   * Obter configurações da API
   */
  getApiConfig: async () => {
    const response = await api.get('/api/config');
    return response.data;
  },

  /**
   * Abre (cria se necessário) a conversa 1:1 com um número, sem enviar
   * mensagem no WhatsApp. Usado pelo botão "Abrir conversa" do modal de
   * info de participante de grupo.
   */
  openConversation: async (phoneNumber, accountId = null) => {
    const response = await api.post('/api/conversations/open', {
      phone_number: phoneNumber,
      account_id: accountId,
    });
    return response.data;
  },

  /**
   * CORRIGIDO: Obter todas as conversas
   * Backend retorna: { success: true, data: [...] }
   * Devemos retornar apenas o array de conversas
   */
  getConversations: async (accountId = null) => {
    try {
      const params = accountId ? `?account_id=${accountId}` : '';
      const response = await api.get(`/api/conversations${params}`);
      console.log('Response completo:', response.data);
  
      if (response.data && response.data.success) {
        return response.data.data || [];
      }
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      console.error('Erro ao buscar conversas:', error);
      return [];
    }
  },


  /**
   * Atendimento — fila/atribuição/status (Fase A)
   */
  getAgents: async () => {
    try {
      const response = await api.get('/api/agents');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar agentes:', error);
      return [];
    }
  },

  updateConversationStatus: async (conversationId, status, options = {}) => {
    const payload = { status };
    // sendCsat: undefined = comportamento padrão (manda se a automação
    // estiver ligada); false = pula CSAT nessa resolução específica.
    if (options.sendCsat !== undefined) payload.send_csat = options.sendCsat;
    const response = await api.patch(`/api/conversations/${conversationId}/status`, payload);
    return response.data;
  },

  updateContactName: async (contactId, name, accountId) => {
    const response = await api.patch(`/api/contacts/${contactId}`, { name, account_id: accountId });
    return response.data;
  },

  updateContactInternal: async (contactId, isInternal) => {
    const response = await api.patch(`/api/contacts/${contactId}`, { is_internal: isInternal });
    return response.data;
  },

  updateContactNotes: async (contactId, notes) => {
    const response = await api.patch(`/api/contacts/${contactId}`, { notes });
    return response.data;
  },

  listInternalContacts: async () => {
    try {
      const response = await api.get('/api/contacts/internal');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar contatos internos:', error);
      return [];
    }
  },

  addInternalContact: async (phoneNumber) => {
    const response = await api.post('/api/contacts/internal', { phone_number: phoneNumber });
    return response.data;
  },

  removeInternalContact: async (contactId) => {
    const response = await api.delete(`/api/contacts/internal/${contactId}`);
    return response.data;
  },

  assignConversation: async (conversationId, userId) => {
    const response = await api.post(`/api/conversations/${conversationId}/assign`, { user_id: userId });
    return response.data;
  },

  updateConversationBot: async (conversationId, enabled) => {
    const response = await api.patch(`/api/conversations/${conversationId}/bot`, { enabled });
    return response.data;
  },

  pinConversation: async (conversationId, pinned) => {
    const response = await api.patch(`/api/conversations/${conversationId}/pin`, { pinned });
    return response.data;
  },

  favoriteConversation: async (conversationId, favorite) => {
    const response = await api.patch(`/api/conversations/${conversationId}/favorite`, { favorite });
    return response.data;
  },

  muteConversation: async (conversationId, muted) => {
    const response = await api.patch(`/api/conversations/${conversationId}/mute`, { muted });
    return response.data;
  },

  getTags: async () => {
    try {
      const response = await api.get('/api/tags');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar etiquetas:', error);
      return [];
    }
  },

  // scope: 'global'|'sector'|'personal'. sector só vale com scope='sector'.
  // taskTitle presente = aplicar a etiqueta cria uma tarefa vinculada à
  // conversa automaticamente (ver create_standalone_task no backend).
  // sharedWith só vale com scope='personal' (mesmo modelo de Resposta Rápida).
  createTag: async ({ name, color, scope, sector, taskTitle, taskDescription, taskPriority, taskDueDays, taskAssignedTo, sharedWith }) => {
    const response = await api.post('/api/tags', {
      name, color: color || '#8696A0', scope: scope || 'global', sector: sector || null,
      task_title: taskTitle || null, task_description: taskDescription || null,
      task_priority: taskPriority || 'medium', task_due_days: taskDueDays || null,
      task_assigned_to: taskAssignedTo || null, shared_with: sharedWith || [],
    });
    return response.data;
  },

  updateTag: async (tagId, { name, color, scope, sector, taskTitle, taskDescription, taskPriority, taskDueDays, taskAssignedTo, sharedWith }) => {
    const response = await api.patch(`/api/tags/${tagId}`, {
      name, color: color || '#8696A0', scope: scope || 'global', sector: sector || null,
      task_title: taskTitle || null, task_description: taskDescription || null,
      task_priority: taskPriority || 'medium', task_due_days: taskDueDays || null,
      task_assigned_to: taskAssignedTo || null, shared_with: sharedWith || [],
    });
    return response.data;
  },

  deleteTag: async (tagId) => {
    const response = await api.delete(`/api/tags/${tagId}`);
    return response.data;
  },

  addConversationTag: async (conversationId, tagId) => {
    const response = await api.post(`/api/conversations/${conversationId}/tags`, { tag_id: tagId });
    return response.data;
  },

  removeConversationTag: async (conversationId, tagId) => {
    const response = await api.delete(`/api/conversations/${conversationId}/tags/${tagId}`);
    return response.data;
  },

  getNotes: async (conversationId) => {
    try {
      const response = await api.get(`/api/conversations/${conversationId}/notes`);
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar notas internas:', error);
      return [];
    }
  },

  createNote: async (conversationId, text) => {
    const response = await api.post(`/api/conversations/${conversationId}/notes`, { text });
    return response.data;
  },

  getQuickReplies: async () => {
    try {
      const response = await api.get('/api/quick-replies');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar respostas rápidas:', error);
      return [];
    }
  },

  createQuickReply: async (payload) => {
    const response = await api.post('/api/quick-replies', payload);
    return response.data;
  },

  updateQuickReply: async (id, payload) => {
    const response = await api.patch(`/api/quick-replies/${id}`, payload);
    return response.data;
  },

  deleteQuickReply: async (id) => {
    const response = await api.delete(`/api/quick-replies/${id}`);
    return response.data;
  },

  // Baixa a mídia salva de uma resposta rápida (uploads/ do próprio backend)
  // como Blob, pra virar um File e entrar no fluxo normal de envio de mídia.
  fetchMediaBlob: async (relativeUrl) => {
    const response = await api.get(relativeUrl, { responseType: 'blob' });
    return response.data;
  },

  /**
   * Automações (auto-resposta/fora-do-horário/CSAT/SLA) — mesmo endpoint que
   * o SettingsModal já usa via fetch direto, exposto aqui pra outras telas
   * (badge de SLA na Sidebar, painel de Relatórios) não duplicarem a URL.
   */
  getAutomations: async () => {
    try {
      const response = await api.get('/api/settings/automations');
      return response.data?.data || response.data || {};
    } catch (error) {
      console.error('Erro ao buscar automações:', error);
      return {};
    }
  },

  getStatusColors: async () => {
    try {
      const response = await api.get('/api/status-colors');
      return response.data?.success ? response.data.data : null;
    } catch (error) {
      console.error('Erro ao buscar cores de status:', error);
      return null;
    }
  },

  updateStatusColors: async (colors) => {
    const response = await api.patch('/api/status-colors', colors);
    return response.data;
  },

  getAttendanceReports: async (days = 7) => {
    try {
      const response = await api.get(`/api/attendance/reports?days=${days}`);
      return response.data?.success ? response.data.data : null;
    } catch (error) {
      console.error('Erro ao buscar relatório de atendimento:', error);
      return null;
    }
  },

  getInternalTaskReports: async (days = 7) => {
    try {
      const response = await api.get(`/api/internal-chats/tasks/reports?days=${days}`);
      return response.data?.success ? response.data.data : null;
    } catch (error) {
      console.error('Erro ao buscar relatório de tarefas internas:', error);
      return null;
    }
  },

  /**
   * Chat interno — comunicação entre usuários da equipe, sem ligação com
   * nenhuma conversa de cliente/WhatsApp.
   */
  getInternalChats: async () => {
    try {
      const response = await api.get('/api/internal-chats');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar chats internos:', error);
      return [];
    }
  },

  getOrCreateInternalDM: async (userId) => {
    const response = await api.post('/api/internal-chats/dm', { user_id: userId });
    return response.data;
  },

  createInternalGroup: async (name, participantIds) => {
    const response = await api.post('/api/internal-chats/group', { name, participant_ids: participantIds });
    return response.data;
  },

  getInternalChatMessages: async (conversationId) => {
    try {
      const response = await api.get(`/api/internal-chats/${conversationId}/messages`);
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar mensagens do chat interno:', error);
      return [];
    }
  },

  sendInternalChatMessage: async (conversationId, text, replyToId = null) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/messages`, { text, reply_to_id: replyToId });
    return response.data;
  },

  sendInternalChatMedia: async (conversationId, file, messageType, caption = '', replyToId = null) => {
    const formData = new FormData();
    formData.append('media', file);
    formData.append('message_type', messageType);
    formData.append('caption', caption);
    if (replyToId) formData.append('reply_to_id', replyToId);
    const response = await api.post(`/api/internal-chats/${conversationId}/media`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  editInternalChatMessage: async (conversationId, messageId, text) => {
    const response = await api.patch(`/api/internal-chats/${conversationId}/messages/${messageId}`, { text });
    return response.data;
  },

  deleteInternalChatMessage: async (conversationId, messageId) => {
    const response = await api.delete(`/api/internal-chats/${conversationId}/messages/${messageId}`);
    return response.data;
  },

  reactInternalChatMessage: async (conversationId, messageId, emoji) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/messages/${messageId}/react`, { emoji });
    return response.data;
  },

  starInternalChatMessage: async (conversationId, messageId, starred) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/messages/${messageId}/star`, { starred });
    return response.data;
  },

  pinInternalChatMessage: async (conversationId, messageId, pinned) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/messages/${messageId}/pin`, { pinned });
    return response.data;
  },

  pinInternalChat: async (conversationId, pinned) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/pin`, { pinned });
    return response.data;
  },

  favoriteInternalChat: async (conversationId, favorite) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/favorite`, { favorite });
    return response.data;
  },

  muteInternalChat: async (conversationId, muted) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/mute`, { muted });
    return response.data;
  },

  searchInternalChats: async (query) => {
    try {
      const response = await api.get('/api/internal-chats/search', { params: { q: query } });
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar conversas internas:', error);
      return [];
    }
  },

  searchInternalMessages: async (query) => {
    try {
      const response = await api.get('/api/internal-chats/messages/search', { params: { q: query } });
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar mensagens internas:', error);
      return [];
    }
  },

  uploadMyPhoto: async (file) => {
    const formData = new FormData();
    formData.append('photo', file);
    const response = await api.post('/api/settings/me/photo', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  copyMyPhotoFromWhatsApp: async (jid, accountId) => {
    const response = await api.post('/api/settings/me/photo/from-whatsapp', { jid, account_id: accountId });
    return response.data;
  },

  getInternalTasks: async (conversationId) => {
    try {
      const response = await api.get(`/api/internal-chats/${conversationId}/tasks`);
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar tarefas do chat interno:', error);
      return [];
    }
  },

  markTasksViewed: async (conversationId) => {
    try { await api.post(`/api/internal-chats/${conversationId}/tasks/mark-viewed`); }
    catch { /* não crítico — badge só fica desatualizado até a próxima tentativa */ }
  },

  getMyTasks: async () => {
    try {
      const response = await api.get('/api/internal-chats/tasks/mine');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar minhas tarefas:', error);
      return [];
    }
  },

  createInternalTask: async (conversationId, { title, description, assignedTo, dueAt, priority, recurrenceInterval, recurrenceEvery, recurrenceDaysOfWeek }) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/tasks`, {
      title, description: description || null, assigned_to: assignedTo || null, due_at: dueAt || null,
      priority: priority || null,
      recurrence_interval: recurrenceInterval || null, recurrence_every: recurrenceEvery || null,
      recurrence_days_of_week: recurrenceDaysOfWeek || null,
    });
    return response.data;
  },

  // Tarefa SEM chat interno — pessoal (customerConversationId ausente) ou
  // vinculada a uma conversa de CLIENTE (customerConversationId presente).
  // Nunca gera card/mensagem em timeline nenhuma, ver create_standalone_task.
  createStandaloneTask: async ({ title, description, assignedTo, dueAt, priority, recurrenceInterval, recurrenceEvery, recurrenceDaysOfWeek, customerConversationId }) => {
    const response = await api.post('/api/internal-chats/tasks', {
      title, description: description || null, assigned_to: assignedTo || null, due_at: dueAt || null,
      priority: priority || null,
      recurrence_interval: recurrenceInterval || null, recurrence_every: recurrenceEvery || null,
      recurrence_days_of_week: recurrenceDaysOfWeek || null,
      customer_conversation_id: customerConversationId || null,
    });
    return response.data;
  },

  getCustomerConversationTasks: async (conversationId) => {
    try {
      const response = await api.get(`/api/internal-chats/customer-conversations/${conversationId}/tasks`);
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar tarefas da conversa:', error);
      return [];
    }
  },

  updateInternalTaskStatus: async (taskId, status) => {
    const response = await api.patch(`/api/internal-chats/tasks/${taskId}`, { status });
    return response.data;
  },

  // patch: { title?, description?, assignedTo?, dueAt?, status?, clearAssignedTo?, clearDueAt? }
  updateInternalTask: async (taskId, patch) => {
    const body = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.assignedTo !== undefined) body.assigned_to = patch.assignedTo;
    if (patch.dueAt !== undefined) body.due_at = patch.dueAt;
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.priority !== undefined) body.priority = patch.priority;
    if (patch.clearAssignedTo) body.assigned_to_clear = true;
    if (patch.clearDueAt) body.due_at_clear = true;
    if (patch.pauseReminderAt !== undefined) body.pause_reminder_at = patch.pauseReminderAt;
    if (patch.clearPauseReminderAt) body.pause_reminder_at_clear = true;
    const response = await api.patch(`/api/internal-chats/tasks/${taskId}`, body);
    return response.data;
  },

  approveInternalTask: async (taskId) => {
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/approve`);
    return response.data;
  },

  rejectInternalTask: async (taskId) => {
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/reject`);
    return response.data;
  },

  pauseInternalTask: async (taskId, reason, reminderAt) => {
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/pause`, { reason, reminder_at: reminderAt || null });
    return response.data;
  },

  resumeInternalTask: async (taskId) => {
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/resume`);
    return response.data;
  },

  cancelInternalTask: async (taskId, reason) => {
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/cancel`, { reason });
    return response.data;
  },

  uncancelInternalTask: async (taskId) => {
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/uncancel`);
    return response.data;
  },

  getPushVapidPublicKey: async () => {
    const response = await api.get('/api/push/vapid-public-key');
    return response.data;
  },

  subscribeToPush: async (subscription) => {
    const response = await api.post('/api/push/subscribe', subscription);
    return response.data;
  },

  unsubscribeFromPush: async (endpoint) => {
    const response = await api.post('/api/push/unsubscribe', { endpoint });
    return response.data;
  },

  createTaskSubtask: async (taskId, title) => {
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/subtasks`, { title });
    return response.data;
  },

  updateTaskSubtask: async (taskId, subtaskId, patch) => {
    const response = await api.patch(`/api/internal-chats/tasks/${taskId}/subtasks/${subtaskId}`, patch);
    return response.data;
  },

  deleteTaskSubtask: async (taskId, subtaskId) => {
    const response = await api.delete(`/api/internal-chats/tasks/${taskId}/subtasks/${subtaskId}`);
    return response.data;
  },

  addTaskAttachment: async (taskId, file) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post(`/api/internal-chats/tasks/${taskId}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  deleteTaskAttachment: async (taskId, attachmentId) => {
    const response = await api.delete(`/api/internal-chats/tasks/${taskId}/attachments/${attachmentId}`);
    return response.data;
  },

  forwardInternalChatMessage: async (conversationId, messageId, targetConversationIds) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/messages/${messageId}/forward`, { target_conversation_ids: targetConversationIds });
    return response.data;
  },

  forwardInternalMessageToWhatsApp: async (messageId, targetConversationIds) => {
    const response = await api.post(`/api/internal-chats/messages/${messageId}/forward-to-whatsapp`, { target_conversation_ids: targetConversationIds });
    return response.data;
  },

  // Favoritar/fixar mensagem de cliente (WhatsApp) — persistem no banco
  // (Message.is_starred/is_pinned), diferente da chamada de protocolo pura
  // (baileysApi.starMessage/pinMessage) que só reflete no app do celular.
  starWhatsAppMessage: async (conversationId, wamid, starred) => {
    const response = await api.post(`/api/conversations/${conversationId}/messages/${wamid}/star`, { starred });
    return response.data;
  },

  pinWhatsAppMessage: async (conversationId, wamid, pinned) => {
    const response = await api.post(`/api/conversations/${conversationId}/messages/${wamid}/pin`, { pinned });
    return response.data;
  },

  // Retry manual (ícone "!" vermelho, ver ChatArea.js) de mensagem que
  // chegou do WhatsApp mas não foi possível salvar no banco na hora —
  // reprocessa o payload original guardado em Message.failed_payload.
  retryFailedMessage: async (messageId) => {
    const response = await api.post(`/api/webhook/bridge/retry-failed/${messageId}`);
    return response.data;
  },

  // Retry manual de mensagem NOSSA que falhou ao enviar — reaproveita os
  // dados originais do envio e tenta de novo pelo mesmo provider.
  retrySendMessage: async (messageId) => {
    const response = await api.post(`/api/messages/${messageId}/retry-send`);
    return response.data;
  },

  forwardMessageToInternal: async (conversationId, wamid, targetInternalConversationIds) => {
    const response = await api.post(`/api/conversations/${conversationId}/messages/${wamid}/forward-to-internal`, { target_internal_conversation_ids: targetInternalConversationIds });
    return response.data;
  },

  markInternalChatRead: async (conversationId) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/read`);
    return response.data;
  },

  getInternalChatPresence: async (userIds) => {
    try {
      const response = await api.get(`/api/internal-chats/presence?user_ids=${userIds.join(',')}`);
      return response.data?.success ? (response.data.data || {}) : {};
    } catch (error) {
      console.error('Erro ao buscar presença:', error);
      return {};
    }
  },

  setMyPresenceStatus: async (status) => {
    const response = await api.patch('/api/internal-chats/me/presence-status', { status });
    return response.data;
  },

  addInternalGroupParticipants: async (conversationId, userIds) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/participants`, { user_ids: userIds });
    return response.data;
  },

  removeInternalGroupParticipant: async (conversationId, userId) => {
    const response = await api.delete(`/api/internal-chats/${conversationId}/participants/${userId}`);
    return response.data;
  },

  setInternalGroupAdmin: async (conversationId, userId, isAdmin) => {
    const response = await api.post(`/api/internal-chats/${conversationId}/participants/${userId}/admin`, { is_admin: isAdmin });
    return response.data;
  },

  renameInternalGroup: async (conversationId, name) => {
    const response = await api.patch(`/api/internal-chats/${conversationId}`, { name });
    return response.data;
  },

  updateInternalGroupPhoto: async (conversationId, file) => {
    const formData = new FormData();
    formData.append('photo', file);
    const response = await api.post(`/api/internal-chats/${conversationId}/photo`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  /**
   * Stickers — conversão de imagem própria + galeria pessoal salva.
   */
  convertToSticker: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post('/api/stickers/convert', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  getSavedStickers: async () => {
    try {
      const response = await api.get('/api/stickers/saved');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar stickers salvos:', error);
      return [];
    }
  },

  saveSticker: async (mediaUrl, mimeType, sourceWamid) => {
    const response = await api.post('/api/stickers/saved', { media_url: mediaUrl, mime_type: mimeType, source_wamid: sourceWamid });
    return response.data;
  },

  deleteSavedSticker: async (id) => {
    const response = await api.delete(`/api/stickers/saved/${id}`);
    return response.data;
  },

  getSavedContacts: async () => {
    try {
      const response = await api.get('/api/saved-contacts');
      return response.data?.success ? (response.data.data || []) : [];
    } catch (error) {
      console.error('Erro ao buscar contatos salvos:', error);
      return [];
    }
  },

  saveContact: async (displayName, contactData) => {
    const response = await api.post('/api/saved-contacts', { display_name: displayName, contact_data: contactData });
    return response.data;
  },

  updateSavedContact: async (id, updates) => {
    const response = await api.put(`/api/saved-contacts/${id}`, updates);
    return response.data;
  },

  deleteSavedContact: async (id) => {
    const response = await api.delete(`/api/saved-contacts/${id}`);
    return response.data;
  },

  searchGifs: async (query, offset = 0) => {
    const response = await api.get('/api/giphy/search', { params: { q: query, offset } });
    return response.data?.success ? (response.data.data || []) : [];
  },

  trendingGifs: async (offset = 0) => {
    const response = await api.get('/api/giphy/trending', { params: { offset } });
    return response.data?.success ? (response.data.data || []) : [];
  },

  /**
   * Busca conversas pelo nome/telefone do contato (aba "Conversas" da busca).
   */
  searchConversations: async (query, accountId = null) => {
    try {
      const params = new URLSearchParams({ q: query });
      if (accountId) params.set('account_id', accountId);
      const response = await api.get(`/api/conversations/search?${params.toString()}`);
      if (response.data && response.data.success) {
        return response.data.data || [];
      }
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      console.error('Erro ao buscar conversas por termo:', error);
      return [];
    }
  },

  /**
   * Busca todas as ocorrências de mensagens com o termo (aba "Mensagens" da
   * busca) — cada resultado identifica quem mandou, quando e em qual conversa.
   */
  searchMessages: async (query, accountId = null) => {
    try {
      const params = new URLSearchParams({ q: query });
      if (accountId) params.set('account_id', accountId);
      const response = await api.get(`/api/messages/search?${params.toString()}`);
      if (response.data && response.data.success) {
        return response.data.data || [];
      }
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      console.error('Erro ao buscar mensagens por termo:', error);
      return [];
    }
  },

  /**
   * Status (Stories) das últimas 24h — separado da lista normal de conversas.
   */
  getStatuses: async (accountId = null) => {
    try {
      const params = accountId ? `?account_id=${accountId}` : '';
      const response = await api.get(`/api/statuses${params}`);
      return response.data?.data?.messages || [];
    } catch (error) {
      console.error('Erro ao buscar status:', error);
      return [];
    }
  },

  /**
   * CORRIGIDO: Obter mensagens de uma conversa específica
   */
  getMessages: async (conversationId) => {
    try {
      // CORREÇÃO: Usar o endpoint dedicado /api/conversations/{conversation_id}/messages
      const response = await api.get(`/api/conversations/${conversationId}/messages`);

      // O backend retorna: {"success": true, "data": {"conversation_id": id, "messages": [...] }}
      return response.data.data.messages || [];

    } catch (error) {
      console.error(`Erro ao buscar mensagens para conv ID ${conversationId}:`, error);
      return [];
    }
  },

  /**
   * Paginação: carrega mensagens ANTERIORES a beforeTimestamp (rolar pro
   * topo do chat). Função separada de getMessages (que sempre traz as N
   * mais recentes) pra não mudar o formato de retorno usado no 1º
   * carregamento — aqui devolve também `hasMore`, pra saber se ainda existe
   * histórico mais antigo pra buscar.
   */
  getOlderMessages: async (conversationId, beforeTimestamp, limit = 50) => {
    try {
      const response = await api.get(`/api/conversations/${conversationId}/messages`, {
        params: { before_timestamp: beforeTimestamp, limit },
      });
      const data = response.data?.data || {};
      return { messages: data.messages || [], hasMore: !!data.has_more };
    } catch (error) {
      console.error(`Erro ao buscar mensagens antigas para conv ID ${conversationId}:`, error);
      return { messages: [], hasMore: false };
    }
  },

  /**
   * ATUALIZADO: Enviar mensagem de texto
   * 
   * Usando /api/send/text (JSON payload)
   */
  sendTextMessage: async (to, text, reply_to = null, account_id = null, preview_url = true) => {
    const payload = {
      to,
      text,
      preview_url
    };

    if (reply_to) {
      payload.reply_to = reply_to;
    }

    if (account_id) {
      payload.account_id = account_id;
    }

    try {
      const response = await api.post('/api/send/text', payload);
      return response.data.data;
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.response?.data || err.message;
      console.error('send/text detalhe do erro:', detail);
      throw err;
    }
  },
  
  sendMediaMessage: async (to, file, type, caption = '', reply_to = null, account_id = null) => {
    const formData = new FormData();
    formData.append('to', to);
    formData.append('media', file);
    formData.append('type', type);

    if (caption) formData.append('caption', caption);
    if (reply_to) formData.append('reply_to', reply_to);
    if (account_id) formData.append('account_id', account_id);

    const response = await api.post('/api/send/media', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data.data;
  },

  uploadPublicMedia: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post('/api/upload/public', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data; // { success: true, url: '...', path: '...' }
  },

  /**
   * Enviar template (mensagens pré-aprovadas)
   * 
   * Usando /api/send/template (JSON payload)
   */
  sendTemplate: async (to, templateName, languageCode, components = [], account_id = null) => {
    const response = await api.post('/api/send/template', {
      to,
      template_name: templateName,
      language_code: languageCode,
      components,
      account_id,
    });
    return response.data;
  },

  getTemplates: async ({ forceRefresh = false, category = null, status = null } = {}) => {
  const params = new URLSearchParams();
  if (forceRefresh) params.set('force_refresh', 'true');
  if (category)     params.set('category', category);
  if (status)       params.set('status', status);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/templates${query}`);
  const d = response.data;
  return { source: d.source || 'unknown', total: d.total || 0, templates: d.data || [] };
},

syncTemplates: async () => {
  const response = await api.post('/api/templates/sync');
  return response.data;
},

getTemplate: async (templateName) => {
  const response = await api.get(`/api/templates/${encodeURIComponent(templateName)}`);
  return response.data?.data || null;
},

createTemplate: async ({ name, language = 'pt_BR', category, components, variable_labels = null, account_id = null }) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/templates${query}`, { name, language, category, components, variable_labels });
  return response.data;
},

getTemplateVariableLabels: async (templateName, language = 'pt_BR') => {
  const response = await api.get(`/api/templates/${encodeURIComponent(templateName)}/variable-labels?language=${encodeURIComponent(language)}`);
  return response.data?.labels || {};
},

uploadTemplateHeaderMedia: async (file, account_id = null) => {
  const formData = new FormData();
  formData.append('file', file);
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/templates/upload-header-media${query}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data; // { success, header_handle, format }
},

deleteTemplate: async (templateName, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.delete(`/api/templates/${encodeURIComponent(templateName)}${query}`);
  return response.data;
},

getCatalogProducts: async (account_id = null, after = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  if (after) params.set('after', after);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/catalog/products${query}`);
  return response.data;
},

createCatalogProduct: async (product, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/catalog/products${query}`, product);
  return response.data;
},

updateCatalogProduct: async (productId, patch, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.patch(`/api/catalog/products/${encodeURIComponent(productId)}${query}`, patch);
  return response.data;
},

deleteCatalogProduct: async (productId, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.delete(`/api/catalog/products/${encodeURIComponent(productId)}${query}`);
  return response.data;
},

getEmbeddedSignupConfig: async () => {
  const response = await api.get('/api/embedded-signup/config');
  return response.data;
},

exchangeEmbeddedSignupCode: async (code) => {
  const response = await api.post('/api/embedded-signup/exchange-code', { code });
  return response.data;
},

createAccountFromSignup: async (payload) => {
  const response = await api.post('/api/embedded-signup/create-account', payload);
  return response.data;
},

registerSignupNumber: async (account_id, pin) => {
  const response = await api.post('/api/embedded-signup/register-number', { account_id, pin });
  return response.data;
},

getFlowFields: async (flowId, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/flows/${encodeURIComponent(flowId)}/fields${query}`);
  return response.data;
},

getPhoneNumberList: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/extended/phone/list${query}`);
  return response.data?.data || [];
},

getSubscribedApps: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/meta/subscribed-apps${query}`);
  return response.data;
},

subscribeApp: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/meta/subscribed-apps/subscribe${query}`);
  return response.data;
},

getMMLiteStatus: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/mmlite/status${query}`);
  return response.data;
},

getMMLiteAnalytics: async (account_id = null, days = 7) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  params.set('days', days);
  const response = await api.get(`/api/mmlite/analytics?${params}`);
  return response.data;
},

getCoexistenceStatus: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/coexistence/status${query}`);
  return response.data;
},

getFlowKeysStatus: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/flows/keys/status${query}`);
  return response.data;
},

generateFlowKeys: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/flows/keys/generate${query}`);
  return response.data;
},

getFlows: async (account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.get(`/api/flows${query}`);
  return response.data;
},

createFlow: async ({ name, categories, endpoint_uri = null }, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/flows${query}`, { name, categories, endpoint_uri });
  return response.data;
},

uploadFlowJson: async (flowId, flow_json, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/flows/${encodeURIComponent(flowId)}/json${query}`, { flow_json });
  return response.data;
},

setFlowEndpointUri: async (flowId, endpoint_uri, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/flows/${encodeURIComponent(flowId)}/endpoint-uri${query}`, { endpoint_uri });
  return response.data;
},

publishFlow: async (flowId, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.post(`/api/flows/${encodeURIComponent(flowId)}/publish${query}`);
  return response.data;
},

deleteFlow: async (flowId, account_id = null) => {
  const params = new URLSearchParams();
  if (account_id) params.set('account_id', account_id);
  const query = params.toString() ? `?${params}` : '';
  const response = await api.delete(`/api/flows/${encodeURIComponent(flowId)}${query}`);
  return response.data;
},

  /**
   * Enviar carrossel (2-10 cards horizontais)
   */
  sendCarousel: async (to, cards) => {
    const response = await api.post('/api/extended/send/carousel', {
      to,
      cards: cards.map(card => ({
        id: card.id,
        header_type: 'image',
        header_media_id: card.header_media_id,
        body_text: card.body_text,
        footer_text: card.footer_text || null,
        buttons: [
          {
            type: 'quick_reply',
            id: `btn_${card.id}`,
            text: card.button_text
          }
        ]
      }))
    });
    return response.data.data;
  },

  /**
   * Solicitar localização do usuário
   */
  sendLocationRequest: async (to, bodyText = 'Por favor, compartilhe sua localização') => {
    const response = await api.post('/api/extended/send/location-request', {
      to,
      body_text: bodyText
    });
    return response.data.data;
  },

/**
 * QR Codes Management
 * CORRIGIDO: URLs sem hífen (/qrcodes)
 */
createQRCode: async (message, imageFormat = 'PNG') => {
  const response = await api.post('/api/extended/qrcodes', {
    prefilled_message: message,
    generate_qr_image: imageFormat
  });
  return response.data.data;
},

listQRCodes: async () => {
  const response = await api.get('/api/extended/qrcodes');
  return response.data.data;
},

getQRCode: async (code) => {
  const response = await api.get(`/api/extended/qrcodes/${code}`);
  return response.data.data;
},

updateQRCode: async (code, message) => {
  const response = await api.patch(`/api/extended/qrcodes/${code}`, {
    prefilled_message: message
  });
  return response.data;
},

deleteQRCode: async (code) => {
  const response = await api.delete(`/api/extended/qrcodes/${code}`);
  return response.data;
},

  // START NEW IMPLEMENTATIONS (as requested)

  /**
   * Contas WhatsApp configuradas
   */
  getAccounts: async () => {
    try {
      const response = await api.get('/api/settings/accounts');
      const data = response.data;
      return Array.isArray(data) ? data : (data.data || []);
    } catch (error) {
      console.error('Erro ao buscar contas:', error);
      return [];
    }
  },

  updateAccount: async (id, data) => {
    const response = await api.patch(`/api/settings/accounts/${id}`, data);
    return response.data;
  },

  deleteAccount: async (id) => {
    const response = await api.delete(`/api/settings/accounts/${id}`);
    return response.data;
  },

  // Cria (ou devolve, se já existir) a conta Baileys "fallback de envio"
  // vinculada à conta WPPConnect {id} — ver fallback_for_account_id.
  createFallbackAccount: async (id) => {
    const response = await api.post(`/api/settings/accounts/${id}/fallback`);
    return response.data;
  },


  /**
   * Endpoint de Login
   * Usando /api/auth/login
   */
  login: async (email, password) => {
    try {
      const response = await api.post('/api/auth/login', { email, password });
      const data = response.data;
      if (data?.access_token) {
        return {
          token: data.access_token,
          user: data.user,
          active_account: data.active_account
        };
      }
      throw new Error('Login falhou.');
    } catch (error) {
      console.error('Erro durante o login:', error);
      throw new Error(error.response?.data?.detail || 'Erro de conexão ou credenciais inválidas.');
    }
  },

  /**
   * Retorna o usuário logado (id, email, full_name, is_admin, role, sector) —
   * usado para reidratar o estado ao recarregar a página com um token já salvo,
   * já que localStorage guardava só o username antes.
   */
  getMe: async () => {
    const response = await api.get('/api/auth/me');
    return response.data;
  },

  /**
   * Enviar mensagem com botões interativos
   * Endpoint: POST /api/send/interactive/buttons
   */
  sendInteractiveButtons: async (payload) => {
    const response = await api.post('/api/send/interactive/buttons', payload);
    return response.data.data; // Returns {message_id, buttons_count}
  },

  /**
   * Botão CTA (link externo) — Meta Cloud API
   */
  sendCtaUrlButton: async (payload) => {
    const response = await api.post('/api/send/interactive/cta-url', payload);
    return response.data.data;
  },

  /**
   * Remove uma reação previamente enviada
   */
  removeReaction: async (payload) => {
    const response = await api.post('/api/send/reaction/remove', payload);
    return response.data.data;
  },

  /**
   * Enviar reação a uma mensagem
   * @param {Object} payload - {to: string, message_id: string, emoji: string}
   */
  async sendReaction(payload) {
    // CORREÇÃO: Usar a rota correta /api/send/reaction que espera payload JSON
    const endpoint = '/api/send/reaction';
    const response = await api.post(endpoint, payload);
    return response.data.data;
  },
  
  // END NEW IMPLEMENTATIONS

  /**
   * CORRIGIDO: Marcar mensagem como lida (individualmente)
   *
   * @param {string} contactWaId - ID do contato (wa_id) (Used for context, but API uses WAMID)
   * @param {Array<string>} messageIds - Lista de WAMIDs a serem marcados como lidos
   */
  // VERIFICAR SE ESTÁ ASSIM:
  markAsRead: async (contactWaId, messageIds, account_id = null) => {
    let success = true;
    for (const wamid of messageIds) {
      try {
        const payload = { message_id: wamid };
        if (account_id) payload.account_id = account_id;
        await api.post('/api/messages/read', payload);
      } catch (e) {
        console.error(`Failed to mark WAMID ${wamid} as read`, e);
        success = false;
      }
    }
    return success;
  },

  /**
   * Marca TODAS as mensagens não lidas de uma conversa como lidas de uma vez
   * (POST /api/conversations/{id}/read) — diferente de markAsRead acima, que
   * só marca os wamids passados (limitados ao que está carregado na tela,
   * só os últimos 50 — ver get_conversation_messages no backend). Numa
   * conversa com mais não lidas do que isso, as mais antigas nunca eram
   * carregadas no front, então markAsRead nunca as via e o contador de não
   * lidas ficava preso pra sempre. Este endpoint busca direto no banco, sem
   * depender do que está carregado no cliente.
   */
  markConversationRead: async (conversationId) => {
    const response = await api.post(`/api/conversations/${conversationId}/read`);
    return response.data;
  },

  markConversationUnread: async (conversationId) => {
    const response = await api.post(`/api/conversations/${conversationId}/unread`);
    return response.data;
  },

  /**
   * Obter URL de mídia
   * 
   * @param {string} mediaId - ID da mídia do WhatsApp
   * @returns {string} URL para acessar a mídia
   */
  getMediaUrl: (mediaId) => {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocalhost) {
      return `${API_URL}/api/media/proxy/${mediaId}`;
    } else {
      return `/api/media/proxy/${mediaId}`;
    }
  },

  clearConversationMessages: (conversationId) =>
    api.delete(`/api/conversations/${conversationId}/messages`).then(r => r.data),

  // ── Listas de transmissão (broadcast) ──────────────────────
  getBroadcastLists: (accountId) =>
    api.get(`/api/broadcast-lists?account_id=${accountId}`).then(r => r.data),

  createBroadcastList: (accountId, name, contactIds) =>
    api.post('/api/broadcast-lists', { account_id: accountId, name, contact_ids: contactIds }).then(r => r.data),

  updateBroadcastList: (listId, patch) =>
    api.patch(`/api/broadcast-lists/${listId}`, patch).then(r => r.data),

  deleteBroadcastList: (listId) =>
    api.delete(`/api/broadcast-lists/${listId}`).then(r => r.data),

  sendBroadcast: (listId, text) =>
    api.post(`/api/broadcast-lists/${listId}/send`, { text }).then(r => r.data),

  getBroadcastSend: (sendId) =>
    api.get(`/api/broadcast-lists/sends/${sendId}`).then(r => r.data),

  getBroadcastSends: (listId) =>
    api.get(`/api/broadcast-lists/${listId}/sends`).then(r => r.data),
};

// ── API exclusiva do provider Baileys ──────────────────────────────────────
// Todas as funções aceitam account_id como último parmetro opcional.
// Quando omitido, o backend usa a primeira conta Baileys ativa.
const _b = (url, body) => api.post(url, body).then(r => r.data);

export const baileysApi = {
  // Mensagens avançadas
  sendSticker: (payload) => _b('/api/baileys/send/sticker', payload),
  sendGif: (payload) => _b('/api/baileys/send/gif', payload),
  sendViewOnce: (payload) => _b('/api/baileys/send/view-once', payload),
  sendPoll: (to, question, options, selectable_count = 1, account_id = null) =>
    _b('/api/baileys/send/poll', { to, question, options, selectable_count, account_id }),
  sendContactCard: (to, contacts, account_id = null) =>
    _b('/api/baileys/send/contact-card', { to, contacts, account_id }),
  sendWithMentions: (to, text, mentioned_jids, reply_to = null, account_id = null) =>
    _b('/api/baileys/send/mentions', { to, text, mentioned_jids, reply_to, account_id }),
  forwardMessage: (to, message_id, from_jid, account_id = null) =>
    _b('/api/baileys/send/forward', { to, message_id, from_jid, account_id }),
  editMessage: (to, message_id, new_text, account_id = null) =>
    _b('/api/baileys/message/edit', { to, message_id, new_text, account_id }),
  deleteMessage: (to, message_id, for_everyone = true, account_id = null) =>
    _b('/api/baileys/message/delete', { to, message_id, for_everyone, account_id }),
  pinMessage: (to, message_id, duration = 604800, account_id = null) =>
    _b('/api/baileys/message/pin', { to, message_id, duration, account_id }),
  starMessage: (to, message_id, starred = true, account_id = null) =>
    _b('/api/baileys/message/star', { to, message_id, starred, account_id }),

  // Grupos
  groupCreate: (subject, participants, account_id = null) =>
    _b('/api/baileys/group/create', { subject, participants, account_id }),
  groupAddParticipants: (group_jid, participants, account_id = null) =>
    _b('/api/baileys/group/participants/add', { group_jid, participants, account_id }),
  groupRemoveParticipants: (group_jid, participants, account_id = null) =>
    _b('/api/baileys/group/participants/remove', { group_jid, participants, account_id }),
  groupPromoteAdmins: (group_jid, participants, account_id = null) =>
    _b('/api/baileys/group/admins/promote', { group_jid, participants, account_id }),
  groupDemoteAdmins: (group_jid, participants, account_id = null) =>
    _b('/api/baileys/group/admins/demote', { group_jid, participants, account_id }),
  groupUpdateSubject: (group_jid, subject, account_id = null) =>
    _b('/api/baileys/group/subject', { group_jid, subject, account_id }),
  groupUpdateDescription: (group_jid, description, account_id = null) =>
    _b('/api/baileys/group/description', { group_jid, description, account_id }),
  groupLeave: (group_jid, account_id = null) =>
    _b('/api/baileys/group/leave', { group_jid, account_id }),
  groupGetInviteCode: (group_jid, account_id = null) =>
    _b('/api/baileys/group/invite-code', { group_jid, account_id }),
  groupRevokeInviteCode: (group_jid, account_id = null) =>
    _b('/api/baileys/group/invite-code/revoke', { group_jid, account_id }),
  groupGetMetadata: (group_jid, account_id = null) =>
    _b('/api/baileys/group/metadata', { group_jid, account_id }),
  groupJoinViaLink: (invite_link, account_id = null) =>
    _b('/api/baileys/group/join', { invite_link, account_id }),
  groupGetJoinRequests: (group_jid, account_id = null) =>
    _b('/api/baileys/group/join-requests', { group_jid, account_id }),
  groupUpdateJoinRequest: (group_jid, participants, action, account_id = null) =>
    _b('/api/baileys/group/join-requests/update', { group_jid, participants, action, account_id }),
  groupSetAnnounce: (group_jid, announce, account_id = null) =>
    _b('/api/baileys/group/announce', { group_jid, announce, account_id }),
  groupSetDisappearing: (group_jid, duration, account_id = null) =>
    _b('/api/baileys/group/disappearing', { group_jid, duration, account_id }),

  // Perfil e privacidade
  getProfilePicture: (jid, high_res = false, account_id = null) =>
    _b('/api/baileys/profile/picture', { jid, high_res, account_id }),
  updateProfilePicture: (image_b64, account_id = null) =>
    _b('/api/baileys/profile/picture/update', { image_b64, account_id }),
  removeProfilePicture: (account_id = null) =>
    _b('/api/baileys/profile/picture/remove', { account_id }),
  updateStatus: (status, account_id = null) =>
    _b('/api/baileys/profile/status', { status, account_id }),
  updateProfileName: (name, account_id = null) =>
    _b('/api/baileys/profile/name', { name, account_id }),
  getUserStatus: (jid, account_id = null) =>
    _b('/api/baileys/profile/get-status', { jid, account_id }),
  getContactBusinessProfile: (jid, account_id = null) =>
    _b('/api/baileys/contact/business-profile', { jid, account_id }),
  checkPhoneExists: (phone, account_id = null) =>
    _b('/api/baileys/contact/check', { phone, account_id }),
  blockContact: (jid, account_id = null) =>
    _b('/api/baileys/contact/block', { jid, account_id }),
  unblockContact: (jid, account_id = null) =>
    _b('/api/baileys/contact/unblock', { jid, account_id }),
  getBlocklist: (account_id = null) =>
    _b('/api/baileys/contact/blocklist', { account_id }),
  getPrivacySettings: (account_id = null) =>
    _b('/api/baileys/privacy/settings', { account_id }),
  updatePrivacySetting: (setting, value, account_id = null) =>
    _b('/api/baileys/privacy/update', { setting, value, account_id }),

  // Presença
  sendPresence: (to, presence_type, account_id = null) =>
    _b('/api/baileys/presence/send', { to, presence_type, account_id }),
  subscribePresence: (jid, account_id = null) =>
    _b('/api/baileys/presence/subscribe', { jid, account_id }),

  // Gerenciamento de chats
  deleteChat: (jid, account_id = null) =>
    _b('/api/baileys/chat/delete', { jid, account_id }),
  archiveChat: (jid, archive = true, account_id = null) =>
    _b('/api/baileys/chat/archive', { jid, archive, account_id }),
  muteChat: (jid, duration_ms = null, account_id = null) =>
    _b('/api/baileys/chat/mute', { jid, duration_ms, account_id }),
  pinChat: (jid, pinned = true, account_id = null) =>
    _b('/api/baileys/chat/pin', { jid, pinned, account_id }),
  setDisappearingMessages: (jid, duration, account_id = null) =>
    _b('/api/baileys/chat/disappearing', { jid, duration, account_id }),
};

export { api };
export default apiService;
