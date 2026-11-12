"""
Rotas API Estendidas - Funcionalidades Avançadas do WhatsApp
Inclui: Flows, Carrinhos, QR Codes, Business Profile, Analytics
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional, List, Dict, Any # FIX: Adicionar Dict e Any
import logging

from backend.database.connection import get_db
from backend.database.models import WhatsAppAccount
from backend.services.whatsapp_service import WhatsAppService
from backend.services.whatsapp_service_extended import WhatsAppServiceExtended
from backend.services.conversation_service import conversation_service

from backend.api.routes import _resolve_account_id, _get_account, get_provider, _extract_wamid
from backend.api.routes_auth import get_current_user
from backend.api.permissions import user_has_permission

def get_whatsapp_extended(db: Session, account_id: Optional[int] = None) -> WhatsAppServiceExtended:
    account = _get_account(db, account_id)
    # _get_account(db, None) devolve "a primeira conta ativa", que pode ser
    # Baileys/Venom/etc (sem credencial Meta) se essa for a conta #1 no banco.
    # Essas rotas são todas específicas da Cloud API — sem account_id explícito,
    # refina pra primeira conta Meta ativa com credenciais, em vez de falhar.
    if account_id is None and not (account and account.meta_phone_number_id and account.meta_access_token):
        account = (
            db.query(WhatsAppAccount)
            .filter(
                WhatsAppAccount.is_active == True,
                WhatsAppAccount.provider_type.like("meta%"),
                WhatsAppAccount.meta_phone_number_id.isnot(None),
                WhatsAppAccount.meta_access_token.isnot(None),
            )
            .first()
        )
    if account and account.meta_phone_number_id and account.meta_access_token:
        return WhatsAppServiceExtended(
            phone_number_id=account.meta_phone_number_id,
            business_account_id=account.meta_business_account_id,
            access_token=account.meta_access_token,
        )
    raise ValueError(f"Não foi possível inicializar WhatsAppServiceExtended. Credenciais Meta ausentes para account_id={account_id}.")
from backend.models.schemas import APIResponse, SendCtaUrlButtonRequest # CORREÇÃO: Importar APIResponse de schemas.py
from backend.models.schemas_extended import (
    SendFlowMessage,
    SendCarouselMessage,
    SendLocationRequestMessage,
    SendCartMessage,
    CreateQRCodeRequest,
    UpdateQRCodeRequest,
    QRCodeResponse,
    ListQRCodesResponse,
    BusinessProfileUpdate,
    BusinessProfileResponse,
    AnalyticsRequest,
    AnalyticsResponse,
    RequestWelcomeMessage
    # APIResponse # Removido, importado acima
)

logger = logging.getLogger(__name__)

# Nenhuma rota aqui é webhook externo — todas antes disso não exigiam login
# nenhum (nem token válido), incluindo editar perfil do negócio na Meta,
# enviar carrinho/carrossel/flow e gerenciar QR codes.
router_extended = APIRouter(prefix="/api/extended", tags=["WhatsApp Advanced"], dependencies=[Depends(get_current_user)])


# FLOWS (FORMULÁRIOS INTERATIVOS)

@router_extended.post("/send/flow", response_model=APIResponse)
async def send_flow(
    flow: SendFlowMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_send_interactive"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Envia Flow (formulário interativo)
    
    **Exemplo:**
    ```json
    {
      "to": "5511999990001",
      "flow_id": "1234567890",
      "flow_cta": "Preencher Cadastro",
      "flow_action": "navigate",
      "flow_action_payload": {
        "screen": "WELCOME_SCREEN",
        "data": {"user_type": "new"}
      },
      "header_text": "Cadastro Completo",
      "body_text": "Preencha seus dados para continuar",
      "footer_text": "Leva apenas 2 minutos"
    }
    ```
    
    **Como criar Flows:**
    1. Acesse Meta Business Manager
    2. WhatsApp Manager > Flows
    3. Criar novo Flow com telas e campos
    4. Copiar o Flow ID
    """
    try:
        logger.info(f"Enviando Flow {flow.flow_id} para {flow.to}")
        
        acc_id = getattr(flow, "account_id", None)
        resolved_account_id = _resolve_account_id(db, acc_id, flow.to)
        whatsapp_extended = get_whatsapp_extended(db, resolved_account_id)
        
        api_response = await whatsapp_extended.send_flow(
            to=flow.to,
            flow_id=flow.flow_id,
            flow_cta=flow.flow_cta,
            flow_action=flow.flow_action,
            flow_action_payload=flow.flow_action_payload.dict(),
            body_text=flow.body_text,
            header_text=flow.header_text,
            footer_text=flow.footer_text,
            reply_to=flow.reply_to
        )
        
        wamid = api_response.get("messages", [{}])[0].get("id")
        
        # Salvar no banco
        contact = conversation_service.get_or_create_contact(db, flow.to, flow.to)
        conversation = conversation_service.get_or_create_conversation(db, contact.id, account_id=resolved_account_id)
        
        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"📋 {flow.body_text}\n\n[{flow.flow_cta}]"
        )
        
        return APIResponse(
            success=True,
            message="Flow enviado com sucesso",
            data={"message_id": wamid, "flow_id": flow.flow_id}
        )
    
    except Exception as e:
        logger.error(f"Erro ao enviar Flow: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router_extended.post("/send/carousel", response_model=APIResponse)
async def send_carousel(
    carousel: SendCarouselMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_send_products"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Envia mensagem de carrossel (2-10 cards horizontais)

    **Exemplo:**
```json
    {
      "to": "5511999990001",
      "cards": [
        {
          "id": "card_1",
          "header_type": "image",
          "header_media_id": "MEDIA_ID_123",
          "body_text": "iPhone 15 Pro",
          "footer_text": "R$ 7.999",
          "buttons": [
            {"type": "quick_reply", "text": "Comprar"}
          ]
        },
        {
          "id": "card_2",
          "header_type": "image",
          "header_media_id": "MEDIA_ID_456",
          "body_text": "Samsung S24 Ultra",
          "footer_text": "R$ 6.999",
          "buttons": [
            {"type": "quick_reply", "text": "Comprar"}
          ]
        }
      ]
    }
```
    """
    try:
        logger.info(f"Enviando carrossel com {len(carousel.cards)} cards")

        clean_number = WhatsAppService.validate_phone_number(carousel.to)
        resolved_account_id = _resolve_account_id(db, carousel.account_id, clean_number)
        whatsapp_extended = get_whatsapp_extended(db, resolved_account_id)

        # Formatar cards para API do WhatsApp
        formatted_cards = []
        for card in carousel.cards:
            formatted_card = {
                "card_index": card.id,
                "components": [
                    {
                        "type": "header",
                        "parameters": [
                            {
                                "type": card.header_type,
                                card.header_type: {"id": card.header_media_id}
                            }
                        ]
                    },
                    {
                        "type": "body",
                        "parameters": [{"type": "text", "text": card.body_text}]
                    }
                ]
            }

            if card.footer_text:
                formatted_card["components"].append({
                    "type": "footer",
                    "parameters": [{"type": "text", "text": card.footer_text}]
                })

            if card.buttons:
                formatted_card["components"].append({
                    "type": "button",
                    "sub_type": "quick_reply",
                    "index": 0,
                    "parameters": [
                        {
                            "type": "payload",
                            "payload": card.buttons[0].get("id", "btn_0")
                        }
                    ]
                })

            formatted_cards.append(formatted_card)

        api_response = await whatsapp_extended.send_carousel_message(
            to=clean_number,
            cards=formatted_cards
        )

        wamid = api_response.get("messages", [{}])[0].get("id")

        # Salvar no banco
        contact = conversation_service.get_or_create_contact(db, clean_number, clean_number)
        conversation = conversation_service.get_or_create_conversation(db, contact.id, account_id=resolved_account_id)

        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"Carrossel com {len(carousel.cards)} cards"
        )

        return APIResponse(
            success=True,
            message="Carrossel enviado com sucesso",
            data={"message_id": wamid, "cards_count": len(carousel.cards)}
        )

    except Exception as e:
        logger.error(f"Erro ao enviar carrossel: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router_extended.post("/send/location-request", response_model=APIResponse)
async def send_location_request(
    message: SendLocationRequestMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_send_location"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Solicita localização do usuário com botão

    **Exemplo:**
```json
    {
      "to": "5511999990001",
      "body_text": "Onde você está? Compartilhe sua localização"
    }
```
    """
    try:
        logger.info(f"Solicitando localização para {message.to}")

        clean_number = WhatsAppService.validate_phone_number(message.to)
        resolved_account_id = _resolve_account_id(db, message.account_id, clean_number)
        whatsapp_extended = get_whatsapp_extended(db, resolved_account_id)

        api_response = await whatsapp_extended.send_location_request(
            to=clean_number,
            body_text=message.body_text
        )

        wamid = api_response.get("messages", [{}])[0].get("id")

        # Salvar no banco
        contact = conversation_service.get_or_create_contact(db, clean_number, clean_number)
        conversation = conversation_service.get_or_create_conversation(db, contact.id, account_id=resolved_account_id)

        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="interactive",
            message_text=f"Solicitação de localização"
        )

        return APIResponse(
            success=True,
            message="Solicitação de localização enviada",
            data={"message_id": wamid}
        )

    except Exception as e:
        logger.error(f"Erro ao solicitar localização: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# CARRINHOS DE COMPRAS

@router_extended.post("/send/cart", response_model=APIResponse)
async def send_cart(
    cart: SendCartMessage,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "feature_send_products"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Envia carrinho de compras
    
    **Exemplo:**
    ```json
    {
      "to": "5511999990001",
      "catalog_id": "1234567890",
      "product_items": [
        {
          "product_retailer_id": "SKU001",
          "quantity": 2,
          "item_price": 99.90,
          "currency": "BRL"
        },
        {
          "product_retailer_id": "SKU002",
          "quantity": 1,
          "item_price": 149.90,
          "currency": "BRL"
        }
      ]
    }
    ```
    
    **Pré-requisitos:**
    - Catálogo configurado no Meta Commerce Manager
    - Produtos cadastrados com SKUs
    """
    try:
        logger.info(f"Enviando carrinho com {len(cart.product_items)} item(ns) para {cart.to}")

        clean_number = WhatsAppService.validate_phone_number(cart.to)
        resolved_account_id = _resolve_account_id(db, cart.account_id, clean_number)
        whatsapp_extended = get_whatsapp_extended(db, resolved_account_id)

        # Converter Pydantic models para dicts
        product_items = [item.dict() for item in cart.product_items]

        api_response = await whatsapp_extended.send_cart(
            to=clean_number,
            catalog_id=cart.catalog_id,
            product_items=product_items,
            reply_to=cart.reply_to
        )

        wamid = api_response.get("messages", [{}])[0].get("id")

        # Calcular total do carrinho
        total = sum(item.item_price * item.quantity for item in cart.product_items)

        # Salvar no banco
        contact = conversation_service.get_or_create_contact(db, clean_number, clean_number)
        conversation = conversation_service.get_or_create_conversation(db, contact.id, account_id=resolved_account_id)
        
        conversation_service.save_outbound_message(
            db=db,
            wamid=wamid,
            conversation_id=conversation.id,
            contact_id=contact.id,
            message_type="order",
            message_text=f"Carrinho: {len(cart.product_items)} itens - Total: R$ {total:.2f}"
        )
        
        return APIResponse(
            success=True,
            message="Carrinho enviado com sucesso",
            data={
                "message_id": wamid,
                "items_count": len(cart.product_items),
                "total": total
            }
        )
    
    except Exception as e:
        logger.error(f"Erro ao enviar carrinho: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# QR CODES

@router_extended.post("/qrcodes", response_model=QRCodeResponse)
async def create_qr_code(qr: CreateQRCodeRequest, account_id: Optional[int] = None, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_qr_manager"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Cria QR Code para iniciar conversa

    **Exemplo:**
    ```json
    {
      "prefilled_message": "Olá! Vim pelo QR Code",
      "generate_qr_image": "PNG"
    }
    ```

    **Retorna:**
    - `code`: ID do QR Code
    - `deep_link_url`: URL wa.me para compartilhar
    - `qr_image_url`: URL da imagem do QR Code (PNG ou SVG)

    **Uso:**
    1. Criar QR Code
    2. Baixar imagem
    3. Imprimir ou compartilhar
    4. Cliente escaneia e inicia conversa com mensagem pré-preenchida
    """
    try:
        logger.info(f"Criando QR Code: {qr.prefilled_message[:50]}")

        whatsapp_extended = get_whatsapp_extended(db, account_id)
        response = await whatsapp_extended.create_qr_code(
            prefilled_message=qr.prefilled_message,
            generate_qr_image=qr.generate_qr_image
        )

        return QRCodeResponse(**response)

    except Exception as e:
        logger.error(f"Erro ao criar QR Code: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router_extended.get("/qrcodes", response_model=ListQRCodesResponse)
async def list_qr_codes(account_id: Optional[int] = None, db: Session = Depends(get_db)):
    """
    Lista todos os QR Codes criados
    """
    try:
        logger.info("Listando QR Codes")
        whatsapp_extended = get_whatsapp_extended(db, account_id)
        response = await whatsapp_extended.list_qr_codes()
        return ListQRCodesResponse(**response)
    
    except Exception as e:
        logger.error(f"Erro ao listar QR Codes: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router_extended.get("/qrcodes/{qr_code_id}", response_model=QRCodeResponse)
async def get_qr_code(qr_code_id: str, account_id: Optional[int] = None, db: Session = Depends(get_db)):
    """
    Obtém detalhes de um QR Code específico
    """
    try:
        logger.info(f"Buscando QR Code: {qr_code_id}")
        whatsapp_extended = get_whatsapp_extended(db, account_id)
        response = await whatsapp_extended.get_qr_code(qr_code_id)
        return QRCodeResponse(**response)
    
    except Exception as e:
        logger.error(f"Erro ao buscar QR Code: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router_extended.patch("/qrcodes/{qr_code_id}", response_model=APIResponse)
async def update_qr_code(qr_code_id: str, qr: UpdateQRCodeRequest, account_id: Optional[int] = None, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_qr_manager"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Atualiza mensagem de um QR Code
    """
    try:
        logger.info(f"Atualizando QR Code: {qr_code_id}")

        whatsapp_extended = get_whatsapp_extended(db, account_id)
        await whatsapp_extended.update_qr_code(
            qr_code_id=qr_code_id,
            prefilled_message=qr.prefilled_message
        )

        return APIResponse(
            success=True,
            message="QR Code atualizado com sucesso"
        )

    except Exception as e:
        logger.error(f"Erro ao atualizar QR Code: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router_extended.delete("/qrcodes/{qr_code_id}", response_model=APIResponse)
async def delete_qr_code(qr_code_id: str, account_id: Optional[int] = None, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "feature_qr_manager"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Deleta QR Code
    """
    try:
        logger.info(f"Deletando QR Code: {qr_code_id}")
        whatsapp_extended = get_whatsapp_extended(db, account_id)
        await whatsapp_extended.delete_qr_code(qr_code_id)
        
        return APIResponse(
            success=True,
            message="QR Code deletado com sucesso"
        )
    
    except Exception as e:
        logger.error(f"Erro ao deletar QR Code: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# BUSINESS PROFILE

@router_extended.get("/business/profile", response_model=BusinessProfileResponse)
async def get_business_profile(account_id: Optional[int] = None, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "settings_business_profile"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Obtém perfil de negócio
    
    **Retorna:**
    - Informações públicas da empresa no WhatsApp
    - Foto de perfil, descrição, endereço, websites, etc
    """
    try:
        logger.info("Buscando perfil de negócio")
        whatsapp_extended = get_whatsapp_extended(db, account_id)
        response = await whatsapp_extended.get_business_profile()
        
        # A resposta vem dentro de data[0]
        profile_data = response.get("data", [{}])[0]
        
        return BusinessProfileResponse(**profile_data)
    
    except Exception as e:
        logger.error(f"Erro ao buscar perfil: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router_extended.patch("/business/profile", response_model=APIResponse)
async def update_business_profile(profile: BusinessProfileUpdate, account_id: Optional[int] = None, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    if not user_has_permission(db, current_user, "settings_business_profile"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Atualiza perfil de negócio
    
    **Exemplo:**
    ```json
    {
      "about": "Empresa líder em tecnologia",
      "address": "Rua Exemplo, 123 - São Paulo, SP",
      "description": "Soluções inovadoras para seu negócio",
      "email": "contato@empresa.com",
      "vertical": "RETAIL",
      "websites": [
        "https://empresa.com",
        "https://loja.empresa.com"
      ]
    }
    ```
    
    **Categorias (vertical):**
    - AUTOMOTIVE, BEAUTY, APPAREL, EDU, ENTERTAIN, EVENT_PLAN
    - FINANCE, GROCERY, GOVT, HOTEL, HEALTH, NONPROFIT
    - PROF_SERVICES, RETAIL, TRAVEL, RESTAURANT, NOT_A_BIZ
    """
    try:
        logger.info("Atualizando perfil de negócio")
        
        # Extrair apenas campos não-nulos
        update_data = profile.dict(exclude_none=True)
        
        if not update_data:
            raise HTTPException(
                status_code=400,
                detail="Pelo menos um campo deve ser fornecido"
            )

        whatsapp_extended = get_whatsapp_extended(db, account_id)
        await whatsapp_extended.update_business_profile(**update_data)
        
        return APIResponse(
            success=True,
            message="Perfil de negócio atualizado com sucesso",
            data=update_data
        )
    
    except Exception as e:
        logger.error(f"Erro ao atualizar perfil: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# REQUEST WELCOME MESSAGE

@router_extended.post("/request-welcome", response_model=APIResponse)
async def request_welcome(request: RequestWelcomeMessage, db: Session = Depends(get_db)):
    """
    Solicita que o cliente envie a primeira mensagem

    **Uso:**
    - Você tem o número do cliente mas ele ainda não iniciou conversa
    - Envia solicitação para que ele envie a primeira mensagem
    - Cliente recebe notificação no WhatsApp

    **Exemplo:**
    ```json
    {
      "to": "5511999990001"
    }
    ```

    **Limitações:**
    - Só funciona se o cliente ainda não enviou nenhuma mensagem
    - Máximo 1 solicitação por cliente a cada 24h
    """
    try:
        logger.info(f"Solicitando welcome para {request.to}")

        clean_number = WhatsAppService.validate_phone_number(request.to)
        resolved_account_id = _resolve_account_id(db, request.account_id, clean_number)
        whatsapp_extended = get_whatsapp_extended(db, resolved_account_id)

        api_response = await whatsapp_extended.request_welcome(to=clean_number)

        return APIResponse(
            success=True,
            message="Solicitação de boas-vindas enviada",
            data=api_response
        )

    except Exception as e:
        logger.error(f"Erro ao solicitar welcome: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# PHONE NUMBER INFO

@router_extended.get("/phone/info", response_model=APIResponse)
async def get_phone_info(account_id: Optional[int] = None, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """
    Obtém informações do número de telefone

    **Retorna:**
    - Quality rating (GREEN, YELLOW, RED)
    - Status de verificação
    - Número formatado
    - Limites de mensagens (tier)
    """
    if not user_has_permission(db, current_user, "settings_phone_quality"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para ver a qualidade do número.")
    try:
        logger.info("Buscando informações do número")
        whatsapp_extended = get_whatsapp_extended(db, account_id)
        response = await whatsapp_extended.get_phone_number_info()

        return APIResponse(
            success=True,
            data=response
        )

    except Exception as e:
        logger.error(f"Erro ao buscar info do número: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router_extended.get("/phone/list", response_model=APIResponse)
async def list_phone_numbers(account_id: Optional[int] = None, db: Session = Depends(get_db), current_user=Depends(get_current_user)):
    """
    Lista todos os números de telefone da conta
    """
    if not user_has_permission(db, current_user, "settings_phone_quality"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para ver a qualidade do número.")
    try:
        logger.info("Listando números de telefone")
        whatsapp_extended = get_whatsapp_extended(db, account_id)
        response = await whatsapp_extended.get_phone_numbers()

        return APIResponse(
            success=True,
            data=response.get("data", [])
        )

    except Exception as e:
        logger.error(f"Erro ao listar números: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ANALYTICS

@router_extended.post("/analytics")
async def get_conversation_analytics(
    request: AnalyticsRequest,
    account_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    if not user_has_permission(db, current_user, "settings_analytics"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para esta ação.")
    """
    Agrega analytics de conversas via WhatsApp Cloud API (conversation_analytics).

    ⚠️ A Meta bloqueou o acesso direto à página de referência durante esta correção,
    então a agregação abaixo (data_points -> conversations -> categoria/direção/custo)
    usa .get() defensivamente em todo canto e é best-effort: valide os números
    contra uma WABA real antes de depender deles para decisões de negócio.
    """
    try:
        whatsapp_extended = get_whatsapp_extended(db, account_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        raw = await whatsapp_extended.get_analytics(
            start=request.start,
            end=request.end,
            granularity=request.granularity,
            phone_numbers=request.phone_numbers,
            product_types=request.product_types,
            country_codes=request.country_codes,
        )
    except Exception as e:
        logger.error(f"Erro ao buscar analytics na Meta: {e}")
        raise HTTPException(status_code=502, detail=f"Erro ao buscar analytics: {e}")

    aggregated: Dict[str, Any] = {
        "messages": {"sent": 0, "delivered": 0, "read": 0, "failed": 0},
        "conversations": {"total": 0, "business_initiated": 0, "user_initiated": 0},
        "conversations_by_category": {"MARKETING": 0, "UTILITY": 0, "AUTHENTICATION": 0, "SERVICE": 0},
        "cost": {"total": 0.0, "per_conversation": 0.0},
    }

    data_points = (raw.get("data") or [{}])[0].get("data_points", [])

    for point in data_points:
        aggregated["messages"]["sent"] += point.get("sent", 0) or 0
        aggregated["messages"]["delivered"] += point.get("delivered", 0) or 0
        aggregated["messages"]["read"] += point.get("read", 0) or 0
        aggregated["messages"]["failed"] += point.get("failed", 0) or 0

        for conv in point.get("conversations", []) or []:
            aggregated["conversations"]["total"] += 1
            aggregated["cost"]["total"] += conv.get("cost", 0) or 0

            direction = conv.get("conversation_direction")
            if direction == "BUSINESS_INITIATED":
                aggregated["conversations"]["business_initiated"] += 1
            elif direction == "USER_INITIATED":
                aggregated["conversations"]["user_initiated"] += 1

            category = conv.get("conversation_category")
            if category in aggregated["conversations_by_category"]:
                aggregated["conversations_by_category"][category] += 1

    total_conversations = aggregated["conversations"]["total"]
    if total_conversations:
        aggregated["cost"]["per_conversation"] = aggregated["cost"]["total"] / total_conversations

    return {"success": True, "data": aggregated}
