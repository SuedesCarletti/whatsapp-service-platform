import asyncio
import logging
import re
from typing import Dict, Any, Optional
from sqlalchemy.orm import Session
from backend.models.database_models import (
    Contact, Conversation, Message, 
    MessageType, Direction, MessageStatus, AccountAlert, MediaFile
)
from backend.services.conversation_service import conversation_service, ConversationService
from backend.api.websocket import ws_manager
from backend.utils.time_utils import to_utc_iso
from backend.services.webhook_handler_extended import webhook_extended # Necessário para chamadas de extended
from backend.services.webhook_handler_coexistence import webhook_coexistence # Handlers de history/smb_app_state_sync/smb_message_echoes
from pathlib import Path
import httpx
import aiofiles

import os
import time
from datetime import datetime, timedelta
import smtplib
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)

# Diretório para salvar mídias
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# Ver WebhookHandler._wamid_hex_core: os dois únicos formatos de wamid de
# onde é seguro extrair o hash único da mensagem sem ambiguidade.
_WAMID_BARE_HEX_RE = re.compile(r'^[0-9A-Fa-f]{15,30}$')
_WAMID_PREFIXED_HEX_RE = re.compile(r'^(?:true|false)_[^@]+@lid_([0-9A-Fa-f]{15,30})$')

# Contatos "fantasma" (status@broadcast, wppconnect-reaction) — ver
# backend/utils/contact_filters.py (fonte única, também usada em
# conversation_service.py e routes_admin.py). Confirmado ao vivo causando
# erro de execução real no n8n (não só desperdício de token) quando
# encaminhado pra automação.
from backend.utils.contact_filters import NON_CUSTOMER_WA_IDS as _NON_CUSTOMER_WA_IDS

# Mensagem "velha demais" quando processada — normalmente sinal de resync de
# backlog do bridge (histórico reenviado como se fosse mensagem nova ao
# reconectar), não uma mensagem nova de verdade. Confirmado ao vivo em
# 2026-09-01: reconexão do wppconnect-bridge reenviou mensagens de ~20h atrás
# como novas, reabrindo dezenas de conversas resolvidas e acordando a IA à
# toa. Comparar msg.timestamp (quando foi enviada de verdade no WhatsApp) com
# agora, não created_at (quando SALVAMOS — sempre "agora", não ajuda aqui).
STALE_MESSAGE_THRESHOLD = timedelta(hours=1)


def _is_stale_inbound(msg_timestamp_ms: int) -> bool:
    if not msg_timestamp_ms:
        return False
    msg_time = datetime.utcfromtimestamp(msg_timestamp_ms / 1000)
    return (datetime.utcnow() - msg_time) > STALE_MESSAGE_THRESHOLD

# ciphertext = mensagem chegou mas ainda não pôde ser decifrada (sessão/chave
# não sincronizada a tempo). Não é definitivo — wa-js/whatsapp-web.js
# reemitem o evento da mensagem quando o "type" muda de ciphertext pro tipo
# real assim que a sessão decifra (mecanismo de retry nativo da lib, não
# nosso). Definido aqui (não em routes_bridge.py) pra evitar import circular
# — routes_bridge.py importa este módulo, não o contrário.
CIPHERTEXT_PLACEHOLDER = "🔒 Mensagem não pôde ser decifrada"


def _parse_single_vcard(vcard: str, fallback_name: str) -> str:
    name = fallback_name or "Contato"
    phones = []
    for line in (vcard or "").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        prop, _, value = line.partition(":")
        value = value.strip()
        # remove prefixo de grupo (ex.: "item1.TEL;waid=...") e parmetros
        # (ex.: ";TYPE=CELL") pra achar o nome real da propriedade
        prop_name = prop.upper().split(".")[-1].split(";")[0]
        if prop_name == "FN":
            name = value or name
        elif prop_name == "TEL":
            # contatos com WhatsApp trazem o número canônico em waid=,
            # que é o formato que bate com o JID salvo no banco
            waid_match = re.search(r"waid=(\d+)", prop, re.IGNORECASE)
            phone = waid_match.group(1) if waid_match else value
            if phone:
                phones.append(phone)

    text = f"📇 {name}"
    if phones:
        text += "\n📱 " + ", ".join(phones)
    return text


def _format_contact_card_text(vcard: str, fallback_name: str, vcards=None) -> str:
    """
    Extrai nome (FN) e telefone(s) (TEL) de um ou mais vCards recebidos e monta
    um texto legível para a conversa — mesmo formato usado para contatos
    enviados (routes.py /send/contacts), já que "contact" não é um MessageType
    próprio no banco e cai em TEXT. Vários contatos no mesmo envio viram
    vários blocos "📇 ..." separados por linha em branco (o front desenha um
    cartão por bloco).

    `vcards` (opcional): lista de {"vcard": str, "name": str} — preferida
    quando o bridge consegue separar os contatos; senão, `vcard` pode trazer
    vários BEGIN:VCARD concatenados.
    """
    items = []
    if isinstance(vcards, list):
        for v in vcards:
            if isinstance(v, dict):
                items.append((v.get("vcard") or "", v.get("name") or ""))
            elif isinstance(v, str):
                items.append((v, ""))
    if not items:
        blocks = re.split(r"(?=BEGIN:VCARD)", vcard or "", flags=re.IGNORECASE)
        blocks = [b for b in blocks if b.strip()]
        if len(blocks) > 1:
            items = [(b, "") for b in blocks]
        else:
            items = [(vcard or "", fallback_name)]

    cards = [_parse_single_vcard(v, n or (fallback_name if len(items) == 1 else "")) for v, n in items]
    return "\n\n".join(cards)


class WebhookHandler:
    def __init__(self):
        self.conversation_service = conversation_service
    
    @staticmethod
    def verify_webhook(mode: str, token: str, challenge: str, verify_token: str) -> str:
        """
        Verifica webhook durante subscrição (GET request)
        """
        if mode == "subscribe" and token == verify_token:
            logger.info("Webhook verificado com sucesso")
            return challenge
        
        logger.warning("Falha na verificação do webhook")
        return None
    
    def _save_webhook_log(self, db: Session, payload: Dict[str, Any]):
        """Salva log do webhook recebido"""
        pass  # Implementar se necessário
    
    async def process_webhook(self, db: Session, payload: Dict[str, Any], account_id: Optional[int] = None) -> Dict[str, str]:
        try:
            logger.info("=" * 70)
            logger.info("PROCESSANDO WEBHOOK")
            
            self._save_webhook_log(db, payload)
            
            if payload.get("object") not in ("whatsapp_business_account", "bridge_message"):
                logger.warning(f"Webhook de tipo desconhecido: {payload.get('object')}")
                return {"status": "ignored"}
            
            if account_id is None:
                account_id = payload.get("account_id")
            
            entries = payload.get("entry", [])
            logger.info(f"Total de entries: {len(entries)}")
            
            for entry in entries:
                changes = entry.get("changes", [])
                logger.info(f"Total de changes: {len(changes)}")
                
                for change in changes:
                    value = change.get("value", {})
                    field = change.get("field")
 
                    # Processar mensagens recebidas
                    if "messages" in value:
                        logger.info("Processando mensagens recebidas...")
                        await self._process_incoming_messages(db, value, account_id=account_id)
                    
                    # Processar status de mensagens enviadas
                    if "statuses" in value:
                        logger.info("Processando status de mensagens...")
                        await self._process_message_statuses(db, value)

                    # Coexistência: sync inicial de histórico, sync contínuo de
                    # estado/contatos do app, e ecos de mensagens enviadas pelo
                    # app do celular — chegam como chaves-irmãs de "messages"/
                    # "statuses" dentro do mesmo value, não no campo `field`.
                    if "history" in value:
                        logger.info("Recebido: History Sync (Coexistência)")
                        await webhook_coexistence.process_history_sync(db, value, account_id=account_id)

                    if "smb_app_state_sync" in value:
                        logger.info("Recebido: App State Sync (Coexistência)")
                        await webhook_coexistence.process_app_state_sync(db, value, account_id=account_id)

                    if "smb_message_echoes" in value:
                        logger.info("Recebido: Message Echo do app do celular (Coexistência)")
                        await webhook_coexistence.process_message_echoes(db, value, account_id=account_id)

                    elif field == "message_template_status_update":
                        logger.info("Recebido: Template Status Update")
                        await self.process_template_status(db, entry)

                    elif field == "account_alerts":
                        logger.info("Recebido: Account Alerts")
                        await self.process_account_alerts(db, entry)
                    
                    elif field == "phone_number_quality_update":
                        logger.info("Recebido: Phone Number Quality Update")
                        await self.process_phone_number_quality(db, entry)
            
            logger.info("WEBHOOK PROCESSADO COM SUCESSO")
            logger.info("=" * 70)
            return {"status": "processed"}
        
        except Exception as e:
            logger.error(f"Erro ao processar webhook: {e}", exc_info=True)
            return {"status": "error", "message": str(e)}
    
    async def _download_media(
        self,
        db: Session,
        media_id: str,
        message_id: Optional[int] = None,
        direct_url: Optional[str] = None,
        direct_mime_type: Optional[str] = None,
        account_id: Optional[int] = None,
    ) -> tuple[Optional[str], Optional[str], Optional[str], Optional[MediaFile]]:
        """
        Baixa mídia do WhatsApp com tracking no banco de dados.

        Para providers Baileys/bridge, forneça `direct_url` com a URL de download
        do arquivo já hospedado pelo bridge (evita chamada à Meta Graph API).

        Retorna: (file_path, mime_type, filename, media_file_object)
        """
        try:
            # 1. Verificar se já foi baixado
            existing_media = db.query(MediaFile).filter(
                MediaFile.media_id == media_id
            ).first()

            if existing_media and os.path.exists(existing_media.filepath):
                logger.info(f"Mídia já existe no banco: {existing_media.filepath}")
                if message_id and not existing_media.message_id:
                    existing_media.message_id = message_id
                    db.commit()
                return existing_media.filepath, existing_media.mime_type, existing_media.filename, existing_media

            logger.info(f"Baixando mídia: {media_id} (direct_url={bool(direct_url)})")
            
            # 2. Obter token de acesso correto da conta
            access_token = None
            if account_id:
                from backend.database.models import WhatsAppAccount
                account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == account_id).first()
                if account and account.meta_access_token:
                    access_token = account.meta_access_token

            # Arquivo local já salvo pelo bridge-upload endpoint — não baixar novamente
            if direct_url and direct_url.startswith("/uploads/"):
                local_filename = direct_url.split("/uploads/")[-1]
                file_path = UPLOAD_DIR / local_filename
                mime_type = direct_mime_type or "application/octet-stream"
                file_size = file_path.stat().st_size if file_path.exists() else 0
                logger.info(f"Mídia local do bridge: {file_path}")
                media_file = MediaFile(
                    media_id=media_id,
                    filename=local_filename,
                    filepath=str(file_path),
                    mime_type=mime_type,
                    file_size=file_size,
                    message_id=message_id,
                )
                db.add(media_file)
                db.commit()
                db.refresh(media_file)
                return str(file_path), mime_type, local_filename, media_file

            async with httpx.AsyncClient(timeout=30.0) as client:
                if direct_url:
                    # Baileys/bridge: download direto da URL fornecida pelo bridge
                    # Meta: também pode enviar url direta para stickers
                    logger.info(f"Download direto: {direct_url}")
                    
                    headers = {}
                    if not access_token and ("lookaside.fbsbx.com" in direct_url or "whatsapp.net" in direct_url or "graph.facebook.com" in direct_url):
                        logger.warning(f"Tentando baixar de URL autenticada sem token para media_id {media_id}")
                    elif access_token and ("lookaside.fbsbx.com" in direct_url or "whatsapp.net" in direct_url or "graph.facebook.com" in direct_url):
                        headers = {"Authorization": f"Bearer {access_token}"}
                        
                    download_response = await client.get(direct_url, headers=headers)
                    download_response.raise_for_status()

                    mime_type = (
                        direct_mime_type
                        or download_response.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
                    )
                    file_size = len(download_response.content)
                else:
                    # Meta Cloud API: obter URL temporária e baixar com token
                    if not access_token:
                        logger.error(f"Não é possível baixar da Meta Graph API sem access_token para a conta {account_id}")
                        return None, None, None, None
                        
                    url = f"https://graph.facebook.com/v18.0/{media_id}"
                    headers = {"Authorization": f"Bearer {access_token}"}

                    response = await client.get(url, headers=headers)
                    response.raise_for_status()
                    media_data = response.json()

                    media_url = media_data.get("url")
                    mime_type = media_data.get("mime_type", "application/octet-stream")
                    file_size = media_data.get("file_size", 0)

                    logger.info(f"Baixando de Meta: {media_url}")
                    download_response = await client.get(media_url, headers=headers)
                    download_response.raise_for_status()
                    file_size = file_size or len(download_response.content)

                # Gerar nome do arquivo
                _MIME_EXT = {
                    "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
                    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
                    "vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
                    "vnd.ms-excel": "xls",
                    "vnd.ms-powerpoint": "ppt",
                    "msword": "doc",
                    "vnd.oasis.opendocument.text": "odt",
                    "vnd.oasis.opendocument.spreadsheet": "ods",
                    "x-zip-compressed": "zip",
                    "x-rar-compressed": "rar",
                    "x-7z-compressed": "7z",
                    "octet-stream": "bin",
                }
                raw_subtype = mime_type.split("/")[-1].split(";")[0].strip()
                extension = _MIME_EXT.get(raw_subtype, raw_subtype[:10]) or "bin"

                filename = f"{media_id}.{extension}"
                file_path = UPLOAD_DIR / filename

                async with aiofiles.open(file_path, 'wb') as f:
                    await f.write(download_response.content)

                logger.info(f"Mídia salva: {file_path} ({len(download_response.content)} bytes)")

                media_file = MediaFile(
                    media_id=media_id,
                    filename=filename,
                    filepath=str(file_path),
                    mime_type=mime_type,
                    file_size=len(download_response.content),
                    message_id=message_id,
                    downloaded_at=datetime.utcnow()
                )

                db.add(media_file)
                db.commit()
                db.refresh(media_file)

                logger.info(f"Registro criado no banco: ID={media_file.id}")
                return str(file_path), mime_type, filename, media_file

        except Exception as e:
            logger.error(f"Erro ao baixar mídia {media_id}: {e}")
            db.rollback()
            return None, None, None, None
    
    @staticmethod
    def _time_in_range(start_str: str, end_str: str, now_time) -> bool:
        """
        True se now_time cai em [start_str, end_str) — suporta janela que
        cruza a meia-noite (ex: fora do expediente 18:00–08:00, onde
        start > end na representação HH:MM).
        """
        try:
            start = datetime.strptime(start_str, "%H:%M").time()
            end = datetime.strptime(end_str, "%H:%M").time()
        except (ValueError, TypeError):
            return False
        if start <= end:
            return start <= now_time < end
        return now_time >= start or now_time < end

    @staticmethod
    def _find_history_sync_duplicate(
        db: Session, conversation_id: int, direction: Direction, timestamp: int, wamid: str
    ) -> Optional[Message]:
        """
        BUG (2026-09-03, confirmado ao vivo — 836 linhas duplicadas achadas em
        produção): `wamid` sintético (prefixo "wpp_hist_", ver
        historySyntheticId no bridge WPPConnect) é gerado quando o resync de
        histórico (syncChatHistory, roda em TODA reconexão do bridge — restart,
        watchdog etc.) usa a API deprecated getAllMessagesInChat, que nunca traz
        o ID real da mensagem. O hash é determinístico entre re-syncs (evita
        duplicar contra SI MESMO a cada reconexão — fix anterior), mas não sabe
        que essa mesma mensagem pode já estar salva com o wamid REAL (chegada
        ao vivo, ou via backfill paginado que usa getMessages e traz ID real) —
        cada reconexão gerava uma linha nova, idêntica em tudo (mesma conversa,
        direção e timestamp — herdados do WhatsApp, não inventados pelo bridge)
        menos o wamid.

        Só entra em ação pra wamid sintético (`wpp_hist_` — nunca para wamid
        real, que já é confiável por si só). Casa por (conversation_id,
        direction, timestamp) sem exigir texto idêntico: mídia salva um
        texto/legenda diferente entre o caminho ao vivo e o de histórico (ex.:
        nome de arquivo real vs. placeholder genérico "[Document]"), e
        timestamp (herdado do WhatsApp, granularidade de segundo) já fixa a
        mensagem com folga — duas mensagens reais distintas na mesma conversa,
        mesma direção, mesmo segundo exato, é praticamente impossível.
        """
        if not wamid.startswith("wpp_hist_"):
            return None
        return db.query(Message).filter(
            Message.conversation_id == conversation_id,
            Message.direction == direction,
            Message.timestamp == timestamp,
            ~Message.wamid.like("wpp_hist_%"),
        ).first()

    @staticmethod
    def _wamid_hex_core(wamid: Optional[str]) -> Optional[str]:
        """
        Extrai o hash hexadecimal único de um wamid SÓ quando ele bate
        exatamente com um dos dois formatos conhecidos e sem ambiguidade:
        cru ("3EB0FA2286B246DB5037D8") ou prefixado
        ("true_<jid>@lid_3EB0FA2286B246DB5037D8"). Qualquer outra coisa
        devolve None — mais vale não casar um duplicado real do que casar
        dois errados.

        Por que regex ancorada em vez de "pega depois do último '_'"
        (tentativa anterior, revertida no mesmo dia): existem outros
        formatos de wamid no banco cujo último "_" NÃO precede o hash
        único — ex.: status@broadcast
        ("false_status@broadcast_<hash>_<jid>@lid", último "_" fica antes
        do JID do autor, repetido em todo post da mesma pessoa) e um
        formato de outro provider terminado em "_out"/"_in" (sufixo
        genérico repetido em muitas mensagens). Auditoria ao vivo achou
        centenas de milhares de pares falsos com a versão ingênua. A
        ncora "^...$" nos dois regex abaixo garante que só extrai quando
        a string INTEIRA bate com um dos dois formatos — nunca um pedaço
        solto de outra coisa.
        """
        if not wamid:
            return None
        if _WAMID_BARE_HEX_RE.match(wamid):
            return wamid.upper()
        m = _WAMID_PREFIXED_HEX_RE.match(wamid)
        return m.group(1).upper() if m else None

    @classmethod
    def _find_existing_message(
        cls, db: Session, conversation_id: int, direction: Direction, timestamp: int, wamid: str
    ) -> Optional[Message]:
        """
        Reentrega do MESMO evento (ex.: WPPConnect reemite como `ciphertext`
        e minutos/segundos depois reemite decifrado com o mesmo wamid, ou
        confirmação de entrega que muda só o prefixo do wamid — ver
        _find_wamid_format_duplicate). Reusa as 3 buscas de idempotência já
        usadas mais abaixo pra decidir SE a mensagem já existe, sem duplicar
        a lógica — usado como guarda ANTES de rodar automação de atendimento
        e encaminhar pro webhook de IA (ver chamada em _process_incoming_messages).

        BUG (2026-09-29, confirmado ao vivo, SAC-01): sem essa guarda, a 2a
        entrega do mesmo evento rodava _forward_to_ai_webhook de novo pro n8n
        — o fluxo via o estado já avançado (salvo pela 1a rodada) e mandava
        uma 2a resposta diferente pro cliente pra UMA ÚNICA mensagem real.
        """
        return db.query(Message).filter(
            Message.wamid == wamid, Message.conversation_id == conversation_id
        ).first() or cls._find_history_sync_duplicate(
            db, conversation_id, direction, timestamp, wamid
        ) or cls._find_wamid_format_duplicate(
            db, conversation_id, direction, wamid
        )

    @classmethod
    def _find_wamid_format_duplicate(
        cls, db: Session, conversation_id: int, direction: Direction, wamid: str
    ) -> Optional[Message]:
        """
        BUG (2026-09-14, confirmado ao vivo — SAC-01, mensagens duplicadas
        na MESMA conversa): o WPPConnect salva o wamid "cru" no eco
        imediato do envio (ex.: "3EB0FA2286B246DB5037D8"), mas a
        confirmação de entrega que chega minutos depois pelo webhook às
        vezes traz o MESMO id num formato mais completo (ex.:
        "true_232795884527826@lid_3EB0FA2286B246DB5037D8" — mesmo hash,
        só o prefixo muda). O match exato de wamid não reconhece que é a
        mesma mensagem e cria uma segunda linha — mesmo texto, mesma
        conversa, minutos de diferença.

        Casa pelo hash único (ver _wamid_hex_core — só extrai quando o
        formato bate exatamente, nunca por heurística frouxa) dentro da
        MESMA conversa e direção. Escaneia só as últimas 200 mensagens da
        conversa nessa direção (mais que suficiente — a confirmação chega
        minutos depois do envio, não páginas de histórico depois) em vez
        de uma query SQL com extração de substring, porque os dois
        formatos têm estrutura irregular demais pra expressar com
        segurança em SUBSTRING_INDEX puro.
        """
        core = cls._wamid_hex_core(wamid)
        if not core:
            return None
        candidates = (
            db.query(Message)
            .filter(Message.conversation_id == conversation_id, Message.direction == direction)
            .order_by(Message.id.desc())
            .limit(200)
            .all()
        )
        for cand in candidates:
            if cand.wamid != wamid and cls._wamid_hex_core(cand.wamid) == core:
                return cand
        return None

    async def _run_attendance_automations(
        self, db: Session, conversation: Conversation, contact: Contact, wa_id: str,
        msg_type: str, msg: Dict[str, Any], account_id: Optional[int],
    ) -> bool:
        """
        Hooks de atendimento sobre toda mensagem INBOUND 1:1 (não-grupo): captura
        de resposta de CSAT, reabertura automática de conversa resolvida, e
        auto-reply de fora-do-horário — na ordem, cada um interrompe os
        seguintes quando se aplica. Nunca deixa uma falha aqui derrubar o
        processamento normal da mensagem (try/except amplo, só loga).

        Retorna True quando a mensagem foi "consumida" por um desses hooks
        (hoje só a captura de CSAT) — nesse caso o chamador não deve também
        encaminhar a mensagem pro webhook de IA (_forward_to_ai_webhook).
        """
        # Contato interno (colega/fornecedor, Contact.is_internal) não é
        # atendimento a cliente — reabertura automática, captura de CSAT e
        # aviso de fora-do-horário não fazem sentido pra esse tipo de conversa.
        # status@broadcast (Status/Stories do WhatsApp, ver conversation_service.py)
        # também não é atendimento — não tem cliente do outro lado pra reabrir
        # conversa, receber CSAT ou aviso de fora-do-horário.
        if conversation.is_group or contact.is_internal or contact.wa_id in _NON_CUSTOMER_WA_IDS:
            return False
        try:
            from backend.api.routes_settings import _load_settings
            from backend.api.routes import get_provider, _extract_wamid
            from backend.database.models import CsatResponse

            automations = _load_settings().get("automations", {})
            off_hours = automations.get("off_hours", {})
            csat = automations.get("csat", {})

            text_body = None
            if msg_type == "text":
                text_body = ((msg.get("text") or {}).get("body") or "").strip()

            async def _send_system_reply(text: str):
                provider, provider_kind = get_provider(db, account_id or conversation.account_id)
                api_response = await provider.send_text_message(to=wa_id, text=text)
                wamid = _extract_wamid(api_response, provider_kind)
                if wamid:
                    conversation_service.save_outbound_message(
                        db=db, wamid=wamid, conversation_id=conversation.id, contact_id=contact.id,
                        message_type="text", message_text=text,
                    )
                    await ws_manager.broadcast_new_message({
                        "wamid": wamid, "type": "text", "direction": "outbound", "from_number": "me",
                        "message": text, "sender": "me", "conversation_id": conversation.id,
                        "account_id": conversation.account_id, "timestamp": int(datetime.now().timestamp() * 1000),
                    })

            # 1) Resposta a uma pesquisa de CSAT pendente (dígito 1-5 no início do texto)
            if conversation.awaiting_csat and text_body:
                first_char = text_body[0]
                if first_char.isdigit() and first_char in "12345":
                    comment = text_body[1:].strip() or None
                    db.add(CsatResponse(conversation_id=conversation.id, rating=int(first_char), comment=comment))
                    conversation.awaiting_csat = False
                    db.commit()
                    try:
                        await _send_system_reply("Muito obrigado pela sua avaliação! 🙏")
                    except Exception as e:
                        logger.warning(f"Falha ao enviar agradecimento de CSAT: {e}")
                    return True  # não conta como "cliente voltou a escrever" pra fins de reabertura/off-hours

            # 2) Cliente escreveu de novo numa conversa marcada como resolvida — reabre.
            # Também retoma o bot (se estava pausado por um atendente ter assumido):
            # atendimento novo, por padrão, começa com o bot de novo.
            # resolved_at some (não está mais resolvida — sem isso, attendance_reports
            # contava essa conversa como resolvida pra sempre, mesmo reaberta). O
            # relógio do Sidebar (Sidebar.js::getSlaBadge) também precisa reiniciar:
            # se já tinha responsável, assigned_at vira agora ("em atendimento");
            # senão, queue_since vira agora ("⏳ esperando") — sem isso os dois
            # badges continuavam contando desde a atribuição/criação original, de
            # dias atrás, em vez de reiniciar (bug relatado: "tempo em atendimento
            # não reseta" ao reabrir depois do CSAT).
            if conversation.status == "resolved":
                conversation.status = "open"
                conversation.awaiting_csat = False
                conversation.resolved_at = None
                conversation.bot_enabled = True
                conversation.bot_handoff_at = None
                conversation.bot_loop_detected = False
                conversation.bot_repeat_count = 0
                conversation.bot_forwarded_at = None
                conversation.bot_last_reply_text = None
                if conversation.assigned_to_user_id:
                    conversation.assigned_at = datetime.utcnow()
                else:
                    conversation.queue_since = datetime.utcnow()
                db.commit()
                await ws_manager.broadcast_conversation_meta_update({
                    "conversation_id": conversation.id, "status": "open", "bot_enabled": True,
                    "bot_handoff_at": None,
                    "bot_loop_detected": False, "resolved_at": None,
                    "assigned_at": to_utc_iso(conversation.assigned_at),
                    "queue_since": to_utc_iso(conversation.queue_since),
                })

            # 2b) Cliente respondeu enquanto a conversa estava "pending"
            # (aguardando ele) — volta pra "open" pra sinalizar que precisa de
            # atenção do atendente de novo, e para o cronômetro de "tempo
            # pendente". Não mexe em bot_enabled aqui: diferente do caso
            # resolved→open, um humano já está engajado nessa conversa.
            elif conversation.status == "pending":
                conversation.status = "open"
                conversation.pending_since = None
                db.commit()
                await ws_manager.broadcast_conversation_meta_update({
                    "conversation_id": conversation.id, "status": "open", "pending_since": None,
                })

            # 3) Fora do horário de atendimento — no máx. 1 aviso a cada 24h por conversa.
            # Contato interno (colega/fornecedor) não recebe resposta automática.
            if not contact.is_internal and off_hours.get("enabled") and off_hours.get("message"):
                now_time = datetime.now().time()
                if self._time_in_range(off_hours.get("start", "18:00"), off_hours.get("end", "08:00"), now_time):
                    last_sent = conversation.last_business_hours_autoreply_at
                    if last_sent is None or (datetime.utcnow() - last_sent) > timedelta(hours=24):
                        conversation.last_business_hours_autoreply_at = datetime.utcnow()
                        db.commit()
                        try:
                            await _send_system_reply(off_hours["message"])
                        except Exception as e:
                            logger.warning(f"Falha ao enviar aviso de fora-do-horário: {e}")

        except Exception as e:
            logger.error(f"Erro nos hooks de automação de atendimento: {e}", exc_info=True)
        return False

    async def _forward_to_ai_webhook(
        self, db: Session, conversation: Conversation, contact: Contact, wa_id: str,
        msg_type: str, msg: Dict[str, Any], account_id: Optional[int],
    ) -> None:
        """
        Encaminha a mensagem recebida pro webhook de IA/bot configurado na
        conta (n8n ou qualquer outra ferramenta que fale HTTP+JSON) — ver
        POST /api/bot/reply em routes_ai_bot.py pro caminho de volta.
        No-op se: grupo, bot pausado nessa conversa (handoff humano em
        andamento), contato marcado como interno (Contact.is_internal — nunca
        encaminha, independente de bot_enabled), contato status@broadcast
        (Status/Stories do WhatsApp — não é um cliente que possa receber
        resposta do bot) ou conta sem webhook configurado. Nunca derruba o
        processamento normal da mensagem (try/except amplo, só loga).
        """
        if conversation.is_group or not conversation.bot_enabled or contact.is_internal or contact.wa_id in _NON_CUSTOMER_WA_IDS:
            return
        try:
            from backend.database.models import WhatsAppAccount

            account = db.query(WhatsAppAccount).filter(
                WhatsAppAccount.id == (account_id or conversation.account_id)
            ).first()
            if not account or not account.ai_webhook_enabled or not account.ai_webhook_url:
                return

            text_body = None
            if msg_type == "text":
                text_body = ((msg.get("text") or {}).get("body") or "").strip()

            history = []
            for m in self.conversation_service.get_conversation_messages(db, conversation.id, limit=20):
                ts = m.get("timestamp")
                history.append({
                    "role": "assistant" if m.get("direction") == "outbound" else "user",
                    "content": m.get("message") or "",
                    "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else ts,
                })

            if account.ai_webhook_format == "evolution_compat":
                # Envelope que imita o webhook MESSAGES_UPSERT da Evolution API —
                # existe só pra migrar bots n8n baseados na Evolution API sem reescrever
                # o nó "Filtro" e tudo que lê $json.body.data... Ver
                # backend/api/routes_evolution_compat.py pro caminho de volta.
                remote_jid = wa_id if "@" in wa_id else f"{wa_id}@{'g.us' if conversation.is_group else 's.whatsapp.net'}"
                payload = {
                    "event": "messages.upsert",
                    "instance": account.account_name,
                    "data": {
                        "key": {"remoteJid": remote_jid, "fromMe": False, "id": msg.get("id") or ""},
                        "messageType": "conversation" if msg_type == "text" else msg_type,
                        "message": {"conversation": text_body} if msg_type == "text" else {},
                        "pushName": contact.push_name or contact.name or "",
                        "messageTimestamp": int(datetime.utcnow().timestamp()),
                    },
                }
                headers = {"apikey": account.ai_webhook_secret or ""}
            else:
                payload = {
                    "event": "message.received",
                    "account_id": account.id,
                    "conversation_id": conversation.id,
                    "contact": {
                        "phone": contact.phone_number or wa_id,
                        "name": contact.name or contact.push_name or None,
                    },
                    "message": {
                        "type": msg_type,
                        "text": text_body,
                        "media_url": None,
                        "timestamp": datetime.utcnow().isoformat(),
                    },
                    "history": history,
                }
                headers = {"Authorization": f"Bearer {account.ai_webhook_secret or ''}"}

            # verify=False: ferramentas de IA (ex: n8n) costumam rodar atrás de
            # certificado autoassinado em LAN privada — mesma situação já
            # resolvida do lado do n8n (allowUnauthorizedCerts) pra chamar de
            # volta o wpp-platform.
            #
            # timeout=60 (era 8): o webhook trigger do n8n
            # está configurado como responseMode="responseNode" — só responde
            # quando o workflow inteiro termina, não na chegada. Execuções reais
            # medidas via execution_entity do n8n levam 7-13s (RAG+LLM), então
            # com 8s a gente dava timeout ANTES do n8n terminar, tratava como
            # falha e marcava bot_loop_detected=True — mesmo o n8n concluindo
            # normalmente segundos depois e respondendo de verdade pelo callback
            # separado (routes_evolution_compat.py). Falso positivo confirmado
            # ao vivo (2026-09-01, ver conversas 520/555): bot_last_reply_text
            # populado por uma resposta real que chegou DEPOIS do nosso timeout.
            # Não consome o corpo da resposta do n8n (só o status code) — o
            # texto de verdade sempre chega pelo callback, então esperar mais
            # aqui não muda o que fazemos com a resposta, só evita o falso
            # positivo.
            async with httpx.AsyncClient(timeout=60.0, verify=os.getenv('AI_WEBHOOK_VERIFY_TLS', 'true').lower() != 'false') as client:
                resp = await client.post(account.ai_webhook_url, json=payload, headers=headers)
                if resp.status_code >= 400:
                    logger.warning(f"Webhook de IA respondeu {resp.status_code} para conversa {conversation.id}")
                    if conversation_service.flag_bot_needs_attention(db, conversation):
                        await ws_manager.broadcast_conversation_meta_update({
                            "conversation_id": conversation.id, "bot_loop_detected": True,
                        })
                else:
                    # Encaminhado com sucesso — começa a contar o silêncio;
                    # bot_health_watchdog alerta se a resposta nunca chegar em
                    # POST /api/bot/reply. Limpo lá assim que a resposta chega.
                    conversation.bot_forwarded_at = datetime.utcnow()
                    db.commit()
        except Exception as e:
            logger.warning(f"Falha ao encaminhar mensagem pro webhook de IA: {e}")
            if conversation_service.flag_bot_needs_attention(db, conversation):
                await ws_manager.broadcast_conversation_meta_update({
                    "conversation_id": conversation.id, "bot_loop_detected": True,
                })

    async def _process_incoming_messages(self, db: Session, value: Dict[str, Any], account_id: Optional[int] = None):
        """
        Processa mensagens recebidas e enviadas (inbound + outbound do bridge).
        Suporta mensagens individuais e de grupo com dados completos de contato.
        """
        if account_id is None:
            account_id = value.get("metadata", {}).get("account_id")
            if account_id is None:
                # Resolve account_id para webhooks Meta
                phone_number_id = value.get("metadata", {}).get("phone_number_id")
                if phone_number_id:
                    from backend.database.models import WhatsAppAccount
                    account = db.query(WhatsAppAccount).filter(WhatsAppAccount.meta_phone_number_id == phone_number_id).first()
                    if account:
                        account_id = account.id

        # Mensagem vinda do resync de histórico (POST /bridge/sync, ao
        # conectar/reconectar) — de antes da sessão existir, não faz sentido
        # entrar como "aberta" na fila de atendimento. Ver get_or_create_conversation.
        is_history = bool(value.get("metadata", {}).get("is_history"))

        messages = value.get("messages", [])
        contacts = value.get("contacts", [])

        logger.info(f"Total de mensagens: {len(messages)}")
        logger.info(f"Total de contatos: {len(contacts)}")

        contact_map = {c["wa_id"]: c for c in contacts}

        for msg in messages:
            try:
                wa_id = msg.get("from")
                wamid = msg.get("id")
                msg_type = msg.get("type")
                timestamp = int(msg.get("timestamp", 0)) * 1000

                # Direção da mensagem (inbound por padrão para Cloud API)
                raw_direction = msg.get("direction", "inbound")
                is_outbound = raw_direction == "outbound"
                direction_enum = Direction.OUTBOUND if is_outbound else Direction.INBOUND

                # Dados de grupo
                is_group = msg.get("is_group", False)
                group_jid = msg.get("group_jid")
                group_name = msg.get("group_name") or msg.get("group_subject")
                participant_jid_raw = msg.get("participant")
                # Descarta participant_jid se ainda é um LID não resolvido
                participant_jid = None if (participant_jid_raw and participant_jid_raw.endswith("@lid")) else participant_jid_raw

                # Para outbound: o contato relevante é o destinatário (campo "to")
                # Para inbound individual: é o remetente (campo "from")
                # Para grupo: é o group_jid
                to_id = msg.get("to", "")
                if is_group and group_jid:
                    chat_wa_id = group_jid
                elif is_outbound and to_id and to_id != "me":
                    chat_wa_id = to_id
                else:
                    chat_wa_id = wa_id

                # Normaliza chat_wa_id: remove @s.whatsapp.net de contatos individuais
                # para garantir consistência entre mensagens outbound e inbound.
                if not is_group and chat_wa_id and "@s.whatsapp.net" in chat_wa_id:
                    chat_wa_id = chat_wa_id.split("@")[0]
                if not is_group and wa_id and "@s.whatsapp.net" in wa_id:
                    wa_id = wa_id.split("@")[0]

                # LID Baileys: campo injetado pelo bridge quando não conseguiu resolver
                # o remoteJid @lid para @s.whatsapp.net a tempo. Contém apenas os dígitos.
                from_lid = msg.get("from_lid", "") or ""

                # BUG: pra mensagens OUTBOUND, "pushName"/"profile.name" no payload
                # (e em contact_map, construído a partir do mesmo msg_obj com
                # wa_id="me") são o nome da NOSSA PRÓPRIA conta, não do contato
                # destinatário — WhatsApp não manda "o nome que o destinatário usa"
                # numa mensagem que nós enviamos. Sem essa guarda, todo envio pra um
                # contato sem nome salvo sobrescrevia Contact.name/push_name com o
                # nome da conta (ex.: toda pessoa nova virava o nome da própria conta).
                if is_outbound:
                    contact_info = {}
                    contact_name = None
                    push_name = ""
                else:
                    contact_info = contact_map.get(wa_id, {}) or contact_map.get(chat_wa_id, {})
                    contact_name = contact_info.get("profile", {}).get("name")
                    push_name = msg.get("pushName") or contact_info.get("pushName", "")
                # Baileys manda reply_to_wamid direto (contextInfo.stanzaId já extraído
                # no bridge); a Meta Cloud API manda a referência em context.id — inclui
                # tanto replies normais (quote) quanto respostas a botão/lista interativa.
                reply_to_wamid = msg.get("reply_to_wamid") or (msg.get("context") or {}).get("id") or None

                if not contact_name:
                    contact_name = push_name or group_name or f"Contato {(chat_wa_id or '')[-4:]}"

                # --- EXTENDED MESSAGE HANDLING CHECK ---
                if msg_type == "order":
                    await webhook_extended.process_order_message(
                        db, msg, wa_id, wamid, timestamp, contact_name, account_id=account_id
                    )
                    continue

                elif msg_type == "referral":
                    await webhook_extended.process_referral_message(
                        db, msg, wa_id, wamid, timestamp, contact_name, account_id=account_id
                    )
                    continue

                elif msg_type == "system":
                    await webhook_extended.process_system_message(
                        db, msg, wa_id, wamid, timestamp, contact_name, account_id=account_id
                    )
                    continue

                elif msg_type == "interactive":
                    interactive_data = msg.get("interactive", {})
                    if interactive_data.get("type") == "nfm_reply":
                        await webhook_extended.process_flow_response(
                            db, msg, wa_id, wamid, timestamp, contact_name, account_id=account_id
                        )
                        continue
                # --- END EXTENDED CHECK ---
                
                logger.info(f"\n{'=' * 60}")
                logger.info(f"MENSAGEM {'ENVIADA' if is_outbound else 'RECEBIDA'}")
                logger.info(f"   WAMID: {wamid}")
                logger.info(f"   De: {wa_id} | Grupo: {is_group} | group_jid: {group_jid}")
                logger.info(f"   Tipo: {msg_type} | Participante: {participant_jid}")
                logger.info(f"   Nome: {contact_name} | push_name: {push_name}")

                if is_group and group_jid:
                    # Contato do grupo: phone_number usa só a parte numérica do JID
                    group_phone = group_jid.split("@")[0]
                    # BUG: "group_display_name" (com fallback "Grupo XXXXXX") é
                    # SEMPRE truthy, e get_or_create_contact sobrescreve
                    # contact.name incondicionalmente quando `name` é truthy.
                    # Resultado: QUALQUER mensagem em que o bridge não resolveu
                    # o group_name a tempo (cache miss, corrida na conexão,
                    # provider ainda sem essa fix, etc.) apagava o nome real já
                    # salvo e voltava pro placeholder — em qualquer um dos N
                    # providers que ecoam o mesmo grupo via multi-device. Passa
                    # o valor bruto (pode ser None): só usado como fallback de
                    # CRIAÇÃO (get_or_create_contact -> _format_phone_display),
                    # nunca para atualizar um contato já existente.
                    contact = self.conversation_service.get_or_create_contact(
                        db=db,
                        wa_id=group_jid,
                        phone_number=group_phone,
                        name=group_name or None,
                        push_name=None,
                        is_group=True,
                        group_subject=group_name,
                    )
                else:
                    # Contato individual: strip @s.whatsapp.net se presente
                    contact_phone = chat_wa_id.split("@")[0] if "@" in (chat_wa_id or "") else (chat_wa_id or "")
                    # Outbound: contact_name aqui é só o placeholder "Contato XXXX" (sem
                    # push_name real do contato) — não pode ser usado pra ATUALIZAR um
                    # contato já existente (sobrescreveria nome real por placeholder a
                    # cada envio). Passa None: get_or_create_contact só usa isso como
                    # fallback de criação (via _format_phone_display), nunca em update.
                    contact = self.conversation_service.get_or_create_contact(
                        db=db,
                        wa_id=chat_wa_id,
                        phone_number=contact_phone,
                        name=(None if is_outbound else contact_name),
                        push_name=push_name,
                        lid=from_lid or None,  # fallback LID→phone quando bridge não resolveu a tempo
                    )

                # Cria/atualiza contato individual de quem enviou de fato (se disponível e
                # resolvido) — vale tanto pra participante de grupo quanto pra quem postou um
                # Status/Stories (contato genérico status@broadcast, participant = autor real,
                # ver bridges). Ignora quando participant_jid ainda é um LID (@lid) não
                # resolvido — evita criar contato fantasma com número numérico falso como wa_id.
                # _format_message (conversation_service.py) já usa participant_jid pra mostrar
                # o remetente real independente do contato "container" da conversa.
                if participant_jid and not is_outbound and not participant_jid.endswith("@lid"):
                    participant_phone = participant_jid.split("@")[0]
                    self.conversation_service.get_or_create_contact(
                        db=db,
                        wa_id=participant_jid,
                        phone_number=participant_phone,
                        name=contact_name,
                        push_name=push_name,
                    )

                conversation = self.conversation_service.get_or_create_conversation(
                    db=db,
                    contact_id=contact.id,
                    account_id=account_id,
                    is_group=is_group,
                    group_jid=group_jid,
                    group_name=group_name,
                    is_history=is_history,
                    is_internal=contact.is_internal,
                )
                
                logger.info(f"   Conversa ID: {conversation.id}")

                if not is_outbound:
                    if _is_stale_inbound(timestamp):
                        # Mensagem chegou com >1h de atraso entre o envio real
                        # (timestamp) e o processamento (agora) — provável
                        # resync de backlog, não atendimento novo de verdade.
                        # Mensagem já foi salva normalmente (histórico
                        # preservado) — só pula reabertura/CSAT/fora-de-horário
                        # e o encaminhamento pro bot, pra não reabrir conversa
                        # resolvida nem gastar token de IA à toa numa mensagem
                        # velha.
                        logger.info(
                            f"   ⏱️ Mensagem com {timestamp} (>{STALE_MESSAGE_THRESHOLD} de atraso) — "
                            f"pulando automações de atendimento e encaminhamento pra IA (conversa {conversation.id})"
                        )
                    elif self._find_existing_message(db, conversation.id, direction_enum, timestamp, wamid):
                        # Reentrega do mesmo evento (cura de ciphertext, retry de
                        # confirmação etc.) — já rodamos automação/IA pra este wamid
                        # na entrega anterior. Reprocessar de novo faz a automação
                        # de atendimento rodar 2x e o bot responder 2x pra UMA
                        # mensagem real do cliente (ver _find_existing_message).
                        logger.info(
                            f"   🔁 WAMID {wamid} já processado nesta conversa — "
                            f"pulando automações de atendimento e encaminhamento pra IA (reentrega, conversa {conversation.id})"
                        )
                    else:
                        handled = await self._run_attendance_automations(db, conversation, contact, wa_id, msg_type, msg, account_id)
                        if not handled:
                            await self._forward_to_ai_webhook(db, conversation, contact, wa_id, msg_type, msg, account_id)

                message_text = None
                caption = None
                media_id = None
                media_url = None
                mime_type = None
                filename = None
                media_file_id = None

                is_media_message = False
                message = None # Placeholder for message object
                should_broadcast = True  # ver comentário no bloco "existing" de texto abaixo
                
                # REAÇÃO (Handles immediately and continues)
                if msg_type == "reaction":
                    reaction_data = msg.get("reaction", {})
                    reaction_emoji = reaction_data.get("emoji", "")
                    reaction_to_wamid = reaction_data.get("message_id")
                    
                    # Escopa por account_id (não por conversation_id): bridges
                    # como wppconnect não conseguem informar de forma confiável
                    # de qual chat veio uma reação (o evento onReactionMessage
                    # só traz msgId + emoji, sem remetente/chat) — então
                    # "conversation" acima pode ter sido resolvida errado pra
                    # esse caso. account_id já está correto (vem do session_id).
                    original_message = db.query(Message).filter(Message.wamid == reaction_to_wamid)
                    if account_id is not None:
                        original_message = original_message.join(
                            Conversation, Message.conversation_id == Conversation.id
                        ).filter(Conversation.account_id == account_id)
                    else:
                        original_message = original_message.filter(Message.conversation_id == conversation.id)
                    original_message = original_message.first()
                    
                    if original_message:
                        original_message.reaction_emoji = reaction_emoji if reaction_emoji else None
                        db.commit()
                        # Emitir via WebSocket
                        await ws_manager.broadcast_reaction_update({
                            "wamid": reaction_to_wamid,
                            "reaction_emoji": original_message.reaction_emoji,
                            "from_number": wa_id,
                            "contact_name": contact_name,
                            "timestamp": timestamp
                        })
                    continue # Skip saving/updating message

                # MEDIA TYPES (Save placeholder -> Download -> Update)
                elif msg_type in ["image", "video", "audio", "voice", "document", "sticker"]:
                    is_media_message = True
                    # "voice" (PTT) é áudio — normaliza para o enum correto
                    stored_type = "audio" if msg_type == "voice" else msg_type
                    msg_data = msg.get(msg_type, {})
                    media_id = msg_data.get("id") or ""
                    # URL direta do bridge Baileys (campo "url" injetado em _normalize_message)
                    direct_url = msg_data.get("url") or None
                    direct_mime = msg_data.get("mime_type") or None

                    if msg_type in ["image", "video", "document"]:
                        caption = msg_data.get("caption")
                    if msg_type == "document":
                        filename = msg_data.get("filename", "document")

                    # 1. Save base message placeholder (idempotente)
                    # Escopado por conversa: o mesmo wamid pode existir em
                    # conversas/contas diferentes (eco multi-device entre
                    # providers ligados ao mesmo número — ver comentário no
                    # model Message). Sem o filtro de conversation_id, a
                    # primeira conta a reportar "roubava" a mensagem das outras.
                    existing = db.query(Message).filter(
                        Message.wamid == wamid, Message.conversation_id == conversation.id
                    ).first() or self._find_history_sync_duplicate(
                        db, conversation.id, direction_enum, timestamp, wamid
                    ) or self._find_wamid_format_duplicate(
                        db, conversation.id, direction_enum, wamid
                    )
                    if existing:
                        message = existing
                        logger.info(f"   WAMID {wamid} já existe no banco, reutilizando registro")
                        # Atualiza pro wamid mais recente/completo quando achado via
                        # _find_wamid_format_duplicate (núcleo igual, prefixo diferente)
                        # — sem isso, um status (delivered/read) que chegar depois
                        # referenciando ESTE formato não encontraria mais a linha.
                        if existing.wamid != wamid:
                            existing.wamid = wamid
                            db.commit()
                        # Retry manual de mídia que falhou ao ser entregue ao banco (ver
                        # POST /bridge/register-failed) — o download logo abaixo já
                        # popula media_url/mime_type de qualquer forma, só falta tirar
                        # do estado de falha e recuperar os campos que o download não cobre.
                        # Cura de ciphertext que decifrou como MÍDIA (foto/PDF/áudio):
                        # o bloco equivalente de texto mais abaixo só cobre texto —
                        # aqui o placeholder "" ficava pra sempre com tipo TEXT.
                        # O download logo abaixo preenche media_url normalmente.
                        if existing.message_text == CIPHERTEXT_PLACEHOLDER:
                            existing.message_type = MessageType(stored_type)
                            existing.message_text = caption or f"[{stored_type.capitalize()}]"
                            existing.caption = caption
                            db.commit()
                            logger.info(f"   WAMID {wamid} atualizado com mídia decifrada (era ciphertext)")
                        if existing.status == MessageStatus.FAILED:
                            existing.participant_jid = participant_jid
                            existing.sender_push_name = push_name or None
                            existing.reply_to_wamid = reply_to_wamid
                            existing.status = MessageStatus.SENT if is_outbound else (
                                MessageStatus.READ if is_history else MessageStatus.DELIVERED
                            )
                            existing.failed_payload = None
                            _new_last_msg_at = datetime.fromtimestamp(timestamp / 1000)
                            if conversation.last_message_at is None or _new_last_msg_at > conversation.last_message_at:
                                conversation.last_message_at = _new_last_msg_at
                            db.commit()
                            logger.info(f"   WAMID {wamid} (mídia) recuperado via retry manual (era FAILED)")
                    else:
                        message = Message(
                            wamid=wamid,
                            conversation_id=conversation.id,
                            contact_id=contact.id,
                            message_type=MessageType(stored_type),
                            direction=direction_enum,
                            participant_jid=participant_jid,
                            sender_push_name=push_name or None,
                            message_text=caption or f"[{stored_type.capitalize()}]",
                            caption=caption,
                            reply_to_wamid=reply_to_wamid,
                            # Histórico (is_history) nunca deve inflar o badge de "não
                            # lida" com mensagens de antes da sessão existir — READ.
                            status=MessageStatus.SENT if is_outbound else (
                                MessageStatus.READ if is_history else MessageStatus.DELIVERED
                            ),
                            timestamp=timestamp,
                            reaction_emoji=None
                        )
                        db.add(message)
                        # BUG: conversation.last_message_at nunca era atualizado aqui —
                        # só era setado uma vez, na criação da conversa. Toda mensagem
                        # nova (de qualquer provider, é este o caminho usado por todos
                        # via webhook) deixava a lista de conversas congelada na ordem
                        # de criação, sem nunca subir pra quem teve atividade recente.
                        # BUG 2 (2026-09-24, achado ao vivo com o backfill manual do
                        # Financeiro): sobrescrevia sem comparar — uma página de
                        # histórico chegando com mensagens de meses/anos atrás jogava
                        # o "última atividade" da conversa pro passado, mesmo com
                        # mensagem de verdade mais recente já registrada (conta #21,
                        # conversas #1578/#1587: last_message_at virou 2025-10-06 e
                        # 2026-09-23 respectivamente, quando a msg real mais recente
                        # era de hoje). Só atualiza se a nova for de fato mais recente.
                        _new_last_msg_at = datetime.fromtimestamp(timestamp / 1000)
                        if conversation.last_message_at is None or _new_last_msg_at > conversation.last_message_at:
                            conversation.last_message_at = _new_last_msg_at
                        db.commit()
                        db.refresh(message)

                    # 2. Download media and update message
                    # BUG (2026-10-04, confirmado ao vivo — 22GB de órfãos em uploads/):
                    # WPPConnect reemite o mesmo Status/Stories 2x (ciphertext→decifrado,
                    # mesmo padrão documentado em _find_wamid_format_duplicate), cada
                    # reemissão com um wamid/media_id diferente. O dedupe de MENSAGEM acima
                    # já reusa a mesma linha (`existing`/`message`) corretamente, mas sem
                    # este guard o passo de mídia baixava e salvava em disco DE NOVO pra
                    # cada reentrega — o 2º arquivo nunca ficava referenciado em
                    # media_files (media_id novo, sem match), só ocupando espaço pra sempre.
                    # Pula quando a mensagem (já existente/reusada) já tem mídia de verdade —
                    # não bloqueia o retry manual (FAILED) nem a cura de ciphertext, que
                    # chegam aqui com media_url ainda vazio.
                    if message.media_url:
                        logger.info(
                            f"   🗄️ Mensagem {message.id} já tem mídia ({message.media_url}) — "
                            f"pulando novo download (reentrega de {media_id or direct_url})"
                        )
                    elif media_id or direct_url:
                        file_path, m_mime_type, m_filename, media_file = await self._download_media(
                            db=db,
                            media_id=media_id or f"bridge_{wamid}",
                            message_id=message.id,
                            direct_url=direct_url,
                            direct_mime_type=direct_mime,
                            account_id=account_id
                        )
                        
                        if media_file:
                            # Arquivo local (bridge): usa /uploads/; Meta API: usa proxy
                            if direct_url and direct_url.startswith("/uploads/"):
                                message.media_url = direct_url
                            else:
                                message.media_url = f"/uploads/{m_filename}" if m_filename else f"/api/media/proxy/{media_id}"
                            message.media_id = media_id
                            message.mime_type = m_mime_type
                            # BUG real (2026-09-10, "nome esquisito" no preview de
                            # documento): m_filename é o nome de ARMAZENAMENTO
                            # (ex.: "<media_id>.pdf" ou o nome que o bridge salvou
                            # em disco) — nunca o nome original que o remetente
                            # usou. `filename` (extraído de msg_data["filename"]
                            # lá em cima, só existe pra msg_type == "document")
                            # é o nome de verdade quando o WhatsApp manda. Usa
                            # esse primeiro, só cai pro nome de armazenamento
                            # quando não há nome original (imagem/vídeo/áudio,
                            # que o WhatsApp não rotula com nome de arquivo).
                            message.filename = filename or m_filename
                            # REMOVIDO: message.media_file_id = media_file.id
                            message.message_text = caption or f"[{msg_type.capitalize()}]"
                            db.commit()
                            db.refresh(message)
                        else:
                            logger.warning(f"   Falha ao baixar mídia {media_id}. Definindo URL de proxy fallback.")
                            message.media_id = media_id
                            message.media_url = f"/api/media/proxy/{media_id}"
                            message.mime_type = direct_mime or "application/octet-stream"
                            message.message_text = caption or f"[{msg_type.capitalize()}]"
                            db.commit()
                            db.refresh(message)

                elif msg_type == "location":
                    import json
                    location_data = msg.get("location", {})
                    message_text = json.dumps({
                        "latitude": location_data.get("latitude"),
                        "longitude": location_data.get("longitude"),
                        "name": location_data.get("name"),
                        "address": location_data.get("address")
                    })
                
                # ENQUETE recebida via wa-web/wppconnect — esses bridges mandam
                # question/options dentro de interactive_payload (norm_type cai em
                # "text" com body vazio, já que "poll" não é tipo mapeado). Baileys
                # não passa por aqui: já pré-formata isso em payload.text no bridge.
                elif msg_type == "text" and (msg.get("interactive_payload") or {}).get("type") == "poll":
                    poll_data = msg["interactive_payload"]
                    poll_question = poll_data.get("question") or "Enquete"
                    poll_options  = poll_data.get("options") or []
                    message_text  = f"📊 {poll_question}\n" + "\n".join(f"☐ {opt}" for opt in poll_options)

                # TEXTO
                elif msg_type == "text":
                    text_data = msg.get("text", {})
                    message_text = text_data.get("body", "")

                # RESPOSTA DE BOTÃO/LISTA (nfm_reply já foi tratado acima)
                elif msg_type == "interactive":
                    interactive_data = msg.get("interactive", {})
                    interactive_type = interactive_data.get("type")

                    if interactive_type == "button_reply":
                        button_reply = interactive_data.get("button_reply", {})
                        message_text = button_reply.get("title", "")
                    elif interactive_type == "list_reply":
                        list_reply = interactive_data.get("list_reply", {})
                        message_text = list_reply.get("title", "")
                        if list_reply.get("description"):
                            message_text += f"\n{list_reply.get('description')}"
                    else:
                        logger.warning(f"   Subtipo interativo não suportado: {interactive_type}")
                        message_text = f"[Interativo: {interactive_type}]"

                # CLIQUE EM BOTÃO DE TEMPLATE (quick reply)
                elif msg_type == "button":
                    button_data = msg.get("button", {})
                    message_text = button_data.get("text", "")

                # CONTATO COMPARTILHADO (vCard)
                elif msg_type == "contact":
                    message_text = _format_contact_card_text(
                        msg.get("vcard", ""), msg.get("vcard_name", ""), msg.get("vcards")
                    )

                # Outros tipos
                else:
                    # Should be handled by extended handlers, but fallback here
                    logger.warning(f"   Tipo de mensagem não suportado: {msg_type}")
                    message_text = f"[Mensagem de tipo {msg_type}]"

                # FINAL SALVAR MENSAGEM (APENAS PARA NÃO-MÍDIA)
                
                if not is_media_message and msg_type != "reaction":
                    # Idempotência: se wamid já existe NESTA CONVERSA, reutiliza
                    # (evita Duplicate entry quando o bridge reenvia a confirmação
                    # de mensagens outbound). Escopado por conversation_id — ver
                    # comentário no model Message sobre eco multi-device entre
                    # providers ligados ao mesmo número real.
                    existing = db.query(Message).filter(
                        Message.wamid == wamid, Message.conversation_id == conversation.id
                    ).first() or self._find_history_sync_duplicate(
                        db, conversation.id, direction_enum, timestamp, wamid
                    ) or self._find_wamid_format_duplicate(
                        db, conversation.id, direction_enum, wamid
                    )
                    if existing:
                        message = existing
                        logger.info(f"   WAMID {wamid} já existe, reutilizando (ID: {existing.id})")
                        # Atualiza pro wamid mais recente/completo quando achado via
                        # _find_wamid_format_duplicate (núcleo igual, prefixo
                        # diferente) — ver definição do método pra contexto
                        # completo do bug. Sem isso, um status (delivered/read)
                        # que chegar depois referenciando ESTE formato não
                        # encontraria mais a linha.
                        if existing.wamid != wamid:
                            existing.wamid = wamid
                            db.commit()
                        # BUG (2026-09-03): esta reutilização "muda" o wamid pro
                        # request atual (bridge reenvia a confirmação da mensagem
                        # outbound por um caminho separado do envio original — ver
                        # routes.py /send/text, que não emite websocket ele mesmo),
                        # mas o broadcast mais abaixo era incondicional pra
                        # QUALQUER `message` truthy, inclusive este caso em que nada
                        # mudou. O front deduplica por wamid na maioria das vezes,
                        # mas sob corrida (o eco chega antes da resposta HTTP do
                        # envio) ou reação de borda na heurística de dedupe (ver
                        # App.js) a bolha duplicada escapava e só sumia com F5.
                        # Suprime aqui; os dois casos abaixo que realmente mudam
                        # algo (cura de ciphertext, retry de FAILED) reativam.
                        should_broadcast = False
                        # "Cura" o placeholder de ciphertext: a lib do bridge reemite a
                        # mensagem com o tipo real quando consegue decifrar depois (não
                        # é definitivo — ver CIPHERTEXT_PLACEHOLDER). Sem isso, o
                        # placeholder ficava permanente mesmo quando o conteúdo real
                        # chegava segundos/minutos depois com o mesmo wamid.
                        if (existing.message_text == CIPHERTEXT_PLACEHOLDER
                                and message_text and message_text != CIPHERTEXT_PLACEHOLDER):
                            existing.message_text = message_text
                            if msg_type in [t.value for t in MessageType]:
                                existing.message_type = MessageType(msg_type)
                            db.commit()
                            should_broadcast = True
                            logger.info(f"   WAMID {wamid} atualizado com conteúdo decifrado (era ciphertext)")
                        # Retry manual (ícone "!" no front) de uma mensagem que o bridge
                        # não conseguiu entregar ao banco na hora — placeholder criado
                        # por POST /bridge/register-failed. Substitui pelo conteúdo real
                        # e sai do estado de falha; o broadcast de websocket mais abaixo
                        # já cobre o "reaparecer" na conversa com o texto certo.
                        elif existing.status == MessageStatus.FAILED:
                            existing.message_text = message_text
                            existing.caption = caption
                            existing.participant_jid = participant_jid
                            existing.sender_push_name = push_name or None
                            existing.reply_to_wamid = reply_to_wamid
                            existing.interactive_payload = msg.get("interactive_payload")
                            if msg_type in [t.value for t in MessageType]:
                                existing.message_type = MessageType(msg_type)
                            existing.status = MessageStatus.SENT if is_outbound else (
                                MessageStatus.READ if is_history else MessageStatus.DELIVERED
                            )
                            existing.failed_payload = None
                            _new_last_msg_at = datetime.fromtimestamp(timestamp / 1000)
                            if conversation.last_message_at is None or _new_last_msg_at > conversation.last_message_at:
                                conversation.last_message_at = _new_last_msg_at
                            db.commit()
                            should_broadcast = True
                            logger.info(f"   WAMID {wamid} recuperado via retry manual (era FAILED)")
                    else:
                        message = Message(
                            wamid=wamid,
                            conversation_id=conversation.id,
                            contact_id=contact.id,
                            message_type=MessageType(msg_type) if msg_type in [t.value for t in MessageType] else MessageType.TEXT,
                            direction=direction_enum,
                            participant_jid=participant_jid,
                            sender_push_name=push_name or None,
                            message_text=message_text,
                            caption=caption,
                            reply_to_wamid=reply_to_wamid,
                            # Histórico (is_history) nunca deve inflar o badge de "não
                            # lida" com mensagens de antes da sessão existir — READ.
                            status=MessageStatus.SENT if is_outbound else (
                                MessageStatus.READ if is_history else MessageStatus.DELIVERED
                            ),
                            timestamp=timestamp,
                            reaction_emoji=None,
                            # Dados estruturados de enquete recebida (question/options) —
                            # sem isso o front só via texto genérico, sem as opções reais.
                            interactive_payload=msg.get("interactive_payload"),
                        )
                        db.add(message)
                        # Mesma correção do bloco de mídia acima — ver comentário lá
                        # (inclusive o BUG 2, só atualiza se for de fato mais recente).
                        _new_last_msg_at = datetime.fromtimestamp(timestamp / 1000)
                        if conversation.last_message_at is None or _new_last_msg_at > conversation.last_message_at:
                            conversation.last_message_at = _new_last_msg_at
                        db.commit()
                        db.refresh(message)

                # EMITIR VIA WEBSOCKET
                
                if message:
                    logger.info(f"   Mensagem salva/atualizada no banco (ID: {message.id})")

                    # Sinal de conversão (clique em botão de template MARKETING)
                    # pro Business Manager — msg_type "button" só existe como
                    # resposta inbound a um quick-reply de template enviado por
                    # nós. No-op silencioso se Pixel não configurado.
                    if msg_type == "button" and not is_outbound:
                        from backend.services.conversions_api import send_conversion_event
                        await send_conversion_event(
                            db=db,
                            event_name="LeadSubmitted",
                            wa_id=wa_id,
                            event_id=f"button-{message.id}",
                        )

                    # Para grupos: from_number é o telefone do participante real
                    if is_group and participant_jid:
                        ws_from_number = participant_jid.split("@")[0]
                    elif not is_outbound:
                        ws_from_number = chat_wa_id.split("@")[0] if "@" in (chat_wa_id or "") else chat_wa_id
                    else:
                        ws_from_number = "me"

                    # Nome do participante em grupos: NUNCA usa push_name (autodeclarado) —
                    # só mostra nome se o participante está salvo na agenda (Contact.saved_name).
                    # Sem isso, a mensagem que chega em tempo real (websocket) mostraria o
                    # push_name mesmo pra quem não está salvo, diferente do histórico já corrigido.
                    if is_group and not is_outbound:
                        ws_contact_name = ""
                        if ws_from_number:
                            participant_contact = db.query(Contact).filter(
                                Contact.phone_number == ws_from_number,
                                Contact.is_group == False,
                            ).first()
                            ws_contact_name = (participant_contact.saved_name if participant_contact else None) or ""
                    else:
                        ws_contact_name = push_name or contact_name

                    message_data = {
                        "id": message.id,
                        "wamid": message.wamid,
                        "type": message.message_type.value,
                        "direction": message.direction.value,
                        "from_number": ws_from_number,
                        "contact_name": ws_contact_name,
                        "push_name": push_name,
                        "sender_push_name": push_name or "",
                        "is_group": is_group,
                        "group_jid": group_jid,
                        "group_name": group_name,
                        "participant_jid": participant_jid,
                        "message": message.message_text or message.caption or f"[{message.message_type.value}]",
                        "caption": message.caption,
                        "media_id": message.media_id,
                        "mediaUrl": message.media_url,
                        "mime_type": message.mime_type,
                        "filename": message.filename,
                        "timestamp": message.timestamp,
                        "status": message.status.value,
                        "sender": "me" if is_outbound else "contact",
                        "conversation_id": conversation.id,
                        "reaction_emoji": message.reaction_emoji,
                        "reply_to_wamid": msg.get("reply_to_wamid"),
                        "interactive_payload": msg.get("interactive_payload"),
                    }
                    
                    if should_broadcast:
                        await ws_manager.broadcast_new_message(message_data)
                        logger.info(f"   WebSocket emitido: new_message")
                    else:
                        logger.info(f"   WebSocket suprimido (reprocessamento do mesmo wamid, nada novo pro front)")
                
                logger.info(f"{'=' * 60}\n")
            
            except Exception as e:
                logger.error(f"Erro ao processar mensagem individual: {e}", exc_info=True)
                # Incidente 2026-09-11: sem isso, um IntegrityError (ex.: wamid
                # duplicado — comum ao parear um fallback Baileys, que recebe
                # um reenvio de histórico recente que se sobrepõe ao que a
                # conta primária já salvou) deixa a Session no estado
                # "transaction has been rolled back due to a previous
                # exception during flush" — TODA mensagem seguinte deste
                # mesmo lote (usando a mesma Session) falha em cascata com
                # esse erro genérico, mesmo sendo mensagens novas e
                # legítimas sem nenhuma relação com o duplicado original.
                db.rollback()
                continue

    async def process_template_status(
        self,
        db: Session,
        entry: Dict[str, Any]
    ):
        """
        Processa atualizações de status de templates
        
        Webhook recebe quando template é:
        - approved (aprovado)
        - rejected (rejeitado)
        - paused (pausado)
        - disabled (desabilitado)
        """
        try:
            changes = entry.get("changes", [])
            
            for change in changes:
                value = change.get("value", {})
                
                # Extrair informações do template
                message_template_id = value.get("message_template_id")
                message_template_name = value.get("message_template_name")
                message_template_language = value.get("message_template_language")
                event = value.get("event")  # APPROVED, REJECTED, etc
                reason = value.get("reason", "")
                
                logger.info("=" * 70)
                logger.info("TEMPLATE STATUS UPDATE")
                logger.info(f"   Template: {message_template_name}")
                logger.info(f"   Language: {message_template_language}")
                logger.info(f"   Event: {event}")
                logger.info(f"   Reason: {reason}")

                # Invalida o cache local (routes_templates.py) — sem isso, o
                # dashboard de templates podia continuar mostrando um status
                # aprovado/pendente por até 30min depois da Meta já ter
                # rejeitado/pausado o template de verdade.
                try:
                    from backend.api.routes_templates import TemplateCacheModel
                    if message_template_name:
                        deleted = (
                            db.query(TemplateCacheModel)
                            .filter(TemplateCacheModel.name == message_template_name)
                            .delete()
                        )
                        db.commit()
                        if deleted:
                            logger.info(f"   Cache local de '{message_template_name}' invalidado ({deleted} linha(s))")
                except Exception as cache_exc:
                    logger.error(f"   Erro ao invalidar cache de template: {cache_exc}")
                    db.rollback()

                # Persiste como AccountAlert — sem isso, o evento só existia
                # enquanto alguém tivesse o painel aberto no exato momento do
                # WebSocket (mesma classe de gap do webhook de qualidade de
                # número, corrigida junto).
                try:
                    severity = "critical" if (event or "").upper() in ("REJECTED", "DISABLED") else (
                        "warning" if (event or "").upper() == "PAUSED" else "info"
                    )
                    db.add(AccountAlert(
                        alert_type="template_status_update",
                        field=message_template_language,
                        severity=severity,
                        message=f"Template '{message_template_name}': {event}",
                        reason=reason or None,
                        notified=False,
                    ))
                    db.commit()
                except Exception as alert_exc:
                    logger.error(f"   Erro ao registrar AccountAlert de template: {alert_exc}")
                    db.rollback()

                # Emitir via WebSocket para notificar frontend
                await ws_manager.sio.emit('template_status', { # Using ws_manager.sio.emit directly if the helper function wasn't updated
                    "type": "template_status",
                    "data": {
                        "template_id": message_template_id,
                        "template_name": message_template_name,
                        "language": message_template_language,
                        "event": event.lower(),
                        "reason": reason,
                        "timestamp": int(time.time())
                    }
                })
                
                logger.info("   WebSocket emitido: template_status")
                logger.info("=" * 70)
        
        except Exception as e:
            logger.error(f"Erro ao processar template status: {e}", exc_info=True)

    async def process_account_alerts(self, db: Session, entry: Dict[str, Any]):
        """Processa alertas da conta com persistência e notificação"""
        try:
            changes = entry.get("changes", [])
            
            for change in changes:
                value = change.get("value", {})
                field = change.get("field", "")
                
                # Determinar severidade
                quality_rating = value.get("quality", {}).get("rating")
                if quality_rating == "RED":
                    severity = "critical"
                elif quality_rating == "YELLOW":
                    severity = "warning"
                else:
                    severity = "info"
                
                # Salvar no banco de dados
                alert = AccountAlert(
                    alert_type=field,
                    field=field,
                    severity=severity,
                    message=f"Alert received for {field}",
                    phone_number=value.get("phone"),
                    quality_rating=quality_rating,
                    current_limit=value.get("daily_conversation_limit", {}).get("current_count"),
                    decision=value.get("decision"),
                    reason=value.get("reason"),
                    notified=False,
                    created_at=datetime.utcnow()
                )
                
                db.add(alert)
                db.commit()
                db.refresh(alert)
                
                logger.info(f"Alert salvo no banco: ID={alert.id}, Severity={alert.severity}")
                
                # Enviar email para alertas críticos
                if alert.severity == "critical":
                    await self._send_critical_alert_email(db, alert)
                
                # Emitir via WebSocket 
                await ws_manager.sio.emit('account_alert', {
                    "type": "account_alert",
                    "data": {
                        "id": alert.id,
                        "field": field,
                        "severity": severity,
                        "message": alert.message,
                        "timestamp": alert.created_at.isoformat()
                    }
                })
        
        except Exception as e:
            logger.error(f"Erro ao processar account alert: {e}", exc_info=True)
            db.rollback()
            
    async def _send_critical_alert_email(self, db: Session, alert: AccountAlert):
        """Envia email real (SMTP) para alertas críticos."""
        try:
            admin_email = os.getenv("ADMIN_EMAIL")
            if not admin_email:
                logger.warning("ADMIN_EMAIL não configurado, e-mail de alerta não enviado")
                return

            subject = f"ALERTA CRÍTICO: {alert.alert_type} - {alert.severity.upper()}"
            body = f"""
ALERTA CRÍTICO DO WHATSAPP

Tipo: {alert.alert_type}
Severidade: {alert.severity}
Telefone: {alert.phone_number}
Qualidade: {alert.quality_rating}
Motivo: {alert.reason}

Data: {alert.created_at}

Por favor, verifique imediatamente o Meta Business Manager.
            """

            msg = MIMEText(body)
            msg['Subject'] = subject
            msg['From'] = os.getenv("SMTP_FROM", "noreply@whatsapp-system.com")
            msg['To'] = admin_email

            smtp_server = os.getenv("SMTP_SERVER")
            smtp_port = os.getenv("SMTP_PORT")
            smtp_user = os.getenv("SMTP_USER")
            smtp_password = os.getenv("SMTP_PASSWORD")

            if not (smtp_server and smtp_port and smtp_user and smtp_password):
                # Honesto: se faltar config, não finge que enviou.
                logger.warning(
                    "⚠️ SMTP incompleto (SMTP_SERVER/PORT/USER/PASSWORD) — "
                    "e-mail de alerta CRÍTICO NÃO enviado (apenas logado)."
                )
                return

            def _send_sync():
                with smtplib.SMTP(smtp_server, int(smtp_port), timeout=15) as server:
                    server.starttls()
                    server.login(smtp_user, smtp_password)
                    server.send_message(msg)

            await asyncio.to_thread(_send_sync)
            logger.info(f"Email de alerta CRÍTICO ({alert.severity}) enviado de verdade para {admin_email}")

            # Marcar como notificado
            alert.notified = True
            db.commit()

        except Exception as e:
            logger.error(f"Erro ao enviar e-mail de alerta: {e}")

    async def process_phone_number_quality(
        self,
        db: Session,
        entry: Dict[str, Any]
    ):
        """
        Processa atualizações de qualidade do número
        """
        try:
            changes = entry.get("changes", [])
            
            for change in changes:
                value = change.get("value", {})
                
                phone_number = value.get("phone_number")
                display_phone_number = value.get("display_phone_number")
                quality_score = value.get("current_quality")
                previous_quality = value.get("previous_quality")
                
                logger.info("=" * 70)
                logger.info("PHONE NUMBER QUALITY UPDATE")
                logger.info(f"   Number: {display_phone_number}")
                logger.info(f"   Quality: {previous_quality} → {quality_score}")

                # Determinar emoji baseado na qualidade
                quality_emoji = {
                    "GREEN": "🟢",
                    "YELLOW": "🟡",
                    "RED": "🔴"
                }.get(quality_score, "⚪️")

                # Persiste — mesmo padrão do process_account_alerts (que já
                # grava AccountAlert pra field="quality"); antes esse handler
                # era o único dos três "eventos de conta" que só emitia
                # WebSocket sem gravar nada.
                try:
                    severity = "critical" if quality_score == "RED" else (
                        "warning" if quality_score == "YELLOW" else "info"
                    )
                    db.add(AccountAlert(
                        alert_type="phone_number_quality_update",
                        field="quality",
                        severity=severity,
                        message=f"Qualidade do número {display_phone_number}: {previous_quality} → {quality_score}",
                        phone_number=phone_number or display_phone_number,
                        quality_rating=quality_score,
                        notified=False,
                    ))
                    db.commit()
                except Exception as alert_exc:
                    logger.error(f"   Erro ao registrar AccountAlert de qualidade: {alert_exc}")
                    db.rollback()

                # Emitir via WebSocket
                await ws_manager.sio.emit('phone_quality_update', { # Using ws_manager.sio.emit directly if the helper function wasn't updated
                    "type": "phone_quality_update",
                    "data": {
                        "phone_number": display_phone_number,
                        "current_quality": quality_score,
                        "previous_quality": previous_quality,
                        "emoji": quality_emoji,
                        "timestamp": int(time.time())
                    }
                })
                
                logger.info(f"   {quality_emoji} WebSocket emitido: phone_quality_update")
                logger.info("=" * 70)
        
        except Exception as e:
            logger.error(f"Erro ao processar phone quality: {e}", exc_info=True)

    
    async def _process_message_statuses(self, db: Session, value: Dict[str, Any]):
        """
        Processa atualizações de status de mensagens enviadas
        """
        statuses = value.get("statuses", [])
        
        logger.info(f"Processando {len(statuses)} status(es)...")
        
        for status in statuses:
            try:
                wamid = status.get("id")
                status_value = status.get("status")
                error_info = None

                logger.info(f"   WAMID: {wamid} -> Status: {status_value}")

                # Buscar mensagem no banco
                message = db.query(Message).filter(Message.wamid == wamid).first()

                if message:
                    # Preço/janela de conversa (status.pricing / status.conversation) —
                    # a Meta manda isso em quase todo status "sent"/"delivered", usado
                    # pra reconciliar com a fatura. Nem sempre vem "conversation" (a
                    # Meta vem migrando templates de CBP pra PMP, que não usa esse
                    # objeto), então trata como opcional.
                    pricing = status.get("pricing") or {}
                    if pricing:
                        message.meta_pricing_category = pricing.get("category")
                        message.meta_pricing_model = pricing.get("pricing_model")
                        message.meta_pricing_billable = pricing.get("billable")
                    conv_info = status.get("conversation") or {}
                    if conv_info:
                        message.meta_conversation_id = conv_info.get("id")
                        message.meta_conversation_origin = (conv_info.get("origin") or {}).get("type")
                        expiration = conv_info.get("expiration_timestamp")
                        if expiration:
                            try:
                                message.meta_conversation_expiration_ts = int(expiration)
                            except (TypeError, ValueError):
                                pass

                    # Atualizar status
                    if status_value == "delivered":
                        message.status = MessageStatus.DELIVERED
                    elif status_value == "read":
                        message.status = MessageStatus.READ
                    elif status_value == "failed":
                        message.status = MessageStatus.FAILED
                        # A Meta envia o motivo da falha dentro de "errors" no próprio status
                        errors = status.get("errors", [])
                        if errors:
                            error_info = errors[0]
                            logger.warning(
                                f"   ❌ Falha de entrega — WAMID {wamid}: "
                                f"[{error_info.get('code')}] {error_info.get('title')} — "
                                f"{error_info.get('error_data', {}).get('details', '')}"
                            )
                            try:
                                db.add(AccountAlert(
                                    alert_type="message_delivery_failed",
                                    severity="warning",
                                    message=error_info.get("title", "Falha ao entregar mensagem"),
                                    phone_number=status.get("recipient_id"),
                                    reason=error_info.get("error_data", {}).get("details") or error_info.get("message"),
                                ))
                            except Exception as alert_exc:
                                logger.error(f"   Erro ao registrar AccountAlert de falha: {alert_exc}")

                    db.commit()
                    logger.info(f"   Status atualizado no banco")

                    # Emitir via WebSocket
                    try:
                        await ws_manager.broadcast_message_status(
                            wamid,
                            status_value,
                            error=error_info
                        )
                        logger.info(f"   WebSocket emitido: message_status_update")
                    except Exception as e:
                        logger.error(f"   Erro ao emitir status via WebSocket: {e}")
                else:
                    logger.warning(f"   Mensagem {wamid} não encontrada no banco")

            except Exception as e:
                logger.error(f"Erro ao processar status individual: {e}", exc_info=True)
                continue


# INSTÂNCIA GLOBAL (ADICIONAR ESTA SEÇÃO)

import os
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv()

# Criar instncia global do webhook handler
webhook_handler = WebhookHandler()

# webhook_handler_coexistence.py não importa este módulo (evita import
# circular) — recebe a referência do método aqui, uma vez, no import.
webhook_coexistence.bind(webhook_handler._process_incoming_messages)

logger.info("Webhook handler global inicializado")

