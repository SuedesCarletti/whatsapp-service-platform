/**
 * services/venom-bridge/index.js
 *
 * Bridge HTTP → Venom-Bot (WhatsApp Web via Puppeteer)
 * Porta padrão: 3002
 *
 * Diferente do Baileys (WebSocket puro), o Venom usa Puppeteer/Chrome headless.
 * Requer Chrome instalado no servidor.
 *
 * Endpoints expostos (consumidos por venom_provider.py):
 *   POST /session/init          → inicia sessão, retorna QR se necessário
 *   GET  /session/status        → status de autenticação
 *   POST /session/logout        → desconecta sessão
 *   POST /session/pairing-code  → solicita código de pareamento
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
const venom   = require('venom-bot');
const axios   = require('axios');
const QRCode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');

// ─── Config ──────────────────────────────────────────────────

const PORT         = process.env.VENOM_PORT    || 3002;
const FASTAPI_URL  = process.env.FASTAPI_URL   || 'http://localhost:8000';
const SESSIONS_DIR = process.env.SESSIONS_DIR  || path.join(__dirname, 'sessions');
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
 *   client:    VenomClient | null,
 *   qr:        string | null,   ← base64 PNG
 *   qr_string: string | null,
 *   status:    'idle'|'qr_required'|'authenticated'|'disconnected'|'error',
 *   phone:     string | null,
 *   starting:  boolean,         ← evita inicializações simultâneas
 * }
 */
const sessions = new Map();

function getSession(session_id) {
  if (!sessions.has(session_id)) {
    sessions.set(session_id, {
      client:   null,
      qr:       null,
      qr_string: null,
      status:   'idle',
      phone:    null,
      starting: false,
    });
  }
  return sessions.get(session_id);
}

// ─── Inicializar sessão ───────────────────────────────────────

async function startSession(session_id) {
  const state = getSession(session_id);

  // Já existe um client vivo para essa sessão (autenticado, aguardando QR,
  // ou ainda conectando) — NUNCA chamar create() de novo aqui. O frontend
  // faz polling em /session/init pra atualizar o QR, e uma segunda chamada
  // criaria um segundo browser puppeteer disputando o mesmo userDataDir
  // ("browser already running"), corrompendo a sessão em andamento.
  if (state.client) {
    return buildStatusResponse(session_id);
  }

  // state.creating cobre a tentativa de create() inteira (pode levar bem
  // mais que a janela de 4s da resposta HTTP) — diferente de state.starting,
  // que é só "esse request específico ainda tá esperando". Sem essa
  // distinção, uma 2ª chamada de /session/init que chegasse depois dos 4s
  // mas antes do create() terminar disparava um SEGUNDO browser em cima do
  // primeiro (mesmo userDataDir), causando "browser already running" e
  // deixando a sessão presa.
  if (state.creating) {
    if (state.starting) {
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    return buildStatusResponse(session_id);
  }

  state.starting = true;
  state.creating = true;
  state.status   = 'idle';

  console.log(`[Venom] Iniciando sessão: ${session_id}`);

  // IMPORTANTE: não faz `await` no create() aqui — mesmo racional do
  // wppconnect-bridge (ver comentário lá): numa reconexão via token salvo
  // (sem QR novo, ex. depois que o browser cai sozinho e reconecta), a
  // promise pode demorar demais ou nunca resolver de forma previsível, e
  // bloquear a requisição HTTP travaria o bridge pra essa sessão.
  let successWithoutQRTimer = null;

  venom.create(
    session_id,

    // Callback de QR Code
    // A versão do venom-bot instalada (fork vynect/venom, mais atual que o
    // pacote publicado no npm) às vezes entrega o código cru em vez do PNG
    // já pronto — detecta e renderiza com a lib `qrcode` quando necessário.
    async (base64Qr, asciiQR) => {
      state.qr_string = asciiQR;
      if (typeof base64Qr === 'string' && base64Qr.startsWith('data:image')) {
        state.qr = base64Qr;
      } else {
        try {
          state.qr = await QRCode.toDataURL(base64Qr);
        } catch (err) {
          console.error(`[Venom] Erro ao renderizar QR: ${err.message}`);
          state.qr = null;
        }
      }
      state.status = 'qr_required';
      if (successWithoutQRTimer) {
        clearTimeout(successWithoutQRTimer);
        successWithoutQRTimer = null;
      }
      console.log(`[Venom] QR gerado para sessão: ${session_id}`);
    },

    // Callback de status
    (statusSession) => {
      console.log(`[Venom] Status [${session_id}]: ${statusSession}`);

      if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess') {
        state.status = 'authenticated';
        state.qr     = null;
      } else if (statusSession === 'notLogged' || statusSession === 'browserClose') {
        state.status  = 'disconnected';
        if (state.client) state.client.close().catch(() => {}); // fecha o browser Puppeteer órfão antes de soltar a referência
        state.client  = null;
      } else if (
        (statusSession === 'successChat' || statusSession === 'successPageWhatsapp')
        && state.status !== 'authenticated'
      ) {
        // Numa reconexão via token salvo, o Venom às vezes só emite esses
        // status (nunca 'isLogged'/'qrReadSuccess', nem gera QR). Se depois
        // de alguns segundos nenhum QR apareceu, é reconexão real.
        if (successWithoutQRTimer) clearTimeout(successWithoutQRTimer);
        successWithoutQRTimer = setTimeout(() => {
          if (state.status !== 'qr_required' && state.status !== 'authenticated') {
            state.status = 'authenticated';
            console.log(`[Venom] Sessão confirmada autenticada via reconexão (sem QR): ${session_id}`);
          }
        }, 5000);
      }
    },

    // Opções do Venom
    // IMPORTANTE: a versão instalada (fork vynect/venom v6) tem uma API de
    // config diferente da v5 original — `folderNameToken`/`useChrome`/
    // `createPathFileToken` não existem mais e são silenciosamente
    // ignorados (o venom caía no diretório padrão dele em vez do nosso
    // SESSIONS_DIR, causando colisão de sessões). Nomes corretos na v6:
    // `tokenDir` e `browserPathExecutable`.
    {
      tokenDir:              SESSIONS_DIR,
      headless:              'new',           // Chrome headless (novo modo)
      devtools:              false,
      browserPathExecutable: CHROME_PATH,
      debug:                 false,
      logQR:                 false,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
      autoClose:             0,               // sem timeout automático
      waitForLogin:          false,           // não bloqueia — retorna com QR
    }
  ).then(async (client) => {
    state.client   = client;
    state.creating = false;

    // Só considera autenticado por essa via se conseguirmos mesmo o
    // dispositivo — getHostDevice() só funciona com login real.
    try {
      const info = await client.getHostDevice();
      state.phone = info?.id?.user || null;
      if (state.phone) {
        state.status = 'authenticated';
      }
    } catch (_) {}

    console.log(`[Venom] Sessão autenticada: ${session_id} | Telefone: ${state.phone}`);
    syncChatHistory(session_id, client).catch(() => {});

    // ── Escuta mensagens recebidas ──────────────────────────
    client.onMessage(async (message) => {
      // Receber qualquer mensagem é prova inequívoca de sessão autenticada —
      // os nomes de status emitidos por statusFind variam entre versões da
      // lib e nem sempre são confiáveis, então isso serve de garantia extra.
      if (state.status !== 'authenticated') {
        state.status = 'authenticated';
        state.qr     = null;
        if (!state.phone) {
          try {
            const info = await client.getHostDevice();
            state.phone = info?.id?.user || null;
          } catch (_) {}
        }
        console.log(`[Venom] Sessão confirmada autenticada via mensagem recebida: ${session_id}`);
      }
      if (message.isGroupMsg) return; // ignora grupos por enquanto
      try {
        await forwardMessageToFastAPI(session_id, message);
      } catch (err) {
        console.error(`[Venom] Erro ao encaminhar mensagem: ${err.message}`);
      }
    });

    // ── Escuta ACK (status) ─────────────────────────────────
    client.onAck(async (ack) => {
      await forwardStatusUpdate(session_id, ack).catch(() => {});
    });
  }).catch((err) => {
    state.creating = false;
    console.error(`[Venom] Erro ao criar sessão ${session_id}: ${err.message}`);
    if (!state.qr && state.status !== 'authenticated') {
      state.status = 'error';
    }
  });

  // Não bloqueia — dá uma janela pro catchQR/statusFind atualizarem o estado
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
// O venom-bot já replica boa parte do backlog recente "de graça" pelo
// próprio onMessage ao conectar — mas isso não é garantido/completo (varia
// por sessão). Buscamos explicitamente as últimas conversas + mensagens
// pra garantir cobertura e mandamos pro mesmo endpoint de sync do Baileys.

async function syncChatHistory(session_id, client) {
  try {
    const chats = await client.getAllChats();
    const batch = [];

    for (const chat of (chats || []).slice(0, SYNC_MAX_CHATS)) {
      const jid = chat?.id?._serialized || chat?.id || chat?.chatId;
      if (!jid) continue;

      let messages = [];
      try {
        messages = await client.getAllMessagesInChat(jid, SYNC_MAX_PER_CHAT);
      } catch (_) {
        continue; // chat sem histórico acessível — pula
      }

      const isGroup   = chat.isGroup || String(jid).endsWith('@g.us');
      const chatName  = chat.name || chat.formattedTitle || chat.contact?.name || '';

      for (const m of messages) {
        const senderJid = isGroup ? (m.author || jid) : jid;
        batch.push({
          session_id,
          wamid:        extractWamid(m.id),
          from:         m.fromMe ? 'me' : String(senderJid).replace('@c.us', '').replace('@g.us', ''),
          to:           m.fromMe ? String(jid).replace('@c.us', '') : 'me',
          direction:    m.fromMe ? 'outbound' : 'inbound',
          type:         m.type || 'chat',
          timestamp:    (m.timestamp || 0) * 1000,
          text:         m.body || '',
          contact_name: chatName,
          push_name:    chatName,
          is_group:     isGroup,
          group_jid:    isGroup ? jid : undefined,
          group_name:   isGroup ? chatName : undefined,
          participant:  isGroup && !m.fromMe ? senderJid : undefined,
        });
      }
    }

    if (batch.length) {
      // Sem session_id na raiz, receive_bridge_sync() cai no fallback
      // "primeira conta ativa" e mistura o histórico de contas diferentes —
      // ver mesmo fix em wppconnect-bridge/index.js.
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/sync`, { session_id, messages: batch }, { timeout: 30000 });
      console.log(`[Venom] Sincronizadas ${batch.length} mensagens de ${chats.length} conversas`);
    }
  } catch (err) {
    console.error(`[Venom] Erro ao sincronizar histórico: ${err.message}`);
  }
}

// ─── Encaminhar ao FastAPI ────────────────────────────────────

async function forwardMessageToFastAPI(session_id, message) {
  // BUG anterior: mandava "message_id", mas o backend (_normalize_message em
  // routes_bridge.py) só lê o campo "wamid" — toda mensagem caía no fallback
  // fixo `bridge_{session_id}`, o MESMO id pra sessão inteira. Como a
  // deduplicação do webhook é por wamid, cada mensagem nova sobrescrevia a
  // linha da anterior no banco (só a última "sobrevivia" por conversa). Este
  // listener só cobre mensagens recebidas (onMessage, não onAnyMessage), daí
  // direction/to fixos — não há mensagem outbound passando por aqui.
  const payload = {
    bridge_provider: 'venom',
    session_id,
    from:       message.from?.replace('@c.us', '') || '',
    jid:        message.from || '',
    wamid:      extractWamid(message.id),
    direction:  'inbound',
    to:         'me',
    // BUG anterior: mandava em segundos (message.timestamp é Unix seconds,
    // padrão da lib; o fallback também computava em segundos), mas o resto
    // do sistema (backend, outros bridges) espera milissegundos — a
    // mensagem ficava registrada com data de ~1970, o que já fez a rota de
    // marcar-como-lida tratar mensagens de HOJE como "mensagem antiga" (>30
    // dias) por engano.
    timestamp:  (message.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    type:       message.type || 'chat',
    pushName:   message.sender?.pushname || '',
    text:       message.body || '',
    caption:    message.caption || '',
    mimetype:   message.mimetype || '',
    filename:   message.filename || '',
  };

  await axios.post(`${FASTAPI_URL}/api/webhook/bridge`, payload, {
    timeout: 8000,
    headers: { 'Content-Type': 'application/json' },
  });

  console.log(`[Venom] Mensagem encaminhada: ${payload.from} → ${payload.type}`);
}

async function forwardStatusUpdate(session_id, ack) {
  await axios.post(`${FASTAPI_URL}/api/webhook/bridge/status`, {
    bridge_provider: 'venom',
    session_id,
    message_id: ack.id?.id,
    status:     ack.ack,
  }, { timeout: 5000 }).catch(() => {});
}

// ─── App Express ──────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    service:  'venom-bridge',
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
    console.error(`[Venom] /session/init erro: ${err.message}`);
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
      await state.client.close().catch(() => {});
      state.client = null;
    }

    // Remove tokens salvos
    const tokenDir = path.join(SESSIONS_DIR, session_id);
    if (fs.existsSync(tokenDir)) {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }

    state.status   = 'disconnected';
    state.phone    = null;
    state.qr       = null;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /session/pairing-code ────────────────────────────────
// Nota: Venom usa Puppeteer e não suporta nativamente pairing code
// via API pública. Este endpoint retorna erro orientativo.
app.post('/session/pairing-code', async (req, res) => {
  res.status(501).json({
    success: false,
    error:   'Venom-Bot não suporta código de pareamento. Use o QR Code.',
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

// WhatsApp Web renomeou a propriedade de ID serializado de "_serialized" pra
// "$1" numa atualização de julho/2026 — a lib do Venom (rewrite recente,
// sem esse fix) devolve o objeto de ID cru em vez da string quando isso
// acontece. Sem normalizar aqui, m.id/message.id vira um OBJETO no payload
// mandado pro backend, que quebra ao tentar salvar como wamid (coluna de
// texto): "TypeError: dict can not be used as parameter". Confirmado ao
// vivo processando o eco de uma mensagem de outro provider linkado no
// mesmo número.
function extractWamid(id) {
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object') return id._serialized || id.$1 || id.id || null;
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

// Baixa mídia de uma URL e devolve base64 + mime type real (o header
// Content-Type do servidor de origem, não um chute) — necessário porque a
// função da lib que manda mídia (window.WWebJS.sendMediaMessage) precisa do
// mimetype de verdade pra decidir se é imagem/vídeo/áudio/documento; antes
// o bridge mandava a URL crua e um mimetype fixo/errado (BUG anterior, ver
// comentário em client.js do venom-bot sobre a assinatura da função).
async function fetchMediaAsBase64(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const base64 = Buffer.from(resp.data).toString('base64');
  const mimetype = resp.headers['content-type']?.split(';')[0] || 'application/octet-stream';
  return { base64, mimetype };
}

// POST /send/text
app.post('/send/text', async (req, res) => {
  const { session_id = 'default', to, text } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.sendText(formatId(to), text);
    res.json({ success: true, message_id: extractWamid(result?.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/image
app.post('/send/image', async (req, res) => {
  const { session_id = 'default', to, url, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const { base64, mimetype } = await fetchMediaAsBase64(url);
    const result = await client.sendImage(formatId(to), base64, mimetype, 'imagem', caption);
    res.json({ success: true, message_id: extractWamid(result?.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/video
app.post('/send/video', async (req, res) => {
  const { session_id = 'default', to, url, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const { base64, mimetype } = await fetchMediaAsBase64(url);
    const result = await client.sendVideo(formatId(to), base64, mimetype, 'video', caption);
    res.json({ success: true, message_id: extractWamid(result?.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/audio
app.post('/send/audio', async (req, res) => {
  const { session_id = 'default', to, url } = req.body;
  try {
    const client = requireClient(session_id);
    const { base64, mimetype } = await fetchMediaAsBase64(url);
    const result = await client.sendVoice(formatId(to), base64, mimetype);
    res.json({ success: true, message_id: extractWamid(result?.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/document
app.post('/send/document', async (req, res) => {
  const { session_id = 'default', to, url, filename = 'arquivo' } = req.body;
  try {
    const client = requireClient(session_id);
    const { base64, mimetype } = await fetchMediaAsBase64(url);
    const result = await client.sendFile(formatId(to), base64, mimetype, filename, filename);
    res.json({ success: true, message_id: extractWamid(result?.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /send/location
app.post('/send/location', async (req, res) => {
  const { session_id = 'default', to, lat, lng, name = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.sendLocation(formatId(to), lat, lng, name);
    res.json({ success: true, message_id: extractWamid(result?.id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Shutdown gracioso ──────────────────────────────────────────
// Mesmo bug do wppconnect-bridge e wa-web-bridge: pm2 restart manda SIGTERM
// direto, e sem fechar o Chrome/Puppeteer de cada sessão ele fica órfão
// segurando o SingletonLock do userDataDir — próxima sessão falha com
// "The browser is already running" até apagar o lock manualmente.
async function shutdown(signal) {
  console.log(`[Venom Bridge] ${signal} recebido, fechando sessões...`);
  const closes = [...sessions.values()].map(s => s.client?.close?.().catch(() => {}));
  await Promise.race([Promise.all(closes), new Promise(r => setTimeout(r, 8000))]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Venom Bridge] Rodando na porta ${PORT}`);
  console.log(`[Venom Bridge] FastAPI URL: ${FASTAPI_URL}`);
  console.log(`[Venom Bridge] Sessões em: ${SESSIONS_DIR}`);
  console.log('[Venom Bridge] Requer Chrome/Chromium instalado');
});

module.exports = app;
