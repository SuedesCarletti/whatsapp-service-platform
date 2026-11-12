"""
backend/services/webhook_handler_coexistence.py

Handlers reais pros 3 eventos de webhook específicos da Coexistência (número
usado simultaneamente pelo app WhatsApp Business do celular e pela Cloud
API): `history` (sync inicial do histórico de mensagens), `smb_app_state_sync`
(sync contínuo de estado/contatos vindo do app) e `smb_message_echoes`
(mensagens enviadas pelo app do celular, ecoadas pra Cloud API).

O formato exato dos payloads da Meta pra `history`/`smb_app_state_sync` não
foi confirmado ao vivo nesta implementação inicial — o parsing é defensivo
(try/except por item, nunca deixa uma surpresa de formato derrubar o
processamento do resto do webhook) e o payload bruto de cada tipo é sempre
salvo em CoexistenceSyncState.last_raw_*_payload, pra permitir corrigir a
leitura assim que o formato real for observado em produção. Mesmo padrão já
usado neste projeto pro MM Lite (campo `replied` de template_analytics) e
Conversions API (nomes de evento/`page_id`), cujos formatos reais divergiram
da documentação de terceiros.

`smb_message_echoes` é o único dos três com formato confirmado (mesma forma
de objeto de mensagem padrão da Cloud API) — por isso delega direto pra
WebhookHandler._process_incoming_messages, reaproveitando toda a lógica de
contato/conversa/mensagem e a deduplicação por wamid que já existe lá.
"""
import logging
from typing import Any, Callable, Dict, Optional
from datetime import datetime

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


class WebhookHandlerCoexistence:
    def __init__(self):
        self._process_incoming_messages: Optional[Callable] = None

    def bind(self, process_incoming_messages: Callable):
        """Recebe uma referência pro WebhookHandler._process_incoming_messages
        (bound method), setada uma vez no import de webhook_handler.py — evita
        import circular, já que este módulo não importa webhook_handler.py."""
        self._process_incoming_messages = process_incoming_messages

    def _get_or_create_state(self, db: Session, account_id: int):
        from backend.database.models import CoexistenceSyncState
        CoexistenceSyncState.__table__.create(db.bind, checkfirst=True)
        state = db.query(CoexistenceSyncState).filter(CoexistenceSyncState.account_id == account_id).first()
        if not state:
            # Colunas Integer com default=0 só recebem o valor no INSERT — em
            # memória, antes do flush, ficam None. Como os handlers fazem += logo
            # em seguida (no mesmo commit), precisam vir zeradas explicitamente.
            state = CoexistenceSyncState(
                account_id=account_id,
                history_chunks_received=0,
                app_state_sync_events_received=0,
                message_echoes_received=0,
            )
            db.add(state)
        return state

    def _resolve_account_id(self, db: Session, value: Dict[str, Any], account_id: Optional[int]) -> Optional[int]:
        if account_id:
            return account_id
        phone_number_id = (value.get("metadata") or {}).get("phone_number_id")
        if not phone_number_id:
            return None
        from backend.database.models import WhatsAppAccount
        account = db.query(WhatsAppAccount).filter(WhatsAppAccount.meta_phone_number_id == phone_number_id).first()
        return account.id if account else None

    async def process_message_echoes(self, db: Session, value: Dict[str, Any], account_id: Optional[int] = None):
        """Mensagens enviadas do app do celular, ecoadas pra Cloud API."""
        resolved_id = self._resolve_account_id(db, value, account_id)
        echoes = value.get("smb_message_echoes") or []
        if not echoes:
            return
        if not resolved_id:
            logger.warning("smb_message_echoes: não foi possível resolver account_id, ignorando %d eco(s)", len(echoes))
            return

        synthetic_value = {"messages": [], "metadata": value.get("metadata", {})}
        for echo in echoes:
            try:
                msg = dict(echo)
                # Mesmo branch que _process_incoming_messages já usa pros ecos
                # outbound vindos da bridge Baileys — reaproveita dedupe por wamid.
                msg["direction"] = "outbound"
                synthetic_value["messages"].append(msg)
            except Exception:
                logger.warning("smb_message_echoes: item em formato inesperado, pulando", exc_info=True)

        if synthetic_value["messages"] and self._process_incoming_messages:
            await self._process_incoming_messages(db, synthetic_value, account_id=resolved_id)

        state = self._get_or_create_state(db, resolved_id)
        state.message_echoes_received += len(echoes)
        state.last_message_echo_at = datetime.utcnow()
        db.commit()

    async def process_app_state_sync(self, db: Session, value: Dict[str, Any], account_id: Optional[int] = None):
        """Sync contínuo de estado/contatos vindo do app do celular."""
        resolved_id = self._resolve_account_id(db, value, account_id)
        events = value.get("smb_app_state_sync") or []
        if not resolved_id:
            logger.warning("smb_app_state_sync: não foi possível resolver account_id, ignorando %d evento(s)", len(events))
            return

        state = self._get_or_create_state(db, resolved_id)
        for event in events:
            try:
                # Formato real não confirmado — tentativa best-effort de tratar
                # como registro de contato (wa_id + nome), na mesma forma que o
                # webhook normal de "contacts" já traz.
                wa_id = event.get("wa_id") or (event.get("contact") or {}).get("wa_id")
                name = (event.get("contact") or {}).get("name") or event.get("name")
                if wa_id:
                    from backend.services.conversation_service import conversation_service
                    conversation_service.get_or_create_contact(db, wa_id, wa_id, name=name)
            except Exception:
                logger.warning("smb_app_state_sync: item em formato inesperado, ignorado (não bloqueia o resto)", exc_info=True)

        state.app_state_sync_events_received += len(events)
        state.last_app_state_sync_at = datetime.utcnow()
        if events:
            state.last_raw_app_state_payload = events[-1]
        db.commit()

    async def process_history_sync(self, db: Session, value: Dict[str, Any], account_id: Optional[int] = None):
        """Sync inicial de histórico de mensagens (até 6 meses, entregue em chunks)."""
        resolved_id = self._resolve_account_id(db, value, account_id)
        chunks = value.get("history") or []
        if not resolved_id:
            logger.warning("history: não foi possível resolver account_id, ignorando %d chunk(s)", len(chunks))
            return

        state = self._get_or_create_state(db, resolved_id)
        if state.history_started_at is None:
            state.history_started_at = datetime.utcnow()

        is_final_chunk = False
        for chunk in chunks:
            state.history_chunks_received += 1
            try:
                meta = chunk.get("metadata") or {}
                progress = meta.get("progress")
                if progress is not None:
                    state.history_last_progress_pct = int(progress)

                # Heurística de "chunk final" não confirmada ao vivo — assume que
                # a Meta sinaliza a fase explicitamente; ajustar assim que o
                # primeiro sync real for observado.
                phase = str(meta.get("phase") or "").lower()
                if phase in ("complete", "completed", "final"):
                    is_final_chunk = True

                threads = chunk.get("threads") or []
                for thread in threads:
                    msgs = thread.get("messages") or []
                    if not msgs or not self._process_incoming_messages:
                        continue
                    contact = thread.get("contact")
                    synthetic_value = {
                        "messages": msgs,
                        "contacts": [contact] if contact else [],
                        "metadata": value.get("metadata", {}),
                    }
                    await self._process_incoming_messages(db, synthetic_value, account_id=resolved_id)
            except Exception:
                logger.warning("history: chunk em formato inesperado, dados parciais processados", exc_info=True)

            state.last_raw_history_payload = chunk

        if is_final_chunk and state.history_completed_at is None:
            state.history_completed_at = datetime.utcnow()
            from backend.database.models import WhatsAppAccount
            account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == resolved_id).first()
            if account:
                account.coexistence_synced_at = state.history_completed_at

        db.commit()


webhook_coexistence = WebhookHandlerCoexistence()
