import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


LOGIN_PATH = "/Usuario/login-api"
PRELIMINARY_PATH = "/Servidor/buscar-preliminar-api"
COMPLETE_PATH = "/Servidor/buscar-completo-api"


def read_payload():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def clean_digits(value):
    return re.sub(r"\D", "", str(value or ""))


def normalize_base_url(value):
    text = str(value or "").strip()
    if not text:
        return ""
    if not text.startswith(("http://", "https://")):
        text = "https://" + text
    return text.rstrip("/")


def request_json(method, url, token=None, body=None, timeout=30):
    headers = {
        "Accept": "application/json",
        "User-Agent": "RelianceCRM/1.0",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = token if str(token).lower().startswith("bearer ") else f"Bearer {token}"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            text = response.read().decode("utf-8", "replace")
            return response.status, json.loads(text) if text.strip() else None
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except Exception:
            payload = text.strip()
        return exc.code, payload


def first_value(payload, names):
    if isinstance(payload, dict):
        for name in names:
            if name in payload and payload[name] not in (None, ""):
                return payload[name]
        for value in payload.values():
            found = first_value(value, names)
            if found not in (None, ""):
                return found
    if isinstance(payload, list):
        for item in payload:
            found = first_value(item, names)
            if found not in (None, ""):
                return found
    return None


def first_record(payload):
    if isinstance(payload, list):
        return payload[0] if payload else {}
    if isinstance(payload, dict):
        for key in ("servidores", "servidor", "data", "dados", "items", "result", "results"):
            value = payload.get(key)
            if isinstance(value, list) and value:
                return value[0]
            if isinstance(value, dict):
                return value
    return payload if isinstance(payload, dict) else {}


def money_fields(payload):
    found = {}

    def walk(value, label=""):
        if isinstance(value, dict):
            lower_keys = {str(k).lower(): k for k in value.keys()}
            name = str(value.get("nome") or value.get("descricao") or value.get("evento") or label or "").lower()
            amount = first_value(value, ["valor", "valorDisponivel", "valor_disponivel", "margem", "disponivel", "liquido"])
            if amount not in (None, ""):
                if "cart" in name and ("benef" in name or "beneficio" in name):
                    found.setdefault("cartao_beneficio_disponivel", amount)
                elif "cart" in name:
                    found.setdefault("margem_cartao_disponivel", amount)
                elif "consign" in name or "desconto" in name or "emprest" in name:
                    found.setdefault("margem_emprestimo_disponivel", amount)
            for canonical, aliases in {
                "margem_emprestimo_disponivel": ["margemdescontoconsignado", "margemconsignado", "margemdisponivel", "margem_emprestimo_disponivel"],
                "margem_cartao_disponivel": ["margemcartaocredito", "margemcartaodecredito", "margem_cartao_disponivel"],
                "cartao_beneficio_disponivel": ["margemcartaobeneficio", "margembeneficio", "cartao_beneficio_disponivel"],
            }.items():
                for alias in aliases:
                    key = lower_keys.get(alias)
                    if key and value.get(key) not in (None, ""):
                        found.setdefault(canonical, value.get(key))
            for key, item in value.items():
                walk(item, str(key))
        elif isinstance(value, list):
            for item in value:
                walk(item, label)

    walk(payload)
    return found


def normalize_result(cpf, preliminary, complete):
    record = first_record(complete) or first_record(preliminary)
    margins = money_fields(complete)
    payload_extra = {
        "nome_portal": first_value(record, ["nome", "Nome", "nomeServidor", "nome_servidor"]) or "",
        "matricula": first_value(record, ["matricula", "Matricula", "matrícula", "numeroMatricula"]) or "",
        "orgao": first_value(record, ["secretaria", "orgao", "órgão", "entidade", "convenio"]) or "",
        "cargo": first_value(record, ["cargo", "funcao", "função"]) or "",
        "vinculo": first_value(record, ["vinculo", "vínculo", "regime", "tipoVinculo"]) or "",
        **margins,
    }
    return {
        "status": "success",
        "cpf": cpf,
        "message": "Consulta RF1 Santana realizada via API.",
        "payload_extra": payload_extra,
        "raw_data": {
            "preliminary": preliminary,
            "complete": complete,
        },
    }


def run(payload):
    cpf = clean_digits(payload.get("cpf"))
    if len(cpf) != 11:
        return {"status": "erro", "detalhe_erro": "CPF invalido para consulta em Santana.", "payload_extra": {"code": "INVALID_CPF"}}

    login = str(payload.get("login") or payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not login or not password:
        return {"status": "erro", "detalhe_erro": "Credencial de Santana nao configurada.", "payload_extra": {"code": "CREDENTIAL_NOT_CONFIGURED"}}

    base_url = normalize_base_url(payload.get("api_url") or os.getenv("SANTANA_RF1_API_URL"))
    if not base_url:
        return {
            "status": "erro",
            "detalhe_erro": "Endpoint API RF1 de Santana nao configurado. Informe SANTANA_RF1_API_URL com a URL do convenio.",
            "payload_extra": {"code": "SANTANA_API_ENDPOINT_NOT_CONFIGURED"},
        }

    timeout = int(payload.get("timeout_ms") or os.getenv("SANTANA_RF1_TIMEOUT_MS") or 30000) / 1000
    login_status, login_payload = request_json("POST", base_url + LOGIN_PATH, body={"cpf": login, "senha": password}, timeout=timeout)
    if login_status != 200:
        return {
            "status": "login_error",
            "detalhe_erro": f"Falha no login RF1 Santana ({login_status}).",
            "payload_extra": {"code": "SANTANA_API_LOGIN_FAILED", "response": login_payload},
        }

    token = first_value(login_payload, ["token", "access_token", "jwt", "bearer", "Token", "accessToken"])
    if not token and isinstance(login_payload, str):
        token = login_payload
    if not token:
        return {"status": "erro", "detalhe_erro": "Login RF1 Santana nao retornou token.", "payload_extra": {"code": "SANTANA_API_TOKEN_MISSING"}}

    query = urllib.parse.urlencode({"cpfOuMatricula": cpf})
    prelim_status, preliminary = request_json("GET", f"{base_url}{PRELIMINARY_PATH}?{query}", token=token, timeout=timeout)
    if prelim_status == 422:
        return {"status": "not_found", "detalhe_erro": "CPF nao encontrado em Santana.", "payload_extra": {"response": preliminary}}
    if prelim_status != 200:
        return {"status": "erro", "detalhe_erro": f"Falha na busca preliminar RF1 Santana ({prelim_status}).", "payload_extra": {"response": preliminary}}

    uuid = first_value(preliminary, ["uuidServidor", "uuid", "guid", "Guid", "id"])
    if not uuid:
        return {"status": "not_found", "detalhe_erro": "CPF sem UUID de servidor na busca preliminar RF1 Santana.", "payload_extra": {"response": preliminary}}

    complete_query = urllib.parse.urlencode({"uuidServidor": str(uuid)})
    complete_status, complete = request_json("GET", f"{base_url}{COMPLETE_PATH}?{complete_query}", token=token, timeout=timeout)
    if complete_status != 200:
        return {"status": "erro", "detalhe_erro": f"Falha na busca completa RF1 Santana ({complete_status}).", "payload_extra": {"response": complete}}

    return normalize_result(cpf, preliminary, complete)


def main():
    try:
        print(json.dumps(run(read_payload()), ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"status": "erro", "detalhe_erro": str(exc), "payload_extra": {"code": "SANTANA_API_INTERNAL_ERROR"}}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
