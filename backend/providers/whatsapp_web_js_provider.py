# backend/providers/whatsapp_web_js_provider.py
"""
Provider WhatsApp-Web.js — Node.js Puppeteer/WebSocket (não-oficial).
Bridge na porta 3004.

whatsapp-web.js é a lib não-oficial mais usada pela comunidade, com boa
compatibilidade com o WhatsApp Web real (roda dentro de um Chromium de verdade).
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


class WhatsAppWebJsProvider(BaseWhatsAppProvider):
    """
    Provider whatsapp-web.js — Node.js + Puppeteer (Chromium real).
    Requer QR Code de sessão para autenticar.
    Suporte a múltiplas sessões simultâneas.
    """

    REQUIRES_SESSION_QR = True

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.provider_type = ProviderType.WHATSAPP_WEB_JS
        self.provider_tier = ProviderTier.FREE
        self.risk_level    = ProviderRisk.MEDIUM
        self.is_official   = False

        bridge_host = config.get("bridge_host") or os.getenv("WHATSAPP_WEB_JS_HOST", "http://localhost")
        bridge_port = config.get("bridge_port") or os.getenv("WHATSAPP_WEB_JS_PORT", "3004")
        self.bridge_url = f"{bridge_host}:{bridge_port}"
        self.session_id = config.get("session_id", "default")

    # ── Autenticação / QR ────────────────────────────────

    async def initialize_session(self) -> Dict[str, Any]:
        """Inicia/retoma sessão no bridge whatsapp-web.js."""
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
                "error": "Serviço whatsapp-web.js não está rodando. Execute: cd services/wa-web-bridge && node index.js",
                "bridge_url": self.bridge_url,
            }
        except Exception as exc:
            logger.exception("[WhatsAppWebJs] Erro ao inicializar sessão")
            return {"status": "error", "error": str(exc)}

    async def get_session_qr(self) -> Dict[str, Any]:
        """Retorna QR Code de sessão para exibir em Settings → Contas WA."""
        result = await self.initialize_session()

        if result.get("status") == "qr_required":
            return {
                "type": "session_qr",
                "requires_scan": True,
                "provider": "whatsapp_web_js",
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
                "provider": "whatsapp_web_js",
                "phone": result.get("phone"),
            }

        return {
            "type": "session_qr",
            "requires_scan": False,
            "authenticated": False,
            "provider": "whatsapp_web_js",
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
            return {"success": False, "error": "Bridge whatsapp-web.js offline. Execute: cd services/wa-web-bridge && node index.js"}
        except httpx.HTTPStatusError as exc:
            return {"success": False, "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def send_text(self, to: str, text: str) -> Dict[str, Any]:
        return await self._bridge("/send/text", {"to": to, "text": text})

    async def send_text_message(self, to: str, text: str, reply_to: Optional[str] = None, **_kwargs) -> Dict[str, Any]:
        """Alias de compatibilidade — routes.py chama send_text_message() genericamente
        para qualquer provider (é o nome usado por BaileysProvider); sem este alias,
        o endpoint /api/send/text (o principal usado pela UI) quebra com
        AttributeError para este provider. `reply_to` ainda não é suportado aqui."""
        return await self.send_text(to, text)

    async def send_with_mentions(self, to: str, text: str, mentioned_jids: List[str], reply_to: Optional[str] = None) -> Dict[str, Any]:
        """@menções em grupo — mesmo fix de wppconnect_provider.py (routes_baileys.py
        chama isso genericamente pra qualquer provider "avançado")."""
        return await self._bridge("/send/text", {"to": to, "text": text, "mentions": mentioned_jids})

    # Mesmo fix de wppconnect_provider.py: aceita file_b64/mime_type (o único
    # jeito que a UI manda mídia, upload direto) além de url — o bridge
    # (wa-web-bridge/index.js) já aceita base64_data+mimetype nesses 4
    # endpoints, só o provider não expunha isso.
    async def send_image(self, to: str, image_url: str = "", caption: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None, reply_to: Optional[str] = None, reply_to_from_me: bool = False) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "caption": caption}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "image/jpeg"
        else:
            payload["url"] = image_url
        return await self._bridge("/send/image", payload)

    async def send_video(self, to: str, video_url: str = "", caption: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None, reply_to: Optional[str] = None, reply_to_from_me: bool = False) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "caption": caption}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "video/mp4"
        else:
            payload["url"] = video_url
        return await self._bridge("/send/video", payload)

    async def send_audio(self, to: str, audio_url: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None, reply_to: Optional[str] = None, reply_to_from_me: bool = False) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "audio/ogg; codecs=opus"
        else:
            payload["url"] = audio_url
        return await self._bridge("/send/audio", payload)

    async def send_document(self, to: str, doc_url: str = "", filename: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None, caption: str = "", reply_to: Optional[str] = None, reply_to_from_me: bool = False) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "filename": filename}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "application/octet-stream"
        else:
            payload["url"] = doc_url
        return await self._bridge("/send/document", payload)

    # Mesmo fix de wppconnect_provider.py: routes.py chama com latitude/
    # longitude/address/reply_to, não lat/lng antigos — TypeError silencioso
    # derrubava "enviar localização" com 500 pra contas whatsapp_web_js.
    async def send_location(self, to: str, latitude: float = None, longitude: float = None, name: str = "", address: str = "", reply_to: Optional[str] = None, lat: float = None, lng: float = None) -> Dict[str, Any]:
        full_name = f"{name} — {address}" if (name and address) else (name or address)
        return await self._bridge("/send/location", {"to": to, "lat": latitude if latitude is not None else lat, "lng": longitude if longitude is not None else lng, "name": full_name})

    # Mesmo fix de wppconnect_provider.py: routes.py chama com language_code=/
    # reply_to=, não `language`/nada.
    async def send_template(self, to: str, template_name: str, language_code: str = "", components: Optional[List[Dict]] = None, reply_to: Optional[str] = None) -> Dict[str, Any]:
        logger.warning("[WhatsAppWebJs] Templates Meta não suportados. Enviando como texto.")
        return await self.send_text(to, f"*{template_name}*")

    # ── Mensagens: reação, figurinha, gif, view-once, enquete, contato ────

    async def send_reaction(self, to: str, message_id: str, emoji: str, from_me: bool = False) -> Dict[str, Any]:
        return await self._bridge("/send/reaction", {"to": to, "message_id": message_id, "emoji": emoji, "from_me": from_me})

    async def remove_reaction(self, to: str, message_id: str) -> Dict[str, Any]:
        """Mesmo fix de wppconnect_provider.py: reagir com emoji vazio remove a reação."""
        return await self.send_reaction(to, message_id, emoji="")

    async def send_sticker(self, to: str, url: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None, reply_to: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "image/webp"
        else:
            payload["url"] = url
        return await self._bridge("/send/sticker", payload)

    async def send_gif(self, to: str, url: str = "", caption: str = "", file_b64: Optional[str] = None, reply_to: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "caption": caption}
        if file_b64:
            payload["base64_data"] = file_b64
        else:
            payload["url"] = url
        return await self._bridge("/send/gif", payload)

    async def send_view_once(self, to: str, media_type: str, url: str = "", caption: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "media_type": media_type, "caption": caption}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type
        else:
            payload["url"] = url
        return await self._bridge("/send/view-once", payload)

    async def send_poll(self, to: str, question: str, options: List[str], selectable_count: int = 1) -> Dict[str, Any]:
        return await self._bridge("/send/poll", {
            "to": to, "question": question, "options": options, "selectable_count": selectable_count,
        })

    async def send_contact_card(self, to: str, contacts: List[Dict[str, Any]]) -> Dict[str, Any]:
        return await self._bridge("/send/contact", {"to": to, "contacts": contacts})

    async def send_contacts(self, to: str, contacts: List[Dict[str, Any]], reply_to: Optional[str] = None) -> Dict[str, Any]:
        return await self._bridge("/send/contact", {"to": to, "contacts": contacts})

    async def forward_message(self, to: str, message_id: str, from_jid: str) -> Dict[str, Any]:
        return await self._bridge("/send/forward", {"to": to, "message_id": message_id, "from_jid": from_jid})

    async def edit_message(self, to: str, message_id: str, new_text: str) -> Dict[str, Any]:
        return await self._bridge("/message/edit", {"to": to, "message_id": message_id, "new_text": new_text})

    async def delete_message(self, to: str, message_id: str, for_everyone: bool = True) -> Dict[str, Any]:
        return await self._bridge("/message/delete", {"to": to, "message_id": message_id, "for_everyone": for_everyone})

    async def mark_read(self, jid: str, message_id: str, participant_jid: Optional[str] = None) -> Dict[str, Any]:
        return await self._bridge("/message/read", {"jid": jid, "message_id": message_id, "participant_jid": participant_jid})

    async def pin_message(self, to: str, message_id: str, duration: int = 604800) -> Dict[str, Any]:
        return await self._bridge("/message/pin", {"to": to, "message_id": message_id, "duration": duration})

    async def star_message(self, to: str, message_id: str, starred: bool = True) -> Dict[str, Any]:
        return await self._bridge("/message/star", {"to": to, "message_id": message_id, "starred": starred})

    # ── Gerenciamento de grupos ───────────────────────────

    async def group_create(self, subject: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge("/group/create", {"subject": subject, "participants": participants})

    async def group_participants_add(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge("/group/participants/add", {"group_jid": group_jid, "participants": participants})

    async def group_participants_remove(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge("/group/participants/remove", {"group_jid": group_jid, "participants": participants})

    async def group_admins_promote(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge("/group/admins/promote", {"group_jid": group_jid, "participants": participants})

    async def group_admins_demote(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge("/group/admins/demote", {"group_jid": group_jid, "participants": participants})

    async def group_subject_update(self, group_jid: str, subject: str) -> Dict[str, Any]:
        return await self._bridge("/group/subject", {"group_jid": group_jid, "subject": subject})

    async def group_description_update(self, group_jid: str, description: str) -> Dict[str, Any]:
        return await self._bridge("/group/description", {"group_jid": group_jid, "description": description})

    async def group_leave(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge("/group/leave", {"group_jid": group_jid})

    async def group_invite_code_get(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge("/group/invite-code", {"group_jid": group_jid})

    async def group_invite_code_revoke(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge("/group/invite-code/revoke", {"group_jid": group_jid})

    async def group_metadata_get(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge("/group/metadata", {"group_jid": group_jid})

    async def group_get_join_requests(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge("/group/join-requests", {"group_jid": group_jid})

    async def group_update_join_request(self, group_jid: str, participants: list, action: str) -> Dict[str, Any]:
        return await self._bridge("/group/join-requests/update", {
            "group_jid": group_jid, "participants": participants, "action": action
        })

    async def group_join_via_link(self, invite_link: str) -> Dict[str, Any]:
        return await self._bridge("/group/join", {"invite_link": invite_link})

    async def group_set_announce(self, group_jid: str, announce: bool) -> Dict[str, Any]:
        return await self._bridge("/group/announce", {"group_jid": group_jid, "announce": announce})

    async def group_set_disappearing(self, group_jid: str, duration: int) -> Dict[str, Any]:
        """Não suportado pela lib whatsapp-web.js (sem API de mensagens temporárias em grupo)."""
        return await self._bridge("/group/disappearing", {"group_jid": group_jid, "duration": duration})

    # ── Perfil e privacidade ──────────────────────────────

    async def get_profile_picture(self, jid: str, high_res: bool = False) -> Dict[str, Any]:
        return await self._bridge("/profile/picture", {"jid": jid, "high_res": high_res})

    async def update_profile_picture(self, image_b64: str) -> Dict[str, Any]:
        return await self._bridge("/profile/picture/update", {"image_b64": image_b64})

    async def remove_profile_picture(self) -> Dict[str, Any]:
        return await self._bridge("/profile/picture/remove", {})

    async def update_status(self, status: str) -> Dict[str, Any]:
        return await self._bridge("/profile/status", {"status": status})

    async def update_profile_name(self, name: str) -> Dict[str, Any]:
        return await self._bridge("/profile/name", {"name": name})

    async def get_user_status(self, jid: str) -> Dict[str, Any]:
        return await self._bridge("/profile/get-status", {"jid": jid})

    async def check_phone_exists(self, phone: str) -> Dict[str, Any]:
        return await self._bridge("/contact/check", {"phone": phone})

    async def block_contact(self, jid: str) -> Dict[str, Any]:
        return await self._bridge("/contact/block", {"jid": jid})

    async def unblock_contact(self, jid: str) -> Dict[str, Any]:
        return await self._bridge("/contact/unblock", {"jid": jid})

    async def get_blocklist(self) -> Dict[str, Any]:
        return await self._bridge("/contact/blocklist", {})

    async def get_business_profile(self, jid: str) -> Dict[str, Any]:
        return await self._bridge("/contact/business-profile", {"jid": jid})

    # ── Privacidade (não suportado pela lib) ──────────────

    async def fetch_privacy_settings(self) -> Dict[str, Any]:
        return await self._bridge("/privacy/settings", {})

    async def update_privacy_setting(self, setting: str, value: str) -> Dict[str, Any]:
        return await self._bridge("/privacy/update", {"setting": setting, "value": value})

    # ── Presença ──────────────────────────────────────────

    async def send_presence(self, to: str, presence_type: str) -> Dict[str, Any]:
        return await self._bridge("/presence/send", {"to": to, "type": presence_type})

    async def subscribe_presence(self, jid: str) -> Dict[str, Any]:
        """Não suportado pela lib whatsapp-web.js (só há assinatura de presença para canais)."""
        return await self._bridge("/presence/subscribe", {"jid": jid})

    # ── Gerenciamento de chats ────────────────────────────

    async def chat_delete(self, jid: str) -> Dict[str, Any]:
        return await self._bridge("/chat/delete", {"jid": jid})

    async def archive_chat(self, jid: str, archive: bool = True) -> Dict[str, Any]:
        return await self._bridge("/chat/archive", {"jid": jid, "archive": archive})

    async def mute_chat(self, jid: str, duration_ms: Optional[int] = None) -> Dict[str, Any]:
        return await self._bridge("/chat/mute", {"jid": jid, "duration_ms": duration_ms})

    async def pin_chat(self, jid: str, pinned: bool = True) -> Dict[str, Any]:
        return await self._bridge("/chat/pin", {"jid": jid, "pinned": pinned})

    async def set_disappearing_messages(self, jid: str, duration: int) -> Dict[str, Any]:
        """Não suportado pela lib whatsapp-web.js (sem API dedicada para chats 1:1)."""
        return await self._bridge("/chat/disappearing", {"jid": jid, "duration": duration})

    # ── Metadados ────────────────────────────────────────

    def get_features(self) -> List[str]:
        return [
            "✅ Gratuito — sem custo por mensagem",
            "✅ Autenticação via QR Code (WhatsApp Web)",
            "✅ Múltiplas sessões simultâneas",
            "✅ Texto, imagens, vídeos, áudio, documentos",
            "✅ Grupos e broadcasts",
            "✅ Ampla comunidade e documentação",
            "✅ Reconexão automática",
        ]

    def get_warnings(self) -> List[str]:
        return [
            _DISCLAIMER,
            "❌ Sem suporte a templates oficiais Meta",
            "❌ Sem analytics avançado",
            "⚠️ Requer Chrome/Chromium no servidor (modo headless)",
            "⚠️ Consumo de memória maior (Puppeteer)",
            "⚠️ Sessão expira se celular ficar offline",
            "🔧 Requer bridge Node.js rodando (services/wa-web-bridge/)",
        ]

    def get_setup_steps(self) -> List[str]:
        return [
            "1. Instale Node.js 18+ e Google Chrome no servidor",
            "2. cd services/wa-web-bridge && npm install",
            "3. node index.js  (inicia bridge na porta 3004)",
            "4. Configure WHATSAPP_WEB_JS_HOST no .env",
            "5. Settings → Contas WA → Adicionar → WhatsApp-Web.js",
            "6. Escaneie o QR Code com o celular",
            "7. Sessão autenticada!",
        ]
