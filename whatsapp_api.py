import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

import requests


class WhatsAppAPIError(RuntimeError):
    pass


def build_initial_message(nome: str) -> str:
    nome = (nome or "").strip() or "cliente"
    return f"Boa tarde, {nome}. Tudo bem?\n\nMeu nome é Aline, sou assistente da Relianse.\nFalo com {nome}?"


@dataclass
class WhatsAppAPI:
    token: str
    phone_number_id: str
    api_version: str = "v20.0"
    timeout_seconds: int = 30

    @property
    def base_url(self) -> str:
        return f"https://graph.facebook.com/{self.api_version}/{self.phone_number_id}"

    def _request(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.base_url}/messages"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        response = requests.post(url, headers=headers, json=payload, timeout=self.timeout_seconds)
        try:
            body = response.json()
        except ValueError:
            body = {"raw": response.text}

        if not response.ok:
            raise WhatsAppAPIError(f"WhatsApp API retornou {response.status_code}: {body}")
        return body

    def send_text_message(self, to: str, body: str, preview_url: bool = False) -> Dict[str, Any]:
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": {
                "preview_url": preview_url,
                "body": body,
            },
        }
        return self._request(payload)

    def send_template_message(
        self,
        to: str,
        template_name: str,
        language_code: str = "pt_BR",
        body_parameters: Optional[list] = None,
    ) -> Dict[str, Any]:
        parameters = body_parameters or []
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": language_code},
                "components": [
                    {
                        "type": "body",
                        "parameters": parameters,
                    }
                ],
            },
        }
        return self._request(payload)

    def send_first_approach(
        self,
        to: str,
        nome: str,
        template_name: str = "",
        language_code: str = "pt_BR",
    ) -> Dict[str, Any]:
        if template_name:
            return self.send_template_message(
                to=to,
                template_name=template_name,
                language_code=language_code,
                body_parameters=[{"type": "text", "text": nome}],
            )
        return self.send_text_message(to=to, body=build_initial_message(nome))


def load_whatsapp_api_from_env() -> WhatsAppAPI:
    token = os.getenv("TOKEN", "").strip()
    phone_number_id = os.getenv("PHONE_NUMBER_ID", "").strip()
    api_version = os.getenv("WHATSAPP_API_VERSION", "v20.0").strip()
    if not token or not phone_number_id:
        raise WhatsAppAPIError("Defina TOKEN e PHONE_NUMBER_ID no arquivo .env")
    return WhatsAppAPI(token=token, phone_number_id=phone_number_id, api_version=api_version)
