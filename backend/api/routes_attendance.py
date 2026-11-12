"""
Atendimento — fila/atribuição/status de conversa (Fase A), tags e notas
internas (Fase B), respostas rápidas (Fase C), horário/CSAT (Fase D),
relatório de SLA/tempo de espera e resolução (Fase E).

Registrar em app.py:
    from backend.api.routes_attendance import router_attendance
    app.include_router(router_attendance, prefix="/api", tags=["Atendimento"])
"""

import logging
import re
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.database.models import Contact, Conversation, User, Role, Tag, InternalNote, QuickReply, CsatResponse
from backend.api.routes_auth import get_current_user
from backend.api.permissions import user_has_permission
from backend.api.websocket import ws_manager
from backend.models.schemas import APIResponse
from backend.services.conversation_service import conversation_service
from backend.utils.time_utils import to_utc_iso

logger = logging.getLogger(__name__)

router_attendance = APIRouter()

VALID_STATUSES = {"open", "pending", "resolved"}


def _user_brief(user: Optional[User]) -> Optional[dict]:
    if not user:
        return None
    return {"id": user.id, "full_name": user.full_name or user.email}


def _is_attendance_agent(db: Session, user: User) -> bool:
    """
    Papel do usuário participa da mecânica de atendimento (aparece no pool de
    atribuição/transferência, conta pra SLA)? Controlado pela permissão
    feature_attendance_agent — papéis sem essa chave (ex: um "Vendedor"
    customizado que o admin criou sem marcá-la) ficam de fora, mesma
    convenção de ausência-de-chave de api/permissions.py::_resolve_decision.
    is_admin=True sempre conta, mesmo padrão do resto do arquivo de permissões.
    """
    if getattr(user, "is_admin", False):
        return True
    role = db.query(Role).filter(Role.key == user.role).first()
    return bool(role and role.permissions.get("feature_attendance_agent") is True)


@router_attendance.get("/agents")
async def list_agents(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Lista usuários ativos pra popular o seletor de atribuição/transferência —
    diferente de GET /api/admin/users, aberto a qualquer usuário logado (um
    atendente precisa ver os nomes da equipe pra transferir uma conversa).
    Só usuários cujo papel participa da mecânica de atendimento (ver
    _is_attendance_agent) — um "Vendedor"/"Usuário simples" não deve aparecer
    aqui pra ser atribuído a uma conversa.
    """
    users = db.query(User).filter(User.is_active == True).order_by(User.full_name).all()  # noqa: E712
    agents = [u for u in users if _is_attendance_agent(db, u)]
    return APIResponse(success=True, data=[
        {"id": u.id, "full_name": u.full_name or u.email, "email": u.email, "sector": u.sector or ""}
        for u in agents
    ])


class UpdateContactNameRequest(BaseModel):
    name: Optional[str] = None
    account_id: Optional[int] = None
    is_internal: Optional[bool] = None
    notes: Optional[str] = None


@router_attendance.patch("/contacts/{contact_id}")
async def update_contact_name(
    contact_id: int,
    payload: UpdateContactNameRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Edição manual de dados do contato, feita pelo atendente direto no painel
    "Dados do contato": nome salvo, is_internal e/ou notes — todos os campos
    são opcionais, envia só o que quer mudar.

    name: por conta (ContactAccountName), não mais global em Contact.saved_name
    — cada conta WhatsApp da empresa pode ter seu próprio nome pro mesmo
    contato (Contact.wa_id é único na plataforma inteira, compartilhado entre
    contas). Requer account_id no payload; sem ele, cai no comportamento
    legado (grava direto em Contact.saved_name, compartilhado entre contas —
    só acontece com um frontend desatualizado em cache).

    is_internal: marca o contato como interno (colega/fornecedor falando
    pelo número da empresa) — daí em diante essa conversa nunca mais é
    encaminhada pro bot/IA, não dispara aviso de fora-do-horário nem CSAT, e
    sai do cálculo de sla_breaches_now (ver webhook_handler.py e
    attendance_reports abaixo).

    notes: observações internas de texto livre sobre o cliente — diferente
    de name, string vazia é um valor válido (apaga a observação), por isso o
    gate é "campo veio no payload" (not None), não "campo não é vazio".
    """
    contact = db.query(Contact).filter(Contact.id == contact_id).first()
    if not contact:
        raise HTTPException(status_code=404, detail="Contato não encontrado")

    resolved_saved_name = contact.saved_name
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Nome não pode ser vazio")
        if payload.account_id is not None:
            conversation_service._upsert_contact_account_name(db, contact.id, payload.account_id, name)
            resolved_saved_name = name
        else:
            logger.warning(
                "PATCH /contacts/%s sem account_id — gravando em Contact.saved_name (legado, compartilhado entre contas)",
                contact_id,
            )
            contact.saved_name = name
            resolved_saved_name = name

    if payload.is_internal is not None:
        contact.is_internal = payload.is_internal

    if payload.notes is not None:
        contact.notes = payload.notes.strip() or None

    db.commit()

    return APIResponse(success=True, data={
        "id": contact.id, "saved_name": resolved_saved_name, "is_internal": contact.is_internal,
        "notes": contact.notes,
    })


def _internal_contact_brief(contact: Contact) -> dict:
    return {
        "id": contact.id,
        "wa_id": contact.wa_id,
        "phone_number": contact.phone_number,
        "name": contact.saved_name or contact.name or contact.push_name,
        "is_group": contact.is_group,
        "group_subject": contact.group_subject,
    }


@router_attendance.get("/contacts/internal")
async def list_internal_contacts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Lista central de todos os contatos/grupos marcados como internos — tela
    "Contatos internos" em Configurações, pra não precisar abrir conversa por
    conversa pra saber (ou mudar) quem está marcado.
    """
    contacts = db.query(Contact).filter(Contact.is_internal == True).order_by(Contact.saved_name, Contact.name).all()  # noqa: E712
    return APIResponse(success=True, data=[_internal_contact_brief(c) for c in contacts])


class AddInternalContactRequest(BaseModel):
    phone_number: str


@router_attendance.post("/contacts/internal")
async def add_internal_contact(
    payload: AddInternalContactRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Marca um número como interno a partir só do telefone, sem precisar que
    exista conversa alguma ainda — cria o Contact na hora se for a primeira
    vez que esse número aparece no sistema (mesmo get_or_create_contact usado
    pelo webhook), pra dar pra pré-cadastrar um número interno ANTES dele
    escrever pela primeira vez (bot nunca chega a responder nem a 1ª mensagem).
    """
    _require_internal_contacts_permission(db, current_user)
    clean_number = "".join(filter(str.isdigit, payload.phone_number))
    if not clean_number:
        raise HTTPException(status_code=400, detail="Número inválido")

    contact = conversation_service.get_or_create_contact(db, clean_number, clean_number)
    contact.is_internal = True
    db.commit()
    return APIResponse(success=True, data=_internal_contact_brief(contact))


@router_attendance.delete("/contacts/internal/{contact_id}")
async def remove_internal_contact(
    contact_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Desmarca — não apaga o contato, só tira do modo 'sem bot/SLA'."""
    _require_internal_contacts_permission(db, current_user)
    contact = db.query(Contact).filter(Contact.id == contact_id).first()
    if not contact:
        raise HTTPException(status_code=404, detail="Contato não encontrado")
    contact.is_internal = False
    db.commit()
    return APIResponse(success=True, data={"id": contact.id, "is_internal": False})


class UpdateStatusRequest(BaseModel):
    status: str
    # None (padrão) mantém o comportamento de sempre: manda CSAT se estiver
    # ligado em Configurações → Automações. False deixa o atendente escolher,
    # no momento de resolver, NÃO mandar a pesquisa pra essa conversa
    # específica (ex: cliente já demonstrou insatisfação, caso sensível,
    # contato que não é o cliente final etc). True não força envio se o CSAT
    # estiver desligado globalmente — só existe mensagem configurada quando
    # a automação está ligada, então True e None têm o mesmo efeito.
    send_csat: Optional[bool] = None


@router_attendance.patch("/conversations/{conversation_id}/status")
async def update_conversation_status(
    conversation_id: int,
    payload: UpdateStatusRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if payload.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"status inválido — use um de {sorted(VALID_STATUSES)}")

    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    # BUG anterior: reenviava a pesquisa de CSAT em TODA chamada que terminasse
    # em status="resolved", mesmo quando a conversa já estava resolvida —
    # sem bloqueio de clique repetido no botão do front, um clique duplo (ou
    # vários cliques rápidos por lentidão percebida) disparava um PATCH por
    # clique, e cada um mandava a pesquisa de novo pro cliente de verdade.
    # Confirmado ao vivo: 6 envios idênticos em ~10s pro mesmo contato.
    # Só dispara CSAT na TRANSIÇÃO pra "resolved" (não estava resolvida antes).
    was_already_resolved = conversation.status == "resolved"

    conversation.status = payload.status
    conversation.resolved_at = datetime.utcnow() if payload.status == "resolved" else None
    conversation.pending_since = datetime.utcnow() if payload.status == "pending" else None
    if payload.status != "resolved":
        conversation.awaiting_csat = False

    # Bot despausa já no momento de encerrar (não só reativamente quando o
    # cliente escrever de novo, ver webhook_handler.py — aquele reset
    # continua existindo, esse aqui só antecipa o ESTADO pra ficar certo na
    # hora, sem esperar a próxima mensagem do cliente pra mostrar "não
    # pausado" no pill do ChatArea). Só muda um booleano — nunca dispara
    # mensagem nenhuma sozinho, então não tem risco de "bot disparando
    # mensagem indesejada": só quando o cliente escrever de novo é que
    # _forward_to_ai_webhook (chamado a partir de uma mensagem real recebida)
    # vai efetivamente encaminhar pra IA, exatamente como já acontecia antes.
    if payload.status == "resolved" and not was_already_resolved:
        conversation.bot_enabled = True
        conversation.bot_handoff_at = None
        conversation.bot_loop_detected = False
        conversation.bot_repeat_count = 0
        conversation.bot_forwarded_at = None
        conversation.bot_last_reply_text = None

    db.commit()

    # Dispara a pesquisa de satisfação (se ligada em Configurações → Automações
    # → CSAT) só pra 1:1 — grupo não faz sentido pedir avaliação individual.
    # Contato interno (Contact.is_internal) nunca recebe CSAT — não é cliente.
    if (
        payload.status == "resolved" and not was_already_resolved
        and not conversation.is_group and conversation.contact
        and not conversation.contact.is_internal
        and payload.send_csat is not False
    ):
        try:
            from backend.api.routes_settings import _load_settings
            from backend.api.routes import get_provider, _extract_wamid
            from backend.services.conversation_service import conversation_service

            csat = _load_settings().get("automations", {}).get("csat", {})
            if csat.get("enabled") and csat.get("message"):
                provider, provider_kind = get_provider(db, conversation.account_id)
                api_response = await provider.send_text_message(to=conversation.contact.wa_id, text=csat["message"])
                wamid = _extract_wamid(api_response, provider_kind)
                if wamid:
                    conversation_service.save_outbound_message(
                        db=db, wamid=wamid, conversation_id=conversation.id, contact_id=conversation.contact_id,
                        message_type="text", message_text=csat["message"],
                    )
                    await ws_manager.broadcast_new_message({
                        "wamid": wamid, "type": "text", "direction": "outbound", "from_number": "me",
                        "message": csat["message"], "sender": "me", "conversation_id": conversation.id,
                        "account_id": conversation.account_id, "timestamp": int(datetime.utcnow().timestamp() * 1000),
                    })
                conversation.awaiting_csat = True
                conversation.csat_sent_at = datetime.utcnow()
                db.commit()
        except Exception as e:
            logger.warning(f"Falha ao enviar pesquisa de CSAT: {e}")

    meta_update = {
        "conversation_id": conversation_id,
        "status": conversation.status,
        "pending_since": to_utc_iso(conversation.pending_since),
    }
    if payload.status == "resolved" and not was_already_resolved:
        meta_update.update({
            "bot_enabled": conversation.bot_enabled,
            "bot_handoff_at": None,
            "bot_loop_detected": False,
        })
    await ws_manager.broadcast_conversation_meta_update(meta_update)

    return APIResponse(success=True, data={"conversation_id": conversation_id, "status": conversation.status})


class UpdateBotRequest(BaseModel):
    enabled: bool


@router_attendance.patch("/conversations/{conversation_id}/bot")
async def update_conversation_bot(
    conversation_id: int,
    payload: UpdateBotRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Liga/desliga manualmente o encaminhamento dessa conversa pro webhook de
    IA (n8n ou outra ferramenta) — ver webhook_handler._forward_to_ai_webhook
    e POST /api/bot/reply em routes_ai_bot.py. Também é setado automaticamente:
    False quando um atendente manda uma mensagem real (ConversationService.
    handle_agent_outbound_reply), True quando a conversa reabre depois de
    resolvida.
    """
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    was_enabled = conversation.bot_enabled
    conversation.bot_enabled = payload.enabled
    # Desligar manualmente é handoff humano tanto quanto responder — marca o
    # mesmo momento que handle_agent_outbound_reply marcaria (ver
    # Conversation.bot_handoff_at). Religar devolve o controle ao bot, então
    # zera — uma medição futura deve contar a partir do PRÓXIMO handoff.
    if payload.enabled and conversation.bot_handoff_at is not None:
        conversation.bot_handoff_at = None
    elif not payload.enabled and was_enabled:
        conversation.bot_handoff_at = datetime.utcnow()
    # Toggle manual (pra qualquer lado) é uma intervenção humana deliberada —
    # zera o estado de detecção de loop pra não carregar sujeira de antes.
    conversation.bot_loop_detected = False
    conversation.bot_repeat_count = 0
    conversation.bot_forwarded_at = None
    conversation.bot_last_reply_text = None
    db.commit()

    await ws_manager.broadcast_conversation_meta_update({
        "conversation_id": conversation_id,
        "bot_enabled": conversation.bot_enabled,
        "bot_handoff_at": to_utc_iso(conversation.bot_handoff_at),
        "bot_loop_detected": False,
    })

    return APIResponse(success=True, data={"conversation_id": conversation_id, "bot_enabled": conversation.bot_enabled})


class UpdatePinRequest(BaseModel):
    pinned: bool


@router_attendance.patch("/conversations/{conversation_id}/pin")
async def update_conversation_pin(
    conversation_id: int,
    payload: UpdatePinRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    "Fixar Conversa" — flag própria do app, independente do pin nativo do
    protocolo WhatsApp (POST /baileys/chat/pin, que continua existindo à
    parte pra quem quiser refletir no app do celular também, mas é limitado
    a 3 chats pelo próprio WhatsApp e nem existe pra grupo em todo provider).
    Essa aqui é o que a Sidebar usa pra ordenar/mostrar o ícone — funciona
    igual pra individual e grupo, em qualquer provider.
    """
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    conversation.is_pinned = payload.pinned
    db.commit()

    await ws_manager.broadcast_conversation_meta_update({
        "conversation_id": conversation_id,
        "is_pinned": conversation.is_pinned,
    })

    return APIResponse(success=True, data={"conversation_id": conversation_id, "is_pinned": conversation.is_pinned})


class UpdateFavoriteRequest(BaseModel):
    favorite: bool


@router_attendance.patch("/conversations/{conversation_id}/favorite")
async def update_conversation_favorite(
    conversation_id: int,
    payload: UpdateFavoriteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """"Favoritar Conversa" — mesma flag-própria-do-app de is_pinned, sem relação com nenhum recurso nativo do WhatsApp."""
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    conversation.is_favorite = payload.favorite
    db.commit()

    await ws_manager.broadcast_conversation_meta_update({
        "conversation_id": conversation_id,
        "is_favorite": conversation.is_favorite,
    })

    return APIResponse(success=True, data={"conversation_id": conversation_id, "is_favorite": conversation.is_favorite})


class UpdateMutedRequest(BaseModel):
    muted: bool


@router_attendance.patch("/conversations/{conversation_id}/mute")
async def update_conversation_muted(
    conversation_id: int,
    payload: UpdateMutedRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    "Silenciar Notificações" — flag própria do app que o front usa pra não
    tocar som/popup dessa conversa (ver App.js::updateConversationListLocally).
    Independente do mute nativo do protocolo WhatsApp (POST /baileys/chat/mute,
    que segue existindo à parte, best-effort, pra quem quiser silenciar no
    app do celular também).
    """
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    conversation.is_muted = payload.muted
    db.commit()

    await ws_manager.broadcast_conversation_meta_update({
        "conversation_id": conversation_id,
        "is_muted": conversation.is_muted,
    })

    return APIResponse(success=True, data={"conversation_id": conversation_id, "is_muted": conversation.is_muted})


# CORES DO STATUS (aberta/pendente/resolvida) — cor exibida na bolinha da
# lista de conversas e no seletor de status do chat. Guardado em
# data/settings.json (mesmo store de Automações), não no banco — é
# preferência visual da equipe toda, não dado de negócio.

DEFAULT_STATUS_COLORS = {"open": "#25D366", "pending": "#f6c026", "resolved": "#8696A0"}
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


@router_attendance.get("/status-colors")
async def get_status_colors(current_user: User = Depends(get_current_user)):
    from backend.api.routes_settings import _load_settings
    settings = _load_settings()
    colors = {**DEFAULT_STATUS_COLORS, **(settings.get("status_colors") or {})}
    return APIResponse(success=True, data=colors)


class StatusColorsRequest(BaseModel):
    open: Optional[str] = None
    pending: Optional[str] = None
    resolved: Optional[str] = None


@router_attendance.patch("/status-colors")
async def update_status_colors(
    payload: StatusColorsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_attendance_config_permission(db, current_user)
    from backend.api.routes_settings import _load_settings, _save_settings

    settings = _load_settings()
    colors = {**DEFAULT_STATUS_COLORS, **(settings.get("status_colors") or {})}
    for key in ("open", "pending", "resolved"):
        value = getattr(payload, key)
        if value is None:
            continue
        if not _HEX_COLOR_RE.match(value):
            raise HTTPException(status_code=400, detail=f"Cor inválida para '{key}' — use formato hex, ex: #25D366")
        colors[key] = value

    settings["status_colors"] = colors
    _save_settings(settings)
    return APIResponse(success=True, data=colors)


class AssignRequest(BaseModel):
    user_id: Optional[int] = None


@router_attendance.post("/conversations/{conversation_id}/assign")
async def assign_conversation(
    conversation_id: int,
    payload: AssignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Atribui/transfere/libera uma conversa. Atribuir a si mesmo ou liberar
    (user_id=None) é sempre permitido sem checar conversation_assign_others —
    só atribuir a OUTRA pessoa exige essa permissão, checado aqui (não em
    Depends) porque a decisão depende do alvo, que só é conhecido depois de
    ler o body.

    BUG (2026-09-09): essa isenção pra autoatribuição cobria só o
    conversation_assign_others — nunca checava _is_attendance_agent em quem
    vira dono quando é autoatribuição, diferente do caminho de outra pessoa
    (linha abaixo). ConversationService.handle_agent_outbound_reply já tinha
    sido corrigido pra só autoatribuir quem tem feature_attendance_agent
    (usuário de papel logística, contando SLA sem dever), mas esse endpoint (usado por um botão
    "assumir"/"atribuir a mim" no front) deixava qualquer papel se
    autoatribuir e entrar na mesma contagem de SLA. Fecha o mesmo buraco
    pros dois casos.
    """
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    target_id = payload.user_id
    if target_id is not None:
        if target_id != current_user.id and not user_has_permission(db, current_user, "conversation_assign_others"):
            raise HTTPException(
                status_code=403,
                detail="Seu papel não tem permissão para atribuir conversas a outras pessoas.",
            )
        target_user = db.query(User).filter(User.id == target_id, User.is_active == True).first()  # noqa: E712
        if not target_user:
            raise HTTPException(status_code=404, detail="Usuário de destino não encontrado")
        if not _is_attendance_agent(db, target_user):
            detail = (
                "Seu papel não participa da mecânica de atendimento — você não pode assumir conversas."
                if target_id == current_user.id else
                "O papel desse usuário não participa da mecânica de atendimento — não pode receber conversas atribuídas."
            )
            raise HTTPException(status_code=400, detail=detail)

    conversation.assigned_to_user_id = target_id
    conversation.assigned_at = datetime.utcnow() if target_id else None
    # Liberar (target_id=None) devolve a conversa pra fila "agora" — sem isso
    # o badge "⏳ esperando" do Sidebar usava conversation.created_at (data de
    # criação original) como início do cronômetro, mostrando um tempo de
    # espera absurdo pra uma conversa que acabou de voltar pra fila.
    if not target_id:
        conversation.queue_since = datetime.utcnow()
    db.commit()
    db.refresh(conversation)

    assigned_to = _user_brief(conversation.assigned_to)

    await ws_manager.broadcast_conversation_meta_update({
        "conversation_id": conversation_id,
        "assigned_to": assigned_to,
        "assigned_at": to_utc_iso(conversation.assigned_at),
        "queue_since": to_utc_iso(conversation.queue_since),
    })

    return APIResponse(success=True, data={"conversation_id": conversation_id, "assigned_to": assigned_to})


def _require_attendance_config_permission(db: Session, user: User):
    """Aba Atendimento (Configurações): cores de status + etiquetas."""
    if not user_has_permission(db, user, "settings_attendance_config"):
        raise HTTPException(
            status_code=403,
            detail="Seu papel não tem permissão para gerenciar cores de status/etiquetas.",
        )


def _require_internal_contacts_permission(db: Session, user: User):
    """Aba Contatos internos (Configurações)."""
    if not user_has_permission(db, user, "settings_internal_contacts"):
        raise HTTPException(
            status_code=403,
            detail="Seu papel não tem permissão para gerenciar contatos internos.",
        )


# TAGS — catálogo global/setorial/pessoal + aplicação em conversas
#
# scope: "global" (todo mundo vê/aplica, comportamento de sempre) |
# "sector" (só quem tem User.sector igual, texto livre — sem tabela própria
# de setor) | "personal" (ponto-a-ponto, mesmo modelo de QuickReply acima:
# só quem criou vê/aplica por padrão, compartilha explicitamente com
# shared_with — quem recebe só usa, editar/excluir é exclusivo do criador).
#
# Etiqueta com task_title preenchido cria uma InternalTask (vinculada à
# conversa de cliente, sem prazo) toda vez que é aplicada — ver
# add_conversation_tag abaixo.

TAG_TASK_PRIORITIES = ("low", "medium", "high", "urgent")
TAG_SCOPES = ("global", "sector", "personal")


def _tag_visible_to(tag: Tag, user: User) -> bool:
    """Controla o CATÁLOGO (list_tags — o que aparece pra escolher/gerenciar).
    Etiqueta já aplicada numa conversa continua visível pra quem vir essa
    conversa independente disso (não filtramos conversation.tags por
    escopo — sem isso teríamos que revisar todo serializer de conversa do
    app; o escopo controla só "consigo achar/aplicar essa etiqueta")."""
    if tag.scope == "sector":
        return bool(user.sector) and user.sector == tag.sector
    if tag.scope == "personal":
        return tag.created_by == user.id or any(u.id == user.id for u in tag.shared_with)
    return True  # global


def _tag_can_manage(tag: Tag, user: User, has_catalog_permission: bool) -> bool:
    """Editar/excluir/mudar compartilhamento. Pessoal é sempre exclusivo de
    quem criou (mesma regra de QuickReply), mesmo pra quem tem a permissão
    geral — senão um admin poderia mexer na etiqueta pessoal de outra
    pessoa, o que contraria o próprio sentido de "pessoal"."""
    if tag.scope == "personal":
        return tag.created_by == user.id
    return has_catalog_permission


def _tag_brief(tag: Tag, user: User, has_catalog_permission: bool) -> dict:
    creator = tag.creator
    assignee = tag.task_assignee
    return {
        "id": tag.id,
        "name": tag.name,
        "color": tag.color,
        "scope": tag.scope,
        "sector": tag.sector,
        "created_by": creator.id if creator else None,
        "created_by_name": (creator.full_name or creator.email) if creator else None,
        "task_title": tag.task_title,
        "task_description": tag.task_description,
        "task_priority": tag.task_priority,
        "task_due_days": tag.task_due_days,
        "task_assigned_to": assignee.id if assignee else None,
        "task_assigned_to_name": (assignee.full_name or assignee.email) if assignee else None,
        "shared_with": [u.id for u in tag.shared_with] if tag.scope == "personal" else [],
        "can_manage": _tag_can_manage(tag, user, has_catalog_permission),
    }


@router_attendance.get("/tags")
async def list_tags(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    has_catalog_permission = user_has_permission(db, current_user, "settings_attendance_config")
    tags = db.query(Tag).order_by(Tag.name).all()
    visible = [t for t in tags if _tag_visible_to(t, current_user)]
    return APIResponse(success=True, data=[_tag_brief(t, current_user, has_catalog_permission) for t in visible])


class TagRequest(BaseModel):
    name: str
    color: Optional[str] = "#8696A0"
    scope: str = "global"
    sector: Optional[str] = None
    task_title: Optional[str] = None
    task_description: Optional[str] = None
    task_priority: Optional[str] = "medium"
    # Dias até o prazo (due_at = aplicação + N dias) — None/ausente = sem
    # prazo (e sem lembrete automático, já que o watchdog de prazo só
    # dispara pra tarefa que TEM due_at).
    task_due_days: Optional[int] = None
    # Responsável fixo — None/ausente = autoatribuída a quem aplicar a etiqueta.
    task_assigned_to: Optional[int] = None
    shared_with: List[int] = []


def _apply_tag_payload(tag: Tag, payload: TagRequest, db: Session, current_user: User):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nome da etiqueta não pode ser vazio")
    dup_query = db.query(Tag).filter(Tag.name == name)
    if tag.id is not None:
        dup_query = dup_query.filter(Tag.id != tag.id)
    if dup_query.first():
        raise HTTPException(status_code=400, detail="Já existe uma etiqueta com esse nome")

    scope = payload.scope if payload.scope in TAG_SCOPES else "global"
    sector = (payload.sector or "").strip() or None
    if scope == "sector" and not sector:
        raise HTTPException(status_code=400, detail="Selecione o setor da etiqueta")
    priority = payload.task_priority or "medium"
    if priority not in TAG_TASK_PRIORITIES:
        raise HTTPException(status_code=400, detail="Urgência da tarefa inválida")
    if payload.task_due_days is not None and payload.task_due_days < 1:
        raise HTTPException(status_code=400, detail="Prazo precisa ser 1 dia ou mais")
    if payload.task_assigned_to is not None and not db.query(User).filter(User.id == payload.task_assigned_to).first():
        raise HTTPException(status_code=400, detail="Responsável da tarefa inválido")

    tag.name = name
    tag.color = payload.color or "#8696A0"
    tag.scope = scope
    tag.sector = sector if scope == "sector" else None
    tag.task_title = (payload.task_title or "").strip() or None
    tag.task_description = (payload.task_description or "").strip() or None
    tag.task_priority = priority
    tag.task_due_days = payload.task_due_days
    tag.task_assigned_to = payload.task_assigned_to

    # Não faz sentido "compartilhar consigo mesmo" — descarta se aparecer.
    # Só relevante pra scope="personal"; nos outros dois shared_with fica
    # sempre vazio (visibilidade já é ampla o bastante).
    if scope == "personal":
        user_ids = {uid for uid in payload.shared_with if uid != tag.created_by}
        tag.shared_with = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
    else:
        tag.shared_with = []


@router_attendance.post("/tags")
async def create_tag(
    payload: TagRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Etiqueta pessoal: qualquer usuário logado cria a sua (mesma liberdade
    # de Resposta Rápida). Global/setorial: exige permissão de configurar
    # atendimento — afeta o catálogo que todo mundo (ou o setor inteiro) vê.
    scope = payload.scope if payload.scope in TAG_SCOPES else "global"
    if scope != "personal":
        _require_attendance_config_permission(db, current_user)
    tag = Tag(created_by=current_user.id)
    _apply_tag_payload(tag, payload, db, current_user)
    db.add(tag)
    db.commit()
    db.refresh(tag)
    has_catalog_permission = user_has_permission(db, current_user, "settings_attendance_config")
    return APIResponse(success=True, data=_tag_brief(tag, current_user, has_catalog_permission))


@router_attendance.patch("/tags/{tag_id}")
async def update_tag(
    tag_id: int,
    payload: TagRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tag = db.query(Tag).filter(Tag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Etiqueta não encontrada")
    has_catalog_permission = user_has_permission(db, current_user, "settings_attendance_config")
    if not _tag_can_manage(tag, current_user, has_catalog_permission):
        raise HTTPException(status_code=403, detail="Você não pode editar esta etiqueta")
    # Trocar pra/de "personal" também segue a mesma regra de permissão —
    # só bloqueia normalmente porque quem já podia editar (dono, ou quem
    # tem a permissão geral) continua podendo mudar o escopo.
    new_scope = payload.scope if payload.scope in TAG_SCOPES else "global"
    if new_scope != "personal" and tag.scope == "personal" and not has_catalog_permission:
        raise HTTPException(status_code=403, detail="Só quem tem permissão de configurar atendimento pode tornar uma etiqueta pessoal em global/setorial")
    _apply_tag_payload(tag, payload, db, current_user)
    db.commit()
    db.refresh(tag)
    return APIResponse(success=True, data=_tag_brief(tag, current_user, has_catalog_permission))


@router_attendance.delete("/tags/{tag_id}")
async def delete_tag(
    tag_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    tag = db.query(Tag).filter(Tag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Etiqueta não encontrada")
    has_catalog_permission = user_has_permission(db, current_user, "settings_attendance_config")
    if not _tag_can_manage(tag, current_user, has_catalog_permission):
        raise HTTPException(status_code=403, detail="Você não pode excluir esta etiqueta")
    db.delete(tag)
    db.commit()
    return APIResponse(success=True, data={"id": tag_id})


class ConversationTagRequest(BaseModel):
    tag_id: int


@router_attendance.post("/conversations/{conversation_id}/tags")
async def add_conversation_tag(
    conversation_id: int,
    payload: ConversationTagRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Aplicar uma etiqueta existente numa conversa — operação do dia a dia,
    liberada a qualquer usuário logado (diferente de criar/apagar etiqueta).
    Etiqueta com tarefa vinculada (task_title) cria automaticamente uma
    InternalTask nessa conversa — pedido explícito 2026-09-23, mesmo
    caminho de create_standalone_task (nunca gera nada visível pro
    cliente, autoatribuída a quem aplicou, sem prazo)."""
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")
    tag = db.query(Tag).filter(Tag.id == payload.tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Etiqueta não encontrada")
    just_applied = tag not in conversation.tags
    if just_applied:
        conversation.tags.append(tag)
        db.commit()

    if just_applied and tag.task_title:
        # Import tardio — mesmo motivo dos watchdogs (routes_internal_chat
        # importa muita coisa do app inteiro; evita ciclo de import).
        from backend.api.routes_internal_chat import create_standalone_task, CreateStandaloneTaskRequest
        due_at = datetime.utcnow() + timedelta(days=tag.task_due_days) if tag.task_due_days else None
        try:
            await create_standalone_task(
                CreateStandaloneTaskRequest(
                    title=tag.task_title, description=tag.task_description,
                    priority=tag.task_priority or "medium", customer_conversation_id=conversation_id,
                    due_at=due_at, assigned_to=tag.task_assigned_to,
                ),
                db, current_user,
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.error(f"Falha ao criar tarefa vinculada à etiqueta '{tag.name}' (conversa {conversation_id}): {exc}", exc_info=True)

    tags = [_tag_brief(t, current_user, user_has_permission(db, current_user, "settings_attendance_config")) for t in conversation.tags]
    await ws_manager.broadcast_conversation_meta_update({"conversation_id": conversation_id, "tags": tags})
    return APIResponse(success=True, data={"conversation_id": conversation_id, "tags": tags})


@router_attendance.delete("/conversations/{conversation_id}/tags/{tag_id}")
async def remove_conversation_tag(
    conversation_id: int,
    tag_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")
    conversation.tags = [t for t in conversation.tags if t.id != tag_id]
    db.commit()

    tags = [_tag_brief(t, current_user, user_has_permission(db, current_user, "settings_attendance_config")) for t in conversation.tags]
    await ws_manager.broadcast_conversation_meta_update({"conversation_id": conversation_id, "tags": tags})
    return APIResponse(success=True, data={"conversation_id": conversation_id, "tags": tags})


# NOTAS INTERNAS — thread privada por conversa (nunca sai pro WhatsApp)

@router_attendance.get("/conversations/{conversation_id}/notes")
async def list_notes(
    conversation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return APIResponse(success=True, data=conversation_service.get_conversation_notes(db, conversation_id))


class CreateNoteRequest(BaseModel):
    text: str


@router_attendance.post("/conversations/{conversation_id}/notes")
async def create_note(
    conversation_id: int,
    payload: CreateNoteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Nota vazia")

    conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversa não encontrada")

    note = InternalNote(conversation_id=conversation_id, user_id=current_user.id, text=text)
    db.add(note)
    db.commit()
    db.refresh(note)

    note_data = {
        "id": f"note_{note.id}",
        "is_internal_note": True,
        "text": note.text,
        "message": note.text,
        "author": current_user.full_name or current_user.email,
        "author_id": current_user.id,
        "timestamp": int(note.created_at.timestamp() * 1000),
        "conversation_id": conversation_id,
    }
    await ws_manager.broadcast_internal_note(note_data)
    return APIResponse(success=True, data=note_data)


# RESPOSTAS RÁPIDAS (macros) — atalho digitado no composer ("/oi") expande
# pro texto e/ou insere uma mídia pronta (parecido com Template de Mídia da
# Meta, mas enviado pelo bridge — o arquivo em si é enviado à parte via
# POST /api/upload/public, aqui só se guarda a referência).
#
# Compartilhamento é ponto-a-ponto, não um catálogo geral: por padrão só o
# autor vê/usa a própria resposta; ele escolhe explicitamente com quais
# colegas específicos compartilhar (shared_with), sem opção de "compartilhar
# com todo mundo" de uma vez. Quem recebe só usa — editar/apagar/mudar com
# quem está compartilhado é sempre exclusivo do autor.

def _quick_reply_brief(qr: QuickReply, current_user: User) -> dict:
    creator = qr.creator
    return {
        "id": qr.id,
        "shortcut": qr.shortcut,
        "text": qr.text,
        "media_url": qr.media_url,
        "media_type": qr.media_type,
        "media_filename": qr.media_filename,
        "media_mime": qr.media_mime,
        "created_by": qr.created_by,
        "created_by_name": (creator.full_name or creator.email) if creator else None,
        "is_mine": qr.created_by == current_user.id,
        "shared_with": [u.id for u in qr.shared_with],
    }


@router_attendance.get("/quick-replies")
async def list_quick_replies(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # Cada usuário vê só as próprias respostas + as que colegas específicos compartilharam com ele.
    replies = (
        db.query(QuickReply)
        .filter(or_(QuickReply.created_by == current_user.id, QuickReply.shared_with.any(User.id == current_user.id)))
        .order_by(QuickReply.shortcut)
        .all()
    )
    return APIResponse(success=True, data=[_quick_reply_brief(r, current_user) for r in replies])


class QuickReplyRequest(BaseModel):
    shortcut: str
    text: Optional[str] = None
    media_url: Optional[str] = None
    media_type: Optional[str] = None
    media_filename: Optional[str] = None
    media_mime: Optional[str] = None
    shared_with: List[int] = []


def _apply_quick_reply_payload(reply: QuickReply, payload: QuickReplyRequest, db: Session):
    shortcut = payload.shortcut.strip().lstrip("/")
    text = (payload.text or "").strip()
    media_url = (payload.media_url or "").strip()
    if not shortcut or not (text or media_url):
        raise HTTPException(status_code=400, detail="Atalho e (texto ou mídia) são obrigatórios")

    # Unicidade só entre as respostas do próprio autor — dois autores podem
    # ter o mesmo atalho sem conflito (não há mais catálogo global).
    query = db.query(QuickReply).filter(QuickReply.shortcut == shortcut, QuickReply.created_by == reply.created_by)
    if reply.id is not None:
        query = query.filter(QuickReply.id != reply.id)
    if query.first():
        raise HTTPException(status_code=400, detail="Você já tem uma resposta rápida com esse atalho")

    reply.shortcut = shortcut
    reply.text = text or None
    reply.media_url = media_url or None
    reply.media_type = (payload.media_type or None) if media_url else None
    reply.media_filename = (payload.media_filename or None) if media_url else None
    reply.media_mime = (payload.media_mime or None) if media_url else None

    # Não faz sentido "compartilhar consigo mesmo" — descarta se aparecer.
    user_ids = {uid for uid in payload.shared_with if uid != reply.created_by}
    reply.shared_with = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []


@router_attendance.post("/quick-replies")
async def create_quick_reply(
    payload: QuickReplyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    reply = QuickReply(created_by=current_user.id)
    _apply_quick_reply_payload(reply, payload, db)
    db.add(reply)
    db.commit()
    db.refresh(reply)
    return APIResponse(success=True, data=_quick_reply_brief(reply, current_user))


@router_attendance.patch("/quick-replies/{reply_id}")
async def update_quick_reply(
    reply_id: int,
    payload: QuickReplyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    reply = db.query(QuickReply).filter(QuickReply.id == reply_id).first()
    # 404 tanto se não existe quanto se existe mas é de outro autor — não
    # revela pra quem não é dono que uma resposta alheia existe nesse id.
    if not reply or reply.created_by != current_user.id:
        raise HTTPException(status_code=404, detail="Resposta rápida não encontrada")
    _apply_quick_reply_payload(reply, payload, db)
    db.commit()
    db.refresh(reply)
    return APIResponse(success=True, data=_quick_reply_brief(reply, current_user))


@router_attendance.delete("/quick-replies/{reply_id}")
async def delete_quick_reply(
    reply_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    reply = db.query(QuickReply).filter(QuickReply.id == reply_id).first()
    if not reply or reply.created_by != current_user.id:
        raise HTTPException(status_code=404, detail="Resposta rápida não encontrada")
    db.delete(reply)
    db.commit()
    return APIResponse(success=True, data={"id": reply_id})


# RELATÓRIO — tempo de espera (fila) e de resolução (Fase E)

@router_attendance.get("/attendance/reports")
async def attendance_reports(
    days: int = 7,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Métricas agregadas sobre conversas 1:1 criadas nos últimos `days` dias:
    tempo médio de espera (criação → atribuição) e de resolução (criação →
    marcada Resolvida, a definição escolhida — cobre o atendimento inteiro,
    não só a parte depois de atribuída), contagem por status, quantas estão
    estourando o SLA de espera agora, e um ranking por atendente. Respeita as
    mesmas restrições de feature_view_all_accounts de GET /conversations —
    um atendente restrito só vê números das contas dele, não da empresa toda.
    Antes disso, qualquer usuário logado via esse ranking por atendente —
    hoje exige settings_analytics (mesma permissão da aba Analytics).
    """
    if not user_has_permission(db, current_user, "settings_analytics"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para ver relatórios de atendimento.")
    from backend.api.routes_settings import _load_settings

    cutoff = datetime.utcnow() - timedelta(days=days)
    # Exclui conversas com contato marcado como interno (Contact.is_internal)
    # — não é atendimento a cliente, não deve entrar em tempo médio, SLA nem
    # ranking por atendente.
    # None = sem restrição (feature_view_all_accounts). Calculado uma vez e
    # reaplicado também nas queries de CSAT abaixo — mesma regra de acesso
    # do restante do relatório, sem duplicar a lógica de permissão.
    allowed_ids = None
    if not user_has_permission(db, current_user, "feature_view_all_accounts"):
        allowed_ids = {a.id for a in current_user.granted_accounts}

    def _scope_accounts(q):
        if allowed_ids is None:
            return q
        return q.filter(Conversation.account_id.in_(allowed_ids)) if allowed_ids else q.filter(Conversation.id.is_(None))

    query = _scope_accounts(
        db.query(Conversation)
        .join(Contact, Conversation.contact_id == Contact.id)
        .filter(
            Conversation.created_at >= cutoff,
            Conversation.is_group.is_(False),
            Contact.is_internal.is_(False),
        )
    )

    conversations = query.all()

    sla_minutes = _load_settings().get("automations", {}).get("sla", {}).get("wait_minutes", 10)
    now = datetime.utcnow()

    wait_times, resolution_times = [], []
    status_counts = {"open": 0, "pending": 0, "resolved": 0}
    per_agent: dict = {}
    sla_breaches = 0

    for conv in conversations:
        status_counts[conv.status or "open"] = status_counts.get(conv.status or "open", 0) + 1

        if conv.assigned_at:
            wait_times.append((conv.assigned_at - conv.created_at).total_seconds())
        elif conv.status != "resolved" and (now - conv.created_at).total_seconds() > sla_minutes * 60:
            sla_breaches += 1

        if conv.resolved_at:
            resolution_seconds = (conv.resolved_at - conv.created_at).total_seconds()
            resolution_times.append(resolution_seconds)
            if conv.assigned_to_user_id:
                agent = per_agent.setdefault(conv.assigned_to_user_id, {
                    "user_id": conv.assigned_to_user_id,
                    "full_name": (conv.assigned_to.full_name or conv.assigned_to.email) if conv.assigned_to else "Desconhecido",
                    "resolved_count": 0,
                    "resolution_seconds": [],
                })
                agent["resolved_count"] += 1
                agent["resolution_seconds"].append(resolution_seconds)

    def _avg(vals):
        return round(sum(vals) / len(vals)) if vals else None

    agents = sorted(
        [{
            "user_id": a["user_id"],
            "full_name": a["full_name"],
            "resolved_count": a["resolved_count"],
            "avg_resolution_seconds": _avg(a["resolution_seconds"]),
        } for a in per_agent.values()],
        key=lambda a: -a["resolved_count"],
    )

    # CSAT — baseado em quando a RESPOSTA chegou (CsatResponse.created_at),
    # não em quando a conversa foi criada, já que a pesquisa só é enviada ao
    # resolver e a resposta pode vir dias depois. Taxa de resposta usa
    # csat_sent_at (nunca é apagado, diferente da flag awaiting_csat) como
    # denominador — pesquisas enviadas no período, respondidas ou não.
    csat_responses = _scope_accounts(
        db.query(CsatResponse)
        .join(Conversation, CsatResponse.conversation_id == Conversation.id)
        .filter(CsatResponse.created_at >= cutoff)
    ).all()
    csat_sent_count = _scope_accounts(
        db.query(Conversation).filter(Conversation.csat_sent_at >= cutoff)
    ).count()

    ratings = [r.rating for r in csat_responses]
    distribution = {str(n): ratings.count(n) for n in range(1, 6)}
    per_agent_csat: dict = {}
    for r in csat_responses:
        conv = r.conversation
        if conv and conv.assigned_to_user_id:
            bucket = per_agent_csat.setdefault(conv.assigned_to_user_id, {
                "user_id": conv.assigned_to_user_id,
                "full_name": (conv.assigned_to.full_name or conv.assigned_to.email) if conv.assigned_to else "Desconhecido",
                "ratings": [],
            })
            bucket["ratings"].append(r.rating)

    csat_agents = sorted(
        [{
            "user_id": a["user_id"],
            "full_name": a["full_name"],
            "response_count": len(a["ratings"]),
            "avg_rating": round(sum(a["ratings"]) / len(a["ratings"]), 2),
        } for a in per_agent_csat.values()],
        key=lambda a: -a["response_count"],
    )

    recent_comments = sorted(
        [{"rating": r.rating, "comment": r.comment, "created_at": to_utc_iso(r.created_at)}
         for r in csat_responses if r.comment],
        key=lambda c: c["created_at"], reverse=True,
    )[:20]

    return APIResponse(success=True, data={
        "period_days": days,
        "total_conversations": len(conversations),
        "status_counts": status_counts,
        "avg_wait_seconds": _avg(wait_times),
        "avg_resolution_seconds": _avg(resolution_times),
        "sla_wait_minutes": sla_minutes,
        "sla_breaches_now": sla_breaches,
        "agents": agents,
        "csat": {
            "sent_count": csat_sent_count,
            "response_count": len(ratings),
            "response_rate": round(len(ratings) / csat_sent_count, 3) if csat_sent_count else None,
            "avg_rating": round(sum(ratings) / len(ratings), 2) if ratings else None,
            "distribution": distribution,
            "agents": csat_agents,
            "recent_comments": recent_comments,
        },
    })
