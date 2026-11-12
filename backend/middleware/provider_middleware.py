# backend/middleware/provider_middleware.py
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from backend.services.provider_manager import provider_manager
from backend.services.auth_service import auth_service
from backend.database.connection import SessionLocal

class ProviderRoutingMiddleware(BaseHTTPMiddleware):
    """
    Middleware que automaticamente roteia para o provider correto
    baseado no usuário/conta autenticada
    """
    
    async def dispatch(self, request: Request, call_next):
        # Pega token do header
        auth_header = request.headers.get("Authorization")
        
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
            
            try:
                # Decodifica token
                payload = auth_service.decode_token(token)
                account_id = payload.get("account_id")
                
                if account_id:
                    # Injeta provider no request state
                    provider = provider_manager.get_provider(str(account_id))
                    request.state.provider = provider
                    request.state.account_id = account_id
                    
            except Exception:
                pass  # Token inválido, deixa passar
        
        response = await call_next(request)
        return response
