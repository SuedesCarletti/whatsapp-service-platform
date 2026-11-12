"""
Serviço COMPLETO para integração com WhatsApp Cloud API
Inclui TODAS as funcionalidades do WhatsApp Business Cloud API
"""
import os
import httpx
import aiofiles
from typing import Optional, Dict, Any, List, BinaryIO
from pathlib import Path
from dotenv import load_dotenv
import logging

load_dotenv()

logger = logging.getLogger(__name__)


class WhatsAppAPIError(Exception):
    """
    Erro da Graph API já traduzido pra mensagem legível. str(e) retorna a
    mensagem amigável — os handlers em routes.py já fazem detail=str(e),
    então isso corrige a opacidade sem precisar tocar em cada rota.
    """
    def __init__(self, message: str, code: Optional[int] = None, subcode: Optional[int] = None, http_status: int = 502):
        self.code = code
        self.subcode = subcode
        self.http_status = http_status
        super().__init__(message)


# Mapa de code/error_subcode da Graph API -> mensagem amigável em pt-BR.
# Referência: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
_META_ERROR_MESSAGES: Dict[int, str] = {
    # Janela de atendimento / template
    131047: "Fora da janela de 24h de atendimento — a Meta só aceita mensagem de template pra esse contato agora.",
    131026: "Mensagem não entregue — esse número não tem WhatsApp ativo ou está indisponível no momento.",
    131021: "Não é possível enviar mensagem para o próprio número de origem.",
    131009: "Parâmetro inválido em algum campo da mensagem.",
    131008: "Faltou preencher um campo obrigatório na mensagem.",
    131056: "Limite de mensagens simultâneas (pair rate limit) excedido para esse contato — aguarde e tente de novo.",
    131048: "Limite de mensagens de template atingido (spam rate limit) — a Meta está limitando o envio pra esse número.",
    131031: "Conta do WhatsApp Business restrita ou desabilitada pela Meta.",
    131052: "Mídia não pôde ser baixada — verifique o link/arquivo enviado.",
    131053: "Falha ao enviar mídia — formato ou tamanho de arquivo não suportado.",
    # Templates
    132000: "Número de variáveis do template não bate com o que foi aprovado.",
    132001: "Template não encontrado (nome ou idioma não existe/não está aprovado).",
    132005: "Formato de mídia do header do template diferente do esperado.",
    132007: "Template pausado pela Meta — a qualidade caiu e o envio foi suspenso temporariamente.",
    132012: "Parâmetro do template com formatação não permitida (ex: múltiplas quebras de linha seguidas).",
    132015: "Template rejeitado pela Meta — não pode ser usado para envio.",
    132016: "Template atingiu o limite de edições no período.",
    # Conta / token / número
    190: "Access Token expirado ou inválido — gere um novo token de sistema na Meta.",
    200: "Permissão ausente no Access Token para essa operação.",
    10: "Sem permissão para essa operação — falta escopo no Access Token/App.",
    100: "Parâmetro inválido ou objeto referenciado não existe/sem permissão de acesso.",
    368: "Conta temporariamente bloqueada por violar as políticas de uso da Meta.",
    133000: "Falha genérica no servidor da Meta — tente novamente em instantes.",
    133004: "Serviço da Meta temporariamente indisponível.",
    133005: "Access Token não corresponde a essa conta do WhatsApp Business.",
    133006: "Número de telefone inválido para essa conta do WhatsApp Business.",
    133008: "Número de telefone não está registrado na Cloud API.",
    133009: "Limite de tentativas de registro do número excedido — aguarde antes de tentar de novo.",
    133010: "Número de telefone não está cadastrado nessa conta da Cloud API.",
    135000: "Parâmetro genérico inválido na requisição.",
    # MM Lite
    134100: "O endpoint MM Lite só aceita templates de categoria MARKETING — esse é de outra categoria.",
}


def _translate_meta_error(status_code: int, body: Dict[str, Any]) -> WhatsAppAPIError:
    """Converte o corpo de erro cru da Graph API numa WhatsAppAPIError com mensagem legível."""
    err = (body or {}).get("error") or {}
    code = err.get("code")
    subcode = err.get("error_subcode")
    raw_message = err.get("message") or err.get("error_user_msg") or "Erro desconhecido na Meta API"

    details = None
    error_data = err.get("error_data")
    if isinstance(error_data, dict):
        details = error_data.get("details")

    friendly = None
    if subcode is not None:
        friendly = _META_ERROR_MESSAGES.get(subcode)
    if friendly is None and code is not None:
        friendly = _META_ERROR_MESSAGES.get(code)

    message = friendly or raw_message
    if details and details not in message:
        message = f"{message} ({details})"

    http_status = status_code if status_code in (400, 401, 403, 404, 409, 429) else 502
    return WhatsAppAPIError(message, code=code, subcode=subcode, http_status=http_status)


class WhatsAppService:
    """
    Serviço completo para integração com WhatsApp Business Cloud API
    Inclui: texto, mídia, localização, templates, contatos, interativas e reações
    """
    
    def __init__(self, phone_number_id: str, access_token: str, provider_type: Optional[str] = None):
        if not phone_number_id or not access_token:
            raise ValueError("As credenciais phone_number_id e access_token são obrigatórias para inicializar o WhatsAppService.")

        self.phone_number_id = phone_number_id
        self.access_token = access_token
        # Só usado pro log de possível estouro de rate limit de Coexistência
        # (ver _send_request) — não afeta o envio em si.
        self.provider_type = provider_type
        self.api_version = os.getenv("CLOUD_API_VERSION", "v23.0")
        self.base_url = f"https://{os.getenv('WA_BASE_URL', 'graph.facebook.com')}"
        self.api_url = f"{self.base_url}/{self.api_version}/{self.phone_number_id}"

        self.headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }
    
    # MÉTODO AUXILIAR - ENVIO GENÉRICO
    
    async def _send_request(
        self, 
        method: str, 
        endpoint: str, 
        json_data: Optional[Dict] = None,
        files: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        Envia requisição para API do WhatsApp
        """
        url = f"{self.api_url}{endpoint}"
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                if files:
                    # Upload de arquivo (sem Content-Type JSON)
                    headers = {"Authorization": f"Bearer {self.access_token}"}
                    response = await client.post(url, headers=headers, files=files, data=json_data)
                else:
                    # Requisição JSON normal
                    if method == "POST":
                        response = await client.post(url, headers=self.headers, json=json_data)
                    elif method == "GET":
                        response = await client.get(url, headers=self.headers)
                    else:
                        raise ValueError(f"Método HTTP não suportado: {method}")
                
                response.raise_for_status()
                return response.json()
                
        except httpx.HTTPStatusError as e:
            logger.error(f"Erro HTTP {e.response.status_code}: {e.response.text}")
            try:
                body = e.response.json()
            except ValueError:
                body = {}
            if (
                e.response.status_code == 429
                and self.provider_type in ("meta_cloud_coexistence", "meta_cloud_full")
                and ((body or {}).get("error") or {}).get("code") not in _META_ERROR_MESSAGES
            ):
                # Meta documenta um cap de ~5 msg/s pra números em Coexistência
                # (não confirmado ao vivo) — 429 não mapeado nessa conta é o
                # suspeito mais provável, log distinto pra facilitar achar isso
                # nos logs se/quando acontecer de verdade.
                logger.warning(f"Possível rate limit de Coexistência (phone_number_id={self.phone_number_id}): {e.response.text[:300]}")
            raise _translate_meta_error(e.response.status_code, body) from e
        except Exception as e:
            logger.error(f"Erro ao enviar requisição: {e}")
            raise
    
    @staticmethod
    def validate_phone_number(phone: str) -> str:
        """Remove caracteres não numéricos do telefone, exceto para JIDs de grupo/lid"""
        phone = phone.strip()
        if "@" in phone:
            return phone
        return ''.join(filter(str.isdigit, phone))
    
    # ENVIO DE MENSAGENS BÁSICAS
    
    async def send_text_message(
        self,
        to: str,
        text: str,
        preview_url: bool = False,
        reply_to: Optional[str] = None,
        recipient_type: str = "individual"
    ) -> Dict[str, Any]:
        """
        Envia mensagem de texto

        Args:
            to: Número do destinatário (com código do país, sem +) ou group_id
            text: Texto da mensagem
            preview_url: Se True, gera preview de URLs na mensagem
            reply_to: WAMID da mensagem para responder (opcional)
            recipient_type: "individual" ou "group" (para grupos criados via Groups API)

        Returns:
            Response da API do WhatsApp
        """
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": recipient_type,
            "to": to,
            "type": "text",
            "text": {
                "preview_url": preview_url,
                "body": text
            }
        }
        
        # ADICIONAR CONTEXTO DE RESPOSTA
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_image(
        self, 
        to: str, 
        image_id: Optional[str] = None,
        image_link: Optional[str] = None,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None  # NOVO
    ) -> Dict[str, Any]:
        """Envia imagem (via ID de mídia ou URL)"""
        if not image_id and not image_link:
            raise ValueError("Você deve fornecer image_id ou image_link")
        
        image_data = {"id": image_id} if image_id else {"link": image_link}
        if caption:
            image_data["caption"] = caption
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "image",
            "image": image_data
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_video(
        self,
        to: str,
        video_id: Optional[str] = None,
        video_link: Optional[str] = None,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """Envia vídeo"""
        if not video_id and not video_link:
            raise ValueError("Você deve fornecer video_id ou video_link")
        
        video_data = {"id": video_id} if video_id else {"link": video_link}
        if caption:
            video_data["caption"] = caption
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "video",
            "video": video_data
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_audio(
        self,
        to: str,
        audio_id: Optional[str] = None,
        audio_link: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """Envia áudio"""
        if not audio_id and not audio_link:
            raise ValueError("Você deve fornecer audio_id ou audio_link")
        
        audio_data = {"id": audio_id} if audio_id else {"link": audio_link}
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "audio",
            "audio": audio_data
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_document(
        self,
        to: str,
        document_id: Optional[str] = None,
        document_link: Optional[str] = None,
        caption: Optional[str] = None,
        filename: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """Envia documento (PDF, DOC, etc)"""
        if not document_id and not document_link:
            raise ValueError("Você deve fornecer document_id ou document_link")
        
        document_data = {"id": document_id} if document_id else {"link": document_link}
        if caption:
            document_data["caption"] = caption
        if filename:
            document_data["filename"] = filename
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "document",
            "document": document_data
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_sticker(
        self,
        to: str,
        sticker_id: Optional[str] = None,
        sticker_link: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """Envia sticker (WEBP animado ou estático)"""
        if not sticker_id and not sticker_link:
            raise ValueError("Você deve fornecer sticker_id ou sticker_link")
        
        sticker_data = {"id": sticker_id} if sticker_id else {"link": sticker_link}
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "sticker",
            "sticker": sticker_data
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_location(
        self,
        to: str,
        latitude: float,
        longitude: float,
        name: Optional[str] = None,
        address: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """Envia localização"""
        location_data = {
            "latitude": latitude,
            "longitude": longitude
        }
        if name:
            location_data["name"] = name
        if address:
            location_data["address"] = address
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "location",
            "location": location_data
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        return await self._send_request("POST", "/messages", json_data=payload)
    
    # NOVO: ENVIO DE CONTATOS
    
    async def send_contacts(
        self,
        to: str,
        contacts: List[Dict[str, Any]],
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia contato(s) no formato vCard
        
        Args:
            to: Número do destinatário
            contacts: Lista de contatos no formato WhatsApp
            reply_to: WAMID para responder (opcional)
        
        Returns:
            Response da API
            
        Example contact format:
        {
            "name": {
                "formatted_name": "João Silva",
                "first_name": "João",
                "last_name": "Silva"
            },
            "phones": [
                {
                    "phone": "5511999990001",
                    "type": "CELL",
                    "wa_id": "5511999990001"
                }
            ],
            "emails": [
                {
                    "email": "joao@example.com",
                    "type": "WORK"
                }
            ],
            "addresses": [
                {
                    "street": "Rua Exemplo, 123",
                    "city": "São Paulo",
                    "state": "SP",
                    "country": "Brasil",
                    "type": "HOME"
                }
            ],
            "org": {
                "company": "Empresa XYZ",
                "title": "Gerente"
            },
            "urls": [
                {
                    "url": "https://example.com",
                    "type": "WORK"
                }
            ],
            "birthday": "1990-01-15"
        }
        """
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "contacts",
            "contacts": contacts
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando {len(contacts)} contato(s) para {to}")
        return await self._send_request("POST", "/messages", json_data=payload)
    
    # NOVO: MENSAGENS INTERATIVAS
    
    async def send_interactive_buttons(
        self,
        to: str,
        body_text: str,
        buttons: List[Dict[str, str]],
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia mensagem com botões de resposta (máximo 3)
        
        Args:
            to: Número do destinatário
            body_text: Texto principal da mensagem
            buttons: Lista de botões [{"id": "btn_1", "title": "Texto"}]
            header_text: Texto do cabeçalho (opcional)
            footer_text: Texto do rodapé (opcional)
            reply_to: WAMID para responder (opcional)
        
        Returns:
            Response da API
        """
        if not buttons or len(buttons) == 0:
            raise ValueError("É necessário pelo menos 1 botão")
        if len(buttons) > 3:
            raise ValueError("Máximo de 3 botões permitidos")
        
        # Construir payload
        interactive = {
            "type": "button",
            "body": {"text": body_text},
            "action": {
                "buttons": [
                    {
                        "type": "reply",
                        "reply": {"id": btn["id"], "title": btn["title"]}
                    }
                    for btn in buttons
                ]
            }
        }
        
        if header_text:
            interactive["header"] = {"type": "text", "text": header_text}
        
        if footer_text:
            interactive["footer"] = {"text": footer_text}
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "interactive",
            "interactive": interactive
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando {len(buttons)} botão(ões) para {to}")
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_interactive_list(
        self,
        to: str,
        body_text: str,
        button_text: str,
        sections: List[Dict[str, Any]],
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia mensagem com lista de opções
        
        Args:
            to: Número do destinatário
            body_text: Texto principal
            button_text: Texto do botão para abrir a lista
            sections: Lista de seções com itens
            header_text: Texto do cabeçalho (opcional)
            footer_text: Texto do rodapé (opcional)
            reply_to: WAMID para responder (opcional)
        
        Returns:
            Response da API
            
        Example sections format:
        [
            {
                "title": "Seção 1",
                "rows": [
                    {"id": "row_1", "title": "Item 1", "description": "Descrição"},
                    {"id": "row_2", "title": "Item 2"}
                ]
            }
        ]
        """
        if not sections or len(sections) == 0:
            raise ValueError("É necessário pelo menos 1 seção")
        if len(sections) > 10:
            raise ValueError("Máximo de 10 seções permitidas")
        
        # Construir payload
        interactive = {
            "type": "list",
            "body": {"text": body_text},
            "action": {
                "button": button_text,
                "sections": sections
            }
        }
        
        if header_text:
            interactive["header"] = {"type": "text", "text": header_text}
        
        if footer_text:
            interactive["footer"] = {"text": footer_text}
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "interactive",
            "interactive": interactive
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando lista com {len(sections)} seção(ões) para {to}")
        return await self._send_request("POST", "/messages", json_data=payload)

    async def send_cta_url_button(
        self,
        to: str,
        body_text: str,
        display_text: str,
        url: str,
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia mensagem com botão CTA (Call-to-Action) que abre um link externo

        Args:
            to: Número do destinatário
            body_text: Texto principal da mensagem
            display_text: Texto exibido no botão (ex: "Ver oferta")
            url: URL que o botão abre
            header_text: Texto do cabeçalho (opcional)
            footer_text: Texto do rodapé (opcional)
            reply_to: WAMID para responder (opcional)

        Returns:
            Response da API
        """
        interactive = {
            "type": "cta_url",
            "body": {"text": body_text},
            "action": {
                "name": "cta_url",
                "parameters": {
                    "display_text": display_text,
                    "url": url
                }
            }
        }

        if header_text:
            interactive["header"] = {"type": "text", "text": header_text}

        if footer_text:
            interactive["footer"] = {"text": footer_text}

        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "interactive",
            "interactive": interactive
        }

        if reply_to:
            payload["context"] = {"message_id": reply_to}

        logger.info(f"Enviando botão CTA ({display_text} -> {url}) para {to}")
        return await self._send_request("POST", "/messages", json_data=payload)

    async def send_interactive_product(
        self,
        to: str,
        catalog_id: str,
        product_retailer_id: str,
        body_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia mensagem com produto único do catálogo
        
        Args:
            to: Número do destinatário
            catalog_id: ID do catálogo do WhatsApp Business
            product_retailer_id: ID do produto no catálogo
            body_text: Texto opcional do corpo
            footer_text: Texto opcional do rodapé
            reply_to: WAMID para responder (opcional)
        
        Returns:
            Response da API
        """
        interactive = {
            "type": "product",
            "action": {
                "catalog_id": catalog_id,
                "product_retailer_id": product_retailer_id
            }
        }
        
        if body_text:
            interactive["body"] = {"text": body_text}
        
        if footer_text:
            interactive["footer"] = {"text": footer_text}
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "interactive",
            "interactive": interactive
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando produto {product_retailer_id} para {to}")
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def send_interactive_product_list(
        self,
        to: str,
        catalog_id: str,
        header_text: str,
        body_text: str,
        sections: List[Dict[str, Any]],
        footer_text: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Envia mensagem com lista de produtos do catálogo
        
        Args:
            to: Número do destinatário
            catalog_id: ID do catálogo
            header_text: Texto do cabeçalho
            body_text: Texto do corpo
            sections: Seções com produtos
            footer_text: Texto do rodapé (opcional)
            reply_to: WAMID para responder (opcional)
        
        Returns:
            Response da API
            
        Example sections format:
        [
            {
                "title": "Categoria 1",
                "product_items": [
                    {"product_retailer_id": "prod_1"},
                    {"product_retailer_id": "prod_2"}
                ]
            }
        ]
        """
        interactive = {
            "type": "product_list",
            "header": {"type": "text", "text": header_text},
            "body": {"text": body_text},
            "action": {
                "catalog_id": catalog_id,
                "sections": sections
            }
        }
        
        if footer_text:
            interactive["footer"] = {"text": footer_text}
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "interactive",
            "interactive": interactive
        }
        
        if reply_to:
            payload["context"] = {"message_id": reply_to}
        
        logger.info(f"Enviando lista de produtos para {to}")
        return await self._send_request("POST", "/messages", json_data=payload)
    
    # NOVO: REAÇÕES
    
    async def send_reaction(
        self,
        to: str,
        message_id: str,
        emoji: str
    ) -> Dict[str, Any]:
        """
        Envia reação (emoji) para uma mensagem
        
        Args:
            to: Número do destinatário
            message_id: WAMID da mensagem para reagir
            emoji: Emoji Unicode (ex: 👍, ❤️, 😂)
        
        Returns:
            Response da API
        """
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "reaction",
            "reaction": {
                "message_id": message_id,
                "emoji": emoji
            }
        }
        
        logger.info(f"Enviando reação {emoji} para mensagem {message_id}")
        return await self._send_request("POST", "/messages", json_data=payload)
    
    async def remove_reaction(
        self,
        to: str,
        message_id: str
    ) -> Dict[str, Any]:
        """
        Remove reação de uma mensagem
        
        Args:
            to: Número do destinatário
            message_id: WAMID da mensagem
        
        Returns:
            Response da API
        """
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "reaction",
            "reaction": {
                "message_id": message_id,
                "emoji": ""  # String vazia remove a reação
            }
        }
        
        logger.info(f"Removendo reação da mensagem {message_id}")
        return await self._send_request("POST", "/messages", json_data=payload)
    
    # TEMPLATES
    
    async def send_template(
        self,
        to: str,
        template_name: str,
        language_code: str = "pt_BR",
        components: Optional[List[Dict[str, Any]]] = None,
        reply_to: Optional[str] = None,
        use_marketing_endpoint: bool = False
    ) -> Dict[str, Any]:
        """
        Envia mensagem template.

        use_marketing_endpoint: quando True, envia pelo endpoint MM Lite
        (/marketing_messages em vez de /messages) — mesmo schema de payload,
        delivery otimizado pra templates de categoria MARKETING. Só faz
        diferença de fato depois que a Business Manager aceitou os termos
        do MM Lite na Meta (ver GET /api/mmlite/status); antes disso a Meta
        aceita a chamada normalmente e ela se comporta como Cloud API padrão.
        """
        template_data = {
            "name": template_name,
            "language": {"code": language_code}
        }

        if components:
            template_data["components"] = components

        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "template",
            "template": template_data
        }

        if reply_to:
            payload["context"] = {"message_id": reply_to}

        endpoint = "/marketing_messages" if use_marketing_endpoint else "/messages"
        return await self._send_request("POST", endpoint, json_data=payload)
    
    # UPLOAD E DOWNLOAD DE MÍDIA
    
    async def upload_media(self, file_path: str, mime_type: str) -> Dict[str, Any]:
        """
        Faz upload de arquivo para WhatsApp Cloud API
        
        Args:
            file_path: Caminho do arquivo
            mime_type: Tipo MIME do arquivo
        
        Returns:
            {"id": "media_id"}
        """
        with open(file_path, "rb") as f:
            files = {
                "file": (Path(file_path).name, f, mime_type),
                "messaging_product": (None, "whatsapp")
            }
            
            return await self._send_request("POST", "/media", files=files)
    
    async def get_media_url(self, media_id: str) -> Dict[str, Any]:
        """
        Obtém URL temporária de download de uma mídia
        
        Args:
            media_id: ID da mídia
        
        Returns:
            {"url": "https://...", "mime_type": "...", "sha256": "...", "file_size": 12345}
        """
        url = f"{self.base_url}/{self.api_version}/{media_id}"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=self.headers)
            response.raise_for_status()
            return response.json()
    
    async def download_media(self, media_url: str, save_path: str) -> str:
        """
        Baixa mídia do WhatsApp
        
        Args:
            media_url: URL da mídia (obtida via get_media_url)
            save_path: Caminho para salvar o arquivo
        
        Returns:
            Caminho do arquivo salvo
        """
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(media_url, headers=self.headers)
            response.raise_for_status()
            
            async with aiofiles.open(save_path, 'wb') as f:
                await f.write(response.content)
            
            return save_path
    
    # MARCAR COMO LIDA
    
    async def mark_as_read(self, message_id: str, typing_indicator: bool = False) -> Dict[str, Any]:
        """
        Marca mensagem como lida e, opcionalmente, mostra o indicador de "digitando..."
        no cliente do usuário (dura até 25s ou até a resposta ser enviada).

        Args:
            message_id: WAMID da mensagem
            typing_indicator: Se True, exibe o indicador de digitação junto com a leitura

        Returns:
            Response da API
        """
        payload = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id
        }

        if typing_indicator:
            payload["typing_indicator"] = {"type": "text"}

        return await self._send_request("POST", "/messages", json_data=payload)
