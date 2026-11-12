# backend/models/schemas_auth.py
from pydantic import BaseModel, EmailStr, Field
from typing import Optional, Dict, Any, List
from datetime import datetime
from enum import Enum

class ProviderType(str, Enum):
    META_CLOUD_BASIC = "meta_cloud_basic"
    META_CLOUD_COEXISTENCE = "meta_cloud_coexistence"
    META_CLOUD_MMLITE = "meta_cloud_mmlite"
    META_CLOUD_FULL = "meta_cloud_full"
    BAILEYS = "baileys"
    VENOM = "venom"
    WHATSAPP_WEB_JS = "whatsapp_web_js"
    WPPCONNECT = "wppconnect"
    SITE_CHAT = "site_chat"

class ProviderTier(str, Enum):
    FREE = "free"
    STARTER = "starter"
    BUSINESS = "business"
    PROFESSIONAL = "professional"
    ENTERPRISE = "enterprise"

class AuthenticationStatus(str, Enum):
    PENDING = "pending"
    QR_REQUIRED = "qr_required"
    AUTHENTICATED = "authenticated"
    FAILED = "failed"
    DISCONNECTED = "disconnected" 

# USER MODELS

class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)
    full_name: Optional[str] = None

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    id: int
    email: str
    full_name: Optional[str]
    is_active: bool
    is_admin: bool = False
    role: Optional[str] = "attendant"
    sector: Optional[str] = ""
    created_at: datetime
    permissions: Dict[str, bool] = {}
    display_name_format: str = "first_initial"
    photo_url: Optional[str] = None

    class Config:
        from_attributes = True

# WHATSAPP ACCOUNT MODELS

class WhatsAppAccountCreate(BaseModel):
    account_name: str = Field(..., min_length=3, max_length=255)
    phone_number: str = Field(..., pattern=r'^\+?[1-9]\d{1,14}$')  # FIX: regex= → pattern= (Pydantic V2)
    provider_type: ProviderType
    
    # Configurações opcionais por provider
    meta_phone_number_id: Optional[str] = None
    meta_access_token: Optional[str] = None
    meta_business_account_id: Optional[str] = None
    
    # Configurações específicas
    provider_config: Optional[Dict[str, Any]] = None

class WhatsAppAccountResponse(BaseModel):
    id: int
    user_id: int
    account_name: str
    phone_number: str
    
    provider_type: ProviderType
    provider_tier: ProviderTier
    
    is_active: bool
    is_authenticated: bool
    authentication_status: AuthenticationStatus
    
    # QR code (se necessário)
    qr_code: Optional[str] = None
    qr_code_expires_at: Optional[datetime] = None
    
    # Features habilitadas
    coexistence_enabled: bool
    mmlite_enabled: bool
    
    created_at: datetime
    last_activity_at: Optional[datetime]
    
    class Config:
        from_attributes = True

class WhatsAppAccountUpdate(BaseModel):
    account_name: Optional[str] = None
    is_active: Optional[bool] = None
    provider_config: Optional[Dict[str, Any]] = None

# PROVIDER SELECTION MODELS

class ProviderInfo(BaseModel):
    type: ProviderType
    name: str
    tier: ProviderTier
    description: str
    
    is_official: bool
    risk_level: str
    
    monthly_cost_range: str
    requires_qr: bool
    requires_business_verification: bool
    
    features: List[str]
    warnings: List[str]
    setup_steps: List[str]

class ProviderSelectionRequest(BaseModel):
    provider_type: ProviderType
    account_name: str
    phone_number: str
    
    # Para providers Meta
    meta_config: Optional[Dict[str, str]] = None
    
    # Para providers não-oficiais
    session_id: Optional[str] = None

# AUTH TOKEN MODELS

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserResponse
    active_account: Optional[WhatsAppAccountResponse] = None
