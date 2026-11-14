from fastapi import FastAPI, HTTPException, Request, Depends, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from contextlib import asynccontextmanager
import asyncio
import logging
import os
from pathlib import Path
import hmac
import hashlib
import json # Adicionado import faltante

# Importações do projeto
from backend.api.routes import router
from backend.api.websocket import sio, socket_app
from backend.database.connection import check_db_connection, init_db, get_db
from backend.services.webhook_handler import webhook_handler
from sqlalchemy.orm import Session
from backend.api.routes_extended import router_extended
from backend.services.webhook_handler_extended import webhook_extended
from backend.services.woocommerce_integration import woocommerce_router
from backend.api.routes_auth import router_auth
from backend.api.routes_admin import router_admin
from backend.middleware.provider_middleware import ProviderRoutingMiddleware
from backend.api.routes_settings import settings_router
from backend.api.routes_templates import templates_router, config_router
from backend.api.routes_flows import flows_router, flows_webhook_router
from backend.api.routes_embedded_signup import embedded_signup_router
from backend.api.routes_bridge import router_bridge
from backend.api.routes_baileys import router_baileys
from backend.api.routes_attendance import router_attendance
from backend.api.routes_ai_bot import ai_bot_router
from backend.api.routes_evolution_compat import evolution_compat_router
from backend.api.routes_internal_chat import router_internal_chat
from backend.api.routes_stickers import router_stickers
from backend.api.routes_saved_contacts import router_saved_contacts
from backend.api.routes_giphy import router_giphy
from backend.api.routes_broadcast import router_broadcast
from backend.api.routes_push import router_push
from backend.api.routes_site_chat import router_site_chat, SiteChatCORSMiddleware
from backend.api.routes_site_chat_questions import router_site_chat_questions
from backend.services.bridge_watchdog import run_bridge_watchdog
from backend.services.csat_timeout_watchdog import run_csat_timeout_watchdog
from backend.services.bot_health_watchdog import run_bot_health_watchdog
from backend.services.stuck_wppconnect_watchdog import run_stuck_wppconnect_watchdog
from backend.services.task_pause_reminder_watchdog import run_task_pause_reminder_watchdog
from backend.services.task_due_reminder_watchdog import run_task_due_reminder_watchdog

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Criar diretórios necessários
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# 2. CRIAÇÃO DA APP (Apenas uma vez, movida para o final)

# MIDDLEWARE DE VALIDAÇÃO COM "RADAR" (DEBUG)
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Eventos de startup e shutdown da aplicação"""
    # STARTUP
    logger.info("Iniciando WhatsApp Chat Backend...")

    # Guarda a referência do loop principal pro WebSocketManager — precisa
    # ser aqui (dentro do lifespan, já com o loop do uvicorn rodando), não
    # no __init__ do ws_manager (roda no import do módulo, antes de existir
    # loop nenhum). Ver capture_main_loop() em backend/api/websocket.py.
    from backend.api.websocket import ws_manager
    ws_manager.capture_main_loop()
    
    # Verificar M4D_APP_SECRET
    app_secret = os.getenv("M4D_APP_SECRET")
    if app_secret:
        logger.info(f"M4D_APP_SECRET configurado (starts with: {app_secret[:5]}...)")
    else:
        logger.warning(" M4D_APP_SECRET não configurado! Webhooks não funcionarão!")
    
    # Verificar conexão com banco de dados
    logger.info("Verificando conexão com banco de dados...")
    if check_db_connection():
        logger.info("Banco de dados conectado!")
    else:
        logger.error("Falha ao conectar com banco de dados!")
        logger.error("Verifique suas configurações no arquivo .env")
    
    # Opcional: Criar tabelas automaticamente
    if os.getenv("AUTO_CREATE_TABLES", "False") == "True":
        logger.info("Criando tabelas do banco de dados...")
        try:
            init_db()
            logger.info("Tabelas criadas com sucesso!")
        except Exception as e:
            logger.warning(f"Erro ao criar tabelas: {e}")

    # Migrações incrementais — adiciona colunas novas sem recriar tabelas
    try:
        from backend.database.connection import engine
        from sqlalchemy import text
        with engine.connect() as conn:
            for stmt in [
                "ALTER TABLE messages ADD COLUMN reply_to_wamid VARCHAR(255) NULL",
                "ALTER TABLE messages ADD COLUMN is_starred BOOLEAN DEFAULT FALSE",
                "ALTER TABLE messages ADD COLUMN meta_pricing_category VARCHAR(50) NULL",
                "ALTER TABLE messages ADD COLUMN meta_pricing_model VARCHAR(20) NULL",
                "ALTER TABLE messages ADD COLUMN meta_pricing_billable BOOLEAN NULL",
                "ALTER TABLE messages ADD COLUMN meta_conversation_id VARCHAR(255) NULL",
                "ALTER TABLE messages ADD COLUMN meta_conversation_origin VARCHAR(50) NULL",
                "ALTER TABLE messages ADD COLUMN meta_conversation_expiration_ts BIGINT NULL",
                "CREATE INDEX ix_messages_meta_conversation_id ON messages (meta_conversation_id)",
                "ALTER TABLE whatsapp_accounts ADD COLUMN meta_catalog_id VARCHAR(255) NULL",
                # Atendimento — fila/atribuição/status (Fase A)
                "ALTER TABLE conversations ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'open'",
                "ALTER TABLE conversations ADD COLUMN assigned_to_user_id INT NULL",
                "ALTER TABLE conversations ADD COLUMN assigned_at DATETIME NULL",
                "ALTER TABLE conversations ADD COLUMN resolved_at DATETIME NULL",
                "ALTER TABLE conversations ADD COLUMN awaiting_csat BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE conversations ADD COLUMN last_business_hours_autoreply_at DATETIME NULL",
                # Cronômetros de SLA (tempo de atribuição/pendente) + timeout de CSAT
                "ALTER TABLE conversations ADD COLUMN pending_since DATETIME NULL",
                # Alerta de bot travado/em loop
                "ALTER TABLE conversations ADD COLUMN bot_loop_detected BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE conversations ADD COLUMN bot_repeat_count INT NOT NULL DEFAULT 0",
                "ALTER TABLE conversations ADD COLUMN bot_last_reply_text TEXT NULL",
                "ALTER TABLE conversations ADD COLUMN bot_last_reply_at DATETIME NULL",
                "ALTER TABLE conversations ADD COLUMN bot_forwarded_at DATETIME NULL",
                "CREATE INDEX ix_conversations_status ON conversations (status)",
                "CREATE INDEX ix_conversations_assigned_to_user_id ON conversations (assigned_to_user_id)",
                "ALTER TABLE conversations ADD CONSTRAINT fk_conversations_assigned_to FOREIGN KEY (assigned_to_user_id) REFERENCES users(id) ON DELETE SET NULL",
                # Chat interno — paridade WhatsApp Web (Fases 1-4)
                "ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL",
                "ALTER TABLE users ADD COLUMN presence_status VARCHAR(20) NOT NULL DEFAULT 'online'",
                "ALTER TABLE internal_conversations ADD COLUMN photo_url TEXT NULL",
                "ALTER TABLE internal_conversation_participants ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE internal_messages ADD COLUMN message_type VARCHAR(20) NOT NULL DEFAULT 'text'",
                "ALTER TABLE internal_messages ADD COLUMN media_url TEXT NULL",
                "ALTER TABLE internal_messages ADD COLUMN mime_type VARCHAR(100) NULL",
                "ALTER TABLE internal_messages ADD COLUMN filename VARCHAR(255) NULL",
                "ALTER TABLE internal_messages ADD COLUMN reply_to_id INT NULL",
                "ALTER TABLE internal_messages ADD COLUMN is_edited BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE internal_messages ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE internal_messages ADD COLUMN is_starred BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE internal_messages ADD CONSTRAINT fk_internal_messages_reply_to FOREIGN KEY (reply_to_id) REFERENCES internal_messages(id) ON DELETE SET NULL",
                # Tarefas — descrição editável só pelo criador (marca se já foi
                # editada) + aprovação da conclusão pelo criador da tarefa
                "ALTER TABLE internal_tasks ADD COLUMN description_edited BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE internal_tasks ADD COLUMN approved_by INT NULL",
                "ALTER TABLE internal_tasks ADD COLUMN approved_at DATETIME NULL",
                "ALTER TABLE internal_tasks ADD CONSTRAINT fk_internal_tasks_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL",
                # Recuperação de mensagens perdidas entre o bridge e o banco
                # (ver POST /bridge/register-failed) — payload bruto guardado
                # pra permitir retry manual pelo agente no front.
                "ALTER TABLE messages ADD COLUMN failed_payload JSON NULL",
                # Corrida confirmada 2026-09-03 (contact_id=210, account_id=15,
                # conversas 268/269 — a 2ª vazia, criada 1s depois): 2 mensagens
                # quase simultneas pro mesmo contato+conta passavam pelo SELECT
                # de get_or_create_conversation antes de qualquer INSERT
                # commitar. Ficou mais provável com o processamento de webhook
                # concorrente (routes_bridge.py::WEBHOOK_EXECUTOR). Duplicata
                # vazia já removida manualmente antes desta migration rodar.
                "ALTER TABLE conversations ADD UNIQUE KEY ux_conversations_contact_account (contact_id, account_id)",
            ]:
                try:
                    conn.execute(text(stmt))
                    conn.commit()
                    logger.info(f"Migration aplicada: {stmt[:60]}")
                except Exception:
                    pass  # Coluna já existe — ignorar
    except Exception as mig_err:
        logger.warning(f"Erro nas migrations de startup: {mig_err}")

    # Seed dos papéis padrão (admin/supervisor/attendant) na tabela roles
    try:
        from backend.database.seed import seed_default_roles
        db_seed = next(get_db())
        try:
            seed_default_roles(db_seed)
        finally:
            db_seed.close()
    except Exception as seed_err:
        logger.warning(f"Erro ao popular papéis padrão: {seed_err}")


    logger.info("WhatsApp Chat Backend iniciado com sucesso!")
    logger.info("Interface web: /app")
    logger.info("API REST: /api/*")
    logger.info("Documentação: /docs")

    watchdog_task = asyncio.create_task(run_bridge_watchdog())
    csat_watchdog_task = asyncio.create_task(run_csat_timeout_watchdog())
    bot_health_watchdog_task = asyncio.create_task(run_bot_health_watchdog())
    task_pause_reminder_watchdog_task = asyncio.create_task(run_task_pause_reminder_watchdog())
    task_due_reminder_watchdog_task = asyncio.create_task(run_task_due_reminder_watchdog())
    # DESATIVADO 2026-09-11 (pedido direto do usuário, "para esse fallback em
    # massa"): o primeiro ciclo, ainda com a versão sem a proteção contra
    # contas sem fallback, marcou ~819 mensagens da ti01 como FAILED antes do
    # restart com a correção pegar efeito, e reenviou 16 mensagens (contas
    # #14/#15) que podem ter sido apenas lentas pra confirmar entrega, não
    # necessariamente perdidas — risco real de mensagem duplicada pro
    # cliente. Precisa de revisão cuidadosa (janela de tempo maior antes de
    # considerar "presa", confirmação mais forte de não-entrega) antes de
    # religar. Ver stuck_wppconnect_watchdog.py.
    #
    # Reforçado 2026-09-16 (achado ao vivo, do lado app-teste): app-teste e
    # app (prod) apontam pros MESMOS bridges/portas reais (BAILEYS_BRIDGE_PORT
    # =3001, WPPCONNECT_PORT=3003 idênticos nos dois .env — ver conta
    # #14/#19, sem bridge_port próprio no provider_config) e compartilham o
    # MESMO MySQL (ver project_teste_prod_shared_db) — esse watchdog rodando
    # em app-teste bateria direto na conta REAL de produção do mesmo jeito.
    # Confirmado ao vivo: reenviou pelo menos 9 mensagens da conta #14 numa
    # janela de ~2h com uma versão antiga ainda ligada em app-teste
    # (inclusive uma IMAGEM, #36154, reenviada como TEXTO com texto vazio —
    # o watchdog nunca soube tratar mídia, só usa message_text). Precisa da
    # mesma revisão cuidadosa acima antes de religar EM QUALQUER UM dos dois apps.
    # stuck_msg_watchdog_task = asyncio.create_task(run_stuck_wppconnect_watchdog())

    yield

    # SHUTDOWN
    watchdog_task.cancel()
    csat_watchdog_task.cancel()
    bot_health_watchdog_task.cancel()
    task_pause_reminder_watchdog_task.cancel()
    task_due_reminder_watchdog_task.cancel()
    # stuck_msg_watchdog_task.cancel()
    logger.info("Encerrando WhatsApp Chat Backend...")

async def validate_webhook_signature(request: Request, call_next):
    """
    Middleware com logs detalhados para descobrir onde está o erro.
    Movido para após o lifespan para garantir que `app` seja a instncia final.
    """
    
    # 1. RADAR: Logar TUDO que chega para sabermos o que está a acontecer
    logger.info(f"RADAR: Recebi pedido {request.method} em: {request.url.path}")

    # Verificar se é o Webhook do WhatsApp
    if request.method == "POST" and request.url.path == "/api/webhook":
        
        logger.info("Rota correta detetada! A iniciar validação de segurança...")

        # --- INICIO DA VALIDAÇÃO (Igual ao anterior) ---
        signature_header = request.headers.get("x-hub-signature-256")
        if not signature_header:
            logger.warning("Rejeitado: Assinatura em falta.")
            return Response(content="Missing Signature", status_code=401)

        try:
            body_bytes = await request.body()
            app_secret = os.getenv("M4D_APP_SECRET")
            
            if not app_secret:
                logger.error("ERRO CRÍTICO: M4D_APP_SECRET não configurado.")
                return Response(content="Server Config Error", status_code=500)

            # Calcular a assinatura esperada
            expected_hash = hmac.new(
                app_secret.encode('utf-8'),
                body_bytes,
                hashlib.sha256
            ).hexdigest()
            
            expected_signature = f"sha256={expected_hash}"

            if not hmac.compare_digest(expected_signature, signature_header):
                logger.error("Rejeitado: Assinatura inválida!")
                # Debug extra para ver o que falhou
                logger.debug(f"   Recebido: {signature_header}")
                logger.debug(f"   Calculado: {expected_signature}")
                return Response(content="Invalid Signature", status_code=403)
            
            logger.info("Assinatura válida! Passando para o endpoint...")

            # Restaurar o corpo para que o endpoint possa ler o JSON
            async def receive():
                return {"type": "http.request", "body": body_bytes}
            request._receive = receive

        except Exception as e:
            logger.error(f"Erro durante validação: {e}")
            return Response(content="Internal Validation Error", status_code=500)
        # --- FIM DA VALIDAÇÃO ---

    response = await call_next(request)
    return response

# Criar aplicação FastAPI
app = FastAPI(
    title="WhatsApp Chat API",
    description="API REST para gerenciar chat do WhatsApp Business Cloud API",
    version="1.0.1",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc"
)

# MIDDLEWARE DE VALIDAÇÃO (CRÍTICO!)
# IMPORTANTE: Este middleware DEVE vir ANTES do CORS
# A função foi definida acima e é adicionada aqui.
app.middleware("http")(validate_webhook_signature)


@app.middleware("http")
async def harden_uploaded_files(request: Request, call_next):
    """Arquivos enviados por usuários nunca executam script na nossa origem (HTML/SVG enviados)."""
    response = await call_next(request)
    if request.url.path.startswith("/uploads/"):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"
        )
    return response

# CORS
allowed_origins = [
    "http://localhost:3000",
    "http://localhost:8000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8000",
]

env_origins = os.getenv("CORS_ORIGINS", "")
if env_origins:
    allowed_origins.extend(env_origins.split(","))

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# WEBHOOK ENDPOINTS (FIX: Movidos para local correto)

# Rota GET: Verificação do webhook
@app.get("/api/webhook")
async def verify_webhook(request: Request):
    """Verificação do Webhook (Meta GET Request)"""
    
    VERIFY_TOKEN = os.getenv("WEBHOOK_VERIFY_TOKEN")
    
    if not VERIFY_TOKEN:
        logger.error("ERRO CRÍTICO: WEBHOOK_VERIFY_TOKEN não configurado.")
        raise HTTPException(status_code=500, detail="Server Config Error")

    try:
        mode = request.query_params.get("hub.mode")
        token = request.query_params.get("hub.verify_token")
        challenge = request.query_params.get("hub.challenge")

        if mode == "subscribe" and token == VERIFY_TOKEN:
            logger.info("Webhook verificado com sucesso!")
            return Response(content=challenge, media_type="text/plain", status_code=200)
        
        logger.warning("Falha na verificação do webhook: Token ou modo inválido.")
        raise HTTPException(status_code=403, detail="Invalid verification credentials")

    except Exception as e:
        logger.error(f"Erro na verificação do webhook: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Rota POST: Onde as mensagens do WhatsApp chegam (FIX: Implementação da lógica)
@app.post("/api/webhook")
async def handle_message(request: Request, db: Session = Depends(get_db)):
    try:
        # O corpo do request já foi restaurado pelo middleware
        payload = await request.json()
        
        logger.info(f"Payload recebido: {json.dumps(payload, indent=2)}")

        # Processar payload usando o handler de serviço (FIX: Lógica de processamento)
        result = await webhook_handler.process_webhook(db, payload)

        return JSONResponse(content=result, status_code=200)

    except Exception as e:
        logger.error(f"Erro ao processar mensagem: {str(e)}", exc_info=True)
        # Retorna 200 OK para evitar re-envio excessivo do Meta
        return JSONResponse(content={"status": "error", "message": "Internal Error"}, status_code=200)

# API ROUTES (Prefixo /api)
app.include_router(router, prefix="/api", tags=["WhatsApp API"])
app.include_router(router_extended, tags=["WhatsApp Advanced"])
app.include_router(woocommerce_router, prefix="/api", tags=["WooCommerce"])
app.include_router(router_auth)
app.include_router(router_admin)
app.add_middleware(ProviderRoutingMiddleware)
app.include_router(settings_router, tags=["Settings"]) 
app.include_router(templates_router, prefix="/api", tags=["Templates"])
app.include_router(config_router, tags=["Admin Config"])
app.include_router(flows_router, prefix="/api", tags=["Flows"])
app.include_router(flows_webhook_router, prefix="/api", tags=["Flows"])
app.include_router(embedded_signup_router, prefix="/api", tags=["Embedded Signup"])
app.include_router(router_bridge, tags=["Bridge"])
app.include_router(router_baileys)
app.include_router(router_attendance, prefix="/api", tags=["Atendimento"])
app.include_router(ai_bot_router, prefix="/api", tags=["Bot/IA"])
app.include_router(evolution_compat_router, tags=["Evolution Compat"])
app.include_router(router_internal_chat, prefix="/api/internal-chats", tags=["Chat Interno"])
app.include_router(router_stickers, prefix="/api/stickers", tags=["Stickers"])
app.include_router(router_saved_contacts, prefix="/api/saved-contacts", tags=["Saved Contacts"])
app.include_router(router_giphy, prefix="/api/giphy", tags=["Giphy"])
app.include_router(router_broadcast)
app.include_router(router_push, prefix="/api/push", tags=["Push"])
app.include_router(router_site_chat)
app.include_router(router_site_chat_questions)
# Último add_middleware = mais externo: precisa interceptar o preflight do widget
# (outra origem) antes do CORSMiddleware global.
app.add_middleware(SiteChatCORSMiddleware)

# WEBSOCKET
app.mount("/socket.io", socket_app)

# ARQUIVOS ESTÁTICOS (uploads)
if UPLOAD_DIR.exists():
    app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# VERIFICAR SE FRONTEND FOI BUILDADO
FRONTEND_BUILD = Path("frontend/build")
FRONTEND_EXISTS = FRONTEND_BUILD.exists() and (FRONTEND_BUILD / "index.html").exists()

if FRONTEND_EXISTS:
    logger.info("Frontend React detectado!")
    
    # Servir arquivos estáticos do React
    app.mount("/static", StaticFiles(directory=str(FRONTEND_BUILD / "static")), name="static")
    # Assets públicos do build (logos/ícones da marca em public/assets)
    if (FRONTEND_BUILD / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(FRONTEND_BUILD / "assets")), name="brand-assets")

    # Service Worker do Web Push (ver src/utils/desktopNotify.js) — PRECISA
    # ficar na raiz (não em /static/, que é só JS/CSS do bundle): o escopo
    # de um Service Worker é a pasta de onde ele é servido. Só /static,
    # /assets e /uploads são montados acima — sem essa rota dedicada,
    # /push-sw.js (que existe em frontend/build/, copiado de public/) não
    # tinha NENHUMA rota servindo (404), então o registro do Service Worker
    # falhava sempre.
    @app.get("/push-sw.js")
    async def serve_push_service_worker():
        return FileResponse(
            FRONTEND_BUILD / "push-sw.js",
            media_type="application/javascript",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Service-Worker-Allowed": "/"},
        )
else:
    logger.warning("Frontend React NÃO foi buildado!")
    logger.warning("   Execute 'cd frontend && npm run build' para buildar o frontend")

# PÁGINA INICIAL

@app.get("/", response_class=HTMLResponse)
async def root():
    """Página inicial com informações do sistema"""
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp Chat API</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            h1 { color: #25D366; }
            .link { display: block; margin: 10px 0; }
            .status { padding: 5px 10px; border-radius: 5px; }
            .ok { background: #d4edda; color: #155724; }
            .warning { background: #fff3cd; color: #856404; }
        </style>
    </head>
    <body>
        <h1>🐍 WhatsApp Chat Backend - Python</h1>
        <p>Sistema de gerenciamento de chat WhatsApp Business Cloud API</p>
        
        <h2>📱 Acesso Rápido</h2>
        <a href="/app" class="link">Interface Web (Atendentes)</a>
        <a href="/docs" class="link">Documentação da API (Swagger)</a>
        <a href="/api/health" class="link">Health Check</a>
        
        <h2>📊 Status do Sistema</h2>
        <div class="status ok">API Online (v1.0.1 - Signature Fix)</div>
    </body>
    </html>
    """
    return html_content

# SERVIR FRONTEND REACT

@app.get("/app", response_class=HTMLResponse)
async def serve_frontend():
    """Serve a interface React"""
    if FRONTEND_EXISTS:
        # Sem isso, o navegador pode cachear index.html por conta própria
        # (heurística baseada em Last-Modified) e continuar carregando o
        # bundle JS antigo por horas depois de um deploy novo — usuário via
        # comportamento de código já corrigido, mesmo com o build novo já no
        # ar (aconteceu de verdade: "Novo Chat" continuava caindo no alert
        # antigo depois do fix já publicado). Os arquivos dentro de /static/
        # são hasheados por conteúdo (main.<hash>.js) e PODEM cachear pra
        # sempre — só o index.html (que aponta pro hash certo) precisa
        # revalidar sempre.
        return FileResponse(
            FRONTEND_BUILD / "index.html",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
    else:
        return HTMLResponse("""
            <html>
            <body>
                <h1>⚠️ Frontend não buildado</h1>
                <p>Execute: <code>cd frontend && npm install && npm run build</code></p>
            </body>
            </html>
        """, status_code=503)

# API ENDPOINTS

@app.get("/api")
async def api_info():
    """Informações sobre a API"""
    return {
        "name": "WhatsApp Chat API",
        "version": "1.0.1",
        "signature_validation": "fixed",
        "description": "API REST para gerenciar chat do WhatsApp Business Cloud API",
        "endpoints": [
            "/api/auth/login - Login",
            "/api/health - Health check",
            "/api/webhook - Webhook do WhatsApp",
            "/api/send - Enviar mensagens",
            "/api/conversations - Listar conversas",
            "/api/woocommerce/webhook/order - Webhook WooCommerce",
            "/docs - Documentação completa"
        ],
        "features": [
            "Envio e recebimento de mensagens",
            "Suporte a múltiplos tipos de mídia",
            "WebSocket para atualizações em tempo real",
            "Interface web para atendentes",
            "API REST para integrações",
            "HMAC SHA256 signature validation (raw bytes)"
        ]
    }

@app.get("/api/config")
async def api_config():
    """Configurações da API (apenas informações públicas)"""
    return {
        "environment": os.getenv("DEBUG", "False"),
        "whatsapp_configured": bool(os.getenv("WA_PHONE_NUMBER_ID")),
        "database_configured": bool(os.getenv("DB_NAME") or os.getenv("DATABASE_URL")),
        "frontend_built": FRONTEND_EXISTS,
        "cors_origins": allowed_origins,
        "webhook_signature_validation": "enabled (raw bytes)",
        "signature_validation_fix": "v1.0.1"
    }

# HEALTH CHECK
@app.get("/api/health")
async def health_check():
    """Verificar status do sistema"""
    # check_db_connection() é síncrona (pymysql); rodar em thread separada
    # evita que ela trave o único worker/loop do processo caso o pool de
    # conexões esteja saturado (causa do incidente de 2026-09-02).
    db_ok = await asyncio.to_thread(check_db_connection)
    return {
        "status": "ok",
        "version": "1.0.1",
        "signature_fix": "applied",
        "frontend": "available" if FRONTEND_EXISTS else "not_built",
        "database": "connected" if db_ok else "disconnected",
        "whatsapp": "configured" if os.getenv("WA_PHONE_NUMBER_ID") else "not_configured",
        "webhook_security": "enabled (raw bytes)" if os.getenv("M4D_APP_SECRET") else "disabled"
    }

# MAIN
if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("APP_PORT", 8000))
    host = os.getenv("APP_HOST", "0.0.0.0")
    debug = os.getenv("DEBUG", "False") == "True"
    
    logger.info(f"Iniciando servidor em {host}:{port}")
    logger.info(f"Interface: http://{host}:{port}/app")
    logger.info(f"API: http://{host}:{port}/api/*")
    logger.info(f"Docs: http://{host}:{port}/docs")
    
    uvicorn.run(
        "app:app",
        host=host,
        port=port,
        reload=debug,
        log_level="info"
    )

