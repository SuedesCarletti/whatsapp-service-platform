/**
 * history-gate.js — portao de carga para sync de historico.
 *
 * Antes de CADA lote de historico antigo, consulta GET /api/webhook/bridge/load
 * e espera enquanto o backend estiver ocupado (trafego ao vivo tem prioridade).
 * Lotes sao enviados em pedacos pequenos, com retry que respeita 429/Retry-After,
 * e uma pagina so e considerada entregue quando TODOS os pedacos foram aceitos —
 * quem chama decide nao avancar o cursor/progresso se vier ok:false.
 *
 * Mesma logica existe em baileys-bridge/history-gate.js (CommonJS). Mantenha os dois
 * em sincronia.
 */
import axios from 'axios';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

async function waitForCapacity(baseUrl, { maxWaitMs = 10 * 60 * 1000, log = () => {} } = {}) {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    let snap;
    try {
      snap = (await axios.get(`${baseUrl}/api/webhook/bridge/load`, { timeout: 4000 })).data;
    } catch {
      snap = { level: 'unreachable', suggested_delay_ms: 15000 };
    }
    if (snap.level === 'ok') return { ok: true, waitedMs: Date.now() - started };
    if (Date.now() - started >= maxWaitMs) {
      return { ok: false, waitedMs: Date.now() - started, level: snap.level };
    }
    const base = Math.max(snap.suggested_delay_ms || 8000, 3000);
    const delay = jitter(Math.min(base * Math.pow(1.5, Math.min(attempt, 4)), 120000));
    if (attempt % 3 === 0) log(`backend ${snap.level} (fila=${snap.executor_queue ?? '?'}, ao vivo/min=${snap.live_per_min ?? '?'}) — historico aguarda ${Math.round(delay / 1000)}s`);
    attempt++;
    // nao dorme alem do prazo restante (maxWaitMs e um teto de verdade)
    await sleep(Math.max(0, Math.min(delay, maxWaitMs - (Date.now() - started))));
  }
}

/** Envia body.messages em pedacos, passando pelo portao a cada pedaco. */
async function postHistoryBatch(baseUrl, body, opts = {}) {
  const { chunkSize = 25, retries = 4, chunkDelayMs = 400, path = '/api/webhook/bridge/sync', log = () => {} } = opts;
  const messages = body.messages || [];
  let sent = 0;
  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    let delivered = false;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries && !delivered; attempt++) {
      const gate = await waitForCapacity(baseUrl, { log });
      if (!gate.ok) return { ok: false, sent, reason: `gate_timeout:${gate.level}` };
      try {
        await axios.post(`${baseUrl}${path}`, { ...body, messages: chunk }, { timeout: 30000 });
        delivered = true;
      } catch (err) {
        lastErr = err;
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        const wait = err.response?.status === 429 && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(5000 * Math.pow(2, attempt), 60000);
        await sleep(jitter(wait));
      }
    }
    if (!delivered) return { ok: false, sent, reason: `post_failed:${lastErr?.message || 'erro'}` };
    sent += chunk.length;
    if (i + chunkSize < messages.length) await sleep(chunkDelayMs);
  }
  return { ok: true, sent };
}

export { waitForCapacity, postHistoryBatch };
