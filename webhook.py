import json
import os
from typing import Dict, Iterable, Optional, Tuple

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
from fastapi import Query
from dotenv import load_dotenv

from database import (
    get_client_by_phone,
    init_db,
    normalize_phone_br,
    normalize_text,
    record_message_log,
    update_client_status,
)
from whatsapp_api import WhatsAppAPIError, load_whatsapp_api_from_env


load_dotenv()

app = FastAPI(title="Relianse Agente de Vendas WhatsApp Webhook")


NEGATIVE_KEYWORDS = [
    "nao quero",
    "sem interesse",
    "agora nao",
    "nao",
]

STOP_KEYWORDS = [
    "parar",
    "remover",
    "sair",
    "nao me chame",
    "nao enviar",
]

INTEREST_KEYWORDS = [
    "sim",
    "pode",
    "quero",
    "tenho interesse",
    "me chama",
    "manda",
    "pode mandar",
    "qual valor",
    "simulacao",
]


def iter_whatsapp_messages(payload: dict) -> Iterable[dict]:
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for message in value.get("messages", []):
                yield {
                    "value": value,
                    "message": message,
                }


def extract_text_body(message: dict) -> str:
    if message.get("type") == "text":
        return message.get("text", {}).get("body", "") or ""
    if message.get("type") == "interactive":
        interactive = message.get("interactive", {})
        if "button_reply" in interactive:
            return interactive["button_reply"].get("title", "") or ""
        if "list_reply" in interactive:
            return interactive["list_reply"].get("title", "") or ""
    return ""


def keyword_match(text: str, keywords: Iterable[str]) -> bool:
    normalized = normalize_text(text)
    return any(normalize_text(keyword) in normalized for keyword in keywords)


def build_reply_and_status(nome: str, text: str) -> Tuple[Optional[str], Optional[str]]:
    if keyword_match(text, STOP_KEYWORDS):
        return (
            f"Tudo bem, {nome}. Vou retirar seu contato da nossa lista.\nObrigada.",
            "parar",
        )

    if keyword_match(text, NEGATIVE_KEYWORDS):
        return (
            f"Sem problemas, {nome}. Obrigada pelo retorno.\nCaso queira não receber novos contatos, é só responder PARAR.",
            "recusado",
        )

    if keyword_match(text, INTEREST_KEYWORDS):
        return (
            f"Perfeito, {nome}. Vou te encaminhar para uma especialista da equipe finalizar sua simulação com segurança.",
            "interessado",
        )

    return None, None


@app.get("/webhook", response_class=PlainTextResponse)
async def verify_webhook(
    hub_mode: Optional[str] = Query(None, alias="hub.mode"),
    hub_challenge: Optional[str] = Query(None, alias="hub.challenge"),
    hub_verify_token: Optional[str] = Query(None, alias="hub.verify_token"),
):
    expected = os.getenv("VERIFY_TOKEN", "").strip()
    if hub_mode == "subscribe" and hub_verify_token == expected and hub_challenge is not None:
        return PlainTextResponse(content=hub_challenge)
    return PlainTextResponse(content="Forbidden", status_code=403)


@app.post("/webhook")
async def receive_webhook(request: Request):
    init_db()
    payload = await request.json()
    whatsapp = load_whatsapp_api_from_env()
    processed = 0

    for event in iter_whatsapp_messages(payload):
        value = event["value"]
        message = event["message"]
        customer_phone = message.get("from", "")
        phone_key, valid = normalize_phone_br(customer_phone)
        if not valid:
            continue

        client = get_client_by_phone(phone_key)
        if not client:
            continue

        current_status = (client.get("status") or "").strip().lower()
        if current_status == "parar":
            continue

        text = extract_text_body(message)
        if not text:
            continue

        reply, next_status = build_reply_and_status(client.get("nome", ""), text)
        if not reply or not next_status:
            continue

        record_message_log(
            phone_key=client["phone_key"],
            nome=client.get("nome", ""),
            direction="inbound",
            status_before=current_status,
            message_type=message.get("type", "text"),
            message_text=text,
            response_payload=json.dumps(payload, ensure_ascii=False),
        )

        try:
            sent = whatsapp.send_text_message(to=phone_key, body=reply)
            update_client_status(
                phone_key=client["phone_key"],
                status=next_status,
                sent_at=None,
                observacao=client.get("observacao", ""),
            )
            record_message_log(
                phone_key=client["phone_key"],
                nome=client.get("nome", ""),
                direction="outbound",
                status_before=current_status,
                status_after=next_status,
                message_type="text",
                message_text=reply,
                response_payload=json.dumps(sent, ensure_ascii=False),
            )
            processed += 1
        except WhatsAppAPIError as exc:
            update_client_status(
                phone_key=client["phone_key"],
                status="erro",
                last_error=str(exc),
            )
            record_message_log(
                phone_key=client["phone_key"],
                nome=client.get("nome", ""),
                direction="outbound",
                status_before=current_status,
                status_after="erro",
                message_type="text",
                message_text=reply,
                error=str(exc),
            )

    return {"ok": True, "processed": processed}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("webhook:app", host="0.0.0.0", port=8000, reload=True)
