# backend/services/account_service.py
from sqlalchemy.orm import Session
from sqlalchemy import select
from typing import List, Optional, Dict, Any
from datetime import datetime, timedelta

from backend.database.models import User, WhatsAppAccount, ProviderChange
from backend.models.schemas_auth import (
    WhatsAppAccountCreate, 
    WhatsAppAccountResponse,
    ProviderType,
    ProviderTier,
    AuthenticationStatus
)
from backend.services.provider_manager import provider_manager
from backend.utils.time_utils import to_utc_iso

class AccountService:
    
    @staticmethod
    def get_provider_tier(provider_type: ProviderType) -> ProviderTier:
        """Mapeia provider_type para tier"""
        tier_mapping = {
            ProviderType.META_CLOUD_BASIC: ProviderTier.STARTER,
            ProviderType.META_CLOUD_COEXISTENCE: ProviderTier.BUSINESS,
            ProviderType.META_CLOUD_MMLITE: ProviderTier.PROFESSIONAL,
            ProviderType.META_CLOUD_FULL: ProviderTier.ENTERPRISE,
            ProviderType.BAILEYS: ProviderTier.FREE,
            ProviderType.VENOM: ProviderTier.FREE,
            ProviderType.WHATSAPP_WEB_JS: ProviderTier.FREE,
            ProviderType.WPPCONNECT: ProviderTier.FREE,
            ProviderType.SITE_CHAT: ProviderTier.FREE,
        }
        return tier_mapping.get(provider_type, ProviderTier.STARTER)
    
    @staticmethod
    async def create_account(
        db: Session, 
        user_id: int, 
        account_data: WhatsAppAccountCreate
    ) -> WhatsAppAccount:
        """
        Cria nova conta WhatsApp para o usuário
        """
        # Verifica se usuário já tem conta com esse número e provider
        stmt = select(WhatsAppAccount).where(
            WhatsAppAccount.user_id == user_id,
            WhatsAppAccount.phone_number == account_data.phone_number,
            WhatsAppAccount.provider_type == account_data.provider_type
        )
        existing = db.execute(stmt).scalar_one_or_none()
        
        if existing:
            raise ValueError(
                f"Já existe conta com número {account_data.phone_number} "
                f"usando provider {account_data.provider_type}"
            )
        
        # Determina tier
        tier = AccountService.get_provider_tier(account_data.provider_type)
        
        # Cria conta
        new_account = WhatsAppAccount(
            user_id=user_id,
            account_name=account_data.account_name,
            phone_number=account_data.phone_number,
            provider_type=account_data.provider_type,
            provider_tier=tier,
            
            # Configurações Meta (se aplicável)
            meta_phone_number_id=account_data.meta_phone_number_id,
            meta_access_token=account_data.meta_access_token,
            meta_business_account_id=account_data.meta_business_account_id,
            
            # Provider config
            provider_config=account_data.provider_config or {},
            
            # Status inicial
            is_authenticated=False,
            authentication_status=AuthenticationStatus.PENDING,

            # attendance_enabled default True (ver models.py) — relógio de
            # SLA/pendente começa a contar a partir de agora, não antes.
            attendance_enabled_since=datetime.utcnow(),
            
            # Features especiais
            coexistence_enabled=(
                account_data.provider_type in [
                    ProviderType.META_CLOUD_COEXISTENCE,
                    ProviderType.META_CLOUD_FULL
                ]
            ),
            mmlite_enabled=(
                account_data.provider_type in [
                    ProviderType.META_CLOUD_MMLITE,
                    ProviderType.META_CLOUD_FULL
                ]
            )
        )
        
        db.add(new_account)
        db.commit()
        db.refresh(new_account)
        
        # Registra provider no ProviderManager
        provider_config = {
            "phone_number_id": account_data.meta_phone_number_id,
            "access_token": account_data.meta_access_token,
            "business_account_id": account_data.meta_business_account_id,
            **(account_data.provider_config or {})
        }
        
        provider_manager.register_provider(
            account_id=str(new_account.id),
            provider_type=account_data.provider_type,
            config=provider_config
        )
        
        return new_account
    
    @staticmethod
    async def get_user_accounts(db: Session, user_id: int) -> List[WhatsAppAccount]:
        """Lista todas as contas do usuário"""
        stmt = select(WhatsAppAccount).where(
            WhatsAppAccount.user_id == user_id
        ).order_by(WhatsAppAccount.created_at.desc())
        
        accounts = db.execute(stmt).scalars().all()
        return list(accounts)
    
    @staticmethod
    async def get_account(db: Session, account_id: int, user_id: int) -> WhatsAppAccount:
        """Retorna conta específica do usuário"""
        stmt = select(WhatsAppAccount).where(
            WhatsAppAccount.id == account_id,
            WhatsAppAccount.user_id == user_id
        )
        
        account = db.execute(stmt).scalar_one_or_none()
        
        if not account:
            raise ValueError("Conta não encontrada")
        
        return account
    
    @staticmethod
    async def switch_account(
        db: Session, 
        user_id: int, 
        account_id: int
    ) -> WhatsAppAccount:
        """Troca conta ativa do usuário"""
        account = await AccountService.get_account(db, account_id, user_id)
        
        # Atualiza last_activity
        account.last_activity_at = datetime.utcnow()
        db.commit()
        db.refresh(account)
        
        return account
    
    @staticmethod
    async def change_provider(
        db: Session,
        account_id: int,
        user_id: int,
        new_provider_type: ProviderType,
        migration_data: Optional[Dict[str, Any]] = None
    ) -> WhatsAppAccount:
        """
        Migra conta para outro provider
        """
        account = await AccountService.get_account(db, account_id, user_id)
        old_provider = account.provider_type
        
        # Registra mudança no histórico
        provider_change = ProviderChange(
            account_id=account_id,
            old_provider_type=old_provider,
            new_provider_type=new_provider_type,
            changed_by=user_id,
            migration_data=migration_data or {}
        )
        
        db.add(provider_change)
        
        # Atualiza provider
        account.provider_type = new_provider_type
        account.provider_tier = AccountService.get_provider_tier(new_provider_type)
        account.is_authenticated = False
        account.authentication_status = AuthenticationStatus.PENDING
        
        # Atualiza features
        account.coexistence_enabled = new_provider_type in [
            ProviderType.META_CLOUD_COEXISTENCE,
            ProviderType.META_CLOUD_FULL
        ]
        
        account.mmlite_enabled = new_provider_type in [
            ProviderType.META_CLOUD_MMLITE,
            ProviderType.META_CLOUD_FULL
        ]
        
        db.commit()
        db.refresh(account)
        
        return account
    
    @staticmethod
    async def initialize_authentication(
        db: Session,
        account_id: int,
        user_id: int
    ) -> Dict[str, Any]:
        """
        Inicializa autenticação para a conta
        Retorna QR code se necessário, ou status
        """
        account = await AccountService.get_account(db, account_id, user_id)
        provider = provider_manager.get_provider(str(account_id))
        
        if not provider:
            raise ValueError("Provider não inicializado")
        
        # Se já autenticado
        if await provider.is_authenticated():
            account.is_authenticated = True
            account.authentication_status = AuthenticationStatus.AUTHENTICATED
            db.commit()
            
            return {
                "status": "authenticated",
                "requires_qr": False
            }
        
        # Se requer QR code
        qr_code = await provider.get_qr_code()
        
        if qr_code:
            account.qr_code = qr_code
            account.qr_code_expires_at = datetime.utcnow() + timedelta(minutes=5)
            account.authentication_status = AuthenticationStatus.QR_REQUIRED
            db.commit()
            
            return {
                "status": "qr_required",
                "requires_qr": True,
                "qr_code": qr_code,
                "expires_at": to_utc_iso(account.qr_code_expires_at)
            }
        
        # Provider oficial já configurado
        account.is_authenticated = True
        account.authentication_status = AuthenticationStatus.AUTHENTICATED
        db.commit()
        
        return {
            "status": "authenticated",
            "requires_qr": False
        }

account_service = AccountService()
