# backend/api/routes_site_chat.py
"""
Canal "Chat do Site" (plugin WordPress/WooCommerce).

Endpoints PÚBLICOS (chamados pelo widget no navegador do visitante, de outra
origem — autenticados por site_key + token do visitante, protegidos por CORS
próprio, checagem de origem e rate limit):
    POST /api/site-chat/session    abre/retoma a sessão do visitante
    POST /api/site-chat/messages   visitante envia mensagem
    GET  /api/site-chat/messages   long-poll de mensagens novas (resposta do atendente)

Endpoints AUTENTICADOS (painel do atendimento):
    GET  /api/site-chat/accounts/{id}/config
    POST /api/site-chat/accounts/{id}/rotate-secret
    GET  /api/site-chat/contacts/{contact_id}/visitor

Inbound reaproveita o pipeline de webhook (webhook_handler.process_webhook):
contato/conversa/fila/SLA/WebSocket/push funcionam igual a uma conta de
WhatsApp. Outbound sai pelo fluxo normal /api/send/text (SiteChatProvider só
acorda o long-poll); a mensagem fica no banco e o widget a busca daqui.

O widget só enxerga o protocolo ativo (24h sem atividade — ver
backend/services/site_chat_protocol.py); o painel mantém o histórico inteiro.
Dúvidas de produto do tema ficam em routes_site_chat_questions.py.

Todo acesso ao banco roda em SITE_CHAT_EXECUTOR com sessão própria — pymysql é
síncrono e travaria o único event loop do processo (ver incidente 2026-09-02).
"""
import asyncio
import hashlib
import hmac
import io
import json
import logging
import re
import secrets
import time
import uuid
import zipfile
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.database.connection import SessionLocal, get_db
from backend.database.models import (
    Conversation,
    Direction,
    Message,
    MessageType,
    SiteChatVisitor,
    WhatsAppAccount,
)
from backend.providers.site_chat_provider import SITE_CHAT_EXECUTOR, site_chat_hub
from backend.services import site_chat_protocol as protocols

logger = logging.getLogger(__name__)

router_site_chat = APIRouter(prefix="/api/site-chat", tags=["Site Chat"])

PUBLIC_PATHS = ("/api/site-chat/session", "/api/site-chat/messages")
MAX_TEXT_LEN = 4000
IDENTITY_MAX_AGE_S = 600
LONG_POLL_MAX_S = 25


# CORS só para os endpoints públicos (widget roda no domínio da loja).
# Middleware ASGI outermost: o CORSMiddleware global rejeita preflight de
# origens fora da lista do painel. A origem permitida de fato é validada por
# conta, dentro da rota (allowed_origins).
class SiteChatCORSMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") not in PUBLIC_PATHS:
            return await self.app(scope, receive, send)

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        origin = headers.get("origin")
        cors = []
        if origin:
            cors = [
                (b"access-control-allow-origin", origin.encode("latin-1")),
                (b"vary", b"Origin"),
            ]

        if scope["method"] == "OPTIONS":
            resp_headers = cors + [
                (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
                (b"access-control-allow-headers", b"Content-Type, ngrok-skip-browser-warning"),
                (b"access-control-max-age", b"600"),
                (b"content-length", b"0"),
            ]
            await send({"type": "http.response.start", "status": 204, "headers": resp_headers})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start" and cors:
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + cors
            await send(message)

        await self.app(scope, receive, send_wrapper)


# Rate limit em memória (processo único). Janela deslizante.
class _RateLimiter:
    def __init__(self) -> None:
        self._hits: Dict[str, deque] = defaultdict(deque)

    def check(self, key: str, limit: int, window_s: int) -> bool:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > window_s:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        if len(self._hits) > 20000:
            for k in [k for k, v in self._hits.items() if not v or now - v[-1] > window_s]:
                self._hits.pop(k, None)
        return True


_limiter = _RateLimiter()


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


async def _run(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(SITE_CHAT_EXECUTOR, fn, *args)


# Config da conta (site_key / site_secret / allowed_origins em provider_config)
def _cfg(account: WhatsAppAccount) -> Dict[str, Any]:
    raw = account.provider_config
    if not raw:
        return {}
    try:
        return json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (json.JSONDecodeError, TypeError):
        return {}


def _save_cfg(account: WhatsAppAccount, cfg: Dict[str, Any]) -> None:
    account.provider_config = json.dumps(cfg)


def _ensure_keys(db: Session, account: WhatsAppAccount) -> Dict[str, Any]:
    cfg = _cfg(account)
    if not cfg.get("site_key") or not cfg.get("site_secret"):
        cfg["site_key"] = cfg.get("site_key") or "sk_" + secrets.token_hex(12)
        cfg["site_secret"] = cfg.get("site_secret") or secrets.token_hex(32)
        _save_cfg(account, cfg)
        db.commit()
        _key_cache.clear()
    return cfg


_key_cache: Dict[str, tuple] = {}  # site_key -> (account_id, expires_monotonic)


def _account_by_site_key(db: Session, site_key: str) -> Optional[WhatsAppAccount]:
    if not site_key or len(site_key) > 64:
        return None
    hit = _key_cache.get(site_key)
    if hit and hit[1] > time.monotonic():
        acc = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == hit[0]).first()
        if acc and acc.is_active and not acc.deleted_at and _cfg(acc).get("site_key") == site_key:
            return acc
        _key_cache.pop(site_key, None)
    accounts = (
        db.query(WhatsAppAccount)
        .filter(WhatsAppAccount.provider_type == "site_chat", WhatsAppAccount.deleted_at.is_(None))
        .all()
    )
    for acc in accounts:
        cfg = _ensure_keys(db, acc) if acc.is_active else _cfg(acc)
        if cfg.get("site_key") and hmac.compare_digest(str(cfg["site_key"]), site_key):
            if not acc.is_active:
                return None
            _key_cache[site_key] = (acc.id, time.monotonic() + 60)
            return acc
    return None


def _origin_allowed(account: WhatsAppAccount, origin: Optional[str]) -> bool:
    allowed = [o.strip().rstrip("/").lower() for o in (_cfg(account).get("allowed_origins") or []) if o and o.strip()]
    if not allowed:
        return True
    return bool(origin) and origin.rstrip("/").lower() in allowed


def _verify_identity(secret: str, ident: Dict[str, Any]) -> bool:
    try:
        ts = int(ident.get("ts", 0))
        if abs(time.time() - ts) > IDENTITY_MAX_AGE_S:
            return False
        msg = "|".join(str(ident.get(k, "")) for k in ("wp_user_id", "email", "name", "phone")) + f"|{ts}"
        expected = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, str(ident.get("sig", "")))
    except Exception:
        return False


# Serialização de mensagens para o widget
_PREFIX_RE = re.compile(r"^\*([^*\n]{1,120})\*\n")


def _serialize(m: Message) -> Dict[str, Any]:
    outbound = m.direction == Direction.OUTBOUND
    text = m.message_text or ""
    agent = None
    if outbound:
        pm = _PREFIX_RE.match(text)
        if pm:
            agent = pm.group(1).split(" - ")[0].strip()
            text = text[pm.end():]
    if m.message_type != MessageType.TEXT and not text:
        text = m.caption or "[anexo]"
    return {
        "id": m.id,
        "from": "agent" if outbound else "visitor",
        "agent": agent,
        "text": text,
        "ts": int(m.timestamp or 0),
    }


def _conversation_for(db: Session, visitor: SiteChatVisitor) -> Optional[Conversation]:
    if not visitor.contact_id:
        return None
    return (
        db.query(Conversation)
        .filter(Conversation.contact_id == visitor.contact_id, Conversation.account_id == visitor.account_id)
        .first()
    )


def _messages_after(db: Session, visitor: SiteChatVisitor, after: int, limit: int = 100) -> List[Dict[str, Any]]:
    conv = _conversation_for(db, visitor)
    if not conv:
        return []
    proto = protocols.active_protocol(db, visitor)
    if not proto:
        return []
    q = db.query(Message).filter(
        Message.conversation_id == conv.id,
        Message.id > after,
        Message.timestamp >= proto.started_ms,
        Message.message_type != MessageType.REACTION,
        ~Message.wamid.startswith("sysnotif_", autoescape=True),
        # Dúvida de produto é pública no site (seção "Dúvidas"), não do chat box.
        ~Message.wamid.startswith("siteQ_", autoescape=True),
    )
    if after <= 0:
        rows = q.order_by(Message.id.desc()).limit(50).all()[::-1]
    else:
        rows = q.order_by(Message.id.asc()).limit(limit).all()
    return [_serialize(m) for m in rows]


def _touch(db: Session, visitor: SiteChatVisitor, page_url=None, page_title=None, ua=None) -> None:
    now = datetime.utcnow()
    changed = False
    if not visitor.last_seen_at or (now - visitor.last_seen_at).total_seconds() > 60:
        visitor.last_seen_at = now
        changed = True
    if page_url and page_url[:2000] != visitor.last_page_url:
        visitor.last_page_url = page_url[:2000]
        changed = True
    if page_title and page_title[:255] != visitor.last_page_title:
        visitor.last_page_title = page_title[:255]
        changed = True
    if ua and not visitor.user_agent:
        visitor.user_agent = ua[:255]
        changed = True
    if changed:
        db.commit()


def _visitor_by_token(db: Session, account_id: int, token: str) -> Optional[SiteChatVisitor]:
    if not token or len(token) > 64:
        return None
    v = db.query(SiteChatVisitor).filter(SiteChatVisitor.token == token).first()
    if v and v.account_id == account_id:
        return v
    return None


def _clean(value: Any, n: int) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s[:n] or None


def _new_visitor(db: Session, account_id: int) -> SiteChatVisitor:
    v = SiteChatVisitor(
        account_id=account_id,
        token=secrets.token_urlsafe(32)[:64],
        wa_id=f"site{account_id}x{secrets.token_hex(8)}@site.chat",
    )
    db.add(v)
    db.commit()
    db.refresh(v)
    return v


# Schemas
class Identity(BaseModel):
    wp_user_id: int
    name: Optional[str] = ""
    email: Optional[str] = ""
    phone: Optional[str] = ""
    ts: int
    sig: str


class SessionIn(BaseModel):
    site_key: str
    token: Optional[str] = None
    identity: Optional[Identity] = None
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    page_url: Optional[str] = None
    page_title: Optional[str] = None


class SendIn(BaseModel):
    site_key: str
    token: str
    text: str = Field(..., min_length=1)
    page_url: Optional[str] = None
    page_title: Optional[str] = None


# Públicos
def _session_sync(body: SessionIn, origin: Optional[str], ua: Optional[str]) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        account = _account_by_site_key(db, body.site_key)
        if not account:
            return {"error": 404, "detail": "Chave do site inválida."}
        if not _origin_allowed(account, origin):
            return {"error": 403, "detail": "Origem não autorizada."}
        cfg = _cfg(account)

        visitor = None
        verified = False
        ident = body.identity
        if ident and _verify_identity(cfg["site_secret"], ident.dict()):
            verified = True
            visitor = (
                db.query(SiteChatVisitor)
                .filter(SiteChatVisitor.account_id == account.id, SiteChatVisitor.wp_user_id == ident.wp_user_id)
                .first()
            )
            if not visitor:
                # Visitante anônimo que acabou de logar: promove o registro dele
                # (mantém a conversa já iniciada) em vez de duplicar.
                anon = _visitor_by_token(db, account.id, body.token or "")
                visitor = anon if anon and not anon.wp_user_id else _new_visitor(db, account.id)
                visitor.wp_user_id = ident.wp_user_id
            visitor.verified = True
            visitor.name = _clean(ident.name, 255) or visitor.name
            visitor.email = _clean(ident.email, 255) or visitor.email
            visitor.phone = _clean(ident.phone, 50) or visitor.phone
        else:
            visitor = _visitor_by_token(db, account.id, body.token or "") or _new_visitor(db, account.id)
            if not visitor.verified:
                visitor.name = _clean(body.name, 255) or visitor.name
                visitor.email = _clean(body.email, 255) or visitor.email
                visitor.phone = _clean(body.phone, 50) or visitor.phone
            verified = bool(visitor.verified)
        db.commit()
        _touch(db, visitor, body.page_url, body.page_title, ua)

        return {
            "token": visitor.token,
            "verified": verified,
            "name": visitor.name,
            "needs_identity": not (verified or visitor.name),
            "protocol": protocols.public_info(protocols.latest_protocol(db, visitor.id), protocols.ttl_hours_for_account(db, visitor.account_id)),
            "messages": _messages_after(db, visitor, 0),
        }
    finally:
        db.close()


@router_site_chat.post("/session")
async def open_session(body: SessionIn, request: Request):
    ip = _client_ip(request)
    if not _limiter.check(f"sess:{ip}", 30, 60):
        raise HTTPException(status_code=429, detail="Muitas requisições.")
    out = await _run(_session_sync, body, request.headers.get("origin"), request.headers.get("user-agent"))
    if "error" in out:
        raise HTTPException(status_code=out["error"], detail=out["detail"])
    return out


def _prepare_send_sync(body: SendIn, origin: Optional[str]) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        account = _account_by_site_key(db, body.site_key)
        if not account:
            return {"error": 404, "detail": "Chave do site inválida."}
        if not _origin_allowed(account, origin):
            return {"error": 403, "detail": "Origem não autorizada."}
        visitor = _visitor_by_token(db, account.id, body.token)
        if not visitor:
            return {"error": 401, "detail": "Sessão inválida."}
        _touch(db, visitor, body.page_url, body.page_title)
        return {
            "account_id": account.id,
            "visitor_id": visitor.id,
            "wa_id": visitor.wa_id,
            "name": visitor.name or "Visitante do site",
        }
    finally:
        db.close()


def _ingest_sync(
    account_id: int,
    visitor_id: int,
    wa_id: str,
    name: str,
    text: str,
    wamid: str,
    interactive_payload: Optional[Dict[str, Any]] = None,
    protocol_reason: Optional[str] = "chat do site",
) -> Dict[str, Any]:
    from backend.api.routes_bridge import _build_webhook_payload
    from backend.services.webhook_handler import webhook_handler

    db = SessionLocal()
    try:
        msg_obj = {
            "id": wamid,
            "from": wa_id,
            "to": "",
            "type": "text",
            "timestamp": str(int(time.time())),
            "pushName": name,
            "direction": "inbound",
            "is_group": False,
            "text": {"body": text},
        }
        if interactive_payload:
            msg_obj["interactive_payload"] = interactive_payload
        payload = _build_webhook_payload("site_chat", f"site_{account_id}", account_id, msg_obj)
        result = asyncio.run(webhook_handler.process_webhook(db, payload, account_id=account_id))
        if result.get("status") == "error":
            raise RuntimeError(result.get("message"))

        from backend.database.models import Contact
        contact = db.query(Contact).filter(Contact.wa_id == wa_id).first()
        visitor = db.query(SiteChatVisitor).filter(SiteChatVisitor.id == visitor_id).first()
        if contact and visitor and visitor.contact_id != contact.id:
            visitor.contact_id = contact.id
            db.commit()
        conv = _conversation_for(db, visitor) if visitor else None
        saved = (
            db.query(Message).filter(Message.conversation_id == conv.id, Message.wamid == wamid).first()
            if conv else None
        )
        trigger_ms = int(saved.timestamp) if saved and saved.timestamp else protocols.now_ms()
        proto = None
        if visitor and protocol_reason:
            proto, _ = protocols.ensure_protocol(db, visitor, conv, trigger_ms, reason=protocol_reason)
        out = _serialize(saved) if saved else {"id": 0, "from": "visitor", "agent": None, "text": text, "ts": int(time.time() * 1000)}
        out["_protocol"] = protocols.public_info(proto, protocols.ttl_hours_for_account(db, account_id))
        out["_conversation_id"] = conv.id if conv else None
        return out
    finally:
        db.close()


@router_site_chat.post("/messages")
async def visitor_send(body: SendIn, request: Request):
    ip = _client_ip(request)
    if not _limiter.check(f"send-ip:{ip}", 60, 60) or not _limiter.check(f"send-tok:{body.token[:16]}", 20, 60):
        raise HTTPException(status_code=429, detail="Muitas mensagens. Aguarde um instante.")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Mensagem vazia.")
    if len(text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=400, detail="Mensagem muito longa.")

    ctx = await _run(_prepare_send_sync, body, request.headers.get("origin"))
    if "error" in ctx:
        raise HTTPException(status_code=ctx["error"], detail=ctx["detail"])

    try:
        msg = await _run(
            _ingest_sync, ctx["account_id"], ctx["visitor_id"], ctx["wa_id"], ctx["name"], text,
            f"siteIn_{uuid.uuid4().hex}",
        )
    except Exception:
        logger.exception("[SiteChat] falha ao processar mensagem do visitante")
        raise HTTPException(status_code=500, detail="Não foi possível enviar a mensagem.")
    proto = msg.pop("_protocol", None)
    msg.pop("_conversation_id", None)
    return {"success": True, "message": msg, "protocol": proto}


def _poll_fetch_sync(account_id: int, visitor_id: int, after: int) -> Optional[List[Dict[str, Any]]]:
    db = SessionLocal()
    try:
        visitor = db.query(SiteChatVisitor).filter(SiteChatVisitor.id == visitor_id).first()
        if not visitor or visitor.account_id != account_id:
            return None
        return _messages_after(db, visitor, after)
    finally:
        db.close()


def _poll_auth_sync(site_key: str, token: str, origin: Optional[str]) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        account = _account_by_site_key(db, site_key)
        if not account:
            return {"error": 404, "detail": "Chave do site inválida."}
        if not _origin_allowed(account, origin):
            return {"error": 403, "detail": "Origem não autorizada."}
        visitor = _visitor_by_token(db, account.id, token)
        if not visitor:
            return {"error": 401, "detail": "Sessão inválida."}
        _touch(db, visitor)
        return {"account_id": account.id, "visitor_id": visitor.id}
    finally:
        db.close()


@router_site_chat.get("/messages")
async def poll_messages(site_key: str, token: str, request: Request, after: int = 0, wait: int = 0):
    ip = _client_ip(request)
    if not _limiter.check(f"poll-ip:{ip}", 120, 60):
        raise HTTPException(status_code=429, detail="Muitas requisições.")
    ctx = await _run(_poll_auth_sync, site_key, token, request.headers.get("origin"))
    if "error" in ctx:
        raise HTTPException(status_code=ctx["error"], detail=ctx["detail"])

    vid, aid = ctx["visitor_id"], ctx["account_id"]
    wait = max(0, min(wait, LONG_POLL_MAX_S))
    event = site_chat_hub.register(vid)
    try:
        deadline = time.monotonic() + wait
        while True:
            msgs = await _run(_poll_fetch_sync, aid, vid, after)
            if msgs is None:
                raise HTTPException(status_code=401, detail="Sessão inválida.")
            if msgs or wait == 0:
                return {"messages": msgs}
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"messages": []}
            event.clear()
            try:
                await asyncio.wait_for(event.wait(), timeout=min(remaining, 5))
                # O provider acorda o poll antes de a rota de envio salvar a
                # mensagem no banco — pequena folga evita ler antes do commit.
                await asyncio.sleep(0.4)
            except asyncio.TimeoutError:
                pass
    finally:
        site_chat_hub.unregister(vid, event)


# Autenticados (painel)
def _get_site_account(db: Session, account_id: int) -> WhatsAppAccount:
    acc = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == account_id).first()
    if not acc or acc.provider_type != "site_chat" or acc.deleted_at:
        raise HTTPException(status_code=404, detail="Conta de chat do site não encontrada.")
    return acc


def _auth_dep():
    from backend.api.routes_settings import _require_auth
    return _require_auth


@router_site_chat.get("/accounts/{account_id}/config")
async def get_config(account_id: int, request: Request, db: Session = Depends(get_db), _auth=Depends(_auth_dep())):
    from backend.api.routes_settings import _require_perm
    _require_perm(db, _auth, "settings_accounts")
    acc = _get_site_account(db, account_id)
    cfg = _ensure_keys(db, acc)
    base = str(request.base_url).rstrip("/")
    return {
        "success": True,
        "data": {
            "site_key": cfg["site_key"],
            "site_secret": cfg["site_secret"],
            "allowed_origins": cfg.get("allowed_origins") or [],
            "api_base_url": cfg.get("api_base_url") or base,
            "protocol_ttl_hours": protocols.clamp_ttl_hours(cfg.get("protocol_ttl_hours", protocols.DEFAULT_TTL_HOURS)),
        },
    }


class ConfigUpdate(BaseModel):
    allowed_origins: Optional[List[str]] = None
    api_base_url: Optional[str] = None
    protocol_ttl_hours: Optional[int] = None


@router_site_chat.put("/accounts/{account_id}/config")
async def update_config(account_id: int, body: ConfigUpdate, db: Session = Depends(get_db), _auth=Depends(_auth_dep())):
    from backend.api.routes_settings import _require_perm
    _require_perm(db, _auth, "settings_accounts")
    acc = _get_site_account(db, account_id)
    cfg = _ensure_keys(db, acc)
    if body.allowed_origins is not None:
        cfg["allowed_origins"] = [o.strip().rstrip("/") for o in body.allowed_origins if o.strip()]
    if body.api_base_url is not None:
        cfg["api_base_url"] = body.api_base_url.strip().rstrip("/") or None
    if body.protocol_ttl_hours is not None:
        if not protocols.MIN_TTL_HOURS <= body.protocol_ttl_hours <= protocols.MAX_TTL_HOURS:
            raise HTTPException(
                status_code=422,
                detail=f"A duração do protocolo deve ficar entre {protocols.MIN_TTL_HOURS} e {protocols.MAX_TTL_HOURS} horas.",
            )
        cfg["protocol_ttl_hours"] = body.protocol_ttl_hours
    _save_cfg(acc, cfg)
    db.commit()
    return {"success": True}


@router_site_chat.post("/accounts/{account_id}/rotate-secret")
async def rotate_secret(account_id: int, db: Session = Depends(get_db), _auth=Depends(_auth_dep())):
    from backend.api.routes_settings import _require_perm
    _require_perm(db, _auth, "settings_accounts")
    acc = _get_site_account(db, account_id)
    cfg = _ensure_keys(db, acc)
    cfg["site_secret"] = secrets.token_hex(32)
    _save_cfg(acc, cfg)
    db.commit()
    return {"success": True, "site_secret": cfg["site_secret"]}


@router_site_chat.get("/contacts/{contact_id}/visitor")
async def contact_visitor(contact_id: int, db: Session = Depends(get_db), _auth=Depends(_auth_dep())):
    rows = (
        db.query(SiteChatVisitor)
        .filter(SiteChatVisitor.contact_id == contact_id)
        .order_by(SiteChatVisitor.last_seen_at.desc())
        .all()
    )
    return {
        "success": True,
        "data": [
            {
                "account_id": v.account_id,
                "verified": bool(v.verified),
                "wp_user_id": v.wp_user_id,
                "name": v.name,
                "email": v.email,
                "phone": v.phone,
                "last_page_url": v.last_page_url,
                "last_page_title": v.last_page_title,
                "first_seen_at": v.first_seen_at.isoformat() if v.first_seen_at else None,
                "last_seen_at": v.last_seen_at.isoformat() if v.last_seen_at else None,
            }
            for v in rows
        ],
    }


# Download do plugin WordPress já pré-configurado para esta conta
PLUGIN_DIR = Path(__file__).resolve().parents[2] / "woocommerce-plugin" / "wpp-site-chat"


@router_site_chat.get("/accounts/{account_id}/plugin.zip")
async def download_plugin(account_id: int, request: Request, db: Session = Depends(get_db), _auth=Depends(_auth_dep())):
    from backend.api.routes_settings import _require_perm
    _require_perm(db, _auth, "settings_accounts")
    acc = _get_site_account(db, account_id)
    cfg = _ensure_keys(db, acc)
    if not PLUGIN_DIR.is_dir():
        raise HTTPException(status_code=500, detail="Arquivos do plugin não encontrados no servidor.")

    api_base = cfg.get("api_base_url") or str(request.base_url).rstrip("/")
    esc = lambda v: str(v).replace("\\", "\\\\").replace("'", "\\'")
    preconfig = (
        "<?php\n// Gerado pelo painel — contém o segredo da conta. Não compartilhe este arquivo.\n"
        "if (!defined('ABSPATH')) { exit; }\n"
        "return array(\n"
        f"    'api_base_url' => '{esc(api_base)}',\n"
        f"    'site_key'     => '{esc(cfg['site_key'])}',\n"
        f"    'site_secret'  => '{esc(cfg['site_secret'])}',\n"
        ");\n"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(PLUGIN_DIR.rglob("*")):
            if f.is_file() and f.name != "preconfig.php":
                z.write(f, f"wpp-site-chat/{f.relative_to(PLUGIN_DIR).as_posix()}")
        z.writestr("wpp-site-chat/preconfig.php", preconfig)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="wpp-site-chat.zip"'},
    )
