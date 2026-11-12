# backend/providers/factory.py
"""
Factory central para instanciar providers não-oficiais (baileys/venom/
wppconnect/whatsapp_web_js) a partir do provider_type salvo na conta.

Usada tanto pelo fluxo de envio de mensagem (routes.py) quanto pelo fluxo
de sessão/QR (routes_settings.py), para que os dois nunca fiquem
dessincronizados sobre qual classe corresponde a qual provider_type.
"""
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from .base_provider import BaseWhatsAppProvider

UNOFFICIAL_PROVIDER_TYPES = {"baileys", "venom", "wppconnect", "whatsapp_web_js"}


def normalize_provider_type(raw: Any) -> str:
    """Normaliza provider_type para string simples, aceitando tanto o Enum
    quanto sua repr (ex.: "ProviderType.BAILEYS" -> "baileys")."""
    return str(raw).lower().split(".")[-1]


def get_unofficial_provider(provider_str: str, config: Dict[str, Any]) -> BaseWhatsAppProvider:
    """Instancia o provider não-oficial correto a partir da string salva em provider_type."""
    if provider_str == "baileys":
        from .baileys_provider import BaileysProvider
        return BaileysProvider(config)
    if provider_str == "venom":
        from .venom_provider import VenomProvider
        return VenomProvider(config)
    if provider_str == "wppconnect":
        from .wppconnect_provider import WPPConnectProvider
        return WPPConnectProvider(config)
    if provider_str == "whatsapp_web_js":
        from .whatsapp_web_js_provider import WhatsAppWebJsProvider
        return WhatsAppWebJsProvider(config)
    raise ValueError(f"Provider não-oficial desconhecido: {provider_str}")


def split_bridge_url(url: str) -> Tuple[str, Optional[str]]:
    """Quebra uma URL completa de bridge (ex.: "http://meu-servidor:21465")
    em (bridge_host, bridge_port) no formato que os *Provider.__init__ leem
    — bridge_host inclui o esquema ("http://meu-servidor"), bridge_port é só
    o número da porta."""
    parts = urlsplit(url if "://" in url else f"http://{url}")
    scheme = parts.scheme or "http"
    hostname = parts.hostname or "localhost"
    port = parts.port
    return f"{scheme}://{hostname}", (str(port) if port else None)
