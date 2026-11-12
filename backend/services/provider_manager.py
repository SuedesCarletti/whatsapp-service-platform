# backend/services/provider_manager.py
"""
ProviderManager — Gerenciador central de providers WhatsApp

Responsável por:
  - Registrar providers por account_id
  - Rotear chamadas para o provider correto
  - Abstrair diferenças entre Meta Cloud API e providers não-oficiais
"""
import logging
from typing import Dict, Any, Optional, List
from backend.models.schemas_auth import ProviderType

logger = logging.getLogger(__name__)


# BASE PROVIDER

class BaseProvider:
    """Interface base para todos os providers"""

    def __init__(self, account_id: str, config: Dict[str, Any]):
        self.account_id = account_id
        self.config = config

    async def is_authenticated(self) -> bool:
        return False

    async def get_qr_code(self) -> Optional[str]:
        return None

    async def send_message(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError

    def get_info(self) -> Dict[str, Any]:
        return {"account_id": self.account_id, "type": "base"}


# META CLOUD PROVIDERS  (oficiais — zero risco)

class MetaCloudProvider(BaseProvider):
    """
    Provider para Meta WhatsApp Business Cloud API.
    Cobre: meta_cloud_basic, meta_cloud_coexistence,
           meta_cloud_mmlite, meta_cloud_full
    """

    PROVIDER_INFO = {
        ProviderType.META_CLOUD_BASIC: {
            "name": "Meta Cloud API — Starter",
            "tier": "starter",
            "risk": "zero",
            "monthly_cost": "R$ 0-299",
            "is_official": True,
            "requires_qr": False,
            "features": [
                "Mensagens de texto",
                "Mídias (imagens, vídeos, documentos)",
                "Templates",
                "Webhooks em tempo real",
                "API oficial Meta",
            ],
            "warnings": [],
        },
        ProviderType.META_CLOUD_COEXISTENCE: {
            "name": "Meta Coexistence — Business",
            "tier": "business",
            "risk": "zero",
            "monthly_cost": "R$ 299-499",
            "is_official": True,
            "requires_qr": False,
            "features": [
                "Tudo do Starter",
                "App WhatsApp Business no celular simultâneo",
                "Coexistência API + App",
            ],
            "warnings": [],
        },
        ProviderType.META_CLOUD_MMLITE: {
            "name": "Meta MM Lite — Professional",
            "tier": "professional",
            "risk": "zero",
            "monthly_cost": "R$ 399-599",
            "is_official": True,
            "requires_qr": False,
            "features": [
                "Tudo do Business",
                "Marketing Messages Lite",
                "Campanhas de marketing",
                "Alto volume de envios",
            ],
            "warnings": [],
        },
        ProviderType.META_CLOUD_FULL: {
            "name": "Meta Full Stack — Enterprise",
            "tier": "enterprise",
            "risk": "zero",
            "monthly_cost": "R$ 599+",
            "is_official": True,
            "requires_qr": False,
            "features": [
                "Tudo do Professional",
                "App + API simultâneos",
                "Marketing completo",
                "Suporte prioritário",
            ],
            "warnings": [],
        },
    }

    def __init__(self, account_id: str, provider_type: ProviderType, config: Dict[str, Any]):
        super().__init__(account_id, config)
        self.provider_type = provider_type
        self.phone_number_id = config.get("phone_number_id") or config.get("meta_phone_number_id")
        self.access_token = config.get("access_token") or config.get("meta_access_token")

    async def is_authenticated(self) -> bool:
        """Meta Cloud API é considerada autenticada se token + phone_number_id presentes"""
        return bool(self.phone_number_id and self.access_token)

    async def get_qr_code(self) -> Optional[str]:
        """Meta Cloud API não usa QR code"""
        return None

    def get_info(self) -> Dict[str, Any]:
        info = self.PROVIDER_INFO.get(self.provider_type, {})
        return {
            "account_id": self.account_id,
            "provider_type": self.provider_type,
            **info,
        }


# PROVIDERS NÃO-OFICIAIS  (risco alto — uso por conta própria)

class UnofficalProvider(BaseProvider):
    """
    Stub para providers não-oficiais (Baileys, Venom, WPPConnect, WWJS).
    Em produção, integraria com o servidor do provider via HTTP/WebSocket.
    """

    PROVIDER_INFO = {
        ProviderType.BAILEYS: {
            "name": "Baileys",
            "tier": "free",
            "risk": "alto",
            "monthly_cost": "Grátis",
            "is_official": False,
            "requires_qr": True,
            "features": ["Mensagens básicas", "QR Code auth", "Gratuito"],
            "warnings": ["Risco de banimento", "Não suportado pela Meta", "Sem garantias"],
        },
        ProviderType.VENOM: {
            "name": "Venom",
            "tier": "free",
            "risk": "alto",
            "monthly_cost": "Grátis",
            "is_official": False,
            "requires_qr": True,
            "features": ["Mensagens básicas", "QR Code auth"],
            "warnings": ["Risco de banimento", "Não suportado pela Meta"],
        },
        ProviderType.WHATSAPP_WEB_JS: {
            "name": "WhatsApp-Web.js",
            "tier": "free",
            "risk": "médio",
            "monthly_cost": "Grátis",
            "is_official": False,
            "requires_qr": True,
            "features": ["Mensagens básicas", "QR Code auth", "Ampla comunidade"],
            "warnings": ["Risco médio de banimento", "Não suportado pela Meta"],
        },
        ProviderType.WPPCONNECT: {
            "name": "WPPConnect",
            "tier": "free",
            "risk": "alto",
            "monthly_cost": "Grátis",
            "is_official": False,
            "requires_qr": True,
            "features": ["Mensagens básicas", "Servidor próprio", "QR Code auth"],
            "warnings": ["Risco de banimento", "Requer servidor dedicado"],
        },
    }

    def __init__(self, account_id: str, provider_type: ProviderType, config: Dict[str, Any]):
        super().__init__(account_id, config)
        self.provider_type = provider_type

    async def is_authenticated(self) -> bool:
        return False  # Requer QR code

    async def get_qr_code(self) -> Optional[str]:
        # Em produção, chamaria o servidor do provider para gerar QR
        logger.warning(f"[{self.provider_type}] QR code não implementado — requer servidor dedicado")
        return None

    def get_info(self) -> Dict[str, Any]:
        info = self.PROVIDER_INFO.get(self.provider_type, {})
        return {
            "account_id": self.account_id,
            "provider_type": self.provider_type,
            **info,
        }


# PROVIDER MANAGER

class ProviderManager:
    """
    Gerenciador central de providers.
    Mantém um registry em memória: account_id → provider instance.
    """

    def __init__(self):
        self._registry: Dict[str, BaseProvider] = {}

    # ── Tipos oficiais ──────────────────────────────────────
    OFFICIAL_TYPES = {
        ProviderType.META_CLOUD_BASIC,
        ProviderType.META_CLOUD_COEXISTENCE,
        ProviderType.META_CLOUD_MMLITE,
        ProviderType.META_CLOUD_FULL,
    }

    def register_provider(
        self,
        account_id: str,
        provider_type: ProviderType,
        config: Dict[str, Any],
    ) -> BaseProvider:
        """
        Instancia e registra o provider correto para a conta.
        Retorna a instância criada.
        """
        if provider_type in self.OFFICIAL_TYPES:
            instance = MetaCloudProvider(account_id, provider_type, config)
        else:
            instance = UnofficalProvider(account_id, provider_type, config)

        self._registry[account_id] = instance
        logger.info(f"Provider registrado: account={account_id} type={provider_type}")
        return instance

    def get_provider(self, account_id: str) -> Optional[BaseProvider]:
        """Retorna provider registrado ou None"""
        return self._registry.get(account_id)

    def unregister_provider(self, account_id: str) -> None:
        """Remove provider do registry"""
        self._registry.pop(account_id, None)
        logger.info(f"Provider removido: account={account_id}")

    def get_all_providers_info(self) -> List[Dict[str, Any]]:
        """Retorna info de todos os tipos de provider disponíveis"""
        all_info = []

        for pt, info in MetaCloudProvider.PROVIDER_INFO.items():
            all_info.append({"provider_type": pt, **info})

        for pt, info in UnofficalProvider.PROVIDER_INFO.items():
            all_info.append({"provider_type": pt, **info})

        return all_info

    def list_registered(self) -> List[str]:
        """Lista account_ids registrados"""
        return list(self._registry.keys())


# Singleton global
provider_manager = ProviderManager()
