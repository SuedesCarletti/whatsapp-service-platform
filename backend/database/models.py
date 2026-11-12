from sqlalchemy import Column, Integer, String, Text, Boolean, TIMESTAMP, BigInteger, Enum, ForeignKey, DECIMAL, JSON, DateTime, UniqueConstraint, Table
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from datetime import datetime
from backend.database.connection import Base
import enum


class MessageType(str, enum.Enum):
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    DOCUMENT = "document"
    STICKER = "sticker"
    LOCATION = "location"
    INTERACTIVE = "interactive"
    TEMPLATE = "template"
    REACTION = "reaction"


class Direction(str, enum.Enum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


class MessageStatus(str, enum.Enum):
    SENT = "sent"
    DELIVERED = "delivered"
    READ = "read"
    FAILED = "failed"


class Contact(Base):
    __tablename__ = "contacts"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    wa_id = Column(String(100), unique=True, nullable=False, index=True)
    phone_number = Column(String(50), nullable=False, index=True)
    lid = Column(String(100), nullable=True, index=True)  # LID Baileys (ex: "128904920580321") sem sufixo @lid
    name = Column(String(255))
    push_name = Column(String(255), nullable=True)
    # Nome real da agenda de endereços do WhatsApp (Baileys c.name), NUNCA derivado
    # do push_name. Só é preenchido quando o contato está de fato salvo na agenda
    # do telefone vinculado — usado para diferenciar "salvo" de "não salvo".
    saved_name = Column(String(255), nullable=True)
    profile_picture_url = Column(Text)
    is_group = Column(Boolean, default=False, nullable=False, index=True)
    group_subject = Column(String(255), nullable=True)
    # Contato interno (colega/fornecedor falando pelo mesmo número da empresa)
    # — no nível de Contact (não de Conversation) porque cobre todas as contas
    # ligadas a esse wa_id de forma permanente; Conversation.bot_enabled é
    # transiente (volta a True sozinho quando a conversa reabre, ver
    # webhook_handler.py) e não serviria pra esse propósito. Gate único em
    # webhook_handler._forward_to_ai_webhook (sem bot/IA), no aviso de
    # fora-do-horário, no disparo de CSAT (routes_attendance.py) e no cálculo
    # de sla_breaches_now (attendance_reports).
    is_internal = Column(Boolean, default=False, nullable=False)
    # Observações internas do atendente sobre o cliente (preferências, histórico
    # relevante etc.) — nunca sincronizado com o WhatsApp, só uso interno da equipe.
    notes = Column(Text, nullable=True)
    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    conversations = relationship("Conversation", back_populates="contact", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="contact", cascade="all, delete-orphan")


class ContactAccountName(Base):
    """
    Nome customizado de um contato POR conta WhatsApp — Contact.wa_id é
    globalmente único (compartilhado entre todas as contas que falam com
    aquele telefone), então Contact.saved_name sozinho vazava o nome de um
    cliente entre contas diferentes da empresa. Esta tabela é a fonte de
    verdade do nome exibido quando existe uma linha para (contact_id,
    account_id); Contact.saved_name vira só o fallback legado (edições
    antigas, antes desta tabela existir).
    """
    __tablename__ = "contact_account_names"
    __table_args__ = (
        UniqueConstraint('contact_id', 'account_id', name='ux_contact_account_names_contact_account'),
    )

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    contact_id = Column(Integer, ForeignKey('contacts.id', ondelete='CASCADE'), nullable=False, index=True)
    account_id = Column(Integer, ForeignKey('whatsapp_accounts.id', ondelete='CASCADE'), nullable=False, index=True)
    custom_name = Column(String(255), nullable=False)
    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, server_default=func.current_timestamp(), onupdate=func.current_timestamp())


class Conversation(Base):
    __tablename__ = "conversations"
    # Unicidade (contact_id, account_id): bug real confirmado 2026-09-03
    # (contact_id=210, account_id=15, conversas 268/269, a 2ª vazia) — 2
    # mensagens quase simultâneas pro mesmo contato+conta corriam o SELECT de
    # get_or_create_conversation antes de qualquer INSERT commitar, cada uma
    # criando sua própria conversa. Ficou mais provável desde que o
    # processamento de webhook passou a rodar em várias threads concorrentes
    # (routes_bridge.py::WEBHOOK_EXECUTOR). Não cobre account_id NULL (MySQL
    # trata cada NULL como distinto em UNIQUE composto) — não é o caso do bug.
    __table_args__ = (
        UniqueConstraint('contact_id', 'account_id', name='ux_conversations_contact_account'),
    )

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    contact_id = Column(Integer, ForeignKey('contacts.id', ondelete='CASCADE'), nullable=False, index=True)

    account_id = Column(Integer, ForeignKey('whatsapp_accounts.id', ondelete='SET NULL'), nullable=True, index=True)

    is_group = Column(Boolean, default=False, nullable=False, index=True)
    group_jid = Column(String(150), nullable=True, index=True)
    group_name = Column(String(255), nullable=True)

    last_message_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    unread_count = Column(Integer, default=0)
    is_archived = Column(Boolean, default=False)
    # "Fixar conversa" — flag própria do app (não o pin nativo do protocolo
    # WhatsApp, que é limitado a 3 chats e nem existe pra conversa interna/
    # grupo em alguns providers). Ordena pro topo da Sidebar em ambas as
    # abas (clientes/equipe), ver Sidebar.js.
    is_pinned = Column(Boolean, default=False, nullable=False)
    # "Favoritar"/"Silenciar" — mesma ideia de is_pinned: flag própria do
    # app, não o pin/mute nativo do protocolo WhatsApp (que só chama a API
    # do bridge, sem persistir nada aqui pra Sidebar refletir). is_muted não
    # tem relação com PATCH /baileys/chat/mute (que continua existindo à
    # parte, best-effort, pra quem quiser silenciar no app do celular
    # também) — essa aqui é só o que o NOSSO app usa pra parar de tocar som/
    # notificação dessa conversa.
    is_favorite = Column(Boolean, default=False, nullable=False)
    is_muted = Column(Boolean, default=False, nullable=False)
    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    # Atendimento: fila/atribuição/status — antes disso, uma conversa não tinha
    # dono nem estado de ciclo de vida, só is_archived. status segue o modelo
    # dos apps de central de atendimento: open (na fila/ativa) -> pending
    # (aguardando algo) -> resolved (fechada, reabre sozinha se o cliente
    # responder de novo, ver webhook_handler._process_incoming_messages).
    status = Column(String(20), nullable=False, default="open", index=True)  # open|pending|resolved
    assigned_to_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    assigned_at = Column(DateTime, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    # Início do cronômetro de "aguardando resposta do cliente": setado junto
    # com status="pending", tanto pela troca manual quanto automaticamente
    # quando um atendente responde (ConversationService.handle_agent_outbound_reply).
    pending_since = Column(DateTime, nullable=True)
    awaiting_csat = Column(Boolean, default=False, nullable=False)
    # Quando a pesquisa de CSAT foi enviada — diferente de awaiting_csat (que
    # é limpo ao responder ou por timeout), este campo nunca é apagado, então
    # dá pra calcular taxa de resposta (respostas / pesquisas enviadas) num
    # período mesmo depois da flag já ter virado False (ver /attendance/reports).
    csat_sent_at = Column(DateTime, nullable=True)
    last_business_hours_autoreply_at = Column(DateTime, nullable=True)
    # Início do cronômetro de "esperando na fila, sem responsável" — igual
    # pending_since, mas pro badge "⏳ esperando" do Sidebar (Sidebar.js::
    # getSlaBadge). NULL = usa created_at (comportamento original, conversa
    # nunca saiu da fila desde que nasceu). Setado explicitamente pra "agora"
    # quando a conversa VOLTA a ficar sem responsável depois de já ter sido
    # trabalhada — reabertura sem responsável (webhook_handler.py) ou
    # liberação manual (routes_attendance.py assign_conversation com
    # user_id=None) — sem isso o badge mostrava "esperando há Nº dias" usando
    # a data de criação original, em vez do momento em que voltou à fila.
    queue_since = Column(DateTime, nullable=True)

    # Integração com bot/IA externo (n8n ou qualquer outra ferramenta que
    # fale com POST /api/bot/reply) — controla se essa conversa deve ser
    # encaminhada pro webhook de IA da conta. Pausa sozinho quando um
    # atendente humano manda uma mensagem real, de qualquer tipo (Conversation
    # Service.handle_agent_outbound_reply, chamado por todos os /send/* de
    # routes.py) e volta a True quando a conversa reabre depois de resolvida
    # (webhook_handler._run_attendance_automations).
    bot_enabled = Column(Boolean, default=True, nullable=False)
    # Momento exato do handoff bot→humano: quando bot_enabled vira False por
    # um atendente ter mandado mensagem (ver handle_agent_outbound_reply) —
    # NULL enquanto o bot nunca foi pausado por um humano nessa conversa.
    # Diferente de assigned_at: uma conversa pode já estar atribuída
    # manualmente (fila) enquanto o bot ainda responde sozinho; isto aqui
    # marca especificamente quando alguém de fato assumiu a resposta, pra dar
    # pra medir "quanto tempo o bot cuidou até um humano assumir".
    bot_handoff_at = Column(DateTime, nullable=True)
    # Diferente de bot_handoff_at (que é ZERADO de propósito ao marcar a
    # conversa Resolvida, pra religar o bot numa eventual reabertura) — este
    # aqui vira True na primeira mensagem de um atendente humano e NUNCA mais
    # volta a False, nem ao resolver/reabrir. É o único jeito confiável de
    # medir, depois da conversa já resolvida, "um humano chegou a responder
    # aqui alguma vez" (dashboard admin, ver /dashboard/trends). Setado em
    # ConversationService.handle_agent_outbound_reply.
    ever_handled_by_human = Column(Boolean, default=False, nullable=False)

    # Alerta de "bot travado/em loop" — liga sozinho a UI (piscar vermelho na
    # lista + botão de bot) pra sinalizar que um atendente precisa assumir.
    # Setado por 3 sinais independentes: webhook de IA deu erro/exceção ao
    # encaminhar (webhook_handler._forward_to_ai_webhook), a mesma resposta
    # chegou repetida N vezes seguidas em pouco tempo (routes_ai_bot.py::
    # bot_reply, ver bot_repeat_count/bot_last_reply_text/bot_last_reply_at),
    # ou o bot ficou em silêncio tempo demais depois de receber a mensagem
    # (bot_health_watchdog.py, usa bot_forwarded_at). Limpo sozinho assim que
    # um humano manda qualquer mensagem (ConversationService.
    # handle_agent_outbound_reply), alguém mexe manualmente no toggle de bot,
    # ou o próprio bot volta a responder com conteúdo novo/não repetido
    # (routes_ai_bot.py::bot_reply) — sem isso, um alerta de silêncio
    # prolongado ficava travado em True pra sempre mesmo depois do fluxo no
    # n8n terminar e responder normalmente.
    bot_loop_detected = Column(Boolean, default=False, nullable=False)
    bot_repeat_count = Column(Integer, default=0, nullable=False)
    bot_last_reply_text = Column(Text, nullable=True)
    bot_last_reply_at = Column(DateTime, nullable=True)
    # Setado quando uma mensagem do cliente é encaminhada com sucesso pro
    # webhook de IA; limpo assim que a resposta chega em POST /api/bot/reply.
    # Se ficar setado tempo demais, o watchdog interpreta como bot travado.
    bot_forwarded_at = Column(DateTime, nullable=True)

    contact = relationship("Contact", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")
    assigned_to = relationship("User", foreign_keys=[assigned_to_user_id])
    # secondary como string (não a Table em si) porque conversation_tags só é
    # declarada mais abaixo neste arquivo — resolvido tardiamente pelo SQLAlchemy
    # no configure_mappers(), então a ordem de definição não importa aqui.
    tags = relationship("Tag", secondary="conversation_tags")


class Message(Base):
    __tablename__ = "messages"
    # wamid deixou de ser único globalmente: contas de teste diferentes ligadas
    # ao MESMO número de telefone real recebem eco multi-device da mesma
    # mensagem via bridges diferentes, cada uma reportando o mesmo wamid — a
    # unicidade global fazia a primeira a chegar "roubar" a linha, misturando
    # conteúdo de providers diferentes na conversa errada. Único por conversa.
    __table_args__ = (
        UniqueConstraint('conversation_id', 'wamid', name='ux_messages_conversation_wamid'),
    )

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    wamid = Column(String(255), nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False, index=True)
    contact_id = Column(Integer, ForeignKey('contacts.id', ondelete='CASCADE'), nullable=False, index=True)

    message_type = Column(Enum(MessageType), nullable=False, index=True)
    direction = Column(Enum(Direction), nullable=False, index=True)

    message_text = Column(Text)
    caption = Column(Text)

    media_id = Column(String(255), index=True)
    media_url = Column(Text)
    mime_type = Column(String(100))
    filename = Column(String(255))

    participant_jid = Column(String(100), nullable=True, index=True)
    sender_push_name = Column(String(255), nullable=True)

    status = Column(Enum(MessageStatus), default=MessageStatus.SENT, index=True)
    timestamp = Column(BigInteger, nullable=False, index=True)

    reply_to_wamid = Column(String(255), nullable=True, index=True)

    reaction_emoji = Column(String(10), nullable=True, index=True, comment='Emoji de reação (ex: ❤️, 👍)')

    is_starred = Column(Boolean, default=False, nullable=True)
    is_pinned = Column(Boolean, default=False, nullable=False)

    # Dados de cobrança/janela vindos do webhook de status da Meta
    # (status.pricing / status.conversation) — usados para reconciliar com a
    # fatura da Meta. Nem toda mensagem/categoria recebe esses campos (a Meta
    # migrou boa parte dos templates de CBP — cobrança por conversa, com o
    # objeto "conversation" — para PMP — cobrança por mensagem, sem esse
    # objeto —, então meta_conversation_id costuma vir vazio para envios
    # recentes de template; pricing geralmente vem sempre).
    meta_pricing_category = Column(String(50), nullable=True)
    meta_pricing_model = Column(String(20), nullable=True)
    meta_pricing_billable = Column(Boolean, nullable=True)
    meta_conversation_id = Column(String(255), nullable=True, index=True)
    meta_conversation_origin = Column(String(50), nullable=True)
    meta_conversation_expiration_ts = Column(BigInteger, nullable=True)

    # Payload estruturado de mensagens interativas enviadas (listas, botões, CTA-URL):
    # sections/rows, buttons ou dados do CTA. Sem isso, o frontend só tem o texto
    # genérico ("Lista: ...") e não consegue renderizar as opções de fato enviadas.
    interactive_payload = Column(JSON, nullable=True)

    # Payload bruto do bridge guardado quando a mensagem chegou de verdade no
    # WhatsApp mas todas as tentativas de salvar no banco falharam (ver
    # POST /bridge/register-failed) — permite reprocessar manualmente (botão
    # de retry no front) sem depender do bridge reenviar. NULL em toda
    # mensagem normal; só populado enquanto status == FAILED por esse motivo.
    failed_payload = Column(JSON, nullable=True)

    # Incidente 2026-09-11: WPPConnect pode devolver success=True (com
    # message_id) num chat endereçado por LID SEM transmitir de verdade —
    # falha muda que withLidRetry (só reage a exceção "No LID for user") não
    # cobre, porque aqui não tem exceção nenhuma. Marca quando o
    # stuck_wppconnect_watchdog já processou esta mensagem (presa em SENT
    # sem confirmação de entrega) — evita reprocessar a mesma mensagem a
    # cada ciclo do watchdog. NULL em toda mensagem normal.
    stuck_retry_attempted_at = Column(DateTime, nullable=True)

    # Incidente 2026-09-15: uma mensagem outbound enviada DIRETO DO CELULAR
    # (sem passar pela nossa API) chega só como eco do webhook (fromMe=true)
    # e nunca recebe DELIVERED/READ pelo pipeline de ack (mesmo problema do
    # comentário acima) — o stuck_wppconnect_watchdog não tinha como
    # diferenciar isso de uma mensagem de verdade travada no envio via API, e
    # chegou a marcar como FAILED (e tentar reenviar por fallback Baileys) uma
    # mensagem que já tinha sido entregue normalmente pelo WhatsApp nativo.
    # True só quando conversation_service.save_outbound_message (o envio pela
    # nossa API) criou/confirmou a linha; NULL/False em qualquer inserção
    # feita só pelo webhook (webhook_handler.py) — é o que o watchdog usa pra
    # só considerar candidatas mensagens que passaram pela nossa API de fato.
    sent_via_platform = Column(Boolean, nullable=False, default=False, server_default='0')

    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at = Column(TIMESTAMP, server_default=func.current_timestamp(), onupdate=func.current_timestamp())

    conversation = relationship("Conversation", back_populates="messages")
    contact = relationship("Contact", back_populates="messages")
    media_file = relationship("MediaFile", back_populates="message", uselist=False)


class WebhookLog(Base):
    __tablename__ = "webhook_logs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    webhook_type = Column(String(50), index=True)
    payload = Column(JSON)
    processed = Column(Boolean, default=False)
    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())


class MediaFile(Base):
    __tablename__ = "media_files"

    id = Column(Integer, primary_key=True, index=True)
    media_id = Column(String(255), unique=True, nullable=False, index=True)
    filename = Column(String(255), nullable=False)
    filepath = Column(String(500), nullable=False)
    mime_type = Column(String(100))
    file_size = Column(BigInteger)
    message_id = Column(Integer, ForeignKey('messages.id', ondelete='CASCADE'))
    downloaded_at = Column(DateTime, default=datetime.utcnow)

    message = relationship("Message", back_populates="media_file")

    def __repr__(self):
        return f"<MediaFile(media_id='{self.media_id}', filepath='{self.filepath}')>"


class WooCommerceOrder(Base):
    __tablename__ = "woocommerce_orders"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, nullable=False, unique=True, index=True)
    contact_id = Column(Integer, ForeignKey('contacts.id'))
    order_status = Column(String(50), index=True)
    order_total = Column(DECIMAL(10, 2))
    customer_name = Column(String(255))
    customer_email = Column(String(255))
    customer_phone = Column(String(20))
    whatsapp_notification_sent = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    contact = relationship("Contact", backref="woocommerce_orders")

    def __repr__(self):
        return f"<WooCommerceOrder(order_id={self.order_id}, status='{self.order_status}')>"


class CatalogOrder(Base):
    """
    Pedido feito pelo cliente via catálogo nativo do WhatsApp (mensagem tipo
    "order" recebida no webhook da Cloud API) — distinto de WooCommerceOrder,
    que vem de uma loja WooCommerce externa integrada via webhook próprio.
    Antes esse pedido só existia como Message.message_text formatado em texto;
    catalog_id/itens/total ficavam só no payload transiente do WebSocket.
    """
    __tablename__ = "catalog_orders"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey('messages.id', ondelete='CASCADE'), nullable=False, index=True)
    conversation_id = Column(Integer, ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False, index=True)
    contact_id = Column(Integer, ForeignKey('contacts.id', ondelete='CASCADE'), nullable=False, index=True)
    catalog_id = Column(String(255), nullable=True)
    product_items = Column(JSON, nullable=False)  # array bruto da Meta: product_retailer_id/quantity/item_price/currency
    total = Column(DECIMAL(10, 2), nullable=False, default=0)
    notes = Column(Text, nullable=True)  # texto livre que o cliente anexou ao pedido
    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())

    message = relationship("Message", backref="catalog_order", uselist=False)
    conversation = relationship("Conversation", backref="catalog_orders")
    contact = relationship("Contact", backref="catalog_orders")

    def __repr__(self):
        return f"<CatalogOrder(message_id={self.message_id}, total={self.total})>"


class AccountAlert(Base):
    __tablename__ = "account_alerts"

    id = Column(Integer, primary_key=True, index=True)
    alert_type = Column(String(100), nullable=False, index=True)
    field = Column(String(100))
    severity = Column(
        Enum("info", "warning", "critical", name="severity_enum"),
        nullable=False,
        index=True
    )
    message = Column(Text)
    phone_number = Column(String(50))
    quality_rating = Column(String(20))
    current_limit = Column(Integer)
    decision = Column(String(100))
    reason = Column(Text)
    notified = Column(Boolean, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    def __repr__(self):
        return f"<AccountAlert(type='{self.alert_type}', severity='{self.severity}')>"

# ── ADICIONAR ao final de backend/database/models.py ──────────────────────

class User(Base):
    __tablename__ = "users"

    id            = Column(Integer, primary_key=True, index=True, autoincrement=True)
    email         = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name     = Column(String(255))
    is_active     = Column(Boolean, default=True)
    is_admin      = Column(Boolean, default=False)
    role          = Column(String(50), default="attendant")
    sector        = Column(String(100), default="")
    created_at    = Column(DateTime, default=datetime.utcnow)
    updated_at    = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Presença do chat interno (Fase 3) — gravado quando o último socket
    # desse usuário desconecta; "online agora" é rastreado só em memória no
    # WebSocketManager, não aqui (não vale persistir estado tão efêmero).
    last_seen_at  = Column(DateTime, nullable=True)
    # Status manual do usuário (Slack/Teams-like) — não é "está conectado ou
    # não" (isso é sempre real, via socket), é como ele QUER aparecer pros
    # outros enquanto conectado: online/away/busy mostram a bolinha da cor
    # correspondente; "offline" faz aparecer offline mesmo estando com socket
    # ativo (efeito "aparecer invisível"). Desconectado de verdade sempre
    # mostra offline, independente deste valor — ver websocket.py.
    presence_status = Column(String(20), nullable=False, default="online")
    # Como o nome dessa pessoa aparece pro cliente (prefixo de identidade nas
    # mensagens de texto) e pra equipe (chat interno) — "first_initial" =
    # "João S.", "initial_last" = "J. Silva". Ver backend/utils/display_name.py.
    display_name_format = Column(String(20), nullable=False, default="first_initial")
    # Foto de perfil no chat interno (Equipe) — upload manual (Configurações
    # > Minha Conta) ou, se a pessoa quiser, copiada uma vez de uma foto de
    # perfil do WhatsApp (POST /api/users/me/photo/from-whatsapp). Sem
    # sincronização automática/contínua — é só uma cópia pontual no momento
    # que a pessoa pedir, não um vínculo permanente com nenhum contato/conta.
    photo_url = Column(Text, nullable=True)

    accounts = relationship("WhatsAppAccount", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("UserSession", back_populates="user", cascade="all, delete-orphan")
    # Contas que este usuário pode VER/usar quando seu papel não tem
    # feature_view_all_accounts (ex: atendente) — diferente de `accounts`
    # acima, que é quem CADASTROU a conta (dono), não quem pode acessá-la no
    # dia a dia. secondary como string porque user_account_access só é
    # declarada mais abaixo neste arquivo (resolvido tardiamente pelo
    # SQLAlchemy, mesmo padrão já usado em Conversation.tags).
    granted_accounts = relationship("WhatsAppAccount", secondary="user_account_access")


class Role(Base):
    """
    Papel/permissão de verdade, substituindo a matriz cosmética que vivia em
    data/settings.json (nunca era checada em lugar nenhum do backend). User.role
    continua sendo string livre — não há FK, o vínculo é por Role.key == User.role,
    então nenhuma conta existente precisa de migração de dados.
    """
    __tablename__ = "roles"

    id           = Column(Integer, primary_key=True, index=True, autoincrement=True)
    key          = Column(String(50), unique=True, nullable=False, index=True)
    label        = Column(String(100), nullable=False)
    color        = Column(String(20), default="#25D366")
    permissions  = Column(JSON, nullable=False, default=dict)
    is_builtin   = Column(Boolean, default=False)  # admin/supervisor/attendant — não pode ser apagado
    created_at   = Column(DateTime, default=datetime.utcnow)
    updated_at   = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PendingChange(Base):
    """
    Fila de aprovação — quando o papel do usuário está marcado 'require_approval'
    para uma permissão sensível (ver Role.permissions), a ação não é aplicada na
    hora: fica registrada aqui até um admin aprovar ou rejeitar. change_type
    identifica qual ação deferida executar na aprovação (ver routes_admin.py
    approve_pending_change); payload guarda os argumentos originais da chamada.
    """
    __tablename__ = "pending_changes"

    id           = Column(Integer, primary_key=True, index=True, autoincrement=True)
    account_id   = Column(Integer, ForeignKey("whatsapp_accounts.id", ondelete="CASCADE"), nullable=True, index=True)
    requested_by = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    change_type  = Column(String(50), nullable=False)
    payload      = Column(JSON, nullable=False, default=dict)
    status       = Column(String(20), default="pending", index=True)  # pending|approved|rejected
    reviewed_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reviewed_at  = Column(DateTime, nullable=True)
    created_at   = Column(DateTime, default=datetime.utcnow)


class WhatsAppAccount(Base):
    __tablename__ = "whatsapp_accounts"

    id            = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    account_name  = Column(String(255), nullable=False)
    phone_number  = Column(String(50), nullable=False, index=True)
    provider_type = Column(String(50), nullable=False, index=True)
    provider_tier = Column(String(50), default="starter")

    # Meta Cloud API
    meta_phone_number_id     = Column(String(255))
    meta_access_token        = Column(Text)
    meta_business_account_id = Column(String(255))
    meta_waba_id             = Column(String(255))
    meta_catalog_id          = Column(String(255))

    # Provider config genérico
    provider_config = Column(JSON)

    # Status
    is_active             = Column(Boolean, default=True)
    is_authenticated      = Column(Boolean, default=False)
    authentication_status = Column(String(50), default="pending")

    # "Excluir" uma conta (admin) é soft-delete: revoga acesso (desloga a
    # sessão, some da lista pra todo mundo) mas NUNCA apaga a linha nem as
    # conversas/mensagens ligadas a ela — só marca deleted_at. Ver
    # routes_admin.py::delete_account_admin. Diferente de is_active=False
    # (pausa reversível pelo próprio usuário/admin), isto é definitivo.
    deleted_at = Column(DateTime, nullable=True)

    # Coexistence
    coexistence_enabled  = Column(Boolean, default=False)
    coexistence_synced_at = Column(TIMESTAMP)

    # MM Lite
    mmlite_enabled      = Column(Boolean, default=False)
    mmlite_portfolio_id = Column(String(255))

    # Sessão unofficial
    session_id         = Column(String(255))
    session_data       = Column(JSON)
    qr_code            = Column(Text)
    qr_code_expires_at = Column(TIMESTAMP)

    # Webhook de IA/bot externo (n8n ou qualquer ferramenta que fale HTTP) —
    # ver backend/api/routes_ai_bot.py e webhook_handler._forward_to_ai_webhook.
    ai_webhook_enabled = Column(Boolean, default=False)
    ai_webhook_url     = Column(String(500))
    ai_webhook_secret  = Column(String(255))
    # generic (contrato próprio, POST /api/bot/reply) | evolution_compat
    # (imita a Evolution API — ver backend/api/routes_evolution_compat.py)
    ai_webhook_format  = Column(String(20), default="generic", nullable=False)

    # False = conta não participa de fila/SLA/"tempo de atendimento" no
    # Painel Admin (ex: linha interna de TI/Logística com fornecedor, sem
    # ninguém formalmente "atendente" nela) — ver routes_admin.py::
    # _client_conv_filters. Não afeta o chat em si, só as métricas.
    attendance_enabled = Column(Boolean, default=True, nullable=False)
    # Instante em que attendance_enabled virou True pela última vez (setado na
    # criação da conta e sempre que o toggle liga de novo, ver routes_settings.
    # py::update_account) — as métricas de IDADE (Estourando SLA agora,
    # Aguardando/Parada) usam GREATEST(timestamp real, este campo) como início
    # do relógio, pra uma conta com backlog antigo que só agora virou
    # atendimento não aparecer como se estivesse estourando SLA há semanas.
    attendance_enabled_since = Column(DateTime, nullable=True)

    # Limites
    daily_message_limit   = Column(Integer, default=1000)
    monthly_message_limit = Column(Integer, default=25000)
    messages_sent_today   = Column(Integer, default=0, nullable=False)
    messages_sent_month   = Column(Integer, default=0, nullable=False)

    created_at       = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at       = Column(TIMESTAMP, server_default=func.current_timestamp(), onupdate=func.current_timestamp())
    last_activity_at = Column(TIMESTAMP)

    user    = relationship("User", back_populates="accounts")
    changes = relationship("ProviderChange", back_populates="account", cascade="all, delete-orphan")


class CoexistenceSyncState(Base):
    """Estado real de sincronização da Coexistência (histórico, app-state, ecos de mensagem).

    Três ciclos de vida distintos, por isso não cabe numa única coluna:
    sync inicial de histórico (tem começo/fim), app-state sync (contínuo,
    sem "fim"), ecos de mensagem do app do celular (contínuo). As colunas
    last_raw_*_payload guardam o último payload bruto recebido de cada tipo,
    pra permitir corrigir o parsing assim que o formato real da Meta for
    observado ao vivo (formato não confirmado nesta implementação inicial).
    """
    __tablename__ = "coexistence_sync_state"

    account_id = Column(Integer, ForeignKey("whatsapp_accounts.id", ondelete="CASCADE"), primary_key=True)

    history_started_at        = Column(TIMESTAMP, nullable=True)
    history_completed_at      = Column(TIMESTAMP, nullable=True)
    history_chunks_received   = Column(Integer, default=0, nullable=False)
    history_last_progress_pct = Column(Integer, nullable=True)

    last_app_state_sync_at         = Column(TIMESTAMP, nullable=True)
    app_state_sync_events_received = Column(Integer, default=0, nullable=False)

    last_message_echo_at    = Column(TIMESTAMP, nullable=True)
    message_echoes_received = Column(Integer, default=0, nullable=False)

    last_raw_history_payload   = Column(JSON, nullable=True)
    last_raw_app_state_payload = Column(JSON, nullable=True)

    updated_at = Column(TIMESTAMP, server_default=func.current_timestamp(), onupdate=func.current_timestamp())


class UserSession(Base):
    __tablename__ = "user_sessions"

    id                = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id           = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    active_account_id = Column(Integer, ForeignKey("whatsapp_accounts.id", ondelete="SET NULL"), nullable=True)
    token_hash        = Column(String(255), nullable=False)
    expires_at        = Column(DateTime, nullable=False)
    created_at        = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="sessions")


class ProviderChange(Base):
    __tablename__ = "provider_changes"

    id          = Column(Integer, primary_key=True, index=True, autoincrement=True)
    account_id  = Column(Integer, ForeignKey("whatsapp_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    old_provider = Column(String(50))
    new_provider = Column(String(50))
    changed_at  = Column(DateTime, default=datetime.utcnow)
    changed_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))

    account = relationship("WhatsAppAccount", back_populates="changes")


class Tag(Base):
    """Etiqueta de atendimento (ex: 'Reclamação', 'Orçamento'), aplicada a
    conversas de CLIENTE via a tabela de associação conversation_tags.

    Classificação/visibilidade (scope) — pedido explícito 2026-09-23:
    - "global": todo mundo vê e pode aplicar (catálogo único, comportamento
      de sempre — é o default, cobre todo tag já existente antes disso).
    - "sector": só quem tem User.sector igual a `sector` abaixo vê/aplica
      (sector é texto livre, sem tabela própria — mesmo campo do cadastro
      do usuário em SettingsModal.js, casamento é por igualdade de string).
    - "personal": ponto-a-ponto, mesmo modelo de QuickReply.shared_with —
      só quem criou (created_by) vê/aplica por padrão; pode compartilhar
      explicitamente com colegas específicos (shared_with), que passam a
      usar mas não editar/excluir/mudar o compartilhamento (exclusivo do
      criador), sem opção de "compartilhar com todo mundo" de uma vez.

    Tarefa vinculada (task_title preenchido) — aplicar a etiqueta numa
    conversa de cliente cria automaticamente uma InternalTask ligada a essa
    conversa (customer_conversation_id, mesmo caminho de
    create_standalone_task em routes_internal_chat.py), com
    InternalTask.source_tag_id apontando de volta pra cá. Responsável: se
    task_assigned_to estiver definido, atribui a essa pessoa fixa (pedido
    explícito 2026-09-23 — etiquetas operacionais tipo "Coleta"/"Devolução"
    precisam acionar quem realmente trata, não sempre quem aplicou);
    ausente, cai no padrão de sempre (autoatribuída a quem aplicou). Prazo:
    se task_due_days estiver definido, due_at = data de aplicação + N dias
    — isso é o que faz o lembrete/popup de prazo (task_due_reminder_watchdog.py)
    disparar sozinho pra essa tarefa; ausente, fica sem prazo (não dispara).

    Recorrência (recurrence_* — pedido explícito 2026-09-24): mesmo motor
    de InternalTask.recurrence_* (dia/semana/mês a cada N unidades, ver
    validate_recurrence em backend/utils/recurrence.py) — cada tarefa
    gerada pela etiqueta já nasce com esses campos preenchidos, então a
    próxima ocorrência é criada normalmente na aprovação
    (_maybe_create_next_recurrence), igual a qualquer outra tarefa
    recorrente. Além disso, source_tag_id é o que habilita, no popup de
    lembrete de prazo vencido (TaskReminderModal), a opção "avisar de novo
    em N dias" (POST /tasks/{id}/snooze-due) — só faz sentido pra tarefa de
    etiqueta; tarefa manual já tem a recorrência normal disponível pra
    quem quiser repetir.
    """
    __tablename__ = "tags"

    id         = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name       = Column(String(100), unique=True, nullable=False)
    color      = Column(String(20), default="#8696A0")
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    scope  = Column(String(10), nullable=False, default="global")  # global|sector|personal
    sector = Column(String(100), nullable=True)

    task_title       = Column(String(255), nullable=True)
    task_description = Column(Text, nullable=True)
    task_priority    = Column(String(10), nullable=True, default="medium")
    # Dias até o prazo (due_at = aplicação + N dias) — null = sem prazo.
    task_due_days    = Column(Integer, nullable=True)
    # Responsável fixo da tarefa gerada — null = autoatribuída a quem aplicou.
    task_assigned_to = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Recorrência da tarefa gerada — mesma convenção de InternalTask.recurrence_*
    # (ver docstring da classe acima). null = tarefa gerada não repete.
    recurrence_interval     = Column(String(10), nullable=True)  # daily|weekly|monthly
    recurrence_every        = Column(Integer, nullable=True)
    recurrence_days_of_week = Column(JSON, nullable=True)

    creator      = relationship("User", foreign_keys=[created_by])
    task_assignee = relationship("User", foreign_keys=[task_assigned_to])
    # secondary como string — mesmo motivo de Conversation.tags acima
    # (tag_shares só é declarada mais abaixo, resolvido tardiamente).
    shared_with = relationship("User", secondary="tag_shares")


conversation_tags = Table(
    "conversation_tags", Base.metadata,
    Column("conversation_id", Integer, ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)

tag_shares = Table(
    "tag_shares", Base.metadata,
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)


# Concede a um usuário (cujo papel NÃO tem feature_view_all_accounts) acesso a
# ver/usar uma conta WhatsApp específica — atribuído manualmente pelo admin no
# cadastro do usuário. Admin/Supervisor (feature_view_all_accounts=True) ignoram
# esta tabela e veem todas as contas, independente do que estiver aqui.
user_account_access = Table(
    "user_account_access", Base.metadata,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("account_id", Integer, ForeignKey("whatsapp_accounts.id", ondelete="CASCADE"), primary_key=True),
)


class InternalNote(Base):
    """
    Nota interna por conversa — cobre tanto "deixar um recado sobre este
    cliente" quanto "atendentes conversando entre si sobre este atendimento":
    é uma lista de mensagens com autor, misturada cronologicamente na mesma
    timeline do chat no frontend (com estilo visual distinto), mas NUNCA sai
    para o WhatsApp — puramente interno.
    """
    __tablename__ = "internal_notes"

    id              = Column(Integer, primary_key=True, index=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id         = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    text            = Column(Text, nullable=False)
    created_at      = Column(DateTime, default=datetime.utcnow, index=True)

    author = relationship("User", foreign_keys=[user_id])


quick_reply_shares = Table(
    "quick_reply_shares", Base.metadata,
    Column("quick_reply_id", Integer, ForeignKey("quick_replies.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
)


class QuickReply(Base):
    """Resposta rápida/macro — atalho digitado no composer (ex: '/oi') que
    expande pro texto completo e/ou insere uma mídia pronta (imagem, vídeo,
    áudio, documento) no anexo, parecido com um Template de Mídia da Meta mas
    enviado pelo bridge (Baileys/WPPConnect/etc), sem passar pela Cloud API.
    A mídia em si fica salva em uploads/ (mesmo storage de anexos avulsos) —
    media_url guarda o caminho relativo (ex: '/uploads/xxx.jpg').

    Compartilhamento é ponto-a-ponto, não um catálogo geral: por padrão só o
    autor (created_by) vê/usa; ele escolhe explicitamente com quais colegas
    específicos compartilhar (shared_with) — sem opção de "compartilhar com
    todo mundo" de uma vez. Quem recebe só usa; editar/apagar/alterar com
    quem está compartilhado é sempre restrito ao autor. Atalho (shortcut) é
    único só entre as respostas do próprio autor, não globalmente — dois
    autores podem ter o mesmo atalho sem conflito."""
    __tablename__ = "quick_replies"

    id             = Column(Integer, primary_key=True, index=True, autoincrement=True)
    shortcut       = Column(String(50), nullable=False, index=True)
    text           = Column(Text, nullable=True)
    media_url      = Column(String(500), nullable=True)
    media_type     = Column(String(20), nullable=True)   # image|video|audio|document|sticker
    media_filename = Column(String(255), nullable=True)
    media_mime     = Column(String(100), nullable=True)
    created_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)
    updated_at     = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    creator      = relationship("User", foreign_keys=[created_by])
    shared_with  = relationship("User", secondary=quick_reply_shares)


class CsatResponse(Base):
    """Resposta de pesquisa de satisfação (1-5) capturada após o cliente
    responder à mensagem de CSAT enviada quando a conversa é marcada Resolvida
    (ver Conversation.awaiting_csat, webhook_handler._run_attendance_automations)."""
    __tablename__ = "csat_responses"

    id              = Column(Integer, primary_key=True, index=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    rating          = Column(Integer, nullable=False)
    comment         = Column(Text, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow, index=True)

    conversation    = relationship("Conversation")


class InternalConversation(Base):
    """
    Chat interno entre usuários da equipe — sem nenhuma ligação com conversa
    de cliente/WhatsApp (diferente de InternalNote, que é presa a uma
    Conversation específica). 1:1 ou grupo (is_group), participantes via
    InternalConversationParticipant (que também guarda o "lido até" de cada
    um, pra contar não-lidas).
    """
    __tablename__ = "internal_conversations"

    id         = Column(Integer, primary_key=True, index=True, autoincrement=True)
    is_group   = Column(Boolean, default=False, nullable=False)
    name       = Column(String(255), nullable=True)  # só usado em grupo
    photo_url  = Column(Text, nullable=True)  # só usado em grupo (Fase 4)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    # "Fixar conversa" — mesma ideia de Conversation.is_pinned (WhatsApp),
    # mas aqui é a única opção possível: chat interno não tem protocolo
    # WhatsApp nenhum por trás pra ter um pin nativo. Global (não por
    # usuário) — todo participante vê fixado, igual ao resto do estado
    # compartilhado da conversa (nome, foto).
    is_pinned  = Column(Boolean, default=False, nullable=False)

    participant_rows = relationship(
        "InternalConversationParticipant", back_populates="conversation", cascade="all, delete-orphan"
    )
    messages = relationship(
        "InternalMessage", back_populates="conversation", cascade="all, delete-orphan",
        order_by="InternalMessage.created_at",
    )


class InternalConversationParticipant(Base):
    __tablename__ = "internal_conversation_participants"

    conversation_id = Column(Integer, ForeignKey("internal_conversations.id", ondelete="CASCADE"), primary_key=True)
    user_id         = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    # Última vez que esse usuário abriu a conversa — mensagens depois disso
    # contam como não lidas pra ele. NULL = nunca abriu.
    last_read_at    = Column(DateTime, nullable=True)
    # Mesma ideia, só que pra faixa de tarefas (não mensagens) — última vez
    # que esse usuário expandiu/olhou a lista de tarefas dessa conversa.
    # Tarefa criada depois disso conta como "não vista" (badge vermelho na
    # faixa/rail/sidebar). Granularidade por CONVERSA, não por tarefa
    # individual — mesmo nível de detalhe que last_read_at já usa pra mensagem.
    last_tasks_viewed_at = Column(DateTime, nullable=True)
    joined_at       = Column(DateTime, default=datetime.utcnow)
    # Quem cria um grupo vira admin automaticamente (Fase 4). Sem sentido numa DM.
    is_admin        = Column(Boolean, default=False, nullable=False)
    # "Favoritar"/"Silenciar" — diferente de InternalConversation.is_pinned
    # (que é global, todo participante vê fixado igual nome/foto do grupo),
    # esses dois são preferência PESSOAL de cada um: uma pessoa silenciar um
    # grupo não pode calar notificação pra todo mundo, e favoritar é sobre
    # como CADA UM organiza a própria lista — por isso moram aqui (por
    # participante), não em InternalConversation.
    is_muted        = Column(Boolean, default=False, nullable=False)
    is_favorite     = Column(Boolean, default=False, nullable=False)

    conversation = relationship("InternalConversation", back_populates="participant_rows")
    user         = relationship("User")


class InternalMessage(Base):
    __tablename__ = "internal_messages"

    id              = Column(Integer, primary_key=True, index=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("internal_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_id       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    text            = Column(Text, nullable=False)
    created_at      = Column(DateTime, default=datetime.utcnow, index=True)

    # Mídia (Fase 1 — paridade WhatsApp Web)
    message_type = Column(String(20), nullable=False, default="text")  # text|image|video|audio|document|sticker
    media_url    = Column(Text, nullable=True)
    mime_type    = Column(String(100), nullable=True)
    filename     = Column(String(255), nullable=True)

    # Interação com mensagem (Fase 2)
    reply_to_id = Column(Integer, ForeignKey("internal_messages.id", ondelete="SET NULL"), nullable=True)
    is_edited   = Column(Boolean, default=False, nullable=False)
    is_deleted  = Column(Boolean, default=False, nullable=False)
    is_starred  = Column(Boolean, default=False, nullable=False)
    is_pinned   = Column(Boolean, default=False, nullable=False)

    # Preenchido só quando esta mensagem nasceu de um encaminhamento de uma
    # conversa de cliente/WhatsApp pra cá (ver POST /api/conversations/{id}/
    # messages/{wamid}/forward-to-internal, routes.py). Guarda uma referência
    # pra conversa/mensagem original (pra abrir o chat do cliente ao clicar)
    # e um snapshot do nome/telefone do contato no momento do encaminhamento
    # (resiliente a rename do contato depois). NULL = mensagem "nativa" do
    # chat interno (digitada ou encaminhada de outro chat interno).
    forwarded_from_wa_conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True)
    forwarded_from_wa_wamid           = Column(String(255), nullable=True)
    forwarded_from_contact_name       = Column(String(255), nullable=True)
    forwarded_from_contact_phone      = Column(String(50), nullable=True)

    # Preenchido só quando message_type="task" — a mensagem em si é só uma
    # "notificação" na timeline (texto = snapshot do título) de que uma
    # tarefa foi criada; o estado real (status/responsável/prazo) vive em
    # InternalTask e é lido ao vivo via essa FK, não duplicado aqui.
    task_id = Column(Integer, ForeignKey("internal_tasks.id", ondelete="SET NULL"), nullable=True)
    # NULL = mensagem de CRIAÇÃO da tarefa (renderiza o card interativo
    # completo, com checkbox/subtarefas/etc — só ela). Preenchido
    # (completed|approved|rejected|reopened) = aviso informativo simples
    # (só o texto, sem card) — sem isso, TODA mensagem de uma tarefa
    # renderizava o card completo com o estado ATUAL (ao vivo), então
    # depois de aprovada até o aviso de "concluída" passava a mostrar
    # "aprovada" também — os dois avisos ficavam idênticos/redundantes.
    task_event = Column(String(20), nullable=True)

    conversation = relationship("InternalConversation", back_populates="messages")
    sender       = relationship("User")
    reply_to     = relationship("InternalMessage", remote_side=[id])
    reactions    = relationship("InternalMessageReaction", cascade="all, delete-orphan")
    task         = relationship("InternalTask")


class InternalMessageReaction(Base):
    """
    Reação por pessoa a uma mensagem de chat interno — diferente do lado
    cliente (Message.reaction_emoji, uma coluna só), aqui precisa suportar
    reações independentes de cada participante (grupo pode ter várias pessoas
    reagindo diferente à mesma mensagem, igual ao WhatsApp real).
    """
    __tablename__ = "internal_message_reactions"
    __table_args__ = (UniqueConstraint("message_id", "user_id", name="ux_internal_reaction_message_user"),)

    id         = Column(Integer, primary_key=True, index=True, autoincrement=True)
    message_id = Column(Integer, ForeignKey("internal_messages.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    emoji      = Column(String(10), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User")


class InternalTask(Base):
    """
    Tarefa — 3 modos mutuamente exclusivos, ver conversation_id/
    customer_conversation_id abaixo:
    - Chat INTERNO (DM ou grupo da equipe): fica listada nos "Dados do
      contato"/"Dados do grupo" (InternalContactInfoPanel/InternalGroupManager)
      e também gera um InternalMessage (message_type="task", .task_id
      apontando pra cá) pra dar contexto de quando/quem pediu na linha do
      tempo do chat.
    - Conversa de CLIENTE: faixa "Tarefas da conversa" dentro do ChatArea.js
      (mesmo componente visual do chat interno) — controle exclusivo de quem
      criou, NUNCA gera nenhuma mensagem/aviso visível pro cliente.
    - PESSOAL (nenhum dos dois IDs preenchido): só aparece em "Minhas tarefas".

    Detalhe expandido (subtasks/anexos/edição) abre em TaskDetailModal.js a
    partir de qualquer um dos 3 lugares.
    """
    __tablename__ = "internal_tasks"

    id              = Column(Integer, primary_key=True, index=True, autoincrement=True)
    # Nullable — pedido explícito 2026-09-23: uma tarefa pode ser de conversa
    # INTERNA (este campo), vinculada a conversa de CLIENTE
    # (customer_conversation_id abaixo) ou PESSOAL (nenhum dos dois — sem
    # isso "tarefa pra mim mesmo" forçava usar a DM "Você mesmo" como
    # container, poluindo uma conversa pensada só pra anotações com avisos
    # de sistema). Os dois campos são mutuamente exclusivos, nunca os dois
    # preenchidos na mesma tarefa — ver create_standalone_task.
    conversation_id = Column(Integer, ForeignKey("internal_conversations.id", ondelete="CASCADE"), nullable=True, index=True)
    # FK só no nível do Python (create_all cria a constraint de verdade num
    # banco novo) — no banco compartilhado atual foi criada SEM constraint
    # de propósito: `conversations` é a tabela mais quente do app inteiro
    # (toda mensagem de cliente grava nela), e um ALTER TABLE com FK pra ela
    # arrisca o mesmo incidente de lock que já aconteceu com
    # push_subscriptions/users (ver comentário lá) — só que numa tabela
    # infinitamente mais concorrida.
    customer_conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True, index=True)
    created_by      = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    assigned_to     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title           = Column(String(255), nullable=False)
    description     = Column(Text, nullable=True)
    due_at          = Column(DateTime, nullable=True)
    # Lembrete de PRAZO — dispara uma vez quando due_at vence, mesma ideia de
    # pause_reminder_notified_at (evita repetir a cada ciclo do watchdog),
    # mas automático: não é opcional/agendado por alguém, qualquer tarefa
    # pendente com prazo dispara (ver task_due_reminder_watchdog.py). Fica
    # null até disparar; reabrir/editar due_at limpa pra poder disparar de
    # novo com o novo prazo (ver update_internal_task).
    due_reminder_notified_at = Column(DateTime, nullable=True)
    status          = Column(String(20), nullable=False, default="pending")  # pending|paused|done|cancelled
    priority        = Column(String(10), nullable=False, default="medium")  # low|medium|high|urgent
    completed_by    = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    completed_at    = Column(DateTime, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)

    # Descrição só edita quem criou a tarefa (ver update_internal_task) —
    # este flag marca que já foi editada pelo menos uma vez, pra mostrar
    # "(editado)" na UI, mesmo padrão do InternalMessage.is_edited.
    description_edited = Column(Boolean, default=False, nullable=False)
    # Conclusão da tarefa principal gera uma mensagem no chat pedindo
    # aprovação do criador — estes campos guardam se/quando/quem aprovou.
    # Só quem criou a tarefa aprova (ver approve_internal_task) — o
    # responsável concluir a própria tarefa não deveria também poder
    # auto-aprová-la, isso esvaziaria o sentido da aprovação.
    approved_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_at = Column(DateTime, nullable=True)
    # Reprovação: volta pra pending (desmarca conclusão) — sem coluna de
    # "estado reprovado" própria, o rastro fica só no histórico
    # (InternalTaskHistory, evento "rejected"); rejected_at/by aqui seriam
    # redundantes já que status já volta a refletir "ainda não concluída".

    # Pausa — status="paused" (pedido explícito: sempre exige justificativa,
    # ver pause_internal_task em routes_internal_chat.py). Esses 3 campos são
    # o estado "ativo" da pausa atual — retomar limpa os três, mas o motivo
    # não se perde: fica gravado pra sempre em InternalTaskHistory.reason.
    paused_by    = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    paused_at    = Column(DateTime, nullable=True)
    pause_reason = Column(Text, nullable=True)
    # Lembrete opcional pra não esquecer uma tarefa pausada (pedido explícito
    # — sem isso, "pausada" vira sinônimo de "esquecida pra sempre"). Quem
    # pausou escolhe um horário; task_pause_reminder_watchdog.py posta um
    # aviso na timeline quando vence. notified_at fica null até disparar
    # (evita repetir a cada ciclo do watchdog); retomar limpa os dois, igual
    # aos outros 3 campos de pausa acima.
    pause_reminder_at          = Column(DateTime, nullable=True)
    pause_reminder_notified_at = Column(DateTime, nullable=True)

    # Cancelamento — status="cancelled", mesmo padrão da pausa (sempre exige
    # justificativa, ver cancel_internal_task). Diferente de pausa, é um
    # estado terminal (igual "done"): não conta mais como tarefa aberta na
    # faixa do chat nem em "Minhas tarefas", mas fica visível/identificável
    # em vez de simplesmente desaparecer — reativar (uncancel_internal_task)
    # volta pra pending, igual reabrir uma tarefa concluída.
    cancelled_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    cancelled_at  = Column(DateTime, nullable=True)
    cancel_reason = Column(Text, nullable=True)

    # Recorrência — intervalo fixo (dia/semana/mês) a cada N unidades.
    # Só dispara quando a conclusão é APROVADA (ver approve_internal_task):
    # cria automaticamente a próxima ocorrência com o mesmo título/
    # descrição/responsável, devido recalculado a partir do due_at anterior
    # (ou de agora, se essa tarefa não tinha prazo). Se reprovada, NÃO gera
    # a próxima — evita duplicar enquanto a atual ainda precisa ser refeita.
    recurrence_interval = Column(String(10), nullable=True)  # daily|weekly|monthly
    recurrence_every    = Column(Integer, nullable=True)     # a cada N unidades (2 = "a cada 2 semanas")
    # Só usado quando recurrence_interval == "weekly" — lista de inteiros
    # 0=segunda...6=domingo (convenção de datetime.weekday()). Quando
    # preenchido, a próxima ocorrência é o próximo desses dias a partir de
    # amanhã, IGNORANDO recurrence_every (não faz sentido combinar "a cada N
    # semanas" com dias específicos). Vazio/null = comportamento antigo
    # (mesmo dia da semana da âncora, a cada N semanas).
    recurrence_days_of_week = Column(JSON, nullable=True)
    # Aponta pra tarefa anterior da mesma série (a que foi aprovada e gerou
    # esta) — null na primeira ocorrência. Só pra navegação/contexto, não
    # tem cascade especial (deletar uma ocorrência não afeta as outras).
    recurrence_parent_id = Column(Integer, ForeignKey("internal_tasks.id", ondelete="SET NULL"), nullable=True)

    # Presente quando esta tarefa foi criada automaticamente pela aplicação
    # de uma etiqueta (ver add_conversation_tag em routes_attendance.py) —
    # null pra tarefa criada manualmente. Único propósito hoje: habilitar
    # "avisar de novo em N dias" no popup de lembrete de prazo vencido
    # (TaskReminderModal + POST /tasks/{id}/snooze-due), pedido explícito
    # 2026-09-24 — só faz sentido pra esse fluxo, tarefa manual já tem a
    # recorrência normal disponível. Uma ocorrência recorrente gerada a
    # partir de uma tarefa de etiqueta herda o mesmo source_tag_id (ver
    # _maybe_create_next_recurrence), pra continuar habilitado nas
    # ocorrências seguintes.
    source_tag_id = Column(Integer, ForeignKey("tags.id", ondelete="SET NULL"), nullable=True)

    conversation = relationship("InternalConversation")
    customer_conversation = relationship("Conversation")
    source_tag   = relationship("Tag")
    creator      = relationship("User", foreign_keys=[created_by])
    assignee     = relationship("User", foreign_keys=[assigned_to])
    completer    = relationship("User", foreign_keys=[completed_by])
    approver     = relationship("User", foreign_keys=[approved_by])
    pauser       = relationship("User", foreign_keys=[paused_by])
    canceller    = relationship("User", foreign_keys=[cancelled_by])
    subtasks     = relationship(
        "InternalTaskSubtask", cascade="all, delete-orphan", order_by="InternalTaskSubtask.position",
    )
    attachments  = relationship(
        "InternalTaskAttachment", cascade="all, delete-orphan", order_by="InternalTaskAttachment.created_at",
    )
    history      = relationship(
        "InternalTaskHistory", cascade="all, delete-orphan", order_by="InternalTaskHistory.created_at",
    )


class InternalTaskHistory(Base):
    """
    Trilha de auditoria completa da tarefa (criada/concluída/aprovada/
    reprovada/reaberta) — SEMPRE grava uma linha por evento real, mesmo
    quando o aviso correspondente no chat é suprimido por repetição rápida
    (ver _maybe_post_task_notice em routes_internal_chat.py). Existe
    separado da timeline do chat exatamente pra isso: o chat mostra só o
    que importa no momento, o histórico completo sempre fica disponível
    (aba "Histórico" no TaskDetailModal).
    """
    __tablename__ = "internal_task_history"

    id         = Column(Integer, primary_key=True, index=True, autoincrement=True)
    task_id    = Column(Integer, ForeignKey("internal_tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    event      = Column(String(20), nullable=False)  # created|completed|approved|rejected|reopened|paused|resumed|pause_reminder|cancelled|uncancelled|due_reminder
    # Justificativa do evento — hoje só "paused" grava algo aqui (pausa
    # sempre exige motivo), mas fica genérico pra não precisar de outra
    # coluna se algum evento futuro também precisar de texto livre.
    reason     = Column(Text, nullable=True)
    user_id    = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    user = relationship("User", foreign_keys=[user_id])


class InternalTaskSubtask(Base):
    """Item de checklist dentro de uma InternalTask — sem responsável/prazo próprio, só título+feito/pendente."""
    __tablename__ = "internal_task_subtasks"

    id         = Column(Integer, primary_key=True, index=True, autoincrement=True)
    task_id    = Column(Integer, ForeignKey("internal_tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    title      = Column(String(255), nullable=False)
    is_done    = Column(Boolean, default=False, nullable=False)
    position   = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class InternalTaskAttachment(Base):
    """Arquivo/imagem anexado a uma InternalTask — mesmo esquema de upload de internal_messages (uploads/ + media_url)."""
    __tablename__ = "internal_task_attachments"

    id          = Column(Integer, primary_key=True, index=True, autoincrement=True)
    task_id     = Column(Integer, ForeignKey("internal_tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    uploaded_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    file_url    = Column(Text, nullable=False)
    filename    = Column(String(255), nullable=True)
    mime_type   = Column(String(100), nullable=True)
    created_at  = Column(DateTime, default=datetime.utcnow)

    uploader = relationship("User")


class SavedSticker(Base):
    """
    Galeria pessoal de stickers de um usuário — tanto salvos de mensagens
    recebidas (guarda o wamid de origem só como rastro, sem FK, já que a
    mensagem original pode ser apagada depois sem invalidar o sticker salvo)
    quanto criados a partir de uma imagem própria (POST /api/stickers/convert).
    Guarda referência ao arquivo (media_url), não uma cópia à parte — mesmo
    padrão de custo mínimo do resto do app.
    """
    __tablename__ = "saved_stickers"

    id            = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    media_url     = Column(Text, nullable=False)
    mime_type     = Column(String(100), nullable=True)
    source_wamid  = Column(String(255), nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow, index=True)


class SavedContact(Base):
    """
    Agenda pessoal de vCards prontos pra reenviar — evita redigitar nome/
    telefone toda vez no ContactSender. Guarda o mesmo formato rico que já
    circula em /api/send/contacts (name/phones/emails/org/addresses/urls/
    birthday) como um JSON só, sem achatar em colunas — é exatamente o que
    o ContactSender preenche e o que os providers esperam, então ida e volta
    não precisa de nenhuma tradução.
    """
    __tablename__ = "saved_contacts"

    id            = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    display_name  = Column(String(255), nullable=False)
    contact_data  = Column(JSON, nullable=False)
    created_at    = Column(DateTime, default=datetime.utcnow, index=True)


class BroadcastList(Base):
    """
    Lista de transmissão (paridade com "Broadcast Lists" do WhatsApp real):
    um conjunto nomeado de contatos de UMA conta, reaproveitável em vários
    disparos ao longo do tempo. Cada disparo (BroadcastSend) é o envio de
    UMA mensagem para todos os contatos da lista naquele momento — cada
    destinatário recebe como mensagem individual normal (não é grupo),
    igual ao comportamento nativo do WhatsApp.
    """
    __tablename__ = "broadcast_lists"

    id         = Column(Integer, primary_key=True, index=True, autoincrement=True)
    account_id = Column(Integer, ForeignKey("whatsapp_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    name       = Column(String(255), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    contacts = relationship("Contact", secondary="broadcast_list_contacts", order_by="Contact.name")
    sends    = relationship("BroadcastSend", back_populates="broadcast_list", cascade="all, delete-orphan")


broadcast_list_contacts = Table(
    "broadcast_list_contacts", Base.metadata,
    Column("broadcast_list_id", Integer, ForeignKey("broadcast_lists.id", ondelete="CASCADE"), primary_key=True),
    Column("contact_id", Integer, ForeignKey("contacts.id", ondelete="CASCADE"), primary_key=True),
)


class BroadcastSend(Base):
    """
    Um disparo de uma lista: snapshot do texto enviado + progresso agregado.
    Separado de BroadcastList porque a mesma lista pode ser reutilizada em
    disparos futuros com mensagens diferentes — histórico fica preservado.
    """
    __tablename__ = "broadcast_sends"

    id                = Column(Integer, primary_key=True, index=True, autoincrement=True)
    broadcast_list_id = Column(Integer, ForeignKey("broadcast_lists.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id        = Column(Integer, ForeignKey("whatsapp_accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    message_text      = Column(Text, nullable=False)
    created_by        = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    status            = Column(String(20), nullable=False, default="pending")  # pending|sending|done|failed
    total             = Column(Integer, nullable=False, default=0)
    sent_count        = Column(Integer, nullable=False, default=0)
    failed_count      = Column(Integer, nullable=False, default=0)
    created_at        = Column(DateTime, default=datetime.utcnow)
    finished_at       = Column(DateTime, nullable=True)

    broadcast_list = relationship("BroadcastList", back_populates="sends")
    recipients     = relationship("BroadcastSendRecipient", back_populates="send", cascade="all, delete-orphan")


class BroadcastSendRecipient(Base):
    """Status de entrega por destinatário de um disparo — permite retomar
    visualização de progresso e mostrar quem falhou e por quê."""
    __tablename__ = "broadcast_send_recipients"

    id                = Column(Integer, primary_key=True, index=True, autoincrement=True)
    broadcast_send_id = Column(Integer, ForeignKey("broadcast_sends.id", ondelete="CASCADE"), nullable=False, index=True)
    contact_id        = Column(Integer, ForeignKey("contacts.id", ondelete="CASCADE"), nullable=False, index=True)
    status            = Column(String(20), nullable=False, default="pending")  # pending|sent|failed
    wamid             = Column(String(255), nullable=True)
    error             = Column(Text, nullable=True)
    sent_at           = Column(DateTime, nullable=True)

    send    = relationship("BroadcastSend", back_populates="recipients")
    contact = relationship("Contact")


class BaileysLidMap(Base):
    """Mapeamento LID→phone persistido pelo bridge Baileys (tabela baileys_lid_map)."""
    __tablename__ = "baileys_lid_map"

    session_id = Column(String(128), primary_key=True, nullable=False)
    lid_jid    = Column(String(128), primary_key=True, nullable=False)
    phone_jid  = Column(String(128), nullable=False)
    updated_at = Column(TIMESTAMP, server_default=func.current_timestamp(), onupdate=func.current_timestamp())


class PushSubscription(Base):
    """
    Inscrição Web Push de um dispositivo/navegador de um usuário — permite
    notificação desktop de verdade mesmo com o app fechado (pedido
    explícito: lembrete de prazo de tarefa precisa chegar no computador da
    pessoa mesmo sem o WhatsApp aberto no momento). Diferente da
    Notification API simples (desktopNotify.js), que só funciona com alguma
    aba do app aberta — isso aqui é entregue pelo serviço de push do
    navegador (FCM/Mozilla/etc) via Service Worker, então funciona com o
    navegador fechado, só não com o computador desligado.

    Um usuário pode ter várias inscrições (um por navegador/dispositivo
    onde deu permissão) — todas recebem o push. `endpoint` já é
    globalmente único por navegador+origem (é a URL do próprio serviço de
    push), então funciona como chave natural pra evitar duplicar a mesma
    inscrição a cada vez que o front resubscreve.
    """
    __tablename__ = "push_subscriptions"

    # user_id: FK declarada aqui pra instalações novas (create_all cria a
    # constraint de verdade num banco do zero). No banco compartilhado atual
    # a tabela foi criada SEM essa constraint (2026-09-23) — havia uma
    # transação presa segurando metadata lock em `users`, e a 1ª tentativa de
    # CREATE TABLE com a FK ficou esperando o lock indefinidamente e
    # derrubou prod+teste (fila de SELECT em `users` travada atrás dela).
    # Recriar a constraint depois exige achar/resolver essa transação presa
    # primeiro (sem PROCESS privilege pra ver innodb_trx daqui).
    id         = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    endpoint   = Column(Text, nullable=False)
    p256dh     = Column(String(255), nullable=False)
    auth       = Column(String(255), nullable=False)
    user_agent = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User")


class SiteChatVisitor(Base):
    """
    Visitante do chat do site (plugin WordPress/WooCommerce) — um por pessoa
    por conta provider_type='site_chat'. A conversa em si usa o fluxo normal
    de Contact/Conversation/Message; esta tabela guarda só o que não cabe
    nelas: o token secreto do navegador, a identidade informada/verificada
    e o contexto da navegação.

    Sem ForeignKey de propósito (account_id/contact_id são Integer soltos):
    o banco é compartilhado entre teste e prod e um CREATE TABLE com FK pega
    metadata lock nas tabelas referenciadas — já derrubou os dois uma vez
    (ver comentário em PushSubscription).
    """
    __tablename__ = "site_chat_visitors"

    id           = Column(Integer, primary_key=True, index=True, autoincrement=True)
    account_id   = Column(Integer, nullable=False, index=True)
    contact_id   = Column(Integer, nullable=True, index=True)
    # Bearer secreto do navegador (localStorage do site) — nunca exibido pro atendente.
    token        = Column(String(64), nullable=False, unique=True, index=True)
    wa_id        = Column(String(100), nullable=False, unique=True)
    # Cliente logado no WordPress (identidade assinada pelo plugin) — mesmo
    # cliente em outro aparelho cai no mesmo visitante/conversa.
    wp_user_id   = Column(Integer, nullable=True, index=True)
    verified     = Column(Boolean, nullable=False, default=False)
    name         = Column(String(255), nullable=True)
    email        = Column(String(255), nullable=True)
    phone        = Column(String(50), nullable=True)
    last_page_url   = Column(Text, nullable=True)
    last_page_title = Column(String(255), nullable=True)
    user_agent   = Column(String(255), nullable=True)
    first_seen_at = Column(DateTime, default=datetime.utcnow)
    last_seen_at  = Column(DateTime, default=datetime.utcnow)


class SiteChatProtocol(Base):
    """
    Protocolo de atendimento do chat do site: janela de 24h de inatividade do
    ponto de vista do CLIENTE (o widget só mostra o protocolo ativo; passou o
    prazo, o chat recomeça zerado). O painel mantém o histórico completo na
    mesma conversa e registra cada abertura com um aviso de sistema.
    Sem ForeignKey de propósito — ver SiteChatVisitor.
    """
    __tablename__ = "site_chat_protocols"

    id               = Column(Integer, primary_key=True, index=True, autoincrement=True)
    account_id       = Column(Integer, nullable=False, index=True)
    visitor_id       = Column(Integer, nullable=False, index=True)
    number           = Column(String(32), nullable=True, index=True)
    started_ms       = Column(BigInteger, nullable=False)
    last_activity_ms = Column(BigInteger, nullable=False)


class SiteChatProductQuestion(Base):
    """Dúvida de produto vinda do tema WooCommerce; a resposta volta por callback assinado."""
    __tablename__ = "site_chat_product_questions"
    __table_args__ = (UniqueConstraint('account_id', 'external_id', name='ux_scpq_account_external'),)

    id            = Column(Integer, primary_key=True, index=True, autoincrement=True)
    account_id    = Column(Integer, nullable=False, index=True)
    visitor_id    = Column(Integer, nullable=False, index=True)
    protocol_id   = Column(Integer, nullable=True)
    external_id   = Column(BigInteger, nullable=False)
    callback_url  = Column(Text, nullable=False)
    question      = Column(Text, nullable=False)
    wamid         = Column(String(255), nullable=False, index=True)
    created_at    = Column(DateTime, default=datetime.utcnow)
    answered_at   = Column(DateTime, nullable=True)
    answer_text   = Column(Text, nullable=True)
    answer_agent  = Column(String(255), nullable=True)
    answer_attempts = Column(Integer, nullable=False, default=0)
    last_error    = Column(String(500), nullable=True)
