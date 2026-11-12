'use strict';

// Sonda de saúde da página do WhatsApp Web (Puppeteer) de uma sessão.
// Incidentes 2026-09-24 (Financeiro) e 2026-09-28 (Pós Vendas): o kernel matou
// por OOM o renderer do Chrome, o navegador principal sobreviveu, o bridge
// seguiu dizendo "authenticated" e nenhuma mensagem chegou por horas/dias.

const PROBE_INTERVAL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS  = 20 * 1000;
const PROBE_MAX_FAILS   = 3;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sem resposta em ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startPageProbe({
  session_id,
  state,
  client,
  onDead,
  onOk = null,
  log = console,
  intervalMs = PROBE_INTERVAL_MS,
  timeoutMs = PROBE_TIMEOUT_MS,
  maxFails = PROBE_MAX_FAILS,
}) {
  let fails = 0;
  let running = false;
  let stopped = false;
  let timer = null;

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
  }

  function declareDead(reason) {
    if (stopped) return;
    stop();
    onDead(reason);
  }

  timer = setInterval(async () => {
    if (stopped || running) return;
    if (state.client !== client) { stop(); return; }
    running = true;
    try {
      const page = client.page;
      if (!page || page.isClosed()) throw new Error('página do Chrome fechada');
      await withTimeout(page.evaluate(() => 1), timeoutMs);
      fails = 0;
      if (onOk) { try { onOk(); } catch (_) { /* não deixa a marca d'água derrubar a sonda */ } }
    } catch (err) {
      fails += 1;
      log.warn(`[WPPConnect] Sonda de página falhou (${fails}/${maxFails}) em ${session_id}: ${err.message}`);
      if (fails >= maxFails) declareDead(`sonda falhou ${fails}x seguidas: ${err.message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  if (timer.unref) timer.unref();

  // Renderer morto (OOM etc.) dispara 'error' ("Page crashed!") na hora, sem esperar a sonda.
  try {
    client.page?.on?.('error', (err) => declareDead(`página crashou: ${err?.message || err}`));
  } catch (_) { /* melhor esforço — a sonda periódica cobre */ }

  return { stop };
}

module.exports = { startPageProbe, withTimeout, PROBE_INTERVAL_MS, PROBE_TIMEOUT_MS, PROBE_MAX_FAILS };
