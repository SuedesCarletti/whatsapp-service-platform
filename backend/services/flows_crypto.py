"""
Criptografia do canal de dados de WhatsApp Flows.

Implementa exatamente o esquema documentado pela Meta
(https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint):

  1. A Meta manda encrypted_aes_key (RSA-OAEP/SHA256) + encrypted_flow_data +
     initial_vector (AES-128-GCM).
  2. Descriptografamos a AES key com nossa chave privada RSA.
  3. Descriptografamos o payload com a AES key + IV.
  4. Respondemos com o mesmo payload criptografado, mas com o IV invertido
     bit a bit (regra da Meta, evita replay da própria resposta como request).
  5. A resposta HTTP é o base64 puro (texto), não um JSON.
"""
import base64
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

KEYS_DIR = Path(__file__).resolve().parent.parent / "secrets"
KEYS_DIR.mkdir(parents=True, exist_ok=True)


class FlowDecryptionError(Exception):
    """
    Levantada quando a request não pôde ser descriptografada com a chave
    privada atual — o handler HTTP deve responder 421 (não 200/500) pra
    Meta saber que precisa buscar a chave pública de novo.
    """


def _private_key_path(phone_number_id: str) -> Path:
    return KEYS_DIR / f"flows_priv_{phone_number_id}.pem"


def _public_key_path(phone_number_id: str) -> Path:
    return KEYS_DIR / f"flows_pub_{phone_number_id}.pem"


def generate_keypair(phone_number_id: str) -> str:
    """
    Gera um par de chaves RSA-2048 pro número informado, salva a privada em
    disco (fora do banco — não deve ser exposta por nenhuma API) e retorna
    o PEM da pública, pra registrar na Meta.
    """
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    priv_path = _private_key_path(phone_number_id)
    priv_path.write_bytes(private_pem)
    os.chmod(priv_path, 0o600)

    pub_path = _public_key_path(phone_number_id)
    pub_path.write_bytes(public_pem)

    logger.info(f"Par de chaves Flows gerado para phone_number_id={phone_number_id}")
    return public_pem.decode("utf-8")


def has_keypair(phone_number_id: str) -> bool:
    return _private_key_path(phone_number_id).exists()


def get_public_key_pem(phone_number_id: str) -> Optional[str]:
    path = _public_key_path(phone_number_id)
    return path.read_text() if path.exists() else None


def _load_private_key(phone_number_id: str):
    path = _private_key_path(phone_number_id)
    if not path.exists():
        raise FlowDecryptionError(f"Nenhuma chave privada de Flows encontrada para phone_number_id={phone_number_id}")
    return serialization.load_pem_private_key(path.read_bytes(), password=None)


def decrypt_request(phone_number_id: str, body: Dict[str, Any]) -> Tuple[Dict[str, Any], bytes, bytes]:
    """
    Retorna (payload_decriptado, aes_key_bruta, iv_bruto).
    Levanta FlowDecryptionError se a chave privada não bater com a que a
    Meta usou pra criptografar (ex: chave rotacionada).
    """
    private_key = _load_private_key(phone_number_id)

    try:
        encrypted_aes_key = base64.b64decode(body["encrypted_aes_key"])
        encrypted_flow_data = base64.b64decode(body["encrypted_flow_data"])
        iv = base64.b64decode(body["initial_vector"])
    except (KeyError, ValueError) as exc:
        raise FlowDecryptionError(f"Payload de Flow malformado: {exc}") from exc

    try:
        aes_key = private_key.decrypt(
            encrypted_aes_key,
            padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )
    except Exception as exc:
        raise FlowDecryptionError(f"Falha ao descriptografar AES key (chave privada não confere): {exc}") from exc

    try:
        aesgcm = AESGCM(aes_key)
        decrypted_bytes = aesgcm.decrypt(iv, encrypted_flow_data, None)
    except Exception as exc:
        raise FlowDecryptionError(f"Falha ao descriptografar payload do Flow: {exc}") from exc

    import json
    return json.loads(decrypted_bytes.decode("utf-8")), aes_key, iv


def encrypt_response(response: Dict[str, Any], aes_key: bytes, iv: bytes) -> str:
    """Criptografa a resposta com o IV invertido bit a bit, conforme exigido pela Meta."""
    import json
    flipped_iv = bytes(b ^ 0xFF for b in iv)
    aesgcm = AESGCM(aes_key)
    response_bytes = json.dumps(response).encode("utf-8")
    encrypted = aesgcm.encrypt(flipped_iv, response_bytes, None)
    return base64.b64encode(encrypted).decode("utf-8")
