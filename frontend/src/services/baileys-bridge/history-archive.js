/**
 * history-archive.js — backup bruto do historico recebido pelo Baileys.
 *
 * Tudo que o WhatsApp entrega em `messaging-history.set` (mensagens, chats,
 * contatos) e gravado SEM teto, em disco, em arquivos JSONL comprimidos:
 *
 *   <root>/<session>/messages/<chat>.jsonl.gz   uma mensagem (WAMessage) por linha
 *   <root>/<session>/chats.jsonl.gz             metadados de chats
 *   <root>/<session>/contacts.jsonl.gz          contatos
 *   <root>/<session>/media/<chat>/<id>.<ext>    midia baixada sob demanda
 *   <root>/<session>/index.json                 resumo por chat + log de eventos
 *
 * Cada gravacao anexa um "membro" gzip novo ao arquivo (gzip multi-membro e
 * valido: `gunzip`/`zcat` leem tudo). A mesma mensagem pode aparecer em mais de
 * um evento de sync; a leitura (readChatMessages) deduplica por key.id.
 * Gravacao e assincrona e serializada por sessao — nunca bloqueia o event loop
 * nem disputa o MySQL da aplicacao.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const fsp = fs.promises;

const safe = (s) => String(s).replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 120);

/** JSON seguro p/ protobuf do Baileys: Buffer/Uint8Array -> {__b64}, Long -> number. */
function replacer(_k, v) {
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { __b64: Buffer.from(v.data).toString('base64') };
  if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (v && typeof v === 'object' && typeof v.toNumber === 'function' && 'low' in v && 'high' in v) return v.toNumber();
  return v;
}
export const serialize = (obj) => JSON.stringify(obj, replacer);

/** Inverso de serialize: {__b64} -> Buffer (necessario p/ baixar midia depois). */
export function revive(_k, v) {
  if (v && typeof v === 'object' && typeof v.__b64 === 'string') return Buffer.from(v.__b64, 'base64');
  return v;
}

export const tsOf = (m) => {
  const t = m?.messageTimestamp;
  if (t == null) return 0;
  return typeof t === 'number' ? t : Number(t?.toNumber ? t.toNumber() : t);
};

export function createArchive(rootDir) {
  const chains = new Map();   // session -> promise (serializa escrita)
  const indexes = new Map();  // session -> index em memoria
  const seen = new Map();     // session -> Set("jid|id") (so deste processo)
  const flushTimers = new Map();

  const sessionDir = (sid) => path.join(rootDir, safe(sid));

  async function loadIndex(sid) {
    if (indexes.has(sid)) return indexes.get(sid);
    let idx = {
      session_id: sid,
      createdAt: new Date().toISOString(),
      chats: {},
      events: [],
      totals: { messages: 0, chats: 0, contacts: 0 },
    };
    try { idx = JSON.parse(await fsp.readFile(path.join(sessionDir(sid), 'index.json'), 'utf8')); } catch { /* novo */ }
    indexes.set(sid, idx);
    return idx;
  }

  function scheduleFlush(sid) {
    if (flushTimers.has(sid)) return;
    flushTimers.set(sid, setTimeout(async () => {
      flushTimers.delete(sid);
      try {
        await fsp.mkdir(sessionDir(sid), { recursive: true });
        await fsp.writeFile(path.join(sessionDir(sid), 'index.json'), JSON.stringify(indexes.get(sid), null, 2));
      } catch { /* melhor esforco; tenta de novo na proxima gravacao */ }
    }, 2000));
  }

  function enqueue(sid, fn) {
    const next = (chains.get(sid) || Promise.resolve()).then(fn, fn);
    chains.set(sid, next.catch(() => {}));
    return next;
  }

  async function appendGz(file, lines) {
    if (!lines.length) return;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, zlib.gzipSync(lines.join('\n') + '\n'));
  }

  /** Grava mensagens agrupadas por chat. Retorna quantas eram novas neste processo. */
  function appendMessages(sid, msgs, { syncType = null, isLatest = null } = {}) {
    return enqueue(sid, async () => {
      const idx = await loadIndex(sid);
      if (!seen.has(sid)) seen.set(sid, new Set());
      const sset = seen.get(sid);
      const byChat = new Map();
      for (const m of msgs) {
        const jid = m?.key?.remoteJid;
        if (!jid || !m?.key?.id) continue;
        const k = `${jid}|${m.key.id}`;
        if (sset.has(k)) continue;
        sset.add(k);
        if (!byChat.has(jid)) byChat.set(jid, []);
        byChat.get(jid).push(m);
      }
      let added = 0;
      for (const [jid, list] of byChat) {
        await appendGz(path.join(sessionDir(sid), 'messages', `${safe(jid)}.jsonl.gz`), list.map(serialize));
        const c = idx.chats[jid] || (idx.chats[jid] = { count: 0, oldest: null, newest: null });
        for (const m of list) {
          const ts = tsOf(m);
          c.count++;
          if (ts && (!c.oldest || ts < c.oldest.ts)) {
            c.oldest = { ts, id: m.key.id, fromMe: !!m.key.fromMe, participant: m.key.participant || null };
          }
          if (ts && (!c.newest || ts > c.newest)) c.newest = ts;
        }
        added += list.length;
      }
      idx.totals.messages += added;
      idx.totals.chats = Object.keys(idx.chats).length;
      idx.events.push({
        at: new Date().toISOString(),
        kind: 'messages',
        syncType: syncType == null ? null : String(syncType),
        isLatest,
        received: msgs.length,
        stored: added,
      });
      if (idx.events.length > 500) idx.events.splice(0, idx.events.length - 500);
      scheduleFlush(sid);
      return added;
    });
  }

  /** chats / contacts (metadados). */
  function appendMeta(sid, kind, items) {
    if (!items?.length) return Promise.resolve(0);
    return enqueue(sid, async () => {
      const idx = await loadIndex(sid);
      await appendGz(path.join(sessionDir(sid), `${kind}.jsonl.gz`), items.map(serialize));
      // chave propria: totals.chats ja e o numero de conversas com mensagens
      const mk = `${kind}_meta`;
      idx.totals[mk] = (idx.totals[mk] || 0) + items.length;
      idx.events.push({ at: new Date().toISOString(), kind, received: items.length });
      scheduleFlush(sid);
      return items.length;
    });
  }

  async function getIndex(sid) { return loadIndex(sid); }
  async function oldestKey(sid, jid) { const idx = await loadIndex(sid); return idx.chats[jid]?.oldest || null; }

  /** Le o arquivo de um chat, descomprime e deduplica por key.id (mais antigo -> mais novo). */
  async function readChatMessages(sid, jid) {
    const file = path.join(sessionDir(sid), 'messages', `${safe(jid)}.jsonl.gz`);
    let buf;
    try { buf = await fsp.readFile(file); } catch { return []; }
    const out = new Map();
    for (const line of zlib.gunzipSync(buf).toString('utf8').split('\n')) {
      if (!line) continue;
      try { const m = JSON.parse(line, revive); if (m?.key?.id) out.set(m.key.id, m); } catch { /* linha corrompida */ }
    }
    return [...out.values()].sort((a, b) => tsOf(a) - tsOf(b));
  }

  const mediaPath = (sid, jid, id, ext) => path.join(sessionDir(sid), 'media', safe(jid), `${safe(id)}.${ext}`);

  return { appendMessages, appendMeta, getIndex, oldestKey, readChatMessages, mediaPath, sessionDir, rootDir };
}
