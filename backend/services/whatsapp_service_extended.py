"""
WhatsApp Service Estendido - Funcionalidades Avançadas
Inclui: Flows, Carrinhos, QR Codes, Business Profile, Analytics, Request Welcome
"""
import os
import httpx
from typing import Optional, Dict, Any, List, Union
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
import logging

load_dotenv()

logger = logging.getLogger(__name__)


def _to_unix_ts(value: Union[str, int, float], end_of_day: bool = False) -> int:
    """
    A Graph API exige start/end como timestamp unix (número) — o formulário de
    Analytics manda 'YYYY-MM-DD'. Aceita os dois formatos e sempre devolve int.
    end_of_day desloca pro início do dia seguinte, pra incluir o dia inteiro.
    """
    if isinstance(value, (int, float)):
        return int(value)
    value = str(value).strip()
    if value.isdigit():
        return int(value)
    dt = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if end_of_day:
        dt += timedelta(days=1)
    return int(dt.timestamp())


class WhatsAppServiceExtended:
    """
    Extensão do WhatsAppService com funcionalidades avançadas
    """
    
    def __init__(self, phone_number_id: str, access_token: str, business_account_id: Optional[str] = None):
        if not phone_number_id or not access_token:
            raise ValueError("As credenciais phone_number_id e access_token são obrigatórias para inicializar o WhatsAppServiceExtended.")
        self.phone_number_id = phone_number_id
        self.business_account_id = business_account_id
        self.access_token = access_token
        self.api_version = os.getenv("CLOUD_API_VERSION", "v23.0")
        self.base_url = f"https://graph.facebook.com/{self.api_version}"
        
        self.headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }
    
    async def _send_request(
        self,
        method: str,
        endpoint: str,
        json_data: Optional[Dict] = None,
        params: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """Envia requisição HTTP para API"""
        url = f"{self.base_url}/{endpoint}"

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                if method == "GET":
                    response = await client.get(url, headers=self.headers, params=params)
                elif method == "POST":
                    response = await client.post(url, headers=self.headers, json=json_data)
                elif method == "PATCH":
                    response = await client.patch(url, headers=self.headers, json=json_data)
                elif method == "DELETE":
                    response = await client.request(
                        "DELETE", url, headers=self.headers, json=json_data, params=params
                    )
                else:
                    raise ValueError(f"Método HTTP não suportado: {method}")
                
                response.raise_for_status()
                return response.json()
        
        except httpx.HTTPStatusError as e:
            logger.error(f"Erro HTTP {e.response.status_code}: {e.response.text}")
            raise
        except Exception as e:
            logger.error(f"Erro ao enviar requisição: {e}")
            raise
    
    # FLOWS (FORMULÁRIOS INTERATIVOS)
    
    async def send_flow(
        self,
        to: str,
        flow_id: str,
        flow_cta: str,
        flow_action: str,
        flow_action_payload: Dict[str, Any],
        body_text: str,
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia Flow (formulário interativo)
        
        Args:
            to: Número do destinatário
            flow_id: ID do Flow (criado no Meta Business Manager)
            flow_cta: Texto do botão (ex: "Preencher Cadastro")
            flow_action: "navigate" ou "data_exchange"
            flow_action_payload: {"screen": "WELCOME_SCREEN", "data": {...}}
            body_text: Texto do corpo
            header_text: Texto do cabeçalho (opcional)
            footer_text: Texto do rodapé (opcional)
            reply_to: WAMID para responder (opcional)
        
        Returns:
            Response da API
        """
        interactive = {
            "type": "flow",
            "body": {"text": body_text},
            "action": {
                "name": "flow",
                "parameters": {
                    "flow_message_version": "3",
                    "flow_token": f"flow_{to}_{flow_id}",
                    "flow_id": flow_id,
                    "flow_cta": flow_cta,
                    "flow_action": flow_action,
                    "flow_action_payload": flow_action_payload
                }
            }
        }
        
        if header_text:
            interactive["header"] = {"type": "text", "text": header_text}
        
        if footer_text:
            interactive["footer"] = {"text": footer_text}
        
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "interactive",
            "interactive": interactive
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando Flow {flow_id} para {to}")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/messages",
            json_data=payload
        )

    async def send_carousel_message(
        self,
        to: str,
        cards: List[Dict[str, Any]],
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia mensagem de carrossel (2-10 cards deslizáveis)
        
        Args:
            to: Número do destinatário
            cards: Lista de 2-10 cards
            reply_to: WAMID para responder (opcional)
        
        Card format:
        {
            "card_index": 0,
            "components": [
                {
                    "type": "header",
                    "parameters": [
                        {"type": "image", "image": {"id": "MEDIA_ID"}}
                    ]
                },
                {
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": "Produto Premium"}
                    ]
                },
                {
                    "type": "button",
                    "sub_type": "quick_reply",
                    "index": 0,
                    "parameters": [
                        {"type": "payload", "payload": "buy_product_1"}
                    ]
                }
            ]
        }
        
        Returns:
            Response da API
        """
        # Validações
        if len(cards) < 2 or len(cards) > 10:
            raise ValueError("Carousel deve ter entre 2-10 cards")
        
        # Construir payload
        interactive = {
            "type": "carousel",
            "cards": cards
        }
        
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "interactive",
            "interactive": interactive
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando Carousel com {len(cards)} cards para {to}")
        
        try:
            return await self._send_request(
                "POST",
                f"{self.phone_number_id}/messages",
                json_data=payload
            )
        except Exception as e:
            logger.error(f"Erro ao enviar carousel: {e}")
            raise

    async def send_location_request(
        self,
        to: str,
        body_text: str = "Por favor, compartilhe sua localização",
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia mensagem solicitando localização do usuário

        Args:
            to: Número do destinatário
            body_text: Texto da solicitação
            reply_to: WAMID para responder (opcional)

        Returns:
            Response da API
        """
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "interactive",
            "interactive": {
                "type": "location_request_message",
                "body": {"text": body_text},
                "action": {
                    "name": "send_location"
                }
            }
        }

        if reply_to:
            payload["context"] = {"message_id": reply_to}

        logger.info(f"Solicitando localização para {to}")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/messages",
            json_data=payload
        )

    # CARRINHOS DE COMPRAS
    
    async def send_cart(
        self,
        to: str,
        catalog_id: str,
        product_items: List[Dict[str, Any]],
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia carrinho de compras
        
        Args:
            to: Número do destinatário
            catalog_id: ID do catálogo
            product_items: [{"product_retailer_id": "SKU", "quantity": 2, "item_price": 99.90, "currency": "BRL"}]
            reply_to: WAMID para responder (opcional)
        
        Returns:
            Response da API
        """
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "order",
            "order": {
                "catalog_id": catalog_id,
                "product_items": product_items
            }
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando carrinho com {len(product_items)} item(ns) para {to}")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/messages",
            json_data=payload
        )
    
    # QR CODES
    
    async def create_qr_code(
        self,
        prefilled_message: str,
        generate_qr_image: str = "PNG"
    ) -> Dict[str, Any]:
        """
        Cria QR Code para iniciar conversa
        
        Args:
            prefilled_message: Mensagem pré-preenchida
            generate_qr_image: "PNG" ou "SVG"
        
        Returns:
            {
                "code": "QRCODE123",
                "prefilled_message": "Olá!",
                "deep_link_url": "https://wa.me/message/QRCODE123",
                "qr_image_url": "https://..."
            }
        """
        payload = {
            "prefilled_message": prefilled_message,
            "generate_qr_image": generate_qr_image
        }
        
        logger.info(f"Criando QR Code com mensagem: {prefilled_message[:50]}")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/message_qrdls",
            json_data=payload
        )
    
    async def list_qr_codes(self) -> Dict[str, Any]:
        """
        Lista todos os QR Codes criados
        
        Returns:
            {"data": [{"code": "...", "prefilled_message": "...", ...}]}
        """
        logger.info("Listando QR Codes")
        return await self._send_request(
            "GET",
            f"{self.phone_number_id}/message_qrdls"
        )
    
    async def get_qr_code(self, qr_code_id: str) -> Dict[str, Any]:
        """
        Obtém detalhes de um QR Code específico
        
        Args:
            qr_code_id: ID do QR Code
        
        Returns:
            Detalhes do QR Code
        """
        logger.info(f"Buscando QR Code: {qr_code_id}")
        return await self._send_request(
            "GET",
            f"{self.phone_number_id}/message_qrdls/{qr_code_id}"
        )
    
    async def update_qr_code(
        self,
        qr_code_id: str,
        prefilled_message: str
    ) -> Dict[str, Any]:
        """
        Atualiza mensagem de um QR Code
        
        Args:
            qr_code_id: ID do QR Code
            prefilled_message: Nova mensagem
        
        Returns:
            Response da API
        """
        payload = {"prefilled_message": prefilled_message}
        
        logger.info(f"Atualizando QR Code: {qr_code_id}")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/message_qrdls/{qr_code_id}",
            json_data=payload
        )
    
    async def delete_qr_code(self, qr_code_id: str) -> Dict[str, Any]:
        """
        Deleta QR Code
        
        Args:
            qr_code_id: ID do QR Code
        
        Returns:
            Response da API
        """
        logger.info(f"Deletando QR Code: {qr_code_id}")
        return await self._send_request(
            "DELETE",
            f"{self.phone_number_id}/message_qrdls/{qr_code_id}"
        )
    
    # BUSINESS PROFILE
    
    async def get_business_profile(self) -> Dict[str, Any]:
        """
        Obtém perfil de negócio
        
        Returns:
            {
                "about": "...",
                "address": "...",
                "description": "...",
                "email": "...",
                "profile_picture_url": "...",
                "vertical": "RETAIL",
                "websites": [...]
            }
        """
        logger.info("Buscando perfil de negócio")
        return await self._send_request(
            "GET",
            f"{self.phone_number_id}/whatsapp_business_profile",
            params={"fields": "about,address,description,email,profile_picture_url,vertical,websites"}
        )
    
    async def update_business_profile(
        self,
        about: Optional[str] = None,
        address: Optional[str] = None,
        description: Optional[str] = None,
        email: Optional[str] = None,
        profile_picture_handle: Optional[str] = None,
        vertical: Optional[str] = None,
        websites: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Atualiza perfil de negócio
        
        Args:
            about: Sobre (máx 139 caracteres)
            address: Endereço (máx 256 caracteres)
            description: Descrição (máx 512 caracteres)
            email: Email
            profile_picture_handle: Media ID da foto
            vertical: Categoria (RETAIL, ECOMMERCE, etc)
            websites: Lista de websites (máx 2)
        
        Returns:
            Response da API
        """
        payload = {}
        
        if about is not None:
            payload["about"] = about
        if address is not None:
            payload["address"] = address
        if description is not None:
            payload["description"] = description
        if email is not None:
            payload["email"] = email
        if profile_picture_handle is not None:
            payload["profile_picture_handle"] = profile_picture_handle
        if vertical is not None:
            payload["vertical"] = vertical
        if websites is not None:
            payload["websites"] = websites
        
        if not payload:
            raise ValueError("Pelo menos um campo deve ser fornecido")
        
        logger.info(f"Atualizando perfil de negócio: {list(payload.keys())}")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/whatsapp_business_profile",
            json_data={"messaging_product": "whatsapp", **payload}
        )
    
    # ANALYTICS
    
    async def get_analytics(
        self,
        start: str,
        end: str,
        granularity: str = "DAY",
        phone_numbers: Optional[List[str]] = None,
        product_types: Optional[List[str]] = None,
        country_codes: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Obtém analytics
        
        Args:
            start: Data início (YYYY-MM-DD)
            end: Data fim (YYYY-MM-DD)
            granularity: "HALF_HOUR", "DAILY", "MONTHLY"
            phone_numbers: Filtrar por números
            product_types: ["WHATSAPP", "CONVERSATION"]
            country_codes: ["BR", "US"]
        
        Returns:
            Dados de analytics
        """
        params = {
            "start": _to_unix_ts(start),
            "end": _to_unix_ts(end, end_of_day=True),
            "granularity": granularity
        }

        if phone_numbers:
            params["phone_numbers"] = ",".join(phone_numbers)
        if product_types:
            params["product_types"] = ",".join(product_types)
        if country_codes:
            params["country_codes"] = ",".join(country_codes)
        
        logger.info(f"Buscando analytics de {start} a {end}")
        return await self._send_request(
            "GET",
            f"{self.business_account_id}/conversation_analytics",
            params=params
        )
    
    # REQUEST WELCOME MESSAGE
    
    async def request_welcome(self, to: str) -> Dict[str, Any]:
        """
        Solicita que o cliente envie a primeira mensagem
        
        Args:
            to: Número do destinatário
        
        Returns:
            Response da API
        """
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "request_welcome"
        }
        
        logger.info(f"Solicitando mensagem de boas-vindas para {to}")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/messages",
            json_data=payload
        )
    
    # PHONE NUMBER MANAGEMENT
    
    async def get_phone_numbers(self) -> Dict[str, Any]:
        """
        Lista números de telefone da conta
        
        Returns:
            Lista de números
        """
        logger.info("Listando números de telefone")
        return await self._send_request(
            "GET",
            f"{self.business_account_id}/phone_numbers"
        )
    
    async def get_phone_number_info(self) -> Dict[str, Any]:
        """
        Obtém informações detalhadas do número
        
        Returns:
            Informações do número (quality rating, etc)
        """
        logger.info("ℹBuscando informações do número")
        return await self._send_request(
            "GET",
            self.phone_number_id,
            params={"fields": "quality_rating,code_verification_status,display_phone_number"}
        )

    # BLOCK USERS

    async def block_users(self, users: List[str]) -> Dict[str, Any]:
        """
        Bloqueia um ou mais usuários — eles deixam de poder enviar mensagens
        para o número de negócio e o negócio deixa de poder enviar para eles.

        Args:
            users: Lista de números no formato E.164 (ex: ["5544999999999"])

        Returns:
            Response da API
        """
        payload = {
            "messaging_product": "whatsapp",
            "block_users": [{"user": u} for u in users],
        }
        logger.info(f"Bloqueando {len(users)} usuário(s)")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/block_users",
            json_data=payload
        )

    async def unblock_users(self, users: List[str]) -> Dict[str, Any]:
        """
        Desbloqueia um ou mais usuários previamente bloqueados.

        Args:
            users: Lista de números no formato E.164
        """
        payload = {
            "messaging_product": "whatsapp",
            "block_users": [{"user": u} for u in users],
        }
        logger.info(f"Desbloqueando {len(users)} usuário(s)")
        return await self._send_request(
            "DELETE",
            f"{self.phone_number_id}/block_users",
            json_data=payload
        )

    async def get_blocked_users(self) -> Dict[str, Any]:
        """Lista os usuários atualmente bloqueados para este número."""
        logger.info("Listando usuários bloqueados")
        return await self._send_request(
            "GET",
            f"{self.phone_number_id}/block_users"
        )

    # GROUPS (BETA)
    # Feature nova da Meta (Cloud API Groups), liberada apenas para
    # contas Official Business Account (selo verde). Os nomes de campo
    # abaixo seguem o padrão documentado publicamente pela Meta no momento
    # da implementação — confirme na documentação oficial
    # (developers.facebook.com/documentation/business-messaging/whatsapp/groups)
    # antes de usar em produção, pois é uma API recente e pode mudar.

    async def create_group(self, subject: str, participants: List[str]) -> Dict[str, Any]:
        """
        Cria um grupo do WhatsApp via Cloud API (requer Official Business Account).

        Args:
            subject: Nome/título do grupo
            participants: Números E.164 dos participantes iniciais (máx 8)

        Returns:
            Response da API contendo o group_id e o invite link
        """
        payload = {
            "messaging_product": "whatsapp",
            "subject": subject,
            "participants": participants,
        }
        logger.info(f"Criando grupo '{subject}' com {len(participants)} participante(s)")
        return await self._send_request(
            "POST",
            f"{self.phone_number_id}/groups",
            json_data=payload
        )

    async def get_group_info(self, group_id: str) -> Dict[str, Any]:
        """Busca metadados de um grupo criado via Cloud API (subject, participantes, invite link)."""
        return await self._send_request(
            "GET",
            group_id,
            params={"fields": "subject,participants,invite_link"}
        )


