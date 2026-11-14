/**
 * services/wppconnect-bridge/index.js
 *
 * Bridge HTTP → @wppconnect-team/wppconnect (WhatsApp Web via Puppeteer)
 * Porta padrão: 3003
 *
 * Mesmo contrato HTTP do venom-bridge/wa-web-bridge (session/init, send/*,
 * etc.) — ver services/venom-bridge/index.js para o racional de manter os
 * bridges não-oficiais uniformes. Requer Chrome/Chromium instalado no servidor.
 *
 * Diferença: se WPPCONNECT_SECRET_KEY estiver definido, todas as rotas
 * exigem "Authorization: Bearer <secret_key>" (proteção básica do bridge,
 * não é autenticação de sessão do WhatsApp).
 *
 * Endpoints expostos (consumidos por wppconnect_provider.py):
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

const express     = require('express');
const wppconnect  = require('@wppconnect-team/wppconnect');
const axios       = require('axios');

// Segredo compartilhado bridge -> backend (BRIDGE_SHARED_SECRET no backend e aqui).
axios.interceptors.request.use((config) => {
  const secret = process.env.BRIDGE_SHARED_SECRET;
  const url = typeof config?.url === 'string' ? config.url : '';
  if (secret && (url.includes('/api/webhook/') || url.includes('/api/media/bridge-upload'))) {
    config.headers = config.headers || {};
    config.headers['X-Bridge-Secret'] = secret;
  }
  return config;
});

const path        = require('path');
const fs          = require('fs');
const { startPageProbe } = require('./page-probe');
const { WatermarkStore, runGapCatchup } = require('./gap-catchup');
const { postHistoryBatch } = require('./history-gate');

// ─── Config ──────────────────────────────────────────────────

const PORT         = process.env.WPPCONNECT_PORT       || 3003;
const FASTAPI_URL  = process.env.FASTAPI_URL            || 'http://localhost:8000';
const SESSIONS_DIR = process.env.SESSIONS_DIR           || path.join(__dirname, 'sessions');
const CHROME_PATH  = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const SECRET_KEY   = process.env.WPPCONNECT_SECRET_KEY  || '';
const SYNC_MAX_CHATS    = parseInt(process.env.SYNC_MAX_CHATS    || '50', 10);
const SYNC_MAX_PER_CHAT = parseInt(process.env.SYNC_MAX_PER_CHAT || '30', 10);

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ─── Entrega confiável de webhooks ────────────────────────────
// Incidente real (2026-09-01): 2 mensagens de cliente chegaram no WhatsApp
// mas nunca apareceram no app. Causa: `axios.post` pro FastAPI só tentava
// UMA vez — qualquer falha transitória do backend (crash, restart, deploy,
// query lenta enchendo o único worker) descartava a mensagem pra sempre,
// sem log de alerta nem forma de recuperar depois. postWebhookWithRetry
// tenta de novo com backoff (cobre reinícios/blips de alguns segundos) e,
// se todas as tentativas falharem, grava o payload em disco em vez de só
// jogar fora — dá pra reprocessar manualmente depois.
const FAILED_WEBHOOKS_LOG = path.join(__dirname, 'failed_webhooks.jsonl');

async function postWebhookWithRetry(url, payload, { timeout = 8000, retries = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.post(url, payload, {
        timeout,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
        console.warn(`[WPPConnect] Falha ao entregar webhook (tentativa ${attempt}/${retries}, retry em ${delayMs}ms): ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  console.error(`[WPPConnect] CRÍTICO: webhook não entregue após ${retries} tentativas (${url}): ${lastErr.message} — salvando em ${FAILED_WEBHOOKS_LOG}`);
  try {
    fs.appendFileSync(FAILED_WEBHOOKS_LOG, JSON.stringify({ url, payload, failed_at: new Date().toISOString(), error: lastErr.message }) + '\n');
  } catch (writeErr) {
    console.error(`[WPPConnect] Falha ao gravar fila de recuperação: ${writeErr.message}`);
  }
  throw lastErr;
}

// BUG (2026-09-22, confirmado ao vivo — cliente do Pós Vendas mandou texto +
// PDF às 11:26 UTC durante a queda do backend, nada apareceu no app): a fila
// acima era só gravada, nunca relida — "dá pra reprocessar manualmente" na
// prática nunca acontecia (2759 entradas acumuladas desde 02/09). Agora um
// loop reenvia sozinho assim que o backend volta. É idempotente: o backend
// deduplica por wamid, e mensagem com >1h de atraso já pula automações/IA
// (_is_stale_inbound), então reenviar não reabre conversa nem acorda o bot.
const FAILED_WEBHOOKS_REPLAYING = `${FAILED_WEBHOOKS_LOG}.replaying`;
const FAILED_WEBHOOKS_DEAD      = path.join(__dirname, 'failed_webhooks.dead.jsonl');
const REPLAY_INTERVAL_MS        = 60000;
const REPLAY_PACE_MS            = 150;
// Mídia só dá pra baixar de novo com a sessão autenticada — espera até
// ~30 passadas (~30min) antes de desistir e entregar sem o arquivo.
const REPLAY_MAX_MEDIA_WAITS    = 30;
const STATUS_BROADCAST_TTL_MS   = 24 * 60 * 60 * 1000;
let replayRunning = false;

function replayDropReason(entry) {
  const { url = '', payload = {} } = entry;
  // ACK reprocessado fora de ordem rebaixaria read → delivered (o backend
  // não protege contra regressão de status) — não vale o risco.
  if (url.endsWith('/webhook/bridge/status')) return 'ack';
  const isStatus = payload.from === 'status@broadcast' || payload.to === 'status@broadcast';
  if (isStatus && Date.now() - (payload.timestamp || 0) > STATUS_BROADCAST_TTL_MS) return 'status expirado';
  return null;
}

async function replayFailedWebhooks() {
  if (replayRunning) return;
  replayRunning = true;
  try {
    // .replaying sobrando = passada anterior interrompida (crash/restart):
    // reprocessa ela primeiro, o que já foi entregue vira no-op por wamid.
    if (!fs.existsSync(FAILED_WEBHOOKS_REPLAYING)) {
      if (!fs.existsSync(FAILED_WEBHOOKS_LOG)) return;
      fs.renameSync(FAILED_WEBHOOKS_LOG, FAILED_WEBHOOKS_REPLAYING);
    }
    const lines = fs.readFileSync(FAILED_WEBHOOKS_REPLAYING, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    const stats = { sent: 0, dropped: 0, dead: 0, kept: 0 };
    // BUG (2026-09-22, confirmado ao vivo em prod — fila de 2772 entradas
    // parada por 10+ minutos, zero progresso, zero log): um `backendDown`
    // permanente (setado na 1ª falha de rede) fazia TODA entrada seguinte
    // da passada ser reempurrada sem sequer tentar — inclusive as que
    // seriam só descartadas (ack/status expirado), por isso nem "kept"
    // aparecia no log. Sob carga real (é justamente quando a fila mais
    // precisa avançar) um timeout isolado é comum e não significa backend
    // fora. Troca por um contador de falhas de rede CONSECUTIVAS — só
    // desiste da passada depois de algumas seguidas, e qualquer sucesso
    // no meio zera o contador.
    const CONSECUTIVE_FAIL_LIMIT = 5;
    let consecutiveNetworkFails = 0;
    let giveUpRest = false;

    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { stats.dead++; fs.appendFileSync(FAILED_WEBHOOKS_DEAD, line + '\n'); continue; }
      if (giveUpRest) { keep.push(entry); continue; }
      if (replayDropReason(entry)) { stats.dropped++; continue; }

      const { payload } = entry;
      if (MEDIA_TYPES.has(payload.type) && !payload.media_url && payload.wamid) {
        const state = sessions.get(payload.session_id);
        if (state?.client && state.status === 'authenticated') {
          await downloadAndUploadMedia(state.client, { id: payload.wamid }, payload, payload.wamid);
        } else if ((entry.media_waits || 0) < REPLAY_MAX_MEDIA_WAITS) {
          entry.media_waits = (entry.media_waits || 0) + 1;
          keep.push(entry);
          continue;
        }
      }

      try {
        await axios.post(entry.url, payload, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
        stats.sent++;
        consecutiveNetworkFails = 0;
        if (payload.type === 'ciphertext') trackCiphertext(payload.session_id, payload.wamid);
      } catch (err) {
        const code = err.response?.status;
        if (code && code >= 400 && code < 500 && code !== 408 && code !== 429) {
          // Payload rejeitado de vez — não adianta insistir.
          stats.dead++;
          consecutiveNetworkFails = 0;
          fs.appendFileSync(FAILED_WEBHOOKS_DEAD, JSON.stringify({ ...entry, dead_at: new Date().toISOString(), dead_error: `${code} ${err.message}` }) + '\n');
        } else {
          // Timeout/conexão/5xx — guarda esta pra próxima passada. Só
          // desiste do RESTO da passada depois de várias seguidas assim
          // (backend genuinamente fora), não numa falha isolada sob carga.
          keep.push(entry);
          consecutiveNetworkFails++;
          if (consecutiveNetworkFails >= CONSECUTIVE_FAIL_LIMIT) giveUpRest = true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, REPLAY_PACE_MS));
    }

    // Append (não sobrescreve): falhas novas podem ter caído no arquivo
    // principal enquanto esta passada rodava.
    if (keep.length) fs.appendFileSync(FAILED_WEBHOOKS_LOG, keep.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.unlinkSync(FAILED_WEBHOOKS_REPLAYING);
    stats.kept = keep.length;
    // Loga sempre que havia algo pra processar (mesmo sem progresso — isso
    // por si só já é sinal de algo travado, como o bug do backendDown
    // permanente documentado acima escondia por completo).
    if (lines.length) {
      console.log(`[WPPConnect] Fila de recuperação reprocessada: ${stats.sent} entregues, ${stats.dropped} descartados (ack/status expirado), ${stats.dead} rejeitados, ${stats.kept} pendentes${giveUpRest ? ' (parou cedo: backend parece fora)' : ''}`);
    }
  } catch (err) {
    console.error(`[WPPConnect] Erro ao reprocessar fila de recuperação: ${err.message}`);
  } finally {
    replayRunning = false;
  }
}

// BUG (2026-09-22, confirmado ao vivo — SAC-01, textos comuns presos em
// "Mensagem não pôde ser decifrada"): o backend sabe "curar" o
// placeholder quando a mesma wamid chega de novo com o tipo real, mas
// dependia da lib reemitir a mensagem ao decifrar — e onAnyMessage NÃO
// dispara de novo (só em "add", não na troca de tipo). Zero curas nos logs
// desde 01/09. Agora o bridge guarda cada ciphertext encaminhado e, a cada
// passada, relê do Store (getMessageById); decifrou → reencaminha, e o
// backend troca o placeholder pelo conteúdo real. Persistido em disco pra
// sobreviver a restart do bridge.
const PENDING_CIPHERTEXT_FILE   = path.join(__dirname, 'pending_ciphertext.json');
const CIPHERTEXT_MAX_AGE_MS     = 7 * 24 * 60 * 60 * 1000;
const CIPHERTEXT_HEAL_INTERVAL_MS = 60000;
let ciphertextHealRunning = false;

function loadPendingCiphertext() {
  try { return JSON.parse(fs.readFileSync(PENDING_CIPHERTEXT_FILE, 'utf8')); } catch { return []; }
}

function savePendingCiphertext(list) {
  try {
    fs.writeFileSync(PENDING_CIPHERTEXT_FILE, JSON.stringify(list));
  } catch (err) {
    console.error(`[WPPConnect] Falha ao gravar pending_ciphertext.json: ${err.message}`);
  }
}

function trackCiphertext(session_id, wamid) {
  if (!wamid) return;
  const list = loadPendingCiphertext();
  if (list.some(e => e.wamid === wamid)) return;
  list.push({ session_id, wamid, since: Date.now() });
  savePendingCiphertext(list);
}

async function healCiphertextMessages() {
  if (ciphertextHealRunning) return;
  ciphertextHealRunning = true;
  const done = new Set();
  let healed = 0;
  try {
    for (const entry of loadPendingCiphertext()) {
      if (Date.now() - entry.since > CIPHERTEXT_MAX_AGE_MS) {
        console.warn(`[WPPConnect] Ciphertext ${entry.wamid} não decifrou em 7 dias — desistindo`);
        done.add(entry.wamid);
        continue;
      }
      const state = sessions.get(entry.session_id);
      if (!state?.client || state.status !== 'authenticated') continue;
      try {
        const msg = await withTimeout(state.client.getMessageById(entry.wamid), 15000, 'getMessageById');
        if (msg && msg.type && msg.type !== 'ciphertext') {
          await forwardMessageToFastAPI(state.client, entry.session_id, msg);
          done.add(entry.wamid);
          healed++;
        }
      } catch (err) {
        // Mensagem ainda não disponível no Store ou backend fora — tenta de novo na próxima.
      }
    }
  } finally {
    // Relê antes de gravar: trackCiphertext pode ter adicionado entradas
    // novas enquanto esta passada rodava.
    if (done.size) savePendingCiphertext(loadPendingCiphertext().filter(e => !done.has(e.wamid)));
    if (healed) console.log(`[WPPConnect] ${healed} mensagem(ns) antes "não decifrada(s)" recuperada(s)`);
    ciphertextHealRunning = false;
  }
}

// ─── Gerenciador de sessões ───────────────────────────────────

/**
 * sessions: Map<session_id, SessionState>
 *
 * SessionState = {
 *   client:    Whatsapp | null,
 *   qr:        string | null,   ← base64 PNG
 *   qr_string: string | null,
 *   status:    'idle'|'qr_required'|'authenticated'|'disconnected'|'error',
 *   phone:     string | null,
 *   starting:  boolean,         ← evita inicializações simultneas
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
// com client.getPnLidEntry(), a função equivalente do wppconnect.
const lidToPhoneCache = {};

async function resolveLidToPhone(client, session_id, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  if (!lidToPhoneCache[session_id]) lidToPhoneCache[session_id] = {};
  const cached = lidToPhoneCache[session_id][jid];
  if (cached) return cached;

  try {
    const entry = await client.getPnLidEntry(jid);
    // entry.phoneNumber é um objeto Wid ({id, server, _serialized}), não
    // string — confirmado ao vivo: { lid: {...}, phoneNumber: { _serialized:
    // "551199990001@c.us" }, contact: {...} }.
    const resolved = entry?.phoneNumber?._serialized;
    if (resolved) {
      lidToPhoneCache[session_id][jid] = resolved;
      return resolved;
    }
  } catch (e) {
    console.warn(`[WPPConnect] Falha ao resolver LID ${jid}: ${e.message}`);
  }
  return jid;
}

// Extrai um wamid utilizável de `message.id` — em algumas respostas da lib
// (confirmado ao vivo: TODAS as mensagens do histórico e ao menos uma
// mensagem ao vivo, um sticker) `message.id` não é a string plana esperada;
// vem como objeto ({_serialized}/{id}) ou undefined. Sem extrair aqui, o
// payload mandado pro backend fica SEM a chave "wamid" (undefined é
// removido pelo JSON.stringify) — o backend cai no fallback fixo
// `bridge_{session_id}`, MESMO pra mensagens diferentes, e cada mensagem
// nova nessa mesma conversa passa a "reaproveitar" (sobrescrever silenciosamente,
// sem nenhum erro) o registro anterior em vez de criar um novo — a mensagem
// nova nunca aparece no app.
function extractMessageId(raw) {
  if (typeof raw === 'string' && raw) return raw;
  if (raw && typeof raw === 'object') {
    if (typeof raw._serialized === 'string' && raw._serialized) return raw._serialized;
    if (typeof raw.id === 'string' && raw.id) return raw.id;
  }
  // Nunca devolve algo repetível entre mensagens diferentes (isso é
  // exatamente o bug original: todas caindo no MESMO fallback fixo,
  // sobrescrevendo umas às outras) — gera um id sintético único.
  const synthetic = `wpp_unk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.warn(`[WPPConnect] message.id em formato inesperado (${JSON.stringify(raw)}), usando id sintético: ${synthetic}`);
  return synthetic;
}

// Hash estável (FNV-1a) — só pra gerar um sufixo curto e determinístico,
// não precisa resistir a colisão criptográfica.
function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// BUG anterior: extractMessageId() gerava um id ALEATÓRIO (Date.now() +
// random) quando message.id vinha em formato inesperado — e
// client.getAllMessagesInChat() (usado no sync de histórico) NUNCA traz o id
// real (só "rowId" interno, ver comentário mais abaixo). Resultado: toda vez
// que a sessão reconectava (reinício do bridge, watchdog etc.) o histórico
// inteiro era re-sincronizado com wamids NOVOS — cada mensagem antiga virava
// uma linha duplicada no banco a cada reconexão (confirmado ao vivo: mesmas
// mensagens 4x, uma por reconexão). Aqui o id é determinístico — a mesma
// mensagem (mesmo chat + timestamp + remetente + corpo) sempre gera o mesmo
// wamid, então re-sincronizar vira no-op (o backend já dedupa por wamid).
function historySyntheticId(chatJid, timestampMs, fromMe, body) {
  return `wpp_hist_${stableHash(`${chatJid}|${timestampMs}|${fromMe ? 1 : 0}|${body || ''}`)}`;
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
      // Localização que ACABAMOS de mandar (setado por /send/location logo
      // antes do client.sendLocation()) — pra mensagens outbound o eco do
      // message_create não traz lat/lng preenchidos (confirmado ao vivo:
      // só "loc":"" vazio), diferente de mensagens realmente recebidas.
      pendingOutboundLocation: null,
    });
  }
  return sessions.get(session_id);
}

// getHostDevice() nessa versão da lib não traz mais o número em id.user/
// wid.user (retorna só metadata tipo {id:"1", platform, pushname...}) —
// confirmado ao vivo. getWid() é quem retorna o JID de verdade, como
// string "5544xxxxxxxx@c.us".
async function fetchSessionPhone(client) {
  try {
    const wid = await client.getWid();
    if (typeof wid === 'string') return wid.split('@')[0] || null;
    return wid?.user || wid?._serialized?.split('@')[0] || null;
  } catch (_) {
    return null;
  }
}

// ─── Recuperação de mensagens perdidas (marca d'água) ───────────
//
// Incidentes 2026-09-24 (Financeiro, 4 dias) e 2026-09-28 (Pós Vendas, ~4h30):
// a página do Chrome morreu (OOM) e o que chegou nesse intervalo nunca entrou.
// Marca d'água = hora até a qual tudo já foi entregue. Ao (re)conectar, busca só
// o que aconteceu depois dela; a cada RECONCILE_INTERVAL_MS revê os últimos
// minutos. O backend diz quais wamids faltam (/bridge/missing), então nada é
// reprocessado à toa. Ver gap-catchup.js.
const watermarks = new WatermarkStore(path.join(__dirname, 'session_watermark.json'));
const RECONCILE_INTERVAL_MS  = parseInt(process.env.RECONCILE_INTERVAL_MS || String(10 * 60 * 1000), 10);
const RECONCILE_WINDOW_MS    = 30 * 60 * 1000;
const CATCHUP_START_DELAY_MS = 25000;
const CATCHUP_RETRY_MS       = 5 * 60 * 1000;
const CATCHUP_MAX_RETRIES    = 6;
const CATCHUP_MAX_CHATS_CAP  = 400;
const catchupStatus = new Map();
let catchupQueue = Promise.resolve(); // uma recuperação por vez em todo o bridge

function noteLiveDelivered(session_id, payload) {
  if (payload.from === 'status@broadcast' || payload.to === 'status@broadcast') return;
  if (getSession(session_id).catchupPending) return;
  watermarks.bump(session_id, payload.timestamp);
}

async function listChatsStable(client) {
  let prev = -1;
  let chats = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    chats = await client.listChats({ count: 200 });
    if (chats.length > 0 && chats.length <= prev) break;
    prev = chats.length;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return chats;
}

async function backendHealthMs() {
  const t0 = Date.now();
  await axios.get(`${FASTAPI_URL}/api/health`, { timeout: 5000 });
  return Date.now() - t0;
}

async function filterMissingWamids(session_id, wamids) {
  try {
    const res = await axios.post(`${FASTAPI_URL}/api/webhook/bridge/missing`, { session_id, wamids }, { timeout: 15000 });
    return Array.isArray(res.data?.missing) ? res.data.missing : wamids;
  } catch (_) {
    return wamids; // falha aberta: /bridge/sync continua deduplicando por wamid
  }
}

function scheduleCatchup(session_id, client, { sinceMs, reason, opts = {}, isConnect = false, attempt = 0 }) {
  catchupStatus.set(session_id, { reason, sinceMs, attempt, state: 'na fila', queuedAt: Date.now() });
  catchupQueue = catchupQueue.then(async () => {
    const state = getSession(session_id);
    if (state.client !== client) return;
    const startedAt = Date.now();
    catchupStatus.set(session_id, { reason, sinceMs, attempt, state: 'rodando', startedAt });
    console.log(`[WPPConnect] Catch-up (${reason}) ${session_id}: desde ${new Date(sinceMs).toISOString()} (tentativa ${attempt + 1})`);
    let res;
    try {
      res = await runGapCatchup({
        session_id, client, sinceMs, opts,
        deps: {
          listChatsStable,
          resolveChatContext,
          mapHistoryMessage,
          filterMissing: (ids) => filterMissingWamids(session_id, ids),
          postSync: (messages) => axios.post(`${FASTAPI_URL}/api/webhook/bridge/sync`,
            { session_id, catchup: true, messages }, { timeout: 30000 }),
          healthCheck: backendHealthMs,
          isMediaType: (t) => MEDIA_TYPES.has(t),
          isStopped: () => getSession(session_id).client !== client,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
      });
    } catch (err) {
      res = { ok: false, aborted: true, reason: err.message, truncated: false };
    }
    catchupStatus.set(session_id, { reason, sinceMs, attempt, state: res.ok ? 'concluído' : 'incompleto', ...res });
    console.log(`[WPPConnect] Catch-up (${reason}) ${session_id}: ${res.ok ? 'concluído' : 'INCOMPLETO'} — ${res.chatsScanned || 0} conversas, ${res.messagesSent || 0} mensagens enviadas${res.reason ? `, motivo: ${res.reason}` : ''}${res.truncated ? ', truncado' : ''}`);

    if (!isConnect) return;
    if (res.ok) {
      watermarks.set(session_id, startedAt);
      state.catchupPending = false;
    } else if (attempt < CATCHUP_MAX_RETRIES && state.client === client) {
      const nextOpts = res.truncated
        ? { ...opts, maxChats: Math.min((opts.maxChats || 100) * 2, CATCHUP_MAX_CHATS_CAP), maxPages: (opts.maxPages || 10) + 5 }
        : opts;
      setTimeout(() => scheduleCatchup(session_id, client, { sinceMs, reason, opts: nextOpts, isConnect, attempt: attempt + 1 }), CATCHUP_RETRY_MS);
    } else {
      console.error(`[WPPConnect] Catch-up ${session_id} desistiu após ${attempt + 1} tentativas — marca d'água preservada, recuperar manualmente via POST /session/catchup.`);
    }
  }).catch((err) => {
    catchupStatus.set(session_id, { reason, sinceMs, attempt, state: 'erro', reason_error: err.message });
    console.error(`[WPPConnect] Catch-up ${session_id} erro inesperado: ${err.message}`);
  });
}

// ─── Inicializar sessão ───────────────────────────────────────

// BUG (2026-09-22, confirmado ao vivo — RMA-01 deslogada desde 15/09 com o
// Chrome gerando QR sem parar, tentativa 9900+): com autoClose: 0 a lib
// regenera o QR pra sempre, e quem abre a sessão no boot é o BridgeWatchdog
// (não um humano) — ninguém está olhando esse QR. Agora o QR só fica vivo
// enquanto alguém pediu de verdade (interactive=true, vindo do botão de QR
// em Configurações, que faz polling). Sem pedido recente, a sessão é
// "estacionada": fecha o Chrome e fica em qr_required até alguém clicar.
// Reconexão via token salvo (sem QR) continua funcionando pro watchdog.
const QR_IDLE_MS = 3 * 60 * 1000;

function qrWanted(state) {
  return !!state.qrRequestedAt && (Date.now() - state.qrRequestedAt) < QR_IDLE_MS;
}

function parkSession(session_id, state) {
  if (!state.parked) {
    console.log(`[WPPConnect] QR não solicitado para ${session_id} — sessão estacionada até alguém gerar o QR em Configurações.`);
  }
  state.parked    = true;
  state.status    = 'qr_required';
  state.qr        = null;
  state.qr_string = null;
  if (state.client) {
    const client = state.client;
    state.client = null;
    client.close().catch(() => {});
  } else {
    // create() ainda não resolveu — o .then() fecha assim que tiver o client.
    state.parkPending = true;
  }
}

async function startSession(session_id, { interactive = false } = {}) {
  const state = getSession(session_id);

  if (interactive) {
    state.qrRequestedAt = Date.now();
    state.parked        = false;
    state.parkPending   = false;
  } else if (state.parked) {
    return buildStatusResponse(session_id);
  }

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
  // primeiro (mesmo userDataDir), causando "browser already running".
  if (state.creating) {
    if (state.starting) {
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    return buildStatusResponse(session_id);
  }

  state.starting = true;
  state.creating = true;
  state.status   = 'idle';

  // Lida ANTES do create(): mensagens que chegarem depois do reconect não podem
  // empurrar a marca d'água pra frente enquanto o buraco não foi recuperado.
  state.catchupSince   = watermarks.get(session_id);
  state.catchupPending = state.catchupSince !== null;

  console.log(`[WPPConnect] Iniciando sessão: ${session_id}`);

  // IMPORTANTE: não fazer `await` no create() aqui. Em reconexões via token
  // salvo (sem precisar de QR novo), observamos que a promise do
  // wppconnect.create() nunca resolve mesmo com a sessão real já conectada
  // (WhatsApp Web carregado, mensagens fluindo) — provavelmente um bug da
  // lib nesse fluxo específico. Bloquear a requisição HTTP nisso travaria
  // o bridge inteiro pra essa sessão pra sempre. Em vez disso, disparamos e
  // confiamos nos callbacks (catchQR/statusFind) + na mensagem recebida
  // (mais abaixo) pra saber o status real, independente do create() resolver.
  let inChatWithoutQRTimer = null;

  wppconnect.create({
    session: session_id,

    catchQR: (base64Qrimg, asciiQR) => {
      // BUG (2026-09-22, confirmado ao vivo no deploy): ao restaurar via
      // token, o WhatsApp Web mostra um QR por um instante antes de logar —
      // estacionar no 1º QR derrubou a SAC-01, que estava válida. Só
      // estaciona depois de QR_IDLE_MS com QR contínuo e ninguém pedindo.
      if (!qrWanted(state)) {
        state.qrUnwantedSince = state.qrUnwantedSince || Date.now();
        if (Date.now() - state.qrUnwantedSince >= QR_IDLE_MS) {
          if (inChatWithoutQRTimer) {
            clearTimeout(inChatWithoutQRTimer);
            inChatWithoutQRTimer = null;
          }
          state.qrUnwantedSince = null;
          parkSession(session_id, state);
          return;
        }
      } else {
        state.qrUnwantedSince = null;
      }
      state.qr        = base64Qrimg;
      state.qr_string = asciiQR;
      state.status    = 'qr_required';
      if (inChatWithoutQRTimer) {
        clearTimeout(inChatWithoutQRTimer);
        inChatWithoutQRTimer = null;
      }
      console.log(`[WPPConnect] QR gerado para sessão: ${session_id}`);
    },

    statusFind: (statusSession) => {
      console.log(`[WPPConnect] Status [${session_id}]: ${statusSession}`);
      if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess') {
        state.qrUnwantedSince = null;
        state.status = 'authenticated';
        state.qr     = null;
      } else if (statusSession === 'notLogged' || statusSession === 'browserClose') {
        // Estacionada: o fechamento foi nosso (parkSession) — mantém
        // qr_required pro watchdog não reabrir a sessão.
        state.status = state.parked ? 'qr_required' : 'disconnected';
        if (state.client) state.client.close().catch(() => {}); // fecha o browser Puppeteer órfão antes de soltar a referência
        state.client = null;
      } else if (statusSession === 'inChat' && state.status !== 'authenticated') {
        // 'inChat' é ambíguo: dispara tanto na página recém-carregada (ANTES
        // do QR existir) quanto numa reconexão via token já autenticada.
        // Se depois de alguns segundos nenhum QR apareceu, é reconexão real.
        if (inChatWithoutQRTimer) clearTimeout(inChatWithoutQRTimer);
        inChatWithoutQRTimer = setTimeout(() => {
          if (state.status !== 'qr_required' && state.status !== 'authenticated') {
            state.status = 'authenticated';
            console.log(`[WPPConnect] Sessão confirmada autenticada via reconexão (sem QR): ${session_id}`);
          }
        }, 5000);
      }
    },

    folderNameToken:     SESSIONS_DIR,
    headless:            true,
    devtools:            false,
    useChrome:           true,
    debug:               false,
    logQR:               false,
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
    ],
    puppeteerOptions: CHROME_PATH ? { executablePath: CHROME_PATH } : {},
    autoClose:           0,
    createPathFileToken: true,
    waitForLogin:        false,
  }).then(async (client) => {
    state.creating = false;
    if (state.parkPending) {
      state.parkPending = false;
      client.close().catch(() => {});
      return;
    }
    state.client   = client;

    // Página do WhatsApp Web morta com o Chrome principal vivo (OOM do
    // renderer — incidentes 2026-09-24 FN-01 e 2026-09-28 POS-01) não muda o
    // status nem dispara 'browserClose': a sessão fica "authenticated" e muda.
    // Derruba o client pra o BridgeWatchdog do backend reabrir via token.
    startPageProbe({
      session_id, state, client,
      onOk: () => { if (!state.catchupPending) watermarks.bump(session_id, Date.now() - 2 * 60 * 1000); },
      onDead: (reason) => {
        if (state.client !== client) return;
        console.error(`[WPPConnect] Página morta em ${session_id} (${reason}) — derrubando a sessão pra reconectar.`);
        state.status = 'disconnected';
        state.client = null;
        const browserProc = client.page?.browser?.()?.process?.();
        client.close().catch(() => {});
        setTimeout(() => { try { browserProc?.kill('SIGKILL'); } catch (_) {} }, 10000);
      },
    });

    // Recupera o que aconteceu enquanto a sessão esteve fora (ver marca d'água).
    if (state.catchupPending) {
      setTimeout(() => {
        if (state.client === client) {
          scheduleCatchup(session_id, client, { sinceMs: state.catchupSince, reason: 'reconexão', isConnect: true });
        }
      }, CATCHUP_START_DELAY_MS);
    } else {
      watermarks.set(session_id, Date.now());
    }
    // Reconciliação leve periódica: cobre evento individual perdido com a sessão de pé.
    if (RECONCILE_INTERVAL_MS > 0) {
      const reconcileTimer = setInterval(() => {
        if (state.client !== client) { clearInterval(reconcileTimer); return; }
        if (state.catchupPending || backfillState.get(session_id)?.running) return;
        scheduleCatchup(session_id, client, {
          sinceMs: Date.now() - RECONCILE_WINDOW_MS, reason: 'reconciliação',
          opts: { maxChats: 25, maxPages: 2, pageDelayMs: 1000, chatDelayMs: 500 },
        });
      }, RECONCILE_INTERVAL_MS);
      if (reconcileTimer.unref) reconcileTimer.unref();
    }

    state.phone = await fetchSessionPhone(client);
    if (state.phone) {
      state.status = 'authenticated';
    }

    if (state.status === 'authenticated') {
      console.log(`[WPPConnect] Sessão autenticada: ${session_id} | Telefone: ${state.phone}`);
    }

    // client resolvido = sessão real e conectada, autenticada ou não no
    // nosso `state` ainda (ver bug do 'inChat' documentado acima) — sincroniza.
    // Com buraco a recuperar, o catch-up (abaixo) assume: o resync de histórico gravaria
    // as mensagens perdidas como LIDAS e as esconderia do atendente.
    if (!state.catchupPending) syncChatHistory(session_id, client).catch(() => {});
    // Backfill gradual e automático — padrão pra QUALQUER número conectado
    // (pedido do usuário 2026-09-02), não precisa chamar manualmente. Roda
    // bem mais devagar que um pedido manual e só entra em ação se a sessão
    // ainda não tiver sido totalmente backfillada antes (ver função).
    maybeAutoStartBackfill(session_id, client);

    // BUG anterior: onMessage() é documentado pela própria lib como "Listens
    // to all new messages received only" — mensagens que a própria conta
    // enviava nunca disparavam esse callback, então nunca eram espelhadas
    // pro FastAPI/banco/frontend (mesmo chegando de verdade no destinatário).
    // onAnyMessage() cobre "sent and received".
    client.onAnyMessage(async (message) => {
      // Receber qualquer mensagem é prova inequívoca de sessão autenticada.
      if (state.status !== 'authenticated') {
        state.status = 'authenticated';
        state.qr     = null;
        console.log(`[WPPConnect] Sessão confirmada autenticada via mensagem recebida: ${session_id}`);
      }
      // BUG anterior: esse retry de telefone só rodava dentro do `if` acima,
      // que só entra uma vez (na primeira mensagem após status != authenticated).
      // Se o getHostDevice() inicial (no .then() do create()) falhar/racear e
      // o status já tiver virado 'authenticated' por outro caminho (statusFind),
      // o telefone ficava null pra sempre — nenhuma mensagem seguinte tentava de novo.
      if (!state.phone) {
        state.phone = await fetchSessionPhone(client);
      }
      try {
        await forwardMessageToFastAPI(client, session_id, message);
      } catch (err) {
        console.error(`[WPPConnect] Erro ao encaminhar mensagem: ${err.message}`);
      }
    });

    // Eventos de sistema do grupo (entrar/sair/promover/trocar nome etc.) —
    // antes não tinha NENHUM listener pra isso, só o que a sincronização
    // inicial (syncChatHistory, rodada uma vez ao conectar) capturava por
    // acaso ficava visível; eventos ao vivo se perdiam.
    client.onNotificationMessage(async (notification) => {
      try {
        await forwardGroupNotification(session_id, notification);
      } catch (err) {
        console.error(`[WPPConnect] Erro ao encaminhar notificação de grupo: ${err.message}`);
      }
    });

    client.onAck(async (ack) => {
      await forwardStatusUpdate(session_id, ack).catch(() => {});
    });

    // ── Escuta reações ────────────────────────────────────────
    // BUG anterior: reagir/editar retornava {success:true} (a ação em si
    // funcionava no WhatsApp de verdade), mas nunca existia nenhum listener
    // pra ecoar de volta o evento e atualizar reaction_emoji/message_text no
    // nosso banco — front nunca mostrava a reação nem o texto editado.
    // onReactionMessage só traz {msgId, reactionText}, sem remetente/chat —
    // não dá pra resolver a conversa de verdade aqui, mas o backend já
    // escopa essa atualização por conta (account_id via session_id), então
    // from/to genéricos não atrapalham a atualização real.
    client.onReactionMessage(async (data) => {
      try {
        // BUG: msgId é um objeto ({fromMe, remote, id, _serialized}), não
        // string — confirmado ao vivo. Mandava o objeto inteiro, então a
        // busca por wamid no banco nunca batia com nada.
        const targetWamid = data.msgId?._serialized || data.msgId;
        await axios.post(`${FASTAPI_URL}/api/webhook/bridge`, {
          bridge_provider: 'wppconnect',
          session_id,
          wamid: `reaction_${Date.now()}`,
          direction: 'inbound',
          from: 'wppconnect-reaction',
          to: 'me',
          timestamp: Date.now(),
          type: 'reaction',
          reaction_message_id: targetWamid,
          reaction_emoji: data.reactionText || '',
        }, { timeout: 8000 });
      } catch (err) {
        console.warn(`[WPPConnect] Falha ao encaminhar reação: ${err.message}`);
      }
    });

    // ── Escuta votos de enquete ──────────────────────────────
    // Antes não existia nenhuma captura de voto pro wppconnect — o front não
    // tinha como mostrar a apuração. onPollResponse só traz o voto individual
    // (selectedOptions = opções escolhidas NESTE voto, já resolvidas com
    // nome via wa-js internamente); acumula em memória por enquete (pollId ->
    // {voterId: [opções]}) e reenvia a apuração agregada — mesmo formato que
    // Baileys e wa-web já usam. msgId aqui já é a key da mensagem de CRIAÇÃO
    // da enquete (wa-js resolve isso internamente), não do voto em si.
    client.onPollResponse(async (data) => {
      try {
        const pollId  = data.msgId?._serialized || data.msgId;
        const voterId = data.sender?._serialized || data.sender;
        if (!pollId || !voterId) return;

        if (!state.pollVotes) state.pollVotes = {};
        if (!state.pollVotes[pollId]) state.pollVotes[pollId] = {};
        // selectedOptions vem como array esparso (indexado por localId) —
        // filtra os buracos antes de extrair o nome da opção.
        state.pollVotes[pollId][voterId] = (data.selectedOptions || [])
          .filter(Boolean)
          .map(o => o.name);

        // Precisa do conjunto completo de opções (inclusive as com 0 votos)
        // pra apuração ficar igual à enquete real — busca a mensagem
        // original em vez de usar só as opções já votadas.
        let optionNames = [...new Set(Object.values(state.pollVotes[pollId]).flat())];
        try {
          const pollMsg = await client.getMessageById(pollId);
          if (pollMsg?.pollOptions?.length) {
            optionNames = pollMsg.pollOptions.map(o => o.name);
          }
        } catch (_) {}

        const tally = {};
        optionNames.forEach(name => { tally[name] = 0; });
        Object.values(state.pollVotes[pollId]).forEach(selected => {
          selected.forEach(name => { tally[name] = (tally[name] || 0) + 1; });
        });

        await axios.post(`${FASTAPI_URL}/api/webhook/bridge/poll-vote`, {
          session_id,
          poll_wamid: pollId,
          options: optionNames.map(name => ({ name, votes: tally[name] || 0 })),
          total_voters: Object.keys(state.pollVotes[pollId]).length,
        }, { timeout: 8000 });
      } catch (err) {
        console.warn(`[WPPConnect] Falha ao processar voto de enquete: ${err.message}`);
      }
    });

    // ── Escuta revogação (apagar-para-todos) feita pelo contato ──
    // Gap de paridade com o Baileys: /api/webhook/bridge/revoke já existe
    // e é genérico (escopado por account_id via session_id, igual a
    // /bridge/edit), mas nada aqui chamava — a lib expõe onRevokedMessage
    // (não usado antes), então mensagem apagada pelo contato continuava
    // aparecendo normal no nosso lado até agora.
    client.onRevokedMessage(async (data) => {
      try {
        const revokedWamid = data.refId?._serialized || data.refId || data.id?._serialized || data.id;
        if (!revokedWamid) return;
        await axios.post(`${FASTAPI_URL}/api/webhook/bridge/revoke`, {
          bridge_provider: 'wppconnect',
          session_id,
          revoked_wamid: revokedWamid,
        }, { timeout: 8000 });
      } catch (err) {
        console.warn(`[WPPConnect] Falha ao encaminhar revogação: ${err.message}`);
      }
    });

    // ── Escuta edições de mensagem ───────────────────────────
    client.onMessageEdit(async (data) => {
      try {
        const newText = data.msg?.body || data.msg?.content || '';
        if (!data.id || !newText) return;
        await axios.post(`${FASTAPI_URL}/api/webhook/bridge/edit`, {
          bridge_provider: 'wppconnect',
          session_id,
          wamid: data.id,
          new_text: newText,
        }, { timeout: 8000 });
      } catch (err) {
        console.warn(`[WPPConnect] Falha ao encaminhar edição: ${err.message}`);
      }
    });
  }).catch((err) => {
    state.creating = false;
    console.error(`[WPPConnect] Erro ao criar sessão ${session_id}: ${err.message}`);
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
// Diferente do venom-bot (que replica o backlog "de graça" pelo onMessage
// normal), essa lib não faz isso sozinha — buscamos explicitamente as
// últimas conversas + mensagens de cada uma e mandamos pro mesmo endpoint
// de sync que o Baileys usa.

// Resolve os metadados de um chat (nome de exibição real, se é grupo, jid
// telefônico quando a contraparte vem como @lid) — usado tanto pelo sync
// inicial (syncChatHistory) quanto pelo backfill gradual (runHistoryBackfill).
// Ver comentários originais em syncChatHistory sobre cada bug que motivou isso.
async function resolveChatContext(client, session_id, chat) {
  const rawJid = chat.id?._serialized;
  if (!rawJid) return null;
  const realName = chat.contact?.formattedName || chat.contact?.name || chat.name || undefined;
  const isGroup = chat.isGroup;
  const jid = isGroup ? rawJid : await resolveLidToPhone(client, session_id, rawJid);
  return { rawJid, realName, isGroup, jid, chat };
}

// Converte UMA mensagem bruta da lib (do getAllMessagesInChat OU do
// getMessages paginado — mesmo formato de objeto nos dois) no payload que
// /api/webhook/bridge/sync espera. Retorna null pra mensagem sem conteúdo
// (mesma checagem que syncChatHistory já fazia).
async function mapHistoryMessage(session_id, client, ctx, m, { skipMedia = false } = {}) {
  if (!m.body && !m.type) return null;
  const { rawJid, realName, isGroup, jid, chat } = ctx;
  let senderJid;
  if (isGroup) {
    senderJid = m.fromMe ? jid : await resolveLidToPhone(client, session_id, m.author || rawJid);
  } else {
    senderJid = jid;
  }
  // m.id nem sempre é utilizável (getAllMessagesInChat, deprecated, só tem
  // "rowId" interno — ver comentário original abaixo); getMessages paginado
  // (usado pelo backfill) costuma trazer o id real. Tenta as formas
  // conhecidas antes de cair no id determinístico (evita duplicar em resync).
  const realId = (typeof m.id === 'string' && m.id) ? m.id
    : (m.id && typeof m.id === 'object' && typeof m.id._serialized === 'string' && m.id._serialized) ? m.id._serialized
    : (m.id && typeof m.id === 'object' && typeof m.id.id === 'string' && m.id.id) ? m.id.id
    : null;
  const wamid = realId || historySyntheticId(jid, (m.t || 0) * 1000, m.fromMe, m.body);
  const payload = {
    session_id,
    wamid,
    from:         m.fromMe ? 'me' : String(senderJid).replace('@c.us', '').replace('@g.us', '').replace('@lid', ''),
    to:           m.fromMe ? String(jid).replace('@c.us', '').replace('@lid', '') : 'me',
    direction:    m.fromMe ? 'outbound' : 'inbound',
    type:         m.type || 'chat',
    timestamp:    (m.t || 0) * 1000,
    text:         m.body || '',
    contact_name: realName || '',
    push_name:    realName || '',
    is_group:     isGroup,
    group_jid:    isGroup ? rawJid : undefined,
    group_name:   isGroup ? (chat?.name || realName) : undefined,
    participant:  isGroup && !m.fromMe ? senderJid : undefined,
    _realId:      realId, // usado só pelo backfill pra saber onde paginar a próxima página
  };

  // Mídia de histórico: getAllMessagesInChat (usado por syncChatHistory) só
  // tem "rowId" interno, nunca deu pra baixar mídia antiga por isso (ver
  // comentário logo abaixo). getMessages (paginado, usado pelo backfill
  // gradual) traz o id REAL da mensagem — então agora dá, sim, pra tentar
  // baixar. Só tenta quando o id é de verdade (não o sintético — sem id real
  // não tem o que pedir pro WhatsApp) e o tipo é de mídia baixável.
  // downloadAndUploadMedia já tem retry/backoff próprio (ver definição) —
  // se falhar de vez, a mensagem entra só com o texto/placeholder mesmo,
  // igual já acontecia antes pra tudo.
  if (realId && MEDIA_TYPES.has(payload.type) && !skipMedia) {
    await downloadAndUploadMedia(client, { id: realId }, payload, realId);
  }

  return payload;
}

async function syncChatHistory(session_id, client, attempt = 1, prevCount = -1) {
  try {
    const chats = await client.listChats({ count: SYNC_MAX_CHATS });

    // Chats vazio (ou uma lista PARCIAL, ainda crescendo) logo após conectar/
    // reconectar quase sempre é o WhatsApp ainda baixando o histórico do
    // celular pro Store da página (o "inChat"/"Connected" só indica que a UI
    // carregou, não que o Store já foi populado) — não é "conta sem conversa
    // nenhuma" nem "conta só tem mesmo 5 conversas".
    // BUG anterior: só re-tentava com chats.length===0 — se o Store ainda
    // estivesse no meio do carregamento e listChats() devolvesse uma lista
    // PARCIAL (ex.: 5 de 69 conversas reais), o código aceitava esses 5 como
    // definitivos e nunca mais tentava de novo (confirmado ao vivo: mesma
    // conta que em reconexões anteriores sincronizou 50-60 conversas ficou
    // com só 5 numa reconexão em que o Store demorou mais pra popular). Agora
    // só aceita a lista quando ela PAROU de crescer entre duas tentativas
    // (ou o teto de tentativas foi atingido) — não só quando é !== 0.
    if (attempt < 6 && (chats.length === 0 || chats.length > prevCount)) {
      console.warn(`[WPPConnect] Lista de chats ainda crescendo (${prevCount}→${chats.length}, tentativa ${attempt}/6), tentando de novo em 5s: ${session_id}`);
      setTimeout(() => syncChatHistory(session_id, client, attempt + 1, chats.length), 5000);
      return;
    }

    const batch = [];

    for (const chat of chats) {
      const ctx = await resolveChatContext(client, session_id, chat);
      if (!ctx) continue;

      let messages = [];
      try {
        messages = await client.getAllMessagesInChat(ctx.rawJid, true, false);
      } catch (_) {
        continue; // chat sem histórico acessível — pula
      }

      const recent = messages.slice(-SYNC_MAX_PER_CHAT); // vem do mais antigo pro mais novo

      // client.getAllMessagesInChat() é deprecated na lib e o objeto que
      // devolve genuinamente NÃO tem o id real da mensagem (confirmado ao
      // vivo via dump: só tem "rowId" numérico interno, que não serve pro
      // WPP.chat.downloadMedia — por isso mídia de histórico nunca baixa,
      // só mensagens ao vivo (via onAnyMessage, que inclui o id de verdade).
      // getMessages() (usado pelo backfill gradual logo abaixo) não tem esse problema.
      for (const m of recent) {
        const mapped = await mapHistoryMessage(session_id, client, ctx, m);
        if (mapped) batch.push(mapped);
      }
    }

    if (batch.length) {
      // BUG anterior: payload não incluía session_id no nível raiz — só cada
      // mensagem do batch tinha. routes_bridge.py::receive_bridge_sync só lê
      // session_id da raiz (default "default"), então TODO resync de
      // histórico caía no fallback "primeira conta ativa" — misturava o
      // histórico de todas as contas WPPConnect na conta de menor id
      // (confirmado ao vivo: histórico da Pós Vendas indo pra conta do SAC).
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/sync`, { session_id, messages: batch }, { timeout: 30000 });
      console.log(`[WPPConnect] Sincronizadas ${batch.length} mensagens de ${chats.length} conversas`);
    } else {
      console.log(`[WPPConnect] Sincronização de histórico concluída sem mensagens (${chats.length} conversas, nenhuma com histórico acessível): ${session_id}`);
    }
  } catch (err) {
    // "WPP is not defined" = wa-js ainda não terminou de injetar na página
    // nesse exato momento (o client já resolveu, mas o WPP global do
    // WhatsApp Web ainda não existe) — condição de corrida transitória, não
    // um erro real. Tentar de novo com um intervalo resolve; sem isso, toda
    // sincronização de histórico falhava silenciosamente e a lista de
    // conversas ficava vazia até a primeira mensagem nova chegar.
    if (err.message?.includes('WPP is not defined') && attempt < 6) {
      console.warn(`[WPPConnect] Histórico ainda não pronto (tentativa ${attempt}/6), tentando de novo em 4s: ${session_id}`);
      setTimeout(() => syncChatHistory(session_id, client, attempt + 1), 4000);
      return;
    }
    console.error(`[WPPConnect] Erro ao sincronizar histórico: ${err.message}`);
  }
}

// ─── Backfill gradual de histórico completo ────────────────────
//
// Pedido do usuário 2026-09-02: trazer o histórico completo de cada número,
// parecido com o que a Evolution API (Baileys, syncFullHistory) consegue —
// mas SEM trocar de provider (WPPConnect tem risco de banimento menor na
// avaliação do usuário). syncChatHistory acima só pega os últimos
// SYNC_MAX_PER_CHAT (~100) por conversa, de uma vez, ao conectar.
//
// client.getMessages(chatId, {count, id, direction:'before'}) — método
// OFICIAL e documentado da lib pra paginação ("this works like pagination,
// so when you get an ID, you can use it to get the next messages from it")
// — deixa buscar página por página, cada vez mais pro passado, simulando
// alguém rolando a tela pra cima manualmente. Roda em background, devagar
// (delay entre páginas e entre conversas), sequencial (uma conversa por
// vez) — tanto pra não parecer scraping agressivo pro WhatsApp quanto pra
// não repetir o incidente de sobrecarregar o backend (563 webhooks em 4min
// só de resync — ver histórico do dia). Não é "histórico infinito de
// verdade": o teto real é até onde o próprio WhatsApp Web ainda guarda/
// permite acessar pra aquele chat, não importa quantas páginas peçamos.
const BACKFILL_PAGE_SIZE = 50;
const BACKFILL_DELAY_MS = 2500;       // entre páginas dentro da mesma conversa
const BACKFILL_CHAT_DELAY_MS = 4000;  // entre conversas
// Teto de paginas por conversa. 200 x 50 = ~10k msgs/conversa: na pratica "ate o
// fim real" (a paginacao para sozinha quando o WhatsApp nao devolve mais nada).
// O ritmo e protegido pelo portao de carga (history-gate), nao por um teto baixo.
const BACKFILL_DEFAULT_MAX_PAGES = parseInt(process.env.BACKFILL_MAX_PAGES_PER_CHAT || '200', 10);
const BACKFILL_MAX_CHATS = parseInt(process.env.BACKFILL_MAX_CHATS || '1000', 10);
// Erro ao mandar uma página pro backend é sinal de que ele pode estar sob
// carga (ver incidente 2026-09-02: resync em massa travou o backend por
// minutos) — pausa bem mais que o delay normal antes de insistir, em vez de
// martelar um serviço já sofrendo.
const BACKFILL_BACKOFF_ON_BACKEND_FAILURE_MS = 30000;

// Pedido do usuário 2026-09-02: isso deve virar padrão automático pra
// QUALQUER número conectado, rodando de fundo, sem precisar chamar
// /session/backfill/start manualmente — mas sem atrapalhar o uso normal do
// app. Por isso o preset automático é BEM mais devagar que o default usado
// quando alguém pede um backfill manual explicitamente.
const BACKFILL_AUTO_START_DELAY_MS = 90000; // espera a conexão estabilizar (Chrome/sync inicial) antes de começar
const BACKFILL_AUTO_PAGE_DELAY_MS = 6000;
const BACKFILL_AUTO_CHAT_DELAY_MS = 12000;

// Progresso persistido em disco (sobrevive a restart do bridge — sem isso,
// cada deploy reiniciaria o backfill do zero pra TODAS as contas, gerando
// carga repetida à toa). Estrutura:
// { [session_id]: { sessionDone: bool, chatsDone: { [jid]: true }, lastRunAt } }
const BACKFILL_PROGRESS_FILE = path.join(__dirname, 'backfill_progress.json');

function loadBackfillProgress() {
  try {
    return JSON.parse(fs.readFileSync(BACKFILL_PROGRESS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveBackfillProgress(progress) {
  try {
    fs.writeFileSync(BACKFILL_PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (err) {
    console.warn(`[WPPConnect] Falha ao salvar progresso do backfill: ${err.message}`);
  }
}

const backfillState = new Map(); // session_id -> estado (ver initBackfillState)

function initBackfillState(session_id) {
  const state = {
    running: true,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    chatsTotal: 0,
    chatsDone: 0,
    currentChat: null,
    messagesImported: 0,
    error: null,
  };
  backfillState.set(session_id, state);
  return state;
}

async function runHistoryBackfill(session_id, client, opts = {}) {
  const pageSize = opts.page_size || BACKFILL_PAGE_SIZE;
  const maxPagesPerChat = opts.max_pages_per_chat || BACKFILL_DEFAULT_MAX_PAGES;
  const maxChats = opts.max_chats || BACKFILL_MAX_CHATS;
  const pageDelayMs = opts.page_delay_ms || BACKFILL_DELAY_MS;
  const chatDelayMs = opts.chat_delay_ms || BACKFILL_CHAT_DELAY_MS;
  // persistProgress=true (modo automático) pula chat já concluído em runs
  // anteriores (sobrevive a restart do bridge) e marca cada um como feito
  // assim que termina — permite rodar de novo a cada reconexão sem repetir
  // trabalho nem gerar carga à toa pros chats que já chegaram no teto/fim.
  const persistProgress = !!opts.persist_progress;

  const state = initBackfillState(session_id);
  console.log(`[WPPConnect] Backfill de histórico iniciado (session=${session_id}, maxChats=${maxChats}, maxPagesPerChat=${maxPagesPerChat}, pageSize=${pageSize}, automático=${persistProgress})`);

  const progress = persistProgress ? loadBackfillProgress() : {};
  if (persistProgress && !progress[session_id]) {
    progress[session_id] = { sessionDone: false, chatsDone: {}, lastRunAt: null };
  }
  const sessionProgress = progress[session_id];

  try {
    const chats = await client.listChats({ count: maxChats });
    // status@broadcast não é uma conversa de verdade (Stories) — sem
    // histórico útil de "conversa" pra recuperar, só ruído.
    let realChats = chats.filter(c => c.id?._serialized && c.id._serialized !== 'status@broadcast');
    if (persistProgress) {
      realChats = realChats.filter(c => !sessionProgress.chatsDone[c.id._serialized]);
    }
    state.chatsTotal = realChats.length;

    for (const chat of realChats) {
      if (state.stopRequested) break;
      const ctx = await resolveChatContext(client, session_id, chat);
      if (!ctx) { state.chatsDone++; continue; }
      state.currentChat = ctx.jid;

      let chatAborted = false; // gate/backend falhou: nao marca a conversa como concluida
      let cursorId; // undefined na 1ª página = pega as mais recentes
      let reachedRealEnd = false;
      for (let page = 0; page < maxPagesPerChat; page++) {
        if (state.stopRequested) break;
        let msgs = [];
        try {
          msgs = await client.getMessages(ctx.rawJid, {
            count: pageSize,
            ...(cursorId ? { id: cursorId, direction: 'before' } : {}),
          });
        } catch (err) {
          console.warn(`[WPPConnect] Backfill: falha ao paginar ${ctx.jid} (página ${page}): ${describeMediaError(err)}`);
          break;
        }
        if (!msgs?.length) { reachedRealEnd = true; break; } // chegou no início real do histórico desse chat

        const batch = [];
        for (const m of msgs) {
          const mapped = await mapHistoryMessage(session_id, client, ctx, m);
          if (mapped) batch.push(mapped);
        }
        // Portao de carga: espera o backend ter folga (trafego ao vivo tem
        // prioridade), envia em pedacos e so segue se TODOS foram aceitos. Falha
        // aqui NAO avanca o cursor — a conversa fica pendente pra proxima rodada
        // (antes, a pagina era perdida e o cursor seguia).
        let backendFailed = false;
        if (batch.length) {
          const res = await postHistoryBatch(FASTAPI_URL, { session_id, messages: batch }, {
            log: (m) => console.log(`[WPPConnect] Backfill ${ctx.jid}: ${m}`),
          });
          state.messagesImported += res.sent;
          if (!res.ok) {
            backendFailed = true;
            chatAborted = true;
            console.warn(`[WPPConnect] Backfill: ${ctx.jid} interrompido na pagina ${page} (${res.reason}) — fica pendente pra proxima rodada`);
            break;
          }
        }

        // Próxima página parte da mensagem mais ANTIGA desta (msgs vem do
        // mais antigo pro mais novo, igual getAllMessagesInChat).
        const oldest = msgs[0];
        const oldestRealId = (typeof oldest.id === 'string' && oldest.id) ? oldest.id
          : (oldest.id?._serialized) ? oldest.id._serialized
          : (oldest.id?.id) ? oldest.id.id
          : null;
        if (!oldestRealId || oldestRealId === cursorId) { reachedRealEnd = true; break; } // sem id novo pra paginar, evita loop infinito
        cursorId = oldestRealId;

        if (msgs.length < pageSize) { reachedRealEnd = true; break; } // página incompleta = fim do histórico

        // Backend com problema = sinal de possível sobrecarga (ver comentário
        // na constante) — pausa bem mais longo em vez do delay normal.
        await new Promise(r => setTimeout(r, backendFailed ? BACKFILL_BACKOFF_ON_BACKEND_FAILURE_MS : pageDelayMs));
      }

      state.chatsDone++;
      if (persistProgress && !chatAborted) {
        // Marca feito tanto no fim real do histórico quanto no teto de
        // páginas — "até o limite" é o próprio critério pedido; não fica
        // reprocessando esse chat pra sempre a cada reconexão.
        sessionProgress.chatsDone[ctx.rawJid] = true;
        sessionProgress.lastRunAt = new Date().toISOString();
        saveBackfillProgress(progress);
      }
      void reachedRealEnd; // só documental por ora — sem distinção de tratamento hoje
      await new Promise(r => setTimeout(r, chatDelayMs));
    }

    if (persistProgress && !state.stopRequested) {
      const stillPending = (await client.listChats({ count: maxChats }))
        .filter(c => c.id?._serialized && c.id._serialized !== 'status@broadcast')
        .some(c => !sessionProgress.chatsDone[c.id._serialized]);
      if (!stillPending) {
        sessionProgress.sessionDone = true;
        saveBackfillProgress(progress);
        console.log(`[WPPConnect] Backfill automático: sessão ${session_id} concluída (todas as conversas atingiram o fim do histórico ou o teto de páginas).`);
      }
    }
  } catch (err) {
    state.error = describeMediaError(err);
    console.error(`[WPPConnect] Backfill: erro fatal (session=${session_id}): ${state.error}`);
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    console.log(`[WPPConnect] Backfill concluído (session=${session_id}): ${state.chatsDone}/${state.chatsTotal} conversas, ${state.messagesImported} mensagens${state.stopRequested ? ' (interrompido manualmente)' : ''}`);
  }
}

// Fila global — serializa os backfills automáticos de TODAS as sessões
// desse bridge, um de cada vez. Sem isso, se SAC-01/POS-01/RMA-01
// reconectarem juntas (ex.: depois de um restart do bridge), os 3
// backfills rodariam em paralelo, triplicando a carga sobre o backend bem
// na hora em que ele já está absorvendo o resync inicial de todas — o
// oposto do "não atrapalhar a produção" pedido. Prioriza terminar uma
// conta de cada vez em vez de ir mais rápido.
let backfillQueue = Promise.resolve();
function queueAutoBackfill(fn) {
  backfillQueue = backfillQueue.then(fn, fn);
  return backfillQueue;
}

// ─── Backfill automático (padrão pra qualquer número conectado) ─
// Chamado uma vez por sessão logo após conectar (ver chamada perto de
// syncChatHistory na criação do client). Só entra em ação se essa sessão
// ainda não tiver sido marcada como concluída no progresso persistido —
// caso contrário é um no-op rápido, então é seguro chamar em toda
// reconexão sem custo perceptível.
// Incidente real (2026-09-02): mesmo com o ritmo conservador, o backfill
// automático rodando ao mesmo tempo que tráfego real de usuário coincidiu
// com o backend travando de novo (ClientDisconnect em /bridge/sync,
// health-check sem resposta) — a mesma classe de problema do incidente
// anterior deste dia. Pausado por padrão até existir uma checagem de saúde
// do backend ANTES de cada página (backoff de verdade quando ele estiver
// sob carga, não só um delay fixo). Ligar de novo via
// BACKFILL_AUTO_ENABLED=true no ecosystem.config.cjs quando essa proteção
// existir. O endpoint manual (/session/backfill/start) continua disponível
// — ele é acionado por pedido explícito, sob supervisão, não de fundo.
// Ligado por padrao agora que existe o portao de carga (history-gate) — era o
// que faltava segundo o incidente acima. Desligar com BACKFILL_AUTO_ENABLED=false.
const BACKFILL_AUTO_ENABLED = process.env.BACKFILL_AUTO_ENABLED !== 'false';

function maybeAutoStartBackfill(session_id, client) {
  if (!BACKFILL_AUTO_ENABLED) return;
  const progress = loadBackfillProgress();
  if (progress[session_id]?.sessionDone) {
    console.log(`[WPPConnect] Backfill automático: sessão ${session_id} já concluída anteriormente — nada a fazer.`);
    return;
  }
  if (backfillState.get(session_id)?.running) return; // já rodando (ex.: alguém disparou manual antes)

  console.log(`[WPPConnect] Backfill automático agendado pra sessão ${session_id} — inicia em ${BACKFILL_AUTO_START_DELAY_MS / 1000}s (deixa a conexão estabilizar antes), entra na fila global (uma conta por vez).`);
  setTimeout(() => {
    queueAutoBackfill(() => {
      // sessão pode ter caído nesse meio tempo (ou entre o agendamento e sua
      // vez na fila) — só roda se o client ainda for o mesmo/válido.
      const state = getSession(session_id);
      if (state.client !== client || state.status !== 'authenticated') {
        console.log(`[WPPConnect] Backfill automático: sessão ${session_id} não está mais autenticada com o mesmo client — cancelado.`);
        return Promise.resolve();
      }
      return runHistoryBackfill(session_id, client, {
        persist_progress: true,
        page_delay_ms: BACKFILL_AUTO_PAGE_DELAY_MS,
        chat_delay_ms: BACKFILL_AUTO_CHAT_DELAY_MS,
      }).catch(err => console.error(`[WPPConnect] Backfill automático falhou (session=${session_id}): ${describeMediaError(err)}`));
    });
  }, BACKFILL_AUTO_START_DELAY_MS);
}

// ─── Encaminhar ao FastAPI ────────────────────────────────────

// Tipos que carregam mídia baixável — "ptt" (voz) é distinto de "audio" na
// nomenclatura da lib (ver MessageType enum), os dois precisam de download.
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

// Usado só quando a data URI retornada por downloadMedia vem com o mimetype
// vazio ("data:;base64,...") — voz gravada no app quase sempre é ogg/opus.
const FALLBACK_MIME_BY_TYPE = {
  audio: 'audio/ogg; codecs=opus',
  ptt: 'audio/ogg; codecs=opus',
  image: 'image/jpeg',
  video: 'video/mp4',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

// BUG anterior: mensagens de mídia recebidas nunca eram baixadas — o front
// não tinha NENHUMA URL pra exibir imagem/vídeo/áudio/documento recebido
// (media_url sempre ficava null no banco). client.downloadMedia() não passa
// pelo WPP.chat.find()/getChatById() (mesma função usada por baileys-bridge:
// baixa, sobe pro mesmo endpoint /api/media/bridge-upload, popula media_url).
// Descreve o erro de forma legível mesmo quando não é um Error de verdade —
// client.downloadMedia() (Puppeteer/CDP por baixo) às vezes rejeita com um
// objeto puro ou uma string curta, e `${e.message}` virava só "Object"/"t"
// nos logs, escondendo a causa real (timeout, contexto destruído, etc.).
function describeMediaError(e) {
  if (e?.message) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// client.downloadMedia() é uma chamada Puppeteer/CDP pra dentro da página do
// WhatsApp Web — se a página travar/ficar presa numa navegação, essa promise
// pode nunca resolver NEM rejeitar, ficando pendurada pra sempre (o retry
// abaixo só dispara em REJEIÇÃO, não em travamento). Suspeito não confirmado
// de um hang real durante backfill grande (ver memória do incidente de
// 2026-09/09-03) — nenhuma outra chamada no bridge tinha esse buraco, só
// essa. `Promise.race` força uma rejeição depois de MEDIA_DOWNLOAD_TIMEOUT_MS,
// o que já é o suficiente pro retry existente (linha ~1023) fazer o resto.
const MEDIA_DOWNLOAD_TIMEOUT_MS = 25000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Incidente real (2026-09-02): áudios chegavam sem NENHUMA mídia — só o
// texto "[Áudio]" — porque essa função falhava (timeout, "Execution
// context was destroyed" por navegação da página nesse meio-tempo, etc.)
// e desistia na primeira tentativa, sem nenhum retry. A mensagem já tinha
// sido salva no banco a essa altura (ver forwardMessageToFastAPI), então
// uma falha aqui é permanente — não tem re-tentativa manual como a do
// webhook de entrega. Só resta tentar de novo aqui mesmo, com backoff.
async function downloadAndUploadMedia(client, message, payload, wamid, attempt = 1) {
  if (!MEDIA_TYPES.has(payload.type)) return;
  const MAX_ATTEMPTS = 3;
  try {
    // Usa o wamid já extraído (string plana) em vez de message.id bruto —
    // passar o objeto bruto da lib (quando message.id não é string) é
    // provavelmente a causa do "Cannot read properties of undefined
    // (reading 'id')" visto ao vivo: downloadMedia espera o id serializado.
    const dataUri = await withTimeout(client.downloadMedia(wamid), MEDIA_DOWNLOAD_TIMEOUT_MS, 'downloadMedia');
    if (!dataUri) throw new Error('downloadMedia retornou vazio');
    // blobToBase64 (wa-js, por baixo do client.downloadMedia) monta a data URI
    // via FileReader.readAsDataURL. Duas pegadinhas confirmadas ao vivo:
    // 1) mimetype vazio quando o Blob não carrega um `type` — data:;base64,...
    // 2) mimetype COM parmetro (RFC 2397) — voz sempre vem como
    //    "data:audio/ogg; codecs=opus;base64,..." — o `;` do "codecs=opus" faz
    //    parte do mediatype, não separa ele do "base64,". `[^;]*` (só até o
    //    1º `;`) cortava o regex bem no meio disso e rejeitava TODO áudio.
    // `.*` guloso resolve os dois: casa o resto da string, credo então
    // retrocede até achar o ÚLTIMO ";base64," — que é sempre o separador de
    // verdade, não importa quantos `;param=valor` o mediatype tenha antes.
    const match = /^data:(.*);base64,(.+)$/.exec(dataUri);
    if (!match) {
      // Log truncado (nunca o base64 inteiro) só pra diagnosticar se ainda
      // assim vier num formato totalmente diferente do esperado.
      throw new Error(`downloadMedia retornou um data URI em formato inesperado: "${String(dataUri).slice(0, 60)}"`);
    }
    const mimeType = match[1] || FALLBACK_MIME_BY_TYPE[payload.type] || 'application/octet-stream';
    const buffer   = Buffer.from(match[2], 'base64');
    const safeId   = String(message.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const params   = new URLSearchParams({ media_id: safeId, mime_type: mimeType });

    const res = await axios.post(`${FASTAPI_URL}/api/media/bridge-upload?${params}`, buffer, {
      headers: { 'Content-Type': mimeType },
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    if (res.data?.media_url) {
      payload.media_url = res.data.media_url;
      payload.mimetype  = res.data.mime_type || mimeType;
      payload.media_id  = safeId;
    } else {
      throw new Error('bridge-upload não retornou media_url');
    }
  } catch (e) {
    const msg = describeMediaError(e);
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = 3000 * attempt;
      console.warn(`[WPPConnect] Falha ao baixar/enviar mídia (tentativa ${attempt}/${MAX_ATTEMPTS}, retry em ${delayMs}ms): ${msg}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return downloadAndUploadMedia(client, message, payload, wamid, attempt + 1);
    }
    console.warn(`[WPPConnect] Falha ao baixar/enviar mídia definitivamente após ${MAX_ATTEMPTS} tentativas: ${msg}`);
  }
}

async function forwardMessageToFastAPI(client, session_id, message) {
  // BUGs anteriores:
  // 1) mandava "message_id", mas o backend (_normalize_message em
  //    routes_bridge.py) só lê o campo "wamid" — toda mensagem caía no
  //    fallback fixo `bridge_{session_id}`, o MESMO id pra sessão inteira,
  //    e o webhook_handler deduplica por wamid → cada mensagem nova
  //    sobrescrevia a linha da anterior no banco (só a última "sobrevivia",
  //    daí "aparece só uma mensagem" na conversa).
  // 2) não mandava "direction"/"to" — outbound (fromMe) precisa from="me"
  //    e to=<contraparte> pro webhook_handler resolver a conversa certa.
  // 3) timestamp em segundos sem *1000 — backend espera ms e divide por
  //    1000, gerando datas erradas (próximas de 1970).
  // BUG anterior: quando a contraparte é identificada por LID (comum em
  // mensagens recebidas), essa string @lid ia direto pro banco como se
  // fosse o wa_id do contato — criando um segundo contato "fantasma"
  // (ex.: "Contato @lid") diferente do contato real (pelo telefone), e a
  // conversa se partia em duas. Resolve pro telefone antes de montar o payload.
  //
  // BUG anterior (grupos): mensagens de grupo eram descartadas antes de
  // chegar aqui (`if (message.isGroupMsg) return`) — nenhuma mensagem nem
  // notificação de grupo era sincronizada. Segue o mesmo contrato do
  // baileys-bridge: from/to usam o JID do GRUPO (não do participante), e
  // "participant" carrega quem enviou de fato (só em mensagens recebidas).
  const isGroup  = !!message.isGroupMsg;
  const groupJid = isGroup ? (typeof message.chatId === 'object' ? message.chatId._serialized : message.chatId) : null;

  let from, to, participant;
  if (isGroup) {
    participant = message.fromMe ? undefined : await resolveLidToPhone(client, session_id, message.author || '');
    from = message.fromMe ? 'me' : (participant || '').replace('@c.us', '').replace('@lid', '');
    to   = message.fromMe ? (groupJid || '').split('@')[0] : 'me';
  } else {
    const rawCounterpart = (message.fromMe ? message.to : message.from) || '';
    const counterpart = await resolveLidToPhone(client, session_id, rawCounterpart);
    from = message.fromMe ? 'me' : counterpart.replace('@c.us', '');
    to   = message.fromMe ? counterpart.replace('@c.us', '') : 'me';

    // Status/Stories (chatId 'status@broadcast'): igual num grupo, quem
    // aparece em "from" é um container genérico, não quem postou de fato —
    // message.author traz o autor real. Sem isso, todo Status cai anônimo
    // dentro do contato genérico status@broadcast (participant undefined),
    // e o backend não consegue atribuir cada Status a quem postou.
    if (rawCounterpart === 'status@broadcast' && !message.fromMe && message.author) {
      participant = await resolveLidToPhone(client, session_id, message.author);
    }
  }

  // BUG anterior: group_name nunca era mandado aqui (só na sincronização
  // inicial via syncChatHistory) — toda mensagem de grupo ao vivo caía no
  // fallback "Grupo XXXXXX" do webhook_handler, que SOBRESCREVIA o nome real
  // salvo no sync a cada nova mensagem. `message.chat.name` (deprecated na
  // lib, mas presente e populado de verdade no objeto bruto) traz o subject
  // do grupo sem precisar de lookup assíncrono extra.
  const groupName = isGroup ? (message.chat?.name || undefined) : undefined;
  const wamid = extractMessageId(message.id);

  const payload = {
    bridge_provider: 'wppconnect',
    session_id,
    wamid,
    direction:  message.fromMe ? 'outbound' : 'inbound',
    from,
    to,
    is_group:   isGroup,
    group_jid:  isGroup ? groupJid : undefined,
    group_name: groupName,
    participant,
    timestamp:  (message.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    type:       message.type || 'chat',
    pushName:   message.sender?.pushname || '',
    text:       message.body || '',
    caption:    message.caption || '',
    mimetype:   message.mimetype || '',
    filename:   message.filename || '',
    // BUG anterior: nunca era mandado — nenhuma resposta/citação chegava ao
    // front (que já tem a UI pronta pra isso, só faltava o dado). Diferente
    // de whatsapp-web.js, wppconnect expõe isso direto no objeto da
    // mensagem, sem precisar de lookup assíncrono.
    reply_to_wamid: message.quotedMsgId || undefined,
  };

  // Contato compartilhado (vCard) — nunca era mandado, então o backend
  // sempre caía no fallback "Contato" sem nome nem telefone
  // (vcard/vcard_name chegavam vazios em _format_contact_card_text). Nesta
  // lib o vCard bruto vem em message.body quando type é "vcard"/"multi_vcard",
  // e vcardFormattedName traz o nome do contato como campo síncrono à parte.
  if (message.type === 'vcard' || message.type === 'multi_vcard') {
    payload.vcard = message.body || '';
    payload.vcard_name = message.vcardFormattedName || '';
    // multi_vcard: message.body vem vazio e os contatos ficam em vcardList
    // ([{displayName, vcard}]) — sem isso o cartão chegava como "Contato" vazio.
    if (message.type === 'multi_vcard' && Array.isArray(message.vcardList)) {
      payload.vcards = message.vcardList.map(v => (
        typeof v === 'string'
          ? { vcard: v, name: '' }
          : { vcard: v?.vcard || '', name: v?.displayName || v?.formattedName || '' }
      ));
    }
  }

  // Enquete — pollName/pollOptions não estão documentados nos tipos da lib,
  // mas existem de verdade no objeto (confirmado via log ao vivo). Sem
  // isso o front só mostrava "Mensagem" genérico em vez das opções reais.
  if (message.pollName) {
    payload.interactive_payload = {
      type: 'poll',
      question: message.pollName,
      options: (message.pollOptions || []).map(o => o.name || o),
    };
  }

  // Localização — lat/lng/loc não documentados nos tipos da lib. Existem no
  // objeto pra mensagens REALMENTE recebidas (confirmado ao vivo), mas pra
  // mensagens que NÓS enviamos o eco vem com "loc":"" vazio e sem lat/lng
  // nenhum — usa o que a gente mesmo mandou (pendingOutboundLocation) nesse caso.
  if (message.type === 'location') {
    if (message.lat || message.lng) {
      payload.location = { latitude: message.lat, longitude: message.lng, name: message.loc || '' };
    } else if (message.fromMe) {
      const st = getSession(session_id);
      if (st.pendingOutboundLocation && Date.now() - st.pendingOutboundLocation.ts < 15000) {
        const { lat, lng, name } = st.pendingOutboundLocation;
        payload.location = { latitude: lat, longitude: lng, name: name || '' };
      }
      st.pendingOutboundLocation = null;
    }
  }

  // BUG anterior: só baixava mídia recebida (fromMe=false). Mensagens
  // ENVIADAS por nós (imagem/vídeo/áudio/documento) chegavam de verdade no
  // destinatário mas nunca ganhavam media_url — o front só mostrava
  // "[Imagem]"/"[Áudio]" genérico. Baixa dos dois lados agora.
  await downloadAndUploadMedia(client, message, payload, wamid);

  try {
    await postWebhookWithRetry(`${FASTAPI_URL}/api/webhook/bridge`, payload);
  } catch (err) {
    // postWebhookWithRetry já tentou N vezes e já gravou em
    // failed_webhooks.jsonl. Última tentativa: registra um placeholder
    // visível na conversa (ícone "!" vermelho, retry manual pelo agente no
    // front) em vez da mensagem simplesmente sumir sem ninguém perceber.
    try {
      await axios.post(`${FASTAPI_URL}/api/webhook/bridge/register-failed`, payload, {
        timeout: 8000,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (registerErr) {
      console.error(`[WPPConnect] Também falhou ao registrar placeholder de falha: ${registerErr.message}`);
    }
    throw err;
  }

  noteLiveDelivered(session_id, payload);
  if (payload.type === 'ciphertext') trackCiphertext(session_id, wamid);
  console.log(`[WPPConnect] Mensagem encaminhada: ${payload.from} → ${payload.type}`);
}

// BUG (2026-09-04, confirmado ao vivo — todo status de conta WPPConnect
// travado em "enviado", nunca progredia): dois problemas nesta função.
// 1. `ack.id?.id` manda só o pedaço curto do id (ex: "3EB089A3...") — o
//    wamid salvo no banco é o `_serialized` completo (ex:
//    "true_...@lid_3EB089A3..._out", ver extractMessageId acima). A busca
//    por wamid exato no backend NUNCA encontrava a mensagem, e o status
//    era descartado silenciosamente ("Mensagem X não encontrada no banco").
// 2. `status: ack.ack` manda o código numérico cru da lib (Chat.Ack: 1 =
//    enviado ao servidor, 2 = entregue, 3 = lida, 4 = reproduzida) — o
//    backend nesse endpoint só sabia interpretar o formato de "receipts"
//    do Baileys (readTimestamp/playedTimestamp), então esse número nunca
//    virava um status de verdade. Traduz aqui pro que o backend entende.
function ackToStatus(ackCode) {
  if (ackCode >= 3) return 'read';       // 3 = lida, 4 = reproduzida (áudio/vídeo) — WhatsApp mostra azul/preto pros dois
  if (ackCode === 2) return 'delivered';
  return null; // 1 (enviado ao servidor) ou menos — mensagem já nasce "sent" no banco, nada novo pra reportar
}

async function forwardStatusUpdate(session_id, ack) {
  const status = ackToStatus(ack.ack);
  if (!status) return;
  const messageId = (typeof ack.id === 'string' && ack.id)
    ? ack.id
    : (ack.id?._serialized || ack.id?.id);
  if (!messageId) return;
  await postWebhookWithRetry(`${FASTAPI_URL}/api/webhook/bridge/status`, {
    bridge_provider: 'wppconnect',
    session_id,
    message_id: messageId,
    status,
  }, { timeout: 5000, retries: 3 }).catch(() => {});
}

// Formato exato do objeto de notificação não é bem documentado pela lib —
// construção defensiva com fallback pra JSON bruto em vez de quebrar.
function describeGroupNotification(n) {
  const type = n?.type || n?.subtype || 'unknown';
  const who  = (n?.recipients || n?.author ? [].concat(n.recipients || n.author) : [])
    .map(j => String(j).split('@')[0]).join(', ');
  switch (type) {
    case 'add':      return `${who || 'Participante'} entrou no grupo`;
    case 'remove':    return `${who || 'Participante'} foi removido do grupo`;
    case 'leave':    return `${who || 'Participante'} saiu do grupo`;
    case 'promote':  return `${who || 'Participante'} agora é admin`;
    case 'demote':   return `${who || 'Participante'} deixou de ser admin`;
    case 'subject':  return `Nome do grupo alterado${n?.body ? ` para "${n.body}"` : ''}`;
    case 'desc':     return 'Descrição do grupo alterada';
    default:         return `Evento de grupo: ${type}`;
  }
}

async function forwardGroupNotification(session_id, notification) {
  const group_jid = notification?.chatId?._serialized || notification?.chatId || notification?.id?.remote;
  if (!group_jid) return;
  await postWebhookWithRetry(`${FASTAPI_URL}/api/webhook/bridge/group-notification`, {
    session_id,
    group_jid,
    text: describeGroupNotification(notification),
    timestamp: Date.now(),
  }, { retries: 3 }).catch((err) => {
    console.warn(`[WPPConnect] Falha ao notificar evento de grupo: ${err.message}`);
  });
}

// ─── App Express ──────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Proteção Bearer opcional ────────────────────────────────
if (SECRET_KEY) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${SECRET_KEY}`) {
      return res.status(401).json({ success: false, error: 'Token inválido' });
    }
    next();
  });
  console.log('[WPPConnect Bridge] Proteção Bearer ativada (WPPCONNECT_SECRET_KEY definido)');
}

// ── Health ────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    service:  'wppconnect-bridge',
    port:     PORT,
    sessions: sessions.size,
    ok:       true,
  });
});

// ── POST /session/init ────────────────────────────────────────
app.post('/session/init', async (req, res) => {
  // interactive=true só vem do botão de QR em Configurações (ver
  // parkSession) — o watchdog chama sem, e aí nunca deixa um QR vivo.
  const { session_id = 'default', interactive = false } = req.body;
  try {
    const result = await startSession(session_id, { interactive: !!interactive });
    res.json(result);
  } catch (err) {
    console.error(`[WPPConnect] /session/init erro: ${err.message}`);
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

// ── POST /session/resync-history ────────────────────────────────
// Re-dispara a sincronização de histórico manualmente numa sessão já
// conectada — útil quando a sincronização automática (ao conectar) falhou
// silenciosamente ou pegou o Store ainda vazio antes do retry existir.
app.post('/session/resync-history', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const client = requireClient(session_id);
    syncChatHistory(session_id, client);
    res.json({ success: true, message: 'Sincronização de histórico disparada — acompanhe os logs.' });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// ── POST /session/backfill/start ────────────────────────────────
// Backfill gradual de histórico completo (ver runHistoryBackfill acima) —
// roda em background, não bloqueia a resposta HTTP. Body opcional:
// { max_chats, max_pages_per_chat, page_size }.
app.post('/session/backfill/start', async (req, res) => {
  const { session_id = 'default', max_chats, max_pages_per_chat, page_size } = req.body || {};
  try {
    const client = requireClient(session_id);
    const existing = backfillState.get(session_id);
    if (existing?.running) {
      return res.status(409).json({ success: false, error: 'Já existe um backfill em andamento pra essa sessão.', state: existing });
    }
    runHistoryBackfill(session_id, client, {
      max_chats: max_chats ? parseInt(max_chats, 10) : undefined,
      max_pages_per_chat: max_pages_per_chat ? parseInt(max_pages_per_chat, 10) : undefined,
      page_size: page_size ? parseInt(page_size, 10) : undefined,
    }); // fire-and-forget — acompanhar via GET /session/backfill/status
    res.json({ success: true, message: 'Backfill iniciado — acompanhe via GET /session/backfill/status' });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// ── GET /session/backfill/status ────────────────────────────────
// ── POST /session/catchup ───────────────────────────────────────
// Recuperação manual de um buraco conhecido. Body: { session_id, since (ISO ou ms),
// max_chats?, max_pages? }. Acompanhar em GET /session/catchup/status.
app.post('/session/catchup', (req, res) => {
  const { session_id = 'default', since, max_chats, max_pages } = req.body || {};
  const sinceMs = typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(sinceMs)) return res.status(400).json({ success: false, error: 'since inválido (ISO ou ms)' });
  try {
    const client = requireClient(session_id);
    if (catchupStatus.get(session_id)?.state === 'rodando') {
      return res.status(409).json({ success: false, error: 'Já há uma recuperação rodando nessa sessão.', status: catchupStatus.get(session_id) });
    }
    scheduleCatchup(session_id, client, {
      sinceMs, reason: 'manual',
      opts: {
        ...(max_chats ? { maxChats: parseInt(max_chats, 10) } : {}),
        ...(max_pages ? { maxPages: parseInt(max_pages, 10) } : {}),
      },
    });
    res.json({ success: true, message: 'Recuperação enfileirada — acompanhe via GET /session/catchup/status' });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

app.get('/session/catchup/status', (req, res) => {
  const session_id = req.query.session_id || 'default';
  res.json({ success: true, status: catchupStatus.get(session_id) || null, watermark: watermarks.get(session_id) });
});

app.get('/session/backfill/status', (req, res) => {
  const session_id = req.query.session_id || 'default';
  const state = backfillState.get(session_id);
  if (!state) return res.json({ success: true, state: null, message: 'Nenhum backfill rodou ainda nessa sessão.' });
  res.json({ success: true, state });
});

// ── POST /session/backfill/stop ─────────────────────────────────
app.post('/session/backfill/stop', (req, res) => {
  const { session_id = 'default' } = req.body || {};
  const state = backfillState.get(session_id);
  if (!state?.running) return res.status(404).json({ success: false, error: 'Nenhum backfill em andamento pra essa sessão.' });
  state.stopRequested = true;
  res.json({ success: true, message: 'Parada solicitada — vai parar assim que a página/conversa atual terminar.' });
});

// ── POST /session/sync-phone ────────────────────────────────────
// Força a releitura do número de telefone vinculado numa sessão já
// autenticada — cobre o caso de reconexão via token, em que
// wppconnect.create() resolve mas o Store da página ainda não está pronto
// no instante em que o .then() busca o telefone inicial, então state.phone
// fica null e nada mais tenta de novo até chegar uma mensagem.
app.post('/session/sync-phone', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const client = requireClient(session_id);
    const state  = getSession(session_id);
    state.phone  = await fetchSessionPhone(client);
    res.json({ success: true, phone: state.phone });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// ── GET /session/chats ────────────────────────────────────────
// Lista os chats reais da sessão (jid + telefone), pra reconciliar dados
// que caíram na conta errada por causa do bug de session_id ausente no
// /bridge/sync (ver comentário em syncChatHistory).
app.get('/session/chats', async (req, res) => {
  const session_id = req.query.session_id || 'default';
  try {
    const client = requireClient(session_id);
    const chats  = await client.listChats({ count: 200 });
    const result = [];
    for (const c of chats) {
      if (c.isGroup) continue;
      const rawJid = c.id?._serialized;
      if (!rawJid) continue;
      const resolved = await resolveLidToPhone(client, session_id, rawJid);
      const phone = String(resolved).replace('@c.us', '').replace('@lid', '');
      if (phone) result.push(phone);
    }
    res.json({ success: true, phones: result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
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

    const tokenDir = path.join(SESSIONS_DIR, session_id);
    if (fs.existsSync(tokenDir)) {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }

    state.status = 'disconnected';
    state.phone  = null;
    state.qr     = null;

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// ── POST /session/pairing-code ────────────────────────────────
// Não incluído neste MVP — QR Code é o método de auth coberto agora.
app.post('/session/pairing-code', async (req, res) => {
  res.status(501).json({
    success: false,
    error:   'WPPConnect bridge não suporta código de pareamento ainda. Use o QR Code.',
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

// Vários métodos WPP.chat.* (markIsRead, deleteMessage, archive...) exigem
// que o chat já esteja no cache do Store da página — se o chat nunca foi
// "aberto" nesta sessão do browser (mesmo já tendo histórico real e mesmo
// já tendo enviado mensagem para ele), a lib lança "Chat not found".
// client.pinChat(id, false, true) força um WPP.chat.find(id) como efeito
// colateral documentado (é o mesmo truque que a própria lib usa
// internamente via seu parmetro `nonExistent`) sem alterar o pin real.
// BUG confirmado ao vivo (2026-09-18): getAllMessagesInChat é uma chamada
// pesada e SEM timeout próprio — força a lib a sincronizar o histórico
// inteiro do chat de destino. Pra contato com histórico grande (ou
// Puppeteer só lento no momento), isso sozinho já passava dos 30s de
// timeout do axios (frontend) e do httpx do backend (_bridge), fazendo
// forward de mensagem simples (texto incluso, não só mídia) estourar como
// timeout mesmo quando ia terminar de dar certo segundos depois. Cap local
// pra nunca deixar essa função pendurar mais que ENSURE_CACHE_TIMEOUT_MS —
// o resultado é best-effort de qualquer forma (ambos os try/catch abaixo já
// ignoravam erro), então abandonar a espera aqui não muda o contrato.
const ENSURE_CACHE_TIMEOUT_MS = 8000;
async function ensureChatCached(client, chatId) {
  try {
    await withTimeout(client.pinChat(chatId, false, true), ENSURE_CACHE_TIMEOUT_MS, 'pinChat(nonExistent)');
  } catch (_) { /* ignora — só um pre-fetch best-effort */ }
  // BUG confirmado ao vivo: o truque acima (pinChat nonExistent=true) NÃO
  // é suficiente pra archive/mute/delete — continuavam com "Chat not found"
  // mesmo depois dele, tanto pra grupo quanto pra contato individual com
  // histórico real. getAllMessagesInChat força a lib a carregar o chat de
  // verdade no Store (é o mesmo mecanismo que a sincronização de histórico
  // já usa com sucesso o tempo todo) — mais pesado, mas resolve de vez.
  try {
    await withTimeout(client.getAllMessagesInChat(chatId, true, false), ENSURE_CACHE_TIMEOUT_MS, 'getAllMessagesInChat');
  } catch (_) { /* ignora — best-effort */ }
}

function formatId(to) {
  // BUG anterior: checava '@' na string já sem dígitos não-numéricos, que
  // nunca contém '@' — todo JID que já vinha com domínio (@g.us, @lid) era
  // reescrito para @c.us errado. Checar o '@' no `to` original.
  if (String(to).includes('@')) return to;
  const digits = String(to).replace(/\D/g, '');
  return `${digits}@c.us`;
}

// @wppconnect-team/wppconnect rejeita alguns métodos (sendImage/sendFile) com
// um objeto plano ({erro, to, text}) em vez de um Error — err.message fica
// undefined nesses casos e o JSON.stringify apaga a chave, devolvendo
// {"success":false} sem nenhuma pista do que falhou.
function errMsg(err) {
  return err?.message || err?.text || (typeof err === 'string' ? err : JSON.stringify(err));
}

// BUG (2026-09-04, confirmado ao vivo — "Iniciar nova conversa" falhando):
// mandar a PRIMEIRA mensagem pra um contato que essa sessão nunca falou
// antes derruba com "No LID for user" — erro interno do wa-js, que tenta
// resolver o LID (endereçamento novo de multi-device do WhatsApp) antes de
// mandar e ainda não tem esse número em cache. checkNumberStatus (mesma
// chamada usada em /contact/check) é uma consulta mais leve que força essa
// resolução.
//
// REFORÇO (2026-09-10, confirmado ao vivo — atendente de teste, número novo
// 5511999990004): 1 retry imediato não bastava pra contatos que usam
// endereçamento @lid de verdade (confirmado pelos wamids "...@lid_..." desse
// contato) — o erro voltou a acontecer 4x na MESMA conversa (não só na
// primeira mensagem), porque o Store do wa-js perde a resolução do LID de
// novo depois, e checkNumberStatus é assíncrono: não fica garantido que o
// Store já comitou a resolução no instante em que o retry (sem espera
// nenhuma antes) tentava de novo. Passa a tentar até 4x no total, com um
// pequeno delay crescente antes de cada nova consulta+reenvio.
//
// REFORÇO 2 (2026-09-10, portado do prod — mesma correção aplicada lá após
// reproduzir de novo em conversa 100% nova, contato 5511999990003): o erro
// voltou a esgotar as 4 tentativas. checkNumberStatus só chama
// WPP.contact.queryExists internamente (dist/lib/wapi/wapi.js) — é uma
// checagem pura de existência, NÃO é o mesmo passo que a comunidade
// documenta como o que de fato resolve o LID (ver issues do wwebjs: "assim
// que você abre o chat pelo WhatsApp Web, o envio passa a funcionar").
// client.openChat() chama WPP.chat.openChatBottom() por baixo — dispara os
// mesmos eventos "naturais" de abrir uma conversa de verdade na UI, o que
// hidrata o Chat no Store de um jeito que a query de existência sozinha não
// faz. Passa a chamar os dois (checkNumberStatus + openChat) em cada retry,
// e aumenta a janela de espera total (~2.6s → ~8.2s) já que abrir o chat é
// mais pesado que só consultar existência.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LID_RETRY_DELAYS_MS = [500, 1200, 2500, 4000]; // 4 retries além da 1ª tentativa

// REFORÇO 3 (2026-09-11, confirmado ao vivo — conta ti01): mesma classe de
// bug, texto de erro diferente. "findChat: new chat not found" apareceu em
// DOIS casos: um contato/grupo novo (esperado, mesma causa raiz de sempre)
// E um contato cujo LID já estava resolvido e estabelecido há tempos —
// confirma que não é só "primeiro contato": o Chat no Store do wa-js pode
// ficar obsoleto/evict depois de um período sem interação, mesmo pra
// conversas antigas, precisando do mesmo re-hidrate (checkNumberStatus +
// openChat) de novo antes do reenvio funcionar. errMsg() normaliza a
// mensagem de erro pra sempre incluir o texto principal (ver definição
// abaixo), então checar duas substrings cobre as duas variantes já vistas
// em produção sem precisar adivinhar todas as formas que o wa-js usa pra
// reportar esse mesmo problema de fundo.
function isRecoverableChatError(err) {
  const msg = errMsg(err);
  return msg.includes('No LID for user') || msg.includes('findChat: new chat not found');
}

async function withLidRetry(client, to, sendFn) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendFn();
    } catch (err) {
      lastErr = err;
      if (!isRecoverableChatError(err)) throw err;
      const delay = LID_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw lastErr; // esgotou as tentativas, desiste de vez
      await sleep(delay);
      const id = formatId(to);
      await client.checkNumberStatus(id).catch(() => {});
      await client.openChat(id).catch(() => {});
    }
  }
}

// POST /send/text
app.post('/send/text', async (req, res) => {
  const { session_id = 'default', to, text, mentions, reply_to } = req.body;
  try {
    const client = requireClient(session_id);
    // @menções (grupo) — mesmo contrato do baileys-bridge: `mentions` é uma
    // lista de JIDs, opcional. Sem isso, texto com "mentions" preenchido
    // simplesmente ignorava a marcação (WPP.chat.sendTextMessage precisa do
    // detectMentioned/mentionedList pra WhatsApp de verdade destacar @Fulano).
    // BUG (2026-09-03): esta rota nunca aceitou reply_to — a citação salva
    // no backend nunca chegava até aqui, então o WhatsApp real recebia
    // sempre uma mensagem solta. client.sendText aceita quotedMsg com o
    // wamid nativo (mesmo formato salvo como wamid nas mensagens desta
    // sessão — ver extractMessageId acima).
    const options = reply_to ? { quotedMsg: reply_to } : undefined;
    const result = await withLidRetry(client, to, () =>
      (Array.isArray(mentions) && mentions.length > 0)
        ? client.sendMentioned(formatId(to), text, mentions.map(formatId))
        : client.sendText(formatId(to), text, options)
    );
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// BUG anterior: só aceitava "url", nunca base64 — o upload real de arquivo
// pela UI (POST /api/send/media) manda o arquivo como base64 (mesmo
// contrato do Baileys), então mídia enviada pela UI de verdade nunca
// chegava aqui pra estes providers. client.sendImage/sendFile aceitam um
// data URI (data:mime;base64,...) no lugar do path/URL.
function toDataUriOrUrl(url, base64_data, mimetype) {
  if (base64_data) {
    // BUG: mimetype vem com parmetro extra do conversor de áudio do backend
    // (ex.: "audio/ogg; codecs=opus") — um data URI com esse "; codecs=opus"
    // ANTES do ";base64," faz o parser de data URL do wa-js (dentro do
    // navegador) rejeitar tudo com "invalid_data_url" (confirmado ao vivo).
    // WhatsApp só precisa do tipo base (audio/ogg) pra reconhecer o áudio,
    // o parmetro de codec não muda nada pro envio.
    const cleanMime = (mimetype || 'application/octet-stream').split(';')[0].trim();
    return `data:${cleanMime};base64,${base64_data}`;
  }
  return url;
}

// POST /send/image
app.post('/send/image', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    // BUG: client.sendImage(to, filePath) trata o 2º argumento como caminho
    // de arquivo/URL de download — nunca reconhece um data URI, e falha com
    // "No such file or directory, open \"data:image/...\"" (confirmado ao
    // vivo). Upload direto (o único jeito que a UI manda imagem — sempre tem
    // base64_data, nunca url pública) precisa do método específico pra
    // base64 (sendImageFromBase64), que aceita data URI de verdade.
    const result = await withLidRetry(client, to, () => base64_data
      ? client.sendImageFromBase64(formatId(to), toDataUriOrUrl(url, base64_data, mimetype), 'image', caption)
      : client.sendImage(formatId(to), url, 'image', caption));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/video
app.post('/send/video', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await withLidRetry(client, to, () =>
      client.sendFile(formatId(to), toDataUriOrUrl(url, base64_data, mimetype), 'video', caption));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/audio
app.post('/send/audio', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype } = req.body;
  try {
    const client = requireClient(session_id);
    // Mesmo bug do /send/image acima: client.sendPtt(to, filePath) não
    // reconhece data URI — precisa do sendPttFromBase64 quando já temos o
    // arquivo em mãos (upload direto, o único caminho real que a UI usa).
    const result = await withLidRetry(client, to, () => base64_data
      ? client.sendPttFromBase64(formatId(to), toDataUriOrUrl(url, base64_data, mimetype), 'audio.ogg')
      : client.sendPtt(formatId(to), url));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/document
app.post('/send/document', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype, filename = 'arquivo' } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await withLidRetry(client, to, () =>
      client.sendFile(formatId(to), toDataUriOrUrl(url, base64_data, mimetype), filename, filename));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/location
app.post('/send/location', async (req, res) => {
  const { session_id = 'default', to, lat, lng, name = '' } = req.body;
  try {
    const client = requireClient(session_id);
    getSession(session_id).pendingOutboundLocation = { lat, lng, name, ts: Date.now() };
    const result = await withLidRetry(client, to, () => client.sendLocation(formatId(to), lat, lng, name));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

const NOT_SUPPORTED = (feature) => ({
  success: false,
  error: `${feature} não é suportado pela lib @wppconnect-team/wppconnect (sem API interna exposta para isso).`,
});

// ── Mensagens: reação, figurinha, gif, view-once, enquete, contato, encaminhar, editar, apagar, ler, fixar, favoritar ──

// POST /send/reaction
app.post('/send/reaction', async (req, res) => {
  const { session_id = 'default', message_id, emoji = '' } = req.body;
  try {
    const client = requireClient(session_id);
    await client.sendReactionToMessage(message_id, emoji);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/sticker
app.post('/send/sticker', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, mimetype } = req.body;
  try {
    const client = requireClient(session_id);
    // BUG (2026-09-04, confirmado ao vivo — "Empty or invalid file or
    // base64"): mesmo bug já corrigido antes em /send/image e /send/audio,
    // só que faltou aqui — sendImageAsSticker também não reconhece um
    // base64 cru (sem o prefixo "data:mime;base64,"), precisa de um data
    // URI de verdade. O sticker recebido do WhatsApp (reenviado pelo chat
    // de equipe, que usa outro caminho de envio) nunca passava por essa
    // rota, por isso só quebrava mandando pro WhatsApp de verdade.
    const result = await withLidRetry(client, to, () =>
      client.sendImageAsSticker(formatId(to), toDataUriOrUrl(url, base64_data, mimetype || 'image/webp')));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/gif
app.post('/send/gif', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await withLidRetry(client, to, () => client.sendFile(formatId(to), base64_data || url, 'gif', caption));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/view-once
app.post('/send/view-once', async (req, res) => {
  const { session_id = 'default', to, url, base64_data, filename = 'midia', caption = '' } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await withLidRetry(client, to, () =>
      client.sendFile(formatId(to), base64_data || url, filename, caption, undefined, undefined, true));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/poll
app.post('/send/poll', async (req, res) => {
  const { session_id = 'default', to, question, options = [], selectable_count = 1 } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await withLidRetry(client, to, () =>
      client.sendPollMessage(formatId(to), question, options, { selectableCount: selectable_count }));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/contact
app.post('/send/contact', async (req, res) => {
  const { session_id = 'default', to, contacts = [] } = req.body;
  try {
    const client = requireClient(session_id);
    // BUG (2026-09-14, confirmado ao vivo — 502 sem detalhe): este endpoint
    // só lia c.phone/c.name (formato simples), mas o backend Python
    // (/api/send/contacts, ContactSender.js) manda o formato rico da Meta
    // Cloud API — { name: { formatted_name }, phones: [{ phone }] }. c.phone
    // vinha undefined e formatId(undefined) virava um JID inválido, então
    // sendContactVcard falhava sempre. Mesmo fix já existia no baileys-bridge
    // (ver /send/contact lá) — replicado aqui pra aceitar os dois formatos.
    const phoneOf = (c) => c.phones?.[0]?.phone || c.phone || '';
    const nameOf  = (c) => c.name?.formatted_name || c.full_name || c.name || 'Contato';
    const invalid = contacts.find(c => !phoneOf(c));
    if (invalid) {
      return res.status(400).json({ success: false, error: 'Contato sem telefone válido.' });
    }
    const ids  = contacts.map(c => formatId(phoneOf(c)));
    const name = contacts.map(nameOf).join(', ');
    const result = await withLidRetry(client, to, () =>
      client.sendContactVcard(formatId(to), ids.length === 1 ? ids[0] : ids, name));
    res.json({ success: true, message_id: result?.id });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /send/forward
app.post('/send/forward', async (req, res) => {
  const { session_id = 'default', to, message_id } = req.body;
  try {
    const client = requireClient(session_id);
    // BUG confirmado ao vivo: client.forwardMessage() (singular) quebrava
    // com "Cannot read properties of undefined (reading 'map')" dentro do
    // próprio JS do WhatsApp Web — a doc da lib já avisa que forwardMessage
    // tem uma pegadinha na forma de passar os argumentos, corrigida em
    // forwardMessagesV2 (que espera um ARRAY de ids, não um id solto).
    const dest = formatId(to);
    // BUG confirmado ao vivo (2026-09-18): chamar ensureChatCached (pinChat +
    // getAllMessagesInChat, pesado) ANTES de toda tentativa de forward — só
    // por analogia com outros endpoints que realmente precisam disso pra
    // "Chat not found" — deixava até o forward de uma mensagem de TEXTO pra
    // um contato com chat já cacheado (o caso comum: você já tem a conversa
    // aberta na plataforma) lento o bastante pra estourar os timeouts de 30s
    // do axios/httpx. Tenta direto primeiro (rápido quando o chat já está no
    // Store, que é o caso normal) — só paga o custo pesado de cachear como
    // fallback, e só se a 1ª tentativa falhar de fato.
    let result;
    try {
      result = await client.forwardMessagesV2(dest, [message_id]);
    } catch (_firstErr) {
      await ensureChatCached(client, dest);
      result = await client.forwardMessagesV2(dest, [message_id]);
    }
    const resultId = Array.isArray(result) ? result[0]?.id || result[0] : result?.id;
    res.json({ success: true, message_id: resultId });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /message/edit
app.post('/message/edit', async (req, res) => {
  const { session_id = 'default', message_id, new_text } = req.body;
  try {
    const client = requireClient(session_id);
    await client.editMessage(message_id, new_text);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /message/delete
app.post('/message/delete', async (req, res) => {
  const { session_id = 'default', to, message_id, for_everyone = true } = req.body;
  try {
    const client = requireClient(session_id);
    await client.deleteMessage(formatId(to), [message_id], !for_everyone);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /message/read
app.post('/message/read', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    await ensureChatCached(client, formatId(jid));
    await client.sendSeen(formatId(jid));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /message/pin — sem API de "fixar mensagem" na lib (só pinChat, que fixa a conversa inteira)
app.post('/message/pin', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Fixar uma mensagem específica (só é possível fixar o chat inteiro)'));
});

// POST /message/star
// BUG confirmado ao vivo: client.starMessage() chama uma função legada da
// lib (WAPI.starMessages → internamente "sendStarMsgs") que não existe mais
// na versão atual do WhatsApp Web — sempre falha com "sendStarMsgs is not a
// function", sem alternativa moderna equivalente na lib nesta versão
// (confirmado: não há WPP.chat.*star* nenhum). Reportado como limitação
// clara (501) em vez de deixar estourar um 500 com stack trace minificado.
app.post('/message/star', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Favoritar mensagem (bug conhecido da versão atual da lib: a função legada que ela usa não existe mais no WhatsApp Web)'));
});

// ── Grupos ──────────────────────────────────────────────────

// POST /group/create
app.post('/group/create', async (req, res) => {
  const { session_id = 'default', subject, participants = [] } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.createGroup(subject, participants.map(formatId));
    res.json({ success: true, group_jid: result?.gid?._serialized || result?.gid, result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/participants/add
app.post('/group/participants/add', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.addParticipant(formatId(group_jid), participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/participants/remove
app.post('/group/participants/remove', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.removeParticipant(formatId(group_jid), participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/admins/promote
app.post('/group/admins/promote', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.promoteParticipant(formatId(group_jid), participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/admins/demote
app.post('/group/admins/demote', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [] } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.demoteParticipant(formatId(group_jid), participants.map(formatId));
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/subject
app.post('/group/subject', async (req, res) => {
  const { session_id = 'default', group_jid, subject } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setGroupSubject(formatId(group_jid), subject);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/description
app.post('/group/description', async (req, res) => {
  const { session_id = 'default', group_jid, description } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setGroupDescription(formatId(group_jid), description);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/leave
app.post('/group/leave', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const client = requireClient(session_id);
    await client.leaveGroup(formatId(group_jid));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/invite-code
app.post('/group/invite-code', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const client = requireClient(session_id);
    const link = await client.getGroupInviteLink(formatId(group_jid));
    res.json({ success: true, invite_link: link });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/invite-code/revoke
app.post('/group/invite-code/revoke', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const client = requireClient(session_id);
    const link = await client.revokeGroupInviteLink(formatId(group_jid));
    res.json({ success: true, invite_link: link });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/metadata
app.post('/group/metadata', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const client = requireClient(session_id);
    // BUG anterior: participants/admins voltavam vazios pra grupos reais —
    // rastreado até getGroupMembers()/getGroupAdmins() dependerem do chat já
    // estar carregado no Store da página (mesma classe de "Chat not found"
    // documentada em ensureChatCached, só que aqui falhava silencioso —
    // devolvia array vazio em vez de lançar). Mesmo truque de pre-fetch já
    // usado em /message/read e /chat/pin, só que não estava aplicado aqui.
    await ensureChatCached(client, formatId(group_jid));
    const members = await client.getGroupMembers(formatId(group_jid));
    const admins  = await client.getGroupAdmins(formatId(group_jid));

    // BUG: cada participante vinha com `id` como OBJETO bruto da lib
    // ({server, user, _serialized}), não a string plana que o front espera
    // (mesmo contrato que o baileys-bridge já usa) — `p.id.split('@')` no
    // GroupManager.js quebrava com "split is not a function", derrubando a
    // tela inteira ao abrir dados de QUALQUER grupo. `admin` também nunca
    // vinha embutido no participante aqui (a lib devolve os admins numa
    // lista separada) — sem cruzar as duas, nenhum badge de admin aparecia.
    const adminIds = new Set((admins || []).map(a => (typeof a === 'string' ? a : a?._serialized)).filter(Boolean));
    const normalizedParticipants = (members || []).map(p => {
      const id = typeof p.id === 'string' ? p.id : (p.id?._serialized || String(p.id));
      return {
        id,
        name: p.formattedName || p.verifiedName || p.pushname || p.name || undefined,
        isMe: !!p.isMe,
        admin: adminIds.has(id) ? 'admin' : null,
      };
    });

    res.json({ success: true, participants: normalizedParticipants, admins: Array.from(adminIds) });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/join-requests
app.post('/group/join-requests', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const client = requireClient(session_id);
    const requests = await client.getGroupMembershipRequests(formatId(group_jid));
    // Mesmo formato bruto de `.id` (objeto, não string) já visto em
    // getGroupMembers — normaliza `jid` aqui também antes que o front tente
    // `req.jid.split('@')` (GroupManager.js) e quebre.
    const normalizedRequests = (requests || []).map(r => ({
      ...r,
      jid: typeof r.jid === 'string' ? r.jid : (r.jid?._serialized || String(r.jid)),
    }));
    res.json({ success: true, requests: normalizedRequests });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/join-requests/update
app.post('/group/join-requests/update', async (req, res) => {
  const { session_id = 'default', group_jid, participants = [], action } = req.body;
  try {
    const client = requireClient(session_id);
    const ids = participants.map(formatId);
    const result = action === 'approve'
      ? await client.approveGroupMembershipRequest(formatId(group_jid), ids)
      : await client.rejectGroupMembershipRequest(formatId(group_jid), ids);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/join
app.post('/group/join', async (req, res) => {
  const { session_id = 'default', invite_link } = req.body;
  try {
    const client = requireClient(session_id);
    const code = invite_link.split('/').pop();
    const result = await client.joinGroup(code);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/announce
app.post('/group/announce', async (req, res) => {
  const { session_id = 'default', group_jid, announce } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setMessagesAdminsOnly(formatId(group_jid), !!announce);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /group/disappearing
app.post('/group/disappearing', async (req, res) => {
  const { session_id = 'default', group_jid, duration } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setTemporaryMessages(formatId(group_jid), duration > 0 ? duration : false);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// ── Perfil, contatos, presença ─────────────────────────────

// POST /profile/picture
app.post('/profile/picture', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    const raw = await client.getProfilePicFromServer(formatId(jid));
    // Sem foto, a lib devolve um objeto tipo {id, tag: ""} (sem eurl/imgFull
    // nenhum) em vez de null/string — mandar esse objeto puro pro front
    // quebra o <img src={...}> e qualquer código que espere uma URL.
    const url = typeof raw === 'string' ? raw : (raw?.imgFull || raw?.eurl || null);
    res.json({ success: true, url: typeof url === 'string' ? url : null });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /profile/picture/update
app.post('/profile/picture/update', async (req, res) => {
  const { session_id = 'default', image_b64 } = req.body;
  try {
    const client = requireClient(session_id);
    const dataUri = image_b64.startsWith('data:') ? image_b64 : `data:image/jpeg;base64,${image_b64}`;
    await client.setProfilePic(dataUri);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /profile/picture/remove
app.post('/profile/picture/remove', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const client = requireClient(session_id);
    await client.removeMyProfilePicture();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /profile/status
app.post('/profile/status', async (req, res) => {
  const { session_id = 'default', status } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setProfileStatus(status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /profile/name
app.post('/profile/name', async (req, res) => {
  const { session_id = 'default', name } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setProfileName(name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /profile/get-status
app.post('/profile/get-status', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    const result = await client.getStatus(formatId(jid));
    // BUG anterior: `result?.status ?? result ?? null` devolvia o objeto
    // {id, status} inteiro sempre que o contato realmente não tinha "recado"
    // definido (caso mais comum — status: null é válido, não "ausente"), já
    // que `??` só pula pro próximo operando quando o valor é null/undefined,
    // não quando é "null de propósito" vindo de dentro do objeto. Resultado:
    // o front recebia um objeto onde esperava string e quebrava o render
    // (React não aceita objeto puro como filho) — tela preta, precisa recarregar.
    const status = typeof result?.status === 'string' ? result.status : (typeof result === 'string' ? result : null);
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /contact/check
// lid_exists (2026-09-10): getPnLidEntry só devolve a chave "lid" quando o
// WhatsApp já expôs esse mapeamento pro contato — quando falta, sendText
// pra esse número quebra com "No LID for user" (bug de wa-js sem correção
// disponível até hoje, testado ao vivo: nenhuma chamada da lib resolve —
// nem checkNumberStatus, nem abrir o chat de verdade (openChat), nem a
// versão mais nova publicada de wa-js). Sem jeito de "consertar" isso daqui;
// o valor é avisar ANTES de tentar mandar, pra Nova Conversa não deixar o
// atendente descobrir só depois de uma tentativa falhada.
async function hasLid(client, id) {
  const entry = await client.getPnLidEntry(id).catch(() => null);
  return Boolean(entry?.lid);
}

app.post('/contact/check', async (req, res) => {
  const { session_id = 'default', phone } = req.body;
  try {
    const client = requireClient(session_id);
    const id = formatId(phone);
    const result = await client.checkNumberStatus(id);
    const lid_exists = result?.numberExists ? await hasLid(client, id) : null;
    res.json({
      success: true,
      exists: result?.numberExists ?? false,
      jid: result?.id?._serialized || null,
      lid_exists,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /contact/lid — diagnóstico standalone (mesma checagem que /contact/check
// já faz embutida, exposta separada pra depuração pontual sem precisar do
// checkNumberStatus completo).
app.post('/contact/lid', async (req, res) => {
  const { session_id = 'default', phone } = req.body;
  try {
    const client = requireClient(session_id);
    const id = formatId(phone);
    const entry = await client.getPnLidEntry(id).catch(e => ({ error: errMsg(e) }));
    res.json({ success: true, entry, lid_exists: Boolean(entry?.lid) });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /contact/block
app.post('/contact/block', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    await client.blockContact(formatId(jid));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /contact/unblock
app.post('/contact/unblock', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    await client.unblockContact(formatId(jid));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /contact/blocklist
app.post('/contact/blocklist', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const client = requireClient(session_id);
    const blocklist = await client.getBlockList();
    res.json({ success: true, blocklist });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /contact/business-profile
app.post('/contact/business-profile', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    const raw = await client.getBusinessProfile(formatId(jid));
    // BUG: `website` vem como array de OBJETOS ({url}), não array de
    // strings — o front (ContactInfoPanel.js) faz <p>{w}</p> direto com cada
    // item esperando string, e React não renderiza objeto como filho: quebra
    // a tela ao abrir QUALQUER contato comercial com site cadastrado (achado
    // ao vivo: Suzano, Dell, Claro, UniCV...). `categories` (plural, array de
    // {id, localized_display_name}) também nunca virava o `category`
    // (singular, string) que o front lê — categoria nunca aparecia.
    const profile = raw ? {
      ...raw,
      website: Array.isArray(raw.website)
        ? raw.website.map(w => (typeof w === 'string' ? w : w?.url)).filter(Boolean)
        : [],
      category: Array.isArray(raw.categories) && raw.categories.length > 0
        ? raw.categories.map(c => c?.localized_display_name).filter(Boolean).join(', ')
        : undefined,
    } : raw;
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
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
    if (type === 'available' || type === 'unavailable') {
      await client.setOnlinePresence(type === 'available');
    } else if (type === 'composing') {
      await client.startTyping(formatId(to));
    } else if (type === 'recording') {
      await client.startRecording(formatId(to));
    } else if (type === 'paused') {
      await client.stopTyping(formatId(to));
      await client.stopRecoring(formatId(to));
    } else {
      throw new Error(`Tipo de presença desconhecido: ${type}`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /presence/subscribe — sem equivalente na lib
app.post('/presence/subscribe', async (req, res) => {
  res.status(501).json(NOT_SUPPORTED('Assinar presença de um contato'));
});

// ── Gerenciamento de chats ────────────────────────────────

// POST /chat/delete
app.post('/chat/delete', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const client = requireClient(session_id);
    const dest = formatId(jid);
    await ensureChatCached(client, dest);
    await client.deleteChat(dest);
    res.json({ success: true });
  } catch (err) {
    if (isChatNotFoundError(err)) {
      return res.status(501).json(NOT_SUPPORTED('Excluir esta conversa (bug conhecido: a lib não encontra o chat internamente pra este contato)'));
    }
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// BUG confirmado ao vivo, NÃO resolvido (documentando o que já foi
// tentado): archiveChat/sendMute/deleteChat continuam com "Chat not found"
// mesmo depois de ensureChatCached (pinChat nonExistent + getAllMessagesInChat,
// as duas tentativas de "aquecer" o Store). Suspeita mais provável: essa
// conta resolve muitos contatos por LID (visto o app inteiro nesta sessão —
// ver resolveLidToPhone) e o Store de chats da lib pode estar indexado pela
// LID internamente, não pelo telefone — então formatId("...@c.us") aponta
// pra uma chave que nunca existiu de verdade. Resolver direito exigiria
// mapear telefone→LID (o caminho inverso do que resolveLidToPhone já faz)
// antes de CADA ação de chat, não só de mensagem — mais trabalho do que dá
// pra cobrir agora. Reporta erro claro em vez de deixar estourar o 500 cru.
function isChatNotFoundError(err) {
  const msg = errMsg(err) || '';
  return msg.includes('Chat not found') || msg.includes('"me":{');
}

// POST /chat/archive
app.post('/chat/archive', async (req, res) => {
  const { session_id = 'default', jid, archive = true } = req.body;
  try {
    const client = requireClient(session_id);
    const dest = formatId(jid);
    await ensureChatCached(client, dest);
    await client.archiveChat(dest, archive);
    res.json({ success: true });
  } catch (err) {
    if (isChatNotFoundError(err)) {
      return res.status(501).json(NOT_SUPPORTED('Arquivar esta conversa (bug conhecido: a lib não encontra o chat internamente pra este contato)'));
    }
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /chat/mute
app.post('/chat/mute', async (req, res) => {
  const { session_id = 'default', jid, duration_ms } = req.body;
  try {
    const client = requireClient(session_id);
    const dest = formatId(jid);
    await ensureChatCached(client, dest);
    const seconds = duration_ms ? Math.floor(duration_ms / 1000) : 0;
    await client.sendMute(dest, seconds, 'hours');
    res.json({ success: true });
  } catch (err) {
    if (isChatNotFoundError(err)) {
      return res.status(501).json(NOT_SUPPORTED('Silenciar esta conversa (bug conhecido: a lib não encontra o chat internamente pra este contato)'));
    }
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /chat/pin
app.post('/chat/pin', async (req, res) => {
  const { session_id = 'default', jid, pinned = true } = req.body;
  try {
    const client = requireClient(session_id);
    await client.pinChat(formatId(jid), pinned, true);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// POST /chat/disappearing
app.post('/chat/disappearing', async (req, res) => {
  const { session_id = 'default', jid, duration } = req.body;
  try {
    const client = requireClient(session_id);
    await client.setTemporaryMessages(formatId(jid), duration > 0 ? duration : false);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: errMsg(err) });
  }
});

// ─── Shutdown gracioso ──────────────────────────────────────────
// BUG anterior: pm2 restart manda SIGTERM direto no processo Node, que
// morria sem nunca fechar o Chrome/Puppeteer de cada sessão — o Chrome
// ficava órfão segurando o SingletonLock do userDataDir, e a próxima vez
// que a sessão tentava iniciar (novo processo, mesmo diretório de perfil)
// falhava com "The browser is already running for ...". Só dava pra
// destravar apagando o lock manualmente. Fechando o client aqui evita isso.
async function shutdown(signal) {
  console.log(`[WPPConnect Bridge] ${signal} recebido, fechando sessões...`);
  const closes = [...sessions.values()].map(s => s.client?.close?.().catch(() => {}));
  await Promise.race([Promise.all(closes), new Promise(r => setTimeout(r, 8000))]);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[WPPConnect Bridge] Rodando na porta ${PORT}`);
  console.log(`[WPPConnect Bridge] FastAPI URL: ${FASTAPI_URL}`);
  console.log(`[WPPConnect Bridge] Sessões em: ${SESSIONS_DIR}`);
  console.log(`[WPPConnect Bridge] Chrome: ${CHROME_PATH || '(auto-detect)'}`);
  setInterval(replayFailedWebhooks, REPLAY_INTERVAL_MS);
  setInterval(healCiphertextMessages, CIPHERTEXT_HEAL_INTERVAL_MS);
});

module.exports = app;
