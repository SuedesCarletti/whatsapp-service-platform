"""
backend/api/routes_flows.py

WhatsApp Flows — formulários interativos dentro da conversa.

  1. Gestão de chaves de criptografia do canal de dados (RSA por phone_number_id).
  2. Endpoint de troca de dados criptografado que a Meta chama de verdade
     quando o usuário interage com um Flow (ping / INIT / data_exchange / BACK).
  3. CRUD básico de Flows via Graph API (criar, listar, publicar, subir o
     FLOW_JSON, excluir) — sem editor visual; o JSON do Flow é colado pronto
     (pode ser desenhado no Flow Builder da própria Meta e colado aqui).

Registrar no app.py:
    from backend.api.routes_flows import flows_router
    app.include_router(flows_router, prefix="/api", tags=["Flows"])
"""

import os
import json
import logging
from typing import Any, Dict, List, Optional

import httpx
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from backend.database.connection import get_db, Base
from backend.database.models import WhatsAppAccount
from backend.services.flows_crypto import (
    generate_keypair, has_keypair, get_public_key_pem,
    decrypt_request, encrypt_response, FlowDecryptionError,
)
from backend.api.routes_auth import get_current_user
from backend.api.permissions import user_has_permission

logger = logging.getLogger(__name__)
# Antes disso, NENHUMA rota deste arquivo exigia login — incluindo criar/
# publicar/apagar Flow real na Meta. A única que precisa continuar pública é
# o data-exchange (webhook criptografado que a própria Meta chama, sem sessão
# de usuário) — por isso ela mora num router separado, sem essa dependency.
def _require_flows_perm(current_user=Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    """Gate único pro router inteiro (tela Flows) — antes disso nenhuma rota
    aqui checava permissão nenhuma além de estar logado, incluindo criar/
    publicar/apagar Flow real na Meta."""
    if not user_has_permission(db, current_user, "settings_flows"):
        raise HTTPException(status_code=403, detail="Seu papel não tem permissão para gerenciar Flows.")

flows_router = APIRouter(dependencies=[Depends(get_current_user), Depends(_require_flows_perm)])
flows_webhook_router = APIRouter()

API_VERSION = os.getenv("CLOUD_API_VERSION", "v23.0")


class FlowSubmissionModel(Base):
    """
    O que foi enviado em cada data_exchange de Flow — prova concreta de que
    a lógica de negócio do endpoint está processando dado de verdade (antes
    disso só existia o "ping" de health check, nada de dado real chegava
    a ser salvo em lugar nenhum).
    """
    __tablename__ = "flow_submissions"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    phone_number_id = Column(String(255), nullable=False, index=True)
    flow_token     = Column(String(255), nullable=True, index=True)
    screen         = Column(String(255), nullable=True)
    action         = Column(String(50), nullable=True)
    data           = Column(Text, nullable=False)  # JSON serializado
    created_at     = Column(DateTime, default=datetime.utcnow)


def _get_phone_credentials(db: Session, account_id: Optional[int] = None) -> tuple[str, str, str]:
    """Retorna (phone_number_id, waba_id, access_token) da conta especificada (ou primeira ativa)."""
    query = db.query(WhatsAppAccount).filter(WhatsAppAccount.provider_type.like("meta%"))
    if account_id:
        query = query.filter(WhatsAppAccount.id == account_id)
    else:
        query = query.filter(WhatsAppAccount.is_active == True)
    account = query.first()
    if account:
        waba_id = account.meta_business_account_id or account.meta_waba_id or ""
        return account.meta_phone_number_id or "", waba_id, account.meta_access_token or ""
    return "", "", ""


# CHAVES DE CRIPTOGRAFIA DO CANAL DE DADOS

@flows_router.get("/flows/keys/status")
async def flows_keys_status(account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    """Verifica se já existe chave local gerada e se está registrada na Meta."""
    phone_number_id, _, token = _get_phone_credentials(db, account_id)
    if not phone_number_id or not token:
        raise HTTPException(status_code=400, detail="Configure Phone Number ID e Access Token da conta primeiro")

    local_key_exists = has_keypair(phone_number_id)

    registered = None
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://graph.facebook.com/{API_VERSION}/{phone_number_id}/whatsapp_business_encryption",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 200:
                data = resp.json()
                registered = data.get("data", [{}])[0].get("business_public_key_signature_status") if data.get("data") else None
    except Exception as exc:
        logger.warning(f"Falha ao consultar status da chave de Flows na Meta: {exc}")

    return {
        "success": True,
        "local_key_exists": local_key_exists,
        "meta_signature_status": registered,
        "phone_number_id": phone_number_id,
    }


@flows_router.post("/flows/keys/generate")
async def flows_generate_keys(account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    """
    Gera um novo par de chaves RSA e registra a pública na Meta pro
    phone_number_id da conta. A privada fica só no disco do servidor
    (backend/secrets/), nunca é exposta por nenhuma API.
    """
    phone_number_id, _, token = _get_phone_credentials(db, account_id)
    if not phone_number_id or not token:
        raise HTTPException(status_code=400, detail="Configure Phone Number ID e Access Token da conta primeiro")

    public_pem = generate_keypair(phone_number_id)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{API_VERSION}/{phone_number_id}/whatsapp_business_encryption",
                headers={"Authorization": f"Bearer {token}"},
                data={"business_public_key": public_pem},
            )
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Chave gerada localmente, mas Meta rejeitou o registro: {exc.response.text[:300]}")

    logger.info(f"Chave pública de Flows registrada na Meta para phone_number_id={phone_number_id}")
    return {"success": True, "message": "Par de chaves gerado e chave pública registrada na Meta"}


# ENDPOINT DE TROCA DE DADOS (chamado pela Meta, não pelo frontend)

def _default_flow_response(decrypted: Dict[str, Any], phone_number_id: str, db: Session) -> Dict[str, Any]:
    """
    Handler de demonstração: responde 'ping' (health check obrigatório da
    Meta), abre a tela WELCOME_SCREEN no INIT, e processa a submissão real
    do formulário em data_exchange — salva em FlowSubmissionModel e fecha o
    Flow com SUCCESS, o que faz a Meta entregar os dados como mensagem
    normal na conversa (via nfm_reply, já tratado em
    webhook_handler_extended.process_flow_response).

    É "genérico" no sentido de assumir o layout do Flow de teste
    (WELCOME_SCREEN com campos nome/telefone/interesse) — um Flow real
    diferente precisaria de lógica própria aqui (branching por
    flow_token/screen).
    """
    action = decrypted.get("action")
    version = decrypted.get("version", "3.0")
    flow_token = decrypted.get("flow_token", "")

    if action == "ping":
        return {"version": version, "data": {"status": "active"}}

    if action in ("INIT", "BACK"):
        return {"version": version, "screen": "WELCOME_SCREEN", "data": {}}

    if action == "data_exchange":
        screen = decrypted.get("screen")
        data = decrypted.get("data", {}) or {}

        try:
            FlowSubmissionModel.__table__.create(db.bind, checkfirst=True)
            db.add(FlowSubmissionModel(
                phone_number_id=phone_number_id,
                flow_token=flow_token,
                screen=screen,
                action=action,
                data=json.dumps(data, ensure_ascii=False),
            ))
            db.commit()
            logger.info(f"Flow submission salva: screen={screen} data={data}")
        except Exception:
            db.rollback()
            logger.exception("Erro ao salvar submissão de Flow")

        # Sinal de conversão (formulário completado) pro Business Manager —
        # disparado em background pra não atrasar a resposta criptografada
        # (a Meta tem timeout curto pra esse endpoint). wa_id vem embutido no
        # próprio flow_token, no formato "flow_{wa_id}_{flow_id}" (ver
        # whatsapp_service_extended.py send_flow). Usa uma sessão de DB
        # própria (não a `db` da requisição) porque essa vai ser fechada
        # pelo FastAPI assim que a resposta for retornada, antes da task
        # em background ter chance de rodar.
        try:
            parts = flow_token.split("_")
            if len(parts) >= 2 and parts[0] == "flow":
                wa_id = parts[1]
                import asyncio
                from backend.database.connection import SessionLocal as _SessionLocal
                from backend.services.conversions_api import send_conversion_event

                async def _fire_conversion_event():
                    task_db = _SessionLocal()
                    try:
                        await send_conversion_event(
                            db=task_db,
                            event_name="LeadSubmitted",
                            wa_id=wa_id,
                            event_id=f"flow-{flow_token}",
                        )
                    finally:
                        task_db.close()

                asyncio.create_task(_fire_conversion_event())
        except Exception:
            logger.exception("Erro ao agendar evento de conversão do Flow")

        return {
            "version": version,
            "screen": "SUCCESS",
            "data": {
                "extension_message_response": {
                    "params": {"flow_token": flow_token, **{k: str(v) for k, v in data.items()}},
                }
            },
        }

    return {
        "version": version,
        "data": {
            "acknowledged": True,
            "error_message": "Ação não reconhecida por este handler de demonstração.",
        },
    }


@flows_webhook_router.post("/webhook/flows/{phone_number_id}")
async def flows_data_exchange(phone_number_id: str, request: Request, db: Session = Depends(get_db)):
    """
    Endpoint criptografado que a própria Meta chama (configurado como
    endpoint_uri do Flow) — não usado pelo frontend. Corpo e resposta são
    opacos (base64), documentados em _default_flow_response acima.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Corpo da requisição inválido")

    try:
        decrypted, aes_key, iv = decrypt_request(phone_number_id, body)
    except FlowDecryptionError as exc:
        logger.warning(f"Falha ao descriptografar request de Flow ({phone_number_id}): {exc}")
        # 421 avisa a Meta que a chave pública dela está desatualizada —
        # ela vai buscar a nossa de novo. Retornar 200/500 aqui faria a
        # Meta achar que é um erro transitório e ficar reenviando à toa.
        return Response(status_code=421)

    logger.info(f"Flow data-exchange [{phone_number_id}]: action={decrypted.get('action')} screen={decrypted.get('screen')}")

    try:
        response_payload = _default_flow_response(decrypted, phone_number_id, db)
    except Exception as exc:
        logger.error(f"Erro ao processar Flow: {exc}", exc_info=True)
        response_payload = {"version": decrypted.get("version", "3.0"), "data": {"error_message": "Erro interno ao processar o formulário."}}

    encrypted_response = encrypt_response(response_payload, aes_key, iv)
    return Response(content=encrypted_response, media_type="text/plain", status_code=200)


@flows_router.get("/flows/submissions")
async def list_flow_submissions(phone_number_id: Optional[str] = Query(None), limit: int = Query(50, le=200), db: Session = Depends(get_db)):
    """Lista as submissões reais recebidas via data_exchange — prova de que a lógica de negócio está funcionando."""
    try:
        FlowSubmissionModel.__table__.create(db.bind, checkfirst=True)
        query = db.query(FlowSubmissionModel)
        if phone_number_id:
            query = query.filter(FlowSubmissionModel.phone_number_id == phone_number_id)
        rows = query.order_by(FlowSubmissionModel.created_at.desc()).limit(limit).all()
    except Exception:
        rows = []

    return {
        "success": True,
        "data": [
            {
                "id": r.id, "phone_number_id": r.phone_number_id, "flow_token": r.flow_token,
                "screen": r.screen, "data": json.loads(r.data), "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


# CRUD DE FLOWS (Graph API) — sem editor visual, JSON colado pronto

class FlowCreateSchema(BaseModel):
    name: str
    categories: List[str] = Field(..., description='Ex: ["OTHER"], ["APPOINTMENT_BOOKING"], ["LEAD_GENERATION"]...')
    endpoint_uri: Optional[str] = Field(
        None,
        description="URL pública completa do endpoint de dados (ex: https://seu-dominio.com/api/webhook/flows/{phone_number_id}). "
                    "Obrigatório antes de publicar um Flow com telas dinâmicas.",
    )


@flows_router.get("/flows")
async def list_flows(account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    _, waba_id, token = _get_phone_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e Access Token")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://graph.facebook.com/{API_VERSION}/{waba_id}/flows",
                headers={"Authorization": f"Bearer {token}"},
                params={"fields": "id,name,status,categories,validation_errors"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao listar Flows: {exc.response.text[:300]}")

    return {"success": True, "data": data.get("data", [])}


@flows_router.post("/flows")
async def create_flow(body: FlowCreateSchema, account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    _, waba_id, token = _get_phone_credentials(db, account_id)
    if not waba_id or not token:
        raise HTTPException(status_code=400, detail="Configure WA_BUSINESS_ACCOUNT_ID e Access Token")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{API_VERSION}/{waba_id}/flows",
                headers={"Authorization": f"Bearer {token}"},
                json={"name": body.name, "categories": body.categories},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao criar Flow: {exc.response.text[:300]}")

    flow_id = data.get("id")
    logger.info(f"Flow '{body.name}' criado (id={flow_id})")

    if body.endpoint_uri and flow_id:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                ep_resp = await client.post(
                    f"https://graph.facebook.com/{API_VERSION}/{flow_id}",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"endpoint_uri": body.endpoint_uri},
                )
                ep_resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning(f"Flow criado mas endpoint_uri não pôde ser definido: {exc.response.text[:300]}")
            return {"success": True, "data": data, "endpoint_uri_warning": exc.response.text[:300]}

    return {"success": True, "data": data}


class FlowJsonSchema(BaseModel):
    flow_json: Dict[str, Any]


@flows_router.post("/flows/{flow_id}/json")
async def upload_flow_json(flow_id: str, body: FlowJsonSchema, account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    """Sobe o FLOW_JSON (telas, campos, roteamento) pro Flow já criado."""
    _, _, token = _get_phone_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure o Access Token da conta")

    flow_json_bytes = json.dumps(body.flow_json).encode("utf-8")
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{API_VERSION}/{flow_id}/assets",
                headers={"Authorization": f"Bearer {token}"},
                files={"file": ("flow.json", flow_json_bytes, "application/json")},
                data={"name": "flow.json", "asset_type": "FLOW_JSON"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao subir JSON do Flow: {exc.response.text[:300]}")

    return {"success": True, "data": data}


# Tipos de componente do FLOW_JSON que geram um campo de dado no
# flow_action_payload (têm "name" e o valor entra no payload de envio).
_FLOW_INPUT_TYPES = {
    "TextInput", "TextArea", "DatePicker", "Dropdown", "RadioButtonsGroup",
    "CheckboxGroup", "ChipsSelector", "OptIn", "Switch", "CalendarPicker",
}


def _extract_flow_fields(flow_json: Dict[str, Any]) -> tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Varre o FLOW_JSON (screens -> layout -> children, recursivo — os campos
    podem estar dentro de um componente Form) e retorna os campos de entrada
    da primeira tela, pra montar um formulário de verdade em vez de pedir
    JSON cru pro usuário. Também retorna o id dessa tela — necessário pra
    montar o flow_action_payload corretamente (precisa de {screen, data},
    não só os dados soltos).
    """
    screens = flow_json.get("screens") or []
    if not screens:
        return [], None

    first_screen = screens[0]
    screen_id = first_screen.get("id")
    fields: List[Dict[str, Any]] = []
    seen = set()

    def walk(node):
        if isinstance(node, dict):
            node_type = node.get("type")
            name = node.get("name")
            if node_type in _FLOW_INPUT_TYPES and name and name not in seen:
                seen.add(name)
                fields.append({
                    "name": name,
                    "label": node.get("label") or node.get("text") or name,
                    "type": node_type,
                    "required": bool(node.get("required")),
                })
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(first_screen.get("layout"))
    return fields, screen_id


@flows_router.get("/flows/{flow_id}/fields")
async def get_flow_fields(flow_id: str, account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    """
    Busca o FLOW_JSON já publicado/enviado desse Flow na Meta e devolve os
    campos de entrada da primeira tela, pra montar um formulário de verdade
    no envio (em vez do usuário ter que escrever JSON na mão).
    """
    _, _, token = _get_phone_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure o Access Token da conta")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            assets_resp = await client.get(
                f"https://graph.facebook.com/{API_VERSION}/{flow_id}/assets",
                headers={"Authorization": f"Bearer {token}"},
            )
            assets_resp.raise_for_status()
            assets = assets_resp.json().get("data", [])

            flow_json_asset = next((a for a in assets if a.get("asset_type") == "FLOW_JSON"), None)
            if not flow_json_asset or not flow_json_asset.get("download_url"):
                return {"success": True, "fields": [], "reason": "Nenhum FLOW_JSON encontrado para esse Flow ainda."}

            json_resp = await client.get(flow_json_asset["download_url"])
            json_resp.raise_for_status()
            flow_json = json_resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao buscar FLOW_JSON: {exc.response.text[:300]}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Erro ao ler FLOW_JSON: {exc}")

    fields, screen_id = _extract_flow_fields(flow_json)
    return {"success": True, "fields": fields, "screen_id": screen_id}


class FlowEndpointUriSchema(BaseModel):
    endpoint_uri: str


@flows_router.post("/flows/{flow_id}/endpoint-uri")
async def set_flow_endpoint_uri(flow_id: str, body: FlowEndpointUriSchema, account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    """Define/atualiza a URL do endpoint de dados de um Flow já criado (obrigatório antes de publicar um Flow com telas dinâmicas)."""
    _, _, token = _get_phone_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure o Access Token da conta")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{API_VERSION}/{flow_id}",
                headers={"Authorization": f"Bearer {token}"},
                json={"endpoint_uri": body.endpoint_uri},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao definir endpoint_uri: {exc.response.text[:300]}")

    logger.info(f"endpoint_uri do Flow {flow_id} definido: {body.endpoint_uri}")
    return {"success": True, "data": data}


@flows_router.post("/flows/{flow_id}/publish")
async def publish_flow(flow_id: str, account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    _, _, token = _get_phone_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure o Access Token da conta")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"https://graph.facebook.com/{API_VERSION}/{flow_id}/publish",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao publicar Flow: {exc.response.text[:300]}")

    logger.info(f"Flow {flow_id} publicado")
    return {"success": True, "data": data}


@flows_router.delete("/flows/{flow_id}")
async def delete_flow(flow_id: str, account_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    _, _, token = _get_phone_credentials(db, account_id)
    if not token:
        raise HTTPException(status_code=400, detail="Configure o Access Token da conta")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.delete(
                f"https://graph.facebook.com/{API_VERSION}/{flow_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail=f"Erro ao excluir Flow: {exc.response.text[:300]}")

    return {"success": True, "data": data}
