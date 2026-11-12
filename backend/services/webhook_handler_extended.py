"""
Webhook Handler Estendido - Processar Mensagens Avançadas
Inclui: Orders, Referrals, System Messages, Flow Responses
"""
import json
import logging
from typing import Dict, Any
from sqlalchemy.orm import Session
from datetime import datetime

from backend.models.database_models import (
    Message, MessageType, Direction, MessageStatus, CatalogOrder
)
from backend.services.conversation_service import conversation_service
from backend.api.websocket import ws_manager

logger = logging.getLogger(__name__)


class WebhookHandlerExtended:
    """
    Extensão do WebhookHandler para processar tipos avançados de mensagens
    """
    
    async def process_order_message(
        self,
        db: Session,
        msg: Dict[str, Any],
        wa_id: str,
        wamid: str,
        timestamp: int,
        contact_name: str,
        account_id: int = None
    ):
        """
        Processa mensagem de pedido (order)
        
        Recebido quando cliente faz pedido via catálogo
        """
        try:
            order_data = msg.get("order", {})
            catalog_id = order_data.get("catalog_id")
            product_items = order_data.get("product_items", [])
            order_text = msg.get("text", "")
            
            logger.info("=" * 70)
            logger.info("PEDIDO RECEBIDO")
            logger.info(f"   Catálogo: {catalog_id}")
            logger.info(f"   Itens: {len(product_items)}")
            
            # Calcular total
            total = sum(
                item.get("item_price", 0) * item.get("quantity", 1)
                for item in product_items
            )
            
            # Formatar mensagem legível
            items_text = "\n".join([
                f"• {item.get('quantity')}x {item.get('product_retailer_id')} - R$ {item.get('item_price', 0):.2f}"
                for item in product_items
            ])
            
            message_text = f"🛒 PEDIDO RECEBIDO\n\n{items_text}\n\nTotal: R$ {total:.2f}"
            if order_text:
                message_text += f"\n\nObservações: {order_text}"
            
            # Salvar no banco
            contact = conversation_service.get_or_create_contact(
                db=db,
                wa_id=wa_id,
                phone_number=wa_id,
                name=contact_name
            )
            
            conversation = conversation_service.get_or_create_conversation(
                db=db,
                contact_id=contact.id,
                account_id=account_id
            )

            message = Message(
                wamid=wamid,
                conversation_id=conversation.id,
                contact_id=contact.id,
                message_type=MessageType.TEXT,  # Salvar como texto formatado
                direction=Direction.INBOUND,
                message_text=message_text,
                status=MessageStatus.DELIVERED,
                timestamp=timestamp
            )
            
            db.add(message)
            db.commit()
            db.refresh(message)

            logger.info(f"   Pedido salvo (ID: {message.id})")

            # Estruturado, além do texto formatado acima — antes catalog_id/
            # itens/total só existiam no payload transiente do WebSocket,
            # sem tabela pra consultar depois (ex.: fluxo de fulfillment).
            catalog_order = CatalogOrder(
                message_id=message.id,
                conversation_id=conversation.id,
                contact_id=contact.id,
                catalog_id=catalog_id,
                product_items=product_items,
                total=total,
                notes=order_text or None,
            )
            db.add(catalog_order)
            db.commit()
            logger.info(f"   CatalogOrder salvo (ID: {catalog_order.id})")

            # Sinal de conversão pro Business Manager (Meta Pixel/Conversions
            # API) — pedido no catálogo é o sinal de "compra" mais próximo que
            # a plataforma capta hoje. No-op silencioso se Pixel não configurado.
            from backend.services.conversions_api import send_conversion_event
            await send_conversion_event(
                db=db,
                event_name="Purchase",
                wa_id=wa_id,
                event_id=f"order-{catalog_order.id}",
                custom_data={"currency": "BRL", "value": total},
            )

            # Emitir via WebSocket
            await ws_manager.broadcast_new_message({
                "wamid": wamid,
                "type": "order",
                "direction": "inbound",
                "from_number": wa_id,
                "contact_name": contact_name,
                "message": message_text,
                "timestamp": timestamp,
                "status": "delivered",
                "sender": "contact",
                "conversation_id": conversation.id,
                "order_data": {
                    "id": catalog_order.id,
                    "catalog_id": catalog_id,
                    "items": product_items,
                    "total": total
                }
            })
            
            logger.info("   WebSocket emitido: new_message (order)")
            logger.info("=" * 70)
        
        except Exception as e:
            logger.error(f"Erro ao processar pedido: {e}", exc_info=True)
    
    async def process_referral_message(
        self,
        db: Session,
        msg: Dict[str, Any],
        wa_id: str,
        wamid: str,
        timestamp: int,
        contact_name: str,
        account_id: int = None
    ):
        """
        Processa mensagem de referência (referral)
        
        Recebido quando cliente vem de anúncio/post do Facebook/Instagram
        """
        try:
            referral_data = msg.get("referral", {})
            source_url = referral_data.get("source_url", "")
            source_type = referral_data.get("source_type", "")
            source_id = referral_data.get("source_id", "")
            headline = referral_data.get("headline", "")
            body = referral_data.get("body", "")
            
            logger.info("=" * 70)
            logger.info("REFERRAL RECEBIDO")
            logger.info(f"   Tipo: {source_type}")
            logger.info(f"   URL: {source_url}")
            logger.info(f"   ID: {source_id}")
            
            # Formatar mensagem legível
            message_text = f"📢 Cliente veio de: {source_type.upper()}\n\n"
            
            if headline:
                message_text += f"Anúncio: {headline}\n"
            if body:
                message_text += f"Descrição: {body}\n"
            
            message_text += f"\nURL: {source_url}"
            
            # Salvar no banco
            contact = conversation_service.get_or_create_contact(
                db=db,
                wa_id=wa_id,
                phone_number=wa_id,
                name=contact_name
            )
            
            conversation = conversation_service.get_or_create_conversation(
                db=db,
                contact_id=contact.id,
                account_id=account_id
            )

            message = Message(
                wamid=wamid,
                conversation_id=conversation.id,
                contact_id=contact.id,
                message_type=MessageType.TEXT,
                direction=Direction.INBOUND,
                message_text=message_text,
                status=MessageStatus.DELIVERED,
                timestamp=timestamp
            )

            db.add(message)
            db.commit()
            db.refresh(message)

            logger.info(f"   Referral salvo (ID: {message.id})")
            
            # Emitir via WebSocket
            await ws_manager.broadcast_new_message({
                "wamid": wamid,
                "type": "referral",
                "direction": "inbound",
                "from_number": wa_id,
                "contact_name": contact_name,
                "message": message_text,
                "timestamp": timestamp,
                "status": "delivered",
                "sender": "contact",
                "conversation_id": conversation.id,
                "referral_data": referral_data
            })
            
            logger.info("   WebSocket emitido: new_message (referral)")
            logger.info("=" * 70)
        
        except Exception as e:
            logger.error(f"Erro ao processar referral: {e}", exc_info=True)
    
    async def process_system_message(
        self,
        db: Session,
        msg: Dict[str, Any],
        wa_id: str,
        wamid: str,
        timestamp: int,
        contact_name: str,
        account_id: int = None
    ):
        """
        Processa mensagem do sistema (system)
        
        Ex: customer_identity_changed, customer_number_change
        """
        try:
            system_data = msg.get("system", {})
            system_type = system_data.get("type", "")
            system_body = system_data.get("body", "")
            new_identity = system_data.get("identity", "")
            
            logger.info("=" * 70)
            logger.info("MENSAGEM DO SISTEMA")
            logger.info(f"   Tipo: {system_type}")
            logger.info(f"   Corpo: {system_body}")
            
            # Formatar mensagem legível
            message_text = f"⚙️ Sistema: {system_body}"
            
            if system_type == "customer_identity_changed" and new_identity:
                message_text += f"\n\nNovo WhatsApp ID: {new_identity}"
                
                # Atualizar WA ID do contato
                contact = conversation_service.get_or_create_contact(
                    db=db,
                    wa_id=new_identity,
                    phone_number=new_identity,
                    name=contact_name
                )
                logger.info(f"   Contato atualizado para novo WA ID: {new_identity}")
            else:
                contact = conversation_service.get_or_create_contact(
                    db=db,
                    wa_id=wa_id,
                    phone_number=wa_id,
                    name=contact_name
                )
            
            conversation = conversation_service.get_or_create_conversation(
                db=db,
                contact_id=contact.id,
                account_id=account_id
            )

            message = Message(
                wamid=wamid,
                conversation_id=conversation.id,
                contact_id=contact.id,
                message_type=MessageType.TEXT,
                direction=Direction.INBOUND,
                message_text=message_text,
                status=MessageStatus.DELIVERED,
                timestamp=timestamp
            )

            db.add(message)
            db.commit()
            db.refresh(message)

            logger.info(f"   Mensagem do sistema salva (ID: {message.id})")
            
            # Emitir via WebSocket
            await ws_manager.broadcast_new_message({
                "wamid": wamid,
                "type": "system",
                "direction": "inbound",
                "from_number": wa_id,
                "contact_name": contact_name,
                "message": message_text,
                "timestamp": timestamp,
                "status": "delivered",
                "sender": "system",
                "conversation_id": conversation.id,
                "system_data": system_data
            })
            
            logger.info("   WebSocket emitido: new_message (system)")
            logger.info("=" * 70)
        
        except Exception as e:
            logger.error(f"Erro ao processar mensagem do sistema: {e}", exc_info=True)
    
    async def process_flow_response(
        self,
        db: Session,
        msg: Dict[str, Any],
        wa_id: str,
        wamid: str,
        timestamp: int,
        contact_name: str,
        account_id: int = None
    ):
        """
        Processa resposta de Flow (formulário interativo)
        
        Recebido quando cliente submete formulário
        """
        try:
            interactive_data = msg.get("interactive", {})
            flow_type = interactive_data.get("type")
            
            if flow_type == "nfm_reply":  # Native Flow Message Reply
                nfm_reply = interactive_data.get("nfm_reply", {})
                response_json = nfm_reply.get("response_json", "{}")

                # response_json é o texto cru que a Meta manda — nele (não num
                # campo nfm_reply.flow_token separado, que não existe de
                # verdade no payload) é que vem tudo que o Flow devolveu,
                # inclusive o flow_token, se a gente decidiu ecoar ele de volta.
                try:
                    response_data = json.loads(response_json) if isinstance(response_json, str) else (response_json or {})
                except (TypeError, ValueError):
                    response_data = {}

                flow_token = nfm_reply.get("flow_token") or response_data.get("flow_token", "")

                logger.info("=" * 70)
                logger.info("RESPOSTA DE FLOW RECEBIDA")
                logger.info(f"   Flow Token: {flow_token}")
                logger.info(f"   Dados: {response_json[:200] if isinstance(response_json, str) else response_json}")

                # Formatar mensagem legível — campo por campo, não um JSON cru
                display_fields = {k: v for k, v in response_data.items() if k != "flow_token"}
                if display_fields:
                    fields_text = "\n".join(f"• {k}: {v}" for k, v in display_fields.items())
                else:
                    fields_text = "(sem dados)"
                message_text = f"📋 Formulário submetido\n\n{fields_text}"
                
                # Salvar no banco
                contact = conversation_service.get_or_create_contact(
                    db=db,
                    wa_id=wa_id,
                    phone_number=wa_id,
                    name=contact_name
                )
                
                conversation = conversation_service.get_or_create_conversation(
                    db=db,
                    contact_id=contact.id,
                    account_id=account_id
                )

                message = Message(
                    wamid=wamid,
                    conversation_id=conversation.id,
                    contact_id=contact.id,
                    message_type=MessageType.INTERACTIVE,
                    direction=Direction.INBOUND,
                    message_text=message_text,
                    status=MessageStatus.DELIVERED,
                    timestamp=timestamp
                )
                
                db.add(message)
                db.commit()
                db.refresh(message)
                
                logger.info(f"   Resposta de Flow salva (ID: {message.id})")
                
                # Emitir via WebSocket
                await ws_manager.broadcast_new_message({
                    "wamid": wamid,
                    "type": "flow_response",
                    "direction": "inbound",
                    "from_number": wa_id,
                    "contact_name": contact_name,
                    "message": message_text,
                    "timestamp": timestamp,
                    "status": "delivered",
                    "sender": "contact",
                    "conversation_id": conversation.id,
                    "flow_data": {
                        "flow_token": flow_token,
                        "response_json": response_json
                    }
                })
                
                logger.info("   WebSocket emitido: new_message (flow_response)")
                logger.info("=" * 70)
        
        except Exception as e:
            logger.error(f"Erro ao processar resposta de Flow: {e}", exc_info=True)


# Instância global
webhook_extended = WebhookHandlerExtended()
