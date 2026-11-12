# backend/api/routes_auth.py
from fastapi import APIRouter, Depends, HTTPException, status, Header, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from typing import List

from backend.database.connection import get_db
from backend.services.auth_service import auth_service
from backend.services.account_service import account_service
from backend.api.routes_admin import get_admin_user as _get_admin_user
from backend.api.permissions import user_has_permission, get_effective_permissions
from backend.models.schemas_auth import (
    UserCreate,
    UserLogin,
    UserResponse,
    TokenResponse,
    WhatsAppAccountCreate,
    WhatsAppAccountResponse,
    ProviderType
)

router_auth = APIRouter(prefix="/api/auth", tags=["Authentication"])
security = HTTPBearer()

# DEPENDENCY: Get Current User

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
):
    """Dependency para pegar usuário autenticado"""
    try:
        token = credentials.credentials
        user = await auth_service.get_current_user(db, token)
        return user
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e)
        )

async def get_current_account(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
):
    """Dependency para pegar conta WhatsApp ativa"""
    try:
        token = credentials.credentials
        account = await auth_service.get_current_account(db, token)
        return account
    except ValueError as e:
        return None

# AUTH ROUTES

@router_auth.post("/register", response_model=UserResponse)
async def register(user_data: UserCreate, db: Session = Depends(get_db), admin_user=Depends(_get_admin_user)):
    """
    Cria novo usuário. Antes disso, qualquer um (sem login nenhum) podia se
    autocadastrar direto por essa rota — não virava admin, mas entrava
    logado no sistema sem convite. Usuários hoje são criados pelo Painel
    Admin (POST /api/admin/users); esta rota fica só como via alternativa,
    agora restrita a quem já é admin.
    """
    try:
        user = await auth_service.register_user(db, user_data)
        return user
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router_auth.post("/login", response_model=TokenResponse)
async def login(login_data: UserLogin, db: Session = Depends(get_db)):
    """Login de usuário"""
    try:
        token_response = await auth_service.login_user(db, login_data)
        return token_response
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))

@router_auth.get("/me", response_model=UserResponse)
async def get_me(current_user = Depends(get_current_user), db: Session = Depends(get_db)):
    """Retorna dados do usuário logado, incluindo o mapa de permissões
    efetivas do seu papel (usado pelo frontend pra esconder abas/telas sem
    esperar um 403 de alguma ação)."""
    response = UserResponse.model_validate(current_user)
    response.permissions = get_effective_permissions(db, current_user)
    return response

# WHATSAPP ACCOUNT ROUTES

@router_auth.post("/accounts", response_model=WhatsAppAccountResponse)
async def create_whatsapp_account(
    account_data: WhatsAppAccountCreate,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Cria nova conta WhatsApp"""
    if not user_has_permission(db, current_user, "settings_accounts"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para conectar contas WhatsApp.")
    try:
        account = await account_service.create_account(
            db, current_user.id, account_data
        )
        return account
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router_auth.get("/accounts", response_model=List[WhatsAppAccountResponse])
async def list_accounts(
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Lista todas as contas do usuário"""
    accounts = await account_service.get_user_accounts(db, current_user.id)
    return accounts

@router_auth.get("/accounts/{account_id}", response_model=WhatsAppAccountResponse)
async def get_account(
    account_id: int,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Retorna conta específica"""
    try:
        account = await account_service.get_account(db, account_id, current_user.id)
        return account
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router_auth.post("/accounts/{account_id}/switch")
async def switch_account(
    account_id: int,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Troca conta ativa"""
    try:
        account = await account_service.switch_account(db, current_user.id, account_id)
        
        # Gera novo token com essa conta
        new_token = auth_service.create_access_token(current_user.id, account.id)
        
        return {
            "access_token": new_token,
            "account": account
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router_auth.post("/accounts/{account_id}/auth/init")
async def initialize_auth(
    account_id: int,
    request: Request,               # ← Request agora importado
    db: Session = Depends(get_db)
):
    """Inicializa autenticação (gera QR se necessário)"""
    try:
        current_user_id = None
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            try:
                payload = auth_service.decode_token(auth_header[7:])
                current_user_id = payload.get("user_id")
            except Exception:
                pass  # Onboarding sem token — OK

        auth_status = await account_service.initialize_authentication(
            db, account_id, current_user_id
        )
        return auth_status
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router_auth.post("/accounts/{account_id}/provider/change")
async def change_provider(
    account_id: int,
    new_provider: ProviderType,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Migra conta para outro provider"""
    try:
        account = await account_service.change_provider(
            db, account_id, current_user.id, new_provider
        )
        return account
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
