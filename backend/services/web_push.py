"""
web_push.py — envio de notificação Web Push de verdade (chega no computador
da pessoa mesmo com o navegador fechado, só não com a máquina desligada/sem
internet — pedido explícito pros lembretes de tarefa com prazo/pausada não
dependerem de alguma aba do app estar aberta, diferente da Notification API
simples usada em notifyNewMessage no front).

Cada usuário pode ter várias PushSubscription (um por navegador/dispositivo
que deu permissão) — send_push_to_user manda pra todas. Inscrição inválida
(pessoa revogou a permissão no navegador, ou o navegador expirou a
inscrição) o próprio serviço de push devolve 404/410 — nesse caso apagamos
a subscription daqui, ela não vale mais e ia falhar pra sempre.
"""
import json
import logging
import os

from pywebpush import webpush, WebPushException
from sqlalchemy.orm import Session

from backend.database.models import PushSubscription

logger = logging.getLogger(__name__)

VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "")
VAPID_CLAIMS_EMAIL = os.getenv("VAPID_CLAIMS_EMAIL", "mailto:admin@example.com")


def push_configured() -> bool:
    return bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY)


def send_push_to_user(db: Session, user_id: int, title: str, body: str, url: str = "/app", tag: str = None) -> None:
    """Manda pra todas as inscrições desse usuário — nunca lança (falha de
    push nunca deveria derrubar o fluxo que chamou, ver mesma filosofia do
    try/except em notifyNewMessage no front). Silenciosamente não faz nada
    se as chaves VAPID não estiverem configuradas (.env)."""
    if not push_configured():
        return

    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
    if not subs:
        return

    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    stale_ids = []

    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_CLAIMS_EMAIL},
            )
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status in (404, 410):
                stale_ids.append(sub.id)
            else:
                logger.warning(f"[WebPush] Falha ao enviar pra subscription #{sub.id} (user {user_id}): {exc}")
        except Exception as exc:
            logger.error(f"[WebPush] Erro inesperado enviando pra subscription #{sub.id}: {exc}", exc_info=True)

    if stale_ids:
        db.query(PushSubscription).filter(PushSubscription.id.in_(stale_ids)).delete(synchronize_session=False)
        db.commit()
