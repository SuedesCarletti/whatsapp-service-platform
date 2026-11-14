from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any, Union, Literal
from datetime import datetime
from enum import Enum


def clean_recipient(v: str) -> str:
    """
    Normaliza o destinatário de um envio.

    JIDs completas (contêm '@', ex: grupos "...@g.us" ou já-normalizadas
    "...@s.whatsapp.net") são preservadas como estão — remover os caracteres
    não-numéricos destrói o sufixo do grupo e o Baileys acaba montando uma
    JID de usuário individual inválida a partir do número do grupo, que ele
    "envia com sucesso" sem entregar a ninguém.
    Números crus continuam validados/limpos como antes.
    """
    if '@' in v:
        return v.strip()
    cleaned = ''.join(filter(str.isdigit, v))
    if len(cleaned) < 10:
        raise ValueError('Número de telefone inválido')
    return cleaned


# ENUMS

class MessageTypeEnum(str, Enum):
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    DOCUMENT = "document"
    STICKER = "sticker"
    LOCATION = "location"
    CONTACTS = "contacts"
    INTERACTIVE = "interactive"
    TEMPLATE = "template"
    REACTION = "reaction"


class DirectionEnum(str, Enum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


class MessageStatusEnum(str, Enum):
    SENT = "sent"
    DELIVERED = "delivered"
    READ = "read"
    FAILED = "failed"


class InteractiveTypeEnum(str, Enum):
    """Tipos de mensagens interativas"""
    BUTTON = "button"
    LIST = "list"
    PRODUCT = "product"
    PRODUCT_LIST = "product_list"


# CONTACT SCHEMAS

class ContactBase(BaseModel):
    wa_id: str
    phone_number: str
    name: Optional[str] = None
    profile_picture_url: Optional[str] = None


class ContactCreate(ContactBase):
    pass


class ContactResponse(ContactBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# MESSAGE SCHEMAS

class MessageBase(BaseModel):
    message_type: MessageTypeEnum
    message_text: Optional[str] = None
    caption: Optional[str] = None


class MessageCreate(MessageBase):
    wamid: str
    conversation_id: int
    contact_id: int
    direction: DirectionEnum
    media_id: Optional[str] = None
    media_url: Optional[str] = None
    mime_type: Optional[str] = None
    filename: Optional[str] = None
    timestamp: int


class MessageResponse(MessageBase):
    id: int
    wamid: str
    conversation_id: int
    contact_id: int
    direction: DirectionEnum
    media_id: Optional[str] = None
    media_url: Optional[str] = None
    mime_type: Optional[str] = None
    filename: Optional[str] = None
    status: MessageStatusEnum
    timestamp: int
    created_at: datetime
    location: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


# CONVERSATION SCHEMAS

class ConversationBase(BaseModel):
    contact_id: int


class ConversationCreate(ConversationBase):
    pass


class ConversationResponse(ConversationBase):
    id: int
    last_message_at: datetime
    unread_count: int
    is_archived: bool
    contact: ContactResponse
    messages: List[MessageResponse] = []
    last_message: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


# WHATSAPP API - MENSAGENS BÁSICAS

class SendTextMessage(BaseModel):
    """Schema para enviar mensagem de texto"""
    to: str = Field(..., description="Número do destinatário com código do país")
    text: str = Field(..., description="Texto da mensagem")
    preview_url: bool = Field(False, description="Gerar preview de URLs")
    reply_to: Optional[str] = Field(None, description="WAMID da mensagem para responder")
    account_id: Optional[int] = Field(None, description="ID da conta WhatsApp a ser usada")
    
    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)


class SendMediaMessage(BaseModel):
    """Schema para enviar mensagem com mídia"""
    to: str = Field(..., description="Número do destinatário")
    type: MessageTypeEnum = Field(..., description="Tipo de mídia")
    caption: Optional[str] = Field(None, description="Legenda da mídia")
    reply_to: Optional[str] = Field(None, description="WAMID para responder")
    
    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)


  # CONTATOS (VCARD)

class ContactName(BaseModel):
    """Nome do contato"""
    formatted_name: str = Field(..., description="Nome completo formatado")
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    middle_name: Optional[str] = None
    suffix: Optional[str] = None
    prefix: Optional[str] = None


class ContactPhone(BaseModel):
    """Telefone do contato"""
    phone: str = Field(..., description="Número de telefone")
    type: Optional[str] = Field("WORK", description="Tipo: HOME, WORK, CELL, etc")
    wa_id: Optional[str] = Field(None, description="WhatsApp ID se for um número WA")


class ContactEmail(BaseModel):
    """Email do contato"""
    email: str
    type: Optional[str] = Field("WORK", description="Tipo: HOME, WORK")


class ContactAddress(BaseModel):
    """Endereço do contato"""
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    country: Optional[str] = None
    country_code: Optional[str] = None
    type: Optional[str] = Field("HOME", description="Tipo: HOME, WORK")


class ContactOrg(BaseModel):
    """Organização do contato"""
    company: Optional[str] = None
    department: Optional[str] = None
    title: Optional[str] = None


class ContactUrl(BaseModel):
    """URL do contato"""
    url: str
    type: Optional[str] = Field("WORK", description="Tipo: HOME, WORK")


class WhatsAppContact(BaseModel):
    """Estrutura completa de um contato para envio"""
    name: ContactName
    phones: Optional[List[ContactPhone]] = None
    emails: Optional[List[ContactEmail]] = None
    addresses: Optional[List[ContactAddress]] = None
    org: Optional[ContactOrg] = None
    urls: Optional[List[ContactUrl]] = None
    birthday: Optional[str] = Field(None, description="Formato: YYYY-MM-DD")


class SendContactMessage(BaseModel):
    """Schema para enviar contato(s)"""
    to: str = Field(..., description="Número do destinatário")
    contacts: List[WhatsAppContact] = Field(..., description="Lista de contatos (mínimo 1)")
    reply_to: Optional[str] = Field(None, description="WAMID para responder")
    # BUG real (2026-09-10, "clips não respeitam o bridge"): ContactSender.js
    # já mandava account_id (conversation.account_id) desde sempre, mas esse
    # campo nunca foi declarado aqui — Pydantic descarta silenciosamente
    # qualquer campo não declarado no payload, então a rota sempre recebia
    # None (getattr(message, "account_id", None)) e caía na resolução
    # ambígua por "conversa mais recente entre todas as contas" — mesma
    # classe de bug já corrigida em SendReactionMessage/RemoveReactionMessage.
    account_id: Optional[int] = Field(None, description="Conta que está enviando (evita resolução ambígua em contatos com conversa em várias contas)")

    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)
    
    @validator('contacts')
    def validate_contacts(cls, v):
        if not v or len(v) == 0:
            raise ValueError('É necessário pelo menos um contato')
        return v


  # MENSAGENS INTERATIVAS

class InteractiveButton(BaseModel):
    """Botão individual de resposta"""
    id: str = Field(..., description="ID único do botão (máx 256 caracteres)")
    title: str = Field(..., description="Texto do botão (máx 20 caracteres)")


class InteractiveReplyButton(BaseModel):
    """Botão de resposta"""
    type: Literal["reply"] = "reply"
    reply: InteractiveButton


class InteractiveListRow(BaseModel):
    """Item individual de uma lista"""
    id: str = Field(..., description="ID único (máx 200 caracteres)")
    title: str = Field(..., description="Título (máx 24 caracteres)")
    description: Optional[str] = Field(None, description="Descrição (máx 72 caracteres)")


class InteractiveListSection(BaseModel):
    """Seção de uma lista"""
    title: Optional[str] = Field(None, description="Título da seção (máx 24 caracteres)")
    rows: List[InteractiveListRow] = Field(..., description="Itens da seção (mín 1, máx 10)")
    
    @validator('rows')
    def validate_rows(cls, v):
        if not v or len(v) == 0:
            raise ValueError('Cada seção precisa ter pelo menos 1 item')
        if len(v) > 10:
            raise ValueError('Máximo de 10 itens permitidos')
        return v


class InteractiveHeader(BaseModel):
    """Cabeçalho de mensagem interativa"""
    type: str = Field(..., description="Tipo: text, video, image, document")
    text: Optional[str] = Field(None, description="Texto do cabeçalho (máx 60 caracteres)")
    video: Optional[Dict[str, str]] = Field(None, description="{'id': 'media_id'} ou {'link': 'url'}")
    image: Optional[Dict[str, str]] = Field(None, description="{'id': 'media_id'} ou {'link': 'url'}")
    document: Optional[Dict[str, str]] = Field(None, description="{'id': 'media_id'} ou {'link': 'url'}")


class InteractiveBody(BaseModel):
    """Corpo de mensagem interativa"""
    text: str = Field(..., description="Texto do corpo (máx 1024 caracteres)")


class InteractiveFooter(BaseModel):
    """Rodapé de mensagem interativa"""
    text: str = Field(..., description="Texto do rodapé (máx 60 caracteres)")


class InteractiveActionButtons(BaseModel):
    """Ação com botões de resposta"""
    buttons: List[InteractiveReplyButton] = Field(..., description="Botões (mín 1, máx 3)")
    
    @validator('buttons')
    def validate_buttons(cls, v):
        if not v or len(v) == 0:
            raise ValueError('É necessário pelo menos 1 botão')
        if len(v) > 3:
            raise ValueError('Máximo de 3 botões permitidos')
        return v


class InteractiveActionList(BaseModel):
    """Ação com lista"""
    button: str = Field(..., description="Texto do botão para abrir lista (máx 20 caracteres)")
    sections: List[InteractiveListSection] = Field(..., description="Seções da lista (mín 1, máx 10)")
    
    @validator('sections')
    def validate_sections(cls, v):
        if not v or len(v) == 0:
            raise ValueError('É necessário pelo menos 1 seção')
        if len(v) > 10:
            raise ValueError('Máximo de 10 seções permitidas')
        return v


class InteractiveActionProduct(BaseModel):
    """Ação com produto único"""
    catalog_id: str = Field(..., description="ID do catálogo")
    product_retailer_id: str = Field(..., description="ID do produto")


class InteractiveActionProductList(BaseModel):
    """Ação com lista de produtos"""
    catalog_id: str = Field(..., description="ID do catálogo")
    sections: List[Dict[str, Any]] = Field(..., description="Seções de produtos")


class SendInteractiveMessage(BaseModel):
    """Schema para enviar mensagem interativa"""
    to: str = Field(..., description="Número do destinatário")
    type: InteractiveTypeEnum = Field(..., description="Tipo de interativa")
    header: Optional[InteractiveHeader] = Field(None, description="Cabeçalho (opcional)")
    body: InteractiveBody = Field(..., description="Corpo da mensagem")
    footer: Optional[InteractiveFooter] = Field(None, description="Rodapé (opcional)")
    action: Union[
        InteractiveActionButtons,
        InteractiveActionList,
        InteractiveActionProduct,
        InteractiveActionProductList
    ] = Field(..., description="Ação/conteúdo interativo")
    reply_to: Optional[str] = Field(None, description="WAMID para responder")
    
    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)


  # REAÇÕES

class SendReactionMessage(BaseModel):
    """Schema para enviar reação (emoji)"""
    to: str = Field(..., description="Número do destinatário")
    message_id: str = Field(..., description="WAMID da mensagem para reagir")
    emoji: str = Field(..., description="Emoji Unicode (ex: 👍, ❤️, 😂)")
    from_me: bool = Field(False, description="True se a mensagem sendo reagida foi enviada por você (outbound)")
    # BUG real (2026-09-10, grupo "Comunicação Intervalo"): sem isso, o
    # backend precisa ADIVINHAR a conta pela conversa mais recente do
    # contato (_resolve_account_id) — quebra pra qualquer contato/grupo que
    # tenha conversa em MAIS de uma conta (comum em grupos internos com
    # vários números da empresa), escolhendo a conta errada e mandando a
    # reação pro bridge/sessão errado. O front já sabe exatamente qual
    # conta está olhando (selectedAccountId) — só precisava mandar.
    account_id: Optional[int] = Field(None, description="Conta que está enviando (evita resolução ambígua em contatos com conversa em várias contas)")

    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)
    
    @validator('emoji')
    def validate_emoji(cls, v):
        # Validar que é um emoji válido
        if not v or len(v.strip()) == 0:
            raise ValueError('Emoji não pode ser vazio')
        # Para remover reação, enviar string vazia
        return v


class RemoveReactionMessage(BaseModel):
    """Schema para remover reação"""
    to: str = Field(..., description="Número do destinatário")
    message_id: str = Field(..., description="WAMID da mensagem")
    # Ver comentário equivalente em SendReactionMessage — a rota já lia
    # getattr(message, "account_id", None) esperando esse campo existir,
    # mas ele nunca tinha sido declarado aqui, então sempre vinha None.
    account_id: Optional[int] = Field(None, description="Conta que está enviando (evita resolução ambígua em contatos com conversa em várias contas)")

    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)


# LOCATION & TEMPLATE (JÁ EXISTENTES)

class SendLocationMessage(BaseModel):
    """Schema para enviar localização"""
    to: str
    latitude: float
    longitude: float
    name: Optional[str] = None
    address: Optional[str] = None
    reply_to: Optional[str] = None
    account_id: Optional[int] = None


class SendTemplateMessage(BaseModel):
    """Schema para enviar mensagem template"""
    to: str
    template_name: str
    language_code: str = "pt_BR"
    components: Optional[List[Dict[str, Any]]] = None
    reply_to: Optional[str] = None
    account_id: Optional[int] = None


class MarkMessageRead(BaseModel):
    """
    Schema para marcar mensagem como lida
    
    CORRIGIDO: Removido alias para evitar confusão
    Frontend envia: {"message_id": "wamid.HBg..."}
    """
    message_id: str = Field(..., description="WAMID da mensagem a ser marcada como lida")
    account_id: Optional[int] = Field(None, description="ID da conta WhatsApp")

    class Config:
        # Aceitar tanto message_id quanto wamid como nomes de campo
        populate_by_name = True
        schema_extra = {
            "example": {
                "message_id": "wamid.HBgMNTU0NDg0MTQ2Mzc5FQIAEhgWM0VCMDg4QzA5OUIzM0MxMzEyQUFFNAA="
            }
        }


# LOGIN & AUTHENTICATION

class UserLogin(BaseModel):
    """Schema para requisição de login"""
    username: str = Field(..., description="Nome de usuário")
    password: str = Field(..., description="Senha do usuário")


# WEBHOOK SCHEMAS

class WebhookVerification(BaseModel):
    """Schema para verificação de webhook"""
    mode: str = Field(..., alias="hub.mode")
    token: str = Field(..., alias="hub.verify_token")
    challenge: str = Field(..., alias="hub.challenge")


class WebhookMessage(BaseModel):
    """Schema para mensagem recebida via webhook"""
    object: str
    entry: List[Dict[str, Any]]


# RESPONSE SCHEMAS

class APIResponse(BaseModel):
    """Schema padrão de resposta da API"""
    success: bool
    message: Optional[str] = None
    data: Optional[Any] = None
    error: Optional[str] = None


class WhatsAppAPIResponse(BaseModel):
    """Schema de resposta da API do WhatsApp"""
    messaging_product: str
    contacts: Optional[List[Dict[str, Any]]] = None
    messages: Optional[List[Dict[str, Any]]] = None


class MediaUploadResponse(BaseModel):
    """Schema de resposta de upload de mídia"""
    media_id: str
    url: Optional[str] = None


# WOOCOMMERCE SCHEMAS (para integração futura)

class WooCommerceOrderWebhook(BaseModel):
    """Schema para webhook do WooCommerce"""
    id: int
    status: str
    total: str
    billing: Dict[str, Any]
    line_items: List[Dict[str, Any]]

class SendInteractiveButtonsRequest(BaseModel):
    to: str
    body_text: str
    buttons: List[Dict[str, str]]
    header_text: Optional[str] = None
    footer_text: Optional[str] = None
    reply_to: Optional[str] = None
    account_id: Optional[int] = None

class SendInteractiveListRequest(BaseModel):
    to: str
    button_text: str
    sections: List[Dict[str, Any]]
    reply_to: Optional[str] = None
    account_id: Optional[int] = None
    # Aliases aceitos pelo ListSender.js do frontend, que envia body/header/footer
    # em vez de body_text/header_text/footer_text. Precisam vir ANTES de
    # body_text/header_text/footer_text para que os validators abaixo os enxerguem
    # em `values` (pydantic v1 só popula campos já processados na ordem declarada).
    body: Optional[str] = None
    header: Optional[str] = None
    footer: Optional[str] = None
    body_text: Optional[str] = None
    header_text: Optional[str] = None
    footer_text: Optional[str] = None

    @validator('body_text', always=True)
    def resolve_body_text(cls, v, values):
        resolved = v or values.get('body')
        if not resolved:
            raise ValueError('body_text (ou body) é obrigatório')
        return resolved

    @validator('header_text', always=True)
    def resolve_header_text(cls, v, values):
        return v or values.get('header')

    @validator('footer_text', always=True)
    def resolve_footer_text(cls, v, values):
        return v or values.get('footer')


class SendInteractiveProductRequest(BaseModel):
    to: str
    catalog_id: str
    product_retailer_id: str
    reply_to: Optional[str] = None
    account_id: Optional[int] = None
    # Aliases aceitos pelo ProductSender.js do frontend, que envia body/footer
    # em vez de body_text/footer_text. Precisam vir ANTES de body_text/footer_text
    # para que os validators abaixo os enxerguem em `values`.
    body: Optional[str] = None
    footer: Optional[str] = None
    body_text: Optional[str] = None
    footer_text: Optional[str] = None

    @validator('body_text', always=True)
    def resolve_body_text(cls, v, values):
        return v or values.get('body')

    @validator('footer_text', always=True)
    def resolve_footer_text(cls, v, values):
        return v or values.get('footer')


class SendInteractiveProductListRequest(BaseModel):
    """Lista de múltiplos produtos do catálogo, agrupados em seções"""
    to: str
    catalog_id: str
    header_text: str
    body_text: str
    sections: List[Dict[str, Any]]
    footer_text: Optional[str] = None
    reply_to: Optional[str] = None
    account_id: Optional[int] = None


class SendCtaUrlButtonRequest(BaseModel):
    """Botão CTA (Call-to-Action) que abre um link externo"""
    to: str
    body_text: str
    display_text: str
    url: str
    header_text: Optional[str] = None
    footer_text: Optional[str] = None
    reply_to: Optional[str] = None
    account_id: Optional[int] = None
