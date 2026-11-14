"""
WebSocket Handler para comunicação em tempo real

OTIMIZADO: Sem ping manual, logs reduzidos, heartbeat nativo
"""
import asyncio
import os
import socketio
from typing import Dict, Any, Optional
import logging

logger = logging.getLogger(__name__)

# Criar servidor Socket.IO com logs otimizados
sio = socketio.AsyncServer(
    async_mode='asgi',
    # Origens vêm de CORS_ORIGINS (mesma lista do app); sem a variável, só localhost de desenvolvimento
    cors_allowed_origins=[o.strip() for o in os.getenv('CORS_ORIGINS', 'http://localhost:3000,http://localhost:8000').split(',') if o.strip()],
    logger=False,              # Desabilita logs verbose do Socket.IO
    engineio_logger=False,     # Desabilita logs do Engine.IO
    # Heartbeat nativo (opcional - já tem valores padrão)
    ping_interval=25,          # Servidor envia ping a cada 25s
    ping_timeout=20,           # Aguarda 20s por resposta
)


class WebSocketManager:
    """Gerencia conexões WebSocket para atualizações em tempo real"""

    def __init__(self, sio_instance: socketio.AsyncServer):
        self.sio = sio_instance
        # Presença (Fase 3) — só em memória de propósito, é estado efêmero
        # demais pra valer persistir. sid_to_user existe pra saber, no
        # disconnect, de quem era aquele socket (o evento só recebe o sid).
        self.sid_to_user: Dict[str, int] = {}
        self.online_users: Dict[int, set] = {}
        # Loop principal do processo (onde este AsyncServer nasceu) — ver
        # capture_main_loop() e _emit() abaixo.
        self._main_loop: Optional[asyncio.AbstractEventLoop] = None
        self.setup_events()

    def capture_main_loop(self) -> None:
        """
        Chamado uma vez no startup do FastAPI, já dentro do loop principal
        (mesma thread/loop em que este AsyncServer foi criado).

        2026-09-02: rotas de webhook de alto volume (mensagem ao vivo,
        resync de histórico) fazem MUITAS chamadas síncronas e bloqueantes
        ao banco (driver pymysql) — com o processo rodando 1 worker só, cada
        lote travava o event loop inteiro por segundos, derrubando até um
        /api/health que nem toca banco (2 incidentes reais nesse dia). A
        correção roda esse processamento numa thread separada, com seu
        próprio event loop isolado (asyncio.run dentro de asyncio.to_thread)
        — mas o socketio.AsyncServer só existe de verdade no loop PRINCIPAL;
        chamar self.sio.emit() a partir do loop de outra thread quebra
        (ele é preso ao loop em que nasceu). _emit() abaixo detecta esse
        caso e usa run_coroutine_threadsafe pra voltar pro loop certo.
        """
        self._main_loop = asyncio.get_running_loop()

    async def _emit(self, event: str, data: Any, room: Optional[str] = None) -> None:
        """Emite um evento Socket.IO com segurança não importa em qual
        thread/loop isso for chamado — ver capture_main_loop()."""
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None

        if self._main_loop is not None and current_loop is not self._main_loop:
            future = asyncio.run_coroutine_threadsafe(
                self.sio.emit(event, data, room=room) if room else self.sio.emit(event, data),
                self._main_loop,
            )
            await asyncio.wrap_future(future)
        else:
            if room:
                await self.sio.emit(event, data, room=room)
            else:
                await self.sio.emit(event, data)

    def _contacts_of(self, user_id: int) -> set:
        """Todo user_id que compartilha pelo menos uma conversa interna com este — só eles precisam saber da presença dele."""
        from backend.database.connection import SessionLocal
        from backend.database.models import InternalConversationParticipant
        db = SessionLocal()
        try:
            my_conv_ids = [r.conversation_id for r in db.query(InternalConversationParticipant).filter(
                InternalConversationParticipant.user_id == user_id
            ).all()]
            if not my_conv_ids:
                return set()
            others = db.query(InternalConversationParticipant.user_id).filter(
                InternalConversationParticipant.conversation_id.in_(my_conv_ids),
                InternalConversationParticipant.user_id != user_id,
            ).all()
            return {o.user_id for o in others}
        finally:
            db.close()

    def setup_events(self):
        """Configura event handlers do Socket.IO"""

        @self.sio.event
        async def connect(sid, environ):
            """Cliente conectou"""
            logger.info(f"Cliente conectado: {sid}")
            await self.sio.emit('connection_established', {'sid': sid}, room=sid)

        @self.sio.event
        async def disconnect(sid):
            """Cliente desconectou — se era o último socket ativo desse
            usuário, grava last_seen_at e avisa quem tem conversa em comum."""
            logger.info(f"Cliente desconectado: {sid}")
            user_id = self.sid_to_user.pop(sid, None)
            if user_id is None:
                return
            sids = self.online_users.get(user_id)
            if sids:
                sids.discard(sid)
                if not sids:
                    del self.online_users[user_id]
                    from backend.database.connection import SessionLocal
                    from backend.database.models import User
                    from datetime import datetime
                    db = SessionLocal()
                    try:
                        u = db.query(User).filter(User.id == user_id).first()
                        if u:
                            u.last_seen_at = datetime.utcnow()
                            db.commit()
                            # "Z" explícito — sem isso o front (moment()) lê o
                            # ISO string como horário LOCAL do navegador, não
                            # UTC, e "visto por último" sai errado pelo exato
                            # offset de fuso do navegador (ex: 3h a menos no Brasil).
                            last_seen_iso = u.last_seen_at.isoformat() + "Z"
                        else:
                            last_seen_iso = None
                    finally:
                        db.close()
                    await self.notify_internal_chat_presence(self._contacts_of(user_id), {
                        "user_id": user_id, "status": "offline", "last_seen_at": last_seen_iso,
                    })

        @self.sio.event
        async def identify(sid, data):
            """
            Cliente se identifica logo após conectar, mandando o próprio JWT
            (não um user_id "cru" — evita que qualquer socket alegue ser
            outro usuário). Entra numa room pessoal 'user:{id}', usada pra
            entregar chat interno (DM/grupo entre usuários) só pra quem
            participa, em vez de broadcast global como o resto do app —
            aqui o conteúdo é privado de verdade, não só "não mostrado na UI".
            Também registra presença (Fase 3): primeiro socket de um usuário
            avisa quem tem conversa em comum que ele ficou online.
            """
            token = (data or {}).get("token")
            if not token:
                return
            try:
                from backend.services.auth_service import auth_service
                payload = auth_service.decode_token(token)
                user_id = payload.get("user_id")
                if not user_id:
                    return
                await self.sio.enter_room(sid, f"user:{user_id}")
                logger.info(f"Socket {sid} identificado como user_id={user_id}")

                self.sid_to_user[sid] = user_id
                was_offline = not self.online_users.get(user_id)
                self.online_users.setdefault(user_id, set()).add(sid)
                if was_offline:
                    # Ao reconectar, respeita o status manual que o usuário já
                    # tinha escolhido (ex: se ele tinha marcado "Ocupado" antes
                    # de cair a conexão, continua aparecendo "Ocupado", não
                    # volta pra "online" sozinho).
                    from backend.database.connection import SessionLocal
                    from backend.database.models import User
                    db = SessionLocal()
                    try:
                        u = db.query(User).filter(User.id == user_id).first()
                        status = (u.presence_status if u else None) or "online"
                    finally:
                        db.close()
                    await self.notify_internal_chat_presence(self._contacts_of(user_id), {
                        "user_id": user_id, "status": status, "last_seen_at": None,
                    })
            except Exception as e:
                logger.warning(f"Falha ao identificar socket {sid}: {e}")

        @self.sio.event
        async def typing(sid, data):
            """
            Cliente avisa que está digitando numa conversa interna —
            repassado só pros outros participantes daquela conversa
            (não broadcast global). Front limpa o indicador sozinho depois
            de alguns segundos sem novo evento (sem "parou de digitar" explícito).
            """
            user_id = self.sid_to_user.get(sid)
            conversation_id = (data or {}).get("conversation_id")
            if not user_id or not conversation_id:
                return
            from backend.database.connection import SessionLocal
            from backend.database.models import InternalConversationParticipant, User
            db = SessionLocal()
            try:
                is_participant = db.query(InternalConversationParticipant).filter(
                    InternalConversationParticipant.conversation_id == conversation_id,
                    InternalConversationParticipant.user_id == user_id,
                ).first()
                if not is_participant:
                    return
                other_ids = [p.user_id for p in db.query(InternalConversationParticipant).filter(
                    InternalConversationParticipant.conversation_id == conversation_id,
                    InternalConversationParticipant.user_id != user_id,
                ).all()]
                user = db.query(User).filter(User.id == user_id).first()
                user_name = (user.full_name or user.email) if user else "Alguém"
            finally:
                db.close()
            await self.notify_internal_chat_typing(other_ids, {
                "conversation_id": conversation_id, "user_id": user_id, "user_name": user_name,
            })

        # PING REMOVIDO: Socket.IO já faz heartbeat automaticamente!
        # Não precisa de evento ping/pong manual
    
    async def broadcast_conversation_update(self, conversation_data: Dict[str, Any]):
        """
        Envia atualização de conversa para todos os clientes conectados
        
        Args:
            conversation_data: Dados da conversa atualizada
        """
        try:
            await self._emit('conversation_update', conversation_data)
            logger.info(f"Atualização de conversa enviada via WebSocket")
        except Exception as e:
            logger.error(f"Erro ao enviar atualização via WebSocket: {e}")
    
    async def broadcast_new_message(self, message_data: Dict[str, Any]):
        """
        Envia nova mensagem para todos os clientes
        
        Args:
            message_data: Dados da nova mensagem
        """
        try:
            await self._emit('new_message', message_data)
            logger.info(f"Nova mensagem enviada via WebSocket")
        except Exception as e:
            logger.error(f"Erro ao enviar mensagem via WebSocket: {e}")
    
    async def broadcast_message_status(self, wamid: str, status: str, error: Optional[Dict[str, Any]] = None):
        """
        Envia atualização de status de mensagem

        Args:
            wamid: ID da mensagem
            status: Novo status (sent, delivered, read, failed)
            error: Detalhes do erro quando status == "failed" (code, title, error_data)
        """
        try:
            payload = {
                'wamid': wamid,
                'status': status
            }
            if error:
                payload['error'] = error
            await self._emit('message_status_update', payload)
            logger.info(f"Status atualizado via WebSocket: {wamid} -> {status}")
        except Exception as e:
            logger.error(f"Erro ao enviar status via WebSocket: {e}")

    async def broadcast_poll_update(self, poll_data: Dict[str, Any]):
        """
        Envia contagem de votos atualizada de uma enquete para todos os clientes.

        Args:
            poll_data: {
                "wamid": "wamid da mensagem da enquete",
                "message": "texto já formatado com pergunta + opções + votos",
            }
        """
        try:
            await self._emit('poll_update', poll_data)
            logger.info(f"Enquete atualizada via WebSocket: {poll_data.get('wamid')}")
        except Exception as e:
            logger.error(f"Erro ao enviar atualização de enquete via WebSocket: {e}")

    async def broadcast_reaction_update(self, reaction_data: Dict[str, Any]):
        """
        Envia atualização de reação para todos os clientes
        
        Args:
            reaction_data: Dados da reação {
                "wamid": "wamid da mensagem original",
                "reaction_emoji": "😮" ou None,
                "from_number": "551199990001",
                "contact_name": "Contato Teste",
                "timestamp": 1768414534000
            }
        """
        try:
            await self._emit('reaction_update', reaction_data)
            emoji_display = reaction_data.get('reaction_emoji', '[REMOVIDA]')
            logger.info(f"Reação enviada via WebSocket: {emoji_display}")
        except Exception as e:
            logger.error(f"Erro ao enviar reação via WebSocket: {e}")

    async def broadcast_message_edit(self, edit_data: Dict[str, Any]):
        """
        Envia atualização de texto de uma mensagem editada pelo contato.

        Args:
            edit_data: {
                "wamid": "wamid da mensagem original",
                "new_text": "texto novo já editado",
            }
        """
        try:
            await self._emit('message_edit_update', edit_data)
            logger.info(f"Edição de mensagem enviada via WebSocket: {edit_data.get('wamid')}")
        except Exception as e:
            logger.error(f"Erro ao enviar edição via WebSocket: {e}")

    async def broadcast_broadcast_progress(self, progress_data: Dict[str, Any]):
        """
        Notifica progresso de um disparo de lista de transmissão (routes_broadcast.py),
        pra quem estiver com o modal aberto ver o contador subir ao vivo sem polling.

        Args:
            progress_data: {
                "id": 5, "broadcast_list_id": 2, "status": "sending"|"done"|"failed",
                "total": 10, "sent_count": 4, "failed_count": 0,
            }
        """
        try:
            await self._emit('broadcast_send_update', progress_data)
        except Exception as e:
            logger.error(f"Erro ao enviar progresso de broadcast via WebSocket: {e}")

    async def broadcast_conversation_meta_update(self, meta_data: Dict[str, Any]):
        """
        Notifica mudança de status/atribuição/tags de uma conversa (atendimento)
        — payload leve, o frontend já tem o resto da conversa em memória.

        Args:
            meta_data: {
                "conversation_id": 12,
                "status": "open"|"pending"|"resolved" (opcional),
                "assigned_to": {"id": 3, "full_name": "..."} | None (opcional),
                "tags": [{"id": 1, "name": "...", "color": "..."}] (opcional),
            }
        """
        try:
            await self._emit('conversation_meta_update', meta_data)
            logger.info(f"Meta de atendimento atualizada via WebSocket: conv={meta_data.get('conversation_id')}")
        except Exception as e:
            logger.error(f"Erro ao enviar meta de atendimento via WebSocket: {e}")

    async def broadcast_internal_note(self, note_data: Dict[str, Any]):
        """
        Notifica nova nota interna (thread privada entre atendentes numa
        conversa — nunca sai para o WhatsApp).

        Args:
            note_data: {"conversation_id", "id", "text", "author", "timestamp"}
        """
        try:
            await self._emit('internal_note_created', note_data)
            logger.info(f"Nota interna enviada via WebSocket: conv={note_data.get('conversation_id')}")
        except Exception as e:
            logger.error(f"Erro ao enviar nota interna via WebSocket: {e}")

    async def broadcast_customer_task_updated(self, task_data: Dict[str, Any]):
        """
        Tarefa vinculada a uma conversa de CLIENTE mudou (criada/pausada/
        cancelada/concluída/etc) — mesmo padrão de broadcast_internal_note
        acima (global, não hoje pra participant_user_ids específicos):
        conversa de cliente não tem roster fixo de participantes como uma
        conversa interna, qualquer atendente com aquele chat aberto no
        momento precisa ver a faixa de tarefas atualizar ao vivo.

        Args:
            task_data: {"customer_conversation_id", "task": {...}}
        """
        try:
            await self._emit('internal_task_updated', task_data)
        except Exception as e:
            logger.error(f"Erro ao enviar atualização de tarefa (conversa de cliente) via WebSocket: {e}")

    async def send_internal_chat_message(self, participant_user_ids, message_data):
        """
        Entrega uma mensagem de chat interno SÓ pra quem participa da
        conversa (rooms 'user:{id}', ver identify() acima) — diferente de
        todo o resto do app, que faz broadcast global, porque aqui o
        conteúdo é uma DM/grupo privado entre usuários específicos.

        `message_data` pode ser um dict único (mesmo payload pra todo mundo)
        OU uma função `(uid) -> dict` — usada quando o payload tem campos
        relativos a quem tá vendo (ex: "is_mine", "my_reaction"), que não
        podem ser calculados uma vez só e replicados pra todo participante
        sem ficarem errados pra quem não é o dono daquele valor.
        """
        is_per_user = callable(message_data)
        for uid in participant_user_ids:
            try:
                payload = message_data(uid) if is_per_user else message_data
                await self._emit('internal_chat_message', payload, room=f"user:{uid}")
            except Exception as e:
                logger.error(f"Erro ao entregar mensagem de chat interno pra user {uid}: {e}")

    async def notify_internal_chat_created(self, participant_user_ids, conversation_data: Dict[str, Any]):
        """Avisa os participantes que uma nova conversa interna (DM ou grupo) foi criada com eles."""
        await self._emit_to_users('internal_chat_created', participant_user_ids, conversation_data)

    async def notify_internal_chat_updated(self, participant_user_ids, conversation_data: Dict[str, Any]):
        """Grupo mudou (nome/foto/admin/participantes) — manda o _conversation_brief atualizado inteiro."""
        await self._emit_to_users('internal_chat_updated', participant_user_ids, conversation_data)

    async def notify_internal_chat_removed(self, user_id, conversation_id: int):
        """Fui removido de um grupo (ou saí) — some da minha lista."""
        await self._emit_to_users('internal_chat_removed', [user_id], {"conversation_id": conversation_id})

    async def _emit_to_users(self, event: str, user_ids, data: Dict[str, Any]):
        """Helper genérico pra eventos de chat interno — sempre por room pessoal, nunca broadcast global."""
        for uid in user_ids:
            try:
                await self._emit(event, data, room=f"user:{uid}")
            except Exception as e:
                logger.error(f"Erro ao emitir '{event}' pra user {uid}: {e}")

    async def notify_internal_chat_message_edited(self, participant_user_ids, data: Dict[str, Any]):
        """data: {conversation_id, id, text, is_edited}"""
        await self._emit_to_users('internal_chat_message_edited', participant_user_ids, data)

    async def notify_internal_chat_message_deleted(self, participant_user_ids, data: Dict[str, Any]):
        """data: {conversation_id, id}"""
        await self._emit_to_users('internal_chat_message_deleted', participant_user_ids, data)

    async def notify_internal_chat_reaction(self, participant_user_ids, data: Dict[str, Any]):
        """data: {conversation_id, message_id, reactions: [{emoji, user_ids}]}"""
        await self._emit_to_users('internal_chat_reaction_updated', participant_user_ids, data)

    async def notify_internal_chat_typing(self, participant_user_ids, data: Dict[str, Any]):
        """data: {conversation_id, user_id, user_name}"""
        await self._emit_to_users('internal_chat_typing', participant_user_ids, data)

    async def notify_internal_chat_read(self, participant_user_ids, data: Dict[str, Any]):
        """data: {conversation_id, user_id, read_at} — pra atualizar os tiquinhos do outro lado."""
        await self._emit_to_users('internal_chat_read', participant_user_ids, data)

    async def notify_internal_chat_presence(self, user_ids, data: Dict[str, Any]):
        """data: {user_id, status ("online"|"away"|"busy"|"offline"), last_seen_at}"""
        await self._emit_to_users('internal_chat_presence', user_ids, data)

    async def notify_internal_task_updated(self, participant_user_ids, data: Dict[str, Any]):
        """data: {conversation_id, task} — status/responsável mudou (marcar feita/reabrir), atualiza o card no chat e a lista nos Dados do contato/grupo em qualquer aba aberta."""
        await self._emit_to_users('internal_task_updated', participant_user_ids, data)

    async def notify_task_reminder(self, user_ids, data: Dict[str, Any]):
        """Lembrete de tarefa PESSOAL ou vinculada a conversa de CLIENTE
        (task_pause_reminder_watchdog.py / task_due_reminder_watchdog.py) —
        essas duas não têm timeline de chat interno pra postar um aviso
        (conversa de cliente não pode receber nada, pessoal não tem
        conversa nenhuma), então a entrega é direta pra quem criou/é
        responsável, disparando o mesmo popup central de lembrete no front
        (ver stableTaskReminder em App.js). data: {text, task, kind}."""
        await self._emit_to_users('task_reminder', user_ids, data)

    async def broadcast_pending_change(self, change_data: Dict[str, Any]):
        """
        Notifica que uma mudança sensível (ex: editar perfil da conta WhatsApp)
        ficou pendente de aprovação de um admin. Broadcast global — sem rooms por
        papel ainda, o frontend decide se mostra o badge conforme is_admin/role.

        Args:
            change_data: {"id": pending_change_id, "change_type": "...", "requested_by": "email"}
        """
        try:
            await self._emit('pending_change_created', change_data)
            logger.info(f"Mudança pendente notificada via WebSocket: {change_data.get('id')}")
        except Exception as e:
            logger.error(f"Erro ao notificar mudança pendente via WebSocket: {e}")


# Instncia global do manager
ws_manager = WebSocketManager(sio)


# Criar app ASGI para o Socket.IO
socket_app = socketio.ASGIApp(
    sio,
    other_asgi_app=None,  # Será integrado no FastAPI
)

