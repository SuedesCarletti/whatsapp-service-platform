"""
Stickers — conversão de imagem própria em sticker WebP (qualquer provider,
não é específico de Baileys) e galeria pessoal de stickers salvos (recebidos
de contatos ou criados pelo próprio usuário).

Registrar em app.py:
    from backend.api.routes_stickers import router_stickers
    app.include_router(router_stickers, prefix="/api/stickers", tags=["Stickers"])
"""

import logging
import uuid
from pathlib import Path
from typing import Optional

import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database.connection import get_db
from backend.database.models import SavedSticker, User
from backend.api.routes_auth import get_current_user
from backend.models.schemas import APIResponse
from backend.utils.media_converter import normalize_media
from backend.utils.time_utils import to_utc_iso

logger = logging.getLogger(__name__)

router_stickers = APIRouter()

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


def _sticker_brief(s: SavedSticker) -> dict:
    return {"id": s.id, "media_url": s.media_url, "mime_type": s.mime_type, "created_at": to_utc_iso(s.created_at)}


@router_stickers.post("/convert")
async def convert_to_sticker(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Converte uma imagem qualquer (jpg/png/etc) em sticker WebP 512×512 —
    genérico, não depende de qual provider vai usar o resultado depois.
    Retorna a URL local (/uploads/...) pronta pra tocar em POST /saved ou
    ser reenviada como arquivo pelo fluxo normal de envio de mídia.
    """
    original_name = file.filename or "imagem"
    safe_original = "".join(c if c.isalnum() or c in "._-" else "_" for c in original_name)
    safe_name = f"{uuid.uuid4().hex}_{safe_original}"
    file_path = UPLOAD_DIR / safe_name

    content = await file.read()
    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    try:
        converted_path, mime_type = normalize_media(file_path, file.content_type or "application/octet-stream", "sticker")
    except Exception as exc:
        logger.error(f"Falha ao converter imagem em sticker: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail="Não foi possível converter essa imagem em sticker.")
    finally:
        if file_path.exists() and file_path != converted_path:
            file_path.unlink(missing_ok=True)

    if converted_path == file_path:
        # normalize_media não converteu (já era webp válido, ou falhou e devolveu o original)
        raise HTTPException(status_code=400, detail="Não foi possível converter essa imagem em sticker — tente outro arquivo.")

    return APIResponse(success=True, data={
        "media_url": f"/uploads/{converted_path.name}",
        "mime_type": mime_type,
    })


@router_stickers.get("/saved")
async def list_saved_stickers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stickers = db.query(SavedSticker).filter(
        SavedSticker.user_id == current_user.id
    ).order_by(SavedSticker.created_at.desc()).all()
    return APIResponse(success=True, data=[_sticker_brief(s) for s in stickers])


class SaveStickerRequest(BaseModel):
    media_url: str
    mime_type: Optional[str] = None
    source_wamid: Optional[str] = None


@router_stickers.post("/saved")
async def save_sticker(
    payload: SaveStickerRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not payload.media_url:
        raise HTTPException(status_code=400, detail="media_url é obrigatório")

    existing = db.query(SavedSticker).filter(
        SavedSticker.user_id == current_user.id,
        SavedSticker.media_url == payload.media_url,
    ).first()
    if existing:
        return APIResponse(success=True, data=_sticker_brief(existing))

    sticker = SavedSticker(
        user_id=current_user.id,
        media_url=payload.media_url,
        mime_type=payload.mime_type,
        source_wamid=payload.source_wamid,
    )
    db.add(sticker)
    db.commit()
    db.refresh(sticker)
    return APIResponse(success=True, data=_sticker_brief(sticker))


@router_stickers.delete("/saved/{sticker_id}")
async def delete_saved_sticker(
    sticker_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sticker = db.query(SavedSticker).filter(
        SavedSticker.id == sticker_id, SavedSticker.user_id == current_user.id
    ).first()
    if not sticker:
        raise HTTPException(status_code=404, detail="Sticker não encontrado")
    db.delete(sticker)
    db.commit()
    return APIResponse(success=True, data={"id": sticker_id})
