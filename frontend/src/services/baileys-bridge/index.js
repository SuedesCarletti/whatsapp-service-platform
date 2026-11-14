/**
 * services/baileys-bridge/index.js
 *
 * ─── CHANGELOG ───────────────────────────────────────────────────────────────
 *
 * [AUTO-BOOTSTRAP] Ao iniciar, consulta whatsapp_accounts no MySQL e inicia
 *   automaticamente todas as sessões Baileys ativas com o session_id correto.
 *   Se há creds salvas → reconecta sem QR. Se não há → fica aguardando scan.
 *
 * [ORPHAN-FIX] Na inicialização, corrige conversas e mensagens com account_id=NULL
 *   vinculando-as à conta Baileys correta (pelo session_id ou primeira conta ativa).
 *
 * [FIX 1] messaging-history.set — evento correto no Baileys 6.7.x+
 * [FIX 2] Railway private networking — FASTAPI_INTERNAL_URL preferido
 * [FIX 3] getMessage no makeWASocket — obrigatório para descriptografia
 * [FIX 4] SSL para TiDB Cloud — ativado para qualquer host não-local
 */

import express        from 'express';
import axios          from 'axios';
import QRCode         from 'qrcode';
import pino           from 'pino';
import fs             from 'fs';
import path           from 'path';
import { Readable }   from 'stream';
import { fileURLToPath } from 'url';
import sharp          from 'sharp';
import { spawn }      from 'child_process';
import { postHistoryBatch } from './history-gate.js';
import { createArchive, tsOf, revive } from './history-archive.js';

import {
  makeWASocket, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage,
  USyncQuery, USyncUser, getUrlInfo, getKeyAuthor, decryptPollVote,
  updateMessageWithPollUpdate, getAggregateVotesInPollMessage, normalizeMessageContent,
  jidNormalizedUser, Browsers,
} from '@whiskeysockets/baileys';

import { useHybridAuthState, createMySQLPool } from './db-auth-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────────

const PORT = process.env.PORT || process.env.BAILEYS_PORT || 3001;
const SESSIONS_DIR = process.env.SESSIONS_DIR  || path.join(__dirname, 'sessions');
const SYNC_MAX_PER_CHAT = parseInt(process.env.SYNC_MAX_PER_CHAT || '30', 10);

const INTERNAL_URL = process.env.FASTAPI_INTERNAL_URL
  ? process.env.FASTAPI_INTERNAL_URL.replace(/\/$/, '').replace(/\/api$/, '')
  : null;

const RAW_FASTAPI_URL = (process.env.FASTAPI_URL || 'http://localhost:8000').replace(/\/$/, '');
const PUBLIC_BASE     = RAW_FASTAPI_URL.endsWith('/api')
  ? RAW_FASTAPI_URL.slice(0, -4)
  : RAW_FASTAPI_URL;

const WEBHOOK_BASE = INTERNAL_URL || PUBLIC_BASE;

// Sessões Baileys que existem só como fallback de ENVIO (ver
// _find_baileys_fallback_account / _send_text_maybe_fallback em
// backend/api/routes.py — usadas quando o WPPConnect falha com "No LID for
// user") NÃO podem virar uma segunda fonte de conversas: essa mesma conta
// real já está sincronizando tudo via WPPConnect (account_id diferente), e
// como aqui é uma sessão Baileys autenticada de verdade (aparelho vinculado
// de verdade, não um mock), ela recebe o histórico completo E mensagens ao
// vivo iguais a qualquer conta Baileys normal — sem esse bloqueio, cada
// contato existente viraria uma SEGUNDA conversa duplicada (account_id da
// fallback) além da que já existe via WPPConnect. Intercepta no nível do
// axios (ponto único, cobre as 12 chamadas de forward pro backend nesse
// arquivo) em vez de guardar cada uma individualmente — envio (/send/*)
// nunca passa por esse axios, só os listeners de evento inbound do
// Baileys, então continua funcionando normalmente.
const FALLBACK_ONLY_SESSIONS = new Set(
  (process.env.FALLBACK_ONLY_BAILEYS_SESSIONS || '').split(',').map(s => s.trim()).filter(Boolean)
);
if (FALLBACK_ONLY_SESSIONS.size) {
  // `logger` (pino) ainda não existe nesse ponto do arquivo — console.log direto.
  console.log('[Baileys] Sessões fallback-only (ingestão bloqueada):', [...FALLBACK_ONLY_SESSIONS]);
}
// Excecao: HISTORICO (POST /bridge/sync) da companion passa — o backend o mescla na
// conta primaria deduplicando por wamid (HISTORY_MERGE_FROM_FALLBACK, padrao ligado).
// Trafego ao vivo e catch-up continuam bloqueados aqui e la.
const MERGE_FALLBACK_HISTORY = process.env.HISTORY_MERGE_FROM_FALLBACK !== 'false';
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
axios.interceptors.request.use((config) => {
  const sid = config?.data?.session_id;
  const isHistorySync = typeof config?.url === 'string' && config.url.endsWith('/api/webhook/bridge/sync');
  if (MERGE_FALLBACK_HISTORY && isHistorySync) return config;
  if (config?.url?.startsWith(WEBHOOK_BASE) && sid && FALLBACK_ONLY_SESSIONS.has(sid)) {
    return Promise.reject(new axios.Cancel(`[Baileys] Ingestão bloqueada (sessão fallback-only): ${sid}`));
  }
  return config;
});

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── Historico completo + backup ─────────────────────────────
// BAILEYS_HISTORY_PROFILE=full (padrao): perfil Desktop + syncFullHistory — e o que
// faz o WhatsApp entregar o historico profundo no PAREAMENTO (entregue uma vez so;
// o que nao vier agora so volta parcialmente, sob demanda). 'default' volta ao perfil antigo.
// Tudo que chega e gravado SEM teto em BACKUP_DIR (history-archive) e encaminhado
// ao backend em segundo plano, atras do portao de carga (history-gate).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backup');
const HISTORY_FULL = process.env.BAILEYS_HISTORY_PROFILE !== 'default';
const HISTORY_FORWARD_ENABLED = process.env.HISTORY_FORWARD_ENABLED !== 'false';
const archive = createArchive(BACKUP_DIR);
const historyQueues = new Map(); // session_id -> promise (um encaminhamento por vez)
function enqueueHistory(session_id, fn) {
  const next = (historyQueues.get(session_id) || Promise.resolve()).then(fn, fn);
  historyQueues.set(session_id, next.catch(() => {}));
  return next;
}

logger.info(
  {
    port:          PORT,
    webhook_base:  WEBHOOK_BASE,
    using_private: !!INTERNAL_URL,
    internal_url:  INTERNAL_URL || '(não configurado — usando URL pública)',
  },
  '[Baileys] Config carregada',
);

// ─── MySQL Pool ───────────────────────────────────────────────

let mysqlPool     = null;
let mysqlInitDone = false;

async function initMySQLPool() {
  if (mysqlInitDone) return;
  mysqlInitDone = true;
  try {
    mysqlPool = await createMySQLPool();
    if (mysqlPool) logger.info('[Baileys] MySQL pool criado');
    else           logger.warn('[Baileys] MySQL indisponível — usando auth em arquivo');
  } catch (e) {
    logger.warn('[Baileys] Falha ao criar MySQL pool: %s', e.message);
    mysqlPool = null;
  }
}

// ─── LID→phone persistência no MySQL ─────────────────────────
async function ensureLidMapTable() {
  if (!mysqlPool) return;
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS baileys_lid_map (
      session_id VARCHAR(128) NOT NULL,
      lid_jid    VARCHAR(128) NOT NULL,
      phone_jid  VARCHAR(128) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id, lid_jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function loadLidMapFromDB(session_id) {
  if (!mysqlPool) return;
  try {
    const [rows] = await mysqlPool.query(
      'SELECT lid_jid, phone_jid FROM baileys_lid_map WHERE session_id = ?',
      [session_id]
    );
    if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
    for (const row of rows) {
      lidToJidMap[session_id][row.lid_jid] = row.phone_jid;
    }
    if (rows.length) logger.info({ session_id, count: rows.length }, '[Baileys] LID map carregado do banco');
  } catch (e) {
    logger.warn('[Baileys] Erro ao carregar LID map: %s', e.message);
  }
}

async function saveLidMapToDB(session_id, lid_jid, phone_jid) {
  if (!mysqlPool) return;
  try {
    await mysqlPool.query(
      'INSERT INTO baileys_lid_map (session_id, lid_jid, phone_jid) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE phone_jid = VALUES(phone_jid)',
      [session_id, lid_jid, phone_jid]
    );
  } catch (e) {
    logger.warn('[Baileys] Erro ao salvar LID map: %s', e.message);
  }
}

// ─── Auto-bootstrap ───────────────────────────────────────────
//
// Lê whatsapp_accounts do banco e inicia cada sessão Baileys ativa.
// session_id vem da coluna session_id, com fallback em provider_config JSON.

async function bootstrapSessionsFromDB() {
  if (!mysqlPool) {
    logger.warn('[Bootstrap] MySQL não disponível — auto-bootstrap ignorado');
    return;
  }

  try {
    const [rows] = await mysqlPool.query(`
      SELECT id, account_name, session_id, provider_config
      FROM   whatsapp_accounts
      WHERE  provider_type IN ('baileys', 'Baileys', 'BAILEYS')
        AND  is_active = 1
    `);

    if (!rows.length) {
      logger.info('[Bootstrap] Nenhuma conta Baileys ativa encontrada no banco');
      return;
    }

    logger.info('[Bootstrap] %d conta(s) Baileys encontrada(s) — iniciando sessões...', rows.length);

    // Aguarda 8s antes de reconectar — dá tempo do WA liberar sessões do deploy anterior
    logger.info('[Bootstrap] Aguardando 15s para WA liberar sessões anteriores...');
    await new Promise(r => setTimeout(r, 15000));

    for (const row of rows) {
      // Resolve session_id: coluna direta > provider_config.session_id > id da conta
      let sid = row.session_id;
      if (!sid && row.provider_config) {
        try {
          const cfg = typeof row.provider_config === 'string'
            ? JSON.parse(row.provider_config)
            : row.provider_config;
          sid = cfg?.session_id;
        } catch (_) {}
      }
      if (!sid) sid = String(row.id);

      logger.info(
        '[Bootstrap] Conta id=%d "%s" → session_id="%s"',
        row.id, row.account_name, sid,
      );

      startSession(sid).then(result => {
        logger.info('[Bootstrap] session_id="%s" status=%s', sid, result.status);
      }).catch(err => {
        logger.error('[Bootstrap] session_id="%s" erro: %s', sid, err.message);
      });

      // Pausa entre sessões — aumentada para evitar conflito no WA
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (err) {
    logger.error('[Bootstrap] Erro ao consultar banco: %s', err.message);
  }
}

// ─── Migração: corrige conversas/mensagens com account_id=NULL ───────────────

async function fixOrphanedConversations() {
  if (!mysqlPool) return;

  try {
    const [[{ total }]] = await mysqlPool.query(
      'SELECT COUNT(*) AS total FROM conversations WHERE account_id IS NULL',
    );

    if (total === 0) {
      logger.info('[OrphanFix] Nenhuma conversa órfã encontrada ');
      return;
    }

    const [accounts] = await mysqlPool.query(`
      SELECT id, session_id, account_name
      FROM   whatsapp_accounts
      WHERE  provider_type IN ('baileys', 'Baileys', 'BAILEYS')
        AND  is_active = 1
      ORDER  BY id ASC
      LIMIT  1
    `);

    if (!accounts.length) {
      logger.warn('[OrphanFix] Nenhuma conta Baileys para vincular conversas órfãs');
      return;
    }

    const targetId = accounts[0].id;

    const [convResult] = await mysqlPool.query(
      'UPDATE conversations SET account_id = ? WHERE account_id IS NULL',
      [targetId],
    );

    let msgCount = 0;
    try {
      const [msgResult] = await mysqlPool.query(
        'UPDATE messages SET account_id = ? WHERE account_id IS NULL',
        [targetId],
      );
      msgCount = msgResult.affectedRows;
    } catch (_) {}

    logger.info(
      '[OrphanFix] Vinculadas %d conversas e %d mensagens à conta id=%d ("%s")',
      convResult.affectedRows, msgCount, targetId, accounts[0].account_name,
    );
  } catch (err) {
    logger.error('[OrphanFix] Erro: %s', err.message);
  }
}

// ─── Store em memória para contatos (nome pelo JID) ──────────

const contactStore = {};

// Mapa LID → JID de telefone por sessão.
// Populado via contacts.upsert quando Baileys reporta c.id (telefone) + c.lid.
// Usado por resolveLidJid para converter @lid em @s.whatsapp.net.
const lidToJidMap = {};

function upsertContacts(session_id, contacts) {
  if (!contactStore[session_id]) contactStore[session_id] = {};
  if (!lidToJidMap[session_id])  lidToJidMap[session_id]  = {};
  for (const [jid, data] of Object.entries(contacts)) {
    contactStore[session_id][jid] = {
      ...( contactStore[session_id][jid] || {} ),
      ...data,
    };
    // Mapeia LID → telefone quando o contato tem id (telefone) + lid
    if (jid.endsWith('@s.whatsapp.net') && data.lid) {
      lidToJidMap[session_id][data.lid] = jid;
      saveLidMapToDB(session_id, data.lid, jid);
    }
    // Mapeia também quando o próprio jid é um LID e tem phoneNumber
    if (jid.endsWith('@lid') && data.phoneNumber) {
      const phoneJid = `${data.phoneNumber}@s.whatsapp.net`;
      lidToJidMap[session_id][jid] = phoneJid;
      saveLidMapToDB(session_id, jid, phoneJid);
    }
  }
}

async function postGroupNotification(session_id, group_jid, text) {
  try {
    await axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/group-notification`, {
      session_id, group_jid, text, timestamp: Date.now(),
    }, { timeout: 8000 });
  } catch (err) {
    logger.warn({ err: err.message }, '[Baileys] Falha ao notificar evento de grupo');
  }
}

function getContactName(session_id, jid) {
  const store = contactStore[session_id];
  if (!store) return null;
  const c = store[jid];
  // c.name = agenda de endereços (contato salvo); c.notify = pushname (autodeclarado).
  // Prioriza o nome salvo — só cai pro pushname/verifiedName quando não há contato salvo.
  return c?.name || c?.verifiedName || c?.notify || null;
}

// ─── Store em memória para getMessage ────────────────────────

const messageStore = {};

// ─── Store em memória da WAMessage completa (key + message), usada para
// encaminhar mensagens (/send/forward) — messageStore só guarda o conteúdo,
// sem a key, e o parâmetro `forward` do Baileys precisa da mensagem inteira.
const fullMessageStore = {};

// ─── Cache de metadados de grupos (populado no boot via groupFetchAllParticipating) ─
const groupMetadataCache = {};

function storeMessage(session_id, msg) {
  if (!msg?.key?.id || !msg.message) return;
  if (!messageStore[session_id]) messageStore[session_id] = {};
  messageStore[session_id][msg.key.id] = msg.message;
  const keys = Object.keys(messageStore[session_id]);
  if (keys.length > 500) delete messageStore[session_id][keys[0]];

  if (!fullMessageStore[session_id]) fullMessageStore[session_id] = {};
  fullMessageStore[session_id][msg.key.id] = msg;
  const fullKeys = Object.keys(fullMessageStore[session_id]);
  if (fullKeys.length > 500) delete fullMessageStore[session_id][fullKeys[0]];
}

function makeGetMessage(session_id) {
  return async (key) => {
    const store = messageStore[session_id];
    if (store && key?.id && store[key.id]) return store[key.id];
    return undefined;
  };
}

// ─── Mapeamento de tipos ──────────────────────────────────────

const TYPE_MAP = {
  conversation:          'text',
  extendedTextMessage:   'text',
  imageMessage:          'image',
  videoMessage:          'video',
  audioMessage:          'audio',
  pttMessage:            'audio',
  documentMessage:       'document',
  stickerMessage:        'sticker',
  locationMessage:       'location',
  reactionMessage:       'reaction',
  contactMessage:        'contact',
  contactsArrayMessage:  'contact',
  // Enquetes não têm representação própria no backend — tratadas como texto
  // formatado (pergunta + opções) para não chegar em branco no app.
  pollCreationMessage:   'text',
  pollCreationMessageV2: 'text',
  pollCreationMessageV3: 'text',
};

// Desembrulha ephemeralMessage/viewOnceMessage/editedMessage/etc. — sem isso,
// mensagens de chats com "mensagens temporárias" ou "ver uma vez" chegam com o
// conteúdo real um nível abaixo e o app enxerga apenas a chave do wrapper, resultando
// em texto vazio.
function getMessageContent(msg) {
  return normalizeMessageContent(msg?.message) || {};
}

function detectBaileysType(msg) {
  const content = getMessageContent(msg);
  const keys = Object.keys(content);
  return keys.find(k => TYPE_MAP[k]) || keys[0] || 'text';
}

function normalizeBaileysType(rawType) {
  return TYPE_MAP[rawType] || 'text';
}

// ─── Cache versão WA ──────────────────────────────────────────

const WA_VERSION_FALLBACK = [2, 3000, 1015901307];
let cachedVersion    = null;
let cachedVersionAt  = 0;
const VERSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

async function getWAVersion() {
  const now = Date.now();
  if (cachedVersion && (now - cachedVersionAt) < VERSION_TTL_MS) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion   = version;
    cachedVersionAt = now;
    logger.info({ version }, '[Baileys] Versão WA atualizada');
    return version;
  } catch (err) {
    logger.warn('[Baileys] Falha ao buscar versão WA: %s — usando fallback', err.message);
    // Só usa fallback se nunca teve versão válida
    return cachedVersion || WA_VERSION_FALLBACK;
  }
}

// ─── Gerenciador de sessões ───────────────────────────────────

const sessions = new Map();

function getSession(session_id) {
  if (!sessions.has(session_id)) {
    sessions.set(session_id, {
      sock:           null,
      qr:             null,
      qr_string:      null,
      status:         'idle',
      phone:          null,
      starting:       false,
      reconnectCount: 0,
      deleteSession:  null,
      pairingCode:    null,
    });
  }
  return sessions.get(session_id);
}

function sessionInvalidated(statusCode) {
  return (
    statusCode === DisconnectReason.loggedOut ||
    statusCode === DisconnectReason.forbidden ||
    statusCode === DisconnectReason.multideviceMismatch
  );
}

// ─── Inicializar sessão ───────────────────────────────────────

async function startSession(session_id) {
  const state = getSession(session_id);

  if (state.status === 'authenticated' && state.sock) {
    return { status: 'authenticated', phone: state.phone };
  }

  if (state.starting) {
    const ready = await waitForSocketReady(session_id, 25000);
    if (ready) return buildStatusResponse(session_id);
    return { status: state.status };
  }

  state.starting  = true;
  state.status    = 'starting';
  state.qr        = null;
  state.qr_string = null;

  try {
    await initMySQLPool();

    const { state: authState, saveCreds, deleteSession } =
      await useHybridAuthState(session_id, mysqlPool, SESSIONS_DIR);

    state.deleteSession = deleteSession;

    const version = await getWAVersion();

    const sock = makeWASocket({
      version,
      auth:                authState,
      printQRInTerminal:   false,
      logger:              pino({ level: 'warn' }),
      browser:             HISTORY_FULL ? Browsers.macOS('Desktop') : ['Ubuntu', 'Chrome', '22.0.0.75'],
      connectTimeoutMs:    60_000,
      keepAliveIntervalMs: 25_000,
      syncFullHistory:     true,
      getMessage:          makeGetMessage(session_id),
      // ← adicionar estas duas:
      shouldSyncHistoryMessage: () => true,
      transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
    });

    state.sock = sock;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        state.qr_string = qr;
        state.qr        = await QRCode.toDataURL(qr).catch(() => null);
        state.status    = 'qr_required';
        logger.info({ session_id }, '[Baileys] QR gerado');
      }

      if (connection === 'open') {
        state.status         = 'authenticated';
        state.qr             = null;
        state.qr_string      = null;
        state.phone          = sock.user?.id?.split(':')[0] || null;
        state.reconnectCount = 0;
        state.starting       = false;
        logger.info({ session_id, phone: state.phone }, '[Baileys] Autenticado ');
        await loadLidMapFromDB(session_id);

        // Sincroniza metadados e participantes de todos os grupos ao conectar
        setTimeout(async () => {
          try {
            const groups = await sock.groupFetchAllParticipating();
            if (!groupMetadataCache[session_id]) groupMetadataCache[session_id] = {};
            const groupMap = {};
            for (const [jid, meta] of Object.entries(groups)) {
              groupMap[jid] = { id: jid, notify: meta.subject, name: meta.subject, subject: meta.subject };
              // Armazena metadados completos (com participantes) para uso em /group/metadata
              groupMetadataCache[session_id][jid] = meta;
              // Registra cada participante como contato
              for (const p of (meta.participants || [])) {
                const pJid = p.lid || p.id;
                const pPn  = p.id?.endsWith('@lid') ? (p.phoneNumber ? `${p.phoneNumber}@s.whatsapp.net` : null) : p.id;
                const contactJid = pPn || pJid;
                if (contactJid) {
                  const phone = contactJid.split('@')[0];
                  await axios.post(`${WEBHOOK_BASE}/api/contacts/upsert`, {
                    wa_id: contactJid,
                    phone_number: phone,
                    group_jid: jid,
                    is_group_participant: true,
                  }, { timeout: 5000 }).catch(() => {});
                }
              }
            }
            upsertContacts(session_id, groupMap);
            logger.info({ session_id, total: Object.keys(groups).length }, '[Baileys] Grupos sincronizados');
          } catch (e) {
            logger.warn({ session_id }, '[Baileys] Falha ao sincronizar grupos: %s', e.message);
          }
        }, 5000);
      }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason     = DisconnectReason[statusCode] || statusCode;
          logger.warn({ session_id, reason, statusCode }, '[Baileys] Conexão fechada');
        
          if (sessionInvalidated(statusCode)) {
            logger.warn({ session_id }, '[Baileys] Sessão invalidada — removendo creds');
            if (state.deleteSession) await state.deleteSession().catch(() => {});
            Object.assign(state, {
              status: 'disconnected', sock: null, phone: null,
              qr: null, qr_string: null, starting: false, reconnectCount: 0,
            });
        
          } else if (statusCode === 440) {
            // 440 = connectionReplaced — container anterior ainda estava vivo
            // Creds são válidas — reconecta após 30s quando o container antigo morrer
            logger.warn({ session_id }, '[Baileys] 440 connectionReplaced — reconectando em 30s...');
            Object.assign(state, {
              status: 'disconnected', sock: null, phone: null,
              qr: null, qr_string: null, starting: false, reconnectCount: 0,
            });
            setTimeout(() => {
              // Incidente 2026-09-11: esse timer não checava se a sessão já
              // tinha reconectado por outro caminho (retry interno mais
              // rápido, ou um /session/init externo) nos 30s de espera —
              // disparava startSession() de novo em cima de uma conexão já
              // viva, e um segundo login com as mesmas credenciais é
              // exatamente o que gera outro 440 (WhatsApp derruba a conexão
              // mais antiga) — loop de reconexão auto-alimentado. Sem essa
              // trava, isso podia ficar oscilando a cada ~30s indefinidamente.
              if (state.status === 'authenticated' && state.sock) {
                logger.info({ session_id }, '[Baileys] Reconexão pós-440 cancelada — sessão já reconectou por outro caminho');
                return;
              }
              logger.info({ session_id }, '[Baileys] Tentando reconexão pós-440...');
              startSession(session_id).catch(err =>
                logger.error({ session_id }, '[Baileys] Reconexão pós-440 falhou: %s', err.message)
              );
            }, 30000);

          } else if (statusCode === 515) {
            // 515 = restart required — WA pediu reconexão, não é erro fatal
            logger.info({ session_id }, '[Baileys] 515 restart — reconectando...');
            // Invalida cache de versão para buscar versão mais recente
            cachedVersion   = null;
            cachedVersionAt = 0;
            Object.assign(state, {
              status: 'starting', sock: null, starting: false,
            });
            setTimeout(() => startSession(session_id).catch(() => {}), 2000);
        
          } else {
            state.reconnectCount = (state.reconnectCount || 0) + 1;
            if (state.reconnectCount <= 5) {
              const delay = Math.min(state.reconnectCount * 3000, 15000);
              logger.info({ session_id, attempt: state.reconnectCount }, '[Baileys] Reconectando em %dms', delay);
              state.status   = 'starting';
              state.sock     = null;
              state.starting = false;
              setTimeout(() => startSession(session_id).catch(() => {}), delay);
            } else {
              // BUG anterior: apagava as credenciais (deleteSession) aqui,
              // tratando "5 tentativas de reconexão falharam" igual a um
              // logout de verdade. Esse ramo (else de sessionInvalidated)
              // é justamente para statusCodes NÃO-invalidantes (408
              // timedOut, 503 unavailableService, 428 connectionClosed) —
              // blips de rede transitórios. As credenciais continuam
              // válidas; só paramos de tentar automaticamente. Um próximo
              // /session/init reconecta direto, sem pedir QR de novo.
              logger.warn({ session_id }, '[Baileys] Reconexões automáticas esgotadas — credenciais preservadas, aguardando novo /session/init');
              Object.assign(state, {
                status: 'disconnected', sock: null, starting: false,
                reconnectCount: 0,
              });
            }
          }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Chamadas (Auto-rejeitar) ─────────────────────────────
    sock.ev.on('call', async (calls) => {
      for (const call of calls) {
        if (call.status === 'offer') {
          try {
            await sock.rejectCall(call.id, call.from);
            logger.info({ session_id, from: call.from, callId: call.id }, '[Baileys] Chamada rejeitada automaticamente');
          } catch (e) {
            logger.warn({ session_id, err: e.message }, '[Baileys] Falha ao rejeitar chamada');
          }
        }
      }
    });

    // ── Store de contatos ────────────────────────────────────
    sock.ev.on('contacts.upsert', (contacts) => {
      const map = {};
      const lidMappings = [];

      for (const c of contacts) {
        if (!c.id) continue;
        map[c.id] = c;
        // Se o contato tem id (telefone) + lid, registra também o lid como chave
        // para que resolveLidJid encontre o mapeamento em ambas as direções.
        if (c.lid && !c.id.endsWith('@lid')) {
          map[c.lid] = { ...c, id: c.lid };
          lidMappings.push({
            wa_id:        c.id,
            lid:          c.lid,
            push_name:    c.notify || '',
            // contact_name: nome real da agenda (só existe se o contato está
            // salvo no telefone vinculado) — distinto do notify/pushname.
            contact_name: c.name || '',
          });
        }
      }

      upsertContacts(session_id, map);
      logger.debug({ session_id, count: contacts.length }, '[Baileys] contacts.upsert');

      // Registra mapeamentos LID→phone no backend para corrigir contatos fantasma
      if (lidMappings.length > 0) {
        axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/contacts`, {
          session_id,
          contacts: lidMappings,
        }, { timeout: 8000 }).catch(e =>
          logger.warn({ session_id }, '[Baileys] Falha ao registrar LID mappings: %s', e.message)
        );
      }
    });

    sock.ev.on('contacts.update', (updates) => {
      const map = {};
      const lidMappings = [];

      for (const u of updates) {
        if (!u.id) continue;
        map[u.id] = u;
        if (u.lid && !u.id.endsWith('@lid')) {
          map[u.lid] = { ...u, id: u.lid };
          lidMappings.push({
            wa_id:        u.id,
            lid:          u.lid,
            push_name:    u.notify || '',
            contact_name: u.name || '',
          });
        }
      }

      upsertContacts(session_id, map);

      if (lidMappings.length > 0) {
        axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/contacts`, {
          session_id,
          contacts: lidMappings,
        }, { timeout: 8000 }).catch(e =>
          logger.warn({ session_id }, '[Baileys] Falha ao registrar LID mappings (update): %s', e.message)
        );
      }
    });

    // ── Metadados de grupos ──────────────────────────────────
    sock.ev.on('groups.upsert', (groups) => {
      const map = {};
      for (const g of groups) {
        if (g.id) map[g.id] = { id: g.id, notify: g.subject, name: g.subject, subject: g.subject };
      }
      upsertContacts(session_id, map);
      // Notifica backend para criar/atualizar conversa do grupo
      axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/contacts`, {
        session_id, contacts: Object.values(map).map(g => ({
          wa_id: g.id, name: g.subject, push_name: g.subject, is_group: true,
        })),
      }).catch(() => {});
    });

    sock.ev.on('groups.update', async (updates) => {
      const map = {};
      for (const u of updates) {
        if (u.id && u.subject) map[u.id] = { id: u.id, notify: u.subject, name: u.subject, subject: u.subject };
      }
      upsertContacts(session_id, map);

      for (const u of updates) {
        if (!u.id) continue;
        const prev = groupMetadataCache[session_id]?.[u.id];
        const notifs = [];
        if (u.subject !== undefined && prev?.subject !== undefined && u.subject !== prev.subject) {
          notifs.push(`Nome do grupo alterado para "${u.subject}"`);
        }
        if (u.desc !== undefined && prev && prev.desc !== u.desc) {
          notifs.push('Descrição do grupo atualizada');
        }
        if (u.announce !== undefined && prev && prev.announce !== u.announce) {
          notifs.push(u.announce ? 'Agora só administradores podem enviar mensagens' : 'Todos os participantes podem enviar mensagens novamente');
        }
        if (u.ephemeralDuration !== undefined && prev && prev.ephemeralDuration !== u.ephemeralDuration) {
          notifs.push(u.ephemeralDuration > 0 ? 'Mensagens temporárias ativadas' : 'Mensagens temporárias desativadas');
        }
        if (prev) Object.assign(prev, u);
        for (const text of notifs) await postGroupNotification(session_id, u.id, text);
      }
    });

    // ── Notificações de participantes (add/remove/promote/demote) ─
    sock.ev.on('group-participants.update', async ({ id, author, participants, action }) => {
      // Desde o Baileys v7, "author" continua sendo string (jid), mas cada item de
      // "participants" virou um objeto GroupParticipant { id, lid, phoneNumber, ... }
      // em vez de string crua — nameOf precisa aceitar os dois formatos, senão
      // jid.endsWith explode (TypeError) e derruba o processo (unhandledRejection).
      const nameOf = async (entry) => {
        if (!entry) return 'alguém';
        const jid = typeof entry === 'string' ? entry : (entry.phoneNumber || entry.id || entry.lid);
        if (!jid) return 'alguém';
        const resolved = jid.endsWith('@lid') ? await resolveLidJid(jid, null, session_id) : jid;
        return getContactName(session_id, resolved) || resolved.split('@')[0];
      };
      try {
        const authorName = await nameOf(author);
        const names = (await Promise.all((participants || []).map(nameOf))).join(', ');
        const ACTION_TEXT = {
          add:     `${authorName} adicionou ${names} ao grupo`,
          remove:  `${authorName} removeu ${names} do grupo`,
          promote: `${authorName} tornou ${names} administrador(a)`,
          demote:  `${authorName} removeu ${names} da administração`,
        };
        const text = ACTION_TEXT[action] || `Atualização de participantes do grupo (${action}): ${names}`;
        await postGroupNotification(session_id, id, text);
      } catch (e) {
        logger.warn({ session_id, err: e.message }, '[Baileys] Falha ao processar group-participants.update');
      }
    });

    // ── Histórico ao autenticar / sob demanda ────────────────
    // Nada e descartado: 1) backup bruto em disco SEM teto; 2) encaminhamento ao
    // backend em segundo plano (fila por sessao, atras do portao de carga). O handler
    // retorna na hora — nao segura o event loop nem a conexao.
    sock.ev.on('messaging-history.set', ({ messages: msgSet, chats: chatSet, contacts: contactSet, syncType, isLatest, progress }) => {
      const received = msgSet?.length ?? 0;
      logger.info(
        { session_id, total: received, chats: chatSet?.length ?? 0, contacts: contactSet?.length ?? 0, syncType: syncType?.toString(), isLatest, progress },
        '[Baileys] messaging-history.set',
      );
      const warn = (what) => (e) => logger.warn({ session_id, err: e.message }, `[Baileys] Backup: falha ao gravar ${what}`);
      archive.appendMeta(session_id, 'chats', chatSet).catch(warn('chats'));
      archive.appendMeta(session_id, 'contacts', contactSet).catch(warn('contatos'));
      if (!received) return;
      archive.appendMessages(session_id, msgSet, { syncType, isLatest }).catch(warn('mensagens'));
      for (const m of msgSet) storeMessage(session_id, m);
      if (HISTORY_FORWARD_ENABLED) {
        enqueueHistory(session_id, () => forwardHistoryToBackend(session_id, msgSet, { syncType: syncType?.toString() }));
      }
    });

    // ── Mensagens em tempo real ──────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      // 'notify' = received in real-time; 'append' = sent by this device
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of msgs) {
        storeMessage(session_id, msg);
        if (!msg.message) continue;
        if (await handleRevoke(session_id, msg)) continue;
        if (await handlePollVote(session_id, msg, sock)) continue;

        const _rjid = msg.key?.remoteJid || '';
        if (_rjid.endsWith('@lid')) {
          // resolveLidJid já consulta a store nativa signalRepository.lidMapping
          // (persistida no auth state) antes de cair no contactStore próprio,
          // então não é mais necessário esperar por contacts.upsert aqui.
          const _resolved = await resolveLidJid(_rjid, msg.key?.senderPn || msg.key?.pn, session_id);
          logger.info(
            {
              session_id,
              remoteJid: _rjid,
              resolved:  _resolved,
              keyPn:     msg.key?.pn ?? null,
              keyPart:   msg.key?.participant ?? null,
            },
            _resolved.endsWith('@lid')
              ? '[Baileys][LID-DIAG] LID não resolvido para telefone'
              : '[Baileys][LID-DIAG] LID resolvido para telefone',
          );
        }

        try {
          await forwardMessageToFastAPI(session_id, msg);
        } catch (e) {
          logger.warn({ session_id }, '[Baileys] Forward falhou: %s', e.message);
        }
      }
    });

    sock.ev.on('message-receipt.update', async (updates) => {
      for (const update of updates) {
        await forwardStatusUpdate(session_id, update).catch(() => {});
      }
    });

    // ── Edições de mensagem (MESSAGE_EDIT) ────────────────────
    // messages.update também carrega REVOKE e pollUpdates, mas esses já chegam
    // via messages.upsert (protocolMessage/pollUpdateMessage brutos) e são tratados
    // lá — repassar aqui de novo duplicaria a notificação no backend. Só o edit de
    // mensagem alheia não tem nenhum outro canal: só chega por aqui.
    sock.ev.on('messages.update', async (updates) => {
      for (const upd of updates) {
        const editedContent = upd.update?.message?.editedMessage?.message;
        if (!editedContent) continue;
        const wamid = upd.key?.id;
        if (!wamid) continue;
        const newText = editedContent.conversation || editedContent.extendedTextMessage?.text || '';
        await forwardEditUpdate(session_id, wamid, newText);
      }
    });

    state.starting = false;
    return buildStatusResponse(session_id);

  } catch (err) {
    state.starting = false;
    state.status   = 'error';
    logger.error({ session_id, err: err.message }, '[Baileys] Erro ao iniciar sessão');
    return { status: 'error', error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function buildStatusResponse(session_id) {
  const state = getSession(session_id);
  if (state.status === 'authenticated') return { status: 'authenticated', phone: state.phone };
  if (state.status === 'qr_required' && state.qr)
    return { status: 'qr_required', qr: state.qr, qr_string: state.qr_string };
  return { status: state.status };
}

async function waitForSocketReady(session_id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getSession(session_id);
    if (state.sock && ['qr_required', 'authenticated'].includes(state.status)) return state;
    if (state.status === 'disconnected') return null;
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

// ─── Payload / forwarding ─────────────────────────────────────

/**
 * Resolve um JID @lid para o JID de telefone correspondente.
 *
 * O WhatsApp novo sistema multidevice usa LIDs (Linked IDs, ex: "128904920580321@lid")
 * em vez de números de telefone (@s.whatsapp.net) para identificar contatos.
 * Quando o remoteJid de um chat individual é um @lid, o campo msg.key.pn
 * (phone number) tem o JID de telefone real que deve ser usado para lookup
 * de contato/conversa no banco.
 *
 * Sem essa resolução, cada resposta de um contato LID cria uma conversa nova
 * com o número LID como wa_id, em vez de encontrar a conversa existente.
 *
 * Este é o mesmo mecanismo que a Evolution API usa para resolver LIDs: a
 * store nativa `sock.signalRepository.lidMapping` do próprio Baileys, que é
 * alimentada automaticamente durante a descriptografia de mensagens/sessões
 * Signal e persistida no auth state (sobrevive a restarts). É mais confiável
 * que depender só de `contacts.upsert`, que pode chegar atrasado ou nunca
 * chegar para contatos que nunca sincronizaram a agenda.
 */
async function resolveLidJid(jid, keyPn, session_id) {
  if (!jid || !jid.endsWith('@lid')) return jid;

  // 1. lidToJidMap — populado via contacts.upsert (cache em memória, mais rápido)
  const mapped = lidToJidMap[session_id]?.[jid];
  if (mapped) return mapped;

  // 2. key.pn / key.senderPn / key.participantPn — campo que o próprio Baileys
  //    já resolve durante a descriptografia da mensagem (fonte autoritativa
  //    para ESSA mensagem específica).
  if (keyPn) {
    const resolved = keyPn.includes('@') ? keyPn : `${keyPn}@s.whatsapp.net`;
    lidToJidMap[session_id][jid] = resolved;
    saveLidMapToDB(session_id, jid, resolved);
    return resolved;
  }

  // 3. Store nativa do Baileys (signalRepository.lidMapping) — persistida no
  //    auth state, é a mesma fonte que a Evolution API consulta. Cobre casos
  //    em que esta mensagem não trouxe key.pn mas uma mensagem/sessão
  //    anterior já resolveu esse LID.
  const sock = getSession(session_id)?.sock;
  if (sock?.signalRepository?.lidMapping) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) {
        const resolved = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
        lidToJidMap[session_id][jid] = resolved;
        saveLidMapToDB(session_id, jid, resolved);
        return resolved;
      }
    } catch (e) {
      logger.warn({ jid, session_id, err: e.message }, '[Baileys] signalRepository.lidMapping.getPNForLID falhou');
    }
  }

  // 4. contactStore — pode ter phoneNumber mapeado para este LID
  const entry = contactStore[session_id]?.[jid];
  if (entry?.phone)       return entry.phone.includes('@') ? entry.phone : `${entry.phone}@s.whatsapp.net`;
  if (entry?.phoneNumber) return `${entry.phoneNumber}@s.whatsapp.net`;

  // 5. Busca reversa no contactStore: algum contato de telefone aponta para este lid?
  const store = contactStore[session_id] || {};
  for (const [storedJid, storedData] of Object.entries(store)) {
    if (storedData.lid === jid && storedJid.endsWith('@s.whatsapp.net')) {
      lidToJidMap[session_id][jid] = storedJid; // cacheia para próximas chamadas
      return storedJid;
    }
  }

  // 6. Fallback: mantém o LID. Vai criar contato com LID como wa_id.
  //    Pode acontecer antes de contacts.upsert ser processado para este contato.
  logger.warn({ jid, session_id }, '[Baileys] LID não resolvido — remoteJid ainda é @lid');
  return jid;
}

async function buildBridgePayload(session_id, msg) {
  const m          = getMessageContent(msg);
  const rawType    = detectBaileysType(msg);
  const msgType    = normalizeBaileysType(rawType);
  const isFromMe   = msg.key?.fromMe === true;
  const sub        = m[rawType] || {};
  const remoteJid  = msg.key?.remoteJid || '';
  const isGroup    = remoteJid.endsWith('@g.us');

  // Resolve LID para JID de telefone em chats individuais.
  // key.pn é o campo do Baileys com o número real quando remoteJid é @lid.
  const resolvedRemoteJid = isGroup ? remoteJid : await resolveLidJid(remoteJid, msg.key?.senderPn || msg.key?.pn, session_id);

  // Em grupos: remetente é o participante. WhatsApp usa LIDs (@lid) em vez de números reais.
  // key.participantPn tem o número real quando key.participant é um LID.
  const participantRaw = msg.key?.participant || msg.participant || null;
  const participantPn  = msg.key?.participantPn || null;
  // Resolve participante @lid usando participantPn ou lidToJidMap
  const participant = participantRaw && participantRaw.endsWith('@lid')
    ? await resolveLidJid(participantRaw, participantPn, session_id)
    : participantRaw;
  const senderJid   = isGroup
    ? (isFromMe ? null : (participant || null))
    : (isFromMe ? null : resolvedRemoteJid);
  const senderPhone = senderJid ? senderJid.split('@')[0] : null;

  // pushName = nome do REMETENTE. Para grupos, NUNCA usar nome do grupo como fallback.
  const pushName = msg.pushName
    || (senderJid ? getContactName(session_id, senderJid) : null)
    || '';

  const groupName = isGroup
    ? (getContactName(session_id, remoteJid) || '')
    : undefined;

  // Se o LID não foi resolvido para telefone, inclui o LID original para que
  // o backend tente o fallback via tabela de mapeamentos (campo lid em contacts).
  const lidUnresolved = !isGroup && !isFromMe && resolvedRemoteJid.endsWith('@lid');

  const payload = {
    bridge_provider: 'baileys',
    session_id,
    wamid:         msg.key?.id || `baileys_${Date.now()}`,
    from:          isFromMe ? 'me' : (senderPhone || resolvedRemoteJid.split('@')[0]),
    to:            isFromMe ? resolvedRemoteJid.split('@')[0] : 'me',
    direction:     isFromMe ? 'outbound' : 'inbound',
    type:          msgType,
    timestamp:     (msg.messageTimestamp || 0) * 1000,
    contact_name:  pushName,
    push_name:     pushName,
    is_group:      isGroup,
    group_jid:     isGroup ? remoteJid : undefined,
    group_name:    groupName,
    participant:   isGroup && !isFromMe ? (participant || undefined) : undefined,
    from_lid:      lidUnresolved ? resolvedRemoteJid : undefined,
  };

  if (msgType === 'text') {
    const poll = m.pollCreationMessageV3 || m.pollCreationMessageV2 || m.pollCreationMessage;
    payload.text = poll
      ? `📊 ${poll.name || 'Enquete'}\n${(poll.options || []).map(o => `☐ ${o.optionName}`).join('\n')}`
      : (m.conversation || m.extendedTextMessage?.text || '');
  }

  if (['image', 'video', 'sticker'].includes(msgType)) {
    payload.caption  = sub.caption  || '';
    payload.mimetype = sub.mimetype || '';
  }

  if (msgType === 'audio') {
    payload.mimetype = sub.mimetype || 'audio/ogg; codecs=opus';
    payload.ptt      = rawType === 'pttMessage';
  }

  if (msgType === 'document') {
    const doc = m.documentMessage || {};
    payload.caption  = doc.caption  || '';
    payload.mimetype = doc.mimetype || '';
    payload.filename = doc.fileName || doc.title || 'arquivo';
  }

  if (msgType === 'reaction') {
    const reaction = m.reactionMessage || {};
    payload.reaction_message_id = reaction.key?.id || '';
    payload.reaction_emoji      = reaction.text    || '';
  }

  if (msgType === 'location') {
    const loc = m.locationMessage || {};
    payload.location = {
      latitude:  loc.degreesLatitude  || 0,
      longitude: loc.degreesLongitude || 0,
      name:      loc.name || '',
    };
  }

  // Contato compartilhado (vCard) — nome do cartão vai em campo próprio.
  // Antes isso pisava em payload.contact_name, que o backend usa como nome
  // de quem ENVIOU a mensagem — resultado: o remetente ficava salvo no banco
  // com o nome do contato dentro do vCard em vez do nome dele mesmo.
  if (msgType === 'contact') {
    const contact = m.contactMessage || {};
    payload.vcard      = contact.vcard || '';
    payload.vcard_name = contact.displayName || '';
  }
  // Vários contatos no mesmo envio (contactsArrayMessage): um vCard por item.
  if (m.contactsArrayMessage) {
    const list = m.contactsArrayMessage.contacts || [];
    payload.vcards = list.map(c => ({ vcard: c.vcard || '', name: c.displayName || '' }));
    payload.vcard = payload.vcards.map(c => c.vcard).join('\n');
  }

  // Contexto de reply (mensagem citada)
  const ctxInfo = m.extendedTextMessage?.contextInfo
    || m.imageMessage?.contextInfo
    || m.videoMessage?.contextInfo
    || m.audioMessage?.contextInfo
    || m.documentMessage?.contextInfo
    || m.stickerMessage?.contextInfo
    || null;
  if (ctxInfo) {
    if (ctxInfo.quotedMessage && ctxInfo.stanzaId) {
      payload.reply_to_wamid  = ctxInfo.stanzaId;
      payload.reply_to_sender = ctxInfo.participant || ctxInfo.remoteJid || null;
    }
    if (ctxInfo.mentionedJid?.length) {
      payload.mentions = ctxInfo.mentionedJid;
    }
    if (ctxInfo.isForwarded) {
      payload.forwarded       = true;
      payload.forward_score   = ctxInfo.forwardingScore || 1;
    }
  }

  return payload;
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

async function downloadAndUploadMedia(session_id, msg, payload) {
  const msgType = payload.type;
  if (!MEDIA_TYPES.has(msgType)) return;

  try {
    const state = getSession(session_id);
    if (!state?.sock) return;

    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: state.sock.updateMediaMessage }
    );

    if (!buffer || buffer.length === 0) {
      logger.warn({ session_id }, '[Baileys][Media] Buffer vazio para %s', msgType);
      return;
    }

    const wamid = payload.wamid || `bridge_${Date.now()}`;
    const safeId = wamid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const mimeType = payload.mimetype || 'application/octet-stream';

    const params = new URLSearchParams({ media_id: safeId, mime_type: mimeType });
    const res = await axios.post(
      `${WEBHOOK_BASE}/api/media/bridge-upload?${params}`,
      buffer,
      {
        headers: { 'Content-Type': mimeType },
        timeout: 30000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    if (res.data?.media_url) {
      payload.media_url = res.data.media_url;
      payload.mimetype  = res.data.mime_type || mimeType;
      payload.media_id  = safeId;
      logger.info({ session_id }, '[Baileys][Media] Mídia enviada ao backend: %s', res.data.media_url);
    }
  } catch (e) {
    logger.warn({ session_id }, '[Baileys][Media] Falha ao baixar/enviar mídia: %s', e.message || e.code || String(e));
  }
}

/**
 * Voto em enquete (pollUpdateMessage). O WhatsApp trata isso como um evento
 * separado da mensagem original, não como uma mensagem de chat nova — por
 * isso ele é tratado à parte aqui em vez de passar pelo forwardMessageToFastAPI
 * normal, que criaria uma bolha "Mensagem" vazia pro voto.
 *
 * O voto chega criptografado com uma chave (messageSecret) que só existe na
 * mensagem original da enquete (pollCreationMessage*), então é preciso ter
 * essa mensagem em cache (messageStore) para conseguir decifrar — daí o
 * mesmo store usado como getMessage() do Baileys ser reaproveitado aqui.
 *
 * Retorna true se a mensagem era um voto (já tratado, não deve seguir o
 * fluxo normal), false caso contrário.
 */
/**
 * Mensagem apagada (delete-for-everyone) chega como protocolMessage dentro
 * de messages.upsert, não como um evento próprio. Antes disso virava
 * payload.type='revoke' dentro de buildBridgePayload() e seguia pro
 * /api/webhook/bridge genérico — só que "revoke" nunca foi um tipo
 * reconhecido lá (nem no BAILEYS_TYPE_MAP nem em nenhum dispatch do
 * webhook_handler), então revoked_wamid chegava e nunca era processado:
 * mensagens apagadas por um contato continuavam aparecendo normalmente.
 * Curto-circuita aqui, igual handlePollVote, e manda pra uma rota dedicada
 * (mesmo padrão de /bridge/edit) em vez de deixar cair no fluxo genérico.
 */
async function handleRevoke(session_id, msg) {
  const proto = msg.message?.protocolMessage;
  if (proto?.type !== 0 /* REVOKE */ || !proto?.key?.id) return false;
  await forwardRevokeUpdate(session_id, proto.key.id);
  return true;
}

async function handlePollVote(session_id, msg, sock) {
  const pollUpdate = msg.message?.pollUpdateMessage;
  if (!pollUpdate) return false;

  const creationMsgKey = pollUpdate.pollCreationMessageKey;
  const pollMsg = await makeGetMessage(session_id)(creationMsgKey);
  if (!pollMsg) {
    logger.warn(
      { session_id, creationMsgKey },
      '[Baileys] Voto de enquete recebido, mas a mensagem original da enquete não está no cache — voto ignorado',
    );
    return true;
  }

  try {
    // BUG anterior: construía meJid manualmente forçando "@s.whatsapp.net",
    // o que quebra quando a própria sessão é identificada por LID (comum em
    // contas novas do WhatsApp) — o número antes do "@" nesse caso é um LID,
    // não um telefone. Correção parcial: usar jidNormalizedUser(creds.me.id)
    // como o próprio Baileys faz internamente (Utils/process-message.js).
    //
    // Isso sozinho não bastou: confirmado ao vivo (log de debug) que contas
    // com "addressingMode":"lid" na mensagem do voto continuam falhando com
    // "Unsupported state or unable to authenticate data" mesmo com JIDs no
    // formato "certo" (PN) — a chave de decifragem depende de qual JID
    // (PN ou LID) o APARELHO DE QUEM VOTOU realmente usou ao computar o
    // voto, e isso não é previsível de fora (não documentado, e getKeyAuthor
    // sempre prefere PN via participantAlt/remoteJidAlt quando disponível).
    // Em vez de adivinhar, tenta as combinações plausíveis de
    // pollCreatorJid/voterJid (PN e LID, cruzadas) e usa a primeira que
    // decifrar com sucesso — decryptPollVote é só verificação de tag AEAD,
    // seguro tentar várias vezes.
    const meJidPn  = jidNormalizedUser(sock.authState?.creds?.me?.id);
    const meJidLid = sock.authState?.creds?.me?.lid ? jidNormalizedUser(sock.authState.creds.me.lid) : null;
    const voterJidPn  = getKeyAuthor(msg.key, meJidPn) || null;
    const voterJidLid = (msg.key.remoteJid || '').endsWith('@lid')
      ? jidNormalizedUser(msg.key.remoteJid)
      : ((msg.key.participant || '').endsWith('@lid') ? jidNormalizedUser(msg.key.participant) : null);

    const candidates = [
      { pollCreatorJid: meJidPn,  voterJid: voterJidPn },
      { pollCreatorJid: meJidLid, voterJid: voterJidPn },
      { pollCreatorJid: meJidPn,  voterJid: voterJidLid },
      { pollCreatorJid: meJidLid, voterJid: voterJidLid },
    ].filter(c => c.pollCreatorJid && c.voterJid);

    let vote = null;
    let lastErr = null;
    for (const cand of candidates) {
      try {
        vote = decryptPollVote(pollUpdate.vote, {
          pollEncKey: pollMsg.messageContextInfo?.messageSecret,
          pollMsgId:  creationMsgKey.id,
          ...cand,
        });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!vote) throw lastErr || new Error('Nenhuma combinação de JID decifrou o voto');

    const meJid = meJidPn;

    // Muta o pollMsg em cache (mesma referência guardada no messageStore),
    // então votos seguintes do mesmo eleitor substituem o anterior — igual
    // ao comportamento do WhatsApp (voto é sempre a seleção "atual").
    updateMessageWithPollUpdate(pollMsg, {
      pollUpdateMessageKey: msg.key,
      vote,
      senderTimestampMs: Date.now(),
    });

    const aggregate = getAggregateVotesInPollMessage(
      { message: pollMsg, pollUpdates: pollMsg.pollUpdates }, meJid,
    );
    const options = aggregate.map(o => ({ name: o.name, votes: o.voters.length }));
    const totalVoters = new Set(aggregate.flatMap(o => o.voters)).size;

    await axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/poll-vote`, {
      session_id,
      poll_wamid: creationMsgKey.id,
      options,
      total_voters: totalVoters,
    }, { timeout: 8000 });
  } catch (e) {
    logger.warn(
      { session_id, creationMsgKey, err: e.message },
      '[Baileys] Falha ao decifrar voto de enquete',
    );
  }
  return true;
}

async function forwardMessageToFastAPI(session_id, msg) {
  const payload = await buildBridgePayload(session_id, msg);

  // Baixa o binário e sobe pro backend nos dois sentidos. Antes só cobria
  // 'inbound' — mensagens ENVIADAS por nós (via bridge direto/API, fora do
  // fluxo de upload real da UI) chegavam de verdade no destinatário mas
  // nunca ganhavam media_url própria; o front só mostrava "[Video]"/
  // "[Audio]" genérico. downloadMediaMessage() usa as chaves de mídia já
  // embutidas na própria mensagem (não depende de nenhum lookup em cache
  // tipo Msg.get(), então não sofre do mesmo problema visto no wa-web.js).
  if (MEDIA_TYPES.has(payload.type)) {
    await downloadAndUploadMedia(session_id, msg, payload);
  }

  try {
    await axios.post(`${WEBHOOK_BASE}/api/webhook/bridge`, payload, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const detail = e.response
      ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}`
      : (e.message || e.code || String(e));
    logger.warn({ session_id }, '[Baileys] Forward falhou: %s', detail);
  }
}

async function forwardStatusUpdate(session_id, update) {
  await axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/status`, {
    bridge_provider: 'baileys',
    session_id,
    message_id: update.key?.id,
    receipts:   update.receipt,
  }, { timeout: 5000 }).catch(() => {});
}

async function forwardRevokeUpdate(session_id, revokedWamid) {
  try {
    await axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/revoke`, {
      bridge_provider: 'baileys',
      session_id,
      revoked_wamid: revokedWamid,
    }, { timeout: 5000 });
  } catch (e) {
    logger.warn({ session_id }, '[Baileys] Falha ao encaminhar revogação: %s', e.message);
  }
}

async function forwardEditUpdate(session_id, wamid, newText) {
  try {
    await axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/edit`, {
      bridge_provider: 'baileys',
      session_id,
      wamid,
      new_text: newText,
    }, { timeout: 5000 });
  } catch (e) {
    logger.warn({ session_id, wamid }, '[Baileys] Falha ao notificar edição de mensagem: %s', e.message);
  }
}

// ─── App Express ──────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Encaminhamento de historico + backup (endpoints) ───────────
async function mapHistoryMessage(session_id, m) {
  const jid = m.key?.remoteJid || '';
  if (!jid || !m.message) return null;
  const isGroup     = jid.endsWith('@g.us');
  const isFromMe    = m.key?.fromMe === true;
  const rawType     = detectBaileysType(m);
  const msgType     = normalizeBaileysType(rawType);
  const content     = getMessageContent(m);
  const sub         = content[rawType] || {};
  const participantRaw = m.key?.participant || m.participant || null;
  const participantPn  = m.key?.participantPn || null;
  const participant = participantRaw && participantRaw.endsWith('@lid')
    ? await resolveLidJid(participantRaw, participantPn, session_id)
    : participantRaw;
  const resolvedJid = isGroup ? jid : await resolveLidJid(jid, m.key?.senderPn || m.key?.pn, session_id);
  const senderJid   = isGroup
    ? (isFromMe ? null : (participant || null))
    : (isFromMe ? null : resolvedJid);
  const senderPhone = senderJid ? senderJid.split('@')[0] : null;
  const pushName = m.pushName
    || (senderJid ? getContactName(session_id, senderJid) : null)
    || '';
  return {
    session_id,
    wamid:         m.key?.id || `baileys_${Date.now()}_${Math.random()}`,
    from:          isFromMe ? 'me' : (senderPhone || resolvedJid.split('@')[0]),
    to:            isFromMe ? resolvedJid.split('@')[0] : 'me',
    direction:     isFromMe ? 'outbound' : 'inbound',
    type:          msgType,
    timestamp:     tsOf(m) * 1000,
    text:          content.conversation || content.extendedTextMessage?.text || sub.caption || '',
    contact_name:  pushName,
    push_name:     pushName,
    is_group:      isGroup,
    group_jid:     isGroup ? jid : undefined,
    group_name:    isGroup ? (getContactName(session_id, jid) || '') : undefined,
    participant:   isGroup && !isFromMe ? (participant || undefined) : undefined,
  };
}

/**
 * Encaminha mensagens ao backend sem teto, mais recentes primeiro, em fatias, cada
 * pedaco atras do portao de carga. Falha persistente NAO perde dado: o backup em
 * disco ja tem tudo e POST /backup/replay reenvia depois (backend deduplica por wamid).
 */
async function forwardHistoryToBackend(session_id, msgSet, { syncType = null } = {}) {
  const relevant = msgSet
    .filter(m => m.message && m.key?.remoteJid)
    .sort((a, b) => tsOf(b) - tsOf(a));
  const SLICE = 200;
  let sent = 0, failed = 0;
  for (let i = 0; i < relevant.length; i += SLICE) {
    const slice = relevant.slice(i, i + SLICE);
    const batch = [];
    for (const m of slice) {
      try { const mapped = await mapHistoryMessage(session_id, m); if (mapped) batch.push(mapped); }
      catch (e) { logger.warn({ session_id, err: e.message }, '[Baileys] Historico: mensagem nao mapeada'); }
    }
    if (batch.length) {
      const res = await postHistoryBatch(WEBHOOK_BASE, { session_id, messages: batch }, {
        log: (msg) => logger.info({ session_id }, `[Baileys] Historico: ${msg}`),
      });
      if (res.ok) sent += res.sent;
      else {
        failed += slice.length;
        logger.warn({ session_id, reason: res.reason }, '[Baileys] Historico: lote nao aceito pelo backend — segue no backup (use POST /backup/replay)');
      }
    }
    await new Promise(r => setImmediate(r)); // cede o event loop entre fatias
  }
  logger.info({ session_id, syncType, total: relevant.length, sent, failed }, '[Baileys] Historico encaminhado ao backend');
}

app.get('/backup/status', async (req, res) => {
  const session_id = req.query.session_id || 'default';
  const idx = await archive.getIndex(session_id);
  const chats = Object.entries(idx.chats).map(([jid, c]) => ({ jid, ...c }))
    .sort((a, b) => (b.newest || 0) - (a.newest || 0));
  res.json({
    session_id,
    profile: HISTORY_FULL ? 'full' : 'default',
    backup_dir: archive.sessionDir(session_id),
    totals: idx.totals,
    chats: chats.slice(0, parseInt(req.query.limit || '200', 10)),
    chats_total: chats.length,
    last_events: idx.events.slice(-20),
  });
});

// Pacote completo do backup (tar.gz em streaming): mensagens, chats, contatos, midia, index.
app.get('/backup/download', (req, res) => {
  const session_id = req.query.session_id || 'default';
  const dir = archive.sessionDir(session_id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Sem backup para esta sessão.' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="backup-${session_id}-${new Date().toISOString().slice(0, 10)}.tar.gz"`);
  const tar = spawn('tar', ['-czf', '-', '-C', dir, '.']);
  tar.stdout.pipe(res);
  tar.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.destroy(e); });
  req.on('close', () => tar.kill());
});

// Pede ao celular mensagens mais antigas de UM chat (aparece como syncType ON_DEMAND).
app.post('/backup/history/fetch', async (req, res) => {
  const { session_id = 'default', jid, count = 50 } = req.body || {};
  try {
    if (!jid) return res.status(400).json({ error: 'jid obrigatório' });
    const sock = requireSock(session_id);
    const oldest = await archive.oldestKey(session_id, jid);
    if (!oldest) return res.status(404).json({ error: 'Chat sem mensagens no backup — não há âncora para paginar.' });
    const reqId = await sock.fetchMessageHistory(
      Math.min(Math.max(parseInt(count, 10) || 50, 1), 50),
      { remoteJid: jid, id: oldest.id, fromMe: oldest.fromMe },
      oldest.ts * 1000,
    );
    res.json({ success: true, request_id: reqId, anchor: oldest, note: 'Resposta chega assincronamente (messaging-history.set, ON_DEMAND).' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reenvia o backup (um chat ou todos) ao backend — restaura o que o portao recusou.
const replayRunning = new Set();
app.post('/backup/replay', async (req, res) => {
  const { session_id = 'default', jid } = req.body || {};
  if (replayRunning.has(session_id)) return res.status(409).json({ error: 'Replay já em andamento para esta sessão.' });
  const idx = await archive.getIndex(session_id);
  const jids = jid ? [jid] : Object.keys(idx.chats);
  if (!jids.length) return res.status(404).json({ error: 'Backup vazio.' });
  replayRunning.add(session_id);
  res.json({ success: true, chats: jids.length, note: 'Executando em segundo plano.' });
  (async () => {
    try {
      for (const j of jids) {
        const msgs = await archive.readChatMessages(session_id, j);
        await enqueueHistory(session_id, () => forwardHistoryToBackend(session_id, msgs, { syncType: 'REPLAY' }));
      }
    } catch (e) {
      logger.error({ session_id, err: e.message }, '[Baileys] Replay falhou');
    } finally {
      replayRunning.delete(session_id);
    }
  })();
});

// Baixa a midia de UMA mensagem do backup (sob demanda) e guarda ao lado do backup.
app.post('/backup/media', async (req, res) => {
  const { session_id = 'default', jid, id } = req.body || {};
  try {
    if (!jid || !id) return res.status(400).json({ error: 'jid e id obrigatórios' });
    const sock = requireSock(session_id);
    const msgs = await archive.readChatMessages(session_id, jid);
    const m = msgs.find(x => x.key?.id === id);
    if (!m) return res.status(404).json({ error: 'Mensagem não encontrada no backup.' });
    const buf = await downloadMediaMessage(m, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage,
    });
    const content = getMessageContent(m);
    const mime = (Object.values(content).find(v => v && v.mimetype) || {}).mimetype || 'application/octet-stream';
    const ext = (mime.split('/')[1] || 'bin').split(';')[0].replace(/[^a-z0-9]/gi, '') || 'bin';
    const file = archive.mediaPath(session_id, jid, id, ext);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    res.json({ success: true, file, bytes: buf.length, mimetype: mime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  const sessionList = [];
  for (const [sid, state] of sessions.entries()) {
    sessionList.push({ session_id: sid, status: state.status, phone: state.phone });
  }
  res.json({
    service:      'baileys-bridge',
    port:         PORT,
    sessions:     sessions.size,
    session_list: sessionList,
    webhook_base: WEBHOOK_BASE,
    ok:           true,
  });
});

app.post('/session/init', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try { res.json(await startSession(session_id)); }
  catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

app.get('/session/status', (req, res) => {
  const session_id = req.query.session_id || 'default';
  const state = getSession(session_id);
  res.json({
    status:        state.status,
    authenticated: state.status === 'authenticated',
    phone:         state.phone,
  });
});

app.get('/session/qr', async (req, res) => {
  const session_id = req.query.session_id || 'default';
  const state = getSession(session_id);

  if (state.status === 'qr_required' && state.qr)
    return res.json({ status: 'qr_required', qr: state.qr, qr_string: state.qr_string });

  if (state.status === 'authenticated')
    return res.json({ status: 'authenticated', phone: state.phone });

  if (['disconnected', 'idle', 'error'].includes(state.status) && !state.starting) {
    startSession(session_id).catch(e =>
      logger.error({ session_id }, '[Baileys] startSession falhou: %s', e.message),
    );
  }

  const ready = await waitForSocketReady(session_id, 15000);
  if (ready?.status === 'qr_required' && ready.qr)
    return res.json({ status: 'qr_required', qr: ready.qr, qr_string: ready.qr_string });
  if (ready?.status === 'authenticated')
    return res.json({ status: 'authenticated', phone: ready.phone });

  res.json(buildStatusResponse(session_id));
});

app.post('/session/logout', async (req, res) => {
  const { session_id = 'default' } = req.body;
  const state = getSession(session_id);
  try {
    if (state.sock) { await state.sock.logout().catch(() => {}); state.sock = null; }
    if (state.deleteSession) await state.deleteSession().catch(() => {});
    Object.assign(state, {
      status: 'disconnected', phone: null, qr: null, qr_string: null,
      starting: false, reconnectCount: 0,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Sessão dedicada para pairing code ───────────────────────

// ─── Sessão dedicada para pairing code ───────────────────────

async function startSessionForPairingCode(session_id, phone_number) {
  const state = getSession(session_id);

  // Mata qualquer sessão existente
  if (state.sock) {
    await state.sock.logout().catch(() => {});
    state.sock = null;
  }
  if (state.deleteSession) {
    await state.deleteSession().catch(() => {});
  }
  Object.assign(state, {
    status: 'idle', qr: null, qr_string: null,
    starting: false, reconnectCount: 0, pairingCode: null,
  });
  await new Promise(r => setTimeout(r, 800));

  state.starting = true;
  state.status   = 'starting';

  await initMySQLPool();

  const { state: authState, saveCreds, deleteSession } =
    await useHybridAuthState(session_id, mysqlPool, SESSIONS_DIR);

  state.deleteSession = deleteSession;
  const version = await getWAVersion();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      // Limpeza automática no timeout
      if (state.deleteSession) await state.deleteSession().catch(() => {});
      Object.assign(state, { status: 'disconnected', sock: null, starting: false });
      reject(new Error('Timeout — WhatsApp não respondeu em 30s'));
    }, 30000);

    const sock = makeWASocket({
      version,
      auth:                authState,
      printQRInTerminal:   false,
      logger:              pino({ level: 'silent' }),
      browser:             ['Chrome (Linux)', 'Chrome', '120.0.0'],
      connectTimeoutMs:    30_000,
      keepAliveIntervalMs: 15_000,
      syncFullHistory:     HISTORY_FULL,   // backup nao bloqueia (assincrono + atras do portao)
      getMessage:          makeGetMessage(session_id),
    });

    state.sock = sock;
    let codeRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

      // ── Momento certo: logo que o socket conecta, ANTES do QR ──
      if (connection === 'connecting' && !codeRequested) {
        codeRequested = true;
        try {
          await new Promise(r => setTimeout(r, 1500)); // aguarda handshake
          const digits = phone_number.replace(/\D/g, '');
          const code   = await sock.requestPairingCode(digits);
          const fmt    = code?.length === 8 ? `${code.slice(0,4)}-${code.slice(4)}` : code;
          state.pairingCode = fmt;
          state.starting    = false;
          clearTimeout(timeout);
          logger.info({ session_id, digits }, '[Baileys] Pairing code gerado ');
          resolve(fmt);
        } catch (err) {
          // Se falhou no pairing, limpa tudo automaticamente
          clearTimeout(timeout);
          if (state.deleteSession) await state.deleteSession().catch(() => {});
          Object.assign(state, { status: 'disconnected', sock: null, starting: false });
          reject(new Error(`requestPairingCode falhou: ${err.message}`));
        }
        return;
      }

      if (connection === 'open') {
        state.status = 'authenticated';
        state.phone  = sock.user?.id?.split(':')[0] || null;
        state.starting = false;
        clearTimeout(timeout);
        if (!state.pairingCode) resolve(null);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message || 'Connection Closed';

        // Auto-limpeza sempre que fechar sem autenticar
        if (state.status !== 'authenticated') {
          logger.warn({ session_id }, '[Baileys] Sessão fechada sem autenticar — limpando creds');
          if (state.deleteSession) await state.deleteSession().catch(() => {});
          Object.assign(state, {
            status: 'disconnected', sock: null, phone: null,
            qr: null, qr_string: null, starting: false, reconnectCount: 0,
          });
          if (!state.pairingCode) {
            clearTimeout(timeout);
            reject(new Error(msg));
          }
        } else if (sessionInvalidated(statusCode)) {
          if (state.deleteSession) await state.deleteSession().catch(() => {});
          Object.assign(state, {
            status: 'disconnected', sock: null, phone: null,
            qr: null, qr_string: null, starting: false, reconnectCount: 0,
          });
        }
      }
    });
  });
}

// ─── Endpoint pairing code ────────────────────────────────────

app.post('/session/pairing-code', async (req, res) => {
  const { session_id = 'default', phone_number } = req.body;
  if (!phone_number)
    return res.status(400).json({ success: false, error: 'phone_number obrigatório' });

  const state = getSession(session_id);
  if (state.status === 'authenticated')
    return res.status(400).json({ success: false, error: 'Sessão já autenticada.' });

  try {
    const code = await startSessionForPairingCode(session_id, phone_number);

    if (!code)
      return res.status(503).json({ success: false, error: 'Sessão autenticou sem retornar código.' });

    logger.info({ session_id, phone_number }, '[Baileys] Pairing code entregue');
    res.json({ success: true, code, expires_in: 60 });

  } catch (err) {
    logger.error({ session_id, err: err.message }, '[Baileys] Erro ao gerar pairing code');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Envio de mensagens ───────────────────────────────────────

function requireSock(session_id) {
  const state = getSession(session_id);
  if (!state.sock || state.status !== 'authenticated')
    throw new Error('Sessão não autenticada.');
  return state.sock;
}

// Baileys WAMediaUpload aceita: Buffer | { url } | { stream: Readable }
// Passar { stream } evita o bug "Cannot read properties of undefined (reading 'toString')"
// que ocorre no caminho de Buffer em Baileys 6.7.x durante o upload para o CDN do WhatsApp.
function toStream(base64_data, url) {
  if (base64_data) return { stream: Readable.from(Buffer.from(base64_data, 'base64')) };
  return { url };
}

// Gera a miniatura JPEG nós mesmos, a partir do buffer original (antes de virar
// stream de uso único). Isso evita que o Baileys tente ler o stream uma segunda
// vez internamente para extrair a thumbnail — leitura que chega vazia e faz o
// sharp falhar com "Input file contains unsupported image format", deixando a
// imagem presa em "Aguardando mensagem" no destinatário. Passando `jpegThumbnail`
// já pronto, o Baileys pula essa etapa (ver messages.js: requiresThumbnailComputation).
// Handlers de mídia crasham o processo inteiro quando recebem `{ url: '' }`
// sem base64_data (Baileys tenta abrir um caminho de arquivo vazio e a
// exceção escapa do try/catch da rota). Validar a origem da mídia antes de
// chamar sock.sendMessage evita esse crash.
function hasMediaSource(base64_data, url) {
  return Boolean(base64_data) || Boolean(url);
}

async function buildImageMeta(base64_data) {
  if (!base64_data) return {};
  try {
    const buffer = Buffer.from(base64_data, 'base64');
    const img = sharp(buffer);
    const [{ width, height }, thumbBuf] = await Promise.all([
      img.metadata(),
      sharp(buffer).resize(32).jpeg({ quality: 50 }).toBuffer(),
    ]);
    return { jpegThumbnail: thumbBuf.toString('base64'), width, height };
  } catch (err) {
    logger.warn({ err: err.message }, '[Baileys] Falha ao pré-gerar thumbnail/dimensões — deixando o Baileys tentar por conta própria');
    return {};
  }
}

// Para imagem, usamos Buffer em vez do { stream } de toStream(): um Buffer
// pode ser lido múltiplas vezes sem corrida, e como já fornecemos jpegThumbnail
// e width/height nós mesmos, o Baileys não precisa mais tocar no conteúdo da
// imagem para extrair metadados — só para o upload/criptografia em si.
function toImageInput(base64_data, url) {
  if (base64_data) return Buffer.from(base64_data, 'base64');
  return { url };
}

function toJID(to) {
  if (String(to).includes('@')) return String(to);
  let digits = String(to).replace(/\D/g, '');
  // IDs de grupo do WhatsApp (18-20 dígitos) são bem mais longos que qualquer
  // número de telefone real (máx. 15 dígitos no padrão E.164). Se algum
  // chamador esqueceu de mandar a JID completa (.../@g.us) para um grupo,
  // isso evita construir uma JID de usuário individual inválida — que o
  // Baileys aceita silenciosamente sem entregar a mensagem a ninguém.
  if (digits.length > 15) {
    return `${digits}@g.us`;
  }
  // Normalização Brasil: adiciona código de país 55 para números sem código de país
  if (digits.length <= 11 && !digits.startsWith('55')) {
    digits = '55' + digits;
  }
  return `${digits}@s.whatsapp.net`;
}

// Resolve o JID real via onWhatsApp(), com normalização brasileira e variante +/- 9
async function resolveJID(sock, phone) {
  let clean = String(phone).replace(/\D/g, '');
  if (clean.length <= 11 && !clean.startsWith('55')) clean = '55' + clean;

  const [r1] = await sock.onWhatsApp(clean);
  logger.info({ phone: clean, onWhatsAppResult: r1 }, '[Baileys] resolveJID onWhatsApp result');
  if (r1?.exists && r1?.jid) return { jid: r1.jid, clean, lid: r1.lid };

  // Tenta variante com/sem dígito 9 (Brasil: 55+DDD+9+8d ↔ 55+DDD+8d)
  const alt = clean.length === 13 && clean[4] === '9'
    ? clean.slice(0, 4) + clean.slice(5)
    : clean.length === 12
      ? clean.slice(0, 4) + '9' + clean.slice(4)
      : null;
  if (alt) {
    const [r2] = await sock.onWhatsApp(alt);
    if (r2?.exists && r2?.jid) return { jid: r2.jid, clean };
  }
  return { jid: null, clean };
}

// Builds a quoted-message stub from a WAMID so Baileys shows the reply indicator.
// fromMe must match the direction of the quoted message for WhatsApp to display it correctly.
// The conversation field uses a non-empty placeholder so proto3 does not omit it during
// serialization, which would cause WhatsApp to ignore the reply context.
function buildQuoted(replyToId, remoteJid, fromMe = false) {
  if (!replyToId) return undefined;
  return { key: { id: replyToId, remoteJid, fromMe: !!fromMe }, message: { conversation: ' ' } };
}

// BUG (2026-09-10, confirmado ao vivo): toJID() monta a JID só formatando
// dígitos, sem NUNCA consultar o WhatsApp — pra um contato cujo LID ainda
// não foi resolvido do lado do WPPConnect (ver project_lid_first_contact),
// mandar pra "<digits>@s.whatsapp.net" às cegas faz o sendMessage() resolver
// com sucesso (key/id sintético devolvido, mensagem marcada como SENT no
// banco) mas a mensagem nunca chega no aparelho real do cliente — o
// WhatsApp aceita no nível de protocolo sem conseguir rotear de verdade.
// resolveJID() (já usada em outro lugar deste arquivo pra participantes de
// grupo) faz a coisa certa: consulta sock.onWhatsApp() primeiro, que
// devolve o JID/LID resolvido de verdade quando existe. Só pula essa
// consulta quando `to` já vem como JID completo (grupo @g.us, ou LID já
// resolvido por outra parte do código) — nesses casos toJID() já é
// suficiente e resolveJID() nem serve (não lida com grupos).
async function resolveSendJID(sock, to) {
  if (String(to).includes('@')) return toJID(to);
  const resolved = await resolveJID(sock, to);
  return resolved.jid || toJID(to);
}

app.post('/send/text', async (req, res) => {
  const { session_id = 'default', to, text, reply_to, reply_to_from_me = false, preview_url = false, mentions } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const opts = reply_to ? { quoted: buildQuoted(reply_to, jid, reply_to_from_me) } : {};

    if (preview_url) {
      const match = text.match(/https?:\/\/[^\s]+/);
      if (match) {
        try {
          const urlInfo = await getUrlInfo(match[0]);
          if (urlInfo) opts.linkPreview = urlInfo;
        } catch (e) {
          logger.warn({ session_id, url: match[0], err: e.message }, '[Baileys] Falha ao gerar link preview');
        }
      }
    }

    const messageContent = { text };
    if (Array.isArray(mentions) && mentions.length) {
      messageContent.mentions = mentions.map(toJID);
    }

    const result = await sock.sendMessage(jid, messageContent, opts);
    if (result?.key?.remoteJid?.endsWith('@lid')) {
      if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
      const digits = String(to).replace(/\D/g, '');
      lidToJidMap[session_id][result.key.remoteJid] = `${digits}@s.whatsapp.net`;
      logger.info({ lid: result.key.remoteJid, phone: digits, session_id }, '[Baileys] LID→phone mapeado via sendMessage');
      saveLidMapToDB(session_id, result.key.remoteJid, `${digits}@s.whatsapp.net`);
    }
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/image', async (req, res) => {
  const { session_id = 'default', to, url, caption = '', reply_to, reply_to_from_me = false, base64_data, mimetype } = req.body;
  if (!hasMediaSource(base64_data, url)) return res.status(400).json({ success: false, error: 'Informe "url" ou "base64_data" com a mídia.' });
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const opts = reply_to ? { quoted: buildQuoted(reply_to, jid, reply_to_from_me) } : {};
    const media = toImageInput(base64_data, url);
    const { jpegThumbnail, width, height } = await buildImageMeta(base64_data);
    const result = await sock.sendMessage(jid, { image: media, caption, mimetype: mimetype || undefined, jpegThumbnail, width, height }, opts);
    if (result?.key?.remoteJid?.endsWith('@lid')) {
      if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
      const digits = String(to).replace(/\D/g, '');
      lidToJidMap[session_id][result.key.remoteJid] = `${digits}@s.whatsapp.net`;
      logger.info({ lid: result.key.remoteJid, phone: digits, session_id }, '[Baileys] LID→phone mapeado via sendMessage');
      saveLidMapToDB(session_id, result.key.remoteJid, `${digits}@s.whatsapp.net`);
    }
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/document', async (req, res) => {
  const { session_id = 'default', to, url, filename = 'arquivo', mimetype = 'application/octet-stream', caption = '', reply_to, reply_to_from_me = false, base64_data } = req.body;
  if (!hasMediaSource(base64_data, url)) return res.status(400).json({ success: false, error: 'Informe "url" ou "base64_data" com a mídia.' });
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const opts = reply_to ? { quoted: buildQuoted(reply_to, jid, reply_to_from_me) } : {};
    const media = toStream(base64_data, url);
    const result = await sock.sendMessage(jid, { document: media, fileName: filename, mimetype, caption }, opts);
    if (result?.key?.remoteJid?.endsWith('@lid')) {
      if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
      const digits = String(to).replace(/\D/g, '');
      lidToJidMap[session_id][result.key.remoteJid] = `${digits}@s.whatsapp.net`;
      logger.info({ lid: result.key.remoteJid, phone: digits, session_id }, '[Baileys] LID→phone mapeado via sendMessage');
      saveLidMapToDB(session_id, result.key.remoteJid, `${digits}@s.whatsapp.net`);
    }
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/video', async (req, res) => {
  const { session_id = 'default', to, url, caption = '', reply_to, reply_to_from_me = false, base64_data, mimetype } = req.body;
  if (!hasMediaSource(base64_data, url)) return res.status(400).json({ success: false, error: 'Informe "url" ou "base64_data" com a mídia.' });
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const opts = reply_to ? { quoted: buildQuoted(reply_to, jid, reply_to_from_me) } : {};
    const media = toStream(base64_data, url);
    const result = await sock.sendMessage(jid, { video: media, caption, mimetype: mimetype || undefined }, opts);
    if (result?.key?.remoteJid?.endsWith('@lid')) {
      if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
      const digits = String(to).replace(/\D/g, '');
      lidToJidMap[session_id][result.key.remoteJid] = `${digits}@s.whatsapp.net`;
      logger.info({ lid: result.key.remoteJid, phone: digits, session_id }, '[Baileys] LID→phone mapeado via sendMessage');
      saveLidMapToDB(session_id, result.key.remoteJid, `${digits}@s.whatsapp.net`);
    }
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/audio', async (req, res) => {
  const { session_id = 'default', to, url, reply_to, reply_to_from_me = false, base64_data, mimetype } = req.body;
  if (!hasMediaSource(base64_data, url)) return res.status(400).json({ success: false, error: 'Informe "url" ou "base64_data" com a mídia.' });
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const opts = reply_to ? { quoted: buildQuoted(reply_to, jid, reply_to_from_me) } : {};
    // Audio PTT requires Buffer (not stream) for reliable upload in Baileys
    const audioBuffer = base64_data ? Buffer.from(base64_data, 'base64') : null;
    const media = audioBuffer || { url };
    const effectiveMime = mimetype || 'audio/ogg; codecs=opus';
    logger.info({ session_id, to: jid, bytes: audioBuffer?.length, mime: effectiveMime }, '[send/audio] enviando PTT');
    const result = await sock.sendMessage(jid, { audio: media, mimetype: effectiveMime, ptt: true }, opts);
    logger.info({ message_id: result?.key?.id }, '[send/audio] enviado ');
    if (result?.key?.remoteJid?.endsWith('@lid')) {
      if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
      const digits = String(to).replace(/\D/g, '');
      lidToJidMap[session_id][result.key.remoteJid] = `${digits}@s.whatsapp.net`;
      logger.info({ lid: result.key.remoteJid, phone: digits, session_id }, '[Baileys] LID→phone mapeado via sendMessage');
      saveLidMapToDB(session_id, result.key.remoteJid, `${digits}@s.whatsapp.net`);
    }
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) {
    logger.error({ err: err.message }, '[send/audio] erro ❌');
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/send/sticker', async (req, res) => {
  const { session_id = 'default', to, url, reply_to, reply_to_from_me = false, base64_data, mimetype } = req.body;
  if (!hasMediaSource(base64_data, url)) return res.status(400).json({ success: false, error: 'Informe "url" ou "base64_data" com a mídia.' });
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const opts = reply_to ? { quoted: buildQuoted(reply_to, jid, reply_to_from_me) } : {};
    const media = toStream(base64_data, url);
    const result = await sock.sendMessage(jid, { sticker: media, mimetype: mimetype || 'image/webp' }, opts);
    if (result?.key?.remoteJid?.endsWith('@lid')) {
      if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
      const digits = String(to).replace(/\D/g, '');
      lidToJidMap[session_id][result.key.remoteJid] = `${digits}@s.whatsapp.net`;
      logger.info({ lid: result.key.remoteJid, phone: digits, session_id }, '[Baileys] LID→phone mapeado via sendMessage');
      saveLidMapToDB(session_id, result.key.remoteJid, `${digits}@s.whatsapp.net`);
    }
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/reaction', async (req, res) => {
  const { session_id = 'default', to, message_id, emoji, from_me = false } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const result = await sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: message_id, fromMe: !!from_me } }
    });
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Mensagens avançadas ──────────────────────────────────────

app.post('/send/gif', async (req, res) => {
  const { session_id = 'default', to, url, caption = '', base64_data, reply_to, reply_to_from_me = false } = req.body;
  if (!hasMediaSource(base64_data, url)) return res.status(400).json({ success: false, error: 'Informe "url" ou "base64_data" com a mídia.' });
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const opts = reply_to ? { quoted: buildQuoted(reply_to, jid, reply_to_from_me) } : {};
    const media = toStream(base64_data, url);
    const result = await sock.sendMessage(jid, { video: media, caption, gifPlayback: true, mimetype: 'video/mp4' }, opts);
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/view-once', async (req, res) => {
  const { session_id = 'default', to, media_type, url, caption = '', base64_data, mimetype } = req.body;
  if (!hasMediaSource(base64_data, url)) return res.status(400).json({ success: false, error: 'Informe "url" ou "base64_data" com a mídia.' });
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    let msg;
    if (media_type === 'video') {
      msg = { video: toStream(base64_data, url), caption, viewOnce: true, mimetype: mimetype || 'video/mp4' };
    } else {
      const { jpegThumbnail, width, height } = await buildImageMeta(base64_data);
      msg = { image: toImageInput(base64_data, url), caption, viewOnce: true, mimetype: mimetype || 'image/jpeg', jpegThumbnail, width, height };
    }
    const result = await sock.sendMessage(jid, msg);
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/poll', async (req, res) => {
  const { session_id = 'default', to, question, options, selectable_count = 1 } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const result = await sock.sendMessage(jid, {
      poll: { name: question, values: options, selectableCount: selectable_count }
    });
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
// BUG conhecido: LocationMessage do protocolo WhatsApp tem um campo
// jpegThumbnail (confirmado no .d.ts do baileys) — sem ele, o WhatsApp do
// destinatário mostra um preview preto/em branco em vez do mapa (a
// localização em si funciona, o mapa oficial só desenha o preview client-side
// a partir desse campo). Busca um tile real do OpenStreetMap + desenha um
// marcador simples por cima via sharp, converte pra JPEG. Falha aqui não
// deve bloquear o envio — se der erro, manda sem thumbnail (como antes).
async function buildLocationThumbnail(latitude, longitude) {
  try {
    const zoom = 15;
    const n = Math.pow(2, zoom);
    const x = Math.floor((longitude + 180) / 360 * n);
    const latRad = latitude * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);

    const tileResp = await axios.get(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 'User-Agent': 'wpp-platform-bridge/1.0 (location thumbnail)' },
    });

    const markerSvg = Buffer.from(
      `<svg width="256" height="256"><circle cx="128" cy="128" r="9" fill="#FF3B30" stroke="white" stroke-width="3"/></svg>`
    );

    return await sharp(Buffer.from(tileResp.data))
      .composite([{ input: markerSvg, top: 0, left: 0 }])
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (e) {
    logger.warn({ err: e.message }, '[Baileys] Falha ao gerar thumbnail de localização');
    return null;
  }
}

app.post('/send/location', async (req, res) => {
  const { session_id = 'default', to, latitude, longitude, name = '' } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const jpegThumbnail = await buildLocationThumbnail(latitude, longitude);
    const locationPayload = { degreesLatitude: latitude, degreesLongitude: longitude, name };
    if (jpegThumbnail) locationPayload.jpegThumbnail = jpegThumbnail;
    const result = await sock.sendMessage(jid, { location: locationPayload });
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


app.post('/send/contact', async (req, res) => {
  const { session_id = 'default', to, contacts } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    // Aceita tanto o formato simples ({ full_name, phones: [{number}] })
    // quanto o formato Meta Cloud API ({ name: { formatted_name }, phones: [{phone}] })
    // usado pelo endpoint /api/send/contacts do backend.
    const displayNameOf = (c) => c.full_name || c.name?.formatted_name || c.name || 'Contato';
    const phoneOf = (c) => (c.phones?.[0]?.number || c.phones?.[0]?.phone || c.phone || '').replace(/\D/g, '');

    const invalid = contacts.find(c => !phoneOf(c));
    if (invalid) {
      return res.status(400).json({ success: false, error: 'Contato sem telefone válido.' });
    }

    const vcards = contacts.map(c => {
      const name = displayNameOf(c);
      const phone = phoneOf(c);
      // WhatsApp exige a propriedade N (nome estruturado), não só FN — sem ela o
      // vCard costuma chegar sem nome ou ser descartado silenciosamente pelo
      // parser do WhatsApp. Formato N: Sobrenome;Nome;;; (usamos o nome inteiro
      // no primeiro campo já que só temos o nome completo).
      return `BEGIN:VCARD\nVERSION:3.0\nN:${name};;;;\nFN:${name}\nTEL;type=CELL:+${phone}\nEND:VCARD`;
    });
    const payload = contacts.length === 1
      ? { contacts: { displayName: displayNameOf(contacts[0]), contacts: [{ vcard: vcards[0] }] } }
      : { contacts: { displayName: `${contacts.length} contatos`, contacts: vcards.map(v => ({ vcard: v })) } };
    const result = await sock.sendMessage(jid, payload);
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/send/forward', async (req, res) => {
  const { session_id = 'default', to, message_id } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    // Recupera a mensagem completa (key + message) do store local para encaminhar
    const msg = fullMessageStore[session_id]?.[message_id];
    if (!msg) return res.status(404).json({ success: false, error: 'Mensagem não encontrada no store local.' });
    const result = await sock.sendMessage(jid, { forward: msg, force: true });
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Editar / Apagar / Fixar / Favoritar ─────────────────────

app.post('/message/edit', async (req, res) => {
  const { session_id = 'default', to, message_id, new_text } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    const result = await sock.sendMessage(jid, {
      edit: { remoteJid: jid, id: message_id, fromMe: true },
      text: new_text
    });
    res.json({ success: true, message_id: result?.key?.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/message/delete', async (req, res) => {
  const { session_id = 'default', to, message_id, for_everyone = true } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    if (for_everyone) {
      await sock.sendMessage(jid, { delete: { remoteJid: jid, id: message_id, fromMe: true } });
    } else {
      await sock.chatModify({ clear: { messages: [{ id: message_id, fromMe: true }] } }, jid);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/message/pin', async (req, res) => {
  const { session_id = 'default', to, message_id, duration = 604800 } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    await sock.sendMessage(jid, {
      pin: { type: 1, time: duration },
      key: { remoteJid: jid, id: message_id }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/message/star', async (req, res) => {
  const { session_id = 'default', to, message_id, starred = true } = req.body;
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    await sock.chatModify(
      { star: { messages: [{ id: message_id, fromMe: true }], star: starred } },
      jid
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/message/read', async (req, res) => {
  const { session_id = 'default', jid, message_id, participant_jid } = req.body;
  try {
    const sock = requireSock(session_id);
    const key = {
      remoteJid: toJID(jid),
      id: message_id,
      participant: participant_jid ? toJID(participant_jid) : undefined,
    };
    await sock.readMessages([key]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Grupos ───────────────────────────────────────────────────

app.post('/group/create', async (req, res) => {
  const { session_id = 'default', subject, participants } = req.body;
  try {
    const sock = requireSock(session_id);

    // Resolve o JID real de cada participante via onWhatsApp()
    // Isso garante o JID correto mesmo para números sem código de país e variante +/-9 (Brasil)
    const resolvedJIDs = [];
    const failed = [];
    for (const p of participants) {
      try {
        const { jid, clean, lid } = await resolveJID(sock, p);
        if (jid) {
          resolvedJIDs.push(jid);
          if (lid) {
            if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
            lidToJidMap[session_id][lid] = jid;
            saveLidMapToDB(session_id, lid, jid);
          }
        }
        else failed.push(clean);
      } catch (_) {
        failed.push(String(p).replace(/\D/g, ''));
      }
    }

    if (resolvedJIDs.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum participante encontrado no WhatsApp: ' + failed.join(', ') });
    }

    const result = await sock.groupCreate(subject, resolvedJIDs);
    const group_jid = result.id;
    // Armazena metadados do grupo recém-criado no cache local
    if (group_jid) {
      if (!groupMetadataCache[session_id]) groupMetadataCache[session_id] = {};
      groupMetadataCache[session_id][group_jid] = result;
    }
    axios.post(`${WEBHOOK_BASE}/api/webhook/bridge/contacts`, {
      session_id,
      contacts: [{ wa_id: group_jid, name: subject, push_name: subject, is_group: true }],
    }).catch(() => {});
    res.json({ success: true, group_jid, resolved: resolvedJIDs.length, failed, metadata: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/participants/add', async (req, res) => {
  const { session_id = 'default', group_jid, participants } = req.body;
  try {
    const sock = requireSock(session_id);
    // Resolve JIDs via onWhatsApp() para suportar números sem código de país e variante +/-9 (Brasil)
    const resolvedJIDs = [];
    const failed = [];
    for (const p of participants) {
      try {
        const { jid, clean, lid } = await resolveJID(sock, p);
        if (jid) {
          resolvedJIDs.push(jid);
          if (lid) {
            if (!lidToJidMap[session_id]) lidToJidMap[session_id] = {};
            lidToJidMap[session_id][lid] = jid;
            saveLidMapToDB(session_id, lid, jid);
          }
        }
        else failed.push(clean);
      } catch (_) {
        failed.push(String(p).replace(/\D/g, ''));
      }
    }
    if (!resolvedJIDs.length) {
      return res.status(400).json({ success: false, error: 'Nenhum participante encontrado no WhatsApp: ' + failed.join(', ') });
    }
    const result = await sock.groupParticipantsUpdate(group_jid, resolvedJIDs, 'add');
    res.json({ success: true, result, failed });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/participants/remove', async (req, res) => {
  const { session_id = 'default', group_jid, participants } = req.body;
  try {
    const sock = requireSock(session_id);
    const result = await sock.groupParticipantsUpdate(group_jid, participants.map(toJID), 'remove');
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/admins/promote', async (req, res) => {
  const { session_id = 'default', group_jid, participants } = req.body;
  try {
    const sock = requireSock(session_id);
    const result = await sock.groupParticipantsUpdate(group_jid, participants.map(toJID), 'promote');
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/admins/demote', async (req, res) => {
  const { session_id = 'default', group_jid, participants } = req.body;
  try {
    const sock = requireSock(session_id);
    const result = await sock.groupParticipantsUpdate(group_jid, participants.map(toJID), 'demote');
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/subject', async (req, res) => {
  const { session_id = 'default', group_jid, subject } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.groupUpdateSubject(group_jid, subject);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/description', async (req, res) => {
  const { session_id = 'default', group_jid, description } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.groupUpdateDescription(group_jid, description);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/leave', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.groupLeave(group_jid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/invite-code', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const sock = requireSock(session_id);
    const code = await sock.groupInviteCode(group_jid);
    res.json({ success: true, invite_code: code, invite_link: `https://chat.whatsapp.com/${code}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/invite-code/revoke', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const sock = requireSock(session_id);
    const code = await sock.groupRevokeInvite(group_jid);
    res.json({ success: true, new_invite_code: code, invite_link: `https://chat.whatsapp.com/${code}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/metadata', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const sock = requireSock(session_id);
    let metadata = null;
    try {
      metadata = await sock.groupMetadata(group_jid);
    } catch (e) {
      logger.warn({ session_id, group_jid, err: e.message }, '[Baileys] groupMetadata falhou, tentando fallback');
    }

    // Fallback: se o Baileys falhou ou retornou participants vazio,
    // tenta usar os dados capturados pelo groupFetchAllParticipating() no boot ou no groupCreate.
    if (!metadata?.participants?.length) {
      const cached = groupMetadataCache[session_id]?.[group_jid];
      if (cached?.participants?.length) {
        metadata = { ...cached, ...metadata, participants: cached.participants };
        logger.info({ session_id, group_jid }, '[Baileys] groupMetadata: usando cache do boot (participants estava vazio)');
      } else {
        // Último recurso: re-busca todos os grupos para atualizar o cache
        try {
          const allGroups = await sock.groupFetchAllParticipating();
          if (!groupMetadataCache[session_id]) groupMetadataCache[session_id] = {};
          for (const [jid, meta] of Object.entries(allGroups)) {
            groupMetadataCache[session_id][jid] = meta;
          }
          const refreshed = groupMetadataCache[session_id][group_jid];
          if (refreshed?.participants?.length) {
            metadata = { ...refreshed, ...metadata, participants: refreshed.participants };
            logger.info({ session_id, group_jid }, '[Baileys] groupMetadata: cache atualizado via groupFetchAllParticipating');
          }
        } catch (_) {}
      }
    }
    if (metadata?.participants?.length) {
      metadata.participants = await Promise.all(metadata.participants.map(async p => {
        let pId = p.id;
        if (!pId || pId === 'undefined') pId = p.jid || p.lid;
        
        let keyPn = null;
        if (p.phoneNumber) keyPn = `${p.phoneNumber}@s.whatsapp.net`;
        else if (p.pn) keyPn = `${p.pn}@s.whatsapp.net`;
        
        // Se a busca principal do Baileys não trouxe a chave, tenta no cache do boot
        if (!keyPn) {
          const cachedP = groupMetadataCache[session_id]?.[group_jid]?.participants?.find(x => x.id === pId || x.lid === pId || x.jid === pId);
          if (cachedP?.phoneNumber) keyPn = `${cachedP.phoneNumber}@s.whatsapp.net`;
          else if (cachedP?.pn) keyPn = `${cachedP.pn}@s.whatsapp.net`;
        }

        let resolvedId = await resolveLidJid(pId, keyPn, session_id);
        
        // Se AINDA for LID, força uma consulta via protocolo USync no WhatsApp para descobrir o telefone
        if (resolvedId?.endsWith('@lid') && sock?.executeUSyncQuery) {
          try {
            const query = new USyncQuery().withContactProtocol().withLIDProtocol();
            query.withUser(new USyncUser().withId(resolvedId));
            const results = await sock.executeUSyncQuery(query);
            if (results?.list?.[0]?.contact && results.list[0].id && results.list[0].id !== 'undefined') {
              resolvedId = results.list[0].id;
            }
          } catch (e) {
            logger.warn({ lid: resolvedId, err: e.message }, '[Baileys] USync force resolve failed');
          }
        }
        
        // Fallback: se resolvedId virou 'undefined' ou não existe, volta para jid ou lid
        if (!resolvedId || resolvedId === 'undefined') {
           resolvedId = p.jid || p.lid || pId;
        }
        
        // Força a atualização do map em memória e DB se descobrimos o número real
        if (pId?.endsWith('@lid') && resolvedId?.endsWith('@s.whatsapp.net')) {
          lidToJidMap[session_id][pId] = resolvedId;
          saveLidMapToDB(session_id, pId, resolvedId);
        }

        const meJid = sock.user?.id ? `${sock.user.id.split(':')[0]}@s.whatsapp.net` : null;
        const isMe = (resolvedId === meJid) || (pId === sock.user?.lid) || (resolvedId === sock.user?.lid);

        // Nome que a pessoa deixa disponível no WhatsApp (agenda salva, ou o
        // pushname autodeclarado) — pro GroupManager mostrar em vez do número cru.
        const name = getContactName(session_id, resolvedId);

        return {
          ...p,
          id: resolvedId,
          isMe: isMe,
          name: name || null,
        };
      }));
    }

    res.json({ success: true, metadata });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/join', async (req, res) => {
  const { session_id = 'default', invite_link } = req.body;
  try {
    const sock = requireSock(session_id);
    const code = invite_link.split('https://chat.whatsapp.com/').pop();
    const result = await sock.groupAcceptInvite(code);
    res.json({ success: true, group_jid: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/announce', async (req, res) => {
  const { session_id = 'default', group_jid, announce } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.groupSettingUpdate(group_jid, announce ? 'announcement' : 'not_announcement');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/disappearing', async (req, res) => {
  const { session_id = 'default', group_jid, duration } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.groupToggleEphemeral(group_jid, duration);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/join-requests', async (req, res) => {
  const { session_id = 'default', group_jid } = req.body;
  try {
    const sock = requireSock(session_id);
    const result = await sock.groupRequestParticipantsList(group_jid);
    res.json({ success: true, requests: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/group/join-requests/update', async (req, res) => {
  const { session_id = 'default', group_jid, participants, action } = req.body;
  try {
    const sock = requireSock(session_id);
    const result = await sock.groupRequestParticipantsUpdate(group_jid, participants, action);
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Perfil e privacidade ─────────────────────────────────────

app.post('/profile/picture', async (req, res) => {
  const { session_id = 'default', jid, high_res = false } = req.body;
  try {
    const sock = requireSock(session_id);
    const url = await sock.profilePictureUrl(toJID(jid), high_res ? 'image' : 'preview');
    res.json({ success: true, url });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/profile/picture/update', async (req, res) => {
  const { session_id = 'default', image_b64 } = req.body;
  try {
    const sock = requireSock(session_id);
    const img = Buffer.from(image_b64, 'base64');
    await sock.updateProfilePicture(sock.user.id, img);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/profile/picture/remove', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.removeProfilePicture(sock.user.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/profile/status', async (req, res) => {
  const { session_id = 'default', status } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.updateProfileStatus(status);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/profile/name', async (req, res) => {
  const { session_id = 'default', name } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.updateProfileName(name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/profile/get-status', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const sock = requireSock(session_id);
    // fetchStatus(...jids) devolve uma LISTA (um item por jid consultado), cada item
    // com { id, status: { status, setAt } } — não um objeto único com .status/.setAt
    // direto na raiz, que é o que o código lia antes (sempre undefined).
    const result = await sock.fetchStatus(toJID(jid));
    const entry = result?.[0]?.status;
    res.json({ success: true, status: entry?.status ?? null, set_at: entry?.setAt ?? null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/contact/check', async (req, res) => {
  const { session_id = 'default', phone } = req.body;
  try {
    const sock = requireSock(session_id);
    const clean = String(phone).replace(/\D/g, '');
    const [result] = await sock.onWhatsApp(clean);
    res.json({ success: true, exists: !!result?.exists, jid: result?.jid });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/contact/block', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.updateBlockStatus(toJID(jid), 'block');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/contact/unblock', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.updateBlockStatus(toJID(jid), 'unblock');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/contact/blocklist', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const sock = requireSock(session_id);
    const list = await sock.fetchBlocklist();
    res.json({ success: true, blocklist: list });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/contact/business-profile', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const sock = requireSock(session_id);
    const result = await sock.getBusinessProfile(toJID(jid));
    res.json({ success: true, profile: result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/privacy/settings', async (req, res) => {
  const { session_id = 'default' } = req.body;
  try {
    const sock = requireSock(session_id);
    const settings = await sock.fetchPrivacySettings(true);
    res.json({ success: true, settings });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// updatePrivacySettings não existe no Baileys — cada categoria tem seu próprio método.
const PRIVACY_SETTERS = {
  last_seen: 'updateLastSeenPrivacy',
  online: 'updateOnlinePrivacy',
  profile_photo: 'updateProfilePicturePrivacy',
  status: 'updateStatusPrivacy',
  read_receipts: 'updateReadReceiptsPrivacy',
  groups_add: 'updateGroupsAddPrivacy',
  calls: 'updateCallPrivacy',
  messages: 'updateMessagesPrivacy',
};

app.post('/privacy/update', async (req, res) => {
  const { session_id = 'default', setting, value } = req.body;
  // setting: last_seen|online|profile_photo|status|read_receipts|groups_add|calls|messages
  // value: all|contacts|contact_blacklist|none
  const fnName = PRIVACY_SETTERS[setting];
  if (!fnName) {
    return res.status(400).json({ success: false, error: `setting inválido: ${setting}. Use um de: ${Object.keys(PRIVACY_SETTERS).join(', ')}` });
  }
  try {
    const sock = requireSock(session_id);
    await sock[fnName](value);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Presença ─────────────────────────────────────────────────

app.post('/presence/send', async (req, res) => {
  const { session_id = 'default', to, type } = req.body;
  // type: available|unavailable|composing|paused|recording
  try {
    const sock = requireSock(session_id);
    const jid = await resolveSendJID(sock, to);
    await sock.sendPresenceUpdate(type, jid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/presence/subscribe', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.presenceSubscribe(toJID(jid));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Gerenciamento de chats ───────────────────────────────────

app.post('/chat/delete', async (req, res) => {
  const { session_id = 'default', jid } = req.body;
  try {
    const sock = requireSock(session_id);
    const chatJid = toJID(jid);
    await sock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: chatJid, id: '', fromMe: false } }] }, chatJid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/chat/archive', async (req, res) => {
  const { session_id = 'default', jid, archive = true } = req.body;
  try {
    const sock = requireSock(session_id);
    const chatJid = toJID(jid);
    await sock.chatModify({ archive }, chatJid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/chat/mute', async (req, res) => {
  const { session_id = 'default', jid, duration_ms } = req.body;
  try {
    const sock = requireSock(session_id);
    const chatJid = toJID(jid);
    if (duration_ms) {
      await sock.chatModify({ mute: Date.now() + duration_ms }, chatJid);
    } else {
      await sock.chatModify({ mute: null }, chatJid);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/chat/pin', async (req, res) => {
  const { session_id = 'default', jid, pinned = true } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.chatModify({ pin: pinned }, toJID(jid));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/chat/disappearing', async (req, res) => {
  const { session_id = 'default', jid, duration } = req.body;
  try {
    const sock = requireSock(session_id);
    await sock.sendMessage(toJID(jid), { disappearingMessagesInChat: duration });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────

app.listen(PORT, '::', async () => {
  logger.info({ port: PORT, webhook_base: WEBHOOK_BASE }, '[Baileys] Bridge iniciado');

  // 1. Pool MySQL
  await initMySQLPool();
  await ensureLidMapTable();

  // 2. Corrige conversas órfãs (account_id=NULL) — uma vez na inicialização
  await fixOrphanedConversations();

  // 3. Inicia todas as sessões Baileys ativas do banco automaticamente
  await bootstrapSessionsFromDB();
});
