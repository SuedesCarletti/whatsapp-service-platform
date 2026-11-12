# backend/providers/site_chat_provider.py
"""
Provider "Chat do Site" (plugin WordPress/WooCommerce).

Não há API externa pra chamar: a mensagem do atendente é salva no banco pelo
fluxo normal (routes.py::send_text_message -> save_outbound_message) e o
widget do site a busca por long-poll em /api/site-chat/messages. Este
provider só devolve um wamid e acorda o long-poll do visitante.
"""
import asyncio
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

from .base_provider import BaseWhatsAppProvider

logger = logging.getLogger(__name__)

# Executor próprio (não o default do loop, compartilhado com /api/health e
# outros to_thread — ver incidente 2026-09-03 em routes_bridge.WEBHOOK_EXECUTOR).
SITE_CHAT_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="sitechat")


class SiteChatHub:
    """
    Acorda os long-polls abertos de um visitante quando chega mensagem nova.
    notify() pode ser chamado de qualquer thread/event loop (o pipeline de
    webhook e as automações rodam em threads com loop próprio — ver
    routes_bridge._run_webhook_processing_sync), por isso o set() sempre
    volta pro loop dono de cada Event via call_soon_threadsafe.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._waiters: Dict[int, List[Tuple[asyncio.AbstractEventLoop, asyncio.Event]]] = {}

    def register(self, visitor_id: int) -> asyncio.Event:
        loop = asyncio.get_running_loop()
        event = asyncio.Event()
        with self._lock:
            self._waiters.setdefault(visitor_id, []).append((loop, event))
        return event

    def unregister(self, visitor_id: int, event: asyncio.Event) -> None:
        with self._lock:
            entries = self._waiters.get(visitor_id, [])
            self._waiters[visitor_id] = [e for e in entries if e[1] is not event]
            if not self._waiters[visitor_id]:
                self._waiters.pop(visitor_id, None)

    def notify(self, visitor_id: int) -> None:
        with self._lock:
            entries = list(self._waiters.get(visitor_id, []))
        for loop, event in entries:
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:
                pass  # loop já fechado

    def notify_by_wa_id(self, wa_id: str) -> None:
        from backend.database.connection import SessionLocal
        from backend.database.models import SiteChatVisitor
        db = SessionLocal()
        try:
            row = db.query(SiteChatVisitor.id).filter(SiteChatVisitor.wa_id == wa_id).first()
            if row:
                self.notify(row[0])
        finally:
            db.close()


site_chat_hub = SiteChatHub()


class SiteChatProvider(BaseWhatsAppProvider):
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.provider_type = "site_chat"
        self.is_official = True

    async def is_authenticated(self) -> bool:
        return True

    async def send_text(self, to: str, text: str) -> Dict[str, Any]:
        return await self.send_text_message(to=to, text=text)

    async def send_text_message(self, to: str, text: str, reply_to: Optional[str] = None, **_: Any) -> Dict[str, Any]:
        # Sessão de banco síncrona — fora do loop principal. O protocolo é
        # renovado/aberto ANTES de a rota salvar a mensagem (e de acordar o
        # long-poll), pra ela já cair dentro da janela do widget.
        await asyncio.get_running_loop().run_in_executor(SITE_CHAT_EXECUTOR, self._prepare_delivery, to)
        return {"success": True, "message_id": f"site_{uuid.uuid4().hex}"}

    @staticmethod
    def _prepare_delivery(wa_id: str) -> None:
        from backend.database.connection import SessionLocal
        from backend.services.site_chat_protocol import touch_for_agent_reply

        db = SessionLocal()
        try:
            touch_for_agent_reply(db, wa_id)
        except Exception:
            logger.warning("[SiteChat] falha ao atualizar protocolo na resposta do atendente", exc_info=True)
        finally:
            db.close()
        site_chat_hub.notify_by_wa_id(wa_id)

    def get_features(self) -> List[str]:
        return ["Mensagens de texto", "Identificação do cliente logado (WooCommerce)"]
