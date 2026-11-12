"""
Enforcement real de permissão por papel — antes de agora, a matriz de
permissões (routes_settings.py, data/settings.json) era só cosmética: nenhuma
rota do backend a consultava. Isso substitui por checagem de verdade contra a
tabela roles (backend/database/models.py Role).

Cada permissão pode valer:
  - True / "allow"       -> segue o fluxo normal
  - False / ausente       -> bloqueado (403), nem chega na rota
  - "require_approval"    -> a rota deve gravar um PendingChange em vez de
                              executar direto (ver routes_baileys.py e
                              routes_admin.py /pending-changes)
"allow"/"require_approval" são os únicos casos que chegam até a rota — "deny"
já é barrado aqui dentro, a rota nem precisa saber que foi negado.
"""
from dataclasses import dataclass
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from sqlalchemy import select

from backend.database.connection import get_db
from backend.database.models import Role, User
from backend.services.auth_service import auth_service

security = HTTPBearer()


@dataclass
class PermissionDecision:
    user: User
    decision: str  # "allow" | "require_approval"


def _resolve_decision(raw) -> str:
    if raw is True or raw == "allow":
        return "allow"
    if raw == "require_approval":
        return "require_approval"
    return "deny"


def require_permission(key: str):
    """
    Dependency factory: `Depends(require_permission('profile_edit_sensitive'))`.
    Devolve um PermissionDecision — a rota deve checar `.decision`:
      - "allow": segue e executa a ação normalmente.
      - "require_approval": grava um PendingChange em vez de executar.
    "deny" nunca chega na rota — já vira 403 aqui.
    is_admin=True sempre é "allow" direto (evita que um admin se tranque fora
    ajustando a própria matriz por engano).
    """
    async def _dependency(
        credentials: HTTPAuthorizationCredentials = Depends(security),
        db: Session = Depends(get_db),
    ) -> PermissionDecision:
        try:
            token = credentials.credentials
            user = await auth_service.get_current_user(db, token)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token inválido ou expirado",
            )

        if getattr(user, "is_admin", False):
            return PermissionDecision(user=user, decision="allow")

        role = db.execute(select(Role).where(Role.key == user.role)).scalar_one_or_none()
        raw = role.permissions.get(key) if role else None
        decision = _resolve_decision(raw)

        if decision == "deny":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Seu papel ('{user.role}') não tem permissão para esta ação.",
            )
        return PermissionDecision(user=user, decision=decision)

    return _dependency


def get_effective_permissions(db: Session, user: User) -> dict:
    """
    Mapa de permissões efetivas do usuário logado, devolvido em /api/auth/me
    pro frontend decidir o que mostrar (abas de Configurações, botão do
    Painel Admin, etc.) sem esperar um 403 de alguma ação pra descobrir que
    não tinha acesso. is_admin=True enxerga tudo como "allow" (mesmo bypass
    de require_permission/user_has_permission).
    """
    if getattr(user, "is_admin", False):
        all_keys = set()
        for role in db.query(Role).all():
            all_keys.update((role.permissions or {}).keys())
        return {key: True for key in all_keys}
    role = db.query(Role).filter(Role.key == user.role).first()
    return dict(role.permissions) if role and role.permissions else {}


def user_has_permission(db: Session, user: User, key: str) -> bool:
    """
    Checagem direta (fora do ciclo de Depends), pra rotas onde a decisão de
    permitir depende de dado do próprio payload (ex: atribuir uma conversa a
    OUTRA pessoa exige `conversation_assign_others`, mas atribuir a si mesmo
    não) — nesses casos a rota precisa decidir DEPOIS de ler o body, então
    `require_permission()` (que já bloqueia antes da rota rodar) não serve.
    Trata "require_approval" como não permitido — só faz sentido pra
    permissões tri-state geridas via PendingChange, as demais são bool puro.
    """
    if getattr(user, "is_admin", False):
        return True
    role = db.query(Role).filter(Role.key == user.role).first()
    if not role:
        return False
    return _resolve_decision(role.permissions.get(key)) == "allow"
