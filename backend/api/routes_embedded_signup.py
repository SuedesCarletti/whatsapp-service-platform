"""
backend/api/routes_embedded_signup.py

Onboarding automático de contas Meta Cloud API via Embedded Signup —
o cliente clica "Continuar com o Facebook", escolhe/cria a WABA e o
número dentro do popup hospedado pela própria Meta, e ao final a gente só
precisa trocar o código OAuth por um token e salvar a conta.

Fluxo:
  1. GET  /api/embedded-signup/config           → app_id + config_id pro FB.login() do frontend
  2. POST /api/embedded-signup/exchange-code    → troca o `code` do FB.login() por access_token de longa duração
  3. POST /api/embedded-signup/create-account   → salva a WhatsAppAccount + inscreve o App no webhook da WABA
  4. POST /api/embedded-signup/register-number  → registra o número pra Cloud API (PIN de 2 etapas)

Registrar no app.py:
    from backend.api.routes_embedded_signup import embedded_signup_router
    app.include_router(embedded_signup_router, prefix="/api", tags=["Embedded Signup"])
"""

import os
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.api.routes_templates import _load_config

logger = logging.getLogger(__name__)
embedded_signup_router = APIRouter(prefix="/embedded-signup")

API_VERSION = os.getenv("CLOUD_API_VERSION", "v23.0")
_bearer = HTTPBearer(auto_error=False)


def _require_login(credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)):
    """Só exige estar logado (qualquer usuário pode conectar uma conta) — mesmo padrão de _require_auth em routes_settings.py."""
    from backend.services.auth_service import auth_service
    token = credentials.credentials if credentials else None
    if not token:
        raise HTTPException(status_code=401, detail="Token de autenticação necessário")
    try:
        return auth_service.decode_token(token)
    except Exception:
        pass
    if token.startswith("simulated_token_"):
        return {"user_id": None, "legacy": True}
    raise HTTPException(status_code=401, detail="Token inválido ou expirado")


def _require_account_perm(db: Session, _auth: dict) -> None:
    """
    create-account/register-number fazem a MESMA coisa que POST /api/settings/accounts
    (criar uma WhatsAppAccount) — precisam do mesmo gate settings_accounts, senão
    dava pra contornar a restrição manual só usando o Embedded Signup.
    """
    from backend.database.models import User
    from backend.api.permissions import user_has_permission

    user_id = _auth.get("user_id")
    user = db.query(User).filter(User.id == user_id).first() if user_id else None
    if not user or not user_has_permission(db, user, "settings_accounts"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para conectar contas WhatsApp.")


@embedded_signup_router.get("/config")
async def get_embedded_signup_config(db: Session = Depends(get_db), _auth=Depends(_require_login)):
    """
    App ID e Config ID não são segredo (aparecem literalmente na URL pública
    do popup de Embedded Signup) — só o App Secret é sensível e nunca sai daqui.
    """
    config = _load_config(db)
    configured = bool(config.fb_app_id and config.fb_app_secret and config.embedded_signup_config_id)
    return {
        "success": True,
        "configured": configured,
        "fb_app_id": config.fb_app_id,
        "embedded_signup_config_id": config.embedded_signup_config_id,
        "coexistence_embedded_signup_config_id": config.coexistence_embedded_signup_config_id,
    }


class ExchangeCodeRequest(BaseModel):
    code: str


@embedded_signup_router.post("/exchange-code")
async def exchange_code(body: ExchangeCodeRequest, db: Session = Depends(get_db), _auth=Depends(_require_login)):
    """
    Troca o `code` do FB.login() por um access_token de longa duração (~60 dias).
    Dois passos: code -> token de curta duração -> token de longa duração.
    """
    config = _load_config(db)
    if not config.fb_app_id or not config.fb_app_secret:
        raise HTTPException(status_code=400, detail="Configure o App ID e o App Secret em Configurações → App Meta antes de conectar uma conta.")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            short_resp = await client.get(
                f"https://graph.facebook.com/{API_VERSION}/oauth/access_token",
                params={
                    "client_id": config.fb_app_id,
                    "client_secret": config.fb_app_secret,
                    "code": body.code,
                },
            )
            short_resp.raise_for_status()
            short_token = short_resp.json().get("access_token")
            if not short_token:
                raise HTTPException(status_code=502, detail="Meta não retornou token na troca do código")

            long_resp = await client.get(
                f"https://graph.facebook.com/{API_VERSION}/oauth/access_token",
                params={
                    "grant_type": "fb_exchange_token",
                    "client_id": config.fb_app_id,
                    "client_secret": config.fb_app_secret,
                    "fb_exchange_token": short_token,
                },
            )
            long_resp.raise_for_status()
            long_data = long_resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao trocar código por token: {exc.response.text[:300]}")

    logger.info("Embedded Signup: código trocado por access_token de longa duração")
    return {
        "success": True,
        "access_token": long_data.get("access_token"),
        "expires_in": long_data.get("expires_in"),
    }


class CreateAccountRequest(BaseModel):
    account_name: Optional[str] = None
    phone_number: Optional[str] = None
    waba_id: str
    phone_number_id: str
    access_token: str
    business_id: Optional[str] = None
    provider_type: str = "meta_cloud_basic"


@embedded_signup_router.post("/create-account")
async def create_account_from_signup(body: CreateAccountRequest, db: Session = Depends(get_db), _auth=Depends(_require_login)):
    """Salva a conta com os dados que vieram do Embedded Signup e inscreve o App no webhook da WABA."""
    _require_account_perm(db, _auth)
    from backend.database.models import WhatsAppAccount, User
    from backend.models.schemas_auth import ProviderType as PTEnum, AuthenticationStatus
    from backend.services.account_service import AccountService
    from sqlalchemy import select

    try:
        chosen_type = PTEnum(body.provider_type)
    except ValueError:
        chosen_type = PTEnum.META_CLOUD_BASIC

    user_id = _auth.get("user_id")
    if not user_id:
        admin = db.execute(select(User).where(User.is_active == True, User.is_admin == True).limit(1)).scalar_one_or_none()
        if not admin:
            admin = db.execute(select(User).where(User.is_active == True).limit(1)).scalar_one_or_none()
        if not admin:
            raise HTTPException(status_code=503, detail="Nenhum usuário encontrado.")
        user_id = admin.id

    phone_number = body.phone_number
    display_name = body.account_name
    if not phone_number or not display_name:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                info_resp = await client.get(
                    f"https://graph.facebook.com/{API_VERSION}/{body.phone_number_id}",
                    headers={"Authorization": f"Bearer {body.access_token}"},
                    params={"fields": "display_phone_number,verified_name"},
                )
                info_resp.raise_for_status()
                info = info_resp.json()
                phone_number = phone_number or info.get("display_phone_number", "").replace(" ", "").replace("+", "")
                display_name = display_name or info.get("verified_name") or "Conta Meta (Embedded Signup)"
        except httpx.HTTPStatusError as exc:
            logger.warning(f"Não foi possível buscar dados do número via Graph API: {exc.response.text[:300]}")
            phone_number = phone_number or body.phone_number_id
            display_name = display_name or "Conta Meta (Embedded Signup)"

    account = WhatsAppAccount(
        user_id=user_id,
        account_name=display_name,
        phone_number=phone_number,
        provider_type=chosen_type,
        provider_tier=AccountService.get_provider_tier(chosen_type),
        meta_phone_number_id=body.phone_number_id,
        meta_access_token=body.access_token,
        meta_business_account_id=body.waba_id,
        meta_waba_id=body.waba_id,
        is_active=True,
        is_authenticated=True,
        authentication_status=AuthenticationStatus.AUTHENTICATED,
        coexistence_enabled=chosen_type in (PTEnum.META_CLOUD_COEXISTENCE, PTEnum.META_CLOUD_FULL),
        mmlite_enabled=chosen_type in (PTEnum.META_CLOUD_MMLITE, PTEnum.META_CLOUD_FULL),
    )
    db.add(account)
    db.commit()
    db.refresh(account)

    # Inscreve o App pra receber webhook dessa WABA nova — sem isso, mensagem
    # chega no número mas nunca aparece no app (mesma causa raiz que o
    # diagnóstico de subscribed_apps existente detecta pra contas manuais).
    subscribe_warning = None
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{API_VERSION}/{body.waba_id}/subscribed_apps",
                headers={"Authorization": f"Bearer {body.access_token}"},
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        subscribe_warning = exc.response.text[:300]
        logger.warning(f"Conta {account.id} criada mas subscribed_apps falhou: {subscribe_warning}")

    logger.info(f"Conta {account.id} criada via Embedded Signup (waba={body.waba_id}, phone_number_id={body.phone_number_id})")
    return {
        "success": True,
        "data": {"id": account.id, "account_name": account.account_name, "phone_number": account.phone_number},
        "subscribe_warning": subscribe_warning,
    }


class RegisterNumberRequest(BaseModel):
    account_id: int
    pin: str = Field(..., min_length=6, max_length=6, description="PIN de 2 etapas — 6 dígitos numéricos")


@embedded_signup_router.post("/register-number")
async def register_number(body: RegisterNumberRequest, db: Session = Depends(get_db), _auth=Depends(_require_login)):
    """
    Ativa o número pra Cloud API (POST /{phone_number_id}/register) — passo
    final exigido pela Meta antes do número conseguir enviar/receber mensagem
    pela Cloud API, mesmo já verificado por SMS dentro do popup de Signup.
    O PIN vira o PIN de verificação em 2 etapas do número.
    """
    _require_account_perm(db, _auth)
    from backend.database.models import WhatsAppAccount

    account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == body.account_id).first()
    if not account or not account.meta_phone_number_id or not account.meta_access_token:
        raise HTTPException(status_code=404, detail="Conta não encontrada ou sem credenciais Meta")

    if account.provider_type == "meta_cloud_coexistence":
        raise HTTPException(
            status_code=400,
            detail="Coexistência não usa o passo de registro por PIN — o número continua ativo "
                   "via o app WhatsApp Business do celular, não precisa ser \"entregue\" pra Cloud API.",
        )

    if not body.pin.isdigit():
        raise HTTPException(status_code=422, detail="PIN precisa ser numérico (6 dígitos)")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{API_VERSION}/{account.meta_phone_number_id}/register",
                headers={"Authorization": f"Bearer {account.meta_access_token}"},
                json={"messaging_product": "whatsapp", "pin": body.pin},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao registrar número: {exc.response.text[:300]}")

    logger.info(f"Número registrado na Cloud API (account_id={account.id})")
    return {"success": True, "data": data}
