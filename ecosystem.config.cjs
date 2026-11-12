module.exports = {
  apps: [
    {
      name: 'baileys-bridge',
      script: 'frontend/src/services/baileys-bridge/index.js',
      interpreter: 'node',
      cwd: '/home/whatsapp/app',
      env_file: undefined,
      env: {
        NODE_ENV: 'production',
        DB_HOST: 'localhost',
        DB_PORT: '3306',
        DB_NAME: 'wpp_platform',
        DB_USER: 'wpp_user',
        DB_PASSWORD: process.env.DB_PASSWORD,
        FASTAPI_URL: 'http://localhost:8000',
        BAILEYS_BRIDGE_PORT: '3001',
        PORT: '3001',
        // Conta Baileys #18 (ti01-baileys) é só um fallback de ENVIO pro
        // WPPConnect (ver comentário no topo de index.js e
        // _find_baileys_fallback_account em backend/api/routes.py) — não
        // pode ingerir histórico/mensagens ao vivo como uma conta normal,
        // senão duplica toda conversa do número ti01 numa segunda conta.
        FALLBACK_ONLY_BAILEYS_SESSIONS: 'ti01-baileys',
      },
    },
    {
      name: 'venom-bridge',
      script: 'frontend/src/services/venom-bridge/index.js',
      interpreter: 'node',
      cwd: '/home/whatsapp/app',
      env_file: undefined,
      // kill_timeout: pm2 manda SIGKILL depois desse prazo se o processo não
      // sair sozinho — o default (1.6s) é curto demais pro Chrome/Puppeteer
      // fechar graciosamente, deixando o browser órfão com o SingletonLock
      // do userDataDir travado (próxima sessão falha com "already running").
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        FASTAPI_URL: 'http://localhost:8000',
        VENOM_PORT: '3002',
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
      },
    },
    {
      name: 'wppconnect-bridge',
      script: 'frontend/src/services/wppconnect-bridge/index.js',
      interpreter: 'node',
      cwd: '/home/whatsapp/app',
      env_file: undefined,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        FASTAPI_URL: 'http://localhost:8000',
        WPPCONNECT_PORT: '3003',
        WPPCONNECT_SECRET_KEY: process.env.WPPCONNECT_SECRET_KEY,
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
        SYNC_MAX_CHATS: '250',
        SYNC_MAX_PER_CHAT: '100',
        // RELIGADO 2026-09-03: pool de conexões aumentado (10/20 -> 15/25,
        // 40 por processo) + pool_timeout=10s, e /api/health agora roda o
        // check_db_connection() via asyncio.to_thread (não trava mais o loop
        // principal se o pool estiver saturado). Validado primeiro na teste.
        // Retomará SAC-01/POS-01/RMA-01 de onde pararam (progresso salvo).
        // Monitorar de perto no primeiro ciclo real.
        BACKFILL_AUTO_ENABLED: 'false', // PAUSADO 2026-09-03 12:06 - health check voltou a travar (000/timeout) mesmo com pool maior
      },
    },
    {
      name: 'wa-web-bridge',
      script: 'frontend/src/services/wa-web-bridge/index.js',
      interpreter: 'node',
      cwd: '/home/whatsapp/app',
      env_file: undefined,
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        FASTAPI_URL: 'http://localhost:8000',
        WHATSAPP_WEB_JS_PORT: '3004',
        PUPPETEER_EXECUTABLE_PATH: '/usr/bin/google-chrome-stable',
      },
    },
  ],
};
