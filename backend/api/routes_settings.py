# backend/api/routes_settings.py
"""
Rotas de Configurações — /api/settings/*

AUTENTICAÇÃO:
  Endpoints que expõem dados sensíveis exigem token Bearer válido.
  Endpoints de leitura pública (ex: /credentials mascaradas) permitem acesso sem token
  apenas para uso interno do painel já autenticado.

  Protegidos (exigem token):
    GET  /accounts            → lista contas (número de tel, provider, status)
    POST /accounts            → cria conta
    DELETE /accounts/{id}     → remove conta
    PATCH /accounts/{id}/toggle
    GET  /accounts/{id}/qr
    POST /accounts/{id}/pairing-code
    POST /accounts/{id}/logout
    GET  /accounts/{id}/auth-status
    GET/POST /users           → lista/cria usuários
    DELETE /users/{username}
"""
import os
import re
import json
import uuid
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, validator

from backend.database.connection import get_db
from backend.services.auth_service import auth_service

logger = logging.getLogger(__name__)

settings_router = APIRouter(prefix="/api/settings", tags=["Settings"])
_bearer = HTTPBearer(auto_error=False)
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# AUTH: dependency opcional — não bloqueia mas loga acesso

def _require_auth(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
):
    """
    Exige token Bearer válido.
    Aceita JWT real (auth_service) e token simulado (simulated_token_*) do sistema legado.
    """
    token = credentials.credentials if credentials else None

    if not token:
        logger.warning("[Settings:AUTH] Acesso sem token em %s %s. Headers recebidos: %s",
                       request.method, request.url.path, dict(request.headers))
        raise HTTPException(status_code=401, detail="Token de autenticação necessário")

    # 1. Tenta JWT real
    try:
        payload = auth_service.decode_token(token)
        logger.debug("[Settings:AUTH] JWT válido user_id=%s path=%s",
                     payload.get("user_id"), request.url.path)
        return payload
    except Exception:
        pass

    # 2. Aceita token simulado legado: "simulated_token_{username}_{n}"
    if token.startswith("simulated_token_"):
        parts = token.split("_")
        # formato: simulated_token_{username}_{len} → mínimo 3 partes após split
        if len(parts) >= 3:
            username = "_".join(parts[2:-1]) if len(parts) > 3 else parts[2]
            logger.debug("[Settings:AUTH] Token legado aceito username='%s' path=%s",
                         username, request.url.path)
            return {"user_id": None, "username": username, "legacy": True}

    logger.warning("[Settings:AUTH] Token inválido em %s", request.url.path)
    raise HTTPException(status_code=401, detail="Token inválido ou expirado")


def _require_perm(db: Session, _auth: dict, key: str) -> None:
    """
    Checa a permissão `key` do usuário do token contra a matriz de papéis
    (backend/api/permissions.py). `_require_auth` só garante token válido —
    isso aqui é quem de fato bloqueia (403) quem não tem o papel certo.
    Token legado (sem user_id) é tratado como sem permissão nenhuma.
    """
    from backend.database.models import User
    from backend.api.permissions import user_has_permission

    user_id = _auth.get("user_id")
    user = db.query(User).filter(User.id == user_id).first() if user_id else None
    if not user or not user_has_permission(db, user, key):
        raise HTTPException(status_code=403, detail=f"Seu papel não tem permissão para esta ação ('{key}').")


def _require_account_scope(db: Session, _auth: dict, account_id: int) -> None:
    """
    BUG/lacuna real (2026-09-14, pedido do usuário): antes disso, quem
    tinha feature_qr_manager conseguia reconectar/desconectar QUALQUER
    conta do sistema, não só a(s) vinculada(s) a ele — a permissão liberava
    a AÇÃO mas não restringia o ALVO. Chamar isso logo após
    _require_any_perm/_require_perm(feature_qr_manager ou settings_accounts)
    fecha essa lacuna: quem tem feature_view_all_accounts (ou é admin, já
    coberto por user_has_permission) mexe em qualquer conta; quem não tem
    só pode agir nas contas que aparecem em user_account_access pra ele —
    mesmo escopo já usado em GET /accounts pra decidir o que listar.
    """
    from backend.database.models import User
    from backend.api.permissions import user_has_permission

    user_id = _auth.get("user_id")
    user = db.query(User).filter(User.id == user_id).first() if user_id else None
    if not user:
        raise HTTPException(status_code=403, detail="Sessão inválida.")
    if user_has_permission(db, user, "feature_view_all_accounts"):
        return
    allowed_ids = {a.id for a in user.granted_accounts}
    if account_id not in allowed_ids:
        raise HTTPException(status_code=403, detail="Você não tem acesso a esta conta.")

# HELPER: normaliza provider_type independente do nome do Enum

def _normalize_provider(raw) -> str:
    return str(raw).lower().split(".")[-1]

UNOFFICIAL_PROVIDERS = {"baileys", "venom", "whatsapp_web_js", "wppconnect"}

# SCHEMAS

class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=6)

class DisplayNameFormatRequest(BaseModel):
    format: str  # "first_initial" | "initial_last" — ver backend/utils/display_name.py

class AutoReplySettings(BaseModel):
    enabled:       bool = False
    message:       str  = "Olá! Recebemos sua mensagem e responderemos em breve."
    delay_seconds: int  = Field(default=5, ge=0, le=300)

class OffHoursSettings(BaseModel):
    enabled: bool = False
    message: str  = "Nosso atendimento é seg-sex 8h–18h. Retornaremos em breve!"
    start:   str  = "18:00"
    end:     str  = "08:00"

class CsatSettings(BaseModel):
    enabled: bool = False
    message: str  = "De 1 a 5, como você avalia nosso atendimento? Responda só com o número 😊"
    # Horas sem resposta até a janela de CSAT se auto-encerrar (awaiting_csat
    # volta a False sozinho, via csat_timeout_watchdog) — 0 = nunca expira.
    timeout_hours: int = 24

class SlaSettings(BaseModel):
    # Limite (minutos) a partir do qual o indicador de tempo na Sidebar fica
    # vermelho — tanto pra conversa esperando atribuição (fila) quanto pra
    # conversa já atribuída mas ainda não resolvida.
    wait_minutes: int = 10

class AutomationsPayload(BaseModel):
    auto_reply: AutoReplySettings = AutoReplySettings()
    off_hours:  OffHoursSettings  = OffHoursSettings()
    csat:       CsatSettings      = CsatSettings()
    sla:        SlaSettings       = SlaSettings()

class PermissionMatrix(BaseModel):
    matrix: Dict[str, Dict[str, bool]]

class UserCreate(BaseModel):
    username: str
    password: str
    role:     str = "attendant"
    sector:   Optional[str] = None

    @validator("role")
    def validate_role(cls, v):
        allowed = {"admin", "supervisor", "attendant"}
        if v not in allowed:
            raise ValueError(f"Role inválido. Permitidos: {allowed}")
        return v

class AccountCreate(BaseModel):
    account_name:  str
    phone_number:  str
    provider_type: str
    meta_phone_number_id:      Optional[str] = None
    meta_access_token:         Optional[str] = None
    meta_business_account_id:  Optional[str] = None
    meta_catalog_id:           Optional[str] = None
    bridge_host:               Optional[str] = None
    bridge_port:               Optional[str] = None
    session_id:                Optional[str] = None
    wppconnect_url:            Optional[str] = None
    wppconnect_token:          Optional[str] = None
    ai_webhook_enabled:        Optional[bool] = None
    ai_webhook_url:            Optional[str] = None
    ai_webhook_secret:         Optional[str] = None
    ai_webhook_format:         Optional[str] = None

    @validator("ai_webhook_format")
    def validate_ai_webhook_format(cls, v):
        if v is not None and v not in {"generic", "evolution_compat"}:
            raise ValueError("ai_webhook_format inválido. Aceitos: 'generic', 'evolution_compat'")
        return v

class AccountUpdate(BaseModel):
    account_name:  Optional[str] = None
    phone_number:  Optional[str] = None
    provider_type: Optional[str] = None
    meta_phone_number_id:      Optional[str] = None
    meta_access_token:         Optional[str] = None
    meta_business_account_id:  Optional[str] = None
    meta_catalog_id:           Optional[str] = None
    bridge_host:               Optional[str] = None
    bridge_port:               Optional[str] = None
    session_id:                Optional[str] = None
    wppconnect_url:            Optional[str] = None
    wppconnect_token:          Optional[str] = None
    ai_webhook_enabled:        Optional[bool] = None
    ai_webhook_url:            Optional[str] = None
    ai_webhook_secret:         Optional[str] = None
    ai_webhook_format:         Optional[str] = None
    # Desliga fila/SLA/"tempo de atendimento" pra essa conta no Painel Admin —
    # pra número que não é atendimento ao cliente de verdade (ex: linha
    # interna de TI/Logística falando com fornecedor), onde ninguém é
    # "atendente" respondendo e não faz sentido contar como cliente
    # esperando. Não muda nada no chat em si, só sai das métricas — ver
    # routes_admin.py::_client_conv_filters.
    attendance_enabled:        Optional[bool] = None

    @validator("ai_webhook_format")
    def validate_ai_webhook_format_update(cls, v):
        if v is not None and v not in {"generic", "evolution_compat"}:
            raise ValueError("ai_webhook_format inválido. Aceitos: 'generic', 'evolution_compat'")
        return v


class PairingCodeRequest(BaseModel):
    phone_number: str

    @validator("phone_number")
    def clean_phone(cls, v):
        digits = re.sub(r"\D", "", v)
        if len(digits) < 10 or len(digits) > 15:
            raise ValueError("Número inválido (mín 10, máx 15 dígitos)")
        return digits

# SETTINGS FILE

SETTINGS_FILE = os.path.join(os.path.dirname(__file__), "../../data/settings.json")

def _load_settings() -> Dict[str, Any]:
    try:
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r") as f:
                return json.load(f)
    except Exception as exc:
        logger.warning("Não foi possível carregar settings: %s", exc)
    return {}

def _save_settings(data: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w") as f:
            json.dump(data, f, indent=2, default=str)
    except Exception as exc:
        logger.error("Não foi possível salvar settings: %s", exc)
        raise HTTPException(status_code=500, detail="Erro ao salvar configurações")

# FACTORY

def _instantiate_unofficial_provider(provider_str: str, config: Dict) -> Any:
    logger.debug("[Settings] Instanciando provider '%s'", provider_str)
    from backend.providers.factory import get_unofficial_provider
    return get_unofficial_provider(provider_str, config)

def _load_provider_config(account) -> Dict:
    config = {}
    if account.provider_config:
        try:
            config = json.loads(account.provider_config) if isinstance(account.provider_config, str) else (account.provider_config or {})
        except (json.JSONDecodeError, TypeError):
            logger.warning("[Settings] provider_config inválido para conta %s", account.id)
    return config

# MINHA CONTA — troca de senha do próprio usuário logado.
#
# Credenciais de provider (Meta/bridges) NÃO ficam mais aqui — isso vivia
# num store global em settings.json, desconectado das contas reais em
# WhatsAppAccount (o `get_provider()` que efetivamente envia mensagem nunca
# lia esse arquivo). Cada conta tem suas próprias credenciais, editáveis em
# Configurações → Contas WA, no cadastro/edição da conta.

@settings_router.post("/me/password")
async def change_my_password(payload: PasswordChangeRequest, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    from backend.database.models import User
    from backend.services.auth_service import AuthService

    user = None
    if _auth.get("user_id"):
        user = db.query(User).filter(User.id == _auth["user_id"]).first()
    if not user and _auth.get("username"):
        user = db.query(User).filter(User.email == _auth["username"]).first()
    if not user:
        raise HTTPException(status_code=401, detail="Não foi possível identificar o usuário — faça login novamente")

    if not AuthService.verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Senha atual incorreta")

    user.password_hash = AuthService.hash_password(payload.new_password)
    db.commit()
    return {"success": True, "message": "Senha alterada com sucesso"}

@settings_router.patch("/me/display-name")
async def update_my_display_name_format(payload: DisplayNameFormatRequest, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    """Como o nome desta pessoa aparece pro cliente (prefixo de identidade
    nas mensagens) e pra equipe (chat interno) — ver backend/utils/display_name.py."""
    from backend.database.models import User
    from backend.utils.display_name import DISPLAY_NAME_FORMATS

    if payload.format not in DISPLAY_NAME_FORMATS:
        raise HTTPException(status_code=400, detail=f"Formato inválido — use um de: {', '.join(DISPLAY_NAME_FORMATS)}")

    user = None
    if _auth.get("user_id"):
        user = db.query(User).filter(User.id == _auth["user_id"]).first()
    if not user and _auth.get("username"):
        user = db.query(User).filter(User.email == _auth["username"]).first()
    if not user:
        raise HTTPException(status_code=401, detail="Não foi possível identificar o usuário — faça login novamente")

    user.display_name_format = payload.format
    db.commit()
    return {"success": True, "display_name_format": user.display_name_format}


def _get_settings_current_user(db: Session, _auth: dict):
    from backend.database.models import User
    user = None
    if _auth.get("user_id"):
        user = db.query(User).filter(User.id == _auth["user_id"]).first()
    if not user and _auth.get("username"):
        user = db.query(User).filter(User.email == _auth["username"]).first()
    if not user:
        raise HTTPException(status_code=401, detail="Não foi possível identificar o usuário — faça login novamente")
    return user


@settings_router.post("/me/photo")
async def upload_my_photo(photo: UploadFile = File(...), db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    """
    Foto de perfil pro chat interno (Equipe) — upload manual. Mesmo padrão de
    salvar arquivo de update_internal_group_photo (routes_internal_chat.py).
    """
    user = _get_settings_current_user(db, _auth)

    original_name = photo.filename or "foto.jpg"
    safe_original = "".join(c if c.isalnum() or c in "._-" else "_" for c in original_name)
    safe_name = f"{uuid.uuid4().hex}_{safe_original}"
    file_path = UPLOAD_DIR / safe_name
    content = await photo.read()
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    user.photo_url = f"/uploads/{safe_name}"
    db.commit()
    return {"success": True, "photo_url": user.photo_url}


class PhotoFromWhatsAppRequest(BaseModel):
    jid: str
    account_id: int


@settings_router.post("/me/photo/from-whatsapp")
async def copy_my_photo_from_whatsapp(payload: PhotoFromWhatsAppRequest, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    """
    Cópia PONTUAL (não é sincronização contínua) da foto de perfil de um
    contato/número do WhatsApp pra virar a foto de perfil desta pessoa no
    chat interno — só quando ela pedir explicitamente (botão "Usar foto do
    WhatsApp" em Configurações > Minha Conta), nunca automático.
    """
    import httpx
    from backend.api.routes import get_provider

    user = _get_settings_current_user(db, _auth)

    try:
        provider, _kind = get_provider(db, payload.account_id)
        result = await provider.get_profile_picture(payload.jid, True)
    except Exception as e:
        logger.error(f"Erro ao buscar foto de perfil do WhatsApp: {e}")
        raise HTTPException(status_code=502, detail="Não foi possível buscar a foto desse número agora.")

    photo_url = (result or {}).get("url")
    if not photo_url:
        raise HTTPException(status_code=404, detail="Esse número não tem foto de perfil pública.")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(photo_url)
            resp.raise_for_status()
            content = resp.content
    except Exception as e:
        logger.error(f"Erro ao baixar foto de perfil do WhatsApp: {e}")
        raise HTTPException(status_code=502, detail="Não foi possível baixar a foto desse número agora.")

    safe_name = f"{uuid.uuid4().hex}_whatsapp.jpg"
    file_path = UPLOAD_DIR / safe_name
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    user.photo_url = f"/uploads/{safe_name}"
    db.commit()
    return {"success": True, "photo_url": user.photo_url}

# AUTOMAÇÕES

_AUTOMATION_SUBKEYS = {
    "auto_reply": "settings_auto_reply",
    "off_hours":  "settings_business_hours",
    "csat":       "settings_csat",
    "sla":        "settings_sla",
}


def _require_any_automation_perm(db: Session, _auth: dict) -> None:
    """
    GET só precisa que o papel tenha PELO MENOS UMA das 4 sub-permissões —
    quem só mexe em CSAT ainda precisa conseguir carregar o formulário pra
    ver o que já está salvo (mesmo sem poder editar auto-resposta/horário/SLA).
    """
    from backend.database.models import User
    from backend.api.permissions import user_has_permission

    user_id = _auth.get("user_id")
    user = db.query(User).filter(User.id == user_id).first() if user_id else None
    if not user or not any(user_has_permission(db, user, key) for key in _AUTOMATION_SUBKEYS.values()):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para ver automações.")


@settings_router.get("/automations")
async def get_automations(db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_any_automation_perm(db, _auth)
    settings = _load_settings()
    automations = settings.get("automations", {})
    return {
        "success": True,
        "data": {
            "auto_reply": automations.get("auto_reply", AutoReplySettings().dict()),
            "off_hours":  automations.get("off_hours",  OffHoursSettings().dict()),
            # Passa pelo modelo Pydantic (não só .get cru) pra que uma instalação
            # já em produção, com "csat" salvo antes do campo timeout_hours
            # existir, herde o default em vez de faltar a chave no JSON de resposta.
            "csat":       CsatSettings(**automations.get("csat", {})).dict(),
            "sla":        automations.get("sla",        SlaSettings().dict()),
        }
    }

@settings_router.post("/automations")
async def save_automations(payload: AutomationsPayload, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    """
    Permissão granular por sub-seção (Resposta Automática / Horário / CSAT /
    SLA são 4 permissões distintas — settings_auto_reply/settings_business_hours/
    settings_csat/settings_sla) em vez de um settings_automations único: só
    bloqueia a sub-seção que o papel não pode mexer, não o formulário inteiro
    — quem só tem settings_sla ainda consegue salvar o resto sem mudar
    (reenvia os mesmos valores), só não pode ALTERAR csat/horário/auto-resposta.
    """
    from backend.database.models import User
    from backend.api.permissions import user_has_permission

    user_id = _auth.get("user_id")
    user = db.query(User).filter(User.id == user_id).first() if user_id else None
    if not user:
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para salvar automações.")

    settings = _load_settings()
    current = settings.get("automations", {})
    new_values = {
        "auto_reply": payload.auto_reply.dict(),
        "off_hours":  payload.off_hours.dict(),
        "csat":       payload.csat.dict(),
        "sla":        payload.sla.dict(),
    }
    for subkey, perm_key in _AUTOMATION_SUBKEYS.items():
        stored = current.get(subkey, {})
        if new_values[subkey] != stored and not user_has_permission(db, user, perm_key):
            raise HTTPException(status_code=403, detail=f"Seu papel não tem permissão para alterar '{subkey}'.")

    settings["automations"] = {**new_values, "updated_at": datetime.utcnow().isoformat()}
    _save_settings(settings)
    return {"success": True, "message": "Automações salvas com sucesso"}

# PERMISSÕES

DEFAULT_PERMISSIONS: Dict[str, Dict[str, bool]] = {
    "admin": {
        "settings_general": True, "settings_accounts": True, "settings_credentials": True,
        "settings_analytics": True, "settings_business_profile": True, "settings_users": True,
        "settings_automations": True, "feature_send_templates": True, "feature_send_media": True,
        "feature_send_interactive": True, "feature_send_products": True, "feature_send_location": True,
        "feature_send_contacts": True, "feature_qr_manager": True, "feature_export_data": True,
        "feature_view_all_chats": True, "feature_broadcast": True,
    },
    "supervisor": {
        "settings_general": True, "settings_accounts": False, "settings_credentials": False,
        "settings_analytics": True, "settings_business_profile": True, "settings_users": False,
        "settings_automations": True, "feature_send_templates": True, "feature_send_media": True,
        "feature_send_interactive": True, "feature_send_products": True, "feature_send_location": True,
        "feature_send_contacts": True, "feature_qr_manager": True, "feature_export_data": True,
        "feature_view_all_chats": True, "feature_broadcast": True,
    },
    "attendant": {
        "settings_general": True, "settings_accounts": False, "settings_credentials": False,
        "settings_analytics": False, "settings_business_profile": False, "settings_users": False,
        "settings_automations": False, "feature_send_templates": True, "feature_send_media": True,
        "feature_send_interactive": True, "feature_send_products": True, "feature_send_location": True,
        "feature_send_contacts": True, "feature_qr_manager": False, "feature_export_data": False,
        "feature_view_all_chats": False, "feature_broadcast": False,
    },
}

@settings_router.get("/permissions")
async def get_permissions(_auth=Depends(_require_auth)):
    settings = _load_settings()
    matrix = settings.get("permissions", DEFAULT_PERMISSIONS)
    return {"success": True, "data": {"matrix": matrix}}

@settings_router.post("/permissions")
async def save_permissions(payload: PermissionMatrix, _auth=Depends(_require_auth)):
    settings = _load_settings()
    settings["permissions"] = payload.matrix
    settings["permissions_updated_at"] = datetime.utcnow().isoformat()
    _save_settings(settings)
    return {"success": True, "message": "Permissões salvas com sucesso"}

# CONTAS WHATSAPP — todos os endpoints exigem auth

@settings_router.get("/accounts")
async def get_accounts(db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    """Lista contas WhatsApp. Exige token. provider_type sempre retorna string limpa."""
    try:
        from backend.database.models import WhatsAppAccount, User
        from backend.api.permissions import user_has_permission
        from sqlalchemy import select

        # deleted_at IS NULL — conta "excluída" (soft-delete, admin) some da
        # lista pra todo mundo, mas a linha e as conversas/mensagens ligadas
        # a ela continuam intactas no banco. Ver routes_admin.py::delete_account_admin.
        accounts = db.execute(
            select(WhatsAppAccount).where(WhatsAppAccount.deleted_at.is_(None))
        ).scalars().all()

        # Restringe às contas explicitamente concedidas quando o papel do
        # usuário não tem feature_view_all_accounts (ex: atendente) — admin
        # sempre vê tudo, e supervisor/admin (via papel) também por padrão.
        caller = db.execute(select(User).where(User.id == _auth.get("user_id"))).scalar_one_or_none()
        if caller and not user_has_permission(db, caller, "feature_view_all_accounts"):
            allowed_ids = {a.id for a in caller.granted_accounts}
            accounts = [a for a in accounts if a.id in allowed_ids]

        # Token legado (sem user_id resolvido) não tem papel pra checar — trata
        # como sem permissão de credenciais (mascara), nunca libera por omissão.
        can_see_credentials = bool(caller) and user_has_permission(db, caller, "settings_credentials")
        def _mask(v):
            return v if (can_see_credentials or not v) else "••••••••"

        logger.info("[Settings:GET /accounts] user_id=%s total=%d", _auth.get("user_id"), len(accounts))

        from backend.models.schemas_auth import AuthenticationStatus

        data = []
        for a in accounts:
            provider_str    = _normalize_provider(a.provider_type)
            is_unofficial   = provider_str in UNOFFICIAL_PROVIDERS

            # Contas não-oficiais (baileys/venom/wppconnect) dependem de uma sessão
            # de dispositivo pareado no bridge, que pode cair sem que ninguém acione
            # "logout" (sessão expirada, deslogada do celular, bridge reiniciado e
            # sem conseguir restaurar). is_authenticated é uma coluna estática — sem
            # checar o bridge aqui ela fica presa em True mesmo com a sessão morta,
            # fazendo o app mostrar "conectado" enquanto todo envio falha com
            # "Sessão não autenticada". Verifica o estado real e corrige o banco
            # nos dois sentidos antes de responder.
            if is_unofficial and a.is_active:
                try:
                    config   = _load_provider_config(a)
                    provider = _instantiate_unofficial_provider(provider_str, config)
                    live_authenticated = await provider.is_authenticated()
                except Exception:
                    logger.warning("[Settings:GET /accounts] Falha ao checar status ao vivo da conta %s", a.id, exc_info=True)
                    live_authenticated = None

                if live_authenticated is not None and live_authenticated != a.is_authenticated:
                    a.is_authenticated = live_authenticated
                    a.authentication_status = (
                        AuthenticationStatus.AUTHENTICATED if live_authenticated else AuthenticationStatus.DISCONNECTED
                    )
                    db.commit()
                    logger.info("[Settings:GET /accounts] is_authenticated da conta %s corrigido para %s (estado real do bridge)",
                                a.id, live_authenticated)

            auth_status_str = _normalize_provider(a.authentication_status)

            logger.debug(
                "[Settings:GET /accounts] id=%s raw='%s' → '%s' unofficial=%s auth='%s'",
                a.id, a.provider_type, provider_str, is_unofficial, auth_status_str
            )
            provider_config = {}
            import json
            if a.provider_config:
                try:
                    provider_config = json.loads(a.provider_config) if isinstance(a.provider_config, str) else a.provider_config
                except:
                    pass

            data.append({
                "id":                    a.id,
                "account_name":          a.account_name,
                "phone_number":          a.phone_number,
                "provider_type":         provider_str,
                "is_active":             a.is_active,
                "is_authenticated":      a.is_authenticated,
                "authentication_status": auth_status_str.upper(),
                "requires_session_qr":   is_unofficial,
                "created_at":            a.created_at.isoformat() if a.created_at else None,
                "meta_phone_number_id":     a.meta_phone_number_id,
                "meta_access_token":        _mask(a.meta_access_token),
                "meta_business_account_id": a.meta_business_account_id,
                "meta_catalog_id":          a.meta_catalog_id,
                "bridge_host":              provider_config.get("bridge_host", ""),
                "bridge_port":              provider_config.get("bridge_port", ""),
                "session_id":               provider_config.get("session_id", a.session_id or ""),
                "wppconnect_url":           provider_config.get("wppconnect_url", ""),
                "wppconnect_token":         _mask(provider_config.get("wppconnect_token", "")),
                "ai_webhook_enabled":       a.ai_webhook_enabled or False,
                "ai_webhook_url":           a.ai_webhook_url or "",
                "ai_webhook_secret":        _mask(a.ai_webhook_secret or ""),
                "ai_webhook_format":        a.ai_webhook_format or "generic",
                "attendance_enabled":       a.attendance_enabled if a.attendance_enabled is not None else True,
                # Conta Baileys criada só como fallback de envio pra uma conta
                # WPPConnect com o MESMO número (ver _find_baileys_fallback_account
                # em routes.py) — não é uma conta WhatsApp independente de verdade
                # (nunca ingere histórico/mensagens, ver FALLBACK_ONLY_BAILEYS_SESSIONS
                # em baileys-bridge/index.js), então o front não deve listá-la como
                # card próprio nem deixar selecionar no trocador de contas — só
                # mostrar como selo vinculado à conta WPPConnect original.
                "fallback_for_account_id":  provider_config.get("fallback_for_account_id"),
            })

        logger.info("[Settings:GET /accounts] Retornando %d contas", len(data))
        return {"success": True, "data": data}

    except Exception as exc:
        logger.exception("[Settings:GET /accounts] Erro")
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.post("/accounts")
async def create_account(payload: AccountCreate, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_accounts")
    logger.info("[Settings:POST /accounts] provider='%s' phone='%s' user_id=%s",
                payload.provider_type, payload.phone_number, _auth.get("user_id"))
    try:
        from backend.database.models import WhatsAppAccount, User
        from backend.models.schemas_auth import ProviderType as PTEnum, AuthenticationStatus, ProviderTier
        from sqlalchemy import select

        # Usa o usuário do token se disponível, senão usa o primeiro admin
        user_id = _auth.get("user_id")
        if not user_id:
            admin = db.execute(
                select(User).where(User.is_active == True, User.is_admin == True).limit(1)
            ).scalar_one_or_none()
            if not admin:
                admin = db.execute(select(User).where(User.is_active == True).limit(1)).scalar_one_or_none()
            if not admin:
                raise HTTPException(status_code=503, detail="Nenhum usuário encontrado. Crie um usuário admin antes.")
            user_id = admin.id

        try:
            provider_enum = PTEnum(payload.provider_type.lower())
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"provider_type inválido: '{payload.provider_type}'. Aceitos: {[e.value for e in PTEnum]}"
            )

        if provider_enum.value.startswith("meta_cloud"):
            missing = []
            if not payload.meta_phone_number_id: missing.append("Phone Number ID")
            if not payload.meta_access_token: missing.append("Access Token")
            if not payload.meta_business_account_id: missing.append("Business Account ID")
            
            if missing:
                raise HTTPException(
                    status_code=422,
                    detail=f"Para contas da Meta, os seguintes dados são obrigatórios no cadastro da conta: {', '.join(missing)}."
                )

        tier_map = {
            PTEnum.META_CLOUD_BASIC:       ProviderTier.STARTER,
            PTEnum.META_CLOUD_COEXISTENCE: ProviderTier.BUSINESS,
            PTEnum.META_CLOUD_MMLITE:      ProviderTier.PROFESSIONAL,
            PTEnum.META_CLOUD_FULL:        ProviderTier.ENTERPRISE,
            PTEnum.BAILEYS:                ProviderTier.FREE,
            PTEnum.VENOM:                  ProviderTier.FREE,
            PTEnum.WHATSAPP_WEB_JS:        ProviderTier.FREE,
            PTEnum.WPPCONNECT:             ProviderTier.FREE,
            PTEnum.SITE_CHAT:              ProviderTier.FREE,
        }
        tier = tier_map.get(provider_enum, ProviderTier.STARTER)

        provider_config = {}
        if payload.bridge_host: provider_config["bridge_host"] = payload.bridge_host
        if payload.bridge_port: provider_config["bridge_port"] = payload.bridge_port
        if payload.session_id:  provider_config["session_id"]  = payload.session_id
        if payload.wppconnect_url:
            from backend.providers.factory import split_bridge_url
            host, port = split_bridge_url(payload.wppconnect_url)
            provider_config.setdefault("bridge_host", host)
            if port:
                provider_config.setdefault("bridge_port", port)
            provider_config["wppconnect_url"] = payload.wppconnect_url
        if payload.wppconnect_token:
            provider_config["secret_key"] = payload.wppconnect_token
            provider_config["wppconnect_token"] = payload.wppconnect_token

        account = WhatsAppAccount(
            user_id=user_id,
            account_name=payload.account_name,
            phone_number=payload.phone_number,
            provider_type=provider_enum,
            provider_tier=tier,
            meta_phone_number_id=payload.meta_phone_number_id,
            meta_access_token=payload.meta_access_token,
            meta_business_account_id=payload.meta_business_account_id,
            meta_catalog_id=payload.meta_catalog_id,
            provider_config=json.dumps(provider_config) if provider_config else None,
            ai_webhook_enabled=payload.ai_webhook_enabled or False,
            ai_webhook_url=payload.ai_webhook_url,
            ai_webhook_secret=payload.ai_webhook_secret,
            ai_webhook_format=payload.ai_webhook_format or "generic",
            is_active=True,
            is_authenticated=False,
            authentication_status=AuthenticationStatus.PENDING,
        )
        if provider_enum == PTEnum.SITE_CHAT:
            # Sem sessão/QR para parear: a conta já nasce pronta (chaves do
            # plugin são geradas na hora, em routes_site_chat._ensure_keys).
            account.is_authenticated = True
            account.authentication_status = AuthenticationStatus.AUTHENTICATED
        db.add(account)
        db.commit()
        db.refresh(account)
        if provider_enum == PTEnum.SITE_CHAT:
            from backend.api.routes_site_chat import _ensure_keys
            _ensure_keys(db, account)

        provider_str  = _normalize_provider(account.provider_type)
        is_unofficial = provider_str in UNOFFICIAL_PROVIDERS
        logger.info("[Settings:POST /accounts] id=%s provider='%s'", account.id, provider_str)

        return {
            "success": True,
            "data": {
                "id":                    account.id,
                "account_name":          account.account_name,
                "phone_number":          account.phone_number,
                "provider_type":         provider_str,
                "is_active":             account.is_active,
                "is_authenticated":      account.is_authenticated,
                "authentication_status": "PENDING",
                "requires_session_qr":   is_unofficial,
            }
        }
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("[Settings:POST /accounts] Erro")
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.post("/accounts/{account_id}/fallback")
async def create_fallback_account(account_id: int, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    """
    Cria (ou devolve, se já existir) uma conta Baileys "fallback de envio"
    vinculada à conta WPPConnect {account_id} — mesmo número de telefone,
    marcada com provider_config.fallback_for_account_id.

    Isso NÃO é uma conta WhatsApp independente: routes_bridge.py's
    _is_fallback_only_account() bloqueia qualquer ingestão de histórico ou
    mensagem ao vivo pra contas marcadas assim (ver comentário lá) — ela só
    serve pra rota /send/text tentar de novo quando o WPPConnect falhar com
    "No LID for user" (ver _find_baileys_fallback_account em routes.py). O
    front some com ela do trocador de contas e da lista de cards (ver
    fallback_for_account_id em SettingsModal.js), mostrando só um selo na
    conta WPPConnect original.

    Depois de criada, ainda precisa ser pareada de verdade (QR ou pairing
    code) — devolve os dados pro front abrir o mesmo painel de vínculo que
    qualquer conta Baileys nova usa.
    """
    _require_perm(db, _auth, "settings_accounts")
    from backend.database.models import WhatsAppAccount
    from backend.models.schemas_auth import ProviderType as PTEnum, AuthenticationStatus, ProviderTier
    from sqlalchemy import select
    import json

    account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    if _normalize_provider(account.provider_type) != "wppconnect":
        raise HTTPException(status_code=400, detail="Fallback de envio só se aplica a contas WPPConnect.")
    if not account.phone_number:
        raise HTTPException(status_code=400, detail="Conta sem número de telefone cadastrado.")

    def _cfg(a):
        if not a.provider_config:
            return {}
        try:
            return json.loads(a.provider_config) if isinstance(a.provider_config, str) else a.provider_config
        except (ValueError, TypeError):
            return {}

    all_accounts = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.deleted_at.is_(None))).scalars().all()
    for a in all_accounts:
        if _cfg(a).get("fallback_for_account_id") == account_id:
            logger.info("[Settings:POST /accounts/%s/fallback] já existe (id=%s)", account_id, a.id)
            return {"success": True, "data": {
                "id": a.id, "account_name": a.account_name, "phone_number": a.phone_number,
                "provider_type": "baileys", "is_active": a.is_active,
                "is_authenticated": a.is_authenticated, "requires_session_qr": True,
                "already_existed": True,
            }}

    session_id = f"{account.session_id or account.id}-baileys"
    fallback = WhatsAppAccount(
        user_id=account.user_id,
        account_name=f"{account.account_name} (Fallback Baileys)",
        phone_number=account.phone_number,
        provider_type=PTEnum.BAILEYS,
        provider_tier=ProviderTier.FREE,
        provider_config=json.dumps({"session_id": session_id, "fallback_for_account_id": account_id}),
        is_active=True,
        is_authenticated=False,
        authentication_status=AuthenticationStatus.PENDING,
    )
    db.add(fallback)
    db.commit()
    db.refresh(fallback)
    logger.info("[Settings:POST /accounts/%s/fallback] criada conta Baileys fallback id=%s", account_id, fallback.id)
    return {"success": True, "data": {
        "id": fallback.id, "account_name": fallback.account_name, "phone_number": fallback.phone_number,
        "provider_type": "baileys", "is_active": True, "is_authenticated": False,
        "requires_session_qr": True, "already_existed": False,
    }}


@settings_router.patch("/accounts/{account_id}")
async def update_account(account_id: int, payload: AccountUpdate, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_accounts")
    logger.info("[Settings:PATCH /accounts/%s] user_id=%s", account_id, _auth.get("user_id"))
    try:
        from backend.database.models import WhatsAppAccount
        from sqlalchemy import select
        import json
        account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Conta não encontrada")
            
        update_data = payload.dict(exclude_unset=True)

        # Liga de novo (False->True, ou primeira vez True) reseta o instante
        # de referência do relógio de SLA/pendente — ver attendance_enabled_
        # since em models.py. Desligar não mexe nele (não importa, a conta
        # inteira já sai das métricas enquanto attendance_enabled=False).
        if update_data.get("attendance_enabled") and not account.attendance_enabled:
            account.attendance_enabled_since = datetime.utcnow()

        if "provider_type" in update_data:
            from backend.models.schemas_auth import ProviderType as PTEnum
            try:
                update_data["provider_type"] = PTEnum(update_data["provider_type"].lower()).value
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail=f"provider_type inválido: '{update_data['provider_type']}'. Aceitos: {[e.value for e in PTEnum]}"
                )

        provider_config = {}
        if account.provider_config:
            try:
                provider_config = json.loads(account.provider_config) if isinstance(account.provider_config, str) else account.provider_config
            except:
                pass
                
        # Handle custom keys that go to provider_config
        if "bridge_host" in update_data:
            provider_config["bridge_host"] = update_data.pop("bridge_host")
        if "bridge_port" in update_data:
            provider_config["bridge_port"] = update_data.pop("bridge_port")
        if "session_id" in update_data:
            provider_config["session_id"] = update_data.pop("session_id")
            account.session_id = provider_config["session_id"]
        if "wppconnect_url" in update_data:
            wppconnect_url = update_data.pop("wppconnect_url")
            provider_config["wppconnect_url"] = wppconnect_url
            if wppconnect_url:
                from backend.providers.factory import split_bridge_url
                host, port = split_bridge_url(wppconnect_url)
                provider_config["bridge_host"] = host
                if port:
                    provider_config["bridge_port"] = port
        if "wppconnect_token" in update_data:
            wppconnect_token = update_data.pop("wppconnect_token")
            provider_config["wppconnect_token"] = wppconnect_token
            if wppconnect_token:
                provider_config["secret_key"] = wppconnect_token
            
        account.provider_config = json.dumps(provider_config)
            
        for key, value in update_data.items():
            setattr(account, key, value)
            
        db.commit()
        db.refresh(account)
        return {"success": True, "message": "Conta atualizada com sucesso"}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("[Settings:PATCH /accounts] Erro")
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.delete("/accounts/{account_id}")
async def delete_account(account_id: int, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_accounts")
    logger.info("[Settings:DELETE /accounts/%s] user_id=%s", account_id, _auth.get("user_id"))
    try:
        from backend.database.models import WhatsAppAccount
        from sqlalchemy import select
        account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Conta não encontrada")
        db.delete(account)
        db.commit()
        return {"success": True, "message": "Conta removida"}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.patch("/accounts/{account_id}/toggle")
async def toggle_account(account_id: int, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_accounts")
    try:
        from backend.database.models import WhatsAppAccount
        from sqlalchemy import select
        account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Conta não encontrada")
        account.is_active = not account.is_active
        db.commit()
        logger.info("[Settings:PATCH /accounts/%s/toggle] is_active=%s", account_id, account.is_active)
        return {"success": True, "is_active": account.is_active}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.get("/accounts/{account_id}/qr")
async def get_session_qr(account_id: int, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "feature_qr_manager")
    _require_account_scope(db, _auth, account_id)
    logger.info("[Settings:GET /accounts/%s/qr] user_id=%s", account_id, _auth.get("user_id"))
    try:
        from backend.database.models import WhatsAppAccount
        from sqlalchemy import select

        account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Conta não encontrada")

        provider_str = _normalize_provider(account.provider_type)
        logger.info("[Settings:GET /accounts/%s/qr] provider raw='%s' → '%s'", account_id, account.provider_type, provider_str)

        if provider_str not in UNOFFICIAL_PROVIDERS:
            logger.warning("[Settings:GET /accounts/%s/qr] Provider '%s' não requer QR", account_id, provider_str)
            return {"success": False, "message": f"Provider '{provider_str}' não requer QR Code de sessão.", "data": {"requires_session_qr": False}}

        config   = _load_provider_config(account)
        provider = _instantiate_unofficial_provider(provider_str, config)

        logger.info("[Settings:GET /accounts/%s/qr] Chamando bridge bridge_url='%s' session='%s'",
                    account_id, getattr(provider, "bridge_url", "?"), getattr(provider, "session_id", "?"))

        qr_data = await provider.get_session_qr()
        status  = qr_data.get("status") or ("authenticated" if qr_data.get("authenticated") else "qr_required")

        logger.info("[Settings:GET /accounts/%s/qr] Bridge: status='%s' has_qr=%s error='%s'",
                    account_id, status, bool(qr_data.get("qr_base64")), qr_data.get("error"))

        if qr_data.get("authenticated") or status == "authenticated":
            from backend.models.schemas_auth import AuthenticationStatus
            account.is_authenticated = True
            account.authentication_status = AuthenticationStatus.AUTHENTICATED
            db.commit()
            logger.info("[Settings:GET /accounts/%s/qr] Já autenticado — banco atualizado", account_id)

        return {"success": True, "data": qr_data}

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[Settings:GET /accounts/%s/qr] Erro inesperado", account_id)
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.post("/accounts/{account_id}/pairing-code")
async def request_pairing_code(
    account_id: int,
    payload: PairingCodeRequest,
    db: Session = Depends(get_db),
    _auth=Depends(_require_auth),
):
    _require_perm(db, _auth, "feature_qr_manager")
    _require_account_scope(db, _auth, account_id)
    logger.info("[Settings:POST /accounts/%s/pairing-code] número='%s' user_id=%s",
                account_id, payload.phone_number, _auth.get("user_id"))
    try:
        from backend.database.models import WhatsAppAccount
        from sqlalchemy import select

        account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Conta não encontrada")

        provider_str = _normalize_provider(account.provider_type)
        logger.info("[Settings:POST /accounts/%s/pairing-code] provider='%s'", account_id, provider_str)

        if provider_str not in UNOFFICIAL_PROVIDERS:
            raise HTTPException(status_code=400, detail=f"Provider '{provider_str}' não suporta pairing code")

        if provider_str == "venom":
            raise HTTPException(status_code=501, detail="Venom não suporta código de pareamento. Use QR Code ou troque para Baileys.")

        config   = _load_provider_config(account)
        provider = _instantiate_unofficial_provider(provider_str, config)

        logger.info("[Settings:POST /accounts/%s/pairing-code] bridge_url='%s' session='%s'",
                    account_id, getattr(provider, "bridge_url", "?"), getattr(provider, "session_id", "?"))

        result = await provider.request_pairing_code(payload.phone_number)

        logger.info("[Settings:POST /accounts/%s/pairing-code] success=%s code='%s' error='%s'",
                    account_id, result.get("success"), result.get("code"), result.get("error"))

        if not result.get("success"):
            raise HTTPException(status_code=502, detail=result.get("error", "Falha ao obter código de pareamento"))

        code = result.get("code", "")
        if code and "-" not in code and len(code) == 8:
            code = f"{code[:4]}-{code[4:]}"

        logger.info("[Settings:POST /accounts/%s/pairing-code] Código: %s", account_id, code)

        return {
            "success": True,
            "data": {
                "pairing_code":       code,
                "expires_in_seconds": result.get("expires_in", 60),
                "phone_number":       payload.phone_number,
                "instructions": [
                    "Abra o WhatsApp no celular",
                    "Toque em Menu (⋮) → Configurações → Dispositivos vinculados",
                    "Toque em 'Vincular dispositivo'",
                    "Toque em 'Vincular com número de telefone'",
                    f"Digite o código: {code}",
                ],
            }
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[Settings:POST /accounts/%s/pairing-code] Erro", account_id)
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.get("/accounts/{account_id}/auth-status")
async def get_auth_status(account_id: int, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    logger.debug("[Settings:GET /accounts/%s/auth-status] polling user_id=%s", account_id, _auth.get("user_id"))
    try:
        from backend.database.models import WhatsAppAccount
        from sqlalchemy import select

        account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Conta não encontrada")

        provider_str = _normalize_provider(account.provider_type)

        if provider_str not in UNOFFICIAL_PROVIDERS:
            return {"success": True, "data": {
                "authenticated": account.is_authenticated,
                "status": _normalize_provider(account.authentication_status).upper(),
            }}

        config   = _load_provider_config(account)
        provider = _instantiate_unofficial_provider(provider_str, config)
        status   = await provider.get_session_status()

        logger.debug("[Settings:GET /accounts/%s/auth-status] bridge=%s auth=%s phone=%s",
                     account_id, status.get("status"), status.get("authenticated"), status.get("phone"))

        live_authenticated = status.get("authenticated", False)
        if live_authenticated != account.is_authenticated:
            from backend.models.schemas_auth import AuthenticationStatus
            account.is_authenticated = live_authenticated
            account.authentication_status = (
                AuthenticationStatus.AUTHENTICATED if live_authenticated else AuthenticationStatus.DISCONNECTED
            )
            db.commit()
            if live_authenticated:
                logger.info("[Settings:GET /accounts/%s/auth-status] Autenticado! phone='%s'",
                            account_id, status.get("phone"))
            else:
                logger.warning("[Settings:GET /accounts/%s/auth-status] Sessão caiu — banco corrigido para não-autenticado",
                                account_id)

        return {"success": True, "data": {
            "authenticated": status.get("authenticated", False),
            "status":        status.get("status", "unknown"),
            "phone":         status.get("phone"),
        }}

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[Settings:GET /accounts/%s/auth-status] Erro", account_id)
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.post("/accounts/{account_id}/logout")
async def logout_session(account_id: int, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "feature_qr_manager")
    _require_account_scope(db, _auth, account_id)
    logger.info("[Settings:POST /accounts/%s/logout] user_id=%s", account_id, _auth.get("user_id"))
    try:
        from backend.database.models import WhatsAppAccount
        from backend.models.schemas_auth import AuthenticationStatus
        from sqlalchemy import select

        account = db.execute(select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)).scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Conta não encontrada")

        provider_str = _normalize_provider(account.provider_type)
        if provider_str in UNOFFICIAL_PROVIDERS:
            config   = _load_provider_config(account)
            provider = _instantiate_unofficial_provider(provider_str, config)
            result   = await provider.logout_session()
            logger.info("[Settings:POST /accounts/%s/logout] bridge=%s", account_id, result)

        account.is_authenticated = False
        account.authentication_status = AuthenticationStatus.DISCONNECTED
        db.commit()
        return {"success": True, "message": "Sessão encerrada"}

    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("[Settings:POST /accounts/%s/logout] Erro", account_id)
        raise HTTPException(status_code=500, detail=str(exc))

# USUÁRIOS

@settings_router.get("/users")
async def get_users(db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_users")
    try:
        try:
            from backend.database.models import User
            from sqlalchemy import select
            users = db.execute(select(User)).scalars().all()
            return {"success": True, "data": [
                {
                    "id":        u.id,
                    "username":  getattr(u, "username", getattr(u, "email", str(u.id))),
                    "role":      getattr(u, "role", "admin" if getattr(u, "is_admin", False) else "attendant"),
                    "sector":    getattr(u, "sector", ""),
                    "is_active": getattr(u, "is_active", True),
                    "created_at": u.created_at.isoformat() if hasattr(u, "created_at") and u.created_at else None,
                }
                for u in users
            ]}
        except Exception:
            pass
        settings = _load_settings()
        users = settings.get("users", [{"username": "admin", "role": "admin", "sector": "", "is_active": True}])
        return {"success": True, "data": users}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.post("/users")
async def create_user(payload: UserCreate, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_users")
    try:
        try:
            from backend.database.models import User
            from sqlalchemy import select
            existing = db.execute(select(User).where(User.email == payload.username)).scalar_one_or_none()
            if existing:
                raise HTTPException(status_code=400, detail="Usuário já existe")
            new_user = User(
                email=payload.username,
                password_hash=auth_service.hash_password(payload.password),
                is_active=True,
                is_admin=(payload.role == "admin"),
            )
            if hasattr(new_user, "role"):   new_user.role   = payload.role
            if hasattr(new_user, "sector"): new_user.sector = payload.sector or ""
            db.add(new_user)
            db.commit()
            return {"success": True, "message": f"Usuário '{payload.username}' criado"}
        except HTTPException:
            raise
        except Exception:
            pass

        settings = _load_settings()
        users = settings.get("users", [])
        if any(u["username"] == payload.username for u in users):
            raise HTTPException(status_code=400, detail="Usuário já existe")
        users.append({"username": payload.username, "role": payload.role, "sector": payload.sector or "", "is_active": True})
        settings["users"] = users
        _save_settings(settings)
        return {"success": True, "message": f"Usuário '{payload.username}' criado"}

    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


@settings_router.delete("/users/{username}")
async def delete_user(username: str, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_users")
    if username == "admin":
        raise HTTPException(status_code=400, detail="Não é possível remover o usuário admin")
    try:
        try:
            from backend.database.models import User
            from sqlalchemy import select
            user = db.execute(select(User).where(User.email == username)).scalar_one_or_none()
            if user:
                db.delete(user)
                db.commit()
                return {"success": True, "message": f"Usuário '{username}' removido"}
        except Exception:
            pass
        settings = _load_settings()
        settings["users"] = [u for u in settings.get("users", []) if u.get("username") != username]
        _save_settings(settings)
        return {"success": True, "message": f"Usuário '{username}' removido"}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))

# ALIAS para compatibilidade com settings gerais
@settings_router.get("/general")
async def get_general(db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_general")
    settings = _load_settings()
    return {"success": True, "data": settings.get("general", {})}

@settings_router.post("/general")
async def save_general(request: Request, db: Session = Depends(get_db), _auth=Depends(_require_auth)):
    _require_perm(db, _auth, "settings_general")
    body = await request.json()
    settings = _load_settings()
    settings["general"] = body
    _save_settings(settings)
    return {"success": True}
