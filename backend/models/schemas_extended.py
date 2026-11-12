from pydantic import BaseModel, Field, validator
from typing import Optional, List, Dict, Any, Literal # Adicionar Literal
from datetime import datetime

from backend.models.schemas import clean_recipient


# FLOWS (FORMULÁRIOS INTERATIVOS)

class FlowActionPayload(BaseModel):
    """Payload de ação do Flow"""
    screen: str = Field(..., description="ID da tela do Flow")
    data: Optional[Dict[str, Any]] = Field(None, description="Dados adicionais")


class SendFlowMessage(BaseModel):
    """Schema para enviar Flow (formulário interativo)"""
    to: str = Field(..., description="Número do destinatário")
    flow_id: str = Field(..., description="ID do Flow (obtido no Meta Business Manager)")
    flow_cta: str = Field(..., description="Texto do botão CTA (ex: 'Preencher Formulário')")
    flow_action: str = Field("navigate", description="Tipo de ação: navigate ou data_exchange")
    flow_action_payload: FlowActionPayload = Field(..., description="Dados da ação")
    body_text: str = Field(..., description="Texto do corpo")
    header_text: Optional[str] = Field(None, description="Texto do cabeçalho")
    footer_text: Optional[str] = Field(None, description="Texto do rodapé")
    reply_to: Optional[str] = Field(None, description="WAMID para responder")
    account_id: Optional[int] = Field(None, description="Conta WhatsApp a usar (opcional)")

    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)

class CarouselCard(BaseModel):
    """Card individual do carrossel"""
    id: str  # Identificador único do card
    header_type: Literal["image", "video"] = "image"
    header_media_id: Optional[str] = None  # ID da mídia já enviada para WhatsApp
    body_text: str  # Texto principal (até 160 caracteres)
    footer_text: Optional[str] = None  # Rodapé opcional
    buttons: List[Dict[str, str]]  # Lista de botões (máx 2 por card)
    # Formato: [{"type": "quick_reply", "text": "Ver mais"}]


class SendCarouselMessage(BaseModel):
    """Schema para enviar mensagem de carrossel"""
    to: str
    cards: List[CarouselCard]  # Mínimo 2, máximo 10 cards
    account_id: Optional[int] = None

    @validator('cards')
    def validate_cards(cls, v):
        if len(v) < 2:
            raise ValueError("Mínimo de 2 cards no carrossel")
        if len(v) > 10:
            raise ValueError("Máximo de 10 cards no carrossel")
        return v

class SendLocationRequestMessage(BaseModel):
    """Schema para solicitar localização do usuário"""
    to: str
    body_text: str = "Por favor, compartilhe sua localização"
    account_id: Optional[int] = None


# CARRINHOS DE COMPRAS

class CartItem(BaseModel):
    """Item do carrinho"""
    product_retailer_id: str = Field(..., description="SKU do produto")
    quantity: int = Field(..., ge=1, description="Quantidade (mínimo 1)")
    item_price: float = Field(..., ge=0, description="Preço unitário")
    currency: str = Field("BRL", description="Moeda (padrão BRL)")


class SendCartMessage(BaseModel):
    """Schema para enviar carrinho de compras"""
    to: str = Field(..., description="Número do destinatário")
    catalog_id: str = Field(..., description="ID do catálogo")
    product_items: List[CartItem] = Field(..., min_items=1, description="Itens do carrinho")
    reply_to: Optional[str] = Field(None, description="WAMID para responder")
    account_id: Optional[int] = Field(None, description="Conta WhatsApp a usar (opcional)")

    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)


# QR CODES

class CreateQRCodeRequest(BaseModel):
    """Schema para criar QR Code"""
    prefilled_message: str = Field(..., description="Mensagem pré-preenchida")
    generate_qr_image: str = Field("PNG", description="Formato da imagem: PNG ou SVG")


class QRCodeResponse(BaseModel):
    """Schema de resposta da criação de QR Code"""
    code: str = Field(..., description="Código do QR")
    prefilled_message: str = Field(..., description="Mensagem pré-preenchida")
    deep_link_url: str = Field(..., description="URL wa.me com QR code")
    qr_image_url: Optional[str] = Field(None, description="URL da imagem do QR Code")


class ListQRCodesResponse(BaseModel):
    """Schema de resposta da listagem de QR Codes"""
    data: List[QRCodeResponse] = Field(..., description="Lista de QR Codes")


class UpdateQRCodeRequest(BaseModel):
    """Schema para atualizar QR Code"""
    prefilled_message: str = Field(..., description="Nova mensagem pré-preenchida")


# BUSINESS PROFILE

class BusinessProfileUpdate(BaseModel):
    """Schema para atualizar perfil de negócio"""
    about: Optional[str] = Field(None, max_length=139, description="Sobre a empresa (máx 139 caracteres)")
    address: Optional[str] = Field(None, max_length=256, description="Endereço")
    description: Optional[str] = Field(None, max_length=512, description="Descrição")
    email: Optional[str] = Field(None, description="Email de contato")
    profile_picture_handle: Optional[str] = Field(None, description="Media ID da foto de perfil")
    vertical: Optional[str] = Field(
        None,
        description="Categoria: AUTOMOTIVE, BEAUTY, APPAREL, EDU, ENTERTAIN, EVENT_PLAN, FINANCE, GROCERY, GOVT, HOTEL, HEALTH, NONPROFIT, PROF_SERVICES, RETAIL, TRAVEL, RESTAURANT, NOT_A_BIZ"
    )
    websites: Optional[List[str]] = Field(None, max_items=2, description="Lista de websites (máximo 2)")


class BusinessProfileResponse(BaseModel):
    """Schema de resposta do perfil de negócio"""
    about: Optional[str] = None
    address: Optional[str] = None
    description: Optional[str] = None
    email: Optional[str] = None
    messaging_product: str = "whatsapp"
    profile_picture_url: Optional[str] = None
    vertical: Optional[str] = None
    websites: Optional[List[str]] = None


# ANALYTICS

class AnalyticsRequest(BaseModel):
    """Schema para solicitar analytics"""
    start: str = Field(..., description="Data início (YYYY-MM-DD)")
    end: str = Field(..., description="Data fim (YYYY-MM-DD)")
    granularity: str = Field("DAY", description="Granularidade: HALF_HOUR, DAILY, MONTHLY")
    phone_numbers: Optional[List[str]] = Field(None, description="Filtrar por números específicos")
    product_types: Optional[List[str]] = Field(
        None,
        description="Tipos de produto: WHATSAPP, CONVERSATION"
    )
    country_codes: Optional[List[str]] = Field(None, description="Códigos de país (ex: ['BR', 'US'])")
    
    @validator('start', 'end')
    def validate_date_format(cls, v):
        try:
            datetime.strptime(v, '%Y-%m-%d')
            return v
        except ValueError:
            raise ValueError('Data deve estar no formato YYYY-MM-DD')


class ConversationAnalytics(BaseModel):
    """Métricas de conversação"""
    conversation_category: str = Field(..., description="AUTHENTICATION, MARKETING, UTILITY, SERVICE, UNKNOWN")
    conversation_type: str = Field(..., description="REGULAR, FREE_TIER, FREE_ENTRY_POINT")
    conversation_direction: str = Field(..., description="BUSINESS_INITIATED, USER_INITIATED")
    cost: float = Field(..., description="Custo da conversa")
    country: Optional[str] = Field(None, description="Código do país")


class AnalyticsDataPoint(BaseModel):
    """Ponto de dados de analytics"""
    start: int = Field(..., description="Timestamp de início")
    end: int = Field(..., description="Timestamp de fim")
    sent: int = Field(0, description="Mensagens enviadas")
    delivered: int = Field(0, description="Mensagens entregues")
    read: int = Field(0, description="Mensagens lidas")
    failed: int = Field(0, description="Mensagens falhadas")
    conversations: Optional[List[ConversationAnalytics]] = Field(None, description="Conversações")


class AnalyticsResponse(BaseModel):
    """Schema de resposta de analytics"""
    phone_numbers: List[str] = Field(..., description="Números analisados")
    granularity: str
    data_points: List[AnalyticsDataPoint] = Field(..., description="Pontos de dados")


# REQUEST WELCOME MESSAGE

class RequestWelcomeMessage(BaseModel):
    """Schema para solicitar mensagem de boas-vindas"""
    to: str = Field(..., description="Número do destinatário")
    account_id: Optional[int] = Field(None, description="Conta WhatsApp a usar (opcional)")

    @validator('to')
    def validate_phone(cls, v):
        return clean_recipient(v)


# WEBHOOK EVENTS ESTENDIDOS

class OrderItem(BaseModel):
    """Item de um pedido"""
    product_retailer_id: str
    quantity: int
    item_price: float
    currency: str


class OrderMessage(BaseModel):
    """Mensagem de pedido recebida"""
    catalog_id: str
    product_items: List[OrderItem]
    text: Optional[str] = None


class ReferralMessage(BaseModel):
    """Mensagem de referência (ads, posts)"""
    source_url: str = Field(..., description="URL de origem (anúncio, post)")
    source_type: str = Field(..., description="Tipo: ad, post")
    source_id: str = Field(..., description="ID da fonte")
    headline: Optional[str] = Field(None, description="Título do anúncio")
    body: Optional[str] = Field(None, description="Corpo do anúncio")
    media_type: Optional[str] = Field(None, description="Tipo de mídia: image, video")
    image_url: Optional[str] = Field(None, description="URL da imagem")
    video_url: Optional[str] = Field(None, description="URL do vídeo")
    thumbnail_url: Optional[str] = Field(None, description="URL da thumbnail")


class SystemMessage(BaseModel):
    """Mensagem do sistema"""
    type: str = Field(..., description="customer_identity_changed, customer_number_change")
    body: str = Field(..., description="Corpo da mensagem do sistema")
    identity: Optional[str] = Field(None, description="Nova identidade (wa_id)")
    wa_id: Optional[str] = Field(None, description="WhatsApp ID")
    customer: Optional[str] = Field(None, description="Número do cliente")


class FlowResponseData(BaseModel):
    """Dados de resposta de um Flow"""
    flow_token: str = Field(..., description="Token único da resposta")
    response_json: Dict[str, Any] = Field(..., description="Dados submetidos pelo usuário")


class FlowMessage(BaseModel):
    """Mensagem de resposta de Flow"""
    flow_token: str
    flow_id: str
    flow_response_data: FlowResponseData


# PHONE NUMBER QUALITY

class PhoneNumberQualityUpdate(BaseModel):
    """Atualização de qualidade do número"""
    phone_number: str
    quality_score: str = Field(..., description="GREEN, YELLOW, RED")
    previous_quality_score: Optional[str] = None
    update_event: str = Field(..., description="Tipo de atualização")


# ACCOUNT ALERTS

class AccountAlert(BaseModel):
    """Alerta da conta"""
    alert_type: str = Field(..., description="Tipo de alerta")
    alert_severity: str = Field(..., description="INFO, WARNING, ERROR")
    title: str
    description: str


# TEMPLATE STATUS

class TemplateStatusUpdate(BaseModel):
    """Atualização de status de template"""
    message_template_id: str
    message_template_name: str
    message_template_language: str
    event: str = Field(..., description="APPROVED, REJECTED, PENDING, DISABLED")
    reason: Optional[str] = Field(None, description="Razão da rejeição/desabilitação")


# RATE LIMIT INFO

class RateLimitInfo(BaseModel):
    """Informações de rate limit da API"""
    app_id: str
    business_id: str
    rate_limit_hit: bool = Field(..., description="Se atingiu o limite")
    rate_limit_type: str = Field(..., description="MESSAGES, CALLS, MARKETING")
    call_count: int = Field(..., description="Número de chamadas na janela atual")
    total_cputime: int = Field(..., description="Tempo total de CPU usado")
    total_time: int = Field(..., description="Tempo total decorrido")
    estimated_time_to_regain_access: Optional[int] = Field(None, description="Tempo estimado para recuperar acesso (segundos)")
