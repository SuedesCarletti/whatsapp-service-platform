/**
 * services/wa-web-bridge/index.js
 *
 * Bridge HTTP → whatsapp-web.js (WhatsApp Web via Puppeteer)
 * Porta padrão: 3004
 *
 * Mesmo contrato HTTP do venom-bridge (services/venom-bridge/index.js) —
 * ver o comentário lá para o racional de manter os bridges não-oficiais
 * uniformes. Requer Chrome/Chromium instalado no servidor.
 *
 * Endpoints expostos (consumidos por whatsapp_web_js_provider.py):
 *   POST /session/init          → inicia sessão, retorna QR se necessário
 *   GET  /session/status        → status de autenticação
 *   POST /session/logout        → desconecta sessão
 *   POST /session/pairing-code  → não suportado (usar QR)
 *   POST /send/text
 *   POST /send/image
 *   POST /send/video
 *   POST /send/audio
 *   POST /send/document
 *   POST /send/location
 *
 * Mensagens recebidas → encaminhadas ao FastAPI em FASTAPI_URL/api/webhook/bridge
 */

'use strict';

const express = require('express');
const { Client, LocalAuth, MessageMedia, Location, Poll } = require('whatsapp-web.js');
const axios   = require('axios');
const QRCode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');

// ─── Config ──────────────────────────────────────────────────

const PORT         = process.env.WHATSAPP_WEB_JS_PORT || 3004;
const FASTAPI_URL  = process.env.FASTAPI_URL           || 'http://localhost:8000';
const SESSIONS_DIR = process.env.SESSIONS_DIR          || path.join(__dirname, 'sessions');
const CHROME_PATH  = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const SYNC_MAX_CHATS    = parseInt(process.env.SYNC_MAX_CHATS    || '50', 10);
const SYNC_MAX_PER_CHAT = parseInt(process.env.SYNC_MAX_PER_CHAT || '30', 10);

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ─── Gerenciador de sessões ───────────────────────────────────

/**
 * sessions: Map<session_id, SessionState>
 *
 * SessionState = {
 *   client:    Client | null,
 *   qr:        string | null,   ← data URL PNG
 *   qr_string: string | null,
 *   status:    'idle'|'qr_required'|'authenticated'|'disconnected'|'error',
 *   phone:     string | null,
 *   starting:  boolean,         ← evita inicializações simultâneas
 * }
 */
const sessions = new Map();

// LID → JID de telefone por sessão (@lid -> xxxx@c.us). WhatsApp identifica
// muitos contatos internamente por LID em vez do número; sem resolver isso,
// mensagens da MESMA pessoa criam DOIS contatos diferentes no banco — um
// "de verdade" (quando NÓS mandamos, usando o telefone que fornecemos) e um
// fantasma tipo "Contato @lid" (quando a mensagem CHEGA, carregando o LID
// bruto) — a conversa se divide em duas, cada lado só com metade do
// histórico. baileys-bridge já resolve isso (lidToJidMap); replicando aqui
// com client.getContactLidAndPhone(), a função equivalente da lib.
const lidToPhoneCache = {};

async function resolveLidToPhone(client, session_id, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  if (!lidToPhoneCache[session_id]) lidToPhoneCache[session_id] = {};
  const cached = lidToPhoneCache[session_id][jid];
  if (cached) return cached;

  try {
    const [entry] = await client.getContactLidAndPhone([jid]);
    if (entry?.pn) {
      const resolved = entry.pn;
      lidToPhoneCache[session_id][jid] = resolved;
      return resolved;
    }
  } catch (e) {
    console.warn(`[WA-Web] Falha ao resolver LID ${jid}: ${e.message}`);
  }
  return jid;
}

function getSession(session_id) {
  if (!sessions.has(session_id)) {
    sessions.set(session_id, {
      client:    null,
      qr:        null,
      qr_string: null,
      status:    'idle',
      phone:     null,
      starting:  false,
      // Último wamid outbound visto via message_create (slot único, não por
      // chat — evitar casar chatId aqui de novo com formatId()/message.to
      // teria o mesmo risco de mismatch @c.us vs @lid já visto em outros
      // bugs desta sessão). Existe porque o retorno síncrono de
      // client.sendMessage() não é confiável nesta versão (ver
      // getSentMessageId) — o evento ao vivo é o caminho que comprovadamente
      // funciona (mesmo usado pelo webhook).
      lastOutgoing: null,
      // Mesma lógica do lastOutgoing, mas guarda os bytes da mídia que
      // ACABAMOS de mandar (setado por cada handler /send/imagem|video|...
      // logo antes do client.sendMessage()) — consumido pelo listener de
      // message_create pra contornar o downloadMedia() quebrado em outbound.
      pendingOutboundMedia: null,
      // Cache jid do grupo → nome (subject), alimentado pelo syncChatHistory
      // (client.getChats() já traz .name pra cada grupo). Evita repetir esse
      // lookup (async, e com histórico de quebrar pra JIDs migrados) a cada
      // mensagem — group_name só precisa ser resolvido uma vez por grupo.
      groupNames: {},
    });
  }
  return sessions.get(session_id);
}

// ─── Inicializar sessão ───────────────────────────────────────

async function startSession(session_id) {
  const state = getSession(session_id);

  // Já existe um client vivo para essa sessão (autenticado, aguardando QR,
  // ou ainda conectando) — NUNCA criar um novo Client() aqui. O frontend
  // faz polling em /session/init pra atualizar o QR, e uma segunda chamada
  // criaria um segundo browser puppeteer para a mesma sessão, trocando o QR
  // antes do usuário conseguir escanear o anterior.
  if (state.client) {
    return buildStatusResponse(session_id);
  }

  if (state.starting) {
    // Já está sendo iniciada — aguarda até ter status
    await new Promise(resolve => setTimeout(resolve, 4000));
    return buildStatusResponse(session_id);
  }

  state.starting = true;
  state.status   = 'idle';

  console.log(`[WA-Web] Iniciando sessão: ${session_id}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session_id, dataPath: SESSIONS_DIR }),
    puppeteer: {
      headless:        true,
      executablePath:  CHROME_PATH,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    },
  });

  state.client = client;

  client.on('qr', async (qr) => {
    try {
      state.qr        = await QRCode.toDataURL(qr);
      state.qr_string = qr;
      state.status    = 'qr_required';
      console.log(`[WA-Web] QR gerado para sessão: ${session_id}`);
    } catch (err) {
      console.error(`[WA-Web] Erro ao gerar QR: ${err.message}`);
    }
  });

  client.on('ready', () => {
    state.status   = 'authenticated';
    state.qr       = null;
    state.phone    = client.info?.wid?.user || null;
    state.starting = false;
    console.log(`[WA-Web] Sessão autenticada: ${session_id} | Telefone: ${state.phone}`);
    // getChats() falha se chamado bem no instante do 'ready' — o Store
    // interno da lib ainda não terminou de hidratar no contexto da página.
    setTimeout(() => {
      syncChatHistory(session_id, client).catch(() => {});
    }, 5000);
  });

  client.on('disconnected', (reason) => {
    console.log(`[WA-Web] Desconectado [${session_id}]: ${reason}`);
    state.status = 'disconnected';
    client.destroy().catch(() => {}); // fecha o browser Puppeteer órfão antes de soltar a referência
    state.client = null;
  });

  client.on('auth_failure', (msg) => {
    console.error(`[WA-Web] Falha de autenticação [${session_id}]: ${msg}`);
    state.status   = 'error';
    state.starting = false;
    client.destroy().catch(() => {}); // fecha o browser Puppeteer órfão antes de soltar a referência
    state.client   = null; // libera pra tentar de novo no próximo /session/init
  });

  // ── Escuta mensagens (recebidas E enviadas) ──────────────
  // BUG anterior: escutava só 'message', que a própria lib documenta como
  // "received only" (client.js faz `if (msg.id.fromMe) return` antes de
  // emitir esse evento) — toda mensagem que a própria conta enviava nunca
  // era espelhada pro FastAPI/banco/frontend, mesmo chegando de verdade no
  // destinatário. 'message_create' cobre os dois sentidos.
  client.on('message_create', async (message) => {
    // Receber qualquer mensagem é prova inequívoca de sessão autenticada —
    // proteção extra caso o evento 'ready' não dispare por algum motivo.
    if (state.status !== 'authenticated') {
      state.status = 'authenticated';
      state.qr     = null;
      state.phone  = state.phone || client.info?.wid?.user || null;
    }
    // BUG de biblioteca (mesma família dos outros achados de LID desta
    // sessão): message.id._serialized vem undefined neste ambiente — só o
    // fragmento curto message.id.id existe. Esse fragmento sozinho NÃO é
    // suficiente pra reconstruir um id utilizável em getMessageById() (que
    // exige o formato completo `fromMe_remoteJid_id`), porque o remoteJid
    // real do WhatsApp aqui é uma identidade @lid que não bate com o JID
    // baseado em telefone que formatId() produziria — não dá pra reconstruir
    // com segurança. Guardamos o que der pra retornar como referência, mas
    // operações por ID (reagir/fixar/favoritar/editar/apagar/encaminhar)
    // ficam não confiáveis pra contatos migrados pra LID nesta versão da lib.
    const sentId = message.id?._serialized || message.id?.id;
    if (message.fromMe && sentId) {
      state.lastOutgoing = { id: sentId, ts: Date.now() };
    }
    try {
      await forwardMessageToFastAPI(client, session_id, message);
    } catch (err) {
      console.error(`[WA-Web] Erro ao encaminhar mensagem: ${err.message}`);
    }
  });

  // ── Escuta ACK (status) ─────────────────────────────────
  client.on('message_ack', async (message, ack) => {
    await forwardStatusUpdate(session_id, message, ack).catch(() => {});
  });

  // ── Escuta votos de enquete ──────────────────────────────
  // Antes não existia nenhuma captura de voto pro wa-web — o front não
  // tinha como mostrar quem votou em quê. Cada vote_update é a ação de UM
  // votante; acumula em memória por enquete (pollId -> {voterId: [opções]})
  // e reenvia a apuração agregada, mesmo formato que o Baileys já usa.
  client.on('vote_update', async (pollVote) => {
    try {
      const pollId = pollVote.parentMessage?.id?._serialized;
      if (!pollId) {
        console.warn('[WA-Web] Voto recebido sem id de enquete resolvível — ignorado');
        return;
      }
      if (!state.pollVotes) state.pollVotes = {};
      if (!state.pollVotes[pollId]) state.pollVotes[pollId] = {};
      state.pollVotes[pollId][pollVote.voter] = (pollVote.selectedOptions || []).map(o => o.name);

      const allOptionNames = (pollVote.parentMessage?.pollOptions || []).map(o => o.name);
      const tally = {};
      allOptionNames.forEach(name => { tally[name] = 0; });
      Object.values(state.pollVotes[pollId]).forEach(selected => {
        selected.forEach(name => { tally[name] = (tally[name] || 0) + 1; });
      });

      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/poll-vote`, {
        session_id,
        poll_wamid: pollId,
        options: allOptionNames.map(name => ({ name, votes: tally[name] || 0 })),
        total_voters: Object.keys(state.pollVotes[pollId]).length,
      }, { timeout: 8000 });
    } catch (err) {
      console.warn(`[WA-Web] Falha ao processar voto de enquete: ${err.message}`);
    }
  });

  // ── Escuta reações recebidas do contato ───────────────────
  // Gap de paridade: reagir/remover reação enviado por NÓS já funcionava
  // (endpoint /send/reaction), mas reações que o CONTATO manda de volta
  // nunca chegavam ao backend — sem listener nenhum pra 'message_reaction',
  // a reação nem aparecia no front nem persistia no banco. Mesmo padrão do
  // wppconnect-bridge (describeGroupNotification/onReactionMessage): usa o
  // endpoint genérico /api/webhook/bridge com type:'reaction'.
  client.on('message_reaction', async (reaction) => {
    try {
      const targetWamid = reaction.msgId?._serialized || reaction.msgId?.id || reaction.msgId;
      if (!targetWamid) return;
      // Backend só sabe descascar sufixo "@s.whatsapp.net" do campo "from"
      // (webhook_handler.py) — sem remover "@c.us"/"@lid" aqui, igual ao
      // resto deste arquivo (linhas 455/551/578), o contato/conversa
      // resolvido pra escopar a reação sairia com wa_id errado.
      const senderFrom = (reaction.senderId || '').replace('@c.us', '').replace('@lid', '') || 'wa-web-reaction';
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge`, {
        bridge_provider: 'wa-web',
        session_id,
        wamid: `reaction_${Date.now()}`,
        direction: 'inbound',
        from: senderFrom,
        to: 'me',
        timestamp: (reaction.timestamp || Math.floor(Date.now() / 1000)) * 1000,
        type: 'reaction',
        reaction_message_id: targetWamid,
        reaction_emoji: reaction.reaction || '',
      }, { timeout: 8000 });
    } catch (err) {
      console.warn(`[WA-Web] Falha ao encaminhar reação: ${err.message}`);
    }
  });

  // ── Escuta edições de mensagem recebidas do contato ───────
  // Mesmo gap do bloco acima: editar NOSSA mensagem já funcionava
  // (/message/edit), mas o contato editando a dele nunca era propagado.
  client.on('message_edit', async (message, newBody) => {
    try {
      const wamid = message.id?._serialized || message.id?.id;
      if (!wamid || !newBody) return;
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/edit`, {
        bridge_provider: 'wa-web',
        session_id,
        wamid,
        new_text: newBody,
      }, { timeout: 8000 });
    } catch (err) {
      console.warn(`[WA-Web] Falha ao encaminhar edição: ${err.message}`);
    }
  });

  // ── Escuta apagar-para-todos feito pelo contato ───────────
  // Sem isso, uma mensagem revogada pelo contato continuava aparecendo
  // normalmente no nosso lado — mesmo gap que existia no Baileys antes do
  // /api/webhook/bridge/revoke ser criado (rota já genérica, só faltava
  // este bridge chamá-la). O id da mensagem revogada é preservado no lugar
  // pela própria lib (mesmo slot/id da mensagem original).
  client.on('message_revoke_everyone', async (message) => {
    try {
      const revokedWamid = message.id?._serialized || message.id?.id;
      if (!revokedWamid) return;
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/revoke`, {
        bridge_provider: 'wa-web',
        session_id,
        revoked_wamid: revokedWamid,
      }, { timeout: 8000 });
    } catch (err) {
      console.warn(`[WA-Web] Falha ao encaminhar revogação: ${err.message}`);
    }
  });

  // ── Escuta eventos de grupo (entrar/sair/promover/atualizar) ──
  // Gap de paridade com o Baileys/WPPConnect: nenhum evento nativo de grupo
  // era escutado — mudanças feitas por outros admins (remover participante,
  // trocar nome/descrição, promover/rebaixar) nunca apareciam na conversa.
  // A lib já separa isso em 4 eventos distintos (em vez de um genérico tipo
  // o onNotificationMessage do wppconnect); GroupNotification.type já vem
  // no mesmo vocabulário (add/remove/leave/promote/demote/subject/desc).
  function describeGroupNotification(n) {
    const type = n?.type || 'unknown';
    const who = (n?.recipientIds || []).map(j => String(j).split('@')[0]).join(', ')
      || (n?.author ? String(n.author).split('@')[0] : '');
    switch (type) {
      case 'add':
      case 'invite':
      case 'linked_group_join': return `${who || 'Participante'} entrou no grupo`;
      case 'remove':   return `${who || 'Participante'} foi removido do grupo`;
      case 'leave':    return `${who || 'Participante'} saiu do grupo`;
      case 'promote':  return `${who || 'Participante'} agora é admin`;
      case 'demote':   return `${who || 'Participante'} deixou de ser admin`;
      case 'subject':  return `Nome do grupo alterado${n?.body ? ` para "${n.body}"` : ''}`;
      case 'desc':     return 'Descrição do grupo alterada';
      default:         return `Evento de grupo: ${type}`;
    }
  }

  async function forwardGroupNotification(notification) {
    try {
      const group_jid = notification?.chatId;
      if (!group_jid) return;
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/group-notification`, {
        session_id,
        group_jid,
        text: describeGroupNotification(notification),
        timestamp: (notification?.timestamp || Math.floor(Date.now() / 1000)) * 1000,
      }, { timeout: 8000 });
    } catch (err) {
      console.warn(`[WA-Web] Falha ao notificar evento de grupo: ${err.message}`);
    }
  }

  client.on('group_join', forwardGroupNotification);
  client.on('group_leave', forwardGroupNotification);
  client.on('group_admin_changed', forwardGroupNotification);
  client.on('group_update', forwardGroupNotification);

  client.initialize().catch((err) => {
    console.error(`[WA-Web] Erro ao inicializar sessão ${session_id}: ${err.message}`);
    state.status   = 'error';
    state.starting = false;
    client.destroy().catch(() => {}); // fecha o browser Puppeteer órfão antes de soltar a referência
    state.client   = null; // libera pra tentar de novo no próximo /session/init
  });

  // Não bloqueia — dá uma janela para QR/ready chegar e retorna o que tiver
  await new Promise(resolve => setTimeout(resolve, 4000));
  state.starting = false;
  return buildStatusResponse(session_id);
}

function buildStatusResponse(session_id) {
  const state = getSession(session_id);
  if (state.status === 'authenticated') {
    return { status: 'authenticated', phone: state.phone };
  }
  if (state.status === 'qr_required' || state.qr) {
    return {
      status:    'qr_required',
      qr:        state.qr,
      qr_string: state.qr_string,
    };
  }
  return { status: state.status };
}

// ─── Sincronização de histórico ao conectar ────────────────────
//
// whatsapp-web.js não replica automaticamente o backlog de mensagens pelo
// evento 'message' (diferente do venom-bot, que faz isso "de graça"). Então
// buscamos explicitamente as últimas conversas + mensagens de cada uma e
// mandamos pro mesmo endpoint de sync que o Baileys usa.

async function syncChatHistory(session_id, client, attempt = 1) {
  try {
    const chats = await client.getChats();
    const batch = [];
    const state = getSession(session_id);

    for (const chat of chats) {
      if (chat.isGroup && chat.id?._serialized && chat.name) {
        state.groupNames[chat.id._serialized] = chat.name;
      }
    }

    for (const chat of chats.slice(0, SYNC_MAX_CHATS)) {
      let messages = [];
      try {
        messages = await chat.fetchMessages({ limit: SYNC_MAX_PER_CHAT });
      } catch (_) {
        continue; // chat sem histórico acessível — pula
      }

      const jid     = chat.id._serialized;
      const isGroup = chat.isGroup;

      for (const m of messages) {
        const senderJid = isGroup ? (m.author || jid) : jid;
        batch.push({
          session_id,
          wamid:        m.id?.id,
          from:         m.fromMe ? 'me' : senderJid.replace('@c.us', '').replace('@g.us', ''),
          to:           m.fromMe ? jid.replace('@c.us', '') : 'me',
          direction:    m.fromMe ? 'outbound' : 'inbound',
          type:         m.type || 'chat',
          timestamp:    (m.timestamp || 0) * 1000,
          text:         m.body || '',
          contact_name: chat.name || '',
          push_name:    chat.name || '',
          is_group:     isGroup,
          group_jid:    isGroup ? jid : undefined,
          group_name:   isGroup ? chat.name : undefined,
          participant:  isGroup && !m.fromMe ? senderJid : undefined,
        });
      }
    }

    if (batch.length) {
      // Sem session_id na raiz, receive_bridge_sync() cai no fallback
      // "primeira conta ativa" e mistura o histórico de contas diferentes —
      // ver mesmo fix em wppconnect-bridge/index.js.
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/sync`, { session_id, messages: batch }, { timeout: 30000 });
      console.log(`[WA-Web] Sincronizadas ${batch.length} mensagens de ${chats.length} conversas`);
    }
  } catch (err) {
    if (attempt < 3) {
      console.warn(`[WA-Web] Falha ao sincronizar histórico (tentativa ${attempt}), tentando de novo em 8s: ${err.message}`);
      setTimeout(() => syncChatHistory(session_id, client, attempt + 1).catch(() => {}), 8000);
      return;
    }
    console.error(`[WA-Web] Erro ao sincronizar histórico após ${attempt} tentativas: ${err.message}`);
  }
}

// ─── Encaminhar ao FastAPI ────────────────────────────────────

// BUG anterior: mensagens de mídia recebidas nunca eram baixadas — o front
// não tinha NENHUMA URL pra exibir imagem/vídeo/áudio/documento recebido
// (media_url sempre ficava null no banco). Mesmo padrão do baileys-bridge:
// baixa, sobe pro mesmo endpoint /api/media/bridge-upload, popula media_url.
// `cachedMedia` (opcional): usado pra mensagens ENVIADAS por nós — o
// message.downloadMedia() da lib depende do mesmo lookup interno
// (Msg.get(this.id._serialized)) que já falha pra self-sent messages nesta
// versão (confirmado ao vivo: mesmo erro "r" do getChatById). Como pra
// outbound NÓS JÁ TEMOS os bytes (foi o que mandamos pra enviar), evita
// depender desse lookup quebrado e usa o que já está em mãos.
async function downloadAndUploadMedia(message, payload, cachedMedia = null) {
  if (!message.hasMedia && !cachedMedia) return;
  try {
    const media = cachedMedia || await message.downloadMedia();
    if (!media?.data) return;
    const buffer  = Buffer.from(media.data, 'base64');
    const safeId  = String(payload.wamid || message.id?.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
    const params  = new URLSearchParams({ media_id: safeId, mime_type: media.mimetype });

    const res = await axios.post(`${FASTAPI_URL}/api/media/bridge-upload?${params}`, buffer, {
      headers: { 'Content-Type': media.mimetype },
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    if (res.data?.media_url) {
      payload.media_url = res.data.media_url;
      payload.mimetype  = res.data.mime_type || media.mimetype;
      payload.media_id  = safeId;
      payload.filename  = payload.filename || media.filename || '';
    }
  } catch (e) {
    console.warn(`[WA-Web] Falha ao baixar/enviar mídia: ${e.message}`);
  }
}

async function forwardMessageToFastAPI(client, session_id, message) {
  // BUGs anteriores:
  // 1) mandava "message_id", mas o backend (_normalize_message em
  //    routes_bridge.py) só lê o campo "wamid" — toda mensagem caía no
  //    fallback fixo `bridge_{session_id}`, o MESMO id pra sessão inteira,
  //    e o webhook_handler deduplica por wamid → cada mensagem nova
  //    sobrescrevia a linha da anterior no banco (só a última "sobrevivia").
  // 2) não mandava "direction"/"to" — outbound (fromMe) precisa from="me"
  //    e to=<contraparte> pro webhook_handler resolver a conversa certa
  //    (ver webhook_handler.py: "Para outbound: o contato relevante é o
  //    destinatário (campo 'to')").
  // 3) contraparte identificada por LID (comum em mensagens recebidas) ia
  //    direto pro banco como wa_id — criando um contato "fantasma" (ex.:
  //    "Contato @lid") diferente do contato real (pelo telefone), partindo
  //    a conversa em duas. Resolve pro telefone antes de montar o payload.
  //
  // BUG anterior (grupos): mensagens de grupo eram descartadas antes de
  // chegar aqui (`if from/to termina em '@g.us' return`) — nenhuma mensagem
  // nem notificação de grupo era sincronizada. Segue o mesmo contrato do
  // baileys-bridge: from/to usam o JID do GRUPO, "participant" carrega quem
  // enviou de fato (só em mensagens recebidas — `.author` da lib).
  const isGroup = (message.from || '').endsWith('@g.us') || (message.to || '').endsWith('@g.us');

  let from, to, participant, groupJidOut, groupName;
  if (isGroup) {
    const groupJid = message.fromMe ? message.to : message.from;
    participant = message.fromMe ? undefined : await resolveLidToPhone(client, session_id, message.author || '');
    from = message.fromMe ? 'me' : (participant || '').replace('@c.us', '').replace('@lid', '');
    to   = message.fromMe ? (groupJid || '').split('@')[0] : 'me';
    groupJidOut = groupJid;
    // BUG anterior: group_name nunca era mandado aqui (só na sincronização
    // inicial) — toda mensagem de grupo ao vivo caía no fallback "Grupo
    // XXXXXX" do webhook_handler, que SOBRESCREVIA o nome real salvo no sync
    // a cada nova mensagem. Usa o cache alimentado pelo syncChatHistory em
    // vez de um lookup ao vivo (message.getChat()/getChatById() documentado
    // como quebrado nesta versão pra JIDs migrados).
    const groupState = getSession(session_id);
    groupName = groupState.groupNames[groupJid] || undefined;
    // Cache miss = grupo do qual entramos depois do último sync (ou 1ª
    // mensagem antes do sync terminar). getChatById() só foi confirmado
    // quebrado pra JIDs migrados pra LID — grupos (@g.us) não são afetados
    // por essa migração, então vale tentar 1x e cachear pro resto da sessão.
    if (!groupName) {
      try {
        const chat = await client.getChatById(groupJid);
        if (chat?.name) {
          groupName = chat.name;
          groupState.groupNames[groupJid] = chat.name;
        }
      } catch (_) {}
    }
  } else {
    const rawCounterpart = (message.fromMe ? message.to : message.from) || '';
    const counterpart = await resolveLidToPhone(client, session_id, rawCounterpart);
    from = message.fromMe ? 'me' : counterpart.replace('@c.us', '');
    to   = message.fromMe ? counterpart.replace('@c.us', '') : 'me';
  }

  const payload = {
    bridge_provider: 'whatsapp_web_js',
    session_id,
    wamid:      message.id?._serialized || message.id?.id,
    direction:  message.fromMe ? 'outbound' : 'inbound',
    from,
    to,
    is_group:   isGroup,
    group_jid:  isGroup ? groupJidOut : undefined,
    group_name: isGroup ? groupName : undefined,
    participant,
    timestamp:  (message.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    type:       message.type || 'chat',
    pushName:   message._data?.notifyName || '',
    text:       message.body || '',
    caption:    message._data?.caption || '',
    mimetype:   message._data?.mimetype || '',
    filename:   message._data?.filename || '',
  };

  // Contato compartilhado (vCard) — nunca era mandado, então o backend
  // sempre caía no fallback "Contato" sem nome nem telefone
  // (vcard/vcard_name chegavam vazios em _format_contact_card_text). A lib
  // já vem com o(s) vCard(s) parseados de forma síncrona; usa o primeiro
  // pro caso mais comum de contato único (multi_vcard concatenado não é
  // 100% preciso, mas melhora bem o "Contato" genérico de antes).
  if (message.vCards && message.vCards.length > 0) {
    payload.vcard = message.vCards.join('\n');
  }

  // Enquete recebida — pollName/pollOptions são campos síncronos da lib.
  // Sem isso, o front não tinha NENHUM dado da enquete pra exibir (só
  // "[chat]" genérico, já que o tipo poll_creation caía no default "text").
  if (message.pollName) {
    payload.interactive_payload = {
      type: 'poll',
      question: message.pollName,
      options: (message.pollOptions || []).map(o => o.name || o),
    };
  }

  // Localização — nunca era extraída daqui, então o backend (que só lê o
  // campo "location" do payload) sempre caía no default {latitude:0,
  // longitude:0}, mesmo com a localização real enviada corretamente.
  if (message.location) {
    payload.location = {
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      name: message.location.name || '',
    };
  }

  // BUG anterior: nunca era mandado — nenhuma resposta/citação chegava ao
  // front (que já tem a UI pronta pra isso, só faltava o dado). Diferente
  // do wppconnect, a lib não expõe o id citado como campo síncrono — só via
  // getQuotedMessage(), que (como outras leituras desta lib nesta versão)
  // pode falhar; nesse caso a mensagem some sem reply_to_wamid, sem quebrar
  // o resto do envio.
  if (message.hasQuotedMsg) {
    try {
      const quoted = await message.getQuotedMessage();
      if (quoted?.id?._serialized) payload.reply_to_wamid = quoted.id._serialized;
    } catch (_) { /* best-effort */ }
  }

  // BUG anterior: só baixava mídia recebida (fromMe=false). Mensagens
  // ENVIADAS por nós (imagem/vídeo/áudio/documento) chegavam de verdade no
  // destinatário mas nunca ganhavam media_url — o front só mostrava
  // "[Imagem]"/"[Áudio]" genérico. Pra outbound, message.downloadMedia() é
  // quebrado nesta versão (mesmo lookup do getChatById) — usa os bytes que
  // JÁ enviamos (pendingOutboundMedia) em vez de tentar rebaixar.
  let cachedMedia = null;
  if (message.fromMe) {
    const state = getSession(session_id);
    if (state.pendingOutboundMedia && Date.now() - state.pendingOutboundMedia.ts < 15000) {
      cachedMedia = state.pendingOutboundMedia.media;
    }
    state.pendingOutboundMedia = null;
  }
  await downloadAndUploadMedia(message, payload, cachedMedia);

  await axios.post(`${FASTAPI_URL}/api/webhook/bridge`, payload, {
    timeout: 8000,
    headers: { 'Content-Type': 'application/json' },
  });

  console.log(`[WA-Web] Mensagem encaminhada: ${payload.from} → ${payload.type}`);
}

async function forwardStatusUpdate(session_id, message, ack) {
  await axios.post(`${FASTAPI_URL}/api/webhook/bridge/status`, {
    bridge_provider: 'whatsapp_web_js',
    session_id,
    message_id: message.id?.id,
    status:     ack,
  }, { timeout: 5000 }).catch(() => {});
}

// ─── App Express ──────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    service:  'wa-web-bridge',
    port:     PORT,
    sessions: sessions.size,
    ok:       true,
  });
});

// ── POST /session/init ────────────────────────────────────────
app.post('/session/init', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const result = await startSession(session_id);
    res.json(result);
  } catch (err) {
    console.error(`[WA-Web] /session/init erro: ${err.message}`);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── GET /session/status ───────────────────────────────────────
app.get('/session/status', (req, res) => {
  const session_id = req.query.session_id || 'default';
  const state = getSession(session_id);
  res.json({
    status:        state.status,
    authenticated: state.status === 'authenticated',
    phone:         state.phone,
  });
});

// ── POST /session/logout ──────────────────────────────────────
app.post('/session/logout', async (req, res) => {
  const { session_id = 'default' } = req.body;
  const state = getSession(session_id);

  try {
    if (state.client) {
      await state.client.logout().catch(() => {});
      await state.client.destroy().catch(() => {});
      state.client = null;
    }

    // Remove tokens salvos (LocalAuth grava em <dataPath>/session-<clientId>)
    const tokenDir = path.join(SESSIONS_DIR, `session-${session_id}`);
    if (fs.existsSync(tokenDir)) {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }

    state.status = 'disconnected';
    state.phone  = null;
    state.qr     = null;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /session/pairing-code ────────────────────────────────
// Não incluído neste MVP — QR Code é o método de auth coberto agora.
app.post('/session/pairing-code', async (req, res) => {
  res.status(501).json({
    success: false,
    error:   'whatsapp-web.js bridge não suporta código de pareamento ainda. Use o QR Code.',
    hint:    'Para parear por número, utilize o provider Baileys.',
  });
});

// ─── Endpoints de envio ───────────────────────────────────────

function requireClient(session_id) {
  const state = getSession(session_id);
  if (!state.client || state.status !== 'authenticated') {
    throw new Error('Sessão não autenticada. Escaneie o QR Code primeiro.');
  }
  return state.client;
}

// BUG de biblioteca: window.WWebJS.sendMessage (injetado pela lib) termina
// com `Msg.get(newMsgKey._serialized)` — uma busca no cache local logo após
// enviar — que retorna undefined quando a mensagem ainda não está indexada
// sob essa chave nesse momento (visto com 100% de reprodução nesta versão,
// tanto pra self-chat quanto pra contato real). client.getChatById() +
// chat.fetchMessages() (tentativa de fallback anterior) sofrem do mesmo tipo
// de lookup quebrado e também falham. O envio em si funciona de verdade —
// só a leitura síncrona do ID que falha. O que comprovadamente funciona
// (confirmado batendo no banco após o webhook) é o evento 'message_create',
// que o handler acima já grava em state.lastOutgoing[to] — então em vez de
// tentar mais uma leitura pela lib, aguardamos esse evento (que já está
// fluindo em paralelo) por uma janela curta.
async function getSentMessageId(state, result) {
  if (result?.id?._serialized) return result.id._serialized;
  const since = Date.now();
  for (let i = 0; i < 15; i++) {
    if (state.lastOutgoing && state.lastOutgoing.ts >= since - 1000) {
      const id = state.lastOutgoing.id;
      state.lastOutgoing = null;
      return id;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

function formatId(to) {
  // BUG anterior: checava '@' na string já sem dígitos não-numéricos, que
  // nunca contém '@' — todo JID que já vinha com domínio (@g.us, @lid) era
  // reescrito para @c.us errado. Checar o '@' no `to` original.
  if (String(to).includes('@')) return to;
  const digits = String(to).replace(/\D/g, '');
  return `${digits}@c.us`;
}

// BUG (2026-09-10, espelhando o mesmo achado já corrigido no
// wppconnect-bridge — ver comentário equivalente lá): mandar a PRIMEIRA
// mensagem pra um contato que essa sessão nunca falou antes derruba com "No
// LID for user" / "Cannot read properties of undefined (reading
// '_serialized')" — erro que vem do próprio JS interno do WhatsApp Web
// (WAWebQueryExistsJob/Store), não da lib: a string não existe em nenhum
// arquivo do pacote whatsapp-web.js instalado aqui, só é lançada em runtime
// pelo bundle que o Puppeteer carrega de web.whatsapp.com. wwebjs ainda não
// tem cache desse número no Store quando a sessão nunca abriu esse chat.
// client.getNumberId() é o equivalente do checkNumberStatus do WPPConnect —
// chama window.require('WAWebQueryExistsJob').queryWidExists() por baixo,
// forçando a mesma resolução que falta. Resolução é assíncrona e pode não
// ter comitado a tempo do primeiro retry, daí o delay crescente e várias
// tentativas (mesmos parâmetros do wppconnect-bridge, para manter os dois
// bridges com o mesmo comportamento observável).
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LID_RETRY_DELAYS_MS = [300, 800, 1500]; // 3 retries além da 1ª tentativa

function isLidError(err) {
  const msg = err?.message || '';
  return msg.includes('No LID for user') || msg.includes("reading '_serialized'");
}

async function withLidRetry(client, to, sendFn) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendFn();
    } catch (err) {
      lastErr = err;
      if (!isLidError(err)) throw err;
      const delay = LID_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw lastErr; // esgotou as tentativas, desiste de vez
      await sleep(delay);
      await client.getNumberId(formatId(to)).catch(() => {});
    }
  }
}

// POST /send/text
app.post('/send/text', async (req, res) => {
  const { session_id = 'default', to, text, mentions } = req.body;
  try {
    const client = requireClient(session_id);
    // @menções (grupo) — mesmo contrato do baileys-bridge: `mentions` é uma
    // lista de JIDs, opcional. whatsapp-web.js aceita isso via options.mentions.
    const options = (Array.isArray(mentions) && mentions.length > 0) ? { mentions: mentions.map(formatId) } : {};
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), text, options));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/image
// BUG anterior: só aceitava "url", nunca base64 — o upload real de arquivo
// pela UI (POST /api/send/media) manda o arquivo como base64 (mesmo
// contrato do Baileys), então mídia enviada pela UI de verdade nunca
// chegava aqui com sucesso pra estes providers.
app.post('/send/image', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = await buildMedia({ url, base64_data, mimetype });
    getSession(session_id).pendingOutboundMedia = { media, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), media, { caption }));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/video
app.post('/send/video', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = await buildMedia({ url, base64_data, mimetype });
    getSession(session_id).pendingOutboundMedia = { media, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), media, { caption }));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/audio
app.post('/send/audio', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = await buildMedia({ url, base64_data, mimetype });
    getSession(session_id).pendingOutboundMedia = { media, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), media, { sendAudioAsVoice: true }));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/document
app.post('/send/document', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype, filename = 'arquivo' } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = await buildMedia({ url, base64_data, mimetype, filename });
    getSession(session_id).pendingOutboundMedia = { media, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), media, { sendMediaAsDocument: true }));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/location
app.post('/send/location', async (req, res) => {
  const { session_id = 'default', to, lat, lng, name = '' } = req.body;
  try {
    const client   = requireClient(session_id);
    const location = new Location(lat, lng, { name });
    const result   = await withLidRetry(client, to, () => client.sendMessage(formatId(to), location));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Helpers compartilhados ─────────────────────────────────────

async function buildMedia({ url, base64_data, mimetype, filename }) {
  if (base64_data) {
    return new MessageMedia(mimetype || 'application/octet-stream', base64_data, filename);
  }
  return await MessageMedia.fromUrl(url, { unsafeMime: true, filename });
}

async function requireChat(session_id, jid) {
  const client = requireClient(session_id);
  const chat = await client.getChatById(formatId(jid));
  if (!chat) throw new Error(`Chat não encontrado: ${jid}`);
  return chat;
}

const NOT_SUPPORTED = (feature) => ({
  success: false,
  error: `${feature} não é suportado pela lib whatsapp-web.js (sem API interna exposta para isso).`,
});

// ── Mensagens: reação, figurinha, gif, view-once, enquete, contato, encaminhar, editar, apagar, ler, fixar, favoritar ──

// POST /send/reaction
app.post('/send/reaction', async (req, res) => {
  const { session_id = 'default', message_id, emoji = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const msg = await client.getMessageById(message_id);
    if (!msg) throw new Error(`Mensagem não encontrada: ${message_id}`);
    await msg.react(emoji);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/sticker
app.post('/send/sticker', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = await buildMedia({ url, base64_data, mimetype });
    getSession(session_id).pendingOutboundMedia = { media, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), media, { sendMediaAsSticker: true }));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/gif
app.post('/send/gif', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = await buildMedia({ url, base64_data, mimetype: 'video/mp4' });
    getSession(session_id).pendingOutboundMedia = { media, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), media, { sendVideoAsGif: true, caption }));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/view-once
app.post('/send/view-once', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = await buildMedia({ url, base64_data, mimetype });
    getSession(session_id).pendingOutboundMedia = { media, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), media, { isViewOnce: true, caption }));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/poll
app.post('/send/poll', async (req, res) => {
  const { session_id = 'default', to, question, options = [], selectable_count = 1 } = req.body;
  try {
    const client = requireClient(session_id);
    const poll   = new Poll(question, options, { allowMultipleAnswers: selectable_count > 1 });
    const result = await withLidRetry(client, to, () => client.sendMessage(formatId(to), poll));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/contact
// Limitação da lib: só permite compartilhar contatos que já existem no
// WhatsApp (resolvidos por número), diferente do Baileys que monta um vCard
// arbitrário com qualquer nome/telefone.
app.post('/send/contact', async (req, res) => {
  const { session_id = 'default', to, contacts = [] } = req.body;
  try {
    const client = requireClient(session_id);
    // Mesmo fix do wppconnect-bridge: aceita tanto { phone } quanto o formato
    // rico da Meta Cloud API ({ phones: [{ phone }] }) mandado pelo backend.
    const phoneOf = (c) => c.phones?.[0]?.phone || c.phone || '';
    const resolved = [];
    for (const c of contacts) {
      const phone = phoneOf(c);
      const numberId = await client.getNumberId(phone);
      if (!numberId) throw new Error(`Número não encontrado no WhatsApp: ${phone}`);
      resolved.push(await client.getContactById(numberId._serialized));
    }
    const content = resolved.length === 1 ? resolved[0] : resolved;
    const result  = await withLidRetry(client, to, () => client.sendMessage(formatId(to), content));
    res.json({ success: true, message_id: await getSentMessageId(getSession(session_id), result) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/forward
app.post('/send/forward', async (req, res) => {
  const { session_id = 'default', to, message_id } = req.body;
  try {
    const client = requireClient(session_id);
    const msg = await client.getMessageById(message_id);
    if (!msg) throw new Error(`Mensagem não encontrada: ${message_id}`);
    await withLidRetry(client, to, () => msg.forward(formatId(to)));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /message/edit
app.post('/message/edit', async (req, res) => {
  const { session_id = 'default', message_id, new_text } = req.body;
  try {
    const client = requireClient(session_id);
    const msg = await client.getMessageById(message_id);
    if (!msg) throw new Error(`Mensagem não encontrada: ${message_id}`);
    await msg.edit(new_text);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /message/delete
app.post('/message/delete', async (req, res) => {
  const { session_id = 'default', message_id, for_everyone = true } = req.body;
  try {
    const client = requireClient(session_id);
    const msg = await client.getMessageById(message_id);
    if (!msg) throw new Error(`Mensagem não encontrada: ${message_id}`);
    await msg.delete(for_everyone);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /message/read
// whatsapp-web.js só expõe "marcar chat inteiro como lido" (sendSeen), não
// há como confirmar leitura de uma mensagem específica isoladamente.
app.post('/message/read', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const chat = await requireChat(session_id, jid);
    await chat.sendSeen();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /message/pin
app.post('/message/pin', async (req, res) => {
  const { session_id = 'default', message_id, duration = 604800 } = req.body;
  try {
    const client = requireClient(session_id);
    const msg = await client.getMessageById(message_id);
    if (!msg) throw new Error(`Mensagem não encontrada: ${message_id}`);
    await msg.pin(duration);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /message/star
app.post('/message/star', async (req, res) => {
  const { session_id = 'default', message_id, starred = true } = req.body;
  try {
    const client = requireClient(session_id);
    const msg = await client.getMessageById(message_id);
    if (!msg) throw new Error(`Mensagem não encontrada: ${message_id}`);
    starred ? await msg.star() : await msg.unstar();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Grupos ──────────────────────────────────────────────────

// POST /group/create
app.post('/group/create', async (req, res) => {
  const { session_id = 'default', subject, participants = [] } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.createGroup(subject, participants.map(formatId));
    res.json({ success: true, group_jid: result?.gid?._serialized, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/participants/add
app.post('/group/participants/add', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const result = await chat.addParticipants(participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/participants/remove
app.post('/group/participants/remove', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const result = await chat.removeParticipants(participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/admins/promote
app.post('/group/admins/promote', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const result = await chat.promoteParticipants(participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/admins/demote
app.post('/group/admins/demote', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const result = await chat.demoteParticipants(participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/subject
app.post('/group/subject', async (req, res) => {
  const { session_id = 'default', group_jid, subject } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    await chat.setSubject(subject);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/description
app.post('/group/description', async (req, res) => {
  const { session_id = 'default', group_jid, description } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    await chat.setDescription(description);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/leave
app.post('/group/leave', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    await chat.leave();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/invite-code
app.post('/group/invite-code', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const code = await chat.getInviteCode();
    res.json({ success: true, invite_code: code, invite_link: `https://chat.whatsapp.com/${code}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/invite-code/revoke
app.post('/group/invite-code/revoke', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const code = await chat.revokeInvite();
    res.json({ success: true, invite_code: code });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/metadata
app.post('/group/metadata', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    res.json({
      success: true,
      subject: chat.name,
      description: chat.description,
      owner: chat.owner?._serialized,
      participants: (chat.participants || []).map(p => ({
        jid: p.id?._serialized, is_admin: p.isAdmin, is_super_admin: p.isSuperAdmin,
      })),
      created_at: chat.createdAt,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/join-requests
app.post('/group/join-requests', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const requests = await chat.getGroupMembershipRequests();
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/join-requests/update
app.post('/group/join-requests/update', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [], action } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    const result = action === 'approve'
      ? await chat.approveGroupMembershipRequests(participants.map(formatId))
      : await chat.rejectGroupMembershipRequests(participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/join
app.post('/group/join', async (req, res) => {
  const { session_id = 'default', invite_link } = req.body;
  try {
    const client = requireClient(session_id);
    const code = invite_link.split('/').pop();
    const groupId = await client.acceptInvite(code);
    res.json({ success: true, group_jid: groupId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/announce
app.post('/group/announce', async (req, res) => {
  const { session_id = 'default', group_jid, announce } = req.body;
  try {
    const chat = await requireChat(session_id, group_jid);
    await chat.setMessagesAdminsOnly(!!announce);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /group/disappearing
app.post('/group/disappearing', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Mensagens temporárias em grupo'));
});

// ── Perfil, contatos, presença ─────────────────────────────

// POST /profile/picture
app.post('/profile/picture', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    const url = await client.getProfilePicUrl(formatId(jid));
    res.json({ success: true, url: url || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /profile/picture/update
app.post('/profile/picture/update', async (req, res) => {
  const { session_id = 'default', image_b64 } = req.body;
  try {
    const client = requireClient(session_id);
    const media  = new MessageMedia('image/jpeg', image_b64);
    await client.setProfilePicture(media);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /profile/picture/remove
app.post('/profile/picture/remove', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const client = requireClient(session_id);
    await client.deleteProfilePicture();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /profile/status
app.post('/profile/status', async (req, res) => {
  const { session_id = 'default', status } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setStatus(status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /profile/name
app.post('/profile/name', async (req, res) => {
  const { session_id = 'default', name } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setDisplayName(name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /profile/get-status
app.post('/profile/get-status', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client  = requireClient(session_id);
    const contact = await client.getContactById(formatId(jid));
    const about   = await contact.getAbout();
    res.json({ success: true, status: about || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /contact/check
app.post('/contact/check', async (req, res) => {
  const { session_id = 'default', phone } = req.body;
  try {
    const client   = requireClient(session_id);
    const numberId = await client.getNumberId(phone);
    res.json({ success: true, exists: !!numberId, jid: numberId?._serialized || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /contact/block
app.post('/contact/block', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client  = requireClient(session_id);
    const contact = await client.getContactById(formatId(jid));
    await contact.block();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /contact/unblock
app.post('/contact/unblock', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client  = requireClient(session_id);
    const contact = await client.getContactById(formatId(jid));
    await contact.unblock();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /contact/blocklist
app.post('/contact/blocklist', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const client = requireClient(session_id);
    const blocked = await client.getBlockedContacts();
    res.json({ success: true, blocklist: blocked.map(c => c.id?._serialized) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /contact/business-profile
// Lib não expõe um endpoint dedicado de perfil comercial — só os campos
// básicos já presentes no objeto Contact.
app.post('/contact/business-profile', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client  = requireClient(session_id);
    const contact = await client.getContactById(formatId(jid));
    if (!contact.isBusiness) {
      return res.json({ success: true, is_business: false });
    }
    res.json({ success: true, is_business: true, name: contact.name, short_name: contact.shortName });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /privacy/settings — sem API na lib
app.post('/privacy/settings', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Consulta de configurações de privacidade'));
});

// POST /privacy/update — sem API na lib
app.post('/privacy/update', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Alteração de configurações de privacidade'));
});

// POST /presence/send
app.post('/presence/send', async (req, res) => {
  const { session_id = 'default', to, type } = req.body;
  try {
    const client = requireClient(session_id);
    if (type === 'available') {
      await client.sendPresenceAvailable();
    } else if (type === 'unavailable') {
      await client.sendPresenceUnavailable();
    } else {
      const chat = await requireChat(session_id, to);
      if (type === 'composing') await chat.sendStateTyping();
      else if (type === 'recording') await chat.sendStateRecording();
      else if (type === 'paused') await chat.clearState();
      else throw new Error(`Tipo de presença desconhecido: ${type}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /presence/subscribe — sem equivalente individual na lib (só canais)
app.post('/presence/subscribe', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Assinar presença de um contato'));
});

// ── Gerenciamento de chats ────────────────────────────────

// POST /chat/delete
app.post('/chat/delete', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const chat = await requireChat(session_id, jid);
    await chat.delete();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /chat/archive
app.post('/chat/archive', async (req, res) => {
  const { session_id = 'default', jid, archive = true } = req.body;
  try {
    const chat = await requireChat(session_id, jid);
    archive ? await chat.archive() : await chat.unarchive();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /chat/mute
app.post('/chat/mute', async (req, res) => {
  const { session_id = 'default', jid, duration_ms } = req.body;
  try {
    const chat = await requireChat(session_id, jid);
    if (duration_ms) {
      await chat.mute(new Date(Date.now() + duration_ms));
    } else {
      await chat.unmute();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /chat/pin
app.post('/chat/pin', async (req, res) => {
  const { session_id = 'default', jid, pinned = true } = req.body;
  try {
    const chat = await requireChat(session_id, jid);
    pinned ? await chat.pin() : await chat.unpin();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /chat/disappearing — sem API dedicada na lib para chats 1:1
app.post('/chat/disappearing', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Mensagens temporárias em chat individual'));
});

// ─── Shutdown gracioso ──────────────────────────────────────────
// Mesmo bug do wppconnect-bridge: pm2 restart manda SIGTERM direto, e sem
// fechar o Chrome/Puppeteer de cada sessão ele fica órfão segurando o
// SingletonLock do userDataDir — próxima sessão falha com "The browser is
// already running" até apagar o lock manualmente.
async function shutdown(signal) {
  console.log(`[WA-Web Bridge] ${signal} recebido, fechando sessões...`);
  const closes = [...sessions.values()].map(s => s.client?.destroy?.().catch(() => {}));
  await Promise.race([Promise.all(closes), new Promise(r => setTimeout(r, 8000))]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[WA-Web Bridge] Rodando na porta ${PORT}`);
  console.log(`[WA-Web Bridge] FastAPI URL: ${FASTAPI_URL}`);
  console.log(`[WA-Web Bridge] Sessões em: ${SESSIONS_DIR}`);
  console.log(`[WA-Web Bridge] Chrome: ${CHROME_PATH || '(auto-detect)'}`);
});

module.exports = app;
