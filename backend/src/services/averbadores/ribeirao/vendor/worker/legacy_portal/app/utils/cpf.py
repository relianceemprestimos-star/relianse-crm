import re


def normalize_cpf(value: str) -> str:
    return re.sub(r"\D", "", str(value or ""))


def is_valid_cpf_length(value: str) -> bool:
    return bool(re.fullmatch(r"\d{11}", str(value or "")))


def mask_cpf(value: str) -> str:
    cpf = normalize_cpf(value)
    if len(cpf) != 11:
        return "***"
    return f"{cpf[:3]}.***.***-{cpf[-2:]}"
