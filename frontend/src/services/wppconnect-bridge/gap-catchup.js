'use strict';

// Recuperação de mensagens perdidas por sessão do WPPConnect.
// Incidentes 2026-09-24 (Financeiro, 4 dias) e 2026-09-28 (Pós Vendas, 4h30):
// o renderer do Chrome morreu por OOM e as mensagens do período nunca entraram.
// Marca d'água = hora até a qual TUDO já foi entregue ao backend. Ao (re)conectar,
// busca só as conversas com atividade depois dela.

const fs = require('fs');

class WatermarkStore {
  constructor(file, log = console) {
    this.file = file;
    this.log = log;
    this.data = this._load();
    this.dirty = false;
    this.timer = setInterval(() => this.flush(), 15000);
    if (this.timer.unref) this.timer.unref();
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch (_) { return {}; }
  }

  get(session_id) {
    const v = this.data[session_id];
    return Number.isFinite(v) ? v : null;
  }

  set(session_id, ts) {
    if (!Number.isFinite(ts)) return;
    this.data[session_id] = ts;
    this.dirty = true;
  }

  bump(session_id, ts) {
    if (!Number.isFinite(ts) || ts > Date.now() + 5 * 60 * 1000) return;
    const cur = this.get(session_id);
    if (cur === null || ts > cur) this.set(session_id, ts);
  }

  flush() {
    if (!this.dirty) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log.warn(`[WPPConnect] Falha ao gravar marca d'água: ${err.message}`);
    }
  }
}

const DEFAULTS = {
  maxChats: 100,
  maxPages: 10,
  pageSize: 50,
  marginMs: 5 * 60 * 1000,
  pageDelayMs: 2500,
  chatDelayMs: 1500,
  mediaMaxAgeMs: 48 * 60 * 60 * 1000,
  maxMediaFailures: 4,
  healthSlowMs: 2500,
  healthRetries: 4,
  healthWaitMs: 15000,
  syncRetryWaitMs: 30000,
};

async function runGapCatchup({ session_id, client, sinceMs, opts = {}, deps }) {
  const o = { ...DEFAULTS, ...opts };
  const { listChatsStable, resolveChatContext, mapHistoryMessage, postSync, healthCheck, filterMissing,
          isMediaType, isStopped, sleep, now = Date.now, log = console } = deps;

  const result = {
    ok: false, aborted: false, reason: null, truncated: false,
    chatsScanned: 0, messagesSent: 0, startedAt: now(), finishedAt: null,
  };
  const cutoff = sinceMs - o.marginMs;
  let mediaFailures = 0;

  const finish = (reason) => {
    if (reason) { result.aborted = true; result.reason = reason; }
    result.ok = !result.aborted && !result.truncated;
    result.finishedAt = now();
    return result;
  };

  const backendHealthy = async () => {
    for (let i = 0; i < o.healthRetries; i++) {
      try {
        const ms = await healthCheck();
        if (ms <= o.healthSlowMs) return true;
      } catch (_) { /* tenta de novo */ }
      await sleep(o.healthWaitMs);
    }
    return false;
  };

  const chats = await listChatsStable(client);
  const candidates = chats
    .filter((c) => c.id?._serialized && c.id._serialized !== 'status@broadcast')
    .filter((c) => c.t === undefined || c.t === null || c.t * 1000 >= cutoff)
    .sort((a, b) => (b.t || 0) - (a.t || 0));
  if (candidates.length > o.maxChats) result.truncated = true;

  for (const chat of candidates.slice(0, o.maxChats)) {
    if (isStopped()) return finish('sessão trocada/fechada');
    if (!(await backendHealthy())) return finish('backend lento/indisponível');

    const ctx = await resolveChatContext(client, session_id, chat);
    if (!ctx) continue;
    result.chatsScanned += 1;

    let cursorId;
    for (let page = 0; page < o.maxPages; page++) {
      if (isStopped()) return finish('sessão trocada/fechada');

      let msgs;
      try {
        msgs = await client.getMessages(ctx.rawJid, {
          count: o.pageSize,
          ...(cursorId ? { id: cursorId, direction: 'before' } : {}),
        });
      } catch (err) {
        log.warn(`[WPPConnect] Catch-up: falha ao paginar ${ctx.jid} (${session_id}): ${err.message}`);
        break;
      }
      if (!msgs?.length) break;

      const inWindow = msgs.filter((m) => (m.t || 0) * 1000 >= cutoff);
      const idOf = (m) => (typeof m.id === 'string' && m.id) ? m.id : (m.id?._serialized || m.id?.id || null);
      const knownIds = inWindow.map(idOf).filter(Boolean);
      const missingIds = knownIds.length ? new Set(await filterMissing(knownIds)) : new Set();

      const batch = [];
      for (const m of inWindow) {
        const ts = (m.t || 0) * 1000;
        const realId = idOf(m);
        if (realId && !missingIds.has(realId)) continue; // backend já tem — não reprocessa
        const skipMedia = mediaFailures >= o.maxMediaFailures || (now() - ts) > o.mediaMaxAgeMs;
        const mapped = await mapHistoryMessage(session_id, client, ctx, m, { skipMedia });
        if (!mapped) continue;
        if (!skipMedia && isMediaType(mapped.type)) {
          mediaFailures = mapped.media_url ? 0 : mediaFailures + 1;
        }
        batch.push(mapped);
      }

      if (batch.length) {
        let sent = false;
        for (let attempt = 0; attempt < 2 && !sent; attempt++) {
          try { await postSync(batch); sent = true; } catch (err) {
            log.warn(`[WPPConnect] Catch-up: envio falhou (${session_id}, tentativa ${attempt + 1}): ${err.message}`);
            if (attempt === 0) await sleep(o.syncRetryWaitMs);
          }
        }
        if (!sent) return finish('envio ao backend falhou');
        result.messagesSent += batch.length;
      }

      const oldest = msgs[0];
      const oldestTs = (oldest.t || 0) * 1000;
      if (oldestTs < cutoff || msgs.length < o.pageSize) break;
      const oldestId = (typeof oldest.id === 'string' && oldest.id) ? oldest.id
        : oldest.id?._serialized || oldest.id?.id || null;
      if (!oldestId || oldestId === cursorId) break;
      cursorId = oldestId;
      await sleep(o.pageDelayMs);
    }
    await sleep(o.chatDelayMs);
  }

  return finish(null);
}

module.exports = { WatermarkStore, runGapCatchup, DEFAULTS };
