"""
Chat interno — comunicação entre usuários da equipe, sem ligação nenhuma com
conversas de cliente/WhatsApp (diferente das notas internas presas a uma
Conversation específica, ver routes_attendance.py). 1:1 (DM) ou grupo, com
paridade de recursos do WhatsApp Web: mídia, responder/encaminhar/editar/
apagar/reagir/favoritar, confirmação de leitura, digitando, admin de grupo.

Registrar em app.py:
    from backend.api.routes_internal_chat import router_internal_chat
    app.include_router(router_internal_chat, prefix="/api/internal-chats", tags=["Chat Interno"])
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

import aiofiles
from dateutil.relativedelta import relativedelta
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select, func, or_
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.database.models import (
    InternalConversation, InternalConversationParticipant, InternalMessage,
    InternalMessageReaction, InternalTask, InternalTaskSubtask, InternalTaskAttachment,
    InternalTaskHistory, User, Conversation,
)
from backend.api.routes_auth import get_current_user
from backend.api.permissions import user_has_permission
from backend.api.websocket import ws_manager
from backend.models.schemas import APIResponse
from backend.utils.media_converter import normalize_media
from backend.utils.time_utils import to_utc_iso
from backend.utils.display_name import format_display_name

logger = logging.getLogger(__name__)

router_internal_chat = APIRouter()

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

VALID_MEDIA_TYPES = {"image", "video", "audio", "document", "sticker"}


def _require_participant(db: Session, conversation_id: int, user_id: int) -> InternalConversation:
    conv = db.query(InternalConversation).filter(InternalConversation.id == conversation_id).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")
    is_participant = db.query(InternalConversationParticipant).filter(
        InternalConversationParticipant.conversation_id == conversation_id,
        InternalConversationParticipant.user_id == user_id,
    ).first()
    if not is_participant:
        raise HTTPException(status_code=403, detail="Você não participa desta conversa")
    return conv


def _my_participant_row(conv: InternalConversation, user_id: int) -> Optional[InternalConversationParticipant]:
    return next((p for p in conv.participant_rows if p.user_id == user_id), None)


def _conversation_display_name(conv: InternalConversation, viewer_id: int) -> str:
    if conv.is_group:
        return conv.name or "Grupo"
    other = next((p.user for p in conv.participant_rows if p.user_id != viewer_id), None)
    # Sem "outro" participante = DM consigo mesmo (único participante é o
    # próprio viewer) — mesma ideia do "Mensagens para você mesmo" do
    # WhatsApp real.
    return (other.full_name or other.email) if other else "Você"


def _conversation_brief(db: Session, conv: InternalConversation, viewer_id: int) -> dict:
    last_msg = db.query(InternalMessage).filter(
        InternalMessage.conversation_id == conv.id
    ).order_by(InternalMessage.created_at.desc()).first()

    my_row = _my_participant_row(conv, viewer_id)
    unread_count = 0
    if my_row:
        unread_q = db.query(func.count(InternalMessage.id)).filter(
            InternalMessage.conversation_id == conv.id,
            InternalMessage.sender_id != viewer_id,
        )
        if my_row.last_read_at:
            unread_q = unread_q.filter(InternalMessage.created_at > my_row.last_read_at)
        unread_count = unread_q.scalar() or 0

    # open_tasks_count: ícone FIXO na sidebar (some só quando a tarefa é
    # concluída, independente de já ter sido vista). unread_tasks_count:
    # notificação vermelha (badge no rail/faixa/sidebar) — tarefa aberta
    # criada depois da última vez que esse usuário expandiu a faixa dessa
    # conversa (last_tasks_viewed_at, mesma ideia de last_read_at acima, só
    # que pra tarefa em vez de mensagem).
    open_tasks_q = db.query(func.count(InternalTask.id)).filter(
        InternalTask.conversation_id == conv.id, InternalTask.status == "pending",
    )
    open_tasks_count = open_tasks_q.scalar() or 0
    unread_tasks_count = 0
    if open_tasks_count:
        unread_q2 = open_tasks_q
        if my_row and my_row.last_tasks_viewed_at:
            unread_q2 = unread_q2.filter(InternalTask.created_at > my_row.last_tasks_viewed_at)
        unread_tasks_count = unread_q2.scalar() or 0

    return {
        "id": conv.id,
        "is_group": conv.is_group,
        "is_pinned": bool(conv.is_pinned),
        # Diferente de is_pinned (global): favoritar/silenciar são por
        # participante — ver InternalConversationParticipant.is_favorite/
        # is_muted. my_row é None só se o chamador não participar mais
        # (não deveria acontecer aqui, mas evita AttributeError).
        "is_favorite": bool(my_row.is_favorite) if my_row else False,
        "is_muted": bool(my_row.is_muted) if my_row else False,
        "name": _conversation_display_name(conv, viewer_id),
        # Grupo: foto do próprio grupo (InternalConversation.photo_url). DM:
        # não tem "foto da conversa" própria — usa a foto de perfil da OUTRA
        # pessoa (a que faz sentido pra cada lado, cada participante vê a do
        # outro), se ela tiver uma. DM consigo mesmo: só tem a própria foto.
        "photo_url": conv.photo_url if conv.is_group else (
            next((p.user.photo_url for p in conv.participant_rows if p.user_id != viewer_id and p.user.photo_url), None)
            or next((p.user.photo_url for p in conv.participant_rows if p.user_id == viewer_id and p.user.photo_url), None)
        ),
        "participants": [
            {
                "id": p.user_id, "full_name": p.user.full_name or p.user.email, "is_admin": p.is_admin,
                "email": p.user.email, "role": p.user.role, "sector": p.user.sector, "photo_url": p.user.photo_url,
            }
            for p in conv.participant_rows
        ],
        "my_is_admin": bool(my_row and my_row.is_admin),
        "last_message": {
            "text": last_msg.text if not last_msg.is_deleted else "Mensagem apagada",
            "message_type": last_msg.message_type,
            "sender_id": last_msg.sender_id,
            "created_at": to_utc_iso(last_msg.created_at),
        } if last_msg else None,
        "unread_count": unread_count,
        "open_tasks_count": open_tasks_count,
        "unread_tasks_count": unread_tasks_count,
        "created_at": to_utc_iso(conv.created_at),
    }


def _format_task(task: InternalTask) -> dict:
    return {
        "id": task.id,
        "conversation_id": task.conversation_id,
        # Presente = tarefa vinculada a uma conversa de CLIENTE (controle
        # exclusivo de quem criou, NUNCA vira mensagem/aviso pro cliente —
        # ver create_standalone_task). Os dois IDs acima nunca vêm
        # preenchidos juntos; nenhum dos dois preenchido = tarefa pessoal.
        "customer_conversation_id": task.customer_conversation_id,
        "title": task.title,
        "description": task.description,
        "due_at": to_utc_iso(task.due_at),
        "status": task.status,
        "priority": task.priority,
        "created_by": {"id": task.creator.id, "full_name": task.creator.full_name or task.creator.email} if task.creator else None,
        "assigned_to": {"id": task.assignee.id, "full_name": task.assignee.full_name or task.assignee.email} if task.assignee else None,
        "completed_by": {"id": task.completer.id, "full_name": task.completer.full_name or task.completer.email} if task.completer else None,
        "completed_at": to_utc_iso(task.completed_at),
        "description_edited": task.description_edited,
        "approved_by": {"id": task.approver.id, "full_name": task.approver.full_name or task.approver.email} if task.approver else None,
        "approved_at": to_utc_iso(task.approved_at),
        "paused_by": {"id": task.pauser.id, "full_name": task.pauser.full_name or task.pauser.email} if task.pauser else None,
        "paused_at": to_utc_iso(task.paused_at),
        "pause_reason": task.pause_reason,
        "pause_reminder_at": to_utc_iso(task.pause_reminder_at),
        "cancelled_by": {"id": task.canceller.id, "full_name": task.canceller.full_name or task.canceller.email} if task.canceller else None,
        "cancelled_at": to_utc_iso(task.cancelled_at),
        "cancel_reason": task.cancel_reason,
        "created_at": to_utc_iso(task.created_at),
        "recurrence_interval": task.recurrence_interval,
        "recurrence_every": task.recurrence_every,
        "recurrence_days_of_week": task.recurrence_days_of_week,
        "recurrence_parent_id": task.recurrence_parent_id,
        "history": [
            {
                "id": h.id, "event": h.event, "reason": h.reason, "created_at": to_utc_iso(h.created_at),
                "user": {"id": h.user.id, "full_name": h.user.full_name or h.user.email} if h.user else None,
            }
            for h in task.history
        ],
        "subtasks": [
            {"id": s.id, "title": s.title, "is_done": s.is_done, "position": s.position}
            for s in task.subtasks
        ],
        "attachments": [
            {
                "id": a.id, "file_url": a.file_url, "filename": a.filename, "mime_type": a.mime_type,
                "uploaded_by": {"id": a.uploader.id, "full_name": a.uploader.full_name or a.uploader.email} if a.uploader else None,
                "created_at": to_utc_iso(a.created_at),
            }
            for a in task.attachments
        ],
    }


def _format_internal_message(msg: InternalMessage, conv: InternalConversation, viewer_id: int) -> dict:
    reactions_by_emoji: dict = {}
    my_reaction = None
    for r in msg.reactions:
        reactions_by_emoji.setdefault(r.emoji, []).append(r.user_id)
        if r.user_id == viewer_id:
            my_reaction = r.emoji

    # "Lida" = todo mundo além de quem mandou já abriu a conversa depois do
    # created_at dessa mensagem (mesmo padrão do WhatsApp real pra grupo: o
    # tique azul só aparece quando TODOS leram, não individualmente por padrão).
    other_participants = [p for p in conv.participant_rows if p.user_id != msg.sender_id]
    read_by_all = bool(other_participants) and all(
        p.last_read_at and p.last_read_at >= msg.created_at for p in other_participants
    )

    reply_to = None
    if msg.reply_to_id and msg.reply_to:
        rt = msg.reply_to
        reply_to = {
            "id": rt.id,
            "text": "Mensagem apagada" if rt.is_deleted else (rt.text if rt.message_type == "text" else f"[{rt.message_type}]"),
            "sender_name": format_display_name(rt.sender.full_name, rt.sender.email, rt.sender.display_name_format) if rt.sender else "Desconhecido",
        }

    return {
        "id": msg.id,
        "conversation_id": msg.conversation_id,
        "text": "Mensagem apagada" if msg.is_deleted else msg.text,
        "message_type": msg.message_type,
        "media_url": None if msg.is_deleted else msg.media_url,
        "mime_type": msg.mime_type,
        "filename": msg.filename,
        "sender_id": msg.sender_id,
        "sender_name": format_display_name(msg.sender.full_name, msg.sender.email, msg.sender.display_name_format) if msg.sender else "Desconhecido",
        "sender_photo_url": msg.sender.photo_url if msg.sender else None,
        "is_mine": msg.sender_id == viewer_id,
        "is_edited": msg.is_edited,
        "is_deleted": msg.is_deleted,
        "is_starred": msg.is_starred,
        "is_pinned": msg.is_pinned,
        "reply_to": reply_to,
        "reactions": [{"emoji": e, "user_ids": uids} for e, uids in reactions_by_emoji.items()],
        "my_reaction": my_reaction,
        "read_by_all": read_by_all,
        "created_at": to_utc_iso(msg.created_at),
        # Preenchido só quando a mensagem chegou aqui por encaminhamento de
        # uma conversa de cliente/WhatsApp — dá pro front mostrar um card
        # clicável de volta pro contato de origem.
        "forwarded_from_whatsapp": {
            "conversation_id": msg.forwarded_from_wa_conversation_id,
            "wamid": msg.forwarded_from_wa_wamid,
            "contact_name": msg.forwarded_from_contact_name,
            "contact_phone": msg.forwarded_from_contact_phone,
        } if msg.forwarded_from_wa_conversation_id else None,
        # Preenchido só quando message_type="task" — estado ao vivo da tarefa
        # (status/responsável/prazo), lido da InternalTask via task_id em vez
        # de duplicado na mensagem (ver comentário no model).
        "task": _format_task(msg.task) if msg.task_id and msg.task else None,
        # NULL = card interativo completo (mensagem de criação); preenchido
        # = aviso simples de texto (ver comentário em InternalMessage.task_event).
        "task_event": msg.task_event,
    }


@router_internal_chat.get("")
async def list_internal_chats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = db.query(InternalConversationParticipant).filter(
        InternalConversationParticipant.user_id == current_user.id
    ).all()
    conversations = [r.conversation for r in rows]
    briefs = [_conversation_brief(db, c, current_user.id) for c in conversations]
    briefs.sort(
        key=lambda b: (b["is_pinned"], b["last_message"]["created_at"] if b["last_message"] else b["created_at"]),
        reverse=True,
    )
    return APIResponse(success=True, data=briefs)


@router_internal_chat.get("/search")
async def search_internal_chats(
    q: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Busca conversas internas (DM/grupo) do usuário pelo nome — aba
    "Conversas" da busca em Equipe, mesma ideia de GET /conversations/search
    do lado cliente. Só entre as conversas que ele participa (chat interno
    é privado, diferente da caixa compartilhada de WhatsApp).
    """
    if not q or not q.strip():
        return APIResponse(success=True, data=[])
    term = q.strip().lower()
    rows = db.query(InternalConversationParticipant).filter(
        InternalConversationParticipant.user_id == current_user.id
    ).all()
    briefs = [_conversation_brief(db, r.conversation, current_user.id) for r in rows]
    matches = [b for b in briefs if term in (b["name"] or "").lower()]
    return APIResponse(success=True, data=matches)


@router_internal_chat.get("/messages/search")
async def search_internal_messages(
    q: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Busca ocorrências de mensagem interna pelo texto — aba "Mensagens" da
    busca em Equipe, mesma ideia de GET /messages/search do lado cliente.
    Restrito às conversas que o usuário participa, senão vazaria conteúdo
    de DM privada de outras pessoas pra quem busca.
    """
    if not q or not q.strip():
        return APIResponse(success=True, data=[])
    like = f"%{q.strip()}%"
    my_conv_ids = [
        r.conversation_id for r in db.query(InternalConversationParticipant).filter(
            InternalConversationParticipant.user_id == current_user.id
        ).all()
    ]
    if not my_conv_ids:
        return APIResponse(success=True, data=[])

    messages = db.query(InternalMessage).filter(
        InternalMessage.conversation_id.in_(my_conv_ids),
        InternalMessage.is_deleted.is_(False),
        InternalMessage.text.ilike(like),
    ).order_by(InternalMessage.created_at.desc()).limit(100).all()

    result = [{
        "id": msg.id,
        "conversation_id": msg.conversation_id,
        "conversation_name": _conversation_display_name(msg.conversation, current_user.id),
        "is_group": msg.conversation.is_group,
        "sender_name": format_display_name(msg.sender.full_name, msg.sender.email, msg.sender.display_name_format) if msg.sender else "Desconhecido",
        "text": msg.text,
        "created_at": to_utc_iso(msg.created_at),
    } for msg in messages]
    return APIResponse(success=True, data=result)


@router_internal_chat.get("/presence")
async def get_presence(
    user_ids: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Presença atual de um conjunto de usuários (`user_ids=1,2,3`) — usado ao
    abrir uma conversa, pra já mostrar "online"/"ausente"/"ocupado"/"offline"
    sem esperar o primeiro evento de socket. Se o usuário está conectado
    (socket ativo, estado em memória do WebSocketManager), o status exibido é
    o `presence_status` manual dele (default "online"); se não está conectado
    de verdade, é sempre "offline" independente do que ele tinha configurado
    (mesma regra usada em websocket.py no disconnect).
    """
    try:
        ids = [int(x) for x in user_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="user_ids inválido")

    users = db.query(User).filter(User.id.in_(ids)).all()
    data = {}
    for u in users:
        # BUG (2026-09-04): pra qualquer usuário, o status manual só valia se
        # já estivesse "online" no WebSocketManager — mas o front busca a
        # PRÓPRIA presença logo ao logar (App.js), numa corrida real contra o
        # handshake do socket ainda em andamento; se essa busca chegasse
        # primeiro, respondia "offline" mesmo com presence_status="away"/
        # "busy" salvo, e o indicador da própria pessoa resetava pra
        # "Disponível" a cada login/reload. Pra si mesmo (current_user),
        # ignora o gate de "está conectado" — quem está fazendo essa
        # requisição autenticada obviamente está prestes a ficar online,
        # não faz sentido esconder o próprio status manual dela mesma.
        if u.id == current_user.id:
            online = True
            status = u.presence_status or "online"
        else:
            online = bool(ws_manager.online_users.get(u.id))
            status = (u.presence_status or "online") if online else "offline"
        data[str(u.id)] = {
            "status": status,
            # "Z" explícito — datetime gravado é UTC (datetime.utcnow()) mas
            # sem timezone marcada no isoformat() o front interpreta como
            # horário local do navegador, errando por todo o offset de fuso.
            "last_seen_at": None if online else ((u.last_seen_at.isoformat() + "Z") if u.last_seen_at else None),
        }
    return APIResponse(success=True, data=data)


VALID_PRESENCE_STATUSES = {"online", "away", "busy", "offline"}


class PresenceStatusRequest(BaseModel):
    status: str


@router_internal_chat.patch("/me/presence-status")
async def set_my_presence_status(
    payload: PresenceStatusRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Deixa o usuário escolher como quer aparecer pros outros (Disponível/
    Ausente/Ocupado/Offline, estilo Slack/Teams) enquanto estiver conectado.
    Não mexe em "está conectado ou não" de verdade — só no que aparece
    enquanto está. Se tiver socket ativo agora, já propaga na hora pra quem
    tem conversa em comum; senão, o valor só é lido no próximo /presence ou
    reconexão (ver identify em websocket.py).
    """
    status = payload.status.strip().lower()
    if status not in VALID_PRESENCE_STATUSES:
        raise HTTPException(status_code=400, detail=f"Status inválido. Use um de: {', '.join(sorted(VALID_PRESENCE_STATUSES))}")

    current_user.presence_status = status
    db.commit()

    if ws_manager.online_users.get(current_user.id):
        await ws_manager.notify_internal_chat_presence(ws_manager._contacts_of(current_user.id), {
            "user_id": current_user.id,
            "status": status,
            "last_seen_at": None,
        })

    return APIResponse(success=True, data={"status": status})


class DmRequest(BaseModel):
    user_id: int


@router_internal_chat.post("/dm")
async def get_or_create_dm(
    payload: DmRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # DM consigo mesmo é permitida — mesma ideia do "Mensagens para você
    # mesmo" do WhatsApp real, útil pra rascunho/lembrete pessoal e pra
    # criar tarefa atribuída a si mesmo sem precisar de outro participante.
    # Ela tem só UM InternalConversationParticipant (chave primária é
    # conversation_id+user_id, não dá pra duplicar o mesmo user_id).
    is_self = payload.user_id == current_user.id

    if not is_self:
        other = db.query(User).filter(User.id == payload.user_id, User.is_active == True).first()  # noqa: E712
        if not other:
            raise HTTPException(status_code=404, detail="Usuário não encontrado")

    my_dm_conv_ids = select(InternalConversationParticipant.conversation_id).where(
        InternalConversationParticipant.user_id == current_user.id
    )
    candidate = db.query(InternalConversation).filter(
        InternalConversation.is_group.is_(False),
        InternalConversation.id.in_(my_dm_conv_ids),
    ).all()
    target_ids = {current_user.id} if is_self else {current_user.id, payload.user_id}
    for conv in candidate:
        participant_ids = {p.user_id for p in conv.participant_rows}
        if participant_ids == target_ids:
            return APIResponse(success=True, data=_conversation_brief(db, conv, current_user.id))

    conv = InternalConversation(is_group=False, created_by=current_user.id)
    db.add(conv)
    db.commit()
    db.refresh(conv)
    participant_rows = [
        InternalConversationParticipant(conversation_id=conv.id, user_id=current_user.id, last_read_at=datetime.utcnow()),
    ]
    if not is_self:
        participant_rows.append(InternalConversationParticipant(conversation_id=conv.id, user_id=payload.user_id))
    db.add_all(participant_rows)
    db.commit()
    db.refresh(conv)

    brief = _conversation_brief(db, conv, current_user.id)
    if not is_self:
        await ws_manager.notify_internal_chat_created([payload.user_id], brief)
    return APIResponse(success=True, data=brief)


class GroupRequest(BaseModel):
    name: str
    participant_ids: List[int]


@router_internal_chat.post("/group")
async def create_internal_group(
    payload: GroupRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_internal_create_group"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para criar grupos na Equipe.")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nome do grupo é obrigatório")
    participant_ids = {pid for pid in payload.participant_ids if pid != current_user.id}
    if not participant_ids:
        raise HTTPException(status_code=400, detail="Selecione pelo menos mais uma pessoa")

    valid_users = db.query(User.id).filter(User.id.in_(participant_ids), User.is_active == True).all()  # noqa: E712
    valid_ids = {u.id for u in valid_users}
    if len(valid_ids) != len(participant_ids):
        raise HTTPException(status_code=400, detail="Algum usuário selecionado não existe ou está inativo")

    conv = InternalConversation(is_group=True, name=name, created_by=current_user.id)
    db.add(conv)
    db.commit()
    db.refresh(conv)

    # Quem cria o grupo vira admin — mesma convenção do WhatsApp real.
    rows = [InternalConversationParticipant(
        conversation_id=conv.id, user_id=current_user.id, last_read_at=datetime.utcnow(), is_admin=True,
    )]
    rows += [InternalConversationParticipant(conversation_id=conv.id, user_id=uid) for uid in valid_ids]
    db.add_all(rows)
    db.commit()
    db.refresh(conv)

    brief = _conversation_brief(db, conv, current_user.id)
    await ws_manager.notify_internal_chat_created(list(valid_ids), brief)
    return APIResponse(success=True, data=brief)


@router_internal_chat.get("/{conversation_id}/messages")
async def list_internal_messages(
    conversation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    messages = db.query(InternalMessage).filter(
        InternalMessage.conversation_id == conversation_id
    ).order_by(InternalMessage.created_at.asc()).all()

    return APIResponse(success=True, data=[_format_internal_message(m, conv, current_user.id) for m in messages])


class SendInternalMessageRequest(BaseModel):
    text: str
    reply_to_id: Optional[int] = None


async def _persist_and_broadcast_message(
    db: Session, conv: InternalConversation, current_user: Optional[User],
    text: str, message_type: str = "text", media_url: Optional[str] = None,
    mime_type: Optional[str] = None, filename: Optional[str] = None,
    reply_to_id: Optional[int] = None,
    forwarded_from_wa_conversation_id: Optional[int] = None,
    forwarded_from_wa_wamid: Optional[str] = None,
    forwarded_from_contact_name: Optional[str] = None,
    forwarded_from_contact_phone: Optional[str] = None,
    task_id: Optional[int] = None,
    task_event: Optional[str] = None,
) -> dict:
    """current_user=None posta como aviso automático do sistema (sender_id
    NULL) — usado só pelo task_pause_reminder_watchdog.py. Sem um usuário
    "dono" da mensagem, is_mine fica False pra TODOS os participantes (nem
    quem pausou a tarefa é tratado como remetente), então o popup/som de
    notificação dispara pra quem precisa ver o lembrete."""
    if reply_to_id is not None:
        replied = db.query(InternalMessage).filter(
            InternalMessage.id == reply_to_id, InternalMessage.conversation_id == conv.id,
        ).first()
        if not replied:
            raise HTTPException(status_code=404, detail="Mensagem citada não encontrada nesta conversa")

    msg = InternalMessage(
        conversation_id=conv.id, sender_id=current_user.id if current_user else None, text=text,
        message_type=message_type, media_url=media_url, mime_type=mime_type, filename=filename,
        reply_to_id=reply_to_id,
        forwarded_from_wa_conversation_id=forwarded_from_wa_conversation_id,
        forwarded_from_wa_wamid=forwarded_from_wa_wamid,
        forwarded_from_contact_name=forwarded_from_contact_name,
        forwarded_from_contact_phone=forwarded_from_contact_phone,
        task_id=task_id,
        task_event=task_event,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # Quem manda já viu a própria mensagem (não se aplica a aviso automático).
    if current_user:
        my_row = _my_participant_row(conv, current_user.id)
        if my_row:
            my_row.last_read_at = msg.created_at
            db.commit()

    message_data = _format_internal_message(msg, conv, current_user.id if current_user else 0)
    participant_ids = [p.user_id for p in conv.participant_rows]
    # "is_mine" (e "my_reaction") são relativos a quem tá vendo — não dá pra
    # calcular uma vez (relativo a quem mandou) e mandar o mesmo pacote pra
    # todo mundo, senão TODOS os participantes recebem a mensagem marcada
    # como se fosse deles, e a conversa parece ter só uma pessoa falando.
    await ws_manager.send_internal_chat_message(
        participant_ids, lambda uid: _format_internal_message(msg, conv, uid),
    )
    return message_data


@router_internal_chat.post("/{conversation_id}/messages")
async def send_internal_message(
    conversation_id: int,
    payload: SendInternalMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Mensagem vazia")

    message_data = await _persist_and_broadcast_message(
        db, conv, current_user, text, reply_to_id=payload.reply_to_id,
    )
    return APIResponse(success=True, data=message_data)


@router_internal_chat.post("/{conversation_id}/media")
async def send_internal_media(
    conversation_id: int,
    message_type: str = Form(...),
    caption: str = Form(""),
    reply_to_id: Optional[int] = Form(None),
    media: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Mídia no chat interno — mesmo padrão de POST /api/send/media (routes.py):
    salva em uploads/, normaliza (normalize_media, já usado pra sticker/áudio/
    vídeo no lado cliente), persiste como InternalMessage e entrega só pros
    participantes via WebSocket (rooms 'user:{id}', nunca broadcast global).
    """
    if message_type not in VALID_MEDIA_TYPES:
        raise HTTPException(status_code=400, detail=f"Tipo de mídia inválido: {message_type}")

    conv = _require_participant(db, conversation_id, current_user.id)

    original_name = media.filename or "arquivo"
    safe_original = "".join(c if c.isalnum() or c in "._-" else "_" for c in original_name)
    safe_name = f"{uuid.uuid4().hex}_{safe_original}"
    file_path = UPLOAD_DIR / safe_name
    content = await media.read()
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    file_mime = media.content_type or "application/octet-stream"
    converted_path = file_path
    try:
        converted_path, file_mime = normalize_media(file_path, file_mime, message_type)
    except Exception as exc:
        logger.warning(f"Falha ao normalizar mídia de chat interno ({message_type}): {exc}")

    media_url = f"/uploads/{converted_path.name}"

    message_data = await _persist_and_broadcast_message(
        db, conv, current_user,
        text=caption or "",
        message_type=message_type,
        media_url=media_url,
        mime_type=file_mime,
        filename=media.filename if message_type == "document" else None,
        reply_to_id=reply_to_id,
    )
    return APIResponse(success=True, data=message_data)


@router_internal_chat.post("/{conversation_id}/read")
async def mark_internal_chat_read(
    conversation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    row = _my_participant_row(conv, current_user.id)
    row.last_read_at = datetime.utcnow()
    db.commit()

    other_ids = [p.user_id for p in conv.participant_rows if p.user_id != current_user.id]
    await ws_manager.notify_internal_chat_read(other_ids, {
        "conversation_id": conversation_id, "user_id": current_user.id, "read_at": to_utc_iso(row.last_read_at),
    })
    return APIResponse(success=True, data={"conversation_id": conversation_id})


def _require_own_message(db: Session, conv: InternalConversation, message_id: int, user_id: int) -> InternalMessage:
    msg = db.query(InternalMessage).filter(
        InternalMessage.id == message_id, InternalMessage.conversation_id == conv.id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    if msg.sender_id != user_id:
        raise HTTPException(status_code=403, detail="Só quem enviou pode alterar esta mensagem")
    return msg


class EditInternalMessageRequest(BaseModel):
    text: str


@router_internal_chat.patch("/{conversation_id}/messages/{message_id}")
async def edit_internal_message(
    conversation_id: int,
    message_id: int,
    payload: EditInternalMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    msg = _require_own_message(db, conv, message_id, current_user.id)
    if msg.is_deleted:
        raise HTTPException(status_code=400, detail="Não é possível editar uma mensagem apagada")
    if msg.message_type != "text":
        raise HTTPException(status_code=400, detail="Só mensagens de texto podem ser editadas")

    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Mensagem vazia")

    msg.text = text
    msg.is_edited = True
    db.commit()

    data = {"conversation_id": conversation_id, "id": msg.id, "text": msg.text, "is_edited": True}
    participant_ids = [p.user_id for p in conv.participant_rows]
    await ws_manager.notify_internal_chat_message_edited(participant_ids, data)
    return APIResponse(success=True, data=data)


@router_internal_chat.delete("/{conversation_id}/messages/{message_id}")
async def delete_internal_message(
    conversation_id: int,
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    msg = _require_own_message(db, conv, message_id, current_user.id)

    msg.is_deleted = True
    db.commit()

    data = {"conversation_id": conversation_id, "id": msg.id}
    participant_ids = [p.user_id for p in conv.participant_rows]
    await ws_manager.notify_internal_chat_message_deleted(participant_ids, data)
    return APIResponse(success=True, data=data)


class ReactRequest(BaseModel):
    emoji: Optional[str] = None  # None/"" remove a reação


@router_internal_chat.post("/{conversation_id}/messages/{message_id}/react")
async def react_internal_message(
    conversation_id: int,
    message_id: int,
    payload: ReactRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    msg = db.query(InternalMessage).filter(
        InternalMessage.id == message_id, InternalMessage.conversation_id == conv.id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    existing = db.query(InternalMessageReaction).filter(
        InternalMessageReaction.message_id == message_id, InternalMessageReaction.user_id == current_user.id,
    ).first()

    if not payload.emoji:
        if existing:
            db.delete(existing)
            db.commit()
    elif existing:
        existing.emoji = payload.emoji
        db.commit()
    else:
        db.add(InternalMessageReaction(message_id=message_id, user_id=current_user.id, emoji=payload.emoji))
        db.commit()

    db.refresh(msg)
    reactions = [{"emoji": e, "user_ids": uids} for e, uids in (
        (e, [r.user_id for r in msg.reactions if r.emoji == e]) for e in {r.emoji for r in msg.reactions}
    )]
    data = {"conversation_id": conversation_id, "message_id": message_id, "reactions": reactions}
    participant_ids = [p.user_id for p in conv.participant_rows]
    await ws_manager.notify_internal_chat_reaction(participant_ids, data)
    return APIResponse(success=True, data=data)


class StarRequest(BaseModel):
    starred: bool


@router_internal_chat.post("/{conversation_id}/messages/{message_id}/star")
async def star_internal_message(
    conversation_id: int,
    message_id: int,
    payload: StarRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    msg = db.query(InternalMessage).filter(
        InternalMessage.id == message_id, InternalMessage.conversation_id == conv.id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    msg.is_starred = payload.starred
    db.commit()
    return APIResponse(success=True, data={"id": msg.id, "is_starred": msg.is_starred})


class PinRequest(BaseModel):
    pinned: bool


@router_internal_chat.post("/{conversation_id}/messages/{message_id}/pin")
async def pin_internal_message(
    conversation_id: int,
    message_id: int,
    payload: PinRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    msg = db.query(InternalMessage).filter(
        InternalMessage.id == message_id, InternalMessage.conversation_id == conv.id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    msg.is_pinned = payload.pinned
    db.commit()
    return APIResponse(success=True, data={"id": msg.id, "is_pinned": msg.is_pinned})


@router_internal_chat.post("/{conversation_id}/pin")
async def pin_internal_conversation(
    conversation_id: int,
    payload: PinRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    "Fixar Conversa" pro chat interno — não existe protocolo WhatsApp por
    trás aqui, então isso é a ÚNICA forma de pin possível (diferente do lado
    cliente, que também tem o pin nativo à parte). Global pra todo
    participante, igual nome/foto de grupo.
    """
    conv = _require_participant(db, conversation_id, current_user.id)
    conv.is_pinned = payload.pinned
    db.commit()
    db.refresh(conv)

    participant_ids = [p.user_id for p in conv.participant_rows]
    await ws_manager.notify_internal_chat_updated(participant_ids, _conversation_public_fields(conv))
    return APIResponse(success=True, data={"id": conv.id, "is_pinned": conv.is_pinned})


class FavoriteRequest(BaseModel):
    favorite: bool


@router_internal_chat.post("/{conversation_id}/favorite")
async def favorite_internal_conversation(
    conversation_id: int,
    payload: FavoriteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    "Favoritar Conversa" pro chat interno — diferente de is_pinned (global),
    é preferência PESSOAL: só afeta como ESSA pessoa organiza a própria
    lista, por isso mora em InternalConversationParticipant, não broadcast
    pros outros participantes.
    """
    conv = _require_participant(db, conversation_id, current_user.id)
    my_row = _my_participant_row(conv, current_user.id)
    my_row.is_favorite = payload.favorite
    db.commit()
    return APIResponse(success=True, data={"id": conv.id, "is_favorite": my_row.is_favorite})


class MutedRequest(BaseModel):
    muted: bool


@router_internal_chat.post("/{conversation_id}/mute")
async def mute_internal_conversation(
    conversation_id: int,
    payload: MutedRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    "Silenciar Notificações" pro chat interno — pessoal (InternalConversationParticipant),
    nunca afeta os outros participantes do grupo/DM.
    """
    conv = _require_participant(db, conversation_id, current_user.id)
    my_row = _my_participant_row(conv, current_user.id)
    my_row.is_muted = payload.muted
    db.commit()
    return APIResponse(success=True, data={"id": conv.id, "is_muted": my_row.is_muted})


RECURRENCE_INTERVALS = ("daily", "weekly", "monthly")
TASK_PRIORITIES = ("low", "medium", "high", "urgent")
# Pra ordenar lista de tarefas com as mais urgentes primeiro (ver
# list_internal_tasks/list_my_tasks) — menor número = mais urgente.
TASK_PRIORITY_ORDER = {"urgent": 0, "high": 1, "medium": 2, "low": 3}


def _naive_utc(dt: datetime) -> datetime:
    """O front manda datetime com "Z" (UTC) — o Pydantic parseia isso como
    datetime AWARE (tzinfo=UTC), mas todo datetime salvo/comparado neste app
    é NAIVE (ver time_utils.py: datetime.utcnow(), sem tzinfo — SQLAlchemy
    também devolve naive na leitura). Comparar/salvar o valor aware direto
    quebra com TypeError ("can't compare offset-naive and offset-aware
    datetimes") assim que bate num `<= datetime.utcnow()`. Usado só nos
    campos que são checados ANTES de passar pelo banco (pause_reminder_at) —
    due_at nunca precisou disso porque só é comparado depois de um
    db.refresh(), que já devolve naive."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


class CreateTaskRequest(BaseModel):
    title: str
    description: Optional[str] = None
    assigned_to: Optional[int] = None
    due_at: Optional[datetime] = None
    priority: Optional[str] = None  # low|medium|high|urgent — default "medium"
    recurrence_interval: Optional[str] = None  # daily|weekly|monthly
    recurrence_every: Optional[int] = None     # a cada N unidades (default 1 se recurrence_interval vier)
    recurrence_days_of_week: Optional[List[int]] = None  # só p/ weekly — 0=segunda...6=domingo


@router_internal_chat.get("/{conversation_id}/tasks")
async def list_internal_tasks(
    conversation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Lista de tarefas pro painel "Dados do contato"/"Dados do grupo" — pendentes primeiro (por prazo), depois concluídas."""
    _require_participant(db, conversation_id, current_user.id)
    tasks = db.query(InternalTask).filter(InternalTask.conversation_id == conversation_id).all()
    tasks.sort(key=lambda t: (
        t.status in ("done", "cancelled"),
        TASK_PRIORITY_ORDER.get(t.priority, 2),
        t.due_at or datetime.max,
        t.created_at or datetime.max,
    ))
    return APIResponse(success=True, data=[_format_task(t) for t in tasks])


@router_internal_chat.post("/{conversation_id}/tasks/mark-viewed")
async def mark_tasks_viewed(
    conversation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Chamado ao expandir a faixa de tarefas dessa conversa — marca todas as
    tarefas atuais como vistas (mesma ideia de abrir a conversa marcar
    mensagem como lida), zerando o badge de não-lida (rail/faixa/sidebar)."""
    conv = _require_participant(db, conversation_id, current_user.id)
    my_row = _my_participant_row(conv, current_user.id)
    my_row.last_tasks_viewed_at = datetime.utcnow()
    db.commit()
    return APIResponse(success=True, data={"conversation_id": conversation_id})


@router_internal_chat.get("/tasks/mine")
async def list_my_tasks(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Todas as tarefas ABERTAS atribuídas a mim OU criadas por mim — base do
    painel global de Tarefas (ícone no rail, abaixo de Mídia). Cobre os 3
    tipos: de conversa INTERNA (só se eu ainda participo dela, regra de
    sempre), vinculada a conversa de CLIENTE, e pessoal (sem conversa
    nenhuma — pedido explícito: "tarefa pra mim mesmo" não deveria depender
    de nenhum chat, ver create_standalone_task). Cada item já vem com o
    contexto (nome da conversa/contato quando existir) pra navegar direto
    pra lá."""
    tasks = db.query(InternalTask).filter(
        InternalTask.status == "pending",
        or_(InternalTask.assigned_to == current_user.id, InternalTask.created_by == current_user.id),
    ).all()

    internal_conv_ids = {t.conversation_id for t in tasks if t.conversation_id}
    my_rows = db.query(InternalConversationParticipant).filter(
        InternalConversationParticipant.user_id == current_user.id,
        InternalConversationParticipant.conversation_id.in_(internal_conv_ids),
    ).all() if internal_conv_ids else []
    last_viewed_by_conv = {r.conversation_id: r.last_tasks_viewed_at for r in my_rows}
    my_participant_conv_ids = set(last_viewed_by_conv.keys())
    # Só filtra fora quem NÃO participa mais — tarefa pessoal/de cliente não
    # tem esse conceito, passa direto.
    tasks = [t for t in tasks if not t.conversation_id or t.conversation_id in my_participant_conv_ids]

    customer_conv_ids = {t.customer_conversation_id for t in tasks if t.customer_conversation_id}
    customer_convs = {
        c.id: c for c in db.query(Conversation).filter(Conversation.id.in_(customer_conv_ids)).all()
    } if customer_conv_ids else {}

    tasks.sort(key=lambda t: (
        TASK_PRIORITY_ORDER.get(t.priority, 2),
        t.due_at is None,
        t.due_at or datetime.max,
        -(t.created_at or datetime.min).timestamp(),
    ))

    data = []
    for t in tasks:
        item = _format_task(t)
        if t.conversation_id:
            last_viewed = last_viewed_by_conv.get(t.conversation_id)
            item["conversation_name"] = _conversation_display_name(t.conversation, current_user.id)
            item["conversation_is_group"] = t.conversation.is_group
            item["is_unread"] = last_viewed is None or t.created_at > last_viewed
        elif t.customer_conversation_id:
            cconv = customer_convs.get(t.customer_conversation_id)
            contact = cconv.contact if cconv else None
            item["conversation_name"] = (contact.saved_name or contact.name or contact.push_name or contact.phone_number) if contact else "Cliente"
            item["conversation_is_group"] = bool(cconv.is_group) if cconv else False
            item["is_unread"] = False
        else:
            item["conversation_name"] = None
            item["conversation_is_group"] = False
            item["is_unread"] = False
        data.append(item)

    return APIResponse(success=True, data=data)


@router_internal_chat.get("/customer-conversations/{conversation_id}/tasks")
async def list_customer_conversation_tasks(
    conversation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Tarefas vinculadas a uma conversa de CLIENTE (ver create_standalone_task)
    — faixa "Tarefas da conversa" dentro do ChatArea, mesmo padrão visual do
    chat interno. Sem checagem extra de permissão além de estar logado
    (mesmo padrão de create_note/get_conversation_notes em
    routes_attendance.py — quem já consegue abrir esse chat no front já
    passou pelo controle de acesso à conta/número)."""
    conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")
    tasks = db.query(InternalTask).filter(InternalTask.customer_conversation_id == conversation_id).all()
    tasks.sort(key=lambda t: (
        t.status in ("done", "cancelled"),
        TASK_PRIORITY_ORDER.get(t.priority, 2),
        t.due_at or datetime.max,
        t.created_at or datetime.max,
    ))
    return APIResponse(success=True, data=[_format_task(t) for t in tasks])


class CreateStandaloneTaskRequest(BaseModel):
    title: str
    description: Optional[str] = None
    assigned_to: Optional[int] = None
    due_at: Optional[datetime] = None
    priority: str = "medium"
    recurrence_interval: Optional[str] = None
    recurrence_every: Optional[int] = None
    recurrence_days_of_week: Optional[List[int]] = None
    # Presente = vinculada a essa conversa de cliente (controle exclusivo de
    # quem cria, nunca gera nada visível pro cliente). Ausente = pessoal,
    # sem vínculo com conversa nenhuma.
    customer_conversation_id: Optional[int] = None


@router_internal_chat.post("/tasks")
async def create_standalone_task(
    payload: CreateStandaloneTaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Cria uma tarefa SEM conversa interna — pessoal (pedido explícito: uma
    tarefa "pra mim mesmo" não deveria forçar um chat interno; antes disso
    o front usava a DM "Você mesmo" como container obrigatório, o que
    poluía essa conversa — pensada só pra anotações — com uma enxurrada de
    avisos de sistema toda vez que uma tarefa mudava de estado) OU vinculada
    a uma conversa de CLIENTE (customer_conversation_id).

    Diferente de create_internal_task acima, NUNCA posta nenhum card/aviso
    em timeline nenhuma — tarefa de cliente é "controle exclusivo de quem
    cria", o cliente não pode nunca ver nem saber que ela existe; tarefa
    pessoal não tem timeline pra postar de qualquer forma.
    """
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Título da tarefa é obrigatório")

    priority = payload.priority or "medium"
    if priority not in TASK_PRIORITIES:
        raise HTTPException(status_code=400, detail="Urgência inválida")

    customer_conv = None
    if payload.customer_conversation_id is not None:
        customer_conv = db.query(Conversation).filter(Conversation.id == payload.customer_conversation_id).first()
        if not customer_conv:
            raise HTTPException(status_code=404, detail="Conversa não encontrada")

    # Tarefa de conversa de cliente cai pra autoatribuída (quem cria = quem
    # resolve, "controle do próprio usuário") só quando NINGUÉM foi
    # explicitamente passado — o front não mostra esse seletor na criação
    # manual (TaskModal em modo cliente), então na prática só chega aqui
    # preenchido quando vem de uma etiqueta com responsável fixo configurado
    # (ver add_conversation_tag em routes_attendance.py — etiquetas
    # operacionais tipo "Coleta"/"Devolução" precisam acionar quem realmente
    # trata, não sempre quem aplicou). Pessoal sempre permitiu delegar pra
    # outro colega (mesma liberdade que a DM "Você mesmo" já dava).
    assigned_to = payload.assigned_to if payload.assigned_to is not None else current_user.id
    if payload.assigned_to is not None:
        if not db.query(User).filter(User.id == payload.assigned_to).first():
            raise HTTPException(status_code=400, detail="Responsável inválido")

    recurrence_interval = None
    recurrence_every = None
    recurrence_days_of_week = None
    if payload.recurrence_interval:
        if payload.recurrence_interval not in RECURRENCE_INTERVALS:
            raise HTTPException(status_code=400, detail="Intervalo de recorrência inválido")
        recurrence_interval = payload.recurrence_interval
        recurrence_every = payload.recurrence_every or 1
        if recurrence_every < 1:
            raise HTTPException(status_code=400, detail="Recorrência precisa repetir a cada 1 ou mais unidades")
        if payload.recurrence_days_of_week:
            if recurrence_interval != "weekly":
                raise HTTPException(status_code=400, detail="Dias da semana só valem pra recorrência semanal")
            if any(not isinstance(d, int) or d < 0 or d > 6 for d in payload.recurrence_days_of_week):
                raise HTTPException(status_code=400, detail="Dia da semana inválido (use 0=segunda...6=domingo)")
            recurrence_days_of_week = sorted(set(payload.recurrence_days_of_week))

    task = InternalTask(
        conversation_id=None,
        customer_conversation_id=customer_conv.id if customer_conv else None,
        created_by=current_user.id, assigned_to=assigned_to,
        title=title, description=(payload.description or "").strip() or None,
        due_at=payload.due_at, priority=priority,
        recurrence_interval=recurrence_interval, recurrence_every=recurrence_every,
        recurrence_days_of_week=recurrence_days_of_week,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    db.add(InternalTaskHistory(task_id=task.id, event="created", user_id=current_user.id))
    db.commit()

    task_data = await _broadcast_task(db, task, None)
    return APIResponse(success=True, data=task_data)


@router_internal_chat.get("/tasks/reports")
async def internal_task_reports(
    days: int = 7,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Métricas agregadas de tarefas do chat interno (atendimento interno da
    equipe, não cliente) — mesma ideia do /api/attendance/reports, mesma
    permissão (settings_analytics). Tarefa não é presa a conta/número
    WhatsApp (chat interno é da empresa toda), então não tem o filtro de
    feature_view_all_accounts que o relatório de atendimento tem.

    "Criadas no período" (total/status/conclusão/aprovação) usa
    InternalTask.created_at >= cutoff. "Atrasadas agora" é uma foto do estado
    ATUAL (independe de quando a tarefa foi criada) — mesmo padrão de
    sla_breaches_now no relatório de atendimento.
    """
    if not user_has_permission(db, current_user, "settings_analytics"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para ver relatórios.")

    cutoff = datetime.utcnow() - timedelta(days=days)
    now = datetime.utcnow()

    tasks = db.query(InternalTask).filter(InternalTask.created_at >= cutoff).all()

    status_counts = {"pending": 0, "paused": 0, "done": 0, "cancelled": 0}
    completion_seconds = []
    per_assignee: dict = {}

    for t in tasks:
        status_counts[t.status] = status_counts.get(t.status, 0) + 1
        if t.status == "done" and t.completed_at:
            completion_seconds.append((t.completed_at - t.created_at).total_seconds())
        if t.assigned_to:
            bucket = per_assignee.setdefault(t.assigned_to, {
                "user_id": t.assigned_to,
                "full_name": (t.assignee.full_name or t.assignee.email) if t.assignee else "Desconhecido",
                "total": 0, "done": 0, "completion_seconds": [], "overdue": 0,
            })
            bucket["total"] += 1
            if t.status == "done":
                bucket["done"] += 1
                if t.completed_at:
                    bucket["completion_seconds"].append((t.completed_at - t.created_at).total_seconds())
            # Cancelada não é "atrasada" — é um estado terminal igual "done",
            # só que sem conclusão (mesmo motivo da exclusão em overdue_now
            # abaixo).
            elif t.status != "cancelled" and t.due_at and t.due_at < now:
                bucket["overdue"] += 1

    overdue_now = db.query(InternalTask).filter(
        InternalTask.status.notin_(["done", "cancelled"]),
        InternalTask.due_at.isnot(None),
        InternalTask.due_at < now,
    ).count()

    approved_count = db.query(InternalTaskHistory).filter(
        InternalTaskHistory.event == "approved", InternalTaskHistory.created_at >= cutoff,
    ).count()
    rejected_count = db.query(InternalTaskHistory).filter(
        InternalTaskHistory.event == "rejected", InternalTaskHistory.created_at >= cutoff,
    ).count()

    def _avg(vals):
        return round(sum(vals) / len(vals)) if vals else None

    assignees = sorted(
        [{
            "user_id": a["user_id"],
            "full_name": a["full_name"],
            "total": a["total"],
            "done": a["done"],
            "completion_rate": round(a["done"] / a["total"], 3) if a["total"] else None,
            "avg_completion_seconds": _avg(a["completion_seconds"]),
            "overdue": a["overdue"],
        } for a in per_assignee.values()],
        key=lambda a: -a["total"],
    )

    total = len(tasks)
    return APIResponse(success=True, data={
        "period_days": days,
        "total_tasks": total,
        "status_counts": status_counts,
        "completion_rate": round(status_counts["done"] / total, 3) if total else None,
        "avg_completion_seconds": _avg(completion_seconds),
        "overdue_now": overdue_now,
        "approved_count": approved_count,
        "rejected_count": rejected_count,
        "assignees": assignees,
    })


@router_internal_chat.post("/{conversation_id}/tasks")
async def create_internal_task(
    conversation_id: int,
    payload: CreateTaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Cria a tarefa e também posta um card na timeline do chat (mensagem
    message_type="task" apontando pra ela) — a lista completa (inclusive
    concluídas) vive nos Dados do contato/grupo via GET acima, o card no chat
    só dá contexto de quando/quem pediu.
    """
    conv = _require_participant(db, conversation_id, current_user.id)
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Título da tarefa é obrigatório")

    if payload.assigned_to is not None and not _my_participant_row(conv, payload.assigned_to):
        raise HTTPException(status_code=400, detail="Responsável precisa ser um participante desta conversa")

    priority = payload.priority or "medium"
    if priority not in TASK_PRIORITIES:
        raise HTTPException(status_code=400, detail="Urgência inválida")

    recurrence_interval = None
    recurrence_every = None
    recurrence_days_of_week = None
    if payload.recurrence_interval:
        if payload.recurrence_interval not in RECURRENCE_INTERVALS:
            raise HTTPException(status_code=400, detail="Intervalo de recorrência inválido")
        recurrence_interval = payload.recurrence_interval
        recurrence_every = payload.recurrence_every or 1
        if recurrence_every < 1:
            raise HTTPException(status_code=400, detail="Recorrência precisa repetir a cada 1 ou mais unidades")
        if payload.recurrence_days_of_week:
            if recurrence_interval != "weekly":
                raise HTTPException(status_code=400, detail="Dias da semana só valem pra recorrência semanal")
            if any(not isinstance(d, int) or d < 0 or d > 6 for d in payload.recurrence_days_of_week):
                raise HTTPException(status_code=400, detail="Dia da semana inválido (use 0=segunda...6=domingo)")
            recurrence_days_of_week = sorted(set(payload.recurrence_days_of_week))

    task = await _create_task_and_post_card(
        db, conv, current_user,
        title=title, description=(payload.description or "").strip() or None, due_at=payload.due_at,
        assigned_to=payload.assigned_to, priority=priority,
        recurrence_interval=recurrence_interval, recurrence_every=recurrence_every,
        recurrence_days_of_week=recurrence_days_of_week,
        recurrence_parent_id=None,
    )
    message_data = await _persist_and_broadcast_message(
        db, conv, current_user, text=f"📋 {title}", message_type="task", task_id=task.id,
    )
    return APIResponse(success=True, data=message_data)


async def _create_task_and_post_card(
    db: Session, conv: InternalConversation, current_user: User, *,
    title: str, description: Optional[str], due_at, assigned_to: Optional[int],
    recurrence_interval: Optional[str], recurrence_every: Optional[int],
    recurrence_parent_id: Optional[int],
    recurrence_days_of_week: Optional[List[int]] = None,
    priority: str = "medium",
) -> InternalTask:
    """Cria a InternalTask + grava o evento "created" no histórico — usado
    tanto pela criação manual (create_internal_task) quanto pela geração
    automática da próxima ocorrência recorrente (ver approve_internal_task)."""
    task = InternalTask(
        conversation_id=conv.id, created_by=current_user.id, assigned_to=assigned_to,
        title=title, description=description, due_at=due_at, priority=priority,
        recurrence_interval=recurrence_interval, recurrence_every=recurrence_every,
        recurrence_days_of_week=recurrence_days_of_week,
        recurrence_parent_id=recurrence_parent_id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    db.add(InternalTaskHistory(task_id=task.id, event="created", user_id=current_user.id))
    db.commit()
    return task


def _require_task_participant(db: Session, task_id: int, user_id: int):
    """Busca a tarefa e confirma que o usuário tem acesso a ela — usado por
    toda rota de detalhe/ação/subtask/anexo abaixo. Devolve (task, conv),
    conv sendo a InternalConversation dona dela quando a tarefa é de chat
    INTERNO, ou None quando é pessoal ou vinculada a uma conversa de
    CLIENTE (não existe roster de participantes internos pra checar
    contra nesses dois casos)."""
    task = db.query(InternalTask).filter(InternalTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Tarefa não encontrada")
    if task.conversation_id is not None:
        conv = _require_participant(db, task.conversation_id, user_id)
        return task, conv
    if user_id not in (task.created_by, task.assigned_to):
        raise HTTPException(status_code=403, detail="Você não tem acesso a esta tarefa")
    return task, None


async def _broadcast_task(db: Session, task: InternalTask, conv: Optional[InternalConversation]) -> dict:
    db.refresh(task)
    task_data = _format_task(task)
    if conv is not None:
        participant_ids = [p.user_id for p in conv.participant_rows]
        await ws_manager.notify_internal_task_updated(participant_ids, {"conversation_id": conv.id, "task": task_data})
    elif task.customer_conversation_id is not None:
        # Sem roster fixo (qualquer atendente com aquele chat de cliente
        # aberto precisa ver a faixa atualizar) — broadcast global, mesmo
        # padrão de broadcast_internal_note em routes_attendance.py.
        await ws_manager.broadcast_customer_task_updated({"customer_conversation_id": task.customer_conversation_id, "task": task_data})
    else:
        # Pessoal — só quem criou/é responsável enxerga.
        participant_ids = list({task.created_by, task.assigned_to} - {None})
        await ws_manager.notify_internal_task_updated(participant_ids, {"conversation_id": None, "task": task_data})
    return task_data


# Cooldown pra evitar poluir o chat com avisos repetidos de um mesmo tipo
# de evento pra mesma tarefa (ex: fechar/reabrir a tarefa várias vezes
# rápido) — cada evento REAL sempre grava no histórico completo
# (InternalTaskHistory, ver TaskDetailModal "Histórico"), mas o aviso
# informativo na timeline do chat só reaparece depois desse intervalo.
TASK_NOTICE_COOLDOWN = timedelta(minutes=2)


async def _write_task_history_and_maybe_notify(
    db: Session, conv: InternalConversation, current_user: User, task: InternalTask,
    event: str, text: str, reason: Optional[str] = None,
) -> None:
    """Sempre grava o evento no histórico; só posta o aviso no chat se o
    último aviso do MESMO tipo pra esta tarefa não foi recente demais.
    Tarefa pessoal ou de conversa de CLIENTE não tem timeline nenhuma pra
    postar aviso (conv é None) — o histórico acima já registrou o evento,
    e quem fez a ação já sabe (foi ela mesma), então não tem quem avisar."""
    db.add(InternalTaskHistory(task_id=task.id, event=event, user_id=current_user.id, reason=reason))
    db.commit()
    if conv is None:
        return

    last_same_event = db.query(InternalMessage).filter(
        InternalMessage.task_id == task.id, InternalMessage.task_event == event,
    ).order_by(InternalMessage.created_at.desc()).first()
    if last_same_event and (datetime.utcnow() - last_same_event.created_at) < TASK_NOTICE_COOLDOWN:
        return

    await _persist_and_broadcast_message(
        db, conv, current_user, text=text, message_type="task", task_id=task.id, task_event=event,
    )


def _next_recurrence_due_at(anchor: datetime, interval: str, every: int, days_of_week: Optional[List[int]] = None) -> datetime:
    every = every or 1
    if interval == "daily":
        return anchor + timedelta(days=every)
    if interval == "weekly":
        if days_of_week:
            # Dias específicos (ex: toda segunda e quinta) — ignora `every`,
            # não faz sentido combinar "a cada N semanas" com dias
            # específicos. Anda dia a dia a partir de amanhã até achar o
            # próximo weekday() presente na lista (cobre virar a semana).
            candidate = anchor + timedelta(days=1)
            for _ in range(8):
                if candidate.weekday() in days_of_week:
                    return candidate
                candidate += timedelta(days=1)
            return anchor + timedelta(weeks=every)  # nunca deveria cair aqui
        return anchor + timedelta(weeks=every)
    if interval == "monthly":
        return anchor + relativedelta(months=every)
    return anchor


class UpdateTaskRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    assigned_to: Optional[int] = None
    due_at: Optional[datetime] = None
    status: Optional[str] = None  # pending|done
    priority: Optional[str] = None  # low|medium|high|urgent
    # assigned_to/due_at não distinguem "não mandou" de "quero limpar" (None
    # em ambos os casos) — os campos *_clear abaixo resolvem isso: manda
    # {"assigned_to_clear": true} pra remover o responsável sem precisar
    # mandar due_at/title/etc junto.
    assigned_to_clear: bool = False
    due_at_clear: bool = False
    # Edita/cancela o lembrete de uma tarefa JÁ pausada, sem precisar
    # retomar e pausar de novo (ver validação abaixo — só vale com
    # status=="paused"). Mesmo par valor/clear de assigned_to/due_at acima.
    pause_reminder_at: Optional[datetime] = None
    pause_reminder_at_clear: bool = False


@router_internal_chat.patch("/tasks/{task_id}")
async def update_internal_task(
    task_id: int,
    payload: UpdateTaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Edição geral da tarefa — status (marcar feita/reabrir), título, descrição, responsável e prazo, todos opcionais (PATCH parcial).

    Duas restrições de permissão (o resto do PATCH continua livre pra
    qualquer participante da conversa):
    - descrição: só quem criou a tarefa pode editar, e fica marcada como
      editada (description_edited) — o histórico de quem mudou o quê fica
      só com o criador, evitando descrição virar um campo de ninguém.
    - status (concluir/reabrir): só o criador ou o responsável pela tarefa
      — "participante qualquer" concluir a tarefa de outra pessoa não faz
      sentido no fluxo de aprovação abaixo.
    """
    task, conv = _require_task_participant(db, task_id, current_user.id)

    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Título da tarefa é obrigatório")
        task.title = title
    if payload.description is not None:
        if current_user.id != task.created_by:
            raise HTTPException(status_code=403, detail="Só quem criou a tarefa pode editar a descrição")
        new_description = payload.description.strip() or None
        if new_description != task.description:
            task.description = new_description
            task.description_edited = True
    if payload.priority is not None:
        if payload.priority not in TASK_PRIORITIES:
            raise HTTPException(status_code=400, detail="Urgência inválida")
        task.priority = payload.priority
    if payload.pause_reminder_at_clear or payload.pause_reminder_at is not None:
        if current_user.id not in (task.created_by, task.assigned_to):
            raise HTTPException(status_code=403, detail="Só quem criou ou é responsável pela tarefa pode mexer no lembrete")
        if task.status != "paused":
            raise HTTPException(status_code=400, detail="Tarefa não está pausada")
        if payload.pause_reminder_at_clear:
            task.pause_reminder_at = None
            task.pause_reminder_notified_at = None
        else:
            reminder_at = _naive_utc(payload.pause_reminder_at)
            if reminder_at <= datetime.utcnow():
                raise HTTPException(status_code=400, detail="Lembrete precisa ser numa data futura")
            task.pause_reminder_at = reminder_at
            task.pause_reminder_notified_at = None
    if payload.assigned_to_clear:
        task.assigned_to = None
    elif payload.assigned_to is not None:
        # Tarefa de conversa interna: responsável precisa ser participante
        # dela (regra de sempre). Pessoal/de conversa de CLIENTE não tem
        # roster pra validar contra — só confirma que o usuário existe.
        if conv is not None:
            if not _my_participant_row(conv, payload.assigned_to):
                raise HTTPException(status_code=400, detail="Responsável precisa ser um participante desta conversa")
        elif not db.query(User).filter(User.id == payload.assigned_to).first():
            raise HTTPException(status_code=400, detail="Responsável inválido")
        task.assigned_to = payload.assigned_to
    if payload.due_at_clear:
        task.due_at = None
        task.due_reminder_notified_at = None
    elif payload.due_at is not None:
        task.due_at = payload.due_at
        # Prazo mudou — libera o lembrete pra disparar de novo no novo
        # horário (sem isso, adiar o prazo de uma tarefa que já venceu uma
        # vez nunca mais lembraria, ver task_due_reminder_watchdog.py).
        task.due_reminder_notified_at = None

    just_completed = False
    just_reopened = False
    if payload.status is not None:
        if payload.status not in ("pending", "done"):
            raise HTTPException(status_code=400, detail="Status inválido")
        if current_user.id not in (task.created_by, task.assigned_to):
            raise HTTPException(status_code=403, detail="Só quem criou ou é responsável pela tarefa pode concluí-la")
        if task.status == "paused":
            raise HTTPException(status_code=400, detail="Tarefa está pausada — retome antes de concluir ou reabrir")
        if task.status == "cancelled":
            raise HTTPException(status_code=400, detail="Tarefa está cancelada — reative antes de concluir ou reabrir")
        if payload.status == "done" and task.status != "done":
            # Pedido explícito: não faz sentido concluir a tarefa principal
            # com itens do checklist ainda pendentes — força terminar (ou
            # remover) cada subtask antes.
            pending_subtasks = [s for s in task.subtasks if not s.is_done]
            if pending_subtasks:
                raise HTTPException(status_code=400, detail="Conclua (ou remova) todas as subtarefas antes de concluir a tarefa")
            just_completed = True
            task.completed_by = current_user.id
            task.completed_at = datetime.utcnow()
        elif payload.status == "pending" and task.status == "done":
            just_reopened = True
            task.completed_by = None
            task.completed_at = None
            # Reabriu — a aprovação anterior (se teve) não vale mais.
            task.approved_by = None
            task.approved_at = None
        task.status = payload.status

    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    # Conclusão da tarefa principal pede aprovação de quem criou — posta um
    # aviso na timeline do chat (o card renderizado a partir dele mostra o
    # botão "Aprovar"/"Reprovar" só pro criador, ver InternalChatArea no
    # frontend). Só dispara na transição pending->done/done->pending, não em
    # toggles redundantes. Aviso próprio (task_event) e sujeito ao cooldown
    # de repetição — ver _write_task_history_and_maybe_notify.
    if just_completed:
        creator_name = task.creator.full_name if task.creator else "alguém"
        text = f"✅ {current_user.full_name or current_user.email} concluiu a tarefa \"{task.title}\" — aguardando aprovação de {creator_name}."
        await _write_task_history_and_maybe_notify(db, conv, current_user, task, "completed", text)
    elif just_reopened:
        text = f"🔄 {current_user.full_name or current_user.email} reabriu a tarefa \"{task.title}\"."
        await _write_task_history_and_maybe_notify(db, conv, current_user, task, "reopened", text)

    return APIResponse(success=True, data=task_data)


async def _maybe_create_next_recurrence(db: Session, task: InternalTask, conv: InternalConversation, current_user: User) -> None:
    """Chamado só depois de uma aprovação — se a tarefa é recorrente, cria a
    próxima ocorrência (mesmo título/descrição/responsável), com o prazo
    recalculado a partir do due_at anterior (ou de agora, se não tinha
    prazo). Não dispara em reprovação — evita duplicar enquanto a atual
    ainda precisa ser refeita (ver reject_internal_task)."""
    if not task.recurrence_interval:
        return
    anchor = task.due_at or datetime.utcnow()
    next_due_at = _next_recurrence_due_at(anchor, task.recurrence_interval, task.recurrence_every, task.recurrence_days_of_week)
    next_task = await _create_task_and_post_card(
        db, conv, current_user,
        title=task.title, description=task.description, due_at=next_due_at,
        assigned_to=task.assigned_to, priority=task.priority,
        recurrence_interval=task.recurrence_interval, recurrence_every=task.recurrence_every,
        recurrence_days_of_week=task.recurrence_days_of_week,
        recurrence_parent_id=task.id,
    )
    text = f"🔁 Próxima ocorrência de \"{task.title}\" criada para {next_due_at.strftime('%d/%m/%Y %H:%M')}."
    await _persist_and_broadcast_message(
        db, conv, current_user, text=text, message_type="task", task_id=next_task.id,
    )


@router_internal_chat.post("/tasks/{task_id}/approve")
async def approve_internal_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Só quem CRIOU a tarefa aprova a conclusão (não se aplica a subtarefas)
    — o responsável concluir e também poder auto-aprovar esvaziaria o
    sentido da aprovação (era assim antes; mudou a pedido explícito)."""
    task, conv = _require_task_participant(db, task_id, current_user.id)
    if current_user.id != task.created_by:
        raise HTTPException(status_code=403, detail="Só quem criou a tarefa pode aprovar a conclusão")
    if task.status != "done":
        raise HTTPException(status_code=400, detail="Tarefa ainda não foi concluída")
    if task.approved_by:
        return APIResponse(success=True, data=_format_task(task))

    task.approved_by = current_user.id
    task.approved_at = datetime.utcnow()
    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    text = f"👍 {current_user.full_name or current_user.email} aprovou a conclusão da tarefa \"{task.title}\"."
    await _write_task_history_and_maybe_notify(db, conv, current_user, task, "approved", text)
    await _maybe_create_next_recurrence(db, task, conv, current_user)

    return APIResponse(success=True, data=task_data)


@router_internal_chat.post("/tasks/{task_id}/reject")
async def reject_internal_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Só quem criou a tarefa reprova a conclusão — desmarca ela (volta pra
    pending, limpa completed_by/completed_at) pra quem é responsável
    concluir de novo corretamente. Não gera a próxima ocorrência recorrente
    (só aprovação gera, ver _maybe_create_next_recurrence)."""
    task, conv = _require_task_participant(db, task_id, current_user.id)
    if current_user.id != task.created_by:
        raise HTTPException(status_code=403, detail="Só quem criou a tarefa pode reprovar a conclusão")
    if task.status != "done":
        raise HTTPException(status_code=400, detail="Tarefa ainda não foi concluída")

    task.status = "pending"
    task.completed_by = None
    task.completed_at = None
    task.approved_by = None
    task.approved_at = None
    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    text = f"👎 {current_user.full_name or current_user.email} reprovou a conclusão da tarefa \"{task.title}\" — precisa ser refeita."
    await _write_task_history_and_maybe_notify(db, conv, current_user, task, "rejected", text)

    return APIResponse(success=True, data=task_data)


class PauseTaskRequest(BaseModel):
    reason: str
    # Opcional — pra não cair no esquecimento com a tarefa pausada.
    # task_pause_reminder_watchdog.py dispara um aviso na timeline quando
    # vence (ver pause_reminder_at em InternalTask).
    reminder_at: Optional[datetime] = None


@router_internal_chat.post("/tasks/{task_id}/pause")
async def pause_internal_task(
    task_id: int,
    payload: PauseTaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Pausa a tarefa — SEMPRE exige justificativa (pedido explícito: toda
    pausa precisa vir com um motivo registrado, não é um toggle simples).
    Mesma permissão de concluir/reabrir: criador ou responsável, não
    qualquer participante da conversa."""
    task, conv = _require_task_participant(db, task_id, current_user.id)
    if current_user.id not in (task.created_by, task.assigned_to):
        raise HTTPException(status_code=403, detail="Só quem criou ou é responsável pela tarefa pode pausá-la")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Justificativa é obrigatória para pausar a tarefa")
    if task.status == "done":
        raise HTTPException(status_code=400, detail="Tarefa já concluída não pode ser pausada")
    if task.status == "cancelled":
        raise HTTPException(status_code=400, detail="Tarefa cancelada não pode ser pausada")
    if task.status == "paused":
        raise HTTPException(status_code=400, detail="Tarefa já está pausada")
    reminder_at = _naive_utc(payload.reminder_at) if payload.reminder_at else None
    if reminder_at and reminder_at <= datetime.utcnow():
        raise HTTPException(status_code=400, detail="Lembrete precisa ser numa data futura")

    task.status = "paused"
    task.paused_by = current_user.id
    task.paused_at = datetime.utcnow()
    task.pause_reason = reason
    task.pause_reminder_at = reminder_at
    task.pause_reminder_notified_at = None
    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    text = f"⏸️ {current_user.full_name or current_user.email} pausou a tarefa \"{task.title}\": {reason}"
    await _write_task_history_and_maybe_notify(db, conv, current_user, task, "paused", text, reason=reason)

    return APIResponse(success=True, data=task_data)


@router_internal_chat.post("/tasks/{task_id}/resume")
async def resume_internal_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Retoma uma tarefa pausada, voltando pra pending. Não exige
    justificativa (só pausar exige) — o motivo da pausa fica preservado pra
    sempre no histórico (InternalTaskHistory.reason); só os campos "ativos"
    da pausa na tarefa em si são limpos."""
    task, conv = _require_task_participant(db, task_id, current_user.id)
    if current_user.id not in (task.created_by, task.assigned_to):
        raise HTTPException(status_code=403, detail="Só quem criou ou é responsável pela tarefa pode retomá-la")
    if task.status != "paused":
        raise HTTPException(status_code=400, detail="Tarefa não está pausada")

    task.status = "pending"
    task.paused_by = None
    task.paused_at = None
    task.pause_reason = None
    task.pause_reminder_at = None
    task.pause_reminder_notified_at = None
    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    text = f"▶️ {current_user.full_name or current_user.email} retomou a tarefa \"{task.title}\"."
    await _write_task_history_and_maybe_notify(db, conv, current_user, task, "resumed", text)

    return APIResponse(success=True, data=task_data)


class CancelTaskRequest(BaseModel):
    reason: str


@router_internal_chat.post("/tasks/{task_id}/cancel")
async def cancel_internal_task(
    task_id: int,
    payload: CancelTaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Cancela a tarefa — estado terminal (como "done"), mas distinto dele:
    não foi feita, não vai ser. SEMPRE exige justificativa, mesmo padrão de
    pausar (ver pause_internal_task) — pedido explícito: sem isso, tarefas
    canceladas eram indistinguíveis de pendentes normais na faixa do chat.
    Mesma permissão de concluir/pausar: criador ou responsável."""
    task, conv = _require_task_participant(db, task_id, current_user.id)
    if current_user.id not in (task.created_by, task.assigned_to):
        raise HTTPException(status_code=403, detail="Só quem criou ou é responsável pela tarefa pode cancelá-la")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Justificativa é obrigatória para cancelar a tarefa")
    if task.status == "done":
        raise HTTPException(status_code=400, detail="Tarefa já concluída não pode ser cancelada")
    if task.status == "cancelled":
        raise HTTPException(status_code=400, detail="Tarefa já está cancelada")

    task.status = "cancelled"
    task.cancelled_by = current_user.id
    task.cancelled_at = datetime.utcnow()
    task.cancel_reason = reason
    # Cancelar sai de qualquer pausa em curso — os dois estados não convivem
    # (mesmos 3 campos "ativos" de pause_internal_task, limpos aqui).
    task.paused_by = None
    task.paused_at = None
    task.pause_reason = None
    task.pause_reminder_at = None
    task.pause_reminder_notified_at = None
    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    text = f"🚫 {current_user.full_name or current_user.email} cancelou a tarefa \"{task.title}\": {reason}"
    await _write_task_history_and_maybe_notify(db, conv, current_user, task, "cancelled", text, reason=reason)

    return APIResponse(success=True, data=task_data)


@router_internal_chat.post("/tasks/{task_id}/uncancel")
async def uncancel_internal_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reativa uma tarefa cancelada, voltando pra pending — mesmo padrão de
    retomar uma pausa (não exige justificativa; o motivo do cancelamento
    fica preservado pra sempre no histórico)."""
    task, conv = _require_task_participant(db, task_id, current_user.id)
    if current_user.id not in (task.created_by, task.assigned_to):
        raise HTTPException(status_code=403, detail="Só quem criou ou é responsável pela tarefa pode reativá-la")
    if task.status != "cancelled":
        raise HTTPException(status_code=400, detail="Tarefa não está cancelada")

    task.status = "pending"
    task.cancelled_by = None
    task.cancelled_at = None
    task.cancel_reason = None
    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    text = f"↩️ {current_user.full_name or current_user.email} reativou a tarefa cancelada \"{task.title}\"."
    await _write_task_history_and_maybe_notify(db, conv, current_user, task, "uncancelled", text)

    return APIResponse(success=True, data=task_data)


class CreateSubtaskRequest(BaseModel):
    title: str


@router_internal_chat.post("/tasks/{task_id}/subtasks")
async def create_task_subtask(
    task_id: int,
    payload: CreateSubtaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Título do item é obrigatório")
    task, conv = _require_task_participant(db, task_id, current_user.id)

    next_position = (max((s.position for s in task.subtasks), default=-1)) + 1
    db.add(InternalTaskSubtask(task_id=task.id, title=title, position=next_position))
    db.commit()
    task_data = await _broadcast_task(db, task, conv)
    return APIResponse(success=True, data=task_data)


class UpdateSubtaskRequest(BaseModel):
    title: Optional[str] = None
    is_done: Optional[bool] = None


@router_internal_chat.patch("/tasks/{task_id}/subtasks/{subtask_id}")
async def update_task_subtask(
    task_id: int,
    subtask_id: int,
    payload: UpdateSubtaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    task, conv = _require_task_participant(db, task_id, current_user.id)
    subtask = next((s for s in task.subtasks if s.id == subtask_id), None)
    if not subtask:
        raise HTTPException(status_code=404, detail="Item não encontrado")

    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Título do item é obrigatório")
        subtask.title = title

    just_completed = False
    if payload.is_done is not None:
        if payload.is_done != subtask.is_done and current_user.id not in (task.created_by, task.assigned_to):
            raise HTTPException(status_code=403, detail="Só quem criou ou é responsável pela tarefa pode concluir subtarefas")
        if payload.is_done and not subtask.is_done:
            just_completed = True
        subtask.is_done = payload.is_done

    db.commit()
    task_data = await _broadcast_task(db, task, conv)

    # Diferente da tarefa principal: subtarefa concluída só avisa no chat,
    # sem pedido de aprovação — é um item do checklist, não a entrega em si.
    if just_completed:
        text = f"☑️ {current_user.full_name or current_user.email} concluiu \"{subtask.title}\" (item de \"{task.title}\")."
        await _persist_and_broadcast_message(db, conv, current_user, text=text, message_type="text")

    return APIResponse(success=True, data=task_data)


@router_internal_chat.delete("/tasks/{task_id}/subtasks/{subtask_id}")
async def delete_task_subtask(
    task_id: int,
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    task, conv = _require_task_participant(db, task_id, current_user.id)
    subtask = next((s for s in task.subtasks if s.id == subtask_id), None)
    if not subtask:
        raise HTTPException(status_code=404, detail="Item não encontrado")

    db.delete(subtask)
    db.commit()
    task_data = await _broadcast_task(db, task, conv)
    return APIResponse(success=True, data=task_data)


@router_internal_chat.post("/tasks/{task_id}/attachments")
async def add_task_attachment(
    task_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Anexo de arquivo/imagem numa tarefa — mesmo padrão de upload de POST /{conversation_id}/media, sem passar pela normalização de mídia de chat (é um anexo genérico, não uma mensagem)."""
    task, conv = _require_task_participant(db, task_id, current_user.id)

    original_name = file.filename or "arquivo"
    safe_original = "".join(c if c.isalnum() or c in "._-" else "_" for c in original_name)
    safe_name = f"{uuid.uuid4().hex}_{safe_original}"
    file_path = UPLOAD_DIR / safe_name
    content = await file.read()
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    db.add(InternalTaskAttachment(
        task_id=task.id, uploaded_by=current_user.id, file_url=f"/uploads/{safe_name}",
        filename=original_name, mime_type=file.content_type or "application/octet-stream",
    ))
    db.commit()
    task_data = await _broadcast_task(db, task, conv)
    return APIResponse(success=True, data=task_data)


@router_internal_chat.delete("/tasks/{task_id}/attachments/{attachment_id}")
async def delete_task_attachment(
    task_id: int,
    attachment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    task, conv = _require_task_participant(db, task_id, current_user.id)
    attachment = next((a for a in task.attachments if a.id == attachment_id), None)
    if not attachment:
        raise HTTPException(status_code=404, detail="Anexo não encontrado")

    db.delete(attachment)
    db.commit()
    task_data = await _broadcast_task(db, task, conv)
    return APIResponse(success=True, data=task_data)


class ForwardRequest(BaseModel):
    target_conversation_ids: List[int]


@router_internal_chat.post("/{conversation_id}/messages/{message_id}/forward")
async def forward_internal_message(
    conversation_id: int,
    message_id: int,
    payload: ForwardRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_participant(db, conversation_id, current_user.id)
    original = db.query(InternalMessage).filter(
        InternalMessage.id == message_id, InternalMessage.conversation_id == conversation_id,
    ).first()
    if not original or original.is_deleted:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    if not payload.target_conversation_ids:
        raise HTTPException(status_code=400, detail="Selecione ao menos uma conversa de destino")

    results = []
    for target_id in payload.target_conversation_ids:
        target_conv = _require_participant(db, target_id, current_user.id)
        message_data = await _persist_and_broadcast_message(
            db, target_conv, current_user,
            text=original.text, message_type=original.message_type,
            media_url=original.media_url, mime_type=original.mime_type, filename=original.filename,
        )
        results.append(message_data)

    return APIResponse(success=True, data=results)


class ForwardToWhatsAppRequest(BaseModel):
    target_conversation_ids: List[int]


@router_internal_chat.post("/messages/{message_id}/forward-to-whatsapp")
async def forward_internal_message_to_whatsapp(
    message_id: int,
    payload: ForwardToWhatsAppRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Encaminha uma mensagem do chat interno pra uma ou mais conversas de
    cliente/WhatsApp — usado tanto pra repassar uma resposta pronta digitada
    por um colega quanto uma mídia recebida internamente. Não leva nenhuma
    marca de "encaminhado do chat interno" na mensagem enviada ao cliente
    (isso é conteúdo interno, não deve vazar pro WhatsApp da pessoa).
    """
    msg = db.query(InternalMessage).filter(InternalMessage.id == message_id).first()
    if not msg or msg.is_deleted:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    _require_participant(db, msg.conversation_id, current_user.id)
    if not payload.target_conversation_ids:
        raise HTTPException(status_code=400, detail="Selecione ao menos uma conversa de cliente")

    from backend.api.routes import send_forwarded_message_to_conversation
    from backend.database.models import Conversation

    media_path = Path(msg.media_url.lstrip("/")) if msg.media_url and msg.message_type != "text" else None
    media_type = msg.message_type if msg.message_type != "text" else None

    results = []
    for target_id in payload.target_conversation_ids:
        target_conv = db.query(Conversation).filter(Conversation.id == target_id).first()
        if not target_conv or not target_conv.contact:
            results.append({"conversation_id": target_id, "success": False, "error": "Conversa não encontrada"})
            continue
        try:
            wamid = await send_forwarded_message_to_conversation(
                db, target_conv, text=(msg.text or None),
                media_path=media_path, media_type=media_type,
                mime_type=msg.mime_type, filename=msg.filename,
            )
            results.append({"conversation_id": target_id, "success": bool(wamid), "wamid": wamid})
        except HTTPException as e:
            results.append({"conversation_id": target_id, "success": False, "error": e.detail})
        except Exception as e:
            logger.error(f"Erro ao encaminhar mensagem interna {message_id} pra conversa {target_id}: {e}", exc_info=True)
            results.append({"conversation_id": target_id, "success": False, "error": str(e)})

    return APIResponse(success=True, data=results)


# GRUPO AVANÇADO (Fase 4) — participantes, admin, nome/foto

def _conversation_public_fields(conv: InternalConversation) -> dict:
    """
    Versão do brief SEM campos por-visualizador (unread_count/my_is_admin) —
    usada só pra broadcast de "grupo mudou" (nome/foto/participantes), onde o
    mesmo payload vai pra todo mundo e cada front mescla por cima do que já
    tinha localmente, preservando o que é individual de cada um.
    """
    return {
        "id": conv.id,
        "is_group": conv.is_group,
        "is_pinned": bool(conv.is_pinned),
        "name": conv.name,
        "photo_url": conv.photo_url,
        "participants": [
            {
                "id": p.user_id, "full_name": p.user.full_name or p.user.email, "is_admin": p.is_admin,
                "email": p.user.email, "role": p.user.role, "sector": p.user.sector, "photo_url": p.user.photo_url,
            }
            for p in conv.participant_rows
        ],
    }


def _require_admin(conv: InternalConversation, user_id: int) -> InternalConversationParticipant:
    row = _my_participant_row(conv, user_id)
    if not row or not row.is_admin:
        raise HTTPException(status_code=403, detail="Só administradores do grupo podem fazer isso")
    return row


class AddParticipantsRequest(BaseModel):
    user_ids: List[int]


@router_internal_chat.post("/{conversation_id}/participants")
async def add_participants(
    conversation_id: int,
    payload: AddParticipantsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    if not conv.is_group:
        raise HTTPException(status_code=400, detail="Só é possível adicionar participantes em grupos")

    existing_ids = {p.user_id for p in conv.participant_rows}
    new_ids = {uid for uid in payload.user_ids if uid not in existing_ids}
    if not new_ids:
        raise HTTPException(status_code=400, detail="Nenhum usuário novo pra adicionar")

    valid_users = db.query(User.id).filter(User.id.in_(new_ids), User.is_active == True).all()  # noqa: E712
    valid_ids = {u.id for u in valid_users}
    if len(valid_ids) != len(new_ids):
        raise HTTPException(status_code=400, detail="Algum usuário selecionado não existe ou está inativo")

    db.add_all([InternalConversationParticipant(conversation_id=conversation_id, user_id=uid) for uid in valid_ids])
    db.commit()
    db.refresh(conv)

    public_fields = _conversation_public_fields(conv)
    existing_participant_ids = [p.user_id for p in conv.participant_rows if p.user_id not in valid_ids]
    await ws_manager.notify_internal_chat_updated(existing_participant_ids, public_fields)
    # Quem acabou de entrar recebe como conversa nova (aparece na lista dele).
    await ws_manager.notify_internal_chat_created(list(valid_ids), _conversation_brief(db, conv, next(iter(valid_ids))))

    return APIResponse(success=True, data=_conversation_brief(db, conv, current_user.id))


@router_internal_chat.delete("/{conversation_id}/participants/{user_id}")
async def remove_participant(
    conversation_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    if not conv.is_group:
        raise HTTPException(status_code=400, detail="DM não tem participantes pra remover")

    target_row = next((p for p in conv.participant_rows if p.user_id == user_id), None)
    if not target_row:
        raise HTTPException(status_code=404, detail="Esse usuário não está no grupo")

    is_self_leave = user_id == current_user.id
    if not is_self_leave:
        _require_admin(conv, current_user.id)

    admins = [p for p in conv.participant_rows if p.is_admin]
    remaining_after = [p for p in conv.participant_rows if p.user_id != user_id]
    if target_row.is_admin and len(admins) == 1 and remaining_after:
        raise HTTPException(
            status_code=400,
            detail="Você é o único administrador do grupo — promova outra pessoa a admin antes de sair/remover.",
        )

    db.delete(target_row)
    db.commit()
    db.refresh(conv)

    remaining_ids = [p.user_id for p in conv.participant_rows]
    if remaining_ids:
        await ws_manager.notify_internal_chat_updated(remaining_ids, _conversation_public_fields(conv))
    await ws_manager.notify_internal_chat_removed(user_id, conversation_id)

    return APIResponse(success=True, data={"conversation_id": conversation_id, "user_id": user_id})


class SetAdminRequest(BaseModel):
    is_admin: bool


@router_internal_chat.post("/{conversation_id}/participants/{user_id}/admin")
async def set_participant_admin(
    conversation_id: int,
    user_id: int,
    payload: SetAdminRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    if not conv.is_group:
        raise HTTPException(status_code=400, detail="DM não tem administrador")
    _require_admin(conv, current_user.id)

    target_row = next((p for p in conv.participant_rows if p.user_id == user_id), None)
    if not target_row:
        raise HTTPException(status_code=404, detail="Esse usuário não está no grupo")

    admins = [p for p in conv.participant_rows if p.is_admin]
    if not payload.is_admin and target_row.is_admin and len(admins) == 1:
        raise HTTPException(status_code=400, detail="Não é possível remover o único administrador — promova outra pessoa antes.")

    target_row.is_admin = payload.is_admin
    db.commit()
    db.refresh(conv)

    participant_ids = [p.user_id for p in conv.participant_rows]
    await ws_manager.notify_internal_chat_updated(participant_ids, _conversation_public_fields(conv))
    return APIResponse(success=True, data=_conversation_public_fields(conv))


class UpdateGroupRequest(BaseModel):
    name: str


@router_internal_chat.patch("/{conversation_id}")
async def update_internal_group(
    conversation_id: int,
    payload: UpdateGroupRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    if not conv.is_group:
        raise HTTPException(status_code=400, detail="DM não tem nome editável")
    _require_admin(conv, current_user.id)

    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nome do grupo não pode ser vazio")

    conv.name = name
    db.commit()
    db.refresh(conv)

    participant_ids = [p.user_id for p in conv.participant_rows]
    await ws_manager.notify_internal_chat_updated(participant_ids, _conversation_public_fields(conv))
    return APIResponse(success=True, data=_conversation_public_fields(conv))


@router_internal_chat.post("/{conversation_id}/photo")
async def update_internal_group_photo(
    conversation_id: int,
    photo: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conv = _require_participant(db, conversation_id, current_user.id)
    if not conv.is_group:
        raise HTTPException(status_code=400, detail="DM não tem foto editável")
    _require_admin(conv, current_user.id)

    original_name = photo.filename or "foto.jpg"
    safe_original = "".join(c if c.isalnum() or c in "._-" else "_" for c in original_name)
    safe_name = f"{uuid.uuid4().hex}_{safe_original}"
    file_path = UPLOAD_DIR / safe_name
    content = await photo.read()
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    conv.photo_url = f"/uploads/{safe_name}"
    db.commit()
    db.refresh(conv)

    participant_ids = [p.user_id for p in conv.participant_rows]
    await ws_manager.notify_internal_chat_updated(participant_ids, _conversation_public_fields(conv))
    return APIResponse(success=True, data=_conversation_public_fields(conv))
