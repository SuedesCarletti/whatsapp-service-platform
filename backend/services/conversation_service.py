"""
ConversationService - Gerenciamento de conversas e mensagens
VERSÃO CORRIGIDA - SEMPRE retorna campo 'message' para frontend
Suporte a account_id para multi-conta (Baileys + Cloud API)
"""
import logging
import re
import uuid
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session, object_session, selectinload, joinedload
from sqlalchemy import desc, or_, exists, func, tuple_
from sqlalchemy.exc import IntegrityError
from backend.models.database_models import (
    Contact, ContactAccountName, Conversation, Message, MessageType, Direction, MessageStatus, MediaFile, BaileysLidMap,
    Tag, InternalNote,
)
from datetime import datetime, timedelta
from backend.utils.time_utils import to_utc_iso
from backend.utils.contact_filters import NON_CUSTOMER_WA_IDS

logger = logging.getLogger("conversation_service")

# Mesmo casamento por núcleo hexadecimal do wamid usado em
# webhook_handler.py (_wamid_hex_core/_find_wamid_format_duplicate) — ver
# comentário lá pro contexto completo. Precisa existir aqui também porque
# save_outbound_message tem a MESMA corrida que aquele código já resolve do
# lado do webhook: quando o eco do webhook ganha a corrida e cria a linha
# ANTES da resposta HTTP do envio voltar, ele grava o wamid no formato
# completo ("true_<jid>@lid_<hex>"), enquanto save_outbound_message só tem o
# hex cru que o provider devolveu na hora — o match exato de wamid não via
# que é a mesma mensagem e criava uma segunda linha (confirmado ao vivo,
# 2026-09-16, conversa real duplicada na tela sem nenhuma mensagem sair
# duas vezes de verdade pro cliente).
_WAMID_BARE_HEX_RE = re.compile(r'^[0-9A-Fa-f]{15,30}$')
_WAMID_PREFIXED_HEX_RE = re.compile(r'^(?:true|false)_[^@]+@lid_([0-9A-Fa-f]{15,30})$')


def _wamid_hex_core(wamid: Optional[str]) -> Optional[str]:
    if not wamid:
        return None
    if _WAMID_BARE_HEX_RE.match(wamid):
        return wamid.upper()
    m = _WAMID_PREFIXED_HEX_RE.match(wamid)
    return m.group(1).upper() if m else None

# Sintoma clássico de bot travado: repetir a mesma resposta várias vezes
# seguidas num intervalo curto. BOT_REPEAT_THRESHOLD respostas idênticas
# dentro de BOT_REPEAT_WINDOW uma da outra dispara o alerta
# (Conversation.bot_loop_detected) — ver ConversationService.register_bot_reply.
BOT_REPEAT_THRESHOLD = 3
BOT_REPEAT_WINDOW = timedelta(minutes=10)


def _br_mobile_alt_wa_id(wa_id: str) -> Optional[str]:
    """
    Retorna a forma alternativa (com/sem o 9º dígito) de um número de celular
    brasileiro, ou None se o número não se encaixar nesse padrão.

    A Meta normaliza números BR à sua própria maneira ao gerar o wa_id de
    entrada (nem sempre igual ao que foi digitado/enviado no outbound), então
    o mesmo contato pode aparecer como 55DDD9XXXXXXXX (13 dígitos) ou
    55DDDXXXXXXXX (12 dígitos) dependendo de quem gerou o número. Sem checar
    a forma alternativa, cada envio outbound com o formato "errado" cria um
    Contact/Conversation duplicado para a mesma pessoa.
    """
    if not wa_id or not wa_id.isdigit() or not wa_id.startswith("55"):
        return None
    local = wa_id[2:]
    if len(local) == 11 and local[2] == "9":
        return "55" + local[:2] + local[3:]
    if len(local) == 10:
        return "55" + local[:2] + "9" + local[2:]
    return None


def _format_phone_display(wa_id: str) -> str:
    """Formats a wa_id/phone number for display (e.g. +55 11 99999-0001)."""
    if not wa_id:
        return "Desconhecido"
    digits = wa_id.replace("+", "").replace("-", "").replace(" ", "").split("@")[0]
    if len(digits) == 13 and digits.startswith("55"):
        return f"+{digits[0:2]} {digits[2:4]} {digits[4:9]}-{digits[9:]}"
    if len(digits) == 12 and digits.startswith("55"):
        return f"+{digits[0:2]} {digits[2:4]} {digits[4:8]}-{digits[8:]}"
    if len(digits) >= 8:
        return f"+{digits}"
    return wa_id


class ConversationService:
    """Serviço para gerenciar conversas e mensagens"""
    
    def get_or_create_contact(
        self,
        db: Session,
        wa_id: str,
        phone_number: str,
        name: Optional[str] = None,
        push_name: Optional[str] = None,
        saved_name: Optional[str] = None,  # nome real da agenda (nunca derivado do push_name)
        profile_picture_url: Optional[str] = None,
        is_group: bool = False,
        group_subject: Optional[str] = None,
        lid: Optional[str] = None,  # LID Baileys sem sufixo @lid (ex: "128904920580321")
    ) -> Contact:
        # Normaliza wa_id: remove sufixos JID de contatos individuais para garantir
        # que mensagens outbound (sem sufixo) e inbound (@s.whatsapp.net/@c.us/@lid)
        # resolvam para o mesmo contato/conversa.
        if not is_group and wa_id:
            if "@s.whatsapp.net" in wa_id or "@c.us" in wa_id or "@lid" in wa_id:
                wa_id = wa_id.split("@")[0]
            phone_number = wa_id  # phone_number sempre os dígitos sem sufixo

        # phone_number é varchar(20) — para grupos, o wa_id/JID completo (com
        # @g.us) não cabe. Independente do que o chamador passou, normaliza
        # para o id numérico do grupo sem sufixo.
        if is_group and wa_id:
            phone_number = wa_id.split("@")[0]

        contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()

        # Heurística de forma: JID de grupo (com ou sem @g.us) é um número bem
        # mais longo (18+ dígitos) que telefone (10-15). Sinal ADICIONAL pro
        # fallback abaixo, além do flag is_group — confirmado ao vivo (conta
        # RMA-01, 2026-09-02) que o bridge pode reportar is_group=False
        # transitoriamente logo após reconectar (visto em contas que passaram
        # por muitas reconexões seguidas), e como esse fallback só rodava com
        # is_group=True, o grupo duplicava mesmo já tendo essa proteção.
        looks_like_group_id = bool(wa_id) and wa_id.split("@")[0].isdigit() and len(wa_id.split("@")[0]) >= 18

        # Fallback (grupos): alguns grupos foram salvos com o wa_id sem o sufixo
        # @g.us (dado legado) enquanto o chamador atual manda a JID completa
        # (ou vice-versa). Sem isso, cada envio para esse grupo cria um Contact
        # duplicado — e, por consequência, uma conversa "fantasma" nova.
        if not contact and (is_group or looks_like_group_id) and wa_id:
            # BUG (pré-existente, achado 2026-09-02): "@g.us" tem 5
            # caracteres, mas isto cortava 6 (wa_id[:-6]) — truncava um
            # dígito A MAIS do id do grupo, então essa busca alternativa
            # nunca batia com o contato real e o fallback inteiro nunca
            # funcionava de verdade. removesuffix() evita repetir esse tipo
            # de erro de contagem manual.
            alt_wa_id = wa_id.removesuffix("@g.us") if wa_id.endswith("@g.us") else f"{wa_id}@g.us"
            contact = db.query(Contact).filter(Contact.wa_id == alt_wa_id).first()
            if contact:
                logger.info(
                    f"⚠️ Grupo encontrado por wa_id alternativo={alt_wa_id} "
                    f"(esperado={wa_id}) — normalizando para incluir sufixo @g.us"
                )
                if not contact.wa_id.endswith("@g.us"):
                    contact.wa_id = f"{contact.wa_id}@g.us"
                    db.commit()

        # Fallback 1: busca pelo phone_number caso wa_id antigo tenha sido salvo com sufixo
        # (ex: contatos criados antes da normalização, ou migração de dados).
        if not contact and not is_group and phone_number:
            contact = db.query(Contact).filter(Contact.phone_number == phone_number).first()
            if contact:
                logger.info(
                    f"⚠️ Contato encontrado por phone_number={phone_number} "
                    f"(wa_id anterior={contact.wa_id}, novo={wa_id}) — atualizando wa_id"
                )
                contact.wa_id = wa_id
                db.commit()

        # Fallback 1B (BR mobile 9º dígito): mesma pessoa pode chegar como
        # 5511999990001 (outbound, formato moderno digitado) ou 551199990001
        # (o wa_id que a própria Meta usa/normaliza) — sem isso, vira contato
        # duplicado com conversa órfã (visto ao vivo: contato "Contato Teste" já
        # existente + um segundo contato fantasma criado por um envio outbound).
        if not contact and not is_group and wa_id:
            alt_wa_id = _br_mobile_alt_wa_id(wa_id)
            if alt_wa_id:
                contact = db.query(Contact).filter(Contact.wa_id == alt_wa_id).first()
                if contact:
                    logger.info(
                        f"Contato encontrado pela forma alternativa (9º dígito) "
                        f"wa_id={alt_wa_id} (recebido={wa_id}) — reaproveitando, sem duplicar"
                    )

        # Fallback 2 (LID Baileys — campo lid nos contatos): quando wa_id é um LID numérico e não
        # encontrou contato pelo número de telefone, tenta resolver pelo campo lid do banco.
        # Isso evita criar uma conversa duplicada quando Baileys usa @lid em vez de @s.whatsapp.net.
        if not contact and not is_group and lid:
            contact = db.query(Contact).filter(Contact.lid == lid).first()
            if contact:
                logger.info(
                    f"Contato resolvido via LID={lid} → wa_id real={contact.wa_id} "
                    f"(evitando contato duplicado com LID como wa_id)"
                )
                # wa_id passado ainda é o LID numérico — NÃO atualiza; o wa_id real já está correto.

        # Fallback 3 (baileys_lid_map — tabela persistida pelo bridge): consulta diretamente a
        # tabela que o bridge preenche em sendMessage e contacts.upsert. Resolve o LID para o
        # phone_jid mesmo que contacts.upsert não tenha chamado /bridge/contacts ainda.
        lid_to_search = lid or (wa_id if wa_id and not is_group else None)
        if not contact and not is_group and lid_to_search:
            try:
                # A tabela armazena lid_jid com ou sem sufixo @lid
                lid_with_suffix    = f"{lid_to_search}@lid" if not lid_to_search.endswith("@lid") else lid_to_search
                lid_without_suffix = lid_to_search.split("@")[0]
                row = (
                    db.query(BaileysLidMap)
                    .filter(BaileysLidMap.lid_jid.in_([lid_with_suffix, lid_without_suffix]))
                    .first()
                )
                if row:
                    resolved_phone = row.phone_jid.split("@")[0]
                    contact = db.query(Contact).filter(Contact.phone_number == resolved_phone).first()
                    if contact:
                        logger.info(
                            f"LID {lid_to_search} resolvido via baileys_lid_map "
                            f"→ phone {resolved_phone} (contact id={contact.id})"
                        )
                        if not contact.lid:
                            contact.lid = lid_without_suffix
                            db.commit()
            except Exception as _e:
                logger.debug(f"Fallback baileys_lid_map falhou: {_e}")

        if not contact:
            display_name = name or push_name or group_subject or _format_phone_display(wa_id)
            contact = Contact(
                wa_id=wa_id,
                phone_number=phone_number,
                lid=lid if not is_group else None,
                name=display_name,
                push_name=push_name,
                saved_name=saved_name if not is_group else None,
                profile_picture_url=profile_picture_url,
                is_group=is_group,
                group_subject=group_subject,
            )
            db.add(contact)
            try:
                db.commit()
            except IntegrityError:
                # Incidente 2026-09-11 (confirmado ao vivo, rajada ao abrir
                # um grupo grande): dois upserts do MESMO participante quase
                # simultâneos (GroupManager renderiza um AvatarThumb por
                # participante, cada um chamando /contacts/upsert) fazem os
                # dois pegarem contact=None na query acima antes de qualquer
                # um commitar — o segundo commit esbarra na unique constraint
                # de contacts.wa_id e falhava sem tratamento nenhum (rota
                # devolvia 500 pra cada upsert perdido na corrida). Não é
                # erro de verdade: o contato já existe, só precisa buscar de
                # novo em vez de tentar criar duplicado.
                db.rollback()
                contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()
                if not contact:
                    raise
                logger.info(f"Contato {wa_id} já criado por uma corrida concorrente — reaproveitando")
                return contact
            db.refresh(contact)
            logger.info(f"Novo contato criado: {wa_id} (grupo={is_group}, lid={lid})")
        else:
            changed = False
            if push_name and contact.push_name != push_name:
                contact.push_name = push_name
                changed = True
            if saved_name and not is_group and contact.saved_name != saved_name:
                contact.saved_name = saved_name
                changed = True
            if name and contact.name != name:
                contact.name = name
                changed = True
            elif push_name and not contact.name:
                contact.name = push_name
                changed = True
            if profile_picture_url and contact.profile_picture_url != profile_picture_url:
                contact.profile_picture_url = profile_picture_url
                changed = True
            if group_subject and contact.group_subject != group_subject:
                contact.group_subject = group_subject
                if not contact.name or contact.name == f"Contato {wa_id[-4:]}":
                    contact.name = group_subject
                changed = True
            # Persiste o LID quando chegou pelo mapeamento do bridge e o contato ainda não tem
            if lid and not is_group and not contact.lid:
                contact.lid = lid
                changed = True
            if changed:
                db.commit()

        return contact

    def _upsert_contact_account_name(self, db: Session, contact_id: int, account_id: int, custom_name: str) -> None:
        """Grava/atualiza o nome customizado de um contato pra uma conta específica (ver ContactAccountName)."""
        row = db.query(ContactAccountName).filter(
            ContactAccountName.contact_id == contact_id,
            ContactAccountName.account_id == account_id,
        ).first()
        if row:
            if row.custom_name != custom_name:
                row.custom_name = custom_name
        else:
            db.add(ContactAccountName(contact_id=contact_id, account_id=account_id, custom_name=custom_name))

    def register_lid_mapping(
        self,
        db: Session,
        lid: str,
        phone_number: str,
        push_name: Optional[str] = None,
        saved_name: Optional[str] = None,
        account_id: Optional[int] = None,
    ) -> bool:
        """
        Registra ou atualiza o mapeamento LID→phone enviado pelo bridge via contacts.upsert.
        Se já existe contato com wa_id=phone_number, apenas grava o lid nele.
        Se já existe contato com wa_id=lid (criado antes da resolução), migra para o telefone real.

        account_id: conta WhatsApp de onde veio essa sincronização (agenda do celular
        vinculado a essa sessão) — saved_name grava em ContactAccountName pra essa conta
        específica, não mais direto em Contact.saved_name (evita vazar nome de contato
        entre contas diferentes da empresa, ver ContactAccountName). Se vier None (não
        deveria, _resolve_account_id sempre tem fallback), cai pro Contact.saved_name
        legado como rede de segurança.
        """
        try:
            lid_clean   = lid.split("@")[0] if "@" in lid else lid
            phone_clean = phone_number.split("@")[0] if "@" in phone_number else phone_number

            # Busca contato correto pelo telefone real
            contact_by_phone = db.query(Contact).filter(
                Contact.phone_number == phone_clean,
                Contact.is_group == False,
            ).first()

            # Busca contato "fantasma" criado com o LID como wa_id
            contact_by_lid_waid = db.query(Contact).filter(
                Contact.wa_id == lid_clean,
                Contact.is_group == False,
            ).first()

            if contact_by_phone:
                # Contato real existe — apenas atualiza o campo lid
                changed = False
                if contact_by_phone.lid != lid_clean:
                    contact_by_phone.lid = lid_clean
                    changed = True
                if push_name and not contact_by_phone.push_name:
                    contact_by_phone.push_name = push_name
                    changed = True
                if saved_name:
                    if account_id is not None:
                        self._upsert_contact_account_name(db, contact_by_phone.id, account_id, saved_name)
                        changed = True
                    elif contact_by_phone.saved_name != saved_name:
                        contact_by_phone.saved_name = saved_name
                        changed = True
                if changed:
                    db.commit()
                    logger.info(f"LID {lid_clean} vinculado ao contato existente wa_id={contact_by_phone.wa_id}")

                # Se havia contato fantasma com lid como wa_id, migra conversas/mensagens e apaga
                if contact_by_lid_waid and contact_by_lid_waid.id != contact_by_phone.id:
                    self._merge_lid_contact(db, ghost=contact_by_lid_waid, real=contact_by_phone)

            elif contact_by_lid_waid:
                # Só existe o contato fantasma — corrige wa_id para o telefone real
                logger.info(
                    f"🔧 Corrigindo contato fantasma LID: wa_id {lid_clean} → {phone_clean}"
                )
                contact_by_lid_waid.wa_id          = phone_clean
                contact_by_lid_waid.phone_number    = phone_clean
                contact_by_lid_waid.lid             = lid_clean
                if push_name and not contact_by_lid_waid.push_name:
                    contact_by_lid_waid.push_name   = push_name
                if saved_name:
                    if account_id is not None:
                        self._upsert_contact_account_name(db, contact_by_lid_waid.id, account_id, saved_name)
                    elif contact_by_lid_waid.saved_name != saved_name:
                        contact_by_lid_waid.saved_name  = saved_name
                db.commit()
            else:
                logger.debug(f"ℹLID {lid_clean} recebido mas nenhum contato encontrado ainda — será resolvido ao criar")

            return True
        except Exception as e:
            logger.error(f"Erro ao registrar mapeamento LID: {e}", exc_info=True)
            db.rollback()
            return False

    def _merge_lid_contact(self, db: Session, ghost: "Contact", real: "Contact"):
        """Reatribui conversas e mensagens do contato fantasma (LID) para o contato real e apaga o fantasma."""
        try:
            from backend.models.database_models import Conversation, Message
            db.query(Conversation).filter(Conversation.contact_id == ghost.id).update(
                {"contact_id": real.id}, synchronize_session=False
            )
            db.query(Message).filter(Message.contact_id == ghost.id).update(
                {"contact_id": real.id}, synchronize_session=False
            )
            # Nomes customizados por conta (ContactAccountName) do fantasma também
            # precisam migrar — se o real já tiver um nome pra mesma account_id (raro,
            # mas possível), mantém o do real e descarta o do fantasma (evita violar a
            # unique constraint (contact_id, account_id)).
            real_account_ids = {
                row.account_id for row in db.query(ContactAccountName.account_id)
                .filter(ContactAccountName.contact_id == real.id).all()
            }
            ghost_names = db.query(ContactAccountName).filter(ContactAccountName.contact_id == ghost.id).all()
            for gn in ghost_names:
                if gn.account_id in real_account_ids:
                    db.delete(gn)
                else:
                    gn.contact_id = real.id
            db.delete(ghost)
            db.commit()
            logger.info(f"Contato fantasma LID (id={ghost.id}) mesclado com contato real (id={real.id})")
        except Exception as e:
            logger.error(f"Erro ao mesclar contato LID: {e}", exc_info=True)
            db.rollback()
    
    def get_or_create_conversation(
        self,
        db: Session,
        contact_id: int,
        account_id: Optional[int] = None,
        is_group: bool = False,
        group_jid: Optional[str] = None,
        group_name: Optional[str] = None,
        is_history: bool = False,
        is_internal: bool = False,
    ) -> Conversation:
        """
        Obtém ou cria uma conversa para um contato.
        Unicidade é (contact_id, account_id) pra grupo E individual —
        get_or_create_contact já é a fonte confiável de identidade de um
        grupo (com seu próprio fallback de sufixo @g.us, ver lá). BUG
        anterior (confirmado ao vivo, conta RMA-01, 2026-09-02): grupo casava
        por Conversation.group_jid == group_jid, mas group_jid às vezes vem
        vazio numa chamada específica (mesma instabilidade transitória do
        bridge logo após reconectar) — a 1ª vez que isso acontecia criava uma
        conversa com group_jid NULL; a próxima chamada, já com group_jid
        preenchido, não achava essa linha (NULL != valor) e criava OUTRA
        conversa nova pro MESMO grupo, partindo o histórico em duas. Casar
        sempre por contact_id elimina essa divergência — e cura o group_jid
        que ficou NULL/desatualizado assim que uma chamada trouxer o valor.

        is_history=True (mensagem vinda do resync de histórico, de antes da
        sessão/QR existir) faz uma conversa NOVA nascer "resolved" em vez do
        padrão "open" — não faz sentido essas mensagens antigas entrarem como
        ticket aberto na fila. Só se aplica à CRIAÇÃO: uma conversa que já
        existia (já tem status próprio, possivelmente "open" de verdade)
        nunca é rebaixada por aqui.

        is_internal=True (Contact.is_internal — colega/fornecedor, não é
        atendimento a cliente) faz a conversa nascer com bot_enabled=False —
        o bot/IA já nunca respondia contato interno (ver guard em
        _run_attendance_automations/_forward_to_ai_webhook), mas o campo
        ficava True mesmo assim, mostrando "🤖 Bot ativo" enganosamente na UI.
        """
        query = db.query(Conversation).filter(Conversation.contact_id == contact_id)
        if account_id is not None:
            query = query.filter(Conversation.account_id == account_id)
        else:
            query = query.filter(Conversation.account_id.is_(None))

        conversation = query.first()

        if not conversation:
            conversation = Conversation(
                contact_id=contact_id,
                account_id=account_id,
                is_group=is_group,
                group_jid=group_jid,
                group_name=group_name,
                last_message_at=datetime.now(),
                unread_count=0,
                is_archived=False,
                status="resolved" if is_history else "open",
                bot_enabled=not is_internal,
            )
            db.add(conversation)
            try:
                db.commit()
                db.refresh(conversation)
                logger.info(f"Nova conversa criada — contact_id={contact_id} account_id={account_id} grupo={is_group}")
            except IntegrityError:
                # Corrida: desde que o processamento de webhook passou a
                # rodar em várias threads concorrentes (ver routes_bridge.py,
                # WEBHOOK_EXECUTOR), 2 mensagens quase simultâneas pro mesmo
                # contato+conta podem passar pelo SELECT acima antes de
                # qualquer uma commitar o INSERT — cada uma criava sua própria
                # conversa (bug real, confirmado 2026-09-03: contact_id=210,
                # account_id=15, conversas 268/269, a segunda vazia). O
                # UNIQUE (contact_id, account_id) agora barra a 2ª, aqui só
                # busca e devolve a que já foi commitada em vez de propagar
                # erro 500 pro chamador.
                db.rollback()
                conversation = query.first()
                if not conversation:
                    raise
                logger.info(f"Conversa contact_id={contact_id} account_id={account_id} criada em corrida, retornando existente")
        else:
            changed = False
            if is_group and group_jid and conversation.group_jid != group_jid:
                conversation.group_jid = group_jid
                conversation.is_group = True
                changed = True
            if group_name and conversation.group_name != group_name:
                conversation.group_name = group_name
                changed = True
            if changed:
                db.commit()

        return conversation
    
    def get_all_contacts(self, db: Session) -> List[Contact]:
        """Retorna todos os contatos"""
        return db.query(Contact).order_by(Contact.name).all()
    
    def get_contact_by_id(self, db: Session, contact_id: int) -> Optional[Contact]:
        """Busca contato por ID"""
        return db.query(Contact).filter(Contact.id == contact_id).first()
    
    def get_all_conversations_with_last_message(
        self,
        db: Session,
        account_id: Optional[int] = None,
        restrict_to_user_id: Optional[int] = None,
        allowed_account_ids: Optional[set] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retorna todas as conversas com a última mensagem de cada uma.
        Filtra por account_id quando fornecido; caso contrário retorna todas.
        restrict_to_user_id: quando setado, só retorna conversas atribuídas a
        esse usuário OU ainda não atribuídas (fila) — usado quando o papel do
        usuário não tem a permissão feature_view_all_chats.
        allowed_account_ids: quando setado (mesmo que vazio), só retorna
        conversas de contas WhatsApp explicitamente concedidas ao usuário —
        usado quando o papel não tem feature_view_all_accounts.
        CORRIGIDO - USA last_message_at
        """
        try:
            # status@broadcast (Status/Stories do WhatsApp) vira uma Conversation normal
            # como qualquer contato — sem filtro aqui ela poluiria a lista de conversas
            # reais. Fica disponível separadamente via GET /api/statuses.
            #
            # Conversa 1:1 sem nenhuma mensagem (ex: usuário só abriu o perfil de um
            # contato/participante e não chegou a mandar nada — POST /conversations/open
            # cria a Conversation na hora pra já existir um id pra selecionar) não deve
            # poluir a lista — só aparece quando alguma mensagem é enviada de fato.
            # Grupos continuam aparecendo desde a criação (ação intencional do usuário).
            query = db.query(Conversation).join(Contact).options(
                selectinload(Conversation.contact),
                selectinload(Conversation.assigned_to),
                selectinload(Conversation.tags),
            ).filter(
                Contact.wa_id.notin_(NON_CUSTOMER_WA_IDS),
                or_(
                    Conversation.is_group.is_(True),
                    exists().where(Message.conversation_id == Conversation.id),
                ),
            )

            if account_id is not None:
                query = query.filter(Conversation.account_id == account_id)

            if allowed_account_ids is not None:
                query = query.filter(Conversation.account_id.in_(allowed_account_ids))

            if restrict_to_user_id is not None:
                query = query.filter(
                    or_(
                        Conversation.assigned_to_user_id == restrict_to_user_id,
                        Conversation.assigned_to_user_id.is_(None),
                    )
                )

            conversations = query.order_by(desc(Conversation.is_pinned), desc(Conversation.last_message_at)).all()

            # Com centenas de conversas, buscar last_message/unread_count uma-a-uma
            # (era o que _build_conversation_summary fazia) virava 2 queries × N —
            # 700+ round-trips ao MySQL só pra montar a sidebar. Aqui vira 2 queries
            # no total, não importa quantas conversas existam.
            conv_ids = [c.id for c in conversations]
            last_message_map = {}
            unread_count_map = {}
            # Nome customizado é por (contact_id, account_id) — cada conta pode ter
            # seu próprio nome pro mesmo contato (ver ContactAccountName). Uma query
            # batched em vez de uma por conversa, mesmo raciocínio do comentário acima.
            custom_name_map = {}
            pairs = {(c.contact_id, c.account_id) for c in conversations if c.account_id is not None}
            if pairs:
                custom_name_map = {
                    (row.contact_id, row.account_id): row.custom_name
                    for row in db.query(ContactAccountName).filter(
                        tuple_(ContactAccountName.contact_id, ContactAccountName.account_id).in_(pairs)
                    ).all()
                }
            if conv_ids:
                max_ts_subq = (
                    db.query(
                        Message.conversation_id.label("conversation_id"),
                        func.max(Message.timestamp).label("max_ts"),
                    )
                    .filter(Message.conversation_id.in_(conv_ids))
                    .group_by(Message.conversation_id)
                    .subquery()
                )
                last_messages = db.query(Message).join(
                    max_ts_subq,
                    (Message.conversation_id == max_ts_subq.c.conversation_id)
                    & (Message.timestamp == max_ts_subq.c.max_ts),
                ).all()
                for m in last_messages:
                    last_message_map[m.conversation_id] = m

                unread_count_map = dict(
                    db.query(Message.conversation_id, func.count(Message.id))
                    .filter(
                        Message.conversation_id.in_(conv_ids),
                        Message.direction == Direction.INBOUND,
                        Message.status != MessageStatus.READ,
                    )
                    .group_by(Message.conversation_id)
                    .all()
                )

            result = [
                self._build_conversation_summary(
                    db, conv,
                    last_message=last_message_map.get(conv.id),
                    unread_count=unread_count_map.get(conv.id, 0),
                    bulk=True,
                    custom_name=custom_name_map.get((conv.contact_id, conv.account_id)),
                )
                for conv in conversations
            ]

            logger.info(f"Retornadas {len(result)} conversas (account_id={account_id})")
            return result

        except Exception as e:
            logger.error(f"Erro ao buscar conversas: {e}", exc_info=True)
            return []

    def _build_conversation_summary(
        self, db: Session, conv: Conversation,
        last_message: Optional[Message] = None,
        unread_count: Optional[int] = None,
        bulk: bool = False,
        custom_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Monta o dict de resumo de uma conversa (usado pela listagem e pela busca).

        `bulk=True` (usado por get_all_conversations_with_last_message) sinaliza que
        `last_message`/`unread_count` já vieram pré-calculados em lote pelo chamador —
        evita cair aqui e refazer 2 queries por conversa (era 700+ round-trips com a
        sidebar cheia). Chamadores que não passam esses valores (ex: search_conversations,
        volume bem menor) continuam calculando um a um, comportamento inalterado.

        `custom_name`: nome de ContactAccountName pra (conv.contact_id, conv.account_id),
        já resolvido em lote pelo chamador. None = essa conta nunca customizou o nome
        desse contato — cai pro Contact.saved_name legado (edição de antes dessa tabela
        existir, ou contato sem account_id como grupo interno).
        """
        # Corrige is_group em conversas antigas onde ficou False mas group_jid existe
        if not conv.is_group and conv.group_jid:
            conv.is_group = True
            if conv.contact and not conv.contact.is_group:
                conv.contact.is_group = True
            db.commit()

        if not bulk:
            last_message = db.query(Message).filter(
                Message.conversation_id == conv.id
            ).order_by(
                desc(Message.timestamp)
            ).first()

            unread_count = db.query(Message).filter(
                Message.conversation_id == conv.id,
                Message.direction == Direction.INBOUND,
                Message.status != MessageStatus.READ
            ).count()

        return {
            "id": conv.id,
            "contact_id": conv.contact_id,
            "account_id": conv.account_id,
            "is_group": conv.is_group,
            "group_jid": conv.group_jid,
            "group_name": conv.group_name,
            "last_message_at": to_utc_iso(conv.last_message_at),
            "unread_count": unread_count,
            "is_archived": conv.is_archived,
            "is_pinned": bool(conv.is_pinned),
            "is_favorite": bool(conv.is_favorite),
            "is_muted": bool(conv.is_muted),
            "status": conv.status or "open",
            "bot_enabled": conv.bot_enabled if conv.bot_enabled is not None else True,
            "bot_handoff_at": to_utc_iso(conv.bot_handoff_at),
            "bot_loop_detected": bool(conv.bot_loop_detected),
            "assigned_to": {
                "id": conv.assigned_to.id,
                "full_name": conv.assigned_to.full_name or conv.assigned_to.email,
            } if conv.assigned_to_user_id and conv.assigned_to else None,
            # Timestamps pra relógio de SLA ao vivo no frontend (tempo de fila/
            # atendimento) — created_at é o início de tudo, assigned_at marca
            # quando parou de esperar na fila, resolved_at quando fechou.
            # BUG anterior: iam como datetime naive cru — o front (Sidebar.js
            # getSlaBadge, `new Date(conversation.created_at)`) interpretava
            # como horário local do navegador, não UTC, e o "há Xmin esperando"
            # saía errado pelo offset de fuso inteiro (podendo mascarar SLA
            # estourado). to_utc_iso() explicita o "Z" pra não dar ambiguidade.
            "created_at": to_utc_iso(conv.created_at),
            "assigned_at": to_utc_iso(conv.assigned_at),
            "resolved_at": to_utc_iso(conv.resolved_at),
            "pending_since": to_utc_iso(conv.pending_since),
            # NULL = nunca voltou pra fila depois de já ter sido trabalhada,
            # front cai pra created_at (ver Sidebar.js::getSlaBadge).
            "queue_since": to_utc_iso(conv.queue_since),
            "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in conv.tags],
            "messages": [],
            "contact": {
                "id": conv.contact.id,
                "wa_id": conv.contact.wa_id,
                "name": conv.contact.name,
                "saved_name": custom_name if custom_name is not None else conv.contact.saved_name,
                "push_name": conv.contact.push_name,
                "phone_number": conv.contact.phone_number,
                "profile_picture_url": conv.contact.profile_picture_url,
                "is_group": conv.contact.is_group,
                "is_internal": conv.contact.is_internal,
                "notes": conv.contact.notes,
                "created_at": to_utc_iso(conv.contact.created_at),
                "updated_at": to_utc_iso(conv.contact.updated_at)
            },
            "last_message": {
                "message": last_message.message_text or last_message.caption or f"[{last_message.message_type.value}]",
                "timestamp": last_message.timestamp,
                "type": last_message.message_type.value,
                "direction": last_message.direction.value,
                "sender_push_name": last_message.sender_push_name or "",
                "from_number": last_message.participant_jid.split("@")[0] if (conv.is_group and last_message.participant_jid) else "",
            } if last_message else None,
        }

    def search_conversations(
        self,
        db: Session,
        query_text: str,
        account_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Busca conversas pelo nome/telefone do contato (aba "Conversas" da busca)."""
        try:
            like = f"%{query_text}%"

            base = db.query(Conversation).join(Contact).options(
                selectinload(Conversation.contact),
                selectinload(Conversation.assigned_to),
                selectinload(Conversation.tags),
            ).filter(
                Contact.wa_id.notin_(NON_CUSTOMER_WA_IDS),
                or_(
                    Conversation.is_group.is_(True),
                    exists().where(Message.conversation_id == Conversation.id),
                ),
            )
            if account_id is not None:
                base = base.filter(Conversation.account_id == account_id)

            # Nome customizado por conta (ContactAccountName) também entra na busca —
            # do contrário um contato só teria match pelo nome legado em Contact.
            matching_pairs = {
                (row.contact_id, row.account_id)
                for row in db.query(ContactAccountName.contact_id, ContactAccountName.account_id)
                .filter(ContactAccountName.custom_name.ilike(like))
                .all()
            }

            conversations = base.filter(
                or_(
                    Contact.name.ilike(like),
                    Contact.push_name.ilike(like),
                    Contact.saved_name.ilike(like),
                    Contact.phone_number.ilike(like),
                    tuple_(Conversation.contact_id, Conversation.account_id).in_(matching_pairs),
                )
            ).order_by(desc(Conversation.last_message_at)).all()

            custom_name_map = {}
            pairs = {(c.contact_id, c.account_id) for c in conversations if c.account_id is not None}
            if pairs:
                custom_name_map = {
                    (row.contact_id, row.account_id): row.custom_name
                    for row in db.query(ContactAccountName).filter(
                        tuple_(ContactAccountName.contact_id, ContactAccountName.account_id).in_(pairs)
                    ).all()
                }

            return [
                self._build_conversation_summary(
                    db, conv, custom_name=custom_name_map.get((conv.contact_id, conv.account_id))
                )
                for conv in conversations
            ]

        except Exception as e:
            logger.error(f"Erro ao buscar conversas por termo '{query_text}': {e}", exc_info=True)
            return []

    def search_messages(
        self,
        db: Session,
        query_text: str,
        account_id: Optional[int] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """
        Busca TODAS as ocorrências de mensagens cujo texto/legenda batem com o
        termo (aba "Mensagens" da busca) — ao contrário de search_conversations,
        que devolve uma conversa só uma vez, aqui cada ocorrência aparece,
        identificando quem mandou, quando e em qual conversa.
        """
        try:
            like = f"%{query_text}%"

            q = db.query(Message).join(
                Conversation, Message.conversation_id == Conversation.id
            ).join(
                Contact, Conversation.contact_id == Contact.id
            ).filter(
                Contact.wa_id.notin_(NON_CUSTOMER_WA_IDS),
                or_(Message.message_text.ilike(like), Message.caption.ilike(like)),
            )
            if account_id is not None:
                q = q.filter(Conversation.account_id == account_id)

            messages = q.order_by(desc(Message.timestamp)).limit(limit).all()

            result = []
            for msg in messages:
                conv = msg.conversation
                contact = conv.contact
                is_outbound = msg.direction == Direction.OUTBOUND

                if is_outbound:
                    sender_name = "Você"
                elif conv.is_group:
                    sender_name = msg.sender_push_name or (
                        msg.participant_jid.split("@")[0] if msg.participant_jid else "Desconhecido"
                    )
                else:
                    sender_name = contact.name or contact.push_name or _format_phone_display(contact.wa_id)

                result.append({
                    "wamid": msg.wamid,
                    "conversation_id": conv.id,
                    "account_id": conv.account_id,
                    "contact_name": contact.name or contact.push_name or _format_phone_display(contact.wa_id),
                    "is_group": conv.is_group,
                    "group_name": conv.group_name,
                    "sender_name": sender_name,
                    "direction": msg.direction.value,
                    "message": msg.message_text or msg.caption or f"[{msg.message_type.value}]",
                    "timestamp": msg.timestamp,
                })

            return result

        except Exception as e:
            logger.error(f"Erro ao buscar mensagens por termo '{query_text}': {e}", exc_info=True)
            return []

    def get_conversation_messages(
        self,
        db: Session,
        conversation_id: int,
        limit: int = 50,
        before_timestamp: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Retorna mensagens de uma conversa, ordenadas da mais antiga pra mais nova.

        Sem before_timestamp: as `limit` mais recentes (comportamento original,
        usado no 1º carregamento do chat). Com before_timestamp: as `limit`
        mensagens imediatamente ANTERIORES a esse timestamp — usado pra
        "carregar mensagens antigas" ao rolar pro topo do chat.

        Cursor por timestamp (não por id/offset): é o único jeito seguro de
        paginar aqui, porque o backfill de histórico (ver
        project_baileys_parity) insere linhas com id alto mas timestamp
        antigo — um offset por id/posição pularia ou repetiria mensagens
        dependendo da ordem de inserção. NOTA: o parâmetro `offset` que
        existia aqui antes nunca era de fato usado na query (dead code) —
        removido junto com essa troca.
        """
        query = db.query(Message.id).filter(Message.conversation_id == conversation_id)
        if before_timestamp is not None:
            query = query.filter(Message.timestamp < before_timestamp)
        subq = query.order_by(Message.timestamp.desc()).limit(limit).subquery()

        messages = db.query(Message).options(
            joinedload(Message.contact),
            joinedload(Message.conversation),
        ).filter(
            Message.id.in_(subq)
        ).order_by(
            Message.timestamp.asc()
        ).all()

        return [self._format_message(msg) for msg in messages]

    @staticmethod
    def _get_conversation_tags(db: Session, conversation_id: int) -> List[Dict[str, Any]]:
        conv = db.query(Conversation).filter(Conversation.id == conversation_id).first()
        if not conv:
            return []
        return [{"id": t.id, "name": t.name, "color": t.color} for t in conv.tags]

    def get_conversation_notes(self, db: Session, conversation_id: int) -> List[Dict[str, Any]]:
        """
        Thread de notas internas de uma conversa — nunca sai para o WhatsApp.
        Formatada com timestamp em ms (mesmo formato de Message) e is_internal_note
        pra o frontend mesclar na mesma timeline do chat por ordem cronológica.
        """
        notes = db.query(InternalNote).filter(
            InternalNote.conversation_id == conversation_id
        ).order_by(InternalNote.created_at.asc()).all()

        return [{
            "id": f"note_{n.id}",
            "is_internal_note": True,
            "text": n.text,
            "message": n.text,
            "author": (n.author.full_name or n.author.email) if n.author else "Desconhecido",
            "author_id": n.user_id,
            "timestamp": int(n.created_at.timestamp() * 1000) if n.created_at else 0,
        } for n in notes]

    def get_status_messages(
        self,
        db: Session,
        account_id: Optional[int] = None,
        since_ms: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retorna as mensagens do contato especial status@broadcast (Status/Stories do
        WhatsApp) — excluído de get_all_conversations_with_last_message de propósito,
        para não poluir a lista de conversas reais. since_ms filtra por timestamp
        (ms epoch) mínimo, ex. últimas 24h.
        """
        query = db.query(Conversation).join(Contact).filter(Contact.wa_id == 'status@broadcast')
        if account_id is not None:
            query = query.filter(Conversation.account_id == account_id)
        status_conv = query.first()
        if not status_conv:
            return []

        msg_query = db.query(Message).filter(Message.conversation_id == status_conv.id)
        if since_ms is not None:
            msg_query = msg_query.filter(Message.timestamp >= since_ms)

        messages = msg_query.order_by(Message.timestamp.asc()).all()
        return [self._format_message(msg) for msg in messages]

    def mark_messages_read(
        self,
        db: Session,
        contact_wa_id: str,
        message_ids: List[str]
    ) -> bool:
        """Marca mensagens como lidas"""
        try:
            for wamid in message_ids:
                message = db.query(Message).filter(Message.wamid == wamid).first()
                if message:
                    message.status = MessageStatus.READ
            
            db.commit()
            return True
        
        except Exception as e:
            logger.error(f"Erro ao marcar mensagens como lidas: {e}")
            db.rollback()
            return False
    
    def save_outbound_message(
        self,
        db: Session,
        wamid: str,
        conversation_id: int,
        contact_id: int,
        message_type: str,
        message_text: Optional[str] = None,
        caption: Optional[str] = None,
        media_id: Optional[str] = None,
        media_url: Optional[str] = None,
        mime_type: Optional[str] = None,
        filename: Optional[str] = None,
        file_size: Optional[int] = None,
        reply_to_wamid: Optional[str] = None,
        interactive_payload: Optional[dict] = None,
    ) -> Message:
        """Salva mensagem enviada (outbound) no banco de dados"""
        try:
            # Idempotência: se o WAMID já foi salvo pelo webhook, atualiza media_url se necessário
            existing = db.query(Message).filter(Message.wamid == wamid).first()
            if not existing:
                # Match exato não achou — tenta pelo núcleo hex (ver comentário
                # em _wamid_hex_core) escopado a esta conversa, pro caso do eco
                # do webhook já ter criado a linha num formato diferente do
                # wamid cru que temos aqui.
                core = _wamid_hex_core(wamid)
                if core:
                    candidates = (
                        db.query(Message)
                        .filter(Message.conversation_id == conversation_id, Message.direction == Direction.OUTBOUND)
                        .order_by(Message.id.desc())
                        .limit(200)
                        .all()
                    )
                    existing = next((c for c in candidates if _wamid_hex_core(c.wamid) == core), None)
            if existing:
                # Confirma que esta mensagem passou pela nossa API mesmo quando o
                # eco do webhook ganhou a corrida e criou a linha primeiro (ver
                # sent_via_platform em models.py) — sem isso o stuck_wppconnect_watchdog
                # não teria como saber que É candidata legítima a reenvio.
                existing.sent_via_platform = True
                if media_url and not existing.media_url:
                    existing.media_url = media_url
                    db.commit()
                    logger.info(f"media_url atualizada para WAMID {wamid}: {media_url}")
                else:
                    db.commit()
                    logger.info(f"WAMID {wamid} já existe (salvo pelo webhook), retornando existente")
                return existing

            msg_type_enum = self._get_message_type_enum(message_type)

            message = Message(
                wamid=wamid,
                conversation_id=conversation_id,
                contact_id=contact_id,
                message_type=msg_type_enum,
                direction=Direction.OUTBOUND,
                message_text=message_text,
                caption=caption,
                media_id=media_id,
                media_url=media_url,
                mime_type=mime_type,
                filename=filename,
                reply_to_wamid=reply_to_wamid,
                interactive_payload=interactive_payload,
                sent_via_platform=True,
                status=MessageStatus.SENT,
                timestamp=int(datetime.now().timestamp() * 1000)
            )
            
            db.add(message)

            conversation = db.query(Conversation).filter(
                Conversation.id == conversation_id
            ).first()

            if conversation:
                conversation.last_message_at = datetime.now()

            db.commit()
            db.refresh(message)

            # Preview estilo WhatsApp (ícone + nome + tamanho) precisa do
            # tamanho do arquivo — antes só existia pra mídia RECEBIDA
            # (_download_media sempre cria um MediaFile ao baixar). Mídia
            # ENVIADA por nós nunca criava essa linha, então o preview de
            # documento enviado nunca mostrava tamanho nenhum.
            if file_size and (filename or media_url):
                try:
                    media_file = MediaFile(
                        media_id=media_id or wamid,
                        filename=filename or (media_url.rsplit("/", 1)[-1] if media_url else "arquivo"),
                        filepath=media_url or "",
                        mime_type=mime_type,
                        file_size=file_size,
                        message_id=message.id,
                    )
                    db.add(media_file)
                    db.commit()
                except IntegrityError:
                    # media_id colidiu com um já existente (raro) — não é
                    # crítico, só faz o preview ficar sem tamanho pra essa
                    # mensagem específica. O envio em si já foi salvo acima.
                    db.rollback()
                    logger.warning(f"Não foi possível salvar MediaFile (tamanho) pra WAMID {wamid} — media_id duplicado")

            logger.info(f"Mensagem outbound salva: {wamid}")
            return message

        except IntegrityError:
            # Corrida: wa-web/wppconnect ecoam a própria mensagem enviada quase
            # instantaneamente (onAnyMessage cobre "sent and received") — o
            # webhook pode inserir esse wamid entre o check de "existing" acima
            # e este INSERT. Não é erro real, a mensagem já está salva; só
            # busca e devolve em vez de propagar 500 pro chamador.
            db.rollback()
            existing = db.query(Message).filter(
                Message.wamid == wamid, Message.conversation_id == conversation_id
            ).first()
            if existing:
                logger.info(f"WAMID {wamid} salvo em corrida pelo webhook, retornando existente")
                return existing
            raise

        except Exception as e:
            logger.error(f"Erro ao salvar mensagem outbound: {e}")
            db.rollback()
            raise

    def save_failed_outbound_message(
        self,
        db: Session,
        conversation_id: int,
        contact_id: int,
        message_type: str,
        message_text: Optional[str],
        failed_payload: dict,
        caption: Optional[str] = None,
        reply_to_wamid: Optional[str] = None,
    ) -> Message:
        """
        Envio pro WhatsApp falhou (provider indisponível/erro) antes de existir
        um wamid real — sem isso a mensagem simplesmente não aparecia em
        lugar nenhum (a rota só retornava um erro HTTP pro front, nada era
        salvo). Cria uma linha com status=FAILED e um wamid sintético só pra
        satisfazer a constraint de unicidade; `failed_payload` guarda os
        parâmetros originais do envio (to/text/tipo/etc) pra retry manual
        (POST /messages/{id}/retry-send) tentar reenviar de verdade depois.
        """
        wamid = f"failed_out_{uuid.uuid4().hex}"
        message = Message(
            wamid=wamid,
            conversation_id=conversation_id,
            contact_id=contact_id,
            message_type=self._get_message_type_enum(message_type),
            direction=Direction.OUTBOUND,
            message_text=message_text,
            caption=caption,
            reply_to_wamid=reply_to_wamid,
            status=MessageStatus.FAILED,
            timestamp=int(datetime.now().timestamp() * 1000),
            failed_payload=failed_payload,
        )
        db.add(message)
        conversation = db.query(Conversation).filter(Conversation.id == conversation_id).first()
        if conversation:
            conversation.last_message_at = datetime.now()
        db.commit()
        db.refresh(message)
        logger.info(f"Mensagem outbound com falha registrada (id={message.id}, wamid sintético={wamid})")
        return message

    def handle_agent_outbound_reply(
        self, db: Session, conversation: Conversation, agent_user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Chamado logo após um atendente humano mandar qualquer tipo de mensagem
        (texto/mídia/interativo/template — ver chamadas em routes.py). Auto-
        atribui a conversa a quem respondeu (só se ainda não tiver dono — não
        reatribui quem já está em atendimento por outra pessoa) e marca
        status="pending" (aguardando o cliente responder), iniciando o
        cronômetro de "tempo pendente".

        Usa um único `now` para os dois campos: se a atribuição e a virada
        pra pending acontecem no mesmo evento (primeira resposta numa
        conversa ainda não atribuída), os dois cronômetros começam exatamente
        juntos.

        Não mexe em conversas resolvidas — reabrir uma conversa "resolved" é
        uma ação explícita do usuário (confirmação no frontend + PATCH
        /status), não um efeito colateral automático de mandar mensagem.
        Grupo também fica de fora, como o resto do módulo de atendimento.

        Também encerra qualquer alerta de "bot travado/em loop" nessa
        conversa (ver bot_loop_detected) — um humano acabou de responder, ou
        seja, já assumiu; não importa se é grupo/resolvida, esse reset
        acontece sempre.

        E, se o bot ainda estava ativo (bot_enabled), esse é o momento exato
        do handoff bot→humano: pausa o bot (mesma regra que antes só existia
        hardcoded em /send/text, agora vale pra qualquer tipo de mensagem
        enviada por um atendente — texto/mídia/interativo/template/etc, todas
        passam por aqui) e grava bot_handoff_at, pra dar pra medir "quanto
        tempo o bot cuidou até um humano assumir" — diferente de assigned_at,
        que marca quando ATRIBUÍDA (pode ter sido atribuída manualmente antes
        de qualquer humano de fato responder, enquanto o bot ainda respondia
        sozinho).

        Não commita — quem chama decide quando commitar/broadcastar. Retorna
        só os campos que mudaram (pra broadcast), ou None se nada mudou.
        """
        changes: Dict[str, Any] = {}
        now = datetime.utcnow()

        if not conversation.ever_handled_by_human:
            conversation.ever_handled_by_human = True
            changes["ever_handled_by_human"] = True

        if conversation.bot_loop_detected or conversation.bot_repeat_count or conversation.bot_forwarded_at:
            conversation.bot_loop_detected = False
            conversation.bot_repeat_count = 0
            conversation.bot_forwarded_at = None
            conversation.bot_last_reply_text = None
            changes["bot_loop_detected"] = False

        if conversation.bot_enabled:
            conversation.bot_enabled = False
            conversation.bot_handoff_at = now
            changes["bot_enabled"] = False
            changes["bot_handoff_at"] = to_utc_iso(now)

        if conversation.is_group or conversation.status == "resolved":
            return changes or None

        # Só auto-atribui se o papel de quem respondeu participa mesmo da
        # mecânica de atendimento (feature_attendance_agent) — sem essa
        # checagem, qualquer usuário que tivesse permissão de ENVIAR mensagem
        # (ex: alguém movido pra um papel de outro setor, tipo "logistica",
        # que ainda pode mandar mensagem mas não deveria mais entrar no pool
        # de atendimento/SLA) virava "responsável" pela conversa só por ter
        # respondido uma vez. Conversa fica na fila (sem responsável) nesse
        # caso, em vez de grudar em alguém que não deveria contar SLA.
        if conversation.assigned_to_user_id is None:
            from backend.api.permissions import user_has_permission
            from backend.database.models import User as _User
            agent = db.query(_User).filter(_User.id == agent_user_id).first()
            if agent and user_has_permission(db, agent, "feature_attendance_agent"):
                conversation.assigned_to_user_id = agent_user_id
                conversation.assigned_at = now
                changes["assigned_at"] = to_utc_iso(now)

        if conversation.status != "pending":
            conversation.status = "pending"
            conversation.pending_since = now
            changes["status"] = "pending"
            changes["pending_since"] = to_utc_iso(now)

        return changes or None

    def flag_bot_needs_attention(self, db: Session, conversation: Conversation) -> bool:
        """
        Marca a conversa pra alertar visualmente na UI (piscar vermelho na
        lista + botão de bot) que o bot/IA travou ou está em loop. Chamada
        por 3 sinais independentes: erro/exceção ao encaminhar pro webhook de
        IA (webhook_handler._forward_to_ai_webhook), resposta repetida N
        vezes seguidas (routes_ai_bot.py::bot_reply) ou silêncio prolongado
        depois de encaminhado (bot_health_watchdog.py).

        Idempotente — não commita de novo se já estava marcado (evita
        broadcast redundante a cada novo sinal enquanto o alerta já está
        ativo). Não conhece websocket — quem chama decide o broadcast,
        só quando o retorno é True.
        """
        if conversation.bot_loop_detected:
            return False
        conversation.bot_loop_detected = True
        db.commit()
        return True

    def register_bot_reply(self, db: Session, conversation: Conversation, reply_text: Optional[str]) -> Dict[str, Any]:
        """
        Bookkeeping comum de "o bot respondeu de verdade" — chamado por TODO
        canal de saída de resposta de bot/IA: o genérico (routes_ai_bot.py::
        bot_reply) e os 3 endpoints Evolution-compat (routes_evolution_compat.py
        evo_send_text/sendMedia/sendContact). Ter dois canais de saída com essa
        lógica duplicada (ou, como era antes, só implementada num deles) foi
        exatamente o bug: contas em modo evolution_compat respondiam pelo
        Evolution shim, que não tocava em bot_forwarded_at/bot_loop_detected,
        então um alerta de "bot travado" disparado por silêncio (bot_health_
        watchdog) nunca era limpo, mesmo com o bot respondendo normalmente.

        Faz 2 coisas:
        1. Limpa bot_forwarded_at — não está mais "esperando resposta" pro
           bot_health_watchdog, incondicional (a resposta chegou).
        2. Quando reply_text vem preenchido (mídia/contato sem legenda passam
           None e pulam isso — não dá pra comparar repetição sem texto):
           atualiza a detecção de loop por repetição (bot_repeat_count) e, se
           essa resposta rompe um loop anterior (conteúdo novo, não repetido),
           limpa bot_loop_detected — evidência de que o bot voltou a
           funcionar. Se a própria resposta atual bater o limiar de repetição,
           marca de novo via flag_bot_needs_attention.

        Não commita tudo de uma vez (flag_bot_needs_attention commita por
        conta própria, mantendo o padrão já usado por ela) — quem chama ainda
        deve commitar o resto depois. Retorna só os campos que mudaram (pra
        broadcast via ws_manager.broadcast_conversation_meta_update).
        """
        changes: Dict[str, Any] = {}
        conversation.bot_forwarded_at = None

        if reply_text:
            now = datetime.utcnow()
            normalized = reply_text.strip().lower()
            same_as_last = (
                conversation.bot_last_reply_text == normalized
                and conversation.bot_last_reply_at is not None
                and (now - conversation.bot_last_reply_at) < BOT_REPEAT_WINDOW
            )
            conversation.bot_repeat_count = (conversation.bot_repeat_count or 0) + 1 if same_as_last else 1
            conversation.bot_last_reply_text = normalized
            conversation.bot_last_reply_at = now

            if not same_as_last and conversation.bot_loop_detected:
                conversation.bot_loop_detected = False
                changes["bot_loop_detected"] = False

            if conversation.bot_repeat_count >= BOT_REPEAT_THRESHOLD:
                if self.flag_bot_needs_attention(db, conversation):
                    changes["bot_loop_detected"] = True

        return changes

    @staticmethod
    def _format_message(msg: Message) -> Dict[str, Any]:
        """CORRIGIDO - Formata mensagem SEMPRE com campo 'message'"""
        message_content = ""
        
        if msg.message_type == MessageType.LOCATION and msg.message_text:
            try:
                import json
                location_data = json.loads(msg.message_text)
                message_content = "📍 Localização"
            except (ValueError, TypeError):
                message_content = msg.message_text
                location_data = None
        elif msg.message_text:
            message_content = msg.message_text
        elif msg.caption:
            message_content = msg.caption
        else:
            type_placeholders = {
                MessageType.IMAGE: "📷 Imagem",
                MessageType.VIDEO: "🎥 Vídeo",
                MessageType.AUDIO: "🎵 Áudio",
                MessageType.DOCUMENT: "📄 Documento",
                MessageType.STICKER: "🎭 Sticker",
                MessageType.LOCATION: "📍 Localização",
            }
            message_content = type_placeholders.get(msg.message_type, "💬 Mensagem")
        
        is_inbound = msg.direction == Direction.INBOUND
        is_group = (
            (msg.conversation.is_group if msg.conversation else False)
            or bool(msg.conversation.group_jid if msg.conversation else None)
            or bool(msg.participant_jid)
        )

        # Para grupos: from_number é o telefone do participante (sender real)
        # Para individuais: é o telefone do contato
        if is_group and msg.participant_jid:
            from_number = msg.participant_jid.split("@")[0]
        elif is_inbound:
            from_number = msg.contact.phone_number
        else:
            from_number = "me"

        # Nome do sender: para grupos, NUNCA usar contact.name/phone (são do grupo, não do participante).
        # Também NUNCA usar sender_push_name (nome autodeclarado no WhatsApp) como nome do
        # participante — isso faria qualquer pessoa aparecer "salva" mesmo sem estar na agenda.
        # Só mostra um nome quando o participante tem Contact.saved_name (agenda real); caso
        # contrário fica vazio e o frontend cai no número de telefone puro, igual ao WhatsApp.
        if is_group and is_inbound:
            participant_phone = msg.participant_jid.split("@")[0] if msg.participant_jid else None
            saved_name = None
            if participant_phone:
                db = object_session(msg)
                if db is not None:
                    participant_contact = (
                        db.query(Contact)
                        .filter(Contact.phone_number == participant_phone, Contact.is_group == False)
                        .first()
                    )
                    saved_name = participant_contact.saved_name if participant_contact else None
            sender_name = saved_name or ""
        else:
            sender_name = (
                msg.sender_push_name
                or msg.contact.push_name
                or msg.contact.name
                or ""
            )

        message_data = {
            "id": msg.id,
            "wamid": msg.wamid,
            "type": msg.message_type.value,
            "direction": msg.direction.value,
            "from_number": from_number,
            "contact_name": sender_name,
            "push_name": msg.sender_push_name or msg.contact.push_name or "",
            "is_group": is_group,
            "group_jid": msg.conversation.group_jid if msg.conversation else None,
            "group_name": msg.conversation.group_name if msg.conversation else None,
            "participant_jid": msg.participant_jid,
            "sender_push_name": msg.sender_push_name or "",
            "timestamp": msg.timestamp,
            "status": msg.status.value,
            "sender": "contact" if is_inbound else "me",
            "message": message_content,
            "reaction_emoji": msg.reaction_emoji,
            "is_starred": bool(msg.is_starred),
            "is_pinned": bool(msg.is_pinned),
        }
        
        if msg.caption:
            message_data["caption"] = msg.caption
        
        if msg.media_id:
            message_data["media_id"] = msg.media_id
            message_data["mediaUrl"] = f"/api/media/proxy/{msg.media_id}"
        elif msg.media_url:
            message_data["mediaUrl"] = msg.media_url
        
        if msg.mime_type:
            message_data["mime_type"] = msg.mime_type
        
        if msg.filename:
            message_data["filename"] = msg.filename

        # Tamanho do arquivo (bytes) — pro front mostrar "123 KB" igual ao
        # WhatsApp real, pra qualquer tipo de mídia, não só documento.
        # media_file existe pra inbound (sempre baixado, ver _download_media)
        # e agora também pra outbound (ver save_outbound_message).
        if msg.media_file and msg.media_file.file_size:
            message_data["file_size"] = msg.media_file.file_size

        if msg.reply_to_wamid:
            message_data["reply_to_wamid"] = msg.reply_to_wamid

        if msg.interactive_payload:
            message_data["interactive_payload"] = msg.interactive_payload

        if msg.message_type == MessageType.LOCATION:
            try:
                import json
                loc = json.loads(msg.message_text) if msg.message_text else None
                if loc and isinstance(loc, dict) and "latitude" in loc:
                    message_data["location"] = loc
            except (ValueError, TypeError):
                pass

        return message_data
    
    @staticmethod
    def _get_message_type_enum(msg_type: str) -> MessageType:
        """Converte string de tipo para enum"""
        type_map = {
            "text": MessageType.TEXT,
            "image": MessageType.IMAGE,
            "video": MessageType.VIDEO,
            "audio": MessageType.AUDIO,
            "document": MessageType.DOCUMENT,
            "sticker": MessageType.STICKER,
            "location": MessageType.LOCATION,
            "interactive": MessageType.INTERACTIVE,
            "template": MessageType.TEMPLATE
        }
        return type_map.get(msg_type, MessageType.TEXT)


# Instância global
conversation_service = ConversationService()
