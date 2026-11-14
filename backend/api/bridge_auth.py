"""Autenticação das chamadas servidor→servidor dos bridges (Baileys / wa-web / WPPConnect).

Os bridges não têm usuário/JWT: eles se identificam com um segredo compartilhado
no header ``X-Bridge-Secret``.

- ``BRIDGE_SHARED_SECRET`` definido  -> o header é obrigatório e comparado em tempo constante.
- ``BRIDGE_SHARED_SECRET`` vazio     -> modo de compatibilidade (aceita tudo) com aviso no log.
  Em produção, defina o segredo e exponha o backend apenas pela rede interna.
"""
import hmac
import logging
import os

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)
_warned = False


async def require_bridge(request: Request) -> None:
    global _warned
    secret = os.getenv("BRIDGE_SHARED_SECRET", "")
    if not secret:
        if not _warned:
            logger.warning(
                "BRIDGE_SHARED_SECRET não configurado: endpoints /api/webhook/bridge* e "
                "/api/media/bridge-upload estão ABERTOS. Defina o segredo em produção."
            )
            _warned = True
        return
    # O frontend (usuário logado) chama retry-failed com o próprio JWT, não com o segredo.
    if "/bridge/retry-failed/" in request.url.path:
        return
    received = request.headers.get("x-bridge-secret", "")
    if not hmac.compare_digest(received, secret):
        raise HTTPException(status_code=401, detail="Bridge não autorizado")
