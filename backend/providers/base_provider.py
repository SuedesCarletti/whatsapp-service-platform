# backend/providers/base_provider.py
"""
Base para todos os providers WhatsApp.

Re-exporta ProviderType e ProviderTier de schemas_auth para que os providers
possam importar tudo de um único lugar (.base_provider).
"""
import logging
from abc import ABC, abstractmethod
from enum import Enum
from typing import Dict, Any, List, Optional

# Re-exporta enums centrais — providers usam: from .base_provider import ProviderType, ProviderTier
from backend.models.schemas_auth import ProviderType, ProviderTier

logger = logging.getLogger(__name__)


class ProviderRisk(str, Enum):
    NONE    = "none"     # Meta oficial — zero risco
    LOW     = "low"      # Baixo risco
    MEDIUM  = "medium"   # Risco médio
    HIGH    = "high"     # Alto risco (providers não-oficiais)


class BaseWhatsAppProvider(ABC):
    """
    Interface base para todos os providers WhatsApp.
    Todo provider (Meta Cloud, Baileys, Venom, WPPConnect) herda desta classe.
    """

    REQUIRES_SESSION_QR: bool = False   # True = provider não-oficial que precisa escanear QR

    def __init__(self, config: Dict[str, Any]):
        self.config        = config
        self.provider_type = None
        self.provider_tier = None
        self.risk_level    = ProviderRisk.NONE
        self.is_official   = True

    # ── Autenticação ─────────────────────────────────────────

    async def is_authenticated(self) -> bool:
        return False

    async def get_qr_code(self) -> Optional[Dict]:
        return None

    async def get_session_qr(self) -> Dict[str, Any]:
        """Retorna dados de QR de sessão. Sobrescreva em providers não-oficiais."""
        return {
            "type":          "session_qr",
            "requires_scan": False,
            "authenticated": await self.is_authenticated(),
            "provider":      str(self.provider_type),
        }

    async def get_session_status(self) -> Dict[str, Any]:
        """Retorna status atual da sessão."""
        return {
            "status":        "unknown",
            "authenticated": await self.is_authenticated(),
        }

    async def request_pairing_code(self, phone_number: str) -> Dict[str, Any]:
        """Solicita código de pareamento por número. Sobrescreva em Baileys."""
        return {
            "success": False,
            "error":   f"Provider {self.provider_type} não suporta pairing code",
        }

    async def logout_session(self) -> Dict[str, Any]:
        return {"success": True}

    async def initialize_session(self) -> Dict[str, Any]:
        return {"status": "not_implemented"}

    # ── Envio de mensagens ────────────────────────────────────

    @abstractmethod
    async def send_text(self, to: str, text: str) -> Dict[str, Any]:
        raise NotImplementedError

    async def send_image(self, to: str, image_url: str, caption: str = "") -> Dict[str, Any]:
        raise NotImplementedError

    async def send_video(self, to: str, video_url: str, caption: str = "") -> Dict[str, Any]:
        raise NotImplementedError

    async def send_audio(self, to: str, audio_url: str) -> Dict[str, Any]:
        raise NotImplementedError

    async def send_document(self, to: str, doc_url: str, filename: str = "") -> Dict[str, Any]:
        raise NotImplementedError

    async def send_location(self, to: str, lat: float, lng: float, name: str = "") -> Dict[str, Any]:
        raise NotImplementedError

    async def send_template(self, to: str, template_name: str, language: str, components: List[Dict]) -> Dict[str, Any]:
        raise NotImplementedError

    # ── Metadados ─────────────────────────────────────────────

    def get_features(self) -> List[str]:
        return []

    def get_warnings(self) -> List[str]:
        return []

    def get_setup_steps(self) -> List[str]:
        return []

    def get_info(self) -> Dict[str, Any]:
        return {
            "provider_type": str(self.provider_type),
            "provider_tier": str(self.provider_tier),
            "risk_level":    str(self.risk_level),
            "is_official":   self.is_official,
            "requires_qr":   self.REQUIRES_SESSION_QR,
            "features":      self.get_features(),
            "warnings":      self.get_warnings(),
        }
