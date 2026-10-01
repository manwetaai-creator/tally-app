from datetime import timedelta

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..txroute import TxRoute
from ..config import get_settings
from ..db import get_db
from ..deps import AuthContext, get_auth
from ..models import ActivationCode, AuthSession, ReminderSettings, Tenant, User, utcnow
from ..security import (
    hash_password, new_activation_code, new_session_token, new_tenant_code, sha256_hex, verify_password,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"], route_class=TxRoute)


def create_session(db: Session, user: User, tenant: Tenant) -> dict:
    token = new_session_token()
    db.add(AuthSession(token_hash=sha256_hex(token), user_id=user.id, tenant_id=tenant.id,
                       expires_at=utcnow() + timedelta(days=get_settings().session_days)))
    db.execute(delete(AuthSession).where(AuthSession.expires_at < utcnow()))  # opportunistic cleanup
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"id": user.id, "email": user.email, "full_name": user.full_name},
        "tenant": {"tenant_id": tenant.tenant_code, "name": tenant.name},
    }


def _find_user(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(func.lower(User.email) == email))


@router.post("/signup")
def signup(body: dict = Body(default={}), db: Session = Depends(get_db)):
    company, email, password, full_name = body.get("company_name"), body.get("email"), body.get("password"), body.get("full_name")
    if not email or not password or not company:
        raise HTTPException(400, "Company name, work email, and password are required")
    clean = str(email).strip().lower()
    if "@" not in clean or "." not in clean:
        raise HTTPException(400, "Enter a valid email address")
    if _find_user(db, clean):
        raise HTTPException(409, "An account with this email already exists")

    tenant = Tenant(tenant_code=new_tenant_code(), name=str(company).strip(), status="active")
    db.add(tenant)
    db.flush()
    user = User(tenant_id=tenant.id, email=clean, full_name=str(full_name).strip() if full_name else None,
                password_hash=hash_password(str(password)), last_login_at=utcnow())
    db.add(user)
    db.add(ActivationCode(tenant_id=tenant.id, code=new_activation_code(), status="unused", expires_at=utcnow() + timedelta(days=1)))
    db.add(ReminderSettings(tenant_id=tenant.id, enabled=False, remind_upcoming=False))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with this email already exists")
    return create_session(db, user, tenant)


@router.post("/login")
def login(body: dict = Body(default={}), db: Session = Depends(get_db)):
    email, password = body.get("email"), body.get("password")
    if not email or not password:
        raise HTTPException(400, "Email and password are required")
    user = _find_user(db, str(email).strip().lower())
    if not user or not verify_password(str(password), user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
    tenant = db.get(Tenant, user.tenant_id)
    if not tenant or tenant.status != "active":
        raise HTTPException(403, "This account is not active")
    user.last_login_at = utcnow()
    return create_session(db, user, tenant)


@router.post("/forgot-password")
def forgot_password(body: dict = Body(default={}), db: Session = Depends(get_db)):
    if not get_settings().insecure_password_reset:
        raise HTTPException(403, "Password reset by email is not enabled yet. Contact support@manweta.com.")
    email = body.get("email")
    if not email or not str(email).strip():
        raise HTTPException(400, "Please enter your registered work email")
    user = _find_user(db, str(email).strip().lower())
    if not user:
        raise HTTPException(404, "No account found with this email address")
    return {"success": True, "email": user.email, "message": "Account verified. You can now set a new password."}


@router.post("/reset-password")
def reset_password(body: dict = Body(default={}), db: Session = Depends(get_db)):
    if not get_settings().insecure_password_reset:
        raise HTTPException(403, "Password reset by email is not enabled yet. Contact support@manweta.com.")
    email, new_password = body.get("email"), body.get("new_password")
    if not email or not new_password:
        raise HTTPException(400, "Email and new password are required")
    if len(str(new_password)) < 8:
        raise HTTPException(400, "Password must be at least 8 characters long")
    user = _find_user(db, str(email).strip().lower())
    if not user:
        raise HTTPException(404, "No account found with this email address")
    user.password_hash = hash_password(str(new_password))
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))  # sign out everywhere
    return {"success": True, "message": "Password reset successful! Please log in with your new password."}


@router.get("/me")
def me(auth: AuthContext = Depends(get_auth)):
    return {
        "user": {"id": auth.user.id, "email": auth.user.email, "full_name": auth.user.full_name},
        "tenant": {"tenant_id": auth.tenant.tenant_code, "name": auth.tenant.name},
    }
