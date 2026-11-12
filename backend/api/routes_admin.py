# backend/api/routes_admin.py
"""
Rotas administrativas - Apenas para usuários admin
Gerenciamento completo de usuários, contas e configurações do sistema
"""
from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from sqlalchemy import select, func, and_, or_
from typing import List, Optional, Dict, Any, Union, Literal
from datetime import datetime, timedelta
from pydantic import BaseModel, Field

from backend.database.connection import get_db
from backend.database.models import (
    User, WhatsAppAccount, ProviderChange, Message, Conversation, Role, PendingChange,
    Contact, CsatResponse, InternalTask, Tag, conversation_tags, Direction,
)
from backend.services.auth_service import auth_service
from backend.utils.contact_filters import NON_CUSTOMER_WA_IDS
from backend.services.account_service import account_service
from backend.services.provider_manager import provider_manager
from backend.models.schemas_auth import (
    ProviderType,
    ProviderTier,
    AuthenticationStatus
)

router_admin = APIRouter(prefix="/api/admin", tags=["Admin"])
security = HTTPBearer()

# MODELS ESPECÍFICOS ADMIN

class UserAdminResponse(BaseModel):
    id: int
    email: str
    full_name: Optional[str] = None
    is_active: bool
    is_admin: bool
    role: Optional[str] = None
    sector: Optional[str] = ""
    account_ids: List[int] = []
    created_at: datetime
    total_accounts: int
    total_messages_sent: int
    last_activity: Optional[datetime] = None

class AccountAdminResponse(BaseModel):
    id: int
    user_id: int
    user_email: str
    account_name: str
    phone_number: str
    provider_type: ProviderType
    provider_tier: ProviderTier
    is_active: bool
    is_authenticated: bool
    authentication_status: AuthenticationStatus
    created_at: datetime
    total_messages: int
    total_conversations: int

class AttendanceSnapshot(BaseModel):
    open_unassigned: int
    open_assigned: int
    # "pending" (aguardando o cliente) sozinho misturava conversa que
    # respondeu ontem com conversa esperando há 23 dias — um card só não dá
    # pra analisar. pending_recent é o que de fato está "aguardando" agora
    # (pending_since < 24h); pending_stale é o resto (parado, cliente sumiu),
    # ver PENDING_STALE_HOURS.
    pending_recent: int
    pending_stale: int
    resolved_count: int
    sla_breaches_now: int
    sla_wait_minutes: int
    avg_wait_seconds: Optional[int] = None
    avg_resolution_seconds: Optional[int] = None

class CsatSnapshot(BaseModel):
    avg_rating: Optional[float] = None
    response_count: int
    response_rate: Optional[float] = None

class TasksSnapshot(BaseModel):
    pending: int
    overdue: int
    completed_count: int

class SystemStats(BaseModel):
    period_days: int
    start_date: str
    end_date: str
    account_ids: List[int] = []
    total_users: int
    active_users: int
    total_accounts: int
    total_messages_today: int
    total_messages_month: int
    providers_usage: Dict[str, int]
    tiers_distribution: Dict[str, int]
    attendance: AttendanceSnapshot
    csat: CsatSnapshot
    tasks: TasksSnapshot


class DailyVolumePoint(BaseModel):
    date: str
    created: int
    resolved: int

class HourlyVolumePoint(BaseModel):
    hour: int
    count: int

class OldestWaitingItem(BaseModel):
    conversation_id: int
    contact_name: str
    account_name: str
    wait_seconds: int

class AgentWorkloadItem(BaseModel):
    user_id: int
    full_name: str
    open_count: int

class TagCount(BaseModel):
    name: str
    color: str
    count: int

class CsatDailyPoint(BaseModel):
    date: str
    avg_rating: Optional[float] = None
    count: int

class AccountVolumeItem(BaseModel):
    account_id: int
    account_name: str
    phone_number: str
    count: int

class DashboardTrends(BaseModel):
    period_days: int
    start_date: str
    end_date: str
    account_ids: List[int] = []
    daily_volume: List[DailyVolumePoint]
    hourly_volume: List[HourlyVolumePoint]
    oldest_waiting: List[OldestWaitingItem]
    agent_workload: List[AgentWorkloadItem]
    bot_only_count: int
    with_human_count: int
    top_tags: List[TagCount]
    csat_daily: List[CsatDailyPoint]
    volume_by_account: List[AccountVolumeItem]

class UserCreateAdmin(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None
    is_admin: bool = False
    role: Optional[str] = "attendant"
    sector: Optional[str] = ""
    account_ids: Optional[List[int]] = None

class UserUpdateAdmin(BaseModel):
    email: Optional[str] = None
    full_name: Optional[str] = None
    is_active: Optional[bool] = None
    is_admin: Optional[bool] = None
    password: Optional[str] = None
    role: Optional[str] = None
    sector: Optional[str] = None
    account_ids: Optional[List[int]] = None

class AccountUpdateAdmin(BaseModel):
    account_name: Optional[str] = None
    is_active: Optional[bool] = None
    provider_type: Optional[ProviderType] = None
    daily_message_limit: Optional[int] = None
    monthly_message_limit: Optional[int] = None


# Valor de uma permissão: bool normal, OU a string "require_approval" pras
# permissões "sensitive" (profile_edit_sensitive, settings_credentials...) —
# ver backend/api/permissions.py _resolve_decision. Faltava aceitar essa
# segunda forma aqui: o formulário de Papel mandava "require_approval" e o
# Dict[str, bool] rejeitava com 422, que o frontend exibia como "[object
# Object]" (o `detail` de validação do FastAPI é uma lista de objetos).
PermissionValue = Union[bool, Literal["require_approval"]]

class RoleResponse(BaseModel):
    id: int
    key: str
    label: str
    color: str
    permissions: Dict[str, PermissionValue]
    is_builtin: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class RoleCreate(BaseModel):
    key: str = Field(..., min_length=2, max_length=50, pattern=r"^[a-z0-9_]+$",
                      description="Identificador único, minúsculo, sem espaços (ex: financeiro)")
    label: str = Field(..., min_length=1, max_length=100)
    color: str = "#25D366"
    permissions: Dict[str, PermissionValue] = {}

class RoleUpdate(BaseModel):
    label: Optional[str] = None
    color: Optional[str] = None
    permissions: Optional[Dict[str, PermissionValue]] = None

class PendingChangeResponse(BaseModel):
    id: int
    account_id: Optional[int]
    requested_by: int
    requested_by_email: str
    change_type: str
    payload: Dict[str, Any]
    status: str
    reviewed_by: Optional[int]
    reviewed_at: Optional[datetime]
    created_at: datetime

class PendingChangeReject(BaseModel):
    reason: Optional[str] = None

# DEPENDENCY: Admin Only  ← CORRIGIDO

async def get_admin_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
):
    """
    ✅ FIX: Dependency correta para FastAPI.
    Antes usava Depends(auth_service.get_current_user) diretamente,
    o que causava FastAPIError porque Session não é campo Pydantic.
    """
    try:
        token = credentials.credentials
        user = await auth_service.get_current_user(db, token)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido ou expirado"
        )

    if not getattr(user, 'is_admin', False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acesso permitido apenas para administradores"
        )
    return user


def require_admin_permission(*keys: str):
    """
    Dependency factory pro Painel Admin: aceita quem é is_admin=True (bypass
    total, como sempre) OU quem tem QUALQUER UMA das permissões passadas
    (admin_dashboard/admin_accounts/admin_roles/admin_approvals/
    settings_users/settings_meta_app/admin_system_config) — permite abrir só
    a aba do Painel Admin liberada pro papel do usuário, em vez de tudo ou
    nada como era com get_admin_user.
    """
    async def _dependency(
        credentials: HTTPAuthorizationCredentials = Depends(security),
        db: Session = Depends(get_db),
    ) -> User:
        try:
            token = credentials.credentials
            user = await auth_service.get_current_user(db, token)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token inválido ou expirado",
            )
        if getattr(user, "is_admin", False):
            return user
        from backend.api.permissions import user_has_permission
        if any(user_has_permission(db, user, key) for key in keys):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Seu papel não tem permissão para acessar esta área do Painel Admin.",
        )
    return _dependency

# DASHBOARD & STATS

def _client_conv_filters(account_ids: Optional[List[int]] = None):
    """Filtro-base pra qualquer métrica sobre conversa de CLIENTE (não grupo,
    não contato interno, não contato-fantasma tipo wppconnect-reaction/
    status@broadcast — ver contact_filters.py; sem isso essas entravam nas
    contagens de fila/SLA como se fossem clientes de verdade esperando; e não
    numa conta com attendance_enabled=False — número que não é atendimento
    ao cliente de verdade, ex: linha interna de TI/Logística com fornecedor,
    onde não faz sentido contar "cliente esperando"/SLA porque ninguém ali é
    formalmente atendente) — usado tanto no snapshot quanto nas tendências.
    account_ids opcional restringe a uma ou mais contas/números (filtro do
    dashboard, multi-seleção), None/vazio = todas as contas (as com
    atendimento desligado continuam de fora mesmo assim)."""
    filters = [
        Conversation.is_group.is_(False),
        Contact.is_internal.is_(False),
        Contact.wa_id.notin_(NON_CUSTOMER_WA_IDS),
        Conversation.account_id.in_(select(WhatsAppAccount.id).where(WhatsAppAccount.attendance_enabled.is_(True))),
    ]
    if account_ids:
        filters.append(Conversation.account_id.in_(account_ids))
    return filters


def _attendant_user_ids(db: Session) -> set:
    """Usuários que contam como "atendente de verdade" pra fins de SLA/tempo
    de atendimento — admin sempre conta (bypass usual); os demais, só se o
    papel tiver feature_attendance_agent == allow (mesma regra que
    ConversationService.handle_agent_outbound_reply já usa pra decidir se
    auto-atribui). Conta ser "de atendimento" (attendance_enabled) não basta
    sozinho: se quem está com a conversa não é atendente de verdade (ex:
    alguém de outro setor respondeu uma vez, ou foi atribuída manualmente a
    alguém errado), não deve contar como "em atendimento"/"aguardando
    cliente" — as duas condições (conta E usuário) precisam valer."""
    from backend.api.permissions import _resolve_decision
    roles = db.execute(select(Role)).scalars().all()
    attendant_role_keys = {
        r.key for r in roles
        if _resolve_decision((r.permissions or {}).get("feature_attendance_agent")) == "allow"
    }
    rows = db.execute(
        select(User.id).where(or_(User.is_admin.is_(True), User.role.in_(attendant_role_keys)))
    ).scalars().all()
    return set(rows)


def _to_epoch_ms(dt: datetime) -> int:
    """Message.timestamp é epoch em MILISSEGUNDOS (BigInteger), não DateTime
    — comparar direto com um objeto datetime silenciosamente compara o
    inteiro com o valor errado (confirmado: contava ~36 mil mensagens como
    "hoje" num banco com 745 mensagens no dia). Sempre converter antes."""
    return int(dt.timestamp() * 1000)


def _resolve_period(days: int, start_date: Optional[str], end_date: Optional[str]):
    """`start_date`/`end_date` (YYYY-MM-DD, do date picker) têm prioridade —
    quando vêm, o período é EXATAMENTE aquele intervalo (não "de lá pra cá"),
    incluindo o dia final inteiro. Sem eles, cai no preset relativo `days`
    (últimos N dias até agora) — mesma convenção do resto do app."""
    if start_date and end_date:
        cutoff = datetime.strptime(start_date, "%Y-%m-%d")
        period_end = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1) - timedelta(microseconds=1)
    else:
        period_end = datetime.utcnow()
        cutoff = period_end - timedelta(days=days)
    return cutoff, period_end


@router_admin.get("/dashboard/stats", response_model=SystemStats)
async def get_system_stats(
    days: int = 7,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    account_ids: Optional[List[int]] = Query(None),
    admin_user = Depends(require_admin_permission('admin_dashboard')),
    db: Session = Depends(get_db)
):
    """Estatísticas gerais do sistema + snapshot operacional (atendimento/
    CSAT/tarefas) no período (`start_date`/`end_date` ou preset `days`),
    opcionalmente restrito a uma ou mais contas/números (`account_ids`).
    Contagens de cadastro (usuários/contas/providers) nunca são filtradas por
    conta — descrevem o sistema todo, não uma linha."""
    total_users = db.execute(select(func.count(User.id))).scalar() or 0

    thirty_days_ago = datetime.utcnow() - timedelta(days=30)
    active_users = db.execute(
        select(func.count(User.id)).where(
            User.is_active == True,
            User.updated_at >= thirty_days_ago
        )
    ).scalar() or 0

    total_accounts = db.execute(select(func.count(WhatsAppAccount.id))).scalar() or 0

    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    message_filters = [Message.timestamp >= _to_epoch_ms(today_start)]
    month_start = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_filters = [Message.timestamp >= _to_epoch_ms(month_start)]
    if account_ids:
        message_filters.append(Message.conversation.has(Conversation.account_id.in_(account_ids)))
        month_filters.append(Message.conversation.has(Conversation.account_id.in_(account_ids)))
    total_messages_today = db.execute(select(func.count(Message.id)).where(*message_filters)).scalar() or 0
    total_messages_month = db.execute(select(func.count(Message.id)).where(*month_filters)).scalar() or 0

    providers_usage: Dict[str, int] = {}
    for provider_type in ProviderType:
        count = db.execute(
            select(func.count(WhatsAppAccount.id)).where(
                WhatsAppAccount.provider_type == provider_type.value
            )
        ).scalar() or 0
        providers_usage[provider_type.value] = count

    tiers_distribution: Dict[str, int] = {}
    for tier in ProviderTier:
        count = db.execute(
            select(func.count(WhatsAppAccount.id)).where(
                WhatsAppAccount.provider_tier == tier.value
            )
        ).scalar() or 0
        tiers_distribution[tier.value] = count

    # Snapshot operacional — o que "Dashboard do Sistema" mostrava até aqui
    # era só contagem de cadastro (usuários/contas/mensagens), sem nada sobre
    # COMO a operação de atendimento está indo. Reaproveita as mesmas regras
    # de escopo do /api/attendance/reports (só 1:1, contato não interno).
    # `open_unassigned`/`open_assigned`/`pending`/`sla_breaches_now` são
    # sempre uma FOTO DE AGORA (independem do período) — mesma convenção já
    # usada em sla_breaches_now do relatório de atendimento; o resto
    # (resolvidas/tempo médio/CSAT) é sobre o intervalo [cutoff, period_end].
    cutoff, period_end = _resolve_period(days, start_date, end_date)
    client_conv_filter = _client_conv_filters(account_ids)
    # Segunda condição independente da conta: quem está com a conversa
    # precisa ser um atendente de verdade — ver _attendant_user_ids.
    attendant_ids = _attendant_user_ids(db)

    def _count_conv(*extra_filters):
        return db.execute(
            select(func.count(Conversation.id))
            .join(Contact, Conversation.contact_id == Contact.id)
            .where(*client_conv_filter, *extra_filters)
        ).scalar() or 0

    open_unassigned = _count_conv(Conversation.status == "open", Conversation.assigned_to_user_id.is_(None))
    # "em atendimento" só conta se o dono da conversa for de fato atendente
    # (ver _attendant_user_ids) — senão a conta bate certo pra fila (ninguém
    # assumiu de verdade) mas contava errado aqui.
    open_assigned = _count_conv(Conversation.status == "open", Conversation.assigned_to_user_id.in_(attendant_ids))

    # "pending" sozinho (medido: 88% das conversas pending tinham mais de 24h,
    # a mais velha 23 dias) misturava "cliente vai responder já já" com
    # "conversa morta que ninguém fechou" — não dava pra analisar num card só.
    # pending_since NULL (não deveria acontecer, mas por segurança) conta como
    # stale, não recent — não dá pra provar que é recente. E, igual a
    # open_assigned acima, só entra se quem está com ela for atendente de
    # verdade (uma "pending" sem isso normalmente também não tem
    # assigned_to_user_id — ver handle_agent_outbound_reply — então já cairia
    # fora do .in_(attendant_ids) mesmo).
    #
    # attendance_enabled_since (ver models.py): se a conta só virou
    # atendimento AGORA mas tem conversa aberta de semanas atrás, o relógio
    # conta a partir de quando virou atendimento, não da data real — senão o
    # card salta pra um backlog gigante no instante em que alguém liga o
    # toggle. GREATEST(timestamp real, enabled_since) faz isso; COALESCE cobre
    # conta que nunca teve o campo setado (sempre foi atendimento).
    PENDING_STALE_HOURS = 24
    pending_recent_cutoff = datetime.utcnow() - timedelta(hours=PENDING_STALE_HOURS)
    effective_pending_since = func.greatest(
        Conversation.pending_since,
        func.coalesce(WhatsAppAccount.attendance_enabled_since, Conversation.pending_since),
    )

    def _count_pending(*extra_filters):
        return db.execute(
            select(func.count(Conversation.id))
            .join(Contact, Conversation.contact_id == Contact.id)
            .join(WhatsAppAccount, Conversation.account_id == WhatsAppAccount.id)
            .where(
                *client_conv_filter, Conversation.status == "pending",
                Conversation.assigned_to_user_id.in_(attendant_ids), *extra_filters,
            )
        ).scalar() or 0

    pending_recent = _count_pending(Conversation.pending_since.isnot(None), effective_pending_since >= pending_recent_cutoff)
    pending_stale = _count_pending(or_(Conversation.pending_since.is_(None), effective_pending_since < pending_recent_cutoff))
    resolved_count = _count_conv(Conversation.resolved_at.between(cutoff, period_end))

    from backend.api.routes_settings import _load_settings
    sla_minutes = _load_settings().get("automations", {}).get("sla", {}).get("wait_minutes", 10)
    sla_cutoff = datetime.utcnow() - timedelta(minutes=sla_minutes)
    # sla_breaches_now é sempre SEM atribuição (assigned_at NULL) — não tem
    # usuário pra checar aqui, só a conta (+ mesmo reset de relógio via
    # attendance_enabled_since que pending_recent/stale usa acima).
    effective_created_at = func.greatest(
        Conversation.created_at,
        func.coalesce(WhatsAppAccount.attendance_enabled_since, Conversation.created_at),
    )
    sla_breaches_now = db.execute(
        select(func.count(Conversation.id))
        .join(Contact, Conversation.contact_id == Contact.id)
        .join(WhatsAppAccount, Conversation.account_id == WhatsAppAccount.id)
        .where(
            *client_conv_filter, Conversation.status != "resolved", Conversation.assigned_at.is_(None),
            effective_created_at < sla_cutoff,
        )
    ).scalar() or 0

    period_activity = db.execute(
        select(Conversation.created_at, Conversation.assigned_at, Conversation.resolved_at, Conversation.assigned_to_user_id)
        .join(Contact, Conversation.contact_id == Contact.id)
        .where(
            *client_conv_filter,
            or_(Conversation.assigned_at.between(cutoff, period_end), Conversation.resolved_at.between(cutoff, period_end)),
        )
    ).all()
    # Tempo médio de espera/resolução só conta quem passou pelas mãos de um
    # atendente de verdade (mesma regra de open_assigned/pending acima) —
    # senão a média de "tempo de atendimento" inclui gente que nunca devia
    # contar como atendimento.
    wait_period = [
        (r.assigned_at - r.created_at).total_seconds() for r in period_activity
        if r.assigned_at and cutoff <= r.assigned_at <= period_end and r.assigned_to_user_id in attendant_ids
    ]
    resolution_period = [
        (r.resolved_at - r.created_at).total_seconds() for r in period_activity
        if r.resolved_at and cutoff <= r.resolved_at <= period_end and r.assigned_to_user_id in attendant_ids
    ]

    def _avg(vals):
        return round(sum(vals) / len(vals)) if vals else None

    attendance = AttendanceSnapshot(
        open_unassigned=open_unassigned,
        open_assigned=open_assigned,
        pending_recent=pending_recent,
        pending_stale=pending_stale,
        resolved_count=resolved_count,
        sla_breaches_now=sla_breaches_now,
        sla_wait_minutes=sla_minutes,
        avg_wait_seconds=_avg(wait_period),
        avg_resolution_seconds=_avg(resolution_period),
    )

    csat_query = select(CsatResponse.rating).join(Conversation, CsatResponse.conversation_id == Conversation.id).where(CsatResponse.created_at.between(cutoff, period_end))
    csat_sent_query = select(func.count(Conversation.id)).where(Conversation.csat_sent_at.between(cutoff, period_end))
    if account_ids:
        csat_query = csat_query.where(Conversation.account_id.in_(account_ids))
        csat_sent_query = csat_sent_query.where(Conversation.account_id.in_(account_ids))
    csat_ratings = db.execute(csat_query).scalars().all()
    csat_sent_count = db.execute(csat_sent_query).scalar() or 0
    csat = CsatSnapshot(
        avg_rating=round(sum(csat_ratings) / len(csat_ratings), 2) if csat_ratings else None,
        response_count=len(csat_ratings),
        response_rate=round(len(csat_ratings) / csat_sent_count, 3) if csat_sent_count else None,
    )

    # Tarefas internas não são ligadas a conta/número WhatsApp (chat interno
    # é da empresa toda) — account_ids não se aplica aqui. pending/overdue são
    # foto de agora; completed_count é do período.
    tasks_pending = db.execute(
        select(func.count(InternalTask.id)).where(InternalTask.status == "pending")
    ).scalar() or 0
    tasks_overdue = db.execute(
        select(func.count(InternalTask.id)).where(
            InternalTask.status != "done", InternalTask.due_at.isnot(None), InternalTask.due_at < datetime.utcnow(),
        )
    ).scalar() or 0
    tasks_completed_count = db.execute(
        select(func.count(InternalTask.id)).where(
            InternalTask.status == "done", InternalTask.completed_at.between(cutoff, period_end),
        )
    ).scalar() or 0
    tasks = TasksSnapshot(pending=tasks_pending, overdue=tasks_overdue, completed_count=tasks_completed_count)

    return SystemStats(
        period_days=(period_end.date() - cutoff.date()).days + 1,
        start_date=cutoff.date().isoformat(),
        end_date=period_end.date().isoformat(),
        account_ids=account_ids or [],
        total_users=total_users,
        active_users=active_users,
        total_accounts=total_accounts,
        total_messages_today=total_messages_today,
        total_messages_month=total_messages_month,
        providers_usage=providers_usage,
        tiers_distribution=tiers_distribution,
        attendance=attendance,
        csat=csat,
        tasks=tasks,
    )


@router_admin.get("/dashboard/trends", response_model=DashboardTrends)
async def get_dashboard_trends(
    days: int = 14,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    account_ids: Optional[List[int]] = Query(None),
    admin_user = Depends(require_admin_permission('admin_dashboard')),
    db: Session = Depends(get_db),
):
    """Análises complementares ao snapshot de /dashboard/stats: tendência de
    volume, horário de pico, fila atual (mais antigas esperando), carga por
    atendente agora, bot x humano, motivos (tags) mais comuns, tendência
    diária de CSAT e volume por conta/número — as análises mais recorrentes
    num dashboard de operação de atendimento. Mesmo filtro de período/contas
    de /dashboard/stats (ver _resolve_period/_client_conv_filters)."""
    now = datetime.utcnow()
    cutoff, period_end = _resolve_period(days, start_date, end_date)
    client_conv_filter = _client_conv_filters(account_ids)
    attendant_ids = _attendant_user_ids(db)
    span_days = (period_end.date() - cutoff.date()).days + 1

    # Volume diário — criadas x resolvidas por dia. Calculado em Python (o
    # período é curto o bastante pra não pesar) pra não depender de função de
    # data específica de dialeto SQL.
    convs = db.execute(
        select(Conversation.created_at, Conversation.resolved_at)
        .join(Contact, Conversation.contact_id == Contact.id)
        .where(*client_conv_filter, or_(Conversation.created_at.between(cutoff, period_end), Conversation.resolved_at.between(cutoff, period_end)))
    ).all()
    day_buckets = {(cutoff.date() + timedelta(days=i)): {"created": 0, "resolved": 0} for i in range(span_days)}
    for row in convs:
        d = row.created_at.date()
        if d in day_buckets:
            day_buckets[d]["created"] += 1
        if row.resolved_at:
            d2 = row.resolved_at.date()
            if d2 in day_buckets:
                day_buckets[d2]["resolved"] += 1
    daily_volume = [
        DailyVolumePoint(date=d.isoformat(), created=v["created"], resolved=v["resolved"])
        for d, v in sorted(day_buckets.items())
    ]

    # Volume por hora do dia — mensagens recebidas do cliente no período —
    # indica horário de pico pra dimensionar escala. Message.timestamp é
    # epoch em milissegundos (ver _to_epoch_ms).
    # Join explícito (não .has()) — Contact.is_internal só correlaciona certo
    # com o contato DESSA conversa via join de verdade; um .has() com
    # condição em Contact vira produto cartesiano (SAWarning), aceitando
    # praticamente qualquer conversa por causa de outro contato qualquer.
    inbound_timestamps = db.execute(
        select(Message.timestamp)
        .join(Conversation, Message.conversation_id == Conversation.id)
        .join(Contact, Conversation.contact_id == Contact.id)
        .where(
            Message.direction == Direction.INBOUND,
            Message.timestamp.between(_to_epoch_ms(cutoff), _to_epoch_ms(period_end)),
            *client_conv_filter,
        )
    ).scalars().all()
    hour_counts = [0] * 24
    for ts_ms in inbound_timestamps:
        hour_counts[datetime.utcfromtimestamp(ts_ms / 1000).hour] += 1
    hourly_volume = [HourlyVolumePoint(hour=h, count=c) for h, c in enumerate(hour_counts)]

    # Fila agora — as 10 conversas abertas sem atendente esperando há mais
    # tempo. Sempre uma FOTO DE AGORA, independente do período selecionado.
    # attendance_enabled_since: mesmo reset de relógio usado em sla_breaches_
    # now/pending_recent-stale (ver get_system_stats) — conta que virou
    # atendimento agora não mostra conversa velha como se estivesse esperando
    # há semanas.
    waiting_rows = db.execute(
        select(Conversation.id, Conversation.created_at, Contact.name, Contact.wa_id,
               WhatsAppAccount.account_name, WhatsAppAccount.attendance_enabled_since)
        .join(Contact, Conversation.contact_id == Contact.id)
        .join(WhatsAppAccount, Conversation.account_id == WhatsAppAccount.id)
        .where(*client_conv_filter, Conversation.status == "open", Conversation.assigned_to_user_id.is_(None))
        .order_by(Conversation.created_at.asc())
        .limit(10)
    ).all()
    oldest_waiting = [
        OldestWaitingItem(
            conversation_id=r.id, contact_name=r.name or r.wa_id, account_name=r.account_name,
            wait_seconds=int((now - max(r.created_at, r.attendance_enabled_since or r.created_at)).total_seconds()),
        ) for r in waiting_rows
    ]

    # Carga por atendente agora — quantas conversas abertas cada um segura
    # neste momento (também foto de agora, não do período). Só atendente de
    # verdade (ver _attendant_user_ids) — mesma regra de open_assigned em
    # get_system_stats.
    workload_rows = db.execute(
        select(Conversation.assigned_to_user_id, func.count(Conversation.id))
        .join(Contact, Conversation.contact_id == Contact.id)
        .where(*client_conv_filter, Conversation.status == "open", Conversation.assigned_to_user_id.in_(attendant_ids))
        .group_by(Conversation.assigned_to_user_id)
    ).all()
    user_ids = [uid for uid, _ in workload_rows]
    users_by_id = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    agent_workload = sorted([
        AgentWorkloadItem(
            user_id=uid,
            full_name=(users_by_id[uid].full_name or users_by_id[uid].email) if uid in users_by_id else "Desconhecido",
            open_count=count,
        ) for uid, count in workload_rows
    ], key=lambda a: -a.open_count)

    # Bot x humano — das resolvidas no período, quantas foram respondidas por
    # um humano alguma vez. IMPORTANTE: não dá pra usar Conversation.
    # bot_handoff_at aqui — é zerado de propósito toda vez que a conversa é
    # marcada Resolvida (pra religar o bot numa eventual reabertura, ver
    # update_conversation_status em routes_attendance.py), então na hora de
    # ler pra esse relatório já está SEMPRE None (bug real: chegou a mostrar
    # "41 só bot" quando na prática é quase tudo humano). assigned_to_user_id
    # também não serve — fica None sempre que ninguém formalmente "assume" a
    # conversa antes de responder, mesmo tendo sido um humano quem respondeu
    # (medido: só 12% das resolvidas tinham responsável atribuído). O único
    # campo que sobrevive à resolução e reflete de verdade "um humano
    # respondeu aqui" é ever_handled_by_human — setado uma vez, pra sempre,
    # na primeira mensagem de um atendente (ver handle_agent_outbound_reply).
    # Só fica preciso pra conversas resolvidas DEPOIS do deploy dessa coluna —
    # histórico anterior fica com o valor default (False).
    resolved_human_rows = db.execute(
        select(Conversation.ever_handled_by_human)
        .join(Contact, Conversation.contact_id == Contact.id)
        .where(*client_conv_filter, Conversation.resolved_at.between(cutoff, period_end))
    ).all()
    bot_only_count = sum(1 for (handled,) in resolved_human_rows if not handled)
    with_human_count = sum(1 for (handled,) in resolved_human_rows if handled)

    # Principais motivos — tags mais usadas nas conversas criadas no período.
    tag_rows = db.execute(
        select(Tag.name, Tag.color, func.count(conversation_tags.c.conversation_id))
        .select_from(conversation_tags)
        .join(Tag, Tag.id == conversation_tags.c.tag_id)
        .join(Conversation, Conversation.id == conversation_tags.c.conversation_id)
        .join(Contact, Conversation.contact_id == Contact.id)
        .where(*client_conv_filter, Conversation.created_at.between(cutoff, period_end))
        .group_by(Tag.id)
        .order_by(func.count(conversation_tags.c.conversation_id).desc())
        .limit(10)
    ).all()
    top_tags = [TagCount(name=n, color=c or "#8696A0", count=cnt) for n, c, cnt in tag_rows]

    # CSAT — nota média por dia, mesma janela do volume diário.
    csat_daily_query = select(CsatResponse.created_at, CsatResponse.rating).join(
        Conversation, CsatResponse.conversation_id == Conversation.id
    ).where(CsatResponse.created_at.between(cutoff, period_end))
    if account_ids:
        csat_daily_query = csat_daily_query.where(Conversation.account_id.in_(account_ids))
    csat_day_buckets = {d: [] for d in day_buckets.keys()}
    for created_at, rating in db.execute(csat_daily_query).all():
        d = created_at.date()
        if d in csat_day_buckets:
            csat_day_buckets[d].append(rating)
    csat_daily = [
        CsatDailyPoint(date=d.isoformat(), avg_rating=round(sum(v) / len(v), 2) if v else None, count=len(v))
        for d, v in sorted(csat_day_buckets.items())
    ]

    # Volume por conta/número — respeita account_ids (mostra só as
    # selecionadas) pra comparar entre 2+ números escolhidos; sem filtro,
    # mostra todas.
    acc_filters = [*_client_conv_filters(), Conversation.created_at.between(cutoff, period_end)]
    if account_ids:
        acc_filters.append(WhatsAppAccount.id.in_(account_ids))
    acc_rows = db.execute(
        select(WhatsAppAccount.id, WhatsAppAccount.account_name, WhatsAppAccount.phone_number, func.count(Conversation.id))
        .join(Conversation, Conversation.account_id == WhatsAppAccount.id)
        .join(Contact, Conversation.contact_id == Contact.id)
        .where(*acc_filters)
        .group_by(WhatsAppAccount.id)
        .order_by(func.count(Conversation.id).desc())
    ).all()
    volume_by_account = [
        AccountVolumeItem(account_id=aid, account_name=name, phone_number=phone, count=cnt)
        for aid, name, phone, cnt in acc_rows
    ]

    return DashboardTrends(
        period_days=span_days,
        start_date=cutoff.date().isoformat(),
        end_date=period_end.date().isoformat(),
        account_ids=account_ids or [],
        daily_volume=daily_volume,
        hourly_volume=hourly_volume,
        oldest_waiting=oldest_waiting,
        agent_workload=agent_workload,
        bot_only_count=bot_only_count,
        with_human_count=with_human_count,
        top_tags=top_tags,
        csat_daily=csat_daily,
        volume_by_account=volume_by_account,
    )

# USER MANAGEMENT

@router_admin.get("/users", response_model=List[UserAdminResponse])
async def list_all_users(
    skip: int = 0,
    limit: int = 50,
    search: Optional[str] = None,
    is_active: Optional[bool] = None,
    admin_user = Depends(require_admin_permission('settings_users')),
    db: Session = Depends(get_db)
):
    stmt = select(User)
    if search:
        stmt = stmt.where(
            or_(User.email.ilike(f"%{search}%"), User.full_name.ilike(f"%{search}%"))
        )
    if is_active is not None:
        stmt = stmt.where(User.is_active == is_active)
    stmt = stmt.offset(skip).limit(limit)

    users = db.execute(stmt).scalars().all()
    result = []
    for user in users:
        total_accounts = db.execute(
            select(func.count(WhatsAppAccount.id)).where(WhatsAppAccount.user_id == user.id)
        ).scalar() or 0
        total_messages = db.execute(
            select(func.count(Message.id))
            .join(Conversation, Message.conversation_id == Conversation.id)
            .join(WhatsAppAccount, Conversation.account_id == WhatsAppAccount.id)
            .where(WhatsAppAccount.user_id == user.id, Message.direction == 'outbound')
        ).scalar() or 0
        result.append(UserAdminResponse(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            is_active=user.is_active,
            is_admin=getattr(user, 'is_admin', False),
            role=user.role,
            sector=user.sector or "",
            account_ids=[a.id for a in user.granted_accounts],
            created_at=user.created_at,
            total_accounts=total_accounts,
            total_messages_sent=total_messages,
            last_activity=user.updated_at
        ))
    return result


def _validate_role_key(db: Session, role_key: Optional[str]) -> None:
    """Barra atribuir um papel que não existe na tabela roles — sem isso, um
    typo no campo criava um User.role sem Role correspondente, que
    require_permission() trata como fail-closed (nega tudo) silenciosamente."""
    if not role_key:
        return
    if not db.execute(select(Role).where(Role.key == role_key)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"Papel '{role_key}' não existe. Crie-o antes em Papéis.")

@router_admin.post("/users", response_model=UserAdminResponse)
async def create_user_admin(
    user_data: UserCreateAdmin,
    admin_user = Depends(require_admin_permission('settings_users')),
    db: Session = Depends(get_db)
):
    stmt = select(User).where(User.email == user_data.email)
    if db.execute(stmt).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email já cadastrado")

    _validate_role_key(db, user_data.role)

    if user_data.is_admin and not getattr(admin_user, 'is_admin', False):
        raise HTTPException(status_code=403, detail="Só um administrador pode conceder acesso de administrador.")

    password_hash = auth_service.hash_password(user_data.password)
    new_user = User(
        email=user_data.email,
        password_hash=password_hash,
        full_name=user_data.full_name,
        is_admin=user_data.is_admin,
        role=user_data.role or "attendant",
        sector=user_data.sector or "",
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    if user_data.account_ids is not None:
        new_user.granted_accounts = db.execute(
            select(WhatsAppAccount).where(WhatsAppAccount.id.in_(user_data.account_ids))
        ).scalars().all()
        db.commit()

    return UserAdminResponse(
        id=new_user.id,
        email=new_user.email,
        full_name=new_user.full_name,
        is_active=new_user.is_active,
        is_admin=getattr(new_user, 'is_admin', False),
        role=new_user.role,
        sector=new_user.sector or "",
        account_ids=[a.id for a in new_user.granted_accounts],
        created_at=new_user.created_at,
        total_accounts=0,
        total_messages_sent=0,
        last_activity=None
    )

@router_admin.patch("/users/{user_id}", response_model=UserAdminResponse)
async def update_user_admin(
    user_id: int,
    user_data: UserUpdateAdmin,
    admin_user = Depends(require_admin_permission('settings_users')),
    db: Session = Depends(get_db)
):
    stmt = select(User).where(User.id == user_id)
    user = db.execute(stmt).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    if user_data.role is not None: _validate_role_key(db, user_data.role)

    if user_data.is_admin is not None and not getattr(admin_user, 'is_admin', False):
        # Quem chegou aqui via permissão settings_users (não é is_admin de
        # verdade) não pode conceder nem revogar acesso de administrador —
        # evita auto-escalonamento por um papel não-admin.
        raise HTTPException(status_code=403, detail="Só um administrador pode alterar o acesso de administrador de um usuário.")

    if user_data.email:      user.email = user_data.email
    if user_data.full_name is not None: user.full_name = user_data.full_name
    if user_data.is_active is not None: user.is_active = user_data.is_active
    if user_data.is_admin is not None:  user.is_admin  = user_data.is_admin
    if user_data.role is not None:      user.role      = user_data.role
    if user_data.sector is not None:    user.sector    = user_data.sector
    if user_data.password:   user.password_hash = auth_service.hash_password(user_data.password)

    if user_data.account_ids is not None:
        user.granted_accounts = db.execute(
            select(WhatsAppAccount).where(WhatsAppAccount.id.in_(user_data.account_ids))
        ).scalars().all()

    db.commit()
    db.refresh(user)
    return UserAdminResponse(
        id=user.id, email=user.email, full_name=user.full_name,
        is_active=user.is_active, is_admin=getattr(user, 'is_admin', False),
        role=user.role, sector=user.sector or "",
        account_ids=[a.id for a in user.granted_accounts],
        created_at=user.created_at, total_accounts=0, total_messages_sent=0,
        last_activity=user.updated_at
    )

@router_admin.delete("/users/{user_id}")
async def delete_user_admin(
    user_id: int,
    admin_user = Depends(require_admin_permission('settings_users')),
    db: Session = Depends(get_db)
):
    stmt = select(User).where(User.id == user_id)
    user = db.execute(stmt).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")
    if user.id == admin_user.id:
        raise HTTPException(status_code=400, detail="Não pode deletar sua própria conta")
    db.delete(user)
    db.commit()
    return {"message": f"Usuário {user.email} deletado com sucesso"}

# ACCOUNT MANAGEMENT

@router_admin.get("/accounts", response_model=List[AccountAdminResponse])
async def list_all_accounts(
    skip: int = 0,
    limit: int = 50,
    provider_type: Optional[ProviderType] = None,
    is_active: Optional[bool] = None,
    admin_user = Depends(require_admin_permission('admin_accounts')),
    db: Session = Depends(get_db)
):
    stmt = (
        select(WhatsAppAccount)
        .join(User, WhatsAppAccount.user_id == User.id)
        .where(WhatsAppAccount.deleted_at.is_(None))
    )
    if provider_type:
        stmt = stmt.where(WhatsAppAccount.provider_type == provider_type)
    if is_active is not None:
        stmt = stmt.where(WhatsAppAccount.is_active == is_active)
    stmt = stmt.offset(skip).limit(limit)
    accounts = db.execute(stmt).scalars().all()

    result = []
    for account in accounts:
        user = db.execute(select(User).where(User.id == account.user_id)).scalar_one()
        total_messages = db.execute(
            select(func.count(Message.id))
            .join(Conversation, Message.conversation_id == Conversation.id)
            .where(Conversation.account_id == account.id)
        ).scalar() or 0
        total_conversations = db.execute(
            select(func.count(Conversation.id)).where(Conversation.account_id == account.id)
        ).scalar() or 0
        result.append(AccountAdminResponse(
            id=account.id, user_id=account.user_id, user_email=user.email,
            account_name=account.account_name, phone_number=account.phone_number,
            provider_type=account.provider_type, provider_tier=account.provider_tier,
            is_active=account.is_active, is_authenticated=account.is_authenticated,
            authentication_status=account.authentication_status, created_at=account.created_at,
            total_messages=total_messages, total_conversations=total_conversations
        ))
    return result

@router_admin.patch("/accounts/{account_id}", response_model=AccountAdminResponse)
async def update_account_admin(
    account_id: int,
    account_data: AccountUpdateAdmin,
    admin_user = Depends(require_admin_permission('admin_accounts')),
    db: Session = Depends(get_db)
):
    stmt = select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)
    account = db.execute(stmt).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Conta não encontrada")

    if account_data.account_name: account.account_name = account_data.account_name
    if account_data.is_active is not None: account.is_active = account_data.is_active
    if account_data.daily_message_limit: account.daily_message_limit = account_data.daily_message_limit
    if account_data.monthly_message_limit: account.monthly_message_limit = account_data.monthly_message_limit

    if account_data.provider_type and account_data.provider_type != account.provider_type:
        db.add(ProviderChange(
            account_id=account_id,
            old_provider_type=account.provider_type,
            new_provider_type=account_data.provider_type,
            changed_by=admin_user.id,
            migration_data={"admin_change": True}
        ))
        account.provider_type = account_data.provider_type
        account.provider_tier = account_service.get_provider_tier(account_data.provider_type)

    db.commit()
    db.refresh(account)
    return AccountAdminResponse(
        id=account.id, user_id=account.user_id, user_email="",
        account_name=account.account_name, phone_number=account.phone_number,
        provider_type=account.provider_type, provider_tier=account.provider_tier,
        is_active=account.is_active, is_authenticated=account.is_authenticated,
        authentication_status=account.authentication_status, created_at=account.created_at,
        total_messages=0, total_conversations=0
    )

@router_admin.delete("/accounts/{account_id}")
async def delete_account_admin(
    account_id: int,
    admin_user = Depends(require_admin_permission('admin_accounts')),
    db: Session = Depends(get_db)
):
    """
    Soft-delete — só admin (get_admin_user). BUG anterior: db.delete(account)
    apagava a linha de verdade; conversations.account_id tem ON DELETE SET
    NULL, então as conversas/mensagens sobreviviam mas ficavam órfãs (sem
    conta associada, some de qualquer filtro por conta) — e broadcast_lists/
    broadcast_sends/coexistence_sync_state/pending_changes/provider_changes
    (ON DELETE CASCADE) eram apagados de verdade. "Excluir" aqui só revoga
    acesso: desloga a sessão (se unofficial), marca is_active=False e
    deleted_at=agora — a conta some da lista pra todo mundo (get_accounts em
    routes_settings.py filtra deleted_at IS NULL) mas a linha, as conversas e
    as mensagens continuam intactas, com o vínculo à conta preservado.
    """
    from datetime import datetime as _dt

    stmt = select(WhatsAppAccount).where(WhatsAppAccount.id == account_id)
    account = db.execute(stmt).scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Conta não encontrada")
    if account.deleted_at:
        raise HTTPException(status_code=400, detail="Conta já foi excluída")

    # Melhor esforço: desloga a sessão de verdade (não trava a exclusão se falhar).
    try:
        from backend.providers.factory import get_unofficial_provider, normalize_provider_type, UNOFFICIAL_PROVIDER_TYPES
        provider_str = normalize_provider_type(account.provider_type)
        if provider_str in UNOFFICIAL_PROVIDER_TYPES:
            import json as _json
            raw = account.provider_config or {}
            if isinstance(raw, str):
                try:
                    raw = _json.loads(raw)
                except (ValueError, TypeError):
                    raw = {}
            config = dict(raw)
            config.setdefault("session_id", account.session_id or "default")
            provider = get_unofficial_provider(provider_str, config)
            await provider.logout_session()
    except Exception as exc:
        logger.warning("[Admin:DELETE /accounts/%s] Falha ao deslogar sessão (segue com a exclusão): %s", account_id, exc)

    account.deleted_at = _dt.utcnow()
    account.is_active = False
    account.is_authenticated = False
    db.commit()
    return {"message": f"Conta {account.account_name} excluída — acesso revogado, mensagens e conversas preservadas"}

# SYSTEM CONFIGURATION
# GET/PATCH /api/admin/config são implementados em routes_templates.py
# (config_router), que persiste de fato no banco — os stubs que existiam
# aqui nunca liam/gravavam nada e ficavam sombreados pela ordem de
# inclusão dos routers em app.py.

# PROVIDER MANAGEMENT

@router_admin.get("/providers/available")
async def get_available_providers(admin_user = Depends(require_admin_permission('admin_accounts'))):
    return provider_manager.get_all_providers_info()

@router_admin.post("/providers/{provider_type}/enable")
async def enable_provider(provider_type: ProviderType, admin_user = Depends(require_admin_permission('admin_accounts'))):
    return {"message": f"Provider {provider_type} habilitado"}

@router_admin.post("/providers/{provider_type}/disable")
async def disable_provider(provider_type: ProviderType, admin_user = Depends(require_admin_permission('admin_accounts'))):
    return {"message": f"Provider {provider_type} desabilitado"}

# ANALYTICS & REPORTS

@router_admin.get("/analytics/usage")
async def get_usage_analytics(
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    admin_user = Depends(require_admin_permission('admin_dashboard')),
    db: Session = Depends(get_db)
):
    if not start_date:
        start_date = datetime.utcnow() - timedelta(days=30)
    if not end_date:
        end_date = datetime.utcnow()

    messages_per_day = db.execute(
        select(
            func.date(Message.timestamp).label('date'),
            func.count(Message.id).label('count')
        )
        .where(and_(Message.timestamp >= start_date, Message.timestamp <= end_date))
        .group_by(func.date(Message.timestamp))
        .order_by(func.date(Message.timestamp))
    ).all()

    return {
        "period": {"start": start_date, "end": end_date},
        "messages_per_day": [{"date": str(row.date), "count": row.count} for row in messages_per_day]
    }

@router_admin.get("/analytics/providers")
async def get_provider_analytics(
    admin_user = Depends(require_admin_permission('admin_dashboard')),
    db: Session = Depends(get_db)
):
    provider_stats = {}
    for provider_type in ProviderType:
        total_accounts = db.execute(
            select(func.count(WhatsAppAccount.id)).where(
                WhatsAppAccount.provider_type == provider_type.value
            )
        ).scalar() or 0
        active_accounts = db.execute(
            select(func.count(WhatsAppAccount.id)).where(
                WhatsAppAccount.provider_type == provider_type.value,
                WhatsAppAccount.is_active == True,
                WhatsAppAccount.is_authenticated == True
            )
        ).scalar() or 0
        total_messages = db.execute(
            select(func.count(Message.id))
            .join(Conversation, Message.conversation_id == Conversation.id)
            .join(WhatsAppAccount, Conversation.account_id == WhatsAppAccount.id)
            .where(WhatsAppAccount.provider_type == provider_type.value)
        ).scalar() or 0
        provider_stats[provider_type.value] = {
            "total_accounts": total_accounts,
            "active_accounts": active_accounts,
            "total_messages": total_messages,
            "active_rate": (active_accounts / total_accounts * 100) if total_accounts > 0 else 0
        }
    return provider_stats

# PAPÉIS E PERMISSÕES (Role)
# Substitui a matriz cosmética que vivia em data/settings.json
# (routes_settings.py /permissions — nunca era checada por nada, legado).

@router_admin.get("/roles", response_model=List[RoleResponse])
async def list_roles(
    admin_user = Depends(require_admin_permission('admin_roles')),
    db: Session = Depends(get_db)
):
    return db.execute(select(Role).order_by(Role.id)).scalars().all()

@router_admin.post("/roles", response_model=RoleResponse)
async def create_role(
    role_data: RoleCreate,
    admin_user = Depends(require_admin_permission('admin_roles')),
    db: Session = Depends(get_db)
):
    if db.execute(select(Role).where(Role.key == role_data.key)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"Já existe um papel com a chave '{role_data.key}'")

    new_role = Role(
        key=role_data.key,
        label=role_data.label,
        color=role_data.color,
        permissions=role_data.permissions,
        is_builtin=False,
    )
    db.add(new_role)
    db.commit()
    db.refresh(new_role)
    return new_role

@router_admin.patch("/roles/{role_id}", response_model=RoleResponse)
async def update_role(
    role_id: int,
    role_data: RoleUpdate,
    admin_user = Depends(require_admin_permission('admin_roles')),
    db: Session = Depends(get_db)
):
    role = db.execute(select(Role).where(Role.id == role_id)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Papel não encontrado")

    if role.key == "admin" and not getattr(admin_user, 'is_admin', False):
        # Quem chegou aqui via permissão admin_roles (não é is_admin de
        # verdade) não pode editar o papel "admin" — evita que esse papel
        # perca permissões por engano ou seja usado pra auto-escalonamento.
        raise HTTPException(status_code=403, detail="Só um administrador pode editar o papel 'admin'.")

    if role_data.label is not None:
        role.label = role_data.label
    if role_data.color is not None:
        role.color = role_data.color
    if role_data.permissions is not None:
        role.permissions = role_data.permissions

    db.commit()
    db.refresh(role)
    return role

@router_admin.delete("/roles/{role_id}")
async def delete_role(
    role_id: int,
    admin_user = Depends(require_admin_permission('admin_roles')),
    db: Session = Depends(get_db)
):
    role = db.execute(select(Role).where(Role.id == role_id)).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Papel não encontrado")
    if role.is_builtin:
        raise HTTPException(status_code=400, detail="Papéis padrão (admin/supervisor/attendant) não podem ser apagados")

    users_with_role = db.execute(
        select(func.count(User.id)).where(User.role == role.key)
    ).scalar() or 0
    if users_with_role > 0:
        raise HTTPException(
            status_code=400,
            detail=f"{users_with_role} usuário(s) ainda usam este papel — reatribua-os antes de apagar"
        )

    db.delete(role)
    db.commit()
    return {"message": f"Papel '{role.label}' apagado com sucesso"}

# FILA DE APROVAÇÃO (PendingChange)
# Dispatch de change_type -> método do provider Baileys, executado só na aprovação.
_PENDING_CHANGE_DISPATCH = {
    "profile_picture_update": lambda provider, payload: provider.update_profile_picture(payload["image_b64"]),
    "profile_picture_remove": lambda provider, payload: provider.remove_profile_picture(),
    "profile_status":         lambda provider, payload: provider.update_status(payload["status"]),
    "profile_name":           lambda provider, payload: provider.update_profile_name(payload["name"]),
}

@router_admin.get("/pending-changes", response_model=List[PendingChangeResponse])
async def list_pending_changes(
    status_filter: Optional[str] = "pending",
    admin_user = Depends(require_admin_permission('admin_approvals')),
    db: Session = Depends(get_db)
):
    stmt = select(PendingChange).order_by(PendingChange.created_at.desc())
    if status_filter:
        stmt = stmt.where(PendingChange.status == status_filter)
    changes = db.execute(stmt).scalars().all()

    result = []
    for pc in changes:
        requester = db.get(User, pc.requested_by)
        result.append(PendingChangeResponse(
            id=pc.id, account_id=pc.account_id, requested_by=pc.requested_by,
            requested_by_email=requester.email if requester else "desconhecido",
            change_type=pc.change_type, payload=pc.payload, status=pc.status,
            reviewed_by=pc.reviewed_by, reviewed_at=pc.reviewed_at, created_at=pc.created_at,
        ))
    return result

@router_admin.post("/pending-changes/{change_id}/approve")
async def approve_pending_change(
    change_id: int,
    admin_user = Depends(require_admin_permission('admin_approvals')),
    db: Session = Depends(get_db)
):
    pc = db.execute(select(PendingChange).where(PendingChange.id == change_id)).scalar_one_or_none()
    if not pc:
        raise HTTPException(status_code=404, detail="Solicitação não encontrada")
    if pc.status != "pending":
        raise HTTPException(status_code=400, detail=f"Solicitação já foi {pc.status}")

    dispatch = _PENDING_CHANGE_DISPATCH.get(pc.change_type)
    if not dispatch:
        raise HTTPException(status_code=400, detail=f"Tipo de mudança desconhecido: {pc.change_type}")

    from backend.api.routes import get_provider
    provider, provider_type = get_provider(db, pc.account_id)
    if provider_type != "baileys":
        raise HTTPException(status_code=400, detail="Conta não é mais Baileys — não é possível aplicar esta mudança")

    try:
        await dispatch(provider, pc.payload)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao aplicar a mudança: {exc}")

    pc.status = "approved"
    pc.reviewed_by = admin_user.id
    pc.reviewed_at = datetime.utcnow()
    db.commit()
    return {"message": "Mudança aprovada e aplicada com sucesso"}

@router_admin.post("/pending-changes/{change_id}/reject")
async def reject_pending_change(
    change_id: int,
    payload: PendingChangeReject,
    admin_user = Depends(require_admin_permission('admin_approvals')),
    db: Session = Depends(get_db)
):
    pc = db.execute(select(PendingChange).where(PendingChange.id == change_id)).scalar_one_or_none()
    if not pc:
        raise HTTPException(status_code=404, detail="Solicitação não encontrada")
    if pc.status != "pending":
        raise HTTPException(status_code=400, detail=f"Solicitação já foi {pc.status}")

    pc.status = "rejected"
    pc.reviewed_by = admin_user.id
    pc.reviewed_at = datetime.utcnow()
    db.commit()
    return {"message": "Solicitação rejeitada"}
