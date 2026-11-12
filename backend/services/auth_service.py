# backend/services/auth_service.py
import jwt
import bcrypt
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from sqlalchemy.orm import Session
from sqlalchemy import select
import hashlib

from backend.database.models import User, WhatsAppAccount, UserSession
from backend.models.schemas_auth import UserCreate, UserLogin, TokenResponse

import os
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "your-secret-key-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 24

class AuthService:
    
    @staticmethod
    def hash_password(password: str) -> str:
        """Hash de senha com bcrypt"""
        salt = bcrypt.gensalt()
        hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
        return hashed.decode('utf-8')
    
    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        """Verifica senha"""
        return bcrypt.checkpw(
            plain_password.encode('utf-8'),
            hashed_password.encode('utf-8')
        )
    
    @staticmethod
    def create_access_token(user_id: int, account_id: Optional[int] = None) -> str:
        """Cria JWT token"""
        expire = datetime.utcnow() + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
        
        payload = {
            "user_id": user_id,
            "account_id": account_id,
            "exp": expire,
            "iat": datetime.utcnow()
        }
        
        token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
        return token
    
    @staticmethod
    def decode_token(token: str) -> Dict[str, Any]:
        """Decodifica JWT token"""
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            return payload
        except jwt.ExpiredSignatureError:
            raise ValueError("Token expirado")
        except jwt.InvalidTokenError:
            raise ValueError("Token inválido")
    
    @staticmethod
    async def register_user(db: Session, user_data: UserCreate) -> User:
        """Registra novo usuário"""
        # Verifica se email já existe
        stmt = select(User).where(User.email == user_data.email)
        existing_user = db.execute(stmt).scalar_one_or_none()
        
        if existing_user:
            raise ValueError("Email já cadastrado")
        
        # Cria usuário
        hashed_password = AuthService.hash_password(user_data.password)
        
        new_user = User(
            email=user_data.email,
            password_hash=hashed_password,
            full_name=user_data.full_name
        )
        
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        
        return new_user
    
    @staticmethod
    async def login_user(db: Session, login_data: UserLogin) -> TokenResponse:
        """Login de usuário"""
        # Busca usuário
        stmt = select(User).where(User.email == login_data.email)
        user = db.execute(stmt).scalar_one_or_none()
        
        if not user or not user.is_active:
            raise ValueError("Credenciais inválidas")
        
        # Verifica senha
        if not AuthService.verify_password(login_data.password, user.password_hash):
            raise ValueError("Credenciais inválidas")
        
        # Busca conta WhatsApp ativa (se existir)
        stmt = select(WhatsAppAccount).where(
            WhatsAppAccount.user_id == user.id,
            WhatsAppAccount.is_active == True
        ).order_by(WhatsAppAccount.last_activity_at.desc())
        
        active_account = db.execute(stmt).scalars().first()
        
        # Cria token
        account_id = active_account.id if active_account else None
        token = AuthService.create_access_token(user.id, account_id)
        
        # Salva sessão
        session_hash = hashlib.sha256(token.encode()).hexdigest()[:255]
        
        new_session = UserSession(
            user_id=user.id,
            active_account_id=account_id,
            token_hash=session_hash,
            expires_at=datetime.utcnow() + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
        )
        
        db.add(new_session)
        db.commit()
        
        return TokenResponse(
            access_token=token,
            expires_in=ACCESS_TOKEN_EXPIRE_HOURS * 3600,
            user=user,
            active_account=active_account
        )
    
    @staticmethod
    async def get_current_user(db: Session, token: str) -> User:
        """Retorna usuário atual baseado no token"""
        payload = AuthService.decode_token(token)
        user_id = payload.get("user_id")
        
        if not user_id:
            raise ValueError("Token inválido")
        
        stmt = select(User).where(User.id == user_id)
        user = db.execute(stmt).scalar_one_or_none()
        
        if not user or not user.is_active:
            raise ValueError("Usuário não encontrado")
        
        return user
    
    @staticmethod
    async def get_current_account(db: Session, token: str) -> Optional[WhatsAppAccount]:
        """Retorna conta WhatsApp ativa do token"""
        payload = AuthService.decode_token(token)
        account_id = payload.get("account_id")
        
        if not account_id:
            return None
        
        stmt = select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)
        account = db.execute(stmt).scalar_one_or_none()
        
        return account

auth_service = AuthService()
