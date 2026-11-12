# backend/api/routes_templates.py
"""
Endpoints de Templates e SystemConfig com persistência real.

GET  /api/templates                → Lista templates da Meta API (com cache)
GET  /api/templates/{name}         → Detalhe de um template
POST /api/templates/sync           → Força re-sincronização com Meta
GET  /api/admin/config             → Config global persistida (substitui versão sem DB)
PATCH /api/admin/config            → Salva config global no banco

Registrar no app.py:
    from backend.api.routes_templates import templates_router
    app.include_router(templates_router, prefix="/api", tags=["Templates"])

    # Substituir as rotas /api/admin/config existentes por:
    from backend.api.routes_templates import config_router
    app.include_router(config_router, tags=["Admin Config"])
"""

import os
import json
import logging
import asyncio
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime
from sqlalchemy.sql import func
from pydantic import BaseModel, Field

from backend.database.connection import get_db, Base
from backend.api.routes_auth import get_current_user
from backend.api.permissions import user_has_permission

logger = logging.getLogger(__name__)

# Antes disso, templates_router não exigia login nenhum — qualquer um que
# alcançasse o servidor conseguia criar/apagar templates reais na Meta ou
# mexer no catálogo de produtos sem autenticação. Nenhuma rota aqui é webhook
# externo (isso fica só em config_router/admin), então o piso de login vale
# pra tudo. config_router continua com checagem de permissão por rota.
templates_router = APIRouter(dependencies=[Depends(get_current_user)])
config_router    = APIRouter()


# MODELOS DE BANCO — SystemConfig + TemplateCache
# Adicione ao backend/database/models.py, ou deixe aqui para
# auto-create via create_all()

class SystemConfigModel(Base):
    """Configurações globais do sistema, persistidas no banco."""
    __tablename__ = "system_config"

    key   = Column(String(255), primary_key=True, index=True)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class TemplateCacheModel(Base):
    """Cache local de templates da Meta API para evitar rate-limit."""
    __tablename__ = "template_cache"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    name        = Column(String(255), nullable=False, index=True)
    language    = Column(String(10), nullable=False, default="pt_BR")
    category    = Column(String(50))          # MARKETING | UTILITY | AUTHENTICATION
    status      = Column(String(50))          # APPROVED | PENDING | REJECTED
    components  = Column(Text)                # JSON serializado
    cached_at   = Column(DateTime, default=datetime.utcnow)
    expires_at  = Column(DateTime)


class TemplateVariableLabelModel(Base):
    """
    O que cada var1/var2... de um template REALMENTE significa (ex: "Nome do
    cliente"). A Meta não guarda isso em lugar nenhum — o campo "example" do
    template é só um valor de exemplo pra revisão, não um rótulo semântico —
    e o `TemplateCacheModel` é apagado/recriado a cada sync, então não dá
    pra guardar o rótulo lá dentro. Esta tabela existe só pra fechar esse
    buraco: guarda o rótulo de cada variável, sobrevive a qualquer sync, e é
    consultada tanto na criação (pra mostrar de volta) quanto no envio (pra
    trocar "Variável 1" por "Nome do cliente" na tela de quem for enviar).
    """
    __tablename__ = "template_variable_labels"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    template_name = Column(String(255), nullable=False, index=True)
    language      = Column(String(10), nullable=False, default="pt_BR")
    var_index     = Column(Integer, nullable=False)  # 1, 2, 3...
    label         = Column(String(255), nullable=False)


# HELPERS — Graph API

from backend.database.models import WhatsAppAccount
from backend.utils.time_utils import to_utc_iso
from backend.api.routes_admin import require_admin_permission

def _get_meta_credentials(db: Session, account_id: Optional[int] = None) -> tuple[str, str]:
    """Retorna (business_account_id, access_token) da conta especificada (ou da primeira ativa) no banco."""
    query = db.query(WhatsAppAccount).filter(WhatsAppAccount.provider_type.like("meta%"))
    
    if account_id:
        query = query.filter(WhatsAppAccount.id == account_id)
    else:
        query = query.filter(WhatsAppAccount.is_active == True)
        
    account = query.first()
    
    if account:
        return account.meta_business_account_id or account.meta_waba_id or "", account.meta_access_token or ""
        
    return "", ""


def _get_catalog_credentials(db: Session, account_id: Optional[int] = None) -> tuple[str, str]:
    """Retorna (catalog_id, access_token) da conta especificada (ou da primeira ativa)."""
    query = db.query(WhatsAppAccount).filter(WhatsAppAccount.provider_type.like("meta%"))
    if account_id:
        query = query.filter(WhatsAppAccount.id == account_id)
    else:
        query = query.filter(WhatsAppAccount.is_active == True)
    account = query.first()
    if account:
        return account.meta_catalog_id or "", account.meta_access_token or ""
    return "", ""


async def _fetch_templates_from_meta(
    waba_id: str,
    token: str,
    status_filter: Optional[str] = None,
    page_limit: int = 100,
) -> List[Dict[str, Any]]:
    """
    Busca templates diretamente da Graph API da Meta.
    Suporta paginação automática (até 500 templates).
    """
    templates: List[Dict] = []
    api_version = os.getenv("CLOUD_API_VERSION", "v23.0")
    url = f"https://graph.facebook.com/{api_version}/{waba_id}/message_templates"
    params: Dict[str, Any] = {
        "fields": "name,status,category,language,components,rejected_reason",
        "limit": page_limit,
    }
    if status_filter:
        params["status"] = status_filter

    headers = {"Authorization": f"Bearer {token}"}
    pages_fetched = 0

    async with httpx.AsyncClient(timeout=20.0) as client:
        while url and pages_fetched < 5:           # máx 5 páginas = 500 templates
            try:
                resp = await client.get(url, headers=headers, params=params if pages_fetched == 0 else {})
                resp.raise_for_status()
                data = resp.json()
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status == 401:
                    raise HTTPException(status_code=401, detail="Access Token inválido ou expirado")
                if status == 403:
                    raise HTTPException(status_code=403, detail="Sem permissão para listar templates")
                raise HTTPException(status_code=502, detail=f"Erro na Meta API: HTTP {status}")

            templates.extend(data.get("data", []))
            url = data.get("paging", {}).get("next")   # None = última página
            pages_fetched += 1

    return templates


def _normalize_template(raw: Dict) -> Dict:
    """
    Normaliza um template da Meta API para o formato
    esperado pelo TemplateSender.js do frontend.
    """
    components = raw.get("components", [])

    # Extrai variáveis de texto {{N}} do BODY
    body_vars: List[str] = []
    for comp in components:
        if comp.get("type") == "BODY":
            text = comp.get("text", "")
            import re
            indices = sorted(set(int(m) for m in re.findall(r"\{\{(\d+)\}\}", text)))
            body_vars = [f"variavel_{i}" for i in indices]
            break

    return {
        "id":         raw.get("name"),          # usado como key no frontend
        "name":       raw.get("name"),
        "category":   raw.get("category", "UTILITY"),
        "language":   raw.get("language", "pt_BR"),
        "status":     raw.get("status", "APPROVED"),
        "components": components,
        "body_variables": body_vars,            # conveniência para o formulário
        "rejected_reason": raw.get("rejected_reason"),
        "_source": "meta_api",
    }


# CACHE — salva/lê do banco para evitar chamadas repetidas

CACHE_TTL_MINUTES = 30   # tempo de validade do cache


def _cache_is_valid(db: Session) -> bool:
    """Retorna True se o cache existe e não expirou."""
    try:
        oldest = (
            db.query(TemplateCacheModel)
            .order_by(TemplateCacheModel.cached_at.asc())
            .first()
        )
        if not oldest:
            return False
        age = datetime.utcnow() - oldest.cached_at
        return age < timedelta(minutes=CACHE_TTL_MINUTES)
    except Exception:
        return False


def _load_from_cache(db: Session) -> List[Dict]:
    """Carrega templates do cache do banco."""
    try:
        rows = db.query(TemplateCacheModel).all()
        result = []
        for row in rows:
            try:
                comps = json.loads(row.components) if row.components else []
            except json.JSONDecodeError:
                comps = []
            result.append({
                "id":         row.name,
                "name":       row.name,
                "category":   row.category,
                "language":   row.language,
                "status":     row.status,
                "components": comps,
                "_source":    "cache",
            })
        return result
    except Exception as exc:
        logger.warning("Falha ao ler cache de templates: %s", exc)
        return []


def _save_to_cache(db: Session, templates: List[Dict]) -> None:
    """Persiste templates no cache do banco (limpa e reinsere)."""
    try:
        # Cria tabela se não existir (dev/first-run)
        TemplateCacheModel.__table__.create(db.bind, checkfirst=True)

        db.query(TemplateCacheModel).delete()
        expires = datetime.utcnow() + timedelta(minutes=CACHE_TTL_MINUTES)
        for t in templates:
            row = TemplateCacheModel(
                name       = t.get("name", ""),
                language   = t.get("language", "pt_BR"),
                category   = t.get("category", "UTILITY"),
                status     = t.get("status", "APPROVED"),
                components = json.dumps(t.get("components", []), ensure_ascii=False),
                cached_at  = datetime.utcnow(),
                expires_at = expires,
            )
            db.add(row)
        db.commit()
        logger.info("Cache de templates atualizado: %d templates", len(templates))
    except Exception as exc:
        db.rollback()
        logger.warning("Não foi possível salvar cache de templates: %s", exc)


# TEMPLATES DE FALLBACK — usados quando a Meta API está indisponível

FALLBACK_TEMPLATES = [
    {
        "id": "hello_world", "name": "hello_world",
        "category": "UTILITY", "language": "pt_BR", "status": "APPROVED",
        "_source": "fallback",
        "components": [
            {"type": "HEADER", "format": "TEXT", "text": "Olá!"},
            {"type": "BODY",   "text": "Olá {{1}}! Bem-vindo à {{2}}. Como podemos ajudar?"},
            {"type": "FOOTER", "text": "Responda para falar conosco"},
        ],
    },
    {
        "id": "order_confirmation", "name": "order_confirmation",
        "category": "UTILITY", "language": "pt_BR", "status": "APPROVED",
        "_source": "fallback",
        "components": [
            {"type": "HEADER", "format": "TEXT", "text": "✅ Pedido Confirmado"},
            {"type": "BODY",   "text": "Seu pedido #{{1}} foi confirmado!\n\nTotal: R$ {{2}}\nEntrega: {{3}}"},
            {"type": "FOOTER", "text": "Obrigado pela preferência!"},
        ],
    },
    {
        "id": "appointment_reminder", "name": "appointment_reminder",
        "category": "UTILITY", "language": "pt_BR", "status": "APPROVED",
        "_source": "fallback",
        "components": [
            {"type": "HEADER", "format": "TEXT", "text": "📅 Lembrete"},
            {"type": "BODY",   "text": "Olá {{1}}! Seu agendamento é dia {{2}} às {{3}}."},
            {"type": "BUTTONS", "buttons": [{"type": "QUICK_REPLY", "text": "Confirmar"}, {"type": "QUICK_REPLY", "text": "Remarcar"}]},
        ],
    },
    {
        "id": "promotional_offer", "name": "promotional_offer",
        "category": "MARKETING", "language": "pt_BR", "status": "APPROVED",
        "_source": "fallback",
        "components": [
            {"type": "HEADER", "format": "IMAGE"},
            {"type": "BODY",   "text": "🎉 Oferta especial para você!\n{{1}} com {{2}}% de desconto.\nCódigo: {{3}}"},
            {"type": "FOOTER", "text": "Válido até {{4}}"},
            {"type": "BUTTONS", "buttons": [{"type": "URL", "text": "Ver oferta", "url": "https://exemplo.com"}]},
        ],
    },
]


# ENDPOINTS — TEMPLATES

@templates_router.get("/templates")
async def list_templates(
    status:   Optional[str] = Query(None, description="Filtrar: APPROVED | PENDING | REJECTED"),
    category: Optional[str] = Query(None, description="Filtrar: MARKETING | UTILITY | AUTHENTICATION"),
    force_refresh: bool      = Query(False, description="Ignorar cache e buscar direto da Meta"),
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
):
    """
    Lista templates do WhatsApp Business.

    Fluxo:
    1. Verifica cache do banco (válido por 30 min)
    2. Se cache válido e não forçado → retorna cache
    3. Senão → busca da Meta Graph API → salva no cache
    4. Se Meta API falhar → retorna templates de fallback

    Filtros: ?status=APPROVED&category=MARKETING
    """
    waba_id, token = _get_meta_credentials(db, account_id)
    source = "cache"
    templates = []

    # Tenta cache primeiro
    if not force_refresh and waba_id and token:
        if _cache_is_valid(db):
            templates = _load_from_cache(db)
            if templates:
                logger.debug("Templates servidos do cache (%d itens)", len(templates))
            else:
                # Cache vazio — busca da Meta
                force_refresh = True
        else:
            # Cache inválido (ou expirado) — busca da Meta
            force_refresh = True

    # Busca da Meta API
    if force_refresh or not waba_id or not token:
        if not waba_id or not token:
            logger.warning("Credenciais Meta não configuradas. Usando fallback.")
            templates = FALLBACK_TEMPLATES
            source = "fallback"
        else:
            try:
                raw = await _fetch_templates_from_meta(waba_id, token, status_filter=status)
                templates = [_normalize_template(t) for t in raw]
                _save_to_cache(db, templates)
                source = "meta_api"
            except Exception as exc:
                if isinstance(exc, HTTPException):
                    logger.error(f"Erro na Meta API ao buscar templates (HTTP {exc.status_code}): {exc.detail}")
                else:
                    logger.error("Erro ao buscar templates da Meta: %s", exc)
                # Tenta cache degradado antes do fallback
                cached = _load_from_cache(db)
                templates = cached if cached else FALLBACK_TEMPLATES
                source = "fallback" if not cached else "stale_cache"

    # Filtro de categoria (se cache não filtrou)
    if category:
        templates = [t for t in templates if t.get("category", "").upper() == category.upper()]

    # Filtro de status
    if status and source != "meta_api":
        templates = [t for t in templates if t.get("status", "").upper() == status.upper()]

    return {
        "success": True,
        "source": source,
        "total": len(templates),
        "data": templates,
        "cached_at": datetime.utcnow().isoformat(),
    }


async def get_template_category(db: Session, template_name: str, account_id: Optional[int] = None) -> Optional[str]:
    """
    Retorna a categoria (MARKETING | UTILITY | AUTHENTICATION) de um template.
    Cache primeiro (populado por /templates/sync e criação de templates), com
    fallback pra busca ao vivo na Meta. Usado para decidir se um envio de
    template deve ir pelo endpoint MM Lite (/marketing_messages).
    """
    row = db.query(TemplateCacheModel).filter(TemplateCacheModel.name == template_name).first()
    if row and row.category:
        return row.category

    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        return None

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/message_templates",
                headers={"Authorization": f"Bearer {token}"},
                params={"name": template_name, "fields": "name,category"},
            )
            resp.raise_for_status()
            data = resp.json()
        templates = data.get("data", [])
        return templates[0].get("category") if templates else None
    except Exception:
        logger.warning("Não foi possível determinar a categoria do template '%s' ao vivo", template_name)
        return None


@templates_router.get("/templates/{template_name}")
async def get_template(
    template_name: str,
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
):
    """Retorna detalhes de um template específico pelo nome."""
    # Tenta no cache primeiro
    try:
        row = db.query(TemplateCacheModel).filter(
            TemplateCacheModel.name == template_name
        ).first()
        if row:
            comps = json.loads(row.components) if row.components else []
            return {
                "success": True,
                "data": {
                    "name": row.name, "category": row.category,
                    "language": row.language, "status": row.status,
                    "components": comps, "_source": "cache",
                }
            }
    except Exception:
        pass

    # Busca direto na Meta
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=404, detail="Template não encontrado e credenciais não configuradas")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/message_templates",
                headers={"Authorization": f"Bearer {token}"},
                params={"name": template_name, "fields": "name,status,category,language,components,rejected_reason"},
            )
            resp.raise_for_status()
            data = resp.json()

        templates = data.get("data", [])
        if not templates:
            raise HTTPException(status_code=404, detail=f"Template '{template_name}' não encontrado")

        return {"success": True, "data": _normalize_template(templates[0])}

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Erro ao buscar template: {str(exc)}")


@templates_router.post("/templates/sync")
async def sync_templates(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_templates_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar templates/catálogo.")
    """
    Força sincronização completa de templates com a Meta API.
    Invalida o cache e re-busca tudo.
    """
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e CLOUD_API_ACCESS_TOKEN")

    try:
        raw = await _fetch_templates_from_meta(waba_id, token)
        templates = [_normalize_template(t) for t in raw]
        _save_to_cache(db, templates)

        stats = {
            "approved":  sum(1 for t in templates if t["status"] == "APPROVED"),
            "pending":   sum(1 for t in templates if t["status"] == "PENDING"),
            "rejected":  sum(1 for t in templates if t["status"] == "REJECTED"),
            "marketing": sum(1 for t in templates if t["category"] == "MARKETING"),
            "utility":   sum(1 for t in templates if t["category"] == "UTILITY"),
        }

        return {
            "success": True,
            "message": f"{len(templates)} templates sincronizados",
            "stats": stats,
            "synced_at": datetime.utcnow().isoformat(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class TemplateCreateSchema(BaseModel):
    name: str
    language: str = "pt_BR"
    category: str = Field(..., description="MARKETING | UTILITY | AUTHENTICATION")
    components: List[Dict[str, Any]]
    variable_labels: Optional[List[str]] = Field(
        None, description="O que cada variável do corpo representa, na ordem (ex: ['Nome do cliente', 'Número do pedido'])"
    )


class TemplateBulkDeleteSchema(BaseModel):
    hsm_ids: List[str] = Field(..., max_length=100, description="IDs dos templates a excluir (máx 100 por chamada)")


@templates_router.post("/templates")
async def create_template(
    body: TemplateCreateSchema,
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_templates_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar templates/catálogo.")
    """
    Cria um novo template de mensagem na Meta.
    O template fica PENDING até a Meta aprovar (normalmente até 24h).
    """
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e CLOUD_API_ACCESS_TOKEN")

    payload = {
        "name": body.name,
        "language": body.language,
        "category": body.category.upper(),
        "components": body.components,
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/message_templates",
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao criar template na Meta: {exc.response.text[:300]}")

    # Invalida o cache para refletir o novo template na próxima listagem
    try:
        db.query(TemplateCacheModel).delete()
        db.commit()
    except Exception:
        db.rollback()

    # Salva o que cada variável representa (não é nada que a Meta guarde) —
    # sobrevive a qualquer sync/invalidação de cache, ao contrário do resto.
    if body.variable_labels:
        try:
            TemplateVariableLabelModel.__table__.create(db.bind, checkfirst=True)
            db.query(TemplateVariableLabelModel).filter(
                TemplateVariableLabelModel.template_name == body.name,
                TemplateVariableLabelModel.language == body.language,
            ).delete()
            for i, label in enumerate(body.variable_labels, start=1):
                if label and label.strip():
                    db.add(TemplateVariableLabelModel(
                        template_name=body.name, language=body.language,
                        var_index=i, label=label.strip(),
                    ))
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.warning(f"Não foi possível salvar os rótulos de variável de '{body.name}': {exc}")

    logger.info(f"Template '{body.name}' criado na Meta (id={data.get('id')})")
    return {"success": True, "data": data}


@templates_router.get("/templates/{template_name}/variable-labels")
async def get_template_variable_labels(
    template_name: str,
    language: str = Query("pt_BR"),
    db: Session = Depends(get_db),
):
    """O que cada var1/var2... desse template representa (se foi definido na criação)."""
    try:
        TemplateVariableLabelModel.__table__.create(db.bind, checkfirst=True)
        rows = (
            db.query(TemplateVariableLabelModel)
            .filter(TemplateVariableLabelModel.template_name == template_name, TemplateVariableLabelModel.language == language)
            .order_by(TemplateVariableLabelModel.var_index)
            .all()
        )
    except Exception:
        rows = []

    return {"success": True, "labels": {row.var_index: row.label for row in rows}}


def _header_format_for_mime(mime_type: str) -> str:
    if mime_type.startswith("image/"):
        return "IMAGE"
    if mime_type.startswith("video/"):
        return "VIDEO"
    return "DOCUMENT"


@templates_router.post("/templates/upload-header-media")
async def upload_template_header_media(
    file: UploadFile = File(...),
    account_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_templates_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar templates/catálogo.")
    """
    Sobe um arquivo (imagem/vídeo/documento) pra usar como exemplo do
    cabeçalho de um template, via Resumable Upload API da Meta — necessário
    pra criar um template com HEADER de mídia (a Meta exige um "handle" de
    exemplo, não aceita URL direto na criação).
    """
    waba_id, token = _get_meta_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure a conta primeiro")

    config = _load_config(db)
    if not config.fb_app_id:
        raise HTTPException(status_code=400, detail="Configure o FB App ID em Configurações → App Meta antes de subir mídia de cabeçalho")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Arquivo vazio")

    mime_type = file.content_type or "application/octet-stream"
    header_format = _header_format_for_mime(mime_type)

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            session_resp = await client.post(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{config.fb_app_id}/uploads",
                params={"file_length": len(content), "file_type": mime_type, "access_token": token},
            )
            session_resp.raise_for_status()
            upload_session_id = session_resp.json().get("id")
            if not upload_session_id:
                raise HTTPException(status_code=502, detail="Meta não retornou sessão de upload")

            upload_resp = await client.post(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{upload_session_id}",
                headers={"Authorization": f"OAuth {token}", "file_offset": "0"},
                content=content,
            )
            upload_resp.raise_for_status()
            handle = upload_resp.json().get("h")
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao subir mídia do cabeçalho: {exc.response.text[:300]}")

    if not handle:
        raise HTTPException(status_code=502, detail="Meta não retornou o identificador da mídia enviada")

    logger.info(f"Mídia de cabeçalho enviada (format={header_format})")
    return {"success": True, "header_handle": handle, "format": header_format}


@templates_router.delete("/templates/{template_name}")
async def delete_template(
    template_name: str,
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_templates_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar templates/catálogo.")
    """Exclui TODAS as versões (idiomas) de um template, pelo nome."""
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e CLOUD_API_ACCESS_TOKEN")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.delete(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/message_templates",
                headers={"Authorization": f"Bearer {token}"},
                params={"name": template_name},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao excluir template: {exc.response.text[:300]}")

    db.query(TemplateCacheModel).filter(TemplateCacheModel.name == template_name).delete()
    db.query(TemplateVariableLabelModel).filter(TemplateVariableLabelModel.template_name == template_name).delete()
    db.commit()

    logger.info(f"Template '{template_name}' excluído")
    return {"success": True, "data": data}


@templates_router.post("/templates/bulk-delete")
async def bulk_delete_templates(
    body: TemplateBulkDeleteSchema,
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_templates_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar templates/catálogo.")
    """Exclui até 100 templates de uma vez, por ID (hsm_ids)."""
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e CLOUD_API_ACCESS_TOKEN")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.delete(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/message_templates",
                headers={"Authorization": f"Bearer {token}"},
                params={"hsm_ids": ",".join(body.hsm_ids)},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao excluir templates: {exc.response.text[:300]}")

    logger.info(f"{len(body.hsm_ids)} template(s) excluído(s) em lote")
    return {"success": True, "data": data}


# ENDPOINTS — SUBSCRIBED APPS (diagnóstico/correção de webhook)
#
# A Meta só entrega webhook (mensagens, status, etc.) pra uma WABA se o
# App estiver inscrito nela via /{waba_id}/subscribed_apps. Isso acontece
# automaticamente no Embedded Signup, mas contas configuradas manualmente
# (como as desse projeto, colando phone_number_id/token direto) podem nunca
# ter passado por essa etapa — sintoma clássico: token/número corretos,
# mas nenhuma mensagem/status chega no app.

@templates_router.get("/meta/subscribed-apps")
async def list_subscribed_apps(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
):
    """Lista os Apps atualmente inscritos pra receber webhook dessa WABA."""
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e CLOUD_API_ACCESS_TOKEN")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/subscribed_apps",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao consultar subscribed_apps: {exc.response.text[:300]}")

    apps = data.get("data", [])
    return {
        "success": True,
        "subscribed": len(apps) > 0,
        "total": len(apps),
        "data": apps,
    }


@templates_router.post("/meta/subscribed-apps/subscribe")
async def subscribe_app(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_templates_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar templates/catálogo.")
    """
    Inscreve o App (dono do Access Token usado) pra receber webhook dessa WABA.
    Corrige o caso clássico de 'token e número certos, mas webhook não chega'.
    """
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e CLOUD_API_ACCESS_TOKEN")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/subscribed_apps",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao inscrever App: {exc.response.text[:300]}")

    logger.info(f"App inscrito em subscribed_apps para WABA {waba_id}")
    return {"success": True, "data": data}


@templates_router.delete("/meta/subscribed-apps")
async def unsubscribe_app(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_templates_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar templates/catálogo.")
    """Remove a inscrição do App pra essa WABA (para de receber webhook)."""
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e CLOUD_API_ACCESS_TOKEN")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.delete(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}/subscribed_apps",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao remover inscrição: {exc.response.text[:300]}")

    logger.info(f"App desinscrito de subscribed_apps para WABA {waba_id}")
    return {"success": True, "data": data}


# ENDPOINTS — MM LITE (Marketing Messages Lite)
#
# MM Lite não tem endpoint de "inscrição" via API — o aceite dos termos
# acontece uma vez por Business Manager (BMID), feito manualmente em
# App Dashboard → WhatsApp → Quickstart → aceitar ToS de marketing
# messages (ou via Embedded Signup com config específica). Esse endpoint
# só consulta o status pra saber se esse passo manual já foi feito.

_MMLITE_STATUS_COPY = {
    "ONBOARDED": {
        "ready": True,
        "message": "MM Lite ativo. Templates de MARKETING são enviados pelo endpoint otimizado automaticamente.",
    },
    "ELIGIBLE": {
        "ready": False,
        "message": (
            "Sua conta pode habilitar o MM Lite, mas ainda não aceitou os termos. "
            "Acesse App Dashboard da Meta → WhatsApp → Quickstart e aceite os "
            "termos de Marketing Messages para essa Business Manager (passo único, feito pela Meta)."
        ),
    },
    "INELIGIBLE": {
        "ready": False,
        "message": "Essa conta ainda não é elegível para o MM Lite (WABA muito nova, região restrita ou verificação pendente).",
    },
}


@templates_router.get("/mmlite/status")
async def get_mmlite_status(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
):
    """
    Consulta o status real de onboarding do MM Lite pra essa WABA na Meta:
    INELIGIBLE → ELIGIBLE → ONBOARDED. Só quando ONBOARDED os templates de
    MARKETING passam a ser roteados pelo endpoint /marketing_messages.
    """
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure a Business Account ID e o Access Token dessa conta")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{waba_id}",
                headers={"Authorization": f"Bearer {token}"},
                params={"fields": "marketing_messages_lite_api_status,marketing_messages_onboarding_status"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao consultar status MM Lite: {exc.response.text[:300]}")

    api_status = data.get("marketing_messages_lite_api_status", "INELIGIBLE")
    onboarding_status = data.get("marketing_messages_onboarding_status", api_status)
    copy = _MMLITE_STATUS_COPY.get(onboarding_status, _MMLITE_STATUS_COPY["INELIGIBLE"])

    return {
        "success": True,
        "waba_id": waba_id,
        "api_status": api_status,
        "onboarding_status": onboarding_status,
        "ready": copy["ready"],
        "message": copy["message"],
    }


# ENDPOINTS — COEXISTÊNCIA
#
# Diferente do MM Lite, não existe campo na Graph API que exponha o
# status de sincronização da Coexistência — só é observável pelos
# webhooks (history/smb_app_state_sync/smb_message_echoes) que a Meta
# efetivamente envia. Por isso a fonte da verdade aqui é o nosso
# próprio banco (CoexistenceSyncState), não uma chamada à Graph API.

@templates_router.get("/coexistence/status")
async def get_coexistence_status(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
):
    """Status real de sincronização da Coexistência pra essa conta, baseado
    nos webhooks já recebidos (não numa consulta à Graph API — ver nota acima)."""
    from backend.database.models import CoexistenceSyncState

    query = db.query(WhatsAppAccount).filter(WhatsAppAccount.provider_type.like("meta%"))
    if account_id:
        query = query.filter(WhatsAppAccount.id == account_id)
    else:
        query = query.filter(WhatsAppAccount.is_active == True)
    account = query.first()

    if not account:
        raise HTTPException(status_code=400, detail="Conta não encontrada")
    if account.provider_type not in ("meta_cloud_coexistence", "meta_cloud_full"):
        raise HTTPException(status_code=400, detail="Essa conta não está no tier de Coexistência")

    CoexistenceSyncState.__table__.create(db.bind, checkfirst=True)
    state = db.query(CoexistenceSyncState).filter(CoexistenceSyncState.account_id == account.id).first()

    history_sync = {
        "started_at": to_utc_iso(state.history_started_at) if state else None,
        "completed_at": to_utc_iso(state.history_completed_at) if state else None,
        "chunks_received": state.history_chunks_received if state else 0,
        "progress_pct": state.history_last_progress_pct if state else None,
    }
    app_state_sync = {
        "last_seen_at": to_utc_iso(state.last_app_state_sync_at) if state else None,
        "events_received": state.app_state_sync_events_received if state else 0,
    }
    message_echoes = {
        "last_seen_at": to_utc_iso(state.last_message_echo_at) if state else None,
        "echoes_received": state.message_echoes_received if state else 0,
    }

    ready = bool(account.coexistence_synced_at)
    message = (
        "Sincronização inicial concluída — histórico, contatos e mensagens do app estão sendo espelhados."
        if ready else
        "Ainda não recebemos nenhum evento de sincronização da Meta pra essa conta. Isso é esperado até a "
        "Meta começar a enviar o webhook de histórico (pode levar alguns minutos após a conexão via Embedded Signup)."
    )

    return {
        "success": True,
        "coexistence_enabled": bool(account.coexistence_enabled),
        "history_sync": history_sync,
        "app_state_sync": app_state_sync,
        "message_echoes": message_echoes,
        "synced_at": to_utc_iso(account.coexistence_synced_at),
        "ready": ready,
        "message": message,
    }


@templates_router.get("/mmlite/analytics")
async def get_mmlite_analytics_route(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    days: int = Query(7, ge=1, le=90, description="Janela de dias pra trás"),
    template_names: Optional[str] = Query(
        None, description="Nomes separados por vírgula. Default: todos os templates MARKETING em cache."
    ),
    db: Session = Depends(get_db),
):
    """
    Analytics REAL de templates MARKETING via /{waba_id}/template_analytics
    (product_type=MARKETING_MESSAGES_LITE_API) — substitui o mock que existia
    antes. Sem número de campanha configurado, retorna zerado (é o dado real
    da Meta, não falta nada no código) até haver envio suficiente na janela.
    """
    waba_id, token = _get_meta_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure a Business Account ID e o Access Token dessa conta")

    if template_names:
        names = [n.strip() for n in template_names.split(",") if n.strip()]
    else:
        rows = db.query(TemplateCacheModel).filter(TemplateCacheModel.category == "MARKETING").all()
        names = [r.name for r in rows]

    if not names:
        return {
            "success": True,
            "templates": [],
            "message": "Nenhum template MARKETING encontrado em cache. Sincronize os templates (Configurações → Templates) ou informe template_names.",
        }

    names = names[:10]  # limite da Meta por chamada
    version = os.getenv("CLOUD_API_VERSION", "v23.0")

    async with httpx.AsyncClient(timeout=20.0) as client:
        id_by_name: Dict[str, str] = {}
        for name in names:
            try:
                r = await client.get(
                    f"https://graph.facebook.com/{version}/{waba_id}/message_templates",
                    headers={"Authorization": f"Bearer {token}"},
                    params={"name": name, "fields": "id,name"},
                )
                r.raise_for_status()
                found = r.json().get("data", [])
                if found:
                    id_by_name[found[0]["id"]] = name
            except Exception:
                logger.warning("Não consegui resolver o ID do template '%s' pra analytics", name)

        if not id_by_name:
            return {"success": True, "templates": [], "message": "Nenhum dos templates informados foi encontrado na Meta."}

        end = int(datetime.utcnow().timestamp())
        start = end - days * 86400

        try:
            resp = await client.get(
                f"https://graph.facebook.com/{version}/{waba_id}/template_analytics",
                headers={"Authorization": f"Bearer {token}"},
                params={
                    "start": start,
                    "end": end,
                    "granularity": "DAILY",
                    "template_ids": list(id_by_name.keys()),
                    "product_type": "MARKETING_MESSAGES_LITE_API",
                },
            )
            resp.raise_for_status()
            raw = resp.json()
        except httpx.HTTPStatusError as exc:
            raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao consultar template_analytics: {exc.response.text[:300]}")

    # Agrega por template: soma sent/delivered/read/replied da janela inteira.
    totals: Dict[str, Dict[str, Any]] = {}
    for block in raw.get("data", []):
        for point in block.get("data_points", []):
            tpl_id = point.get("template_id")
            name = id_by_name.get(tpl_id, tpl_id)
            acc = totals.setdefault(name, {"sent": 0, "delivered": 0, "read": 0, "replied": 0})
            acc["sent"] += point.get("sent", 0) or 0
            acc["delivered"] += point.get("delivered", 0) or 0
            acc["read"] += point.get("read", 0) or 0
            acc["replied"] += point.get("replied", 0) or 0

    templates_out = []
    for name, t in totals.items():
        sent = t["sent"]
        templates_out.append({
            "name": name,
            "sent": sent,
            "delivered": t["delivered"],
            "read": t["read"],
            "replied": t["replied"],
            "delivery_rate": round(t["delivered"] / sent, 4) if sent else None,
            "read_rate": round(t["read"] / sent, 4) if sent else None,
            "reply_rate": round(t["replied"] / sent, 4) if sent else None,
        })

    return {
        "success": True,
        "product_type": "marketing_messages_lite_api",
        "period_days": days,
        "templates": templates_out,
    }


# ENDPOINTS — CATALOG MANAGER
#
# Gerencia produtos de um catálogo do Facebook já existente, direto pela
# aplicação (sem precisar do Commerce Manager). Não cria catálogos novos —
# isso exige o ID de Negócio (Business Manager) que essa conta não guarda
# hoje; o catálogo em si é criado uma única vez fora do app (como a WABA
# e o número já são), e o ID dele é colado aqui (account.meta_catalog_id).

class CatalogProductSchema(BaseModel):
    retailer_id: str = Field(..., description="SKU único do produto no seu sistema")
    name: str
    description: Optional[str] = None
    price: float = Field(..., ge=0, description="Preço em unidades (ex: 29.90)")
    currency: str = "BRL"
    image_url: str = Field(..., description="URL pública da imagem do produto")
    url: Optional[str] = Field(None, description="URL da página do produto (opcional)")
    availability: str = Field("in stock", description="in stock | out of stock | preorder | available for order | discontinued")
    condition: str = Field("new", description="new | refurbished | used")
    brand: Optional[str] = None


class CatalogProductUpdateSchema(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = None
    image_url: Optional[str] = None
    url: Optional[str] = None
    availability: Optional[str] = None
    condition: Optional[str] = None
    brand: Optional[str] = None


def _price_to_cents(price: float, currency: str) -> str:
    """A Graph API espera o preço na menor unidade monetária, como string (ex: 2990 ISO 4217 BRL)."""
    return f"{round(price * 100):d} {currency.upper()}"


@templates_router.get("/catalog/products")
async def list_catalog_products(
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    after: Optional[str] = Query(None, description="Cursor de paginação"),
    limit: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Lista produtos do catálogo configurado na conta."""
    catalog_id, token = _get_catalog_credentials(db, account_id)
    if not catalog_id or not token:
        raise HTTPException(status_code=400, detail="Configure o Catalog ID na conta antes de gerenciar produtos.")

    params: Dict[str, Any] = {
        "fields": "id,retailer_id,name,description,price,currency,image_url,url,availability,condition,brand",
        "limit": limit,
    }
    if after:
        params["after"] = after

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{catalog_id}/products",
                headers={"Authorization": f"Bearer {token}"},
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao listar produtos: {exc.response.text[:300]}")

    return {
        "success": True,
        "data": data.get("data", []),
        "paging": data.get("paging", {}),
    }


@templates_router.post("/catalog/products")
async def create_catalog_product(
    body: CatalogProductSchema,
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "settings_catalog"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar o catálogo.")
    """Cria um produto novo no catálogo configurado na conta."""
    catalog_id, token = _get_catalog_credentials(db, account_id)
    if not catalog_id or not token:
        raise HTTPException(status_code=400, detail="Configure o Catalog ID na conta antes de gerenciar produtos.")

    payload = {
        "retailer_id": body.retailer_id,
        "name": body.name,
        "description": body.description or "",
        "price": _price_to_cents(body.price, body.currency),
        "currency": body.currency.upper(),
        "image_url": body.image_url,
        "availability": body.availability,
        "condition": body.condition,
    }
    if body.url:
        payload["url"] = body.url
    if body.brand:
        payload["brand"] = body.brand

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{catalog_id}/products",
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao criar produto: {exc.response.text[:300]}")

    logger.info(f"Produto '{body.retailer_id}' criado no catálogo {catalog_id} (id={data.get('id')})")
    return {"success": True, "data": data}


@templates_router.patch("/catalog/products/{product_id}")
async def update_catalog_product(
    product_id: str,
    body: CatalogProductUpdateSchema,
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "settings_catalog"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar o catálogo.")
    """Atualiza campos de um produto existente no catálogo."""
    _, token = _get_catalog_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure o Catalog ID na conta antes de gerenciar produtos.")

    payload = {}
    update_fields = body.dict(exclude_unset=True, exclude_none=True)
    for key, value in update_fields.items():
        if key == "price":
            continue  # tratado junto com currency abaixo
        payload[key] = value
    if "price" in update_fields:
        currency = update_fields.get("currency", "BRL")
        payload["price"] = _price_to_cents(update_fields["price"], currency)
        payload["currency"] = currency.upper()

    if not payload:
        raise HTTPException(status_code=400, detail="Nenhum campo para atualizar")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{product_id}",
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao atualizar produto: {exc.response.text[:300]}")

    logger.info(f"Produto {product_id} atualizado")
    return {"success": True, "data": data}


@templates_router.delete("/catalog/products/{product_id}")
async def delete_catalog_product(
    product_id: str,
    account_id: Optional[int] = Query(None, description="ID da Conta do WhatsApp"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "settings_catalog"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar o catálogo.")
    """Remove um produto do catálogo."""
    _, token = _get_catalog_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure o Catalog ID na conta antes de gerenciar produtos.")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.delete(
                f"https://graph.facebook.com/{os.getenv('CLOUD_API_VERSION', 'v23.0')}/{product_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao excluir produto: {exc.response.text[:300]}")

    logger.info(f"Produto {product_id} excluído")
    return {"success": True, "data": data}


# ENDPOINTS — SYSTEM CONFIG (substitui versão sem persistência)

class SystemConfigSchema(BaseModel):
    """Schema das configurações globais do sistema."""
    default_daily_limit:          int  = Field(1000,  ge=1)
    default_monthly_limit:        int  = Field(30000, ge=1)
    max_accounts_per_user:        int  = Field(5,     ge=1)
    allow_unofficial_providers:   bool = True
    enable_coexistence:           bool = True
    enable_mmlite:                bool = True
    require_email_verification:   bool = False
    maintenance_mode:             bool = False
    template_cache_ttl_minutes:   int  = Field(30, ge=5, le=1440)

    # Meta App usado pro Embedded Signup — é do App (developers.facebook.com),
    # não de uma conta/WABA específica: o mesmo App pode receber Embedded
    # Signup de vários clientes diferentes. Por isso fica na config global,
    # não em cada linha de WhatsAppAccount.
    fb_app_id:                     str = ""
    fb_app_secret:                 str = ""
    embedded_signup_config_id:     str = ""
    # Configuração de Embedded Signup SEPARADA, específica pro fluxo de
    # Coexistência (número continua ativo no app WhatsApp Business do
    # celular) — precisa ser criada à parte no Meta App Dashboard, com o
    # feature flag de coexistência habilitado; não é a mesma config_id do
    # Cloud API "puro" acima.
    coexistence_embedded_signup_config_id: str = ""

    # Meta Pixel / Conversions API — usado pra mandar eventos de conversão
    # (pedido no catálogo, Flow completado, clique em botão de template
    # MARKETING) pro Business Manager, pra otimizar campanhas de anúncio.
    # Também é config global do App/Business Manager, não por conta.
    meta_pixel_id:                 str = ""
    meta_conversions_api_token:    str = ""
    # ID da Página do Facebook — a Meta EXIGE isso (ou um ctwa_clid real de
    # clique de anúncio) em todo evento business_messaging/whatsapp; sem
    # nenhum dos dois ela rejeita com 400 "page_id ausente" (confirmado ao
    # vivo). Só existe se o negócio roda anúncios "clique para WhatsApp" a
    # partir de uma Página — sem isso, os eventos de conversão não têm como
    # ser aceitos pela Meta, é uma exigência dela, não do nosso código.
    meta_page_id:                  str = ""


def _mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "••••••••"
    return value[:4] + "••••••••" + value[-4:]


def _config_key(field: str) -> str:
    return f"system_config.{field}"


def _load_config(db: Session) -> SystemConfigSchema:
    """Carrega configurações do banco. Retorna defaults se não existirem."""
    defaults = SystemConfigSchema()
    try:
        # Tenta criar tabela se não existir
        SystemConfigModel.__table__.create(db.bind, checkfirst=True)

        rows = db.query(SystemConfigModel).filter(
            SystemConfigModel.key.like("system_config.%")
        ).all()

        if not rows:
            return defaults

        data = {}
        for row in rows:
            field = row.key.replace("system_config.", "")
            # Detecta tipo pelo default do schema (API do Pydantic v2 —
            # `.outer_type_`/`__fields__` são v1 e sempre lançavam aqui,
            # fazendo _load_config cair no `except` e devolver defaults
            # silenciosamente pra TODO campo, mesmo com dado salvo no banco)
            field_info = SystemConfigSchema.model_fields.get(field)
            if field_info is None:
                continue
            field_type = field_info.annotation
            try:
                if field_type is bool:
                    data[field] = row.value.lower() in ("true", "1", "yes")
                elif field_type is int:
                    data[field] = int(row.value)
                else:
                    data[field] = row.value
            except (ValueError, TypeError):
                pass

        return SystemConfigSchema(**{**defaults.dict(), **data})

    except Exception as exc:
        logger.warning("Falha ao carregar system_config do banco: %s", exc)
        return defaults


def _save_config(db: Session, config: SystemConfigSchema) -> None:
    """Persiste todas as configurações no banco."""
    try:
        SystemConfigModel.__table__.create(db.bind, checkfirst=True)

        for field, value in config.dict().items():
            key = _config_key(field)
            row = db.query(SystemConfigModel).filter(SystemConfigModel.key == key).first()
            if row:
                row.value = str(value)
                row.updated_at = datetime.utcnow()
            else:
                db.add(SystemConfigModel(key=key, value=str(value)))

        db.commit()
        logger.info("SystemConfig salvo no banco (%d campos)", len(config.dict()))

    except Exception as exc:
        db.rollback()
        logger.error("Falha ao salvar system_config: %s", exc)
        raise HTTPException(status_code=500, detail="Erro ao salvar configurações")


@config_router.get("/api/admin/config", response_model=SystemConfigSchema, tags=["Admin Config"])
async def get_system_config(db: Session = Depends(get_db), admin_user=Depends(require_admin_permission('settings_meta_app', 'admin_system_config'))):
    """Retorna configurações globais do sistema (persistidas no banco)."""
    config = _load_config(db)
    config.fb_app_secret = _mask_secret(config.fb_app_secret)
    config.meta_conversions_api_token = _mask_secret(config.meta_conversions_api_token)
    return config


@config_router.patch("/api/admin/config", response_model=SystemConfigSchema, tags=["Admin Config"])
async def update_system_config(
    config_data: SystemConfigSchema,
    db: Session = Depends(get_db),
    admin_user=Depends(require_admin_permission('settings_meta_app', 'admin_system_config')),
):
    """Atualiza e persiste configurações globais no banco."""
    if "•" in (config_data.fb_app_secret or "") or "•" in (config_data.meta_conversions_api_token or ""):
        # Valor(es) mascarado(s) voltaram sem alteração — preserva o secreto real já salvo.
        existing = _load_config(db)
        if "•" in (config_data.fb_app_secret or ""):
            config_data.fb_app_secret = existing.fb_app_secret
        if "•" in (config_data.meta_conversions_api_token or ""):
            config_data.meta_conversions_api_token = existing.meta_conversions_api_token

    _save_config(db, config_data)
    result = config_data.model_copy()
    result.fb_app_secret = _mask_secret(result.fb_app_secret)
    result.meta_conversions_api_token = _mask_secret(result.meta_conversions_api_token)
    return result
