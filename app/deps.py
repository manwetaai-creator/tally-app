"""Request authentication (Bearer token, or ?token= like the original app)."""
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_db
from .models import AuthSession, Tenant, User, utcnow
from .security import sha256_hex


@dataclass
class AuthContext:
    user: User
    tenant: Tenant


def get_auth(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> AuthContext:
    raw = None
    if authorization and authorization.startswith("Bearer "):
        raw = authorization[7:].strip()
    elif token:
        raw = token
    if not raw:
        raise HTTPException(401, "Not authenticated")

    sess = db.get(AuthSession, sha256_hex(raw))
    if sess is None or sess.expires_at < utcnow():
        if sess is not None:
            db.delete(sess)
            db.commit()
        raise HTTPException(401, "Your session expired. Please log in again.")

    user = db.get(User, sess.user_id)
    tenant = db.get(Tenant, sess.tenant_id)
    if not user or not tenant or tenant.status != "active":
        raise HTTPException(401, "Account is not active")
    return AuthContext(user=user, tenant=tenant)


def get_connector(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """Authenticate the Windows Tally Connector by its API key."""
    from .models import Connector

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Authorization header is required")
    key_hash = sha256_hex(authorization[7:].strip())
    connector = db.scalar(select(Connector).where(Connector.api_key_hash == key_hash, Connector.status == "active"))
    if not connector:
        raise HTTPException(401, "Invalid or revoked API key")
    return connector
