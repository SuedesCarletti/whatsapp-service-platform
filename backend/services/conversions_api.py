"""
Meta Conversions API para eventos de conversão originados no WhatsApp
(action_source="business_messaging"). Manda sinais de negócio (pedido no
catálogo, Flow completado, clique em botão de template MARKETING) pro
Business Manager, pra alimentar a otimização de campanhas de anúncio —
é o pedaço "tracking de conversão nativo" da MM Lite que faltava.

Pixel ID + token vêm do SystemConfig global (mesma tela "App Meta" onde
fica o FB_APP_ID) — configure em Configurações → App Meta antes de usar.
Sem essas duas credenciais configuradas, send_conversion_event() é um
no-op silencioso (só loga), pra não quebrar o fluxo normal de mensagens
enquanto o Pixel não existir/não estiver configurado.

NÃO live-testado ainda contra um Pixel real — a estrutura do payload
segue a doc oficial da Meta pra Business Messaging Conversions API, mas
só pode ser confirmada com um Pixel/token reais.
"""
import hashlib
import logging
import os
import time
from typing import Any, Dict, Optional

import httpx
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

CLOUD_API_VERSION = os.getenv("CLOUD_API_VERSION", "v23.0")


def _hash_phone(wa_id: str) -> str:
    """SHA256 do telefone em E.164 sem '+', só dígitos, conforme exigido pela Meta."""
    digits = "".join(ch for ch in wa_id if ch.isdigit())
    return hashlib.sha256(digits.encode("utf-8")).hexdigest()


# A Meta só aceita estes dois event_name pra action_source=business_messaging
# (confirmado ao vivo — qualquer outro valor, incluindo "Lead"/"CompleteRegistration",
# volta 400 "Evento de mensagem com tipo de evento inválido").
VALID_EVENT_NAMES = {"Purchase", "LeadSubmitted"}


async def send_conversion_event(
    db: Session,
    event_name: str,
    wa_id: str,
    ctwa_clid: Optional[str] = None,
    custom_data: Optional[Dict[str, Any]] = None,
    event_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Manda um evento de conversão pro Meta Pixel via Conversions API.

    event_name: só "Purchase" ou "LeadSubmitted" são aceitos pela Meta
    pra action_source=business_messaging — ver VALID_EVENT_NAMES.
    wa_id: número do contato (com DDI, só dígitos) — vira o "ph" hasheado.
    ctwa_clid: click id do anúncio "click to WhatsApp", se disponível.
    event_id: opcional, pra deduplicar se o mesmo evento também for
    reportado por outro canal (ex: Pixel do site).

    Retorna a resposta da Meta, ou None se não configurado/erro (nunca
    levanta exceção — conversão é um "extra", não pode derrubar o fluxo
    principal de mensagens).
    """
    if event_name not in VALID_EVENT_NAMES:
        logger.warning(
            "[ConversionsAPI] event_name '%s' inválido pra business_messaging — "
            "use um de %s. Evento não enviado.", event_name, VALID_EVENT_NAMES,
        )
        return None

    from backend.api.routes_templates import _load_config

    config = _load_config(db)
    pixel_id = config.meta_pixel_id
    token = config.meta_conversions_api_token
    page_id = config.meta_page_id

    if not pixel_id or not token:
        logger.info(
            "[ConversionsAPI] Pixel/token não configurados (Configurações → App Meta) "
            "— evento '%s' não enviado (isso é esperado até o Pixel ser configurado).",
            event_name,
        )
        return None

    if not page_id and not ctwa_clid:
        # Confirmado ao vivo: a Meta rejeita TODO evento business_messaging/
        # whatsapp sem page_id OU ctwa_clid (erro 2804069, "page_id ausente")
        # — exigência dela pra atribuir o evento a uma campanha de anúncio
        # "clique para WhatsApp". Sem um dos dois, o envio sempre falharia
        # com 400 — evita a chamada à toa e deixa claro o motivo no log.
        logger.info(
            "[ConversionsAPI] Nem page_id nem ctwa_clid disponíveis — a Meta exige "
            "pelo menos um dos dois pra eventos business_messaging/whatsapp. Configure "
            "meta_page_id em Configurações → App Meta (se o negócio rodar anúncios "
            "'clique para WhatsApp' a partir de uma Página). Evento '%s' não enviado.",
            event_name,
        )
        return None

    user_data: Dict[str, Any] = {"ph": [_hash_phone(wa_id)]}
    if page_id:
        user_data["page_id"] = page_id
    if ctwa_clid:
        user_data["ctwa_clid"] = ctwa_clid

    event: Dict[str, Any] = {
        "event_name": event_name,
        "event_time": int(time.time()),
        "action_source": "business_messaging",
        "messaging_channel": "whatsapp",
        "user_data": user_data,
    }
    if custom_data:
        event["custom_data"] = custom_data
    if event_id:
        event["event_id"] = event_id

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{CLOUD_API_VERSION}/{pixel_id}/events",
                params={"access_token": token},
                json={"data": [event]},
            )
            resp.raise_for_status()
            data = resp.json()
            logger.info("[ConversionsAPI] Evento '%s' enviado (wa_id=%s...): %s", event_name, wa_id[:6], data)
            return data
    except httpx.HTTPStatusError as exc:
        logger.warning("[ConversionsAPI] Falha ao enviar evento '%s': %s", event_name, exc.response.text[:300])
        return None
    except Exception as exc:
        logger.warning("[ConversionsAPI] Erro inesperado ao enviar evento '%s': %s", event_name, exc)
        return None
