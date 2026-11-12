"""
Rotas exclusivas do provider Baileys.
Funcionalidades não disponíveis na Meta Cloud API:
  - Mensagens avançadas (sticker, GIF, view-once, poll, menções, editar, apagar, fixar)
  - Gerenciamento de grupos
  - Perfil e privacidade
  - Presença (typing indicator)
  - Gerenciamento de chats (arquivar, mutar, fixar chat)
  - Verificação de contatos
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import List, Optional, Any, Dict
import logging

from backend.database.connection import get_db
from backend.api.routes import get_provider, _get_account, _get_contact_and_conversation
from backend.api.permissions import require_permission, user_has_permission
from backend.api.routes_auth import get_current_user
from backend.providers.baileys_provider import BaileysProvider
from backend.providers.wppconnect_provider import WPPConnectProvider
from backend.providers.whatsapp_web_js_provider import WhatsAppWebJsProvider
from backend.database.models import Contact, Conversation, WhatsAppAccount, PendingChange
from backend.services.conversation_service import conversation_service

logger = logging.getLogger(__name__)

# Providers que implementam o mesmo conjunto de métodos avançados (grupos,
# perfil, reações, etc.) usado por estas rotas. Venom fica de fora — seu
# envio básico está quebrado na versão instalada (bug de terceiros na
# injeção do WAPI, "Chat not found"/"undefined reading sendTextMessage"),
# não faz sentido expor a API avançada num provider cujo básico não funciona.
_FULL_API_PROVIDERS = (BaileysProvider, WPPConnectProvider, WhatsAppWebJsProvider)


def _queue_pending_change(db: Session, user, account_id: Optional[int], change_type: str, payload: dict) -> Dict[str, Any]:
    """
    Grava a ação em vez de executá-la na hora — usado quando o papel do usuário
    está marcado 'require_approval' para a permissão da rota (ver
    backend/api/permissions.py). Aprovação/rejeição em routes_admin.py
    /pending-changes; a execução deferida acontece lá, não aqui.
    """
    account = _get_account(db, account_id)
    pc = PendingChange(
        account_id=account.id if account else account_id,
        requested_by=user.id,
        change_type=change_type,
        payload=payload,
        status="pending",
    )
    db.add(pc)
    db.commit()
    db.refresh(pc)

    try:
        import asyncio
        from backend.api.websocket import ws_manager
        asyncio.create_task(ws_manager.broadcast_pending_change({
            "id": pc.id,
            "change_type": pc.change_type,
            "requested_by": user.email,
        }))
    except Exception:
        logger.warning("[PendingChange] Falha ao notificar via WebSocket", exc_info=True)

    return {
        "success": True,
        "pending": True,
        "pending_change_id": pc.id,
        "message": "Sua solicitação foi enviada para aprovação de um administrador.",
    }

router_baileys = APIRouter(
    prefix="/api/baileys",
    tags=["Baileys"],
    # Nenhuma rota aqui é webhook externo (todas são ações do usuário logado
    # sobre a sessão WhatsApp real — apagar msg, gerenciar grupo, bloquear
    # contato, etc.) — antes disso, ZERO delas exigia autenticação, então
    # qualquer um que alcançasse o servidor conseguia agir na conta real sem
    # login nenhum. Isso é o piso (exige token válido); enforcement por papel
    # fino (feature_group_manage etc.) vem depois, rota a rota.
    dependencies=[Depends(get_current_user)],
)


class _Base(BaseModel):
    """Base para todos os payloads Baileys — carrega account_id opcional."""
    account_id: Optional[int] = Field(None, description="ID da conta Baileys. Se omitido, usa a conta ativa.")


def _get_baileys(db: Session, account_id: Optional[int] = None):
    """Retorna o provider da conta informada (ou a primeira ativa), desde que
    implemente a API avançada (Baileys, WPPConnect ou WhatsApp-Web.js)."""
    try:
        provider, provider_type = get_provider(db, account_id)
    except HTTPException:
        raise
    if not isinstance(provider, _FULL_API_PROVIDERS):
        raise HTTPException(
            400,
            f"A conta selecionada usa o provider '{provider_type}', que não suporta "
            "estas funcionalidades avançadas. Disponível para contas Baileys, "
            "WPPConnect ou WhatsApp-Web.js."
        )
    return provider


# ── Schemas ────────────────────────────────────────────────────────────────────

class StickerPayload(_Base):
    to: str
    url: Optional[str] = ""
    file_b64: Optional[str] = None
    mime_type: Optional[str] = None
    reply_to: Optional[str] = None

class GifPayload(_Base):
    to: str
    url: Optional[str] = ""
    caption: str = ""
    file_b64: Optional[str] = None
    reply_to: Optional[str] = None

class ViewOncePayload(_Base):
    to: str
    media_type: str = Field(..., description="image | video")
    url: Optional[str] = ""
    caption: str = ""
    file_b64: Optional[str] = None
    mime_type: Optional[str] = None

class PollPayload(_Base):
    to: str
    question: str
    options: List[str] = Field(..., min_length=2)
    selectable_count: int = 1

class ContactCardPayload(_Base):
    to: str
    contacts: List[Dict[str, Any]] = Field(..., description="Lista de contatos com full_name, phones, etc.")

class MentionsPayload(_Base):
    to: str
    text: str
    mentioned_jids: List[str]
    reply_to: Optional[str] = None

class ForwardPayload(_Base):
    to: str
    message_id: str
    from_jid: str

class ReactionPayload(_Base):
    to: str
    message_id: str
    emoji: str
    from_me: bool = False

class MarkReadPayload(_Base):
    jid: str
    message_id: str
    participant_jid: Optional[str] = None

class EditMessagePayload(_Base):
    to: str
    message_id: str
    new_text: str

class DeleteMessagePayload(_Base):
    to: str
    message_id: str
    for_everyone: bool = True

class PinMessagePayload(_Base):
    to: str
    message_id: str
    duration: int = Field(604800, description="Duração em segundos: 86400=24h, 604800=7d, 2592000=30d")

class StarMessagePayload(_Base):
    to: str
    message_id: str
    starred: bool = True

# Grupos
class GroupCreatePayload(_Base):
    subject: str
    participants: List[str]

class GroupParticipantsPayload(_Base):
    group_jid: str
    participants: List[str]

class GroupSubjectPayload(_Base):
    group_jid: str
    subject: str

class GroupDescriptionPayload(_Base):
    group_jid: str
    description: str

class GroupJidPayload(_Base):
    group_jid: str

class GroupJoinPayload(_Base):
    invite_link: str

class GroupAnnouncePayload(_Base):
    group_jid: str
    announce: bool

class GroupJoinRequestUpdatePayload(_Base):
    group_jid: str
    participants: List[str]
    action: str = Field(..., description="approve | reject")

class GroupDisappearingPayload(_Base):
    group_jid: str
    duration: int = Field(..., description="0=off, 86400=24h, 604800=7d, 7776000=90d")

# Perfil e privacidade
class ProfilePictureGetPayload(_Base):
    jid: str
    high_res: bool = False

class ProfilePictureUpdatePayload(_Base):
    image_b64: str

class UpdateStatusPayload(_Base):
    status: str

class UpdateNamePayload(_Base):
    name: str

class JidPayload(_Base):
    jid: str

class PhonePayload(_Base):
    phone: str

class PrivacyUpdatePayload(_Base):
    setting: str = Field(..., description="last_seen | online | profile_photo | status | read_receipts | groups_add")
    value: str = Field(..., description="all | contacts | contact_blacklist | none")

# Presença
class PresencePayload(_Base):
    to: str
    presence_type: str = Field(..., description="available | unavailable | composing | paused | recording")

class SubscribePresencePayload(_Base):
    jid: str

# Chat management
class ArchiveChatPayload(_Base):
    jid: str
    archive: bool = True

class MuteChatPayload(_Base):
    jid: str
    duration_ms: Optional[int] = Field(None, description="None=desmutar, 28800000=8h, 604800000=7d")

class PinChatPayload(_Base):
    jid: str
    pinned: bool = True

class DisappearingPayload(_Base):
    jid: str
    duration: int = Field(..., description="0=off, 86400=24h, 604800=7d, 7776000=90d")


# ── Mensagens avançadas ────────────────────────────────────────────────────────

@router_baileys.post("/send/sticker", summary="Enviar sticker")
async def send_sticker(payload: StickerPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.send_sticker(
        to=payload.to, url=payload.url or "",
        file_b64=payload.file_b64, mime_type=payload.mime_type,
        reply_to=payload.reply_to,
    )

@router_baileys.post("/send/gif", summary="Enviar GIF")
async def send_gif(payload: GifPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.send_gif(
        to=payload.to, url=payload.url or "", caption=payload.caption,
        file_b64=payload.file_b64, reply_to=payload.reply_to,
    )

@router_baileys.post("/send/view-once", summary="Enviar mídia view-once (auto-destruição)")
async def send_view_once(payload: ViewOncePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.send_view_once(
        to=payload.to, media_type=payload.media_type,
        url=payload.url or "", caption=payload.caption,
        file_b64=payload.file_b64, mime_type=payload.mime_type,
    )

@router_baileys.post("/send/poll", summary="Enviar enquete")
async def send_poll(payload: PollPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    result = await provider.send_poll(
        to=payload.to, question=payload.question,
        options=payload.options, selectable_count=payload.selectable_count,
    )

    if not result.get("success", True):
        raise HTTPException(status_code=502, detail=f"[baileys] {result.get('error', 'Falha ao enviar enquete')}")

    # Enquete não tem tipo próprio no modelo de mensagem — salva como texto
    # formatado (pergunta + opções) para aparecer na conversa local, já que
    # este endpoint (ao contrário de /api/send/*) não persistia nada antes.
    account = _get_account(db, payload.account_id)
    wamid = result.get("message_id") or f"baileys_poll_{payload.to}"
    poll_text = f"📊 {payload.question}\n" + "\n".join(f"☐ {opt}" for opt in payload.options)

    contact, conversation = _get_contact_and_conversation(
        db, payload.to, account.id if account else None
    )
    conversation_service.save_outbound_message(
        db=db,
        wamid=wamid,
        conversation_id=conversation.id,
        contact_id=contact.id,
        message_type="text",
        message_text=poll_text,
    )

    return result

@router_baileys.post("/send/contact-card", summary="Enviar cartão de contato (vCard)")
async def send_contact_card(payload: ContactCardPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.send_contact_card(to=payload.to, contacts=payload.contacts)

@router_baileys.post("/send/mentions", summary="Enviar mensagem com @menções")
async def send_mentions(payload: MentionsPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.send_with_mentions(
        to=payload.to, text=payload.text,
        mentioned_jids=payload.mentioned_jids, reply_to=payload.reply_to,
    )

@router_baileys.post("/send/forward", summary="Encaminhar mensagem")
async def forward_message(payload: ForwardPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.forward_message(
        to=payload.to, message_id=payload.message_id, from_jid=payload.from_jid,
    )

@router_baileys.post("/message/edit", summary="Editar mensagem enviada")
async def edit_message(payload: EditMessagePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.edit_message(
        to=payload.to, message_id=payload.message_id, new_text=payload.new_text,
    )

@router_baileys.post("/message/delete", summary="Apagar mensagem")
async def delete_message(payload: DeleteMessagePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.delete_message(
        to=payload.to, message_id=payload.message_id, for_everyone=payload.for_everyone,
    )

@router_baileys.post("/send/reaction", summary="Reagir a uma mensagem com emoji")
async def send_reaction(payload: ReactionPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.send_reaction(
        to=payload.to, message_id=payload.message_id, emoji=payload.emoji, from_me=payload.from_me,
    )

@router_baileys.post("/message/read", summary="Marcar mensagem/conversa como lida")
async def mark_read(payload: MarkReadPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.mark_read(
        jid=payload.jid, message_id=payload.message_id, participant_jid=payload.participant_jid,
    )

@router_baileys.post("/message/pin", summary="Fixar/desafixar mensagem")
async def pin_message(payload: PinMessagePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.pin_message(
        to=payload.to, message_id=payload.message_id, duration=payload.duration,
    )

@router_baileys.post("/message/star", summary="Favoritar/desfavoritar mensagem")
async def star_message(payload: StarMessagePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.star_message(
        to=payload.to, message_id=payload.message_id, starred=payload.starred,
    )


# ── Grupos ─────────────────────────────────────────────────────────────────────

@router_baileys.post("/group/create", summary="Criar grupo")
async def group_create(payload: GroupCreatePayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    result = await provider.group_create(subject=payload.subject, participants=payload.participants)

    # Cria Contact + Conversation no banco para o grupo aparecer na lista
    group_jid = None
    if isinstance(result, dict):
        if "group" in result and isinstance(result["group"], dict):
            group_jid = result["group"].get("id")
        else:
            group_jid = result.get("group_jid")
            
    if group_jid:
        try:
            account = db.query(WhatsAppAccount).filter(
                WhatsAppAccount.id == payload.account_id
            ).first() if payload.account_id else None

            # Usa conversation_service (mesmo caminho do /api/send/*) em vez de
            # criar a Conversation manualmente sem group_jid — sem group_jid,
            # get_or_create_conversation() (que casa grupos por group_jid, não
            # contact_id) não reconhece essa conversa depois e cria uma segunda
            # ("chat fantasma") no primeiro envio para o grupo.
            contact = conversation_service.get_or_create_contact(
                db, group_jid, group_jid, name=payload.subject, is_group=True,
            )
            conversation_service.get_or_create_conversation(
                db,
                contact.id,
                account_id=account.id if account else None,
                is_group=True,
                group_jid=group_jid,
                group_name=payload.subject,
            )
        except Exception as e:
            logger.warning("Não foi possível criar conversa do grupo: %s", e)
            db.rollback()

    return result

@router_baileys.post("/group/participants/add", summary="Adicionar participantes ao grupo")
async def group_add(payload: GroupParticipantsPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_participants_add(group_jid, payload.participants)

@router_baileys.post("/group/participants/remove", summary="Remover participantes do grupo")
async def group_remove(payload: GroupParticipantsPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_participants_remove(group_jid, payload.participants)

@router_baileys.post("/group/admins/promote", summary="Promover participantes a administradores")
async def group_promote(payload: GroupParticipantsPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_admins_promote(group_jid, payload.participants)

@router_baileys.post("/group/admins/demote", summary="Rebaixar administradores a participantes")
async def group_demote(payload: GroupParticipantsPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_admins_demote(group_jid, payload.participants)

@router_baileys.post("/group/subject", summary="Alterar nome do grupo")
async def group_subject(payload: GroupSubjectPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_subject_update(group_jid, payload.subject)

@router_baileys.post("/group/description", summary="Alterar descrição do grupo")
async def group_description(payload: GroupDescriptionPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_description_update(group_jid, payload.description)

@router_baileys.post("/group/leave", summary="Sair do grupo")
async def group_leave(payload: GroupJidPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_leave(group_jid)

@router_baileys.post("/group/invite-code", summary="Obter link de convite do grupo")
async def group_invite_code(payload: GroupJidPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_invite_code_get(group_jid)

@router_baileys.post("/group/invite-code/revoke", summary="Revogar e gerar novo link de convite")
async def group_revoke_invite(payload: GroupJidPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_invite_code_revoke(group_jid)

@router_baileys.post("/group/metadata", summary="Obter metadados do grupo (participantes, admins, etc.)")
async def group_metadata(payload: GroupJidPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_metadata_get(group_jid)

@router_baileys.post("/group/join", summary="Entrar em grupo via link de convite")
async def group_join(payload: GroupJoinPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    return await provider.group_join_via_link(payload.invite_link)

@router_baileys.post("/group/join-requests", summary="Obter lista de pedidos de entrada no grupo")
async def group_join_requests(payload: GroupJidPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_get_join_requests(group_jid)

@router_baileys.post("/group/join-requests/update", summary="Aprovar/rejeitar pedidos de entrada no grupo")
async def group_update_join_request(payload: GroupJoinRequestUpdatePayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_update_join_request(group_jid, payload.participants, payload.action)

@router_baileys.post("/group/announce", summary="Ativar/desativar modo anúncio (somente admins enviam)")
async def group_announce(payload: GroupAnnouncePayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_set_announce(group_jid, payload.announce)

@router_baileys.post("/group/disappearing", summary="Configurar mensagens temporárias no grupo")
async def group_disappearing(payload: GroupDisappearingPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_group_manage"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    group_jid = payload.group_jid if "@" in payload.group_jid else f"{payload.group_jid}@g.us"
    return await provider.group_set_disappearing(group_jid, payload.duration)


# ── Perfil e privacidade ───────────────────────────────────────────────────────

@router_baileys.post("/profile/picture", summary="Buscar foto de perfil de um contato/grupo")
async def get_profile_picture(payload: ProfilePictureGetPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.get_profile_picture(payload.jid, payload.high_res)

@router_baileys.post("/profile/picture/update", summary="Atualizar foto de perfil (base64)")
async def update_profile_picture(payload: ProfilePictureUpdatePayload, db: Session = Depends(get_db), decision=Depends(require_permission('profile_edit_sensitive'))):
    if decision.decision == 'require_approval':
        return _queue_pending_change(db, decision.user, payload.account_id, 'profile_picture_update', {"image_b64": payload.image_b64})
    provider = _get_baileys(db, payload.account_id)
    return await provider.update_profile_picture(payload.image_b64)

@router_baileys.post("/profile/picture/remove", summary="Remover foto de perfil")
async def remove_profile_picture(payload: _Base, db: Session = Depends(get_db), decision=Depends(require_permission('profile_edit_sensitive'))):
    if decision.decision == 'require_approval':
        return _queue_pending_change(db, decision.user, payload.account_id, 'profile_picture_remove', {})
    provider = _get_baileys(db, payload.account_id)
    return await provider.remove_profile_picture()

@router_baileys.post("/profile/status", summary="Atualizar recado/status")
async def update_status(payload: UpdateStatusPayload, db: Session = Depends(get_db), decision=Depends(require_permission('profile_edit_sensitive'))):
    if decision.decision == 'require_approval':
        return _queue_pending_change(db, decision.user, payload.account_id, 'profile_status', {"status": payload.status})
    provider = _get_baileys(db, payload.account_id)
    return await provider.update_status(payload.status)

@router_baileys.post("/profile/name", summary="Atualizar nome de exibição")
async def update_name(payload: UpdateNamePayload, db: Session = Depends(get_db), decision=Depends(require_permission('profile_edit_sensitive'))):
    if decision.decision == 'require_approval':
        return _queue_pending_change(db, decision.user, payload.account_id, 'profile_name', {"name": payload.name})
    provider = _get_baileys(db, payload.account_id)
    return await provider.update_profile_name(payload.name)

@router_baileys.post("/profile/get-status", summary="Buscar recado/status de um contato")
async def get_user_status(payload: JidPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.get_user_status(payload.jid)

@router_baileys.post("/contact/check", summary="Verificar se número existe no WhatsApp")
async def check_phone(payload: PhonePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.check_phone_exists(payload.phone)

@router_baileys.post("/contact/block", summary="Bloquear contato")
async def block_contact(payload: JidPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_chat_actions"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    return await provider.block_contact(payload.jid)

@router_baileys.post("/contact/unblock", summary="Desbloquear contato")
async def unblock_contact(payload: JidPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_chat_actions"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    return await provider.unblock_contact(payload.jid)

@router_baileys.post("/contact/blocklist", summary="Listar contatos bloqueados")
async def get_blocklist(payload: _Base, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.get_blocklist()

@router_baileys.post("/contact/business-profile", summary="Obter perfil comercial de um contato")
async def get_business_profile_contact(payload: JidPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.get_business_profile(payload.jid)

@router_baileys.post("/privacy/settings", summary="Obter configurações de privacidade")
async def get_privacy(payload: _Base, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.fetch_privacy_settings()

@router_baileys.post("/privacy/update", summary="Atualizar configuração de privacidade")
async def update_privacy(payload: PrivacyUpdatePayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_chat_actions"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    return await provider.update_privacy_setting(payload.setting, payload.value)


# ── Presença ───────────────────────────────────────────────────────────────────

@router_baileys.post("/presence/send", summary="Enviar indicador de presença (digitando, gravando...)")
async def send_presence(payload: PresencePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.send_presence(payload.to, payload.presence_type)

@router_baileys.post("/presence/subscribe", summary="Assinar atualizações de presença de um contato")
async def subscribe_presence(payload: SubscribePresencePayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.subscribe_presence(payload.jid)


# ── Chat management ────────────────────────────────────────────────────────────

@router_baileys.post("/chat/delete", summary="Apagar conversa (delete chat)")
async def chat_delete(payload: JidPayload, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_chat_actions"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    provider = _get_baileys(db, payload.account_id)
    res = await provider.chat_delete(payload.jid)
    
    # Apagar do banco de dados local para não voltar na listagem
    try:
        contact = db.query(Contact).filter(Contact.wa_id == payload.jid).first()
        if contact:
            conv = db.query(Conversation).filter(Conversation.contact_id == contact.id).first()
            if conv:
                db.delete(conv)
                db.commit()
    except Exception as e:
        db.rollback()
        print(f"Erro ao deletar conversa local: {e}")
        
    return res

@router_baileys.post("/chat/archive", summary="Arquivar/desarquivar conversa")
async def archive_chat(payload: ArchiveChatPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.archive_chat(payload.jid, payload.archive)

@router_baileys.post("/chat/mute", summary="Mutar/desmutar conversa")
async def mute_chat(payload: MuteChatPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.mute_chat(payload.jid, payload.duration_ms)

@router_baileys.post("/chat/pin", summary="Fixar/desafixar conversa")
async def pin_chat(payload: PinChatPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.pin_chat(payload.jid, payload.pinned)

@router_baileys.post("/chat/disappearing", summary="Configurar mensagens temporárias na conversa")
async def set_disappearing(payload: DisappearingPayload, db: Session = Depends(get_db)):
    provider = _get_baileys(db, payload.account_id)
    return await provider.set_disappearing_messages(payload.jid, payload.duration)
