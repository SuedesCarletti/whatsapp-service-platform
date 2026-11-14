import os
import hmac
import hashlib
import logging
import json
import base64 # <-- NEW IMPORT
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Header, Request # <-- ADD Request
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.services.whatsapp_service import WhatsAppService
from backend.api.routes import _resolve_account_id, get_provider
from backend.services.conversation_service import conversation_service
from backend.models.schemas import WooCommerceOrderWebhook
from backend.models.database_models import WooCommerceOrder # <-- Assuming model is imported/defined
from .conversation_service import ConversationService

logger = logging.getLogger(__name__)

# Instâncias de serviço
conversation_service = ConversationService()

# Router para endpoints WooCommerce
woocommerce_router = APIRouter(prefix="/woocommerce", tags=["WooCommerce"])


# UTILS: VALIDAR ASSINATURA

def verify_woocommerce_signature(
    body_bytes: bytes, 
    signature: str, 
    secret: str
) -> bool:
    """
    Verifica assinatura do webhook do WooCommerce
    
    WooCommerce usa: base64(HMAC-SHA256(secret, body))
    """
    if not secret:
        logger.warning("WOOCOMMERCE_WEBHOOK_SECRET não configurado. Assinatura ignorada.")
        return True
    
    try:
        # 1. Calcular HMAC-SHA256
        expected_hash = hmac.new(
            secret.encode('utf-8'),
            body_bytes,
            hashlib.sha256
        ).digest()
        
        # 2. Codificar em Base64
        expected_signature = base64.b64encode(expected_hash).decode('utf-8')
        
        # 3. Comparar de forma segura
        is_valid = hmac.compare_digest(expected_signature, signature)
        
        if not is_valid:
            logger.error(f"Assinatura WooCommerce inválida!")
            logger.debug(f"   Esperado: {expected_signature[:20]}...")
            logger.debug(f"   Recebido: {signature[:20]}...")
        
        return is_valid
    
    except Exception as e:
        logger.error(f"Erro ao verificar assinatura WooCommerce: {e}")
        return False


# WEBHOOK DO WOOCOMMERCE

@woocommerce_router.post("/webhook/order")
async def woocommerce_order_webhook(
    request: Request,  # ADICIONAR Request para ler body
    x_wc_webhook_signature: Optional[str] = Header(None),
    db: Session = Depends(get_db)
):
    """
    Recebe webhooks do WooCommerce quando um pedido é criado/atualizado
    """
    try:
        # 1. Ler body como bytes
        body_bytes = await request.body()
        
        # 2. Validar assinatura
        woo_secret = os.getenv("WOOCOMMERCE_WEBHOOK_SECRET")
        
        if woo_secret and x_wc_webhook_signature:
            if not verify_woocommerce_signature(
                body_bytes, 
                x_wc_webhook_signature, 
                woo_secret
            ):
                logger.error("Assinatura inválida do webhook WooCommerce")
                raise HTTPException(status_code=403, detail="Invalid signature")
        
        # 3. Parsear JSON
        payload = json.loads(body_bytes.decode('utf-8'))
        
        if 'id' not in payload or 'status' not in payload:
            logger.warning("Payload WooCommerce inválido: faltando ID ou Status")
            return {"status": "ignored", "message": "Missing ID or Status"}

        # Extrair dados do pedido
        order_id = payload.get("id")
        status = payload.get("status")
        total = payload.get("total")
        
        billing = payload.get("billing", {})
        customer_name = f"{billing.get('first_name', '')} {billing.get('last_name', '')}".strip()
        customer_phone = billing.get("phone", "").strip()
        customer_email = billing.get("email", "")
        
        line_items = payload.get("line_items", [])
        
        logger.info(f"ィ Pedido WooCommerce recebido: #{order_id} - Status: {status}")
        
        # 4. Salvar ou atualizar pedido no banco
        
        contact = None
        clean_phone = None
        if customer_phone:
            clean_phone = WhatsAppService.validate_phone_number(customer_phone)
            contact = conversation_service.get_or_create_contact(
                db, clean_phone, clean_phone, customer_name
            )

        order = db.query(WooCommerceOrder).filter(
            WooCommerceOrder.order_id == order_id
        ).first()

        if order:
            logger.info(f"↩Atualizando pedido existente #{order_id}")
            order.order_status = status
            order.order_total = total
            order.customer_name = customer_name
            order.customer_email = customer_email
            order.customer_phone = clean_phone
            order.contact_id = contact.id if contact else None
        else:
            logger.info(f"Criando novo registro de pedido #{order_id}")
            order = WooCommerceOrder(
                order_id=order_id,
                contact_id=contact.id if contact else None,
                order_status=status,
                order_total=total,
                customer_name=customer_name,
                customer_email=customer_email,
                customer_phone=clean_phone,
                whatsapp_notification_sent=False
            )
            db.add(order)
        
        db.commit()
        db.refresh(order)
        
        # 5. Enviar notificação via WhatsApp (se status for relevante)
        if clean_phone and status in ["processing", "completed"] and not order.whatsapp_notification_sent:
            await send_order_notification(db, clean_phone, order_id, status, line_items)
            
            # Marcar como enviado
            order.whatsapp_notification_sent = True
            db.commit()
        
        return {"status": "success", "order_id": order_id}
    
    except json.JSONDecodeError:
        logger.error("Erro de decodificação JSON no payload WooCommerce")
        raise HTTPException(status_code=400, detail="Invalid JSON payload")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro ao processar webhook WooCommerce: {e}", exc_info=True)
        # Retorna 200 para evitar que o WooCommerce tente novamente infinitamente
        return {"status": "error", "order_id": payload.get("id"), "message": str(e)}


# NOTIFICAÇÕES (restante do arquivo)

async def send_order_notification(
    db: Session,
    phone: str,
    order_id: int,
    status: str,
    line_items: list
):
    """
    Envia notificação de pedido via WhatsApp

    Args:
        db: Sessão do banco (necessária para resolver a conta remetente)
        phone: Telefone do cliente
        order_id: ID do pedido
        status: Status do pedido
        line_items: Itens do pedido
    """
    try:
        # Formatar mensagem
        message = format_order_message(order_id, status, line_items)

        # Enviar via WhatsApp
        clean_phone = WhatsAppService.validate_phone_number(phone)

        resolved_account_id = _resolve_account_id(db, None, clean_phone)
        provider, provider_kind = get_provider(db, resolved_account_id)
        
        # Opção 1: Mensagem de texto simples
        response = await provider.send_text_message(clean_phone, message)
        
        logger.info(f"Notificação de pedido enviada: #{order_id} para {phone}")
        return response
    
    except Exception as e:
        logger.error(f"Erro ao enviar notificação: {e}")
        raise


def format_order_message(order_id: int, status: str, line_items: list) -> str:
    """
    Formata mensagem de pedido
    
    Args:
        order_id: ID do pedido
        status: Status do pedido
        line_items: Itens do pedido
    
    Returns:
        Mensagem formatada
    """
    status_messages = {
        "pending": "⏳ Aguardando pagamento",
        "processing": "Pedido confirmado! Estamos preparando seu envio.",
        "on-hold": "⏸️ Pedido em espera",
        "completed": "🎉 Pedido entregue!",
        "cancelled": "❌ Pedido cancelado",
        "refunded": "💰 Pedido reembolsado",
        "failed": "⚠️ Falha no pagamento"
    }
    
    status_text = status_messages.get(status, f"Status: {status}")
    
    # Formatar itens
    items_text = ""
    for item in line_items[:5]:  # Limitar a 5 itens
        name = item.get("name", "")
        quantity = item.get("quantity", 1)
        items_text += f"• {quantity}x {name}\n"
    
    if len(line_items) > 5:
        items_text += f"• ... e mais {len(line_items) - 5} itens\n"
    
    # Montar mensagem
    message = f"""
*Atualização do Pedido #{order_id}*

{status_text}

*Itens do pedido:*
{items_text}

Para mais detalhes, acesse sua conta em nosso site.

Obrigado por comprar conosco! 💚
    """.strip()
    
    return message


# PLUGIN WORDPRESS/WOOCOMMERCE
"""
Para integrar com WooCommerce, você pode:

OPÇÃO 1: USAR WEBHOOKS (Recomendado)
- Configure webhooks no WooCommerce (acima)
- Mais simples e eficiente

OPÇÃO 2: CRIAR PLUGIN WORDPRESS
Crie um plugin que:
1. Adiciona botão WhatsApp nas páginas de produto
2. Envia dados do pedido para este backend
3. Permite chat direto do checkout

Exemplo de código PHP para o plugin:

```php
<?php
/**
 * Plugin Name: WhatsApp Chat Integration
 * Description: Integra WooCommerce com WhatsApp Chat
 * Version: 1.0
 */

// Adicionar botão WhatsApp na página do produto
add_action('woocommerce_after_add_to_cart_button', 'add_whatsapp_button');

function add_whatsapp_button() {
    global $product;
    $backend_url = 'https://seu-backend.railway.app';
    $product_name = $product->get_name();
    $product_url = get_permalink();
    
    echo '<a href="#" class="whatsapp-chat-button" 
          data-product-name="' . esc_attr($product_name) . '"
          data-product-url="' . esc_url($product_url) . '">
          💬 Falar sobre este produto
    </a>';
}

// Enviar dados do pedido para o backend
add_action('woocommerce_order_status_changed', 'send_order_to_backend', 10, 3);

function send_order_to_backend($order_id, $old_status, $new_status) {
    $order = wc_get_order($order_id);
    $backend_url = 'https://seu-backend.railway.app/woocommerce/webhook/order';
    
    $data = array(
        'id' => $order_id,
        'status' => $new_status,
        'total' => $order->get_total(),
        'billing' => array(
            'first_name' => $order->get_billing_first_name(),
            'last_name' => $order->get_billing_last_name(),
            'phone' => $order->get_billing_phone(),
            'email' => $order->get_billing_email()
        ),
        'line_items' => array()
    );
    
    foreach ($order->get_items() as $item) {
        $data['line_items'][] = array(
            'name' => $item->get_name(),
            'quantity' => $item->get_quantity()
        );
    }
    
    wp_remote_post($backend_url, array(
        'body' => json_encode($data),
        'headers' => array('Content-Type' => 'application/json')
    ));
}
```

INSTALAÇÃO DO PLUGIN:
1. Salve o código acima em: wp-content/plugins/whatsapp-chat/whatsapp-chat.php
2. Ative o plugin no WordPress Admin
3. Configure a URL do seu backend

"""

