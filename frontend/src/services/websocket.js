/**
 * WebSocket Service - Socket.IO para tempo real
 * 
 * OTIMIZADO: Sem ping manual, usa heartbeat nativo do Socket.IO
 * 
 * IMPORTANTE: Configuração que funciona tanto em desenvolvimento (localhost)
 * quanto em produção (Railway) detectando automaticamente o ambiente
 */
import { io } from 'socket.io-client';

/**
 * Detecta automaticamente a URL do WebSocket:
 * - Em desenvolvimento (localhost): usa localhost:8000
 * - Em produção (Railway): usa a URL atual (window.location.origin)
 */
function getWebSocketURL() {
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  if (isLocalhost) {
    // Desenvolvimento local
    return process.env.REACT_APP_API_URL || 'http://localhost:8000';
  } else {
    // Produção (Railway) - usa a URL atual
    return window.location.origin;
  }
}

const WS_URL = getWebSocketURL();

class WebSocketService {
  constructor() {
    this.socket = null;
    this.listeners = {};
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
  }

  /**
   * Conectar ao servidor WebSocket
   */
  connect() {
    if (this.socket && this.socket.connected) {
      console.log('WebSocket já conectado');
      return this.socket;
    }

    console.log(`Conectando ao WebSocket: ${WS_URL}`);

    this.socket = io(WS_URL, {
      path: '/socket.io/',
      transports: ['websocket', 'polling'], // Tenta websocket primeiro, depois polling
      reconnection: true,
      // BUG real (2026-09-14): reconnectionAttempts finito (era 5) faz o
      // socket.io DESISTIR de vez depois de ~25s (5 tentativas x até 5s de
      // delay) e nunca mais tentar sozinho — a aba fica com status/mensagem
      // "congelados" até um F5 manual. Sob uma instabilidade de backend que
      // dura minutos (não segundos, como aconteceu hoje: restarts de
      // serviço, disco cheio), isso estoura fácil. Infinity mantém o app
      // tentando reconectar pra sempre (mesmo comportamento do WhatsApp Web
      // oficial — nunca desiste sozinho, só mostra "reconectando").
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      autoConnect: true,
      // Heartbeat nativo do Socket.IO (opcional - já tem valores padrão)
      pingInterval: 25000,  // Servidor envia ping a cada 25s
      pingTimeout: 20000,   // Cliente aguarda 20s por resposta
    });

    // Eventos essenciais apenas
    this.socket.on('connect', () => {
      console.log('WebSocket conectado:', this.socket.id);
      this.connectionAttempts = 0;
      // Identifica o socket pro backend poder entregar chat interno (DM/grupo
      // entre usuários) só pra quem participa — precisa ser refeito em toda
      // (re)conexão, já que uma nova conexão ganha um novo sid/room.
      const token = localStorage.getItem('token');
      if (token) this.socket.emit('identify', { token });
    });

    this.socket.on('disconnect', (reason) => {
      console.log('WebSocket desconectado:', reason);
      
      if (reason === 'io server disconnect') {
        // Servidor forçou desconexão - reconectar manualmente
        this.socket.connect();
      }
    });

    this.socket.on('connect_error', (error) => {
      this.connectionAttempts++;
      
      // Só loga erros críticos (máximo de tentativas)
      if (this.connectionAttempts >= this.maxConnectionAttempts) {
        console.error('Falha na conexão após máximo de tentativas');
      }
    });

    this.socket.on('connection_established', (data) => {
      console.log('Conexão estabelecida:', data);
    });

    return this.socket;
  }

  /**
   * Desconectar
   */
  disconnect() {
    if (this.socket) {
      console.log('Desconectando WebSocket...');
      this.socket.disconnect();
      this.socket = null;
      this.connectionAttempts = 0;
    }
  }

  /**
   * Verificar se está conectado
   */
  isConnected() {
    return this.socket && this.socket.connected;
  }

  /**
   * Emitir evento genérico pro servidor (ex: 'typing' do chat interno).
   */
  emit(eventName, data) {
    if (this.socket?.connected) {
      this.socket.emit(eventName, data);
    }
  }

  /**
   * Ouvir evento genérico (CRITICAL FIX)
   */
  on(eventName, callback) {
    if (this.socket) {
      this.socket.on(eventName, callback);
    }
  }

  /**
   * Ouvir evento de atualização de conversa
   */
  onConversationUpdate(callback) {
    if (this.socket) {
      this.socket.on('conversation_update', callback);
    }
  }

  /**
   * Ouvir evento de nova mensagem
   */
  onNewMessage(callback) {
    if (this.socket) {
      this.socket.on('new_message', callback);
    }
  }

  /**
   * Ouvir evento de atualização de status de mensagem
   */
  onMessageStatusUpdate(callback) {
    if (this.socket) {
      this.socket.on('message_status_update', callback);
    }
  }

  /**
   * NOVO: Listener para atualizações de reações
   * @param {Function} callback - Callback executado quando uma reação é recebida
   */
  onReactionUpdate(callback) {
    if (!this.socket) {
      console.warn('Socket não conectado');
      return;
    }
  
    console.log('Registrando listener: reaction_update');
    
    this.socket.on('reaction_update', (data) => {
      console.log('Reação recebida via WebSocket:', data);
      callback(data);
    });
  }
  
  /**
   * Remover listener de evento
   * @param {string} event - Nome do evento
   * @param {Function} callback - Callback para remover (opcional)
   */
  off(event, callback) {
    if (!this.socket) {
      console.warn('Socket não conectado');
      return;
    }
  
    console.log(`Removendo listener: ${event}`);
    
    if (callback) {
      this.socket.off(event, callback);
    } else {
      this.socket.off(event);
    }
  }

  /**
   * Remover todos os listeners
   */
  removeAllListeners() {
    if (this.socket) {
      this.socket.removeAllListeners();
    }
  }

  /**
   * Obter status da conexão
   */
  getConnectionStatus() {
    if (!this.socket) {
      return 'not_initialized';
    }
    
    if (this.socket.connected) {
      return 'connected';
    }
    
    if (this.socket.io.engine.id) {
      return 'connecting';
    }
    
    return 'disconnected';
  }
}

// Instância singleton
const wsService = new WebSocketService();

// PING REMOVIDO: Socket.IO já faz isso automaticamente!
// Não precisa de setInterval para ping manual

export default wsService;
