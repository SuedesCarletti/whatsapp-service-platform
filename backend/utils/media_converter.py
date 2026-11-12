"""
Normalização de mídia para compatibilidade com WhatsApp/Baileys.

WhatsApp exige:
  - Áudio  : OGG container + codec Opus, mono
  - Vídeo  : MP4 container + H.264/AAC
  - Imagem : JPEG/PNG/WebP (aceitos nativamente)
  - Sticker: WebP
  - Documento: qualquer formato (sem conversão)
"""
import shutil
import logging
import subprocess
from pathlib import Path
from typing import Tuple

logger = logging.getLogger(__name__)

_AUDIO_TARGET_MIME = "audio/ogg; codecs=opus"
_VIDEO_TARGET_MIME = "video/mp4"
_STICKER_TARGET_MIME = "image/webp"

# Mimetypes que já são compatíveis e não precisam de conversão
# Apenas ogg com codec opus explícito é aceito sem conversão
_AUDIO_OK = {"audio/ogg; codecs=opus", "audio/ogg;codecs=opus"}
_VIDEO_OK  = {"video/mp4", "video/mpeg"}
_STICKER_OK = {"image/webp"}
# Tamanho máximo de sticker estático aceito pelo WhatsApp (folga sobre os ~100KB reais)
_STICKER_MAX_BYTES = 95_000


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _run_ffmpeg(args: list[str], timeout: int = 120) -> None:
    result = subprocess.run(
        ["ffmpeg", "-y"] + args,
        capture_output=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")
        raise RuntimeError(f"ffmpeg falhou (código {result.returncode}): {stderr[-500:]}")


def _convert_audio(src: Path) -> Tuple[Path, str]:
    dst = src.with_stem(src.stem + "_converted").with_suffix(".ogg")
    _run_ffmpeg([
        "-i", str(src),
        "-c:a", "libopus",
        "-ac", "1",       # mono (WhatsApp exige)
        "-b:a", "64k",
        "-vn",            # remove stream de vídeo se houver
        str(dst),
    ])
    logger.info(f"Áudio convertido: {src.name} → {dst.name}")
    return dst, _AUDIO_TARGET_MIME


def _convert_video(src: Path) -> Tuple[Path, str]:
    dst = src.with_stem(src.stem + "_converted").with_suffix(".mp4")
    _run_ffmpeg([
        "-i", str(src),
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ], timeout=180)
    logger.info(f"Vídeo convertido: {src.name} → {dst.name}")
    return dst, _VIDEO_TARGET_MIME


def _convert_sticker(src: Path) -> Tuple[Path, str]:
    """
    Converte qualquer imagem pra sticker WebP 512×512 (WhatsApp exige quadrado
    exato) — encaixa a imagem inteira dentro do quadrado sem cortar (fundo
    transparente nas sobras) e recomprime até caber no limite de tamanho da
    Meta/WhatsApp (~100KB pra estático), reduzindo qualidade em passos se
    precisar. Usa Pillow (já é dependência do projeto), não ffmpeg.
    """
    from PIL import Image

    dst = src.with_stem(src.stem + "_sticker").with_suffix(".webp")
    with Image.open(src) as img:
        img = img.convert("RGBA")
        img.thumbnail((512, 512), Image.LANCZOS)
        canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
        offset = ((512 - img.width) // 2, (512 - img.height) // 2)
        canvas.paste(img, offset, img)

        for quality in (90, 75, 60, 45, 30):
            canvas.save(dst, "WEBP", quality=quality, method=6)
            if dst.stat().st_size <= _STICKER_MAX_BYTES:
                break

    logger.info(f"Imagem convertida pra sticker: {src.name} → {dst.name} ({dst.stat().st_size} bytes)")
    return dst, _STICKER_TARGET_MIME


def normalize_media(
    file_path: Path,
    mime_type: str,
    media_type: str,
) -> Tuple[Path, str]:
    """
    Converte o arquivo para o formato aceito pelo WhatsApp se necessário.
    Retorna (path, mime_type) — pode ser o original ou um arquivo convertido.
    O chamador é responsável por deletar o arquivo convertido (diferente do original).
    """
    # Sticker usa Pillow (não ffmpeg) — checado antes do gate de ffmpeg abaixo,
    # que só vale pra áudio/vídeo, senão sticker nunca seria convertido em
    # ambiente sem ffmpeg instalado.
    if media_type == "sticker" and mime_type not in _STICKER_OK:
        try:
            logger.info(f"Convertendo imagem pra sticker: {mime_type} → {_STICKER_TARGET_MIME}")
            return _convert_sticker(file_path)
        except Exception as exc:
            logger.error(f"Falha na conversão de sticker: {exc}")
            logger.warning(" Enviando arquivo original sem conversão")
            return file_path, mime_type

    if not ffmpeg_available():
        logger.warning(" ffmpeg não encontrado — enviando sem conversão (pode falhar no WhatsApp)")
        return file_path, mime_type

    try:
        if media_type == "audio" and mime_type not in _AUDIO_OK:
            logger.info(f"Convertendo áudio: {mime_type} → {_AUDIO_TARGET_MIME}")
            return _convert_audio(file_path)

        if media_type == "video" and mime_type not in _VIDEO_OK:
            logger.info(f"Convertendo vídeo: {mime_type} → {_VIDEO_TARGET_MIME}")
            return _convert_video(file_path)

    except Exception as exc:
        logger.error(f"Falha na conversão de mídia ({media_type}, {mime_type}): {exc}")
        logger.warning(" Enviando arquivo original sem conversão")

    return file_path, mime_type
