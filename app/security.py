"""Hashing, tokens and at-rest encryption."""
import hashlib
import logging
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

log = logging.getLogger("manweta.security")
_ph = PasswordHasher()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_session_token() -> str:
    return "mwt_" + secrets.token_hex(32)


def generate_api_key() -> str:
    return "mwt_live_" + secrets.token_hex(24)


_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def new_activation_code() -> str:
    pick = lambda n: "".join(secrets.choice(_CODE_CHARS) for _ in range(n))  # noqa: E731
    return f"MP-{pick(4)}-{pick(4)}"


def new_tenant_code() -> str:
    return "TC-" + secrets.token_hex(4).upper()


def new_connector_code() -> str:
    return "CN-" + secrets.token_hex(4).upper()


# --- WhatsApp token encryption -------------------------------------------------
_PREFIX = "enc:"


def _fernet() -> Fernet | None:
    key = get_settings().encryption_key
    return Fernet(key.encode()) if key else None


def encrypt_secret(plain: str) -> str:
    f = _fernet()
    return _PREFIX + f.encrypt(plain.encode()).decode() if f else plain


def decrypt_secret(stored: str) -> str:
    if not stored.startswith(_PREFIX):
        return stored
    f = _fernet()
    if not f:
        raise RuntimeError("ENCRYPTION_KEY is not set but stored tokens are encrypted")
    try:
        return f.decrypt(stored[len(_PREFIX):].encode()).decode()
    except InvalidToken as e:  # wrong key
        raise RuntimeError("Cannot decrypt stored token - wrong ENCRYPTION_KEY?") from e
