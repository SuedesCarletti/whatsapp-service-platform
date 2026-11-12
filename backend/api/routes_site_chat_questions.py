# backend/api/routes_site_chat_questions.py
"""
Dúvidas de produto do tema WooCommerce (ecomall-child) <-> painel.

    POST /api/site-chat/product-question   site -> painel (HMAC do corpo bruto)

A dúvida cai na MESMA conversa do cliente no chat do site quando ele já é um
visitante conhecido (wp_user_id, depois e-mail, depois telefone); senão cria o
visitante. A mensagem leva o produto em interactive_payload (type
"product_question") pro painel desenhar o card (imagem, specs, link, estoque).

A dúvida NÃO aparece no chat box do cliente nem abre/renova protocolo: ela é
pública no site (seção "Dúvidas") e só existe no painel, como card.

Resposta (duas vias, qualquer uma encerra a dúvida):
  - Painel: o atendente responde CITANDO o card (reply_to). routes.py chama
    answer_question_from_panel(): a resposta vai SÓ ao site (POST assinado no
    callback_url), nunca ao chat box.
  - Site:   alguém responde no WordPress (Comentários -> Responder) e o tema
    avisa POST /api/site-chat/product-question/answered (HMAC); o card passa
    a "respondida no site".
Mensagem digitada sem citar o card continua indo para o chat box, como sempre.

Todo acesso ao banco roda em SITE_CHAT_EXECUTOR.
"""
import asyncio
import hashlib
import hmac
import html as html_lib
import ipaddress
import json
import logging
import re
import socket
import time
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from backend.api.routes_site_chat import (
    _account_by_site_key,
    _cfg,
    _client_ip,
    _ingest_sync,
    _limiter,
    _new_visitor,
    _run,
)
from backend.database.connection import SessionLocal
from backend.database.models import (
    Message,
    SiteChatProductQuestion,
    SiteChatVisitor,
    WhatsAppAccount,
)

logger = logging.getLogger(__name__)

router_site_chat_questions = APIRouter(prefix="/api/site-chat", tags=["Site Chat"])

MAX_BODY_BYTES = 64 * 1024
MAX_QUESTION_LEN = 2000
STORE_API_TIMEOUT_S = 4.0
CALLBACK_TIMEOUT_S = 10.0
ANSWER_RETRY_DELAYS_S = (0, 10, 60)
SIGNATURE_HEADER = "x-wpp-signature"

_background: set = set()


# Helpers de segurança
def _valid_signature(secret: str, raw: bytes, header: Optional[str]) -> bool:
    if not header:
        return False
    given = header.strip()
    if given.lower().startswith("sha256="):
        given = given[7:]
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, given.lower())


def _http_url(value: Any, max_len: int = 2000) -> Optional[str]:
    """Só http(s) — o painel renderiza como href/src, então javascript: etc. nunca passa."""
    if not isinstance(value, str):
        return None
    v = value.strip()[:max_len]
    p = urlparse(v)
    return v if p.scheme in ("http", "https") and p.netloc else None


def _host_matches(host: str, origin: str) -> bool:
    oh = (urlparse(origin).hostname or "").lower()
    host = host.lower()
    return bool(oh) and (host == oh or host.endswith("." + oh) or oh.endswith("." + host))


def _check_callback_url(account: WhatsAppAccount, url: Any) -> Optional[str]:
    """
    Devolve a URL validada ou None. O painel vai fazer um POST nela, então:
    http(s), host dentro das origens da conta (quando configuradas) e nunca
    um endereço interno (SSRF) — checado de novo na hora do envio.
    """
    clean = _http_url(url)
    if not clean:
        return None
    host = urlparse(clean).hostname or ""
    origins = [o for o in (_cfg(account).get("allowed_origins") or []) if o and o.strip()]
    if origins and not any(_host_matches(host, o) for o in origins):
        return None
    try:
        infos = socket.getaddrinfo(host, urlparse(clean).port or (443 if clean.startswith("https") else 80))
    except socket.gaierror:
        return None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                or ip.is_reserved or ip.is_unspecified):
            return None
    return clean


# Normalização do produto (dados do tema + complemento via Store API pública)
def _text(value: Any, n: int) -> Optional[str]:
    if value is None:
        return None
    s = html_lib.unescape(str(value)).strip()
    return s[:n] or None


def _html_to_lines(raw: str) -> List[str]:
    s = re.sub(r"(?i)<\s*(br|/p|/li|/h[1-6]|/div|/tr)\s*/?>", "\n", raw or "")
    s = re.sub(r"<[^>]+>", "", s)
    s = html_lib.unescape(s).replace("\xa0", " ")
    return [ln.strip() for ln in s.split("\n") if ln.strip()]


_SPEC_LINE = re.compile(r"^([^:\d][^:]{1,38}):\s*(\S.{0,198})$")


def _specs_from_description(raw: str, limit: int = 14) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for ln in _html_to_lines(raw):
        m = _SPEC_LINE.match(ln)
        if m:
            out.append({"name": m.group(1).strip(), "value": m.group(2).strip()})
        if len(out) >= limit:
            break
    return out


def _coerce_specs(raw: Any) -> List[Dict[str, str]]:
    """Aceita lista de {name,value}, lista de 'Nome: valor', dict ou texto livre."""
    items: List[Any]
    if isinstance(raw, dict):
        items = [{"name": k, "value": v} for k, v in raw.items()]
    elif isinstance(raw, list):
        items = raw
    elif isinstance(raw, str):
        items = _html_to_lines(raw)
    else:
        return []
    out: List[Dict[str, str]] = []
    for it in items:
        if isinstance(it, dict):
            name, value = _text(it.get("name") or it.get("label"), 80), _text(it.get("value"), 300)
        else:
            m = _SPEC_LINE.match(str(it).strip())
            name, value = (m.group(1).strip(), m.group(2).strip()) if m else (None, _text(it, 300))
        if value:
            out.append({"name": name or "", "value": value})
        if len(out) >= 20:
            break
    return out


def _fetch_store_product(origin: str, product_id: Any) -> Optional[Dict[str, Any]]:
    try:
        pid = int(product_id)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    try:
        with httpx.Client(timeout=STORE_API_TIMEOUT_S, follow_redirects=False) as c:
            r = c.get(f"{origin}/wp-json/wc/store/v1/products/{pid}", headers={"Accept": "application/json"})
        if r.status_code != 200:
            return None
        data = r.json()
        return data if isinstance(data, dict) else None
    except Exception as exc:
        logger.info("[SiteChat] Store API indisponível para produto %s: %s", pid, exc)
        return None


def _stock_info(raw: Dict[str, Any], store: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    status = _text(raw.get("stock_status"), 20)
    status = status.lower().replace("_", "") if status else None
    qty = raw.get("stock_quantity")
    try:
        qty = int(qty) if qty not in (None, "") else None
    except (TypeError, ValueError):
        qty = None
    low = None
    if store:
        if status is None:
            status = "onbackorder" if store.get("is_on_backorder") else ("instock" if store.get("is_in_stock") else "outofstock")
        low = store.get("low_stock_remaining")
    if qty is not None and status is None:
        status = "instock" if qty > 0 else "outofstock"

    if status == "outofstock" or (qty is not None and qty <= 0 and status != "onbackorder"):
        label = "Sem estoque"
        status = "outofstock"
    elif status == "onbackorder":
        label = "Sob encomenda"
    elif qty is not None:
        label = f"{qty} unidade{'s' if qty != 1 else ''} em estoque"
    elif low:
        label = f"Últimas {low} unidade{'s' if low != 1 else ''}"
    elif status == "instock":
        label = "Em estoque (quantidade não informada)"
    else:
        label = "Estoque não informado"
    return {"status": status, "quantity": qty if qty is not None else (int(low) if low else None),
            "exact": qty is not None, "label": label}


def _build_product(raw: Any, origin: str) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    store = _fetch_store_product(origin, raw.get("id"))

    specs = _coerce_specs(raw.get("specs") or raw.get("attributes"))
    summary = _text(raw.get("short_description"), 400)
    image = _http_url(raw.get("image"))
    if store:
        if not specs:
            for a in store.get("attributes") or []:
                terms = ", ".join(t.get("name", "") for t in (a.get("terms") or []) if t.get("name"))
                if a.get("name") and terms:
                    specs.append({"name": a["name"], "value": terms})
            specs += _specs_from_description(store.get("description") or "")
        if not summary:
            summary = _text(" ".join(_html_to_lines(store.get("short_description") or "")), 400)
        if not image:
            imgs = store.get("images") or []
            image = _http_url(imgs[0].get("src")) if imgs and isinstance(imgs[0], dict) else None
    return {
        "id": raw.get("id"),
        "name": _text(raw.get("name"), 255) or (_text(store.get("name"), 255) if store else None) or "Produto",
        "sku": _text(raw.get("sku"), 100) or (_text(store.get("sku"), 100) if store else None),
        "url": _http_url(raw.get("url")) or (_http_url(store.get("permalink")) if store else None),
        "image": image,
        "price": _text(raw.get("price"), 60),
        "summary": summary,
        "specs": specs[:20],
        "stock": _stock_info(raw, store),
    }


# Mesmo cliente => mesma conversa
def _digits(v: Any) -> str:
    return re.sub(r"\D", "", str(v or ""))


def _resolve_visitor(db, account: WhatsAppAccount, cust: Dict[str, Any]) -> SiteChatVisitor:
    name = _text(cust.get("name"), 255)
    email = (_text(cust.get("email"), 255) or "").lower() or None
    phone = _text(cust.get("phone"), 50)
    try:
        wp_user_id = int(cust.get("wp_user_id") or 0)
    except (TypeError, ValueError):
        wp_user_id = 0

    base = db.query(SiteChatVisitor).filter(SiteChatVisitor.account_id == account.id)
    visitor = base.filter(SiteChatVisitor.wp_user_id == wp_user_id).first() if wp_user_id > 0 else None

    def compatible(v: SiteChatVisitor) -> bool:
        return wp_user_id <= 0 or v.wp_user_id in (None, wp_user_id)

    if not visitor and email:
        for v in base.filter(func.lower(SiteChatVisitor.email) == email).order_by(SiteChatVisitor.last_seen_at.desc()).all():
            if compatible(v):
                visitor = v
                break
    if not visitor and len(_digits(phone)) >= 8:
        tail = _digits(phone)[-9:]
        for v in (base.filter(SiteChatVisitor.phone.isnot(None))
                  .order_by(SiteChatVisitor.last_seen_at.desc()).limit(500).all()):
            if _digits(v.phone)[-9:] == tail and compatible(v):
                visitor = v
                break
    if not visitor:
        visitor = _new_visitor(db, account.id)

    if wp_user_id > 0 and not visitor.wp_user_id:
        visitor.wp_user_id = wp_user_id
        visitor.verified = True
    if wp_user_id > 0 and visitor.verified:
        visitor.name = name or visitor.name
    else:
        visitor.name = visitor.name or name
    visitor.email = visitor.email or email
    visitor.phone = visitor.phone or phone
    visitor.last_seen_at = datetime.utcnow()
    db.commit()
    return visitor


# Site -> painel
def _receive_sync(raw: bytes, signature: Optional[str]) -> Dict[str, Any]:
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return {"error": 400, "detail": "JSON inválido."}
    if not isinstance(data, dict):
        return {"error": 400, "detail": "JSON inválido."}

    db = SessionLocal()
    try:
        account = _account_by_site_key(db, str(data.get("site_key") or ""))
        if not account:
            return {"error": 401, "detail": "Chave do site inválida."}
        secret = _cfg(account).get("site_secret") or ""
        if not secret or not _valid_signature(secret, raw, signature):
            return {"error": 401, "detail": "Assinatura inválida."}

        try:
            external_id = int(data.get("external_id"))
        except (TypeError, ValueError):
            return {"error": 400, "detail": "external_id inválido."}
        question = _text(data.get("question"), MAX_QUESTION_LEN)
        if not question:
            return {"error": 400, "detail": "Pergunta vazia."}

        if (db.query(SiteChatProductQuestion.id)
                .filter(SiteChatProductQuestion.account_id == account.id,
                        SiteChatProductQuestion.external_id == external_id).first()):
            return {"ok": True, "duplicate": True}

        callback = _check_callback_url(account, data.get("callback_url"))
        if not callback:
            return {"error": 400, "detail": "callback_url inválida ou fora das origens autorizadas."}
        cp = urlparse(callback)
        product = _build_product(data.get("product"), f"{cp.scheme}://{cp.netloc}")

        cust = data.get("customer") if isinstance(data.get("customer"), dict) else {}
        visitor = _resolve_visitor(db, account, cust)

        wamid = f"siteQ_{account.id}_{external_id}"
        payload = {
            "type": "product_question",
            "question_id": external_id,
            "question": question,
            "status": "pending",
            "product": product,
        }
        text = f"❓ Dúvida sobre o produto «{product['name']}»\n\n{question}"
        out = _ingest_sync(
            account.id, visitor.id, visitor.wa_id, visitor.name or "Visitante do site", text, wamid,
            interactive_payload=payload, protocol_reason=None,
        )

        row = SiteChatProductQuestion(
            account_id=account.id, visitor_id=visitor.id, external_id=external_id,
            callback_url=callback, question=question, wamid=wamid,
        )
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return {"ok": True, "duplicate": True}
        return {"ok": True, "conversation_id": out.get("_conversation_id")}
    except Exception:
        logger.exception("[SiteChat] falha ao registrar dúvida de produto")
        db.rollback()
        return {"error": 500, "detail": "Falha ao registrar a dúvida."}
    finally:
        db.close()


@router_site_chat_questions.post("/product-question")
async def product_question(request: Request):
    if not _limiter.check(f"pq:{_client_ip(request)}", 60, 60):
        raise HTTPException(status_code=429, detail="Muitas requisições.")
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Corpo grande demais.")
    out = await _run(_receive_sync, raw, request.headers.get(SIGNATURE_HEADER))
    if "error" in out:
        raise HTTPException(status_code=out["error"], detail=out["detail"])
    return out


# Estado do card (interactive_payload) + eventos de tela
_inflight: set = set()


def _emit_update(data: Dict[str, Any]) -> None:
    from backend.api.websocket import ws_manager
    try:
        asyncio.run(ws_manager._emit("product_question_update", data))
    except Exception:
        logger.warning("[SiteChat] falha ao emitir product_question_update", exc_info=True)


def _set_card_sync(wamid: str, **fields: Any) -> Optional[int]:
    """Atualiza o payload do card, avisa as telas abertas e devolve o conversation_id."""
    db = SessionLocal()
    try:
        msg = db.query(Message).filter(Message.wamid == wamid).first()
        if not msg:
            return None
        payload = dict(msg.interactive_payload or {})
        payload.update(fields)
        msg.interactive_payload = payload
        db.commit()
        conv_id = msg.conversation_id
    finally:
        db.close()
    _emit_update({"conversation_id": conv_id, "wamid": wamid, **fields})
    return conv_id


def _question_state_sync(wamid: str) -> Dict[str, Any]:
    db = SessionLocal()
    try:
        q = db.query(SiteChatProductQuestion).filter(SiteChatProductQuestion.wamid == wamid).first()
        if not q:
            return {"state": "missing"}
        if q.answered_at:
            return {"state": "answered"}
        return {"state": "pending", "id": q.id}
    finally:
        db.close()


def _mark_answered_sync(q: SiteChatProductQuestion, db, answer: str, agent: str, via: str) -> Optional[int]:
    """Grava a resposta na linha da dúvida e no card. Quem chama faz commit e emite o evento."""
    q.answered_at = datetime.utcnow()
    q.answer_text = answer
    q.answer_agent = (agent or "")[:255]
    q.last_error = None
    msg = db.query(Message).filter(Message.wamid == q.wamid).first()
    if not msg:
        return None
    payload = dict(msg.interactive_payload or {})
    payload.update({
        "status": "answered", "answered_by": agent, "answer": answer, "answered_via": via,
        "answered_at": q.answered_at.isoformat(), "error": None,
    })
    msg.interactive_payload = payload
    return msg.conversation_id


# Painel -> site (resposta do atendente)
def _deliver_sync(question_row_id: int, answer: str, agent: str) -> Dict[str, Any]:
    """Uma tentativa de POST assinado. retry=False em erros permanentes (401/404/URL inválida)."""
    db = SessionLocal()
    try:
        q = db.query(SiteChatProductQuestion).filter(SiteChatProductQuestion.id == question_row_id).first()
        if not q or q.answered_at:
            return {"done": True}
        account = db.query(WhatsAppAccount).filter(WhatsAppAccount.id == q.account_id).first()
        secret = _cfg(account).get("site_secret") if account else None
        q.answer_attempts = (q.answer_attempts or 0) + 1

        def fail(msg: str, retry: bool) -> Dict[str, Any]:
            q.last_error = msg[:500]
            db.commit()
            return {"done": False, "retry": retry, "error": msg}

        if not secret or not account:
            return fail("Conta/segredo do site indisponível.", False)
        if not _check_callback_url(account, q.callback_url):
            return fail("callback_url recusada na validação.", False)

        body = json.dumps(
            {"question_id": q.external_id, "answer": answer, "agent": agent, "ts": int(time.time())},
            ensure_ascii=False, separators=(",", ":"),
        ).encode("utf-8")
        sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        try:
            with httpx.Client(timeout=CALLBACK_TIMEOUT_S, follow_redirects=False) as c:
                r = c.post(q.callback_url, content=body, headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "X-LF-Signature": f"sha256={sig}",
                })
        except Exception as exc:
            return fail(f"Falha de rede: {exc}", True)

        if r.status_code == 200:
            conv_id = _mark_answered_sync(q, db, answer, agent, "painel")
            db.commit()
            return {"done": True, "conversation_id": conv_id, "wamid": q.wamid, "answer": answer, "agent": agent}
        permanent = r.status_code in (400, 401, 403, 404, 410)
        return fail(f"Site respondeu HTTP {r.status_code}", not permanent)
    finally:
        db.close()


def _deliver_with_retries_sync(question_row_id: int, wamid: str, answer: str, agent: str) -> None:
    last_error = "Falha desconhecida."
    for delay in ANSWER_RETRY_DELAYS_S:
        if delay:
            time.sleep(delay)
        res = _deliver_sync(question_row_id, answer, agent)
        if res.get("done"):
            if res.get("conversation_id"):
                _emit_update({
                    "conversation_id": res["conversation_id"], "wamid": res["wamid"], "status": "answered",
                    "answered_by": res["agent"], "answer": res["answer"], "answered_via": "painel", "error": None,
                })
            return
        last_error = res.get("error") or last_error
        logger.warning("[SiteChat] resposta de dúvida %s não entregue: %s", question_row_id, last_error)
        if not res.get("retry"):
            break
    # Esgotou: o card volta a aceitar resposta e mostra o motivo.
    _set_card_sync(wamid, status="delivery_failed", error=last_error[:300])


def _start_answer_sync(wamid: str) -> None:
    _set_card_sync(wamid, status="sending", error=None)


async def answer_question_from_panel(reply_to_wamid: str, answer: str, agent: str) -> str:
    """
    Chamada pela rota de envio quando o atendente responde CITANDO um card de
    dúvida. Devolve "ok" | "answered" | "missing" | "busy". A entrega ao site
    roda em segundo plano (com retentativas); o resultado chega ao card por
    evento de WebSocket.
    """
    state = await _run(_question_state_sync, reply_to_wamid)
    if state["state"] == "missing":
        return "missing"
    if state["state"] == "answered":
        return "answered"
    qid = state["id"]
    if qid in _inflight:
        return "busy"
    _inflight.add(qid)
    try:
        await _run(_start_answer_sync, reply_to_wamid)
    except Exception:
        _inflight.discard(qid)
        raise
    task = asyncio.get_running_loop().create_task(
        _run(_deliver_with_retries_sync, qid, reply_to_wamid, answer, agent)
    )
    _background.add(task)

    def _done(t):
        _background.discard(t)
        _inflight.discard(qid)

    task.add_done_callback(_done)
    return "ok"


# Site -> painel (resposta dada no WordPress)
ANSWER_TS_TOLERANCE_S = 600


def _answered_from_site_sync(raw: bytes, signature: Optional[str]) -> Dict[str, Any]:
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return {"error": 400, "detail": "JSON inválido."}
    if not isinstance(data, dict):
        return {"error": 400, "detail": "JSON inválido."}

    db = SessionLocal()
    emit = None
    try:
        account = _account_by_site_key(db, str(data.get("site_key") or ""))
        if not account:
            return {"error": 401, "detail": "Chave do site inválida."}
        secret = _cfg(account).get("site_secret") or ""
        if not secret or not _valid_signature(secret, raw, signature):
            return {"error": 401, "detail": "Assinatura inválida."}
        try:
            ts = int(data.get("ts"))
        except (TypeError, ValueError):
            return {"error": 401, "detail": "Requisição expirada."}
        if abs(time.time() - ts) > ANSWER_TS_TOLERANCE_S:
            return {"error": 401, "detail": "Requisição expirada."}
        try:
            external_id = int(data.get("question_id"))
        except (TypeError, ValueError):
            return {"error": 400, "detail": "question_id inválido."}
        answer = _text(data.get("answer"), MAX_QUESTION_LEN)
        if not answer:
            return {"error": 400, "detail": "Resposta vazia."}
        agent = _text(data.get("agent"), 120) or "Site"

        q = (
            db.query(SiteChatProductQuestion)
            .filter(SiteChatProductQuestion.account_id == account.id,
                    SiteChatProductQuestion.external_id == external_id)
            .with_for_update()
            .first()
        )
        if not q:
            return {"error": 404, "detail": "Dúvida não encontrada."}
        if q.answered_at:
            return {"ok": True, "duplicate": True}
        conv_id = _mark_answered_sync(q, db, answer, agent, "site")
        db.commit()
        if conv_id:
            emit = {
                "conversation_id": conv_id, "wamid": q.wamid, "status": "answered",
                "answered_by": agent, "answer": answer, "answered_via": "site", "error": None,
            }
        out = {"ok": True}
    except Exception:
        logger.exception("[SiteChat] falha ao registrar resposta dada no site")
        db.rollback()
        return {"error": 500, "detail": "Falha ao registrar a resposta."}
    finally:
        db.close()
    if emit:
        _emit_update(emit)
    return out


@router_site_chat_questions.post("/product-question/answered")
async def product_question_answered(request: Request):
    if not _limiter.check(f"pqa:{_client_ip(request)}", 60, 60):
        raise HTTPException(status_code=429, detail="Muitas requisições.")
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Corpo grande demais.")
    out = await _run(_answered_from_site_sync, raw, request.headers.get(SIGNATURE_HEADER))
    if "error" in out:
        raise HTTPException(status_code=out["error"], detail=out["detail"])
    return out
