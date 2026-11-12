"""
Giphy — proxy de busca/trending de GIFs pra aba "GIFs" do composer (ao lado
de Emoji/Stickers, ver ChatArea.js). Fica no backend só pra não expor a API
key do Giphy no bundle do front (ela vai em requests do navegador senão).

Registrar em app.py:
    from backend.api.routes_giphy import router_giphy
    app.include_router(router_giphy, prefix="/api/giphy", tags=["Giphy"])
"""

import os
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from backend.api.routes_auth import get_current_user
from backend.database.models import User
from backend.models.schemas import APIResponse

logger = logging.getLogger(__name__)

router_giphy = APIRouter()

GIPHY_API_KEY = os.getenv("GIPHY_API_KEY", "")
GIPHY_BASE_URL = "https://api.giphy.com/v1/gifs"


def _format_gif(g: dict) -> dict:
    images = g.get("images", {})
    # fixed_width_small pro grid (thumbnail leve); fixed_width pro envio de
    # verdade (tamanho razoável — "original" costuma vir muito pesado pra
    # WhatsApp sem necessidade).
    preview = images.get("fixed_width_small") or images.get("preview_gif") or {}
    full = images.get("fixed_width") or images.get("original") or {}
    return {
        "id": g.get("id"),
        "title": g.get("title") or "",
        "preview_url": preview.get("url"),
        "url": full.get("url"),
    }


async def _giphy_get(path: str, params: dict) -> list:
    if not GIPHY_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="Busca de GIFs não configurada — falta GIPHY_API_KEY no servidor.",
        )
    params = {**params, "api_key": GIPHY_API_KEY, "rating": "pg-13", "lang": "pt"}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(f"{GIPHY_BASE_URL}/{path}", params=params)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.error(f"Giphy /{path} falhou: {exc}")
            raise HTTPException(status_code=502, detail="Não foi possível buscar GIFs agora.")
    data = resp.json().get("data", [])
    return [_format_gif(g) for g in data]


@router_giphy.get("/search")
async def search_gifs(
    q: str = Query(..., min_length=1),
    offset: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=50),
    current_user: User = Depends(get_current_user),
):
    results = await _giphy_get("search", {"q": q, "offset": offset, "limit": limit})
    return APIResponse(success=True, data=results)


@router_giphy.get("/trending")
async def trending_gifs(
    offset: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=50),
    current_user: User = Depends(get_current_user),
):
    results = await _giphy_get("trending", {"offset": offset, "limit": limit})
    return APIResponse(success=True, data=results)
