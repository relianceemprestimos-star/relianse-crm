import base64
import hashlib

from cryptography.fernet import Fernet

from app.core.config import get_settings


def _fernet_key() -> bytes:
    settings = get_settings()
    raw_secret = (settings.credentials_secret or settings.app_password or "consulta-margem").strip()

    # Aceita chave ja no formato Fernet (44 chars base64 urlsafe), senão deriva por SHA-256.
    if len(raw_secret) == 44:
        try:
            base64.urlsafe_b64decode(raw_secret.encode("utf-8"))
            return raw_secret.encode("utf-8")
        except Exception:
            pass

    digest = hashlib.sha256(raw_secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt_secret(value: str) -> str:
    token = Fernet(_fernet_key()).encrypt((value or "").encode("utf-8"))
    return token.decode("utf-8")


def decrypt_secret(value: str) -> str:
    plain = Fernet(_fernet_key()).decrypt((value or "").encode("utf-8"))
    return plain.decode("utf-8")
