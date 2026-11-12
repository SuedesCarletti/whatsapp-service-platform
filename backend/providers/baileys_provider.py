# backend/providers/baileys_provider.py
"""
Provider Baileys — Node.js WebSocket (não-oficial).
Comunica com o micro-serviço baileys-bridge via HTTP.
Bridge padrão: porta 3001.
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

_QR_INSTRUCTIONS = [
    "Abra o WhatsApp no celular",
    "Toque em Menu (⋮) ou Configurações",
    "Toque em 'Dispositivos vinculados'",
    "Toque em 'Vincular dispositivo'",
    "Aponte a câmera para o QR Code",
]


class BaileysProvider(BaseWhatsAppProvider):
    """
    Provider Baileys — @whiskeysockets/baileys via Node.js WebSocket.
    Requer QR Code ou pairing code para autenticar a sessão.
    """

    REQUIRES_SESSION_QR = True

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.provider_type = ProviderType.BAILEYS
        self.provider_tier = ProviderTier.FREE
        self.risk_level    = ProviderRisk.HIGH
        self.is_official   = False

        bridge_host = config.get("bridge_host") or os.getenv("BAILEYS_BRIDGE_HOST", "http://localhost")
        bridge_port = config.get("bridge_port") or os.getenv("BAILEYS_BRIDGE_PORT", "3001")
        self.bridge_url = f"{bridge_host}:{bridge_port}"
        self.session_id = config.get("session_id", "default")

    # ── Autenticação / QR ────────────────────────────────

    async def initialize_session(self) -> Dict[str, Any]:
        """Inicia/retoma sessão no bridge Baileys via POST /session/init."""
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    f"{self.bridge_url}/session/init",
                    json={"session_id": self.session_id}
                )
                resp.raise_for_status()
                return resp.json()
        except httpx.ConnectError:
            logger.error("[Baileys] Bridge offline em %s", self.bridge_url)
            return {
                "status": "bridge_offline",
                "error":  f"Serviço Baileys não está rodando em {self.bridge_url}.",
                "bridge_url": self.bridge_url,
            }
        except Exception as exc:
            logger.exception("[Baileys] Erro ao inicializar sessão")
            return {"status": "error", "error": str(exc)}

    async def get_session_qr(self) -> Dict[str, Any]:
        """
        Retorna QR Code de sessão para exibir em Settings → Contas WA.
        GET /session/qr no bridge auto-inicia sessão e aguarda QR (até 15 s).

        IMPORTANTE: retorna requires_scan=True quando QR está disponível
        para que o WhatsAppLinkPanel renderize a imagem corretamente.
        """
        try:
            async with httpx.AsyncClient(timeout=25.0) as client:
                resp = await client.get(
                    f"{self.bridge_url}/session/qr",
                    params={"session_id": self.session_id}
                )
                resp.raise_for_status()
                data = resp.json()

            status = data.get("status", "idle")

            if status == "authenticated":
                return {
                    "status":        "authenticated",
                    "authenticated": True,
                    "requires_scan": False,
                    "phone":         data.get("phone"),
                }

            if status == "qr_required" and (data.get("qr") or data.get("qr_string")):
                return {
                    "status":             "qr_required",
                    "authenticated":      False,
                    "requires_scan":      True,   # ← campo obrigatório para WhatsAppLinkPanel
                    "qr_base64":          data.get("qr"),
                    "qr_string":          data.get("qr_string"),
                    "expires_in_seconds": 60,
                    "instructions":       _QR_INSTRUCTIONS,
                }

            if status == "bridge_offline":
                return {
                    "status":        "bridge_offline",
                    "authenticated": False,
                    "requires_scan": False,
                    "error":         data.get("error", f"Bridge offline em {self.bridge_url}."),
                }

            # starting / idle / error
            return {
                "status":        status,
                "authenticated": False,
                "requires_scan": False,
                "error":         data.get("error"),
            }

        except httpx.ConnectError:
            logger.error("[Baileys] Bridge offline ao buscar QR: %s", self.bridge_url)
            return {
                "status":        "bridge_offline",
                "authenticated": False,
                "requires_scan": False,
                "error":         (
                    f"Bridge offline em {self.bridge_url}. "
                    "Verifique o serviço baileys-bridge no Railway."
                ),
            }
        except Exception as exc:
            logger.exception("[Baileys] Erro ao buscar QR")
            return {
                "status":        "error",
                "authenticated": False,
                "requires_scan": False,
                "error":         str(exc),
            }

    async def request_pairing_code(self, phone_number: str) -> Dict[str, Any]:
        """
        Alternativa ao QR Code — usuário recebe código de 8 dígitos no WhatsApp.
        Número DEVE estar em formato E.164 sem '+' (ex: 5544999990000).

        O bridge inicia uma sessão FRESCA para pairing code (sem gerar QR)
        e chama requestPairingCode durante o evento 'connecting', conforme
        a documentação do Baileys.
        """
        logger.info("[Baileys] Solicitando pairing code para '%s' bridge=%s session=%s",
                    phone_number, self.bridge_url, self.session_id)
        try:
            async with httpx.AsyncClient(timeout=35.0) as client:
                resp = await client.post(
                    f"{self.bridge_url}/session/pairing-code",
                    json={
                        "session_id":   self.session_id,
                        "phone_number": phone_number,
                    }
                )
                resp.raise_for_status()
                data = resp.json()

            logger.info("[Baileys] Resposta pairing code: %s", data)

            if data.get("code"):
                code = data["code"]
                if "-" not in code and len(code) == 8:
                    code = f"{code[:4]}-{code[4:]}"
                return {"success": True, "code": code, "expires_in": 60}

            return {
                "success": False,
                "error":   data.get("error", "Código não retornado pelo bridge"),
            }

        except httpx.ConnectError:
            return {
                "success": False,
                "error":   f"Bridge offline em {self.bridge_url}. Suba o serviço baileys-bridge no Railway.",
            }
        except httpx.HTTPStatusError as exc:
            return {
                "success": False,
                "error":   f"Bridge retornou HTTP {exc.response.status_code}: {exc.response.text[:100]}",
            }
        except Exception as exc:
            logger.exception("[Baileys] Erro inesperado ao solicitar pairing code")
            return {"success": False, "error": str(exc)}

    async def is_authenticated(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    f"{self.bridge_url}/session/status",
                    params={"session_id": self.session_id}
                )
                data = resp.json()
                return data.get("authenticated", False)
        except Exception:
            return False

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

    # ── Envio de mensagens ────────────────────────────────

    async def send_text(self, to: str, text: str, reply_to: Optional[str] = None, reply_to_from_me: bool = False) -> Dict[str, Any]:
        """Implementa BaseWhatsAppProvider.send_text (abstract)."""
        payload: Dict[str, Any] = {"to": to, "text": text, "preview_url": True}
        if reply_to:
            payload["reply_to"] = reply_to
            payload["reply_to_from_me"] = reply_to_from_me
        return await self._bridge_post("/send/text", payload)

    async def send_text_message(self, to: str, text: str, reply_to: Optional[str] = None, reply_to_from_me: bool = False) -> Dict[str, Any]:
        """Alias de compatibilidade → delega para send_text."""
        return await self.send_text(to, text, reply_to=reply_to, reply_to_from_me=reply_to_from_me)

    async def send_image(self, to: str, url: str = "", caption: str = "", reply_to: Optional[str] = None, reply_to_from_me: bool = False, file_b64: Optional[str] = None, mime_type: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "caption": caption}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "image/jpeg"
        else:
            payload["url"] = url
        if reply_to:
            payload["reply_to"] = reply_to
            payload["reply_to_from_me"] = reply_to_from_me
        return await self._bridge_post("/send/image", payload)

    async def send_video(self, to: str, video_url: str = "", caption: str = "", reply_to: Optional[str] = None, reply_to_from_me: bool = False, file_b64: Optional[str] = None, mime_type: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "caption": caption}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "video/mp4"
        else:
            payload["url"] = video_url
        if reply_to:
            payload["reply_to"] = reply_to
            payload["reply_to_from_me"] = reply_to_from_me
        return await self._bridge_post("/send/video", payload)

    async def send_document(self, to: str, url: str = "", filename: str = "arquivo", reply_to: Optional[str] = None, reply_to_from_me: bool = False, file_b64: Optional[str] = None, mime_type: Optional[str] = None, caption: str = "") -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "filename": filename, "caption": caption}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "application/octet-stream"
        else:
            payload["url"] = url
        if reply_to:
            payload["reply_to"] = reply_to
            payload["reply_to_from_me"] = reply_to_from_me
        return await self._bridge_post("/send/document", payload)

    async def send_audio(self, to: str, audio_url: str = "", reply_to: Optional[str] = None, reply_to_from_me: bool = False, file_b64: Optional[str] = None, mime_type: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "audio/ogg; codecs=opus"
        else:
            payload["url"] = audio_url
        if reply_to:
            payload["reply_to"] = reply_to
            payload["reply_to_from_me"] = reply_to_from_me
        return await self._bridge_post("/send/audio", payload)

    async def send_reaction(self, to: str, message_id: str, emoji: str, from_me: bool = False) -> Dict[str, Any]:
        return await self._bridge_post("/send/reaction", {
            "to": to, "message_id": message_id, "emoji": emoji, "from_me": from_me
        })

    async def send_location(
        self, 
        to: str, 
        latitude: float, 
        longitude: float, 
        name: Optional[str] = None, 
        address: Optional[str] = None, 
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        payload = {
            "to": to, 
            "latitude": latitude, 
            "longitude": longitude, 
            "name": name or ""
        }
        if address:
            payload["address"] = address
        if reply_to:
            payload["reply_to"] = reply_to
        return await self._bridge_post("/send/location", payload)

    async def send_sticker(self, to: str, url: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None, reply_to: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type or "image/webp"
        else:
            payload["url"] = url
        if reply_to:
            payload["reply_to"] = reply_to
        return await self._bridge_post("/send/sticker", payload)

    async def send_gif(self, to: str, url: str = "", caption: str = "", file_b64: Optional[str] = None, reply_to: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"to": to, "caption": caption, "gif_playback": True}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = "video/mp4"
        else:
            payload["url"] = url
        if reply_to:
            payload["reply_to"] = reply_to
        return await self._bridge_post("/send/gif", payload)

    async def send_view_once(self, to: str, media_type: str, url: str = "", caption: str = "", file_b64: Optional[str] = None, mime_type: Optional[str] = None) -> Dict[str, Any]:
        """Envia mídia que desaparece após visualização (view once)."""
        payload: Dict[str, Any] = {"to": to, "media_type": media_type, "caption": caption, "view_once": True}
        if file_b64:
            payload["base64_data"] = file_b64
            payload["mimetype"] = mime_type
        else:
            payload["url"] = url
        return await self._bridge_post("/send/view-once", payload)

    async def send_poll(self, to: str, question: str, options: List[str], selectable_count: int = 1) -> Dict[str, Any]:
        """Envia enquete com múltiplas opções."""
        return await self._bridge_post("/send/poll", {
            "to": to,
            "question": question,
            "options": options,
            "selectable_count": selectable_count,
        })

    async def send_contact_card(self, to: str, contacts: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Envia cartão(ões) de contato (vCard)."""
        return await self._bridge_post("/send/contact", {
            "to": to,
            "contacts": contacts,
        })
        
    async def send_contacts(
        self,
        to: str,
        contacts: List[Dict[str, Any]],
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        """Alias padronizado para compatibilidade com Meta Cloud API"""
        payload = {"to": to, "contacts": contacts}
        if reply_to:
            payload["reply_to"] = reply_to
        return await self._bridge_post("/send/contact", payload)

    async def send_interactive_buttons(
        self,
        to: str,
        body_text: str,
        buttons: List[Dict[str, str]],
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        reply_to: Optional[str] = None
    ) -> Dict[str, Any]:
        logger.warning("[Baileys] Botões interativos não suportados nativamente pelo WhatsApp Web.")
        return {"success": False, "error": "Botões interativos nativos não suportados pelo Baileys. Use a Meta Cloud API para esta funcionalidade."}
        
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
        logger.warning("[Baileys] Listas interativas não suportadas nativamente.")
        return {"success": False, "error": "Listas interativas não suportadas pelo Baileys."}

    async def send_with_mentions(self, to: str, text: str, mentioned_jids: List[str], reply_to: Optional[str] = None) -> Dict[str, Any]:
        """Envia mensagem de texto com @menções."""
        payload: Dict[str, Any] = {"to": to, "text": text, "mentions": mentioned_jids}
        if reply_to:
            payload["reply_to"] = reply_to
        return await self._bridge_post("/send/text", payload)

    async def forward_message(self, to: str, message_id: str, from_jid: str) -> Dict[str, Any]:
        """Encaminha mensagem existente."""
        return await self._bridge_post("/send/forward", {
            "to": to,
            "message_id": message_id,
            "from_jid": from_jid,
        })

    async def edit_message(self, to: str, message_id: str, new_text: str) -> Dict[str, Any]:
        """Edita texto de mensagem enviada."""
        return await self._bridge_post("/message/edit", {
            "to": to,
            "message_id": message_id,
            "new_text": new_text,
        })

    async def delete_message(self, to: str, message_id: str, for_everyone: bool = True) -> Dict[str, Any]:
        """Apaga mensagem (para todos ou só para mim)."""
        return await self._bridge_post("/message/delete", {
            "to": to,
            "message_id": message_id,
            "for_everyone": for_everyone,
        })

    async def mark_read(self, jid: str, message_id: str, participant_jid: Optional[str] = None) -> Dict[str, Any]:
        """Marca uma mensagem como lida usando sock.readMessages()"""
        return await self._bridge_post("/message/read", {
            "jid": jid,
            "message_id": message_id,
            "participant_jid": participant_jid,
        })

    async def pin_message(self, to: str, message_id: str, duration: int = 604800) -> Dict[str, Any]:
        """Fixa mensagem no chat. duration em segundos: 86400=24h, 604800=7d, 2592000=30d."""
        return await self._bridge_post("/message/pin", {
            "to": to,
            "message_id": message_id,
            "duration": duration,
        })

    async def star_message(self, to: str, message_id: str, starred: bool = True) -> Dict[str, Any]:
        """Marca/desmarca mensagem como favorita."""
        return await self._bridge_post("/message/star", {
            "to": to,
            "message_id": message_id,
            "starred": starred,
        })

    # ── Gerenciamento de grupos ───────────────────────────

    async def group_create(self, subject: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge_post("/group/create", {
            "subject": subject,
            "participants": participants,
        })

    async def group_participants_add(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge_post("/group/participants/add", {
            "group_jid": group_jid,
            "participants": participants,
        })

    async def group_participants_remove(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge_post("/group/participants/remove", {
            "group_jid": group_jid,
            "participants": participants,
        })

    async def group_admins_promote(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge_post("/group/admins/promote", {
            "group_jid": group_jid,
            "participants": participants,
        })

    async def group_admins_demote(self, group_jid: str, participants: List[str]) -> Dict[str, Any]:
        return await self._bridge_post("/group/admins/demote", {
            "group_jid": group_jid,
            "participants": participants,
        })

    async def group_subject_update(self, group_jid: str, subject: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/subject", {
            "group_jid": group_jid,
            "subject": subject,
        })

    async def group_description_update(self, group_jid: str, description: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/description", {
            "group_jid": group_jid,
            "description": description,
        })

    async def group_leave(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/leave", {"group_jid": group_jid})

    async def group_invite_code_get(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/invite-code", {"group_jid": group_jid})

    async def group_invite_code_revoke(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/invite-code/revoke", {"group_jid": group_jid})

    async def group_metadata_get(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/metadata", {"group_jid": group_jid})

    async def group_get_join_requests(self, group_jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/join-requests", {"group_jid": group_jid})

    async def group_update_join_request(self, group_jid: str, participants: list, action: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/join-requests/update", {
            "group_jid": group_jid, "participants": participants, "action": action
        })

    async def group_join_via_link(self, invite_link: str) -> Dict[str, Any]:
        return await self._bridge_post("/group/join", {"invite_link": invite_link})

    async def group_set_announce(self, group_jid: str, announce: bool) -> Dict[str, Any]:
        """Modo anúncio: True = apenas admins enviam, False = todos enviam."""
        return await self._bridge_post("/group/announce", {
            "group_jid": group_jid,
            "announce": announce,
        })

    async def group_set_disappearing(self, group_jid: str, duration: int) -> Dict[str, Any]:
        """Mensagens temporárias: 0=off, 86400=24h, 604800=7d, 7776000=90d."""
        return await self._bridge_post("/group/disappearing", {
            "group_jid": group_jid,
            "duration": duration,
        })

    # ── Perfil e privacidade ──────────────────────────────

    async def get_profile_picture(self, jid: str, high_res: bool = False) -> Dict[str, Any]:
        return await self._bridge_post("/profile/picture", {"jid": jid, "high_res": high_res})

    async def update_profile_picture(self, image_b64: str) -> Dict[str, Any]:
        return await self._bridge_post("/profile/picture/update", {"image_b64": image_b64})

    async def remove_profile_picture(self) -> Dict[str, Any]:
        return await self._bridge_post("/profile/picture/remove", {})

    async def update_status(self, status: str) -> Dict[str, Any]:
        return await self._bridge_post("/profile/status", {"status": status})

    async def update_profile_name(self, name: str) -> Dict[str, Any]:
        return await self._bridge_post("/profile/name", {"name": name})

    async def get_user_status(self, jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/profile/get-status", {"jid": jid})

    async def check_phone_exists(self, phone: str) -> Dict[str, Any]:
        """Verifica se número existe no WhatsApp."""
        return await self._bridge_post("/contact/check", {"phone": phone})

    async def block_contact(self, jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/contact/block", {"jid": jid})

    async def unblock_contact(self, jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/contact/unblock", {"jid": jid})

    async def get_blocklist(self) -> Dict[str, Any]:
        return await self._bridge_post("/contact/blocklist", {})

    async def get_business_profile(self, jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/contact/business-profile", {"jid": jid})

    # ── Privacidade ───────────────────────────────────────

    async def fetch_privacy_settings(self) -> Dict[str, Any]:
        return await self._bridge_post("/privacy/settings", {})

    async def update_privacy_setting(self, setting: str, value: str) -> Dict[str, Any]:
        """
        setting: last_seen | online | profile_photo | status | read_receipts | groups_add
        value: all | contacts | contact_blacklist | none (conforme disponibilidade)
        """
        return await self._bridge_post("/privacy/update", {"setting": setting, "value": value})

    # ── Presença ──────────────────────────────────────────

    async def send_presence(self, to: str, presence_type: str) -> Dict[str, Any]:
        """
        presence_type: available | unavailable | composing | paused | recording
        """
        return await self._bridge_post("/presence/send", {"to": to, "type": presence_type})

    async def subscribe_presence(self, jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/presence/subscribe", {"jid": jid})

    # ── Gerenciamento de chats ────────────────────────────

    async def chat_delete(self, jid: str) -> Dict[str, Any]:
        return await self._bridge_post("/chat/delete", {"jid": jid})

    async def archive_chat(self, jid: str, archive: bool = True) -> Dict[str, Any]:
        return await self._bridge_post("/chat/archive", {"jid": jid, "archive": archive})

    async def mute_chat(self, jid: str, duration_ms: Optional[int] = None) -> Dict[str, Any]:
        """duration_ms: None=desmutar, 28800000=8h, 604800000=7d."""
        return await self._bridge_post("/chat/mute", {"jid": jid, "duration_ms": duration_ms})

    async def pin_chat(self, jid: str, pinned: bool = True) -> Dict[str, Any]:
        return await self._bridge_post("/chat/pin", {"jid": jid, "pinned": pinned})

    async def set_disappearing_messages(self, jid: str, duration: int) -> Dict[str, Any]:
        """duration: 0=off, 86400=24h, 604800=7d, 7776000=90d."""
        return await self._bridge_post("/chat/disappearing", {"jid": jid, "duration": duration})

    async def send_template(self, to: str, template_name: str, language: str,
                            components: List[Dict]) -> Dict[str, Any]:
        logger.warning("[Baileys] Templates Meta não suportados nativamente.")
        return {"success": False, "error": "Templates Meta não suportados pelo Baileys."}

    async def _bridge_post(self, endpoint: str, payload: Dict) -> Dict[str, Any]:
        payload["session_id"] = self.session_id
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(f"{self.bridge_url}{endpoint}", json=payload)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    logger.warning(f"[Baileys] Bridge retornou resposta não-dict em {endpoint}: {data!r}")
                    return {"success": False, "error": f"Resposta inesperada do bridge: {data!r}"}
                return data
        except httpx.ConnectError:
            return {"success": False, "error": f"Bridge offline em {self.bridge_url}"}
        except httpx.HTTPStatusError as exc:
            return {"success": False, "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    # ── Metadados ─────────────────────────────────────────

    @property
    def display_name(self) -> str:
        return "Baileys (Não-oficial)"

    @property
    def description(self) -> str:
        return _DISCLAIMER

    def get_capabilities(self) -> Dict[str, bool]:
        return {
            "send_text":              True,
            "send_image":             True,
            "send_video":             True,
            "send_audio":             True,
            "send_document":          True,
            "send_sticker":           True,
            "send_gif":               True,
            "send_view_once":         True,
            "send_poll":              True,
            "send_contact_card":      True,
            "send_mentions":          True,
            "send_location":          True,
            "forward_message":        True,
            "edit_message":           True,
            "delete_message":         True,
            "pin_message":            True,
            "star_message":           True,
            "group_management":       True,
            "profile_management":     True,
            "privacy_settings":       True,
            "presence":               True,
            "chat_management":        True,
            "check_phone_exists":     True,
            "receive_webhook":        True,
            "session_qr":             True,
            "pairing_code":           True,
            "official":               False,
        }

    def get_features(self) -> List[str]:
        return [
            "📱 Conecta via WhatsApp Web WebSocket",
            "✅ QR Code ou código de pareamento",
            "✅ Envio: texto, imagem, vídeo, áudio, documento, localização",
            "✅ Sticker, GIF, view-once, enquetes, contatos, menções",
            "✅ Editar e apagar mensagens; encaminhar; fixar; favoritar",
            "✅ Gerenciamento completo de grupos",
            "✅ Perfil: foto, nome, status; Privacidade; Bloquear contatos",
            "✅ Presença (digitando, gravando) e chat management",
            "✅ Recebimento via webhook ao FastAPI",
            "✅ Múltiplas sessões simultâneas",
            "✅ Persistência de credenciais via MySQL",
            "⚠️ Não-oficial — risco de ban",
        ]

    def get_warnings(self) -> List[str]:
        return [
            "⚠️ Viola Termos de Serviço do WhatsApp",
            "⚠️ Conta pode ser banida sem aviso",
            "⚠️ Sem SLA ou suporte oficial",
            "⚠️ Pode quebrar após atualizações do WhatsApp",
        ]

    def get_setup_steps(self) -> List[str]:
        return [
            "1. Certifique-se que o serviço baileys-bridge está rodando no Railway",
            "2. Acesse Configurações → Contas WA",
            "3. Clique em 'QR Code' ou 'Código de pareamento'",
            "4. Escaneie o QR com o WhatsApp do celular",
            "5. Pronto — sessão autenticada!",
        ]
