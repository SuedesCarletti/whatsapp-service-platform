# backend/providers/venom_provider.py
"""
Provider Venom — Node.js Puppeteer/WebSocket (não-oficial).
Bridge na porta 3002.

Venom é mais estável que o whatsapp-web.js para múltiplas sessões.
"""
import os
import logging
import httpx
from typing import Dict, Any, List, Optional

from .base_provider import BaseWhatsAppProvider, ProviderType, ProviderTier, ProviderRisk

logger = logging.getLogger(__name__)

_DISCLAIMER = (
    "⚠️ Não-oficial. Pode violar Termos de Serviço do WhatsApp. "
    "Conta pode ser banida. Use ciente do risco."
)


class VenomProvider(BaseWhatsAppProvider):
    """
    Provider Venom-Bot — Node.js + WebSocket/Puppeteer.
    Requer QR Code de sessão para autenticar.
    Suporte a múltiplas sessões simultâneas.
    """

    REQUIRES_SESSION_QR = True

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.provider_type = ProviderType.VENOM
        self.provider_tier = ProviderTier.FREE
        self.risk_level    = ProviderRisk.HIGH
        self.is_official   = False

        bridge_host = config.get("bridge_host") or os.getenv("VENOM_BRIDGE_HOST", "http://localhost")
        bridge_port = config.get("bridge_port") or os.getenv("VENOM_BRIDGE_PORT", "3002")
        self.bridge_url = f"{bridge_host}:{bridge_port}"
        self.session_id = config.get("session_id", "default")

    # ── Autenticação / QR ────────────────────────────────

    async def initialize_session(self) -> Dict[str, Any]:
        """Inicia/retoma sessão no bridge Venom."""
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    f"{self.bridge_url}/session/init",
                    json={"session_id": self.session_id}
                )
                resp.raise_for_status()
                return resp.json()
        except httpx.ConnectError:
            return {
                "status": "bridge_offline",
                "error": "Serviço Venom não está rodando. Execute: cd services/venom-bridge && node index.js",
                "bridge_url": self.bridge_url,
            }
        except Exception as exc:
            logger.exception("[Venom] Erro ao inicializar sessão")
            return {"status": "error", "error": str(exc)}

    async def get_session_qr(self) -> Dict[str, Any]:
        """Retorna QR Code de sessão para exibir em Settings → Contas WA."""
        result = await self.initialize_session()

        if result.get("status") == "qr_required":
            return {
                "type": "session_qr",
                "requires_scan": True,
                "provider": "venom",
                "qr_base64": result.get("qr"),
                "qr_string": result.get("qr_string"),
                "expires_in_seconds": 60,
                "instructions": [
                    "Abra o WhatsApp no celular",
                    "Toque em Menu (⋮) → Dispositivos vinculados",
                    "Toque em 'Vincular dispositivo'",
                    "Escaneie este QR Code",
                ],
            }

        if result.get("status") == "authenticated":
            return {
                "type": "session_qr",
                "requires_scan": False,
                "authenticated": True,
                "provider": "venom",
                "phone": result.get("phone"),
            }

        return {
            "type": "session_qr",
            "requires_scan": False,
            "authenticated": False,
            "provider": "venom",
            "status": result.get("status"),
            "error": result.get("error"),
        }

    async def get_qr_code(self) -> Optional[Dict]:
        return await self.get_session_qr()

    async def get_session_status(self) -> Dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(
                    f"{self.bridge_url}/session/status",
                    params={"session_id": self.session_id}
                )
                resp.raise_for_status()
                return resp.json()
        except httpx.ConnectError:
            return {"status": "bridge_offline", "authenticated": False}
        except Exception as exc:
            return {"status": "error", "error": str(exc), "authenticated": False}

    async def logout_session(self) -> Dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{self.bridge_url}/session/logout",
                    json={"session_id": self.session_id}
                )
                resp.raise_for_status()
            return {"success": True}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def is_authenticated(self) -> bool:
        status = await self.get_session_status()
        return status.get("authenticated", False)

    # ── Envio de Mensagens ───────────────────────────────

    async def _bridge(self, endpoint: str, payload: Dict) -> Dict[str, Any]:
        # Antes lançava RuntimeError em erro HTTP/conexão — como nenhuma rota
        # chamadora captura isso, virava um "Internal Server Error" genérico
        # sem detalhe nenhum. Devolver um dict (igual ao _bridge_post do
        # Baileys) deixa o erro real visível na resposta da API.
        payload["session_id"] = self.session_id
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(f"{self.bridge_url}{endpoint}", json=payload)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    return {"success": False, "error": f"Resposta inesperada do bridge: {data!r}"}
                return data
        except httpx.ConnectError:
            return {"success": False, "error": "Bridge Venom offline. Execute: cd services/venom-bridge && node index.js"}
        except httpx.HTTPStatusError as exc:
            return {"success": False, "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def send_text(self, to: str, text: str) -> Dict[str, Any]:
        return await self._bridge("/send/text", {"to": to, "text": text})

    async def send_text_message(self, to: str, text: str, reply_to: Optional[str] = None, **_kwargs) -> Dict[str, Any]:
        """Alias de compatibilidade — routes.py chama send_text_message() genericamente
        para qualquer provider (é o nome usado por BaileysProvider); sem este alias,
        o endpoint /api/send/text (o principal usado pela UI) quebrava com
        AttributeError em vez do erro real do bug de envio do Venom."""
        return await self.send_text(to, text)

    async def send_image(self, to: str, image_url: str, caption: str = "") -> Dict[str, Any]:
        return await self._bridge("/send/image", {"to": to, "url": image_url, "caption": caption})

    async def send_video(self, to: str, video_url: str, caption: str = "") -> Dict[str, Any]:
        return await self._bridge("/send/video", {"to": to, "url": video_url, "caption": caption})

    async def send_audio(self, to: str, audio_url: str) -> Dict[str, Any]:
        return await self._bridge("/send/audio", {"to": to, "url": audio_url})

    async def send_document(self, to: str, doc_url: str, filename: str = "") -> Dict[str, Any]:
        return await self._bridge("/send/document", {"to": to, "url": doc_url, "filename": filename})

    async def send_location(self, to: str, lat: float, lng: float, name: str = "") -> Dict[str, Any]:
        return await self._bridge("/send/location", {"to": to, "lat": lat, "lng": lng, "name": name})

    async def send_template(self, to: str, template_name: str, language: str, components: List[Dict]) -> Dict[str, Any]:
        logger.warning("[Venom] Templates Meta não suportados. Enviando como texto.")
        return await self.send_text(to, f"*{template_name}*")

    # ── Metadados ────────────────────────────────────────

    def get_features(self) -> List[str]:
        return [
            "Gratuito — sem custo por mensagem",
            "Autenticação via QR Code (WhatsApp Web)",
            "Múltiplas sessões simultâneas",
            "Texto, imagens, vídeos, áudio, documentos",
            "Grupos e broadcasts",
            "Mais estável que whatsapp-web.js",
            "Reconexão automática",
            "💡 Sem aprovação de templates necessária",
        ]

    def get_warnings(self) -> List[str]:
        return [
            _DISCLAIMER,
            "❌ Sem suporte a templates oficiais Meta",
            "❌ Sem analytics avançado",
            "⚠️ Requer Chrome/Puppeteer no servidor (modo headless)",
            "⚠️ Consumo de memória maior (Puppeteer)",
            "⚠️ Sessão expira se celular ficar offline",
            "🔧 Requer bridge Node.js rodando (services/venom-bridge/)",
        ]

    def get_setup_steps(self) -> List[str]:
        return [
            "1. Instale Node.js 18+ e Google Chrome no servidor",
            "2. cd services/venom-bridge && npm install",
            "3. node index.js  (inicia bridge na porta 3002)",
            "4. Configure VENOM_BRIDGE_HOST no .env",
            "5. Settings → Contas WA → Adicionar → Venom",
            "6. Escaneie o QR Code com o celular",
            "7. Sessão autenticada!",
        ]

    VENOM_PAIRING_CODE_METHOD = """
        async def request_pairing_code(self, phone_number: str) -> Dict[str, Any]:
            \"\"\"
            Solicita código de pareamento via número de telefone (Venom).
            \"\"\"
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    resp = await client.post(
                        f"{self.bridge_url}/session/pairing-code",
                        json={"session_id": self.session_id, "phone_number": phone_number}
                    )
                    resp.raise_for_status()
                    data = resp.json()
     
                if data.get("code"):
                    code = data["code"]
                    if "-" not in code and len(code) == 8:
                        code = f"{code[:4]}-{code[4:]}"
                    return {"success": True, "code": code, "expires_in": 60}
     
                return {"success": False, "error": data.get("error", "Código não retornado")}
     
            except httpx.ConnectError:
                return {"success": False, "error": "Bridge Venom offline."}
            except Exception as exc:
                return {"success": False, "error": str(exc)}
    """
