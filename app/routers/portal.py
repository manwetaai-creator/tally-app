"""Authenticated dashboard API (/api/v1/portal/*). Responses match the original Express server 1:1."""
import hashlib
import logging
import os
import re
import secrets
import time
from datetime import timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import blob
from ..txroute import TxRoute
from ..config import get_settings
from ..db import get_db
from ..deps import AuthContext, get_auth
from ..models import (
    ActivationCode, Connector, Customer, InboundMessage, InstallerRelease, Invoice, ReminderLog, SyncRun, WhatsAppAccount, utcnow,
)
from ..reminders import calculate_candidates, get_or_create_settings, make_log
from ..security import encrypt_secret, new_activation_code
from ..utils import d2s, f, iso, normalize_phone, today_utc

log = logging.getLogger("manweta.portal")
STATIC = Path(__file__).resolve().parents[2] / "static"
TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles", "UTC"]

router = APIRouter(prefix="/api/v1/portal", tags=["portal"], dependencies=[Depends(get_auth)], route_class=TxRoute)
public_router = APIRouter(tags=["public"], route_class=TxRoute)


# ----------------------------------------------------------------------------- helpers
def _paging(limit: str | None, offset: str | None) -> tuple[int, int]:
    def p(v, default):
        try:
            return int(v) or default
        except (TypeError, ValueError):
            return default
    return min(200, max(1, p(limit, 50))), max(0, p(offset, 0) if offset not in (None, "0") else 0)


def _to_int(v: Any, label: str) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        raise HTTPException(400, f"Invalid value for {label}")


def wa_public(a: WhatsAppAccount) -> dict:
    return {
        "status": a.status, "waba_id": a.waba_id, "phone_number_id": a.phone_number_id,
        "display_phone_number": a.display_phone_number, "verified_name": a.verified_name,
        "quality_rating": a.quality_rating, "connection_method": a.connection_method, "template_name": a.template_name,
        "template_status": a.template_status, "template_reject_reason": a.template_reject_reason, "last_error": a.last_error,
        "connected_at": iso(a.connected_at), "ready_to_send": a.status == "connected" and a.template_status == "APPROVED",
    }


def settings_json(s) -> dict:
    return {
        "enabled": s.enabled, "send_hour": s.send_hour, "timezone": s.timezone, "remind_overdue": s.remind_overdue,
        "remind_upcoming": s.remind_upcoming, "days_before_due": s.days_before_due, "repeat_every_days": s.repeat_every_days,
        "min_amount": f(s.min_amount), "reminder_mode": s.reminder_mode or "customer_wise", "last_auto_run_at": iso(s.last_auto_run_at),
    }


def log_json(l: ReminderLog) -> dict:
    return {
        "id": l.id, "customer_id": l.customer_id, "customer_name": l.customer_name, "phone_number": l.phone_number,
        "amount": f(l.amount) if l.amount is not None else None, "bill_ref": l.bill_ref,
        "reminder_mode": l.reminder_mode or "customer_wise", "bills_count": l.bills_count or 1, "status": l.status,
        "trigger": l.trigger, "error_message": l.error_message, "template_name": l.template_name,
        "sent_at": iso(l.sent_at), "created_at": iso(l.created_at),
    }


def _customer(db: Session, tenant_id: int, customer_id: int) -> Customer:
    c = db.scalar(select(Customer).where(Customer.id == customer_id, Customer.tenant_id == tenant_id))
    if not c:
        raise HTTPException(404, "Customer not found")
    return c


def _wa_account(db: Session, tenant_id: int) -> WhatsAppAccount | None:
    return db.get(WhatsAppAccount, tenant_id)


# ----------------------------------------------------------------------------- installer
def get_release(db: Session) -> InstallerRelease:
    r = db.get(InstallerRelease, 1)
    if r is None:
        s = get_settings()
        r = InstallerRelease(
            id=1, version=s.windows_installer_version, file_name="TallyConnector-Setup.exe", file_size=44920832,
            file_size_formatted="42.8 MB", sha256="9f83a21b34c761e2f8d40a23e198b472e90c561b3491f2a718d098e217c491a2",
            blob_url=s.windows_installer_blob_url or "/blobs/TallyConnector-Setup.exe",
            source="blob_storage" if s.windows_installer_blob_url else "local_blob",
        )
        db.add(r)
        db.flush()
    return r


def release_json(r: InstallerRelease) -> dict:
    return {
        "version": r.version, "file_name": r.file_name, "file_size": r.file_size, "file_size_formatted": r.file_size_formatted,
        "sha256": r.sha256, "blob_url": r.blob_url, "download_url": "/api/v1/portal/tally/download",
        "uploaded_at": iso(r.uploaded_at), "source": r.source,
    }


def require_installer_admin(auth: AuthContext) -> None:
    admins = get_settings().installer_admins
    if admins and auth.user.email.lower() not in admins:
        raise HTTPException(403, "Only Manweta administrators can change the Windows installer")


def serve_installer(db: Session):
    r = get_release(db)
    url = r.blob_url or ""
    if url.startswith(("http://", "https://")):
        return RedirectResponse(url, status_code=302)
    if url.startswith(blob.SCHEME):
        try:
            return RedirectResponse(blob.sas_url(url, r.file_name or "TallyConnector-Setup.exe"), status_code=302)
        except Exception:  # noqa: BLE001
            log.exception("Could not create SAS link for %s", url)
            raise HTTPException(502, "Installer storage is temporarily unavailable")
    local = STATIC / "blobs" / "TallyConnector-Setup.exe"
    if local.is_file():
        return FileResponse(local, filename=r.file_name or "TallyConnector-Setup.exe", media_type="application/vnd.microsoft.portable-executable")
    fallback = STATIC / "assets" / "TallyConnector.zip"
    if fallback.is_file():
        return FileResponse(fallback, filename="TallyConnector.zip")
    raise HTTPException(404, "Windows installer not found in blob storage")


@public_router.get("/api/v1/download/tally-connector")
def public_download(db: Session = Depends(get_db)):
    return serve_installer(db)


# ----------------------------------------------------------------------------- overview
@router.get("/overview")
def overview(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    tenant = auth.tenant
    tid = tenant.id
    connector = db.scalar(select(Connector).where(Connector.tenant_id == tid, Connector.status == "active").order_by(Connector.id.desc()))
    wa = _wa_account(db, tid)
    settings = get_or_create_settings(db, tid)

    tally_state = "done" if connector and connector.last_sync_at else ("in_progress" if connector else "todo")
    if wa and wa.status == "connected" and wa.template_status == "APPROVED":
        wa_state = "done"
    elif wa and wa.status == "connected":
        wa_state = "in_progress"
    else:
        wa_state = "todo"
    steps = [
        {"key": "company", "label": "Company", "state": "done", "detail": tenant.name},
        {"key": "tally", "label": "Tally", "state": tally_state},
        {"key": "whatsapp", "label": "WhatsApp", "state": wa_state},
        {"key": "reminders", "label": "Reminders", "state": "done" if settings.enabled else "todo"},
    ]

    today = today_utc()
    open_inv = db.scalars(select(Invoice).where(
        Invoice.tenant_id == tid, Invoice.status == "outstanding", Invoice.is_on_account.is_(False), Invoice.pending_amount > 0)).all()
    owing = {i.customer_id for i in open_inv}
    overdue = [i for i in open_inv if i.due_date and i.due_date < today]
    no_phone = 0
    if owing:
        no_phone = db.scalar(select(func.count()).select_from(Customer).where(
            Customer.tenant_id == tid, Customer.id.in_(owing), or_(Customer.phone_number.is_(None), func.trim(Customer.phone_number) == ""))) or 0

    statuses = db.scalars(select(ReminderLog.status).where(ReminderLog.tenant_id == tid, ReminderLog.created_at >= utcnow() - timedelta(days=30))).all()
    replies_7d = db.scalar(select(func.count()).select_from(InboundMessage).where(
        InboundMessage.tenant_id == tid, InboundMessage.received_at >= utcnow() - timedelta(days=7))) or 0
    last = db.scalar(select(SyncRun).where(SyncRun.tenant_id == tid).order_by(SyncRun.id.desc()))

    return {
        "tenant": {"tenant_id": tenant.tenant_code, "name": tenant.name},
        "steps": steps,
        "onboarding_complete": all(s["state"] == "done" for s in steps),
        "receivables": {
            "total_outstanding": sum(f(i.pending_amount) for i in open_inv), "open_bills": len(open_inv),
            "customers_owing": len(owing), "overdue_amount": sum(f(i.pending_amount) for i in overdue),
            "overdue_customers": len({i.customer_id for i in overdue}), "owing_without_phone": no_phone,
        },
        "messaging_30d": {
            "total": len(statuses), "sent": sum(1 for s in statuses if s not in ("failed", "queued")),
            "delivered": sum(1 for s in statuses if s in ("delivered", "read")), "read": sum(1 for s in statuses if s == "read"),
            "failed": sum(1 for s in statuses if s == "failed"), "replies_7d": replies_7d,
        },
        "last_sync": {"at": iso(last.completed_at or last.started_at), "records": last.records_count} if last else None,
        "currency": "₹",
    }


# ----------------------------------------------------------------------------- tally
@router.get("/tally")
def tally(request: Request, auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    tid = auth.tenant.id
    code = db.scalar(select(ActivationCode).where(ActivationCode.tenant_id == tid, ActivationCode.status == "unused").order_by(ActivationCode.id.desc()))
    connectors = db.scalars(select(Connector).where(Connector.tenant_id == tid).order_by(Connector.id.desc())).all()
    base = get_settings().public_base_url.rstrip("/") or f"{request.url.scheme}://{request.headers.get('host', request.url.netloc)}"
    return {
        "activation_code": code.code if code else None,
        "server_url": base,
        "tally_url": "http://localhost:9000",
        "download_url": "/api/v1/download/tally-connector",
        "installer": release_json(get_release(db)),
        "connectors": [{"connector_id": c.connector_code, "status": c.status, "created_at": iso(c.created_at),
                        "last_seen_at": iso(c.last_seen_at), "last_sync_at": iso(c.last_sync_at)} for c in connectors],
    }


@router.get("/tally/download")
def tally_download(db: Session = Depends(get_db)):
    return serve_installer(db)


@router.get("/tally/installer-info")
def installer_info(db: Session = Depends(get_db)):
    return {"success": True, "release": release_json(get_release(db))}


@router.post("/tally/upload-installer")
def upload_installer(
    installer: UploadFile | None = File(default=None), version: str | None = Form(default=None),
    external_blob_url: str | None = Form(default=None), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db),
):
    require_installer_admin(auth)
    r = get_release(db)

    if external_blob_url and not installer:
        url = external_blob_url.strip()
        if not url.startswith(("http://", "https://")):
            raise HTTPException(400, "blob_url must start with http:// or https://")
        r.blob_url, r.source, r.uploaded_at = url, "blob_storage", utcnow()
        if version:
            r.version = version.strip()
        return {"success": True, "message": "Blob storage URL updated successfully", "release": release_json(r)}

    if not installer:
        raise HTTPException(400, "No installer file uploaded")
    orig = os.path.basename(installer.filename or "TallyConnector-Setup.exe")
    if not orig.lower().endswith((".exe", ".zip")):
        raise HTTPException(400, "Only .exe or .zip installers are accepted")

    fobj = installer.file
    fobj.seek(0, os.SEEK_END)
    size = fobj.tell()
    fobj.seek(0)
    if size > get_settings().max_installer_mb * 1024 * 1024:
        raise HTTPException(413, f"Installer is larger than {get_settings().max_installer_mb} MB")
    h = hashlib.sha256()
    for chunk in iter(lambda: fobj.read(1024 * 1024), b""):
        h.update(chunk)
    fobj.seek(0)

    new_version = (version or "").strip() or r.version or "v1.4.2"
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", orig)
    if blob.configured():
        try:
            ref = blob.upload(fobj, f"{new_version}/{safe}")
        except Exception:  # noqa: BLE001
            log.exception("Blob upload failed")
            raise HTTPException(502, "Upload to Azure Blob Storage failed")
        source = "blob_storage"
    else:  # local development only: container disks are ephemeral on Azure App Service
        dest = STATIC / "blobs"
        dest.mkdir(parents=True, exist_ok=True)
        with open(dest / "TallyConnector-Setup.exe", "wb") as out:
            while chunk := fobj.read(1024 * 1024):
                out.write(chunk)
        ref, source = "/blobs/TallyConnector-Setup.exe", "local_blob"

    r.version, r.file_name, r.file_size = new_version, orig, size
    r.file_size_formatted = f"{size / (1024 * 1024):.1f} MB"
    r.sha256, r.blob_url, r.source, r.uploaded_at = h.hexdigest(), ref, source, utcnow()
    log.info("New Windows installer uploaded: %s (%s) sha256=%s", orig, r.file_size_formatted, r.sha256)
    return {"success": True, "message": f"Successfully uploaded {orig} to blob storage!", "release": release_json(r)}


@router.put("/tally/installer-config")
def installer_config(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    require_installer_admin(auth)
    url = body.get("blob_url")
    if not url:
        raise HTTPException(400, "blob_url is required")
    url = str(url).strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "blob_url must start with http:// or https://")
    r = get_release(db)
    r.blob_url, r.source, r.uploaded_at = url, "blob_storage", utcnow()
    if body.get("version"):
        r.version = str(body["version"]).strip()
    if body.get("file_name"):
        r.file_name = str(body["file_name"]).strip()
    return {"success": True, "message": "Blob storage configuration saved", "release": release_json(r)}


@router.post("/tally/activation-code")
def new_code(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    for c in db.scalars(select(ActivationCode).where(ActivationCode.tenant_id == auth.tenant.id, ActivationCode.status == "unused")):
        c.status = "disabled"
    code = ActivationCode(tenant_id=auth.tenant.id, code=new_activation_code(), status="unused", expires_at=utcnow() + timedelta(days=1))
    db.add(code)
    db.flush()
    return {"activation_code": code.code}


@router.post("/tally/connectors/{connector_code}/revoke")
def revoke(connector_code: str, auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    c = db.scalar(select(Connector).where(Connector.tenant_id == auth.tenant.id, Connector.connector_code == connector_code))
    if not c:
        raise HTTPException(404, "Connector not found")
    c.status, c.updated_at = "inactive", utcnow()
    return {"status": "revoked"}


# ----------------------------------------------------------------------------- whatsapp
@router.get("/whatsapp/config")
def wa_config():
    s = get_settings()
    return {"embedded_signup_enabled": bool(s.meta_app_id and s.meta_embedded_signup_config_id), "app_id": s.meta_app_id,
            "config_id": s.meta_embedded_signup_config_id, "api_version": "v21.0"}


@router.get("/whatsapp")
def wa_get(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    a = _wa_account(db, auth.tenant.id)
    return {"account": wa_public(a) if a else None}


def _upsert_account(db: Session, tenant_id: int, **fields) -> WhatsAppAccount:
    a = db.get(WhatsAppAccount, tenant_id)
    if a is None:
        a = WhatsAppAccount(tenant_id=tenant_id, **fields)
        db.add(a)
    else:
        for k, v in fields.items():
            setattr(a, k, v)
    db.flush()
    return a


@router.post("/whatsapp/manual")
def wa_manual(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    waba, pnid, token = body.get("waba_id"), body.get("phone_number_id"), body.get("access_token")
    if not waba or not pnid or not token:
        raise HTTPException(400, "waba_id, phone_number_id, and access_token are required")
    pnid = str(pnid).strip()
    a = _upsert_account(
        db, auth.tenant.id, status="connected", waba_id=str(waba).strip(), phone_number_id=pnid, display_phone_number="+91 " + pnid[-10:],
        verified_name=auth.tenant.name, quality_rating="GREEN", connection_method="manual", template_name="manweta_payment_reminder",
        template_status="APPROVED", template_language="en", template_reject_reason=None,
        access_token_enc=encrypt_secret(str(token).strip()), last_error=None, connected_at=utcnow(),
    )
    return {"account": wa_public(a)}


@router.post("/whatsapp/embedded-signup")
def wa_embedded(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    # Same simulated connection as the original app. For live Meta onboarding, exchange `code` for a token here.
    a = _upsert_account(
        db, auth.tenant.id, status="connected", waba_id=body.get("waba_id") or "WABA_" + secrets.token_hex(4),
        phone_number_id=body.get("phone_number_id") or "PN_" + secrets.token_hex(4), display_phone_number="+91 98000 00001",
        verified_name=auth.tenant.name, quality_rating="GREEN", connection_method="embedded_signup",
        template_name="manweta_payment_reminder", template_status="APPROVED", template_language="en", template_reject_reason=None,
        access_token_enc=encrypt_secret(body.get("code") or "token_" + secrets.token_hex(16)), last_error=None, connected_at=utcnow(),
    )
    return {"account": wa_public(a)}


@router.post("/whatsapp/refresh")
def wa_refresh(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    a = _wa_account(db, auth.tenant.id)
    if not a:
        raise HTTPException(404, "WhatsApp is not connected")
    a.quality_rating, a.template_status, a.last_error = "GREEN", "APPROVED", None
    return {"account": wa_public(a) | {"ready_to_send": True}}


@router.post("/whatsapp/test")
def wa_test(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    a = _wa_account(db, auth.tenant.id)
    if not a or a.status != "connected":
        raise HTTPException(409, "WhatsApp is not connected")
    to = normalize_phone(body.get("to"))
    if not to:
        raise HTTPException(400, "Invalid phone number")
    return {"status": "sent", "wa_message_id": "wamid.test." + secrets.token_hex(8), "to": to}


@router.delete("/whatsapp")
def wa_delete(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    a = _wa_account(db, auth.tenant.id)
    if a:
        db.delete(a)
    get_or_create_settings(db, auth.tenant.id).enabled = False
    return {"status": "disconnected"}


# ----------------------------------------------------------------------------- customers
@router.get("/customers")
def customers(search: str = "", filter: str = "all", limit: str | None = None, offset: str | None = None,
              auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    tid = auth.tenant.id
    lim, off = _paging(limit, offset)
    q = select(Customer).where(Customer.tenant_id == tid, Customer.status == "active")
    search = search.strip()
    if search:
        q = q.where(or_(Customer.name.icontains(search, autoescape=True), Customer.phone_number.icontains(search, autoescape=True)))
    no_phone = or_(Customer.phone_number.is_(None), func.trim(Customer.phone_number) == "")
    if filter == "owing":
        q = q.where(Customer.total_pending > 0)
    elif filter == "no_phone":
        q = q.where(Customer.total_pending > 0, no_phone)
    elif filter == "opted_out":
        q = q.where(Customer.whatsapp_opt_out.is_(True))

    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(Customer.total_pending.desc(), Customer.name.asc()).limit(lim).offset(off)).all()
    ids = [c.id for c in rows]
    counts, last = {}, {}
    if ids:
        counts = dict(db.execute(select(Invoice.customer_id, func.count()).where(
            Invoice.tenant_id == tid, Invoice.customer_id.in_(ids), Invoice.status == "outstanding").group_by(Invoice.customer_id)).all())
        last_ids = select(func.max(ReminderLog.id)).where(ReminderLog.tenant_id == tid, ReminderLog.customer_id.in_(ids)).group_by(ReminderLog.customer_id)
        last = {l.customer_id: l for l in db.scalars(select(ReminderLog).where(ReminderLog.id.in_(last_ids)))}
    items = []
    for c in rows:
        l = last.get(c.id)
        items.append({
            "id": c.id, "name": c.name, "phone_number": c.phone_number, "total_pending": f(c.total_pending),
            "bill_outstanding": f(c.bill_outstanding), "on_account": f(c.on_account), "whatsapp_opt_out": c.whatsapp_opt_out,
            "last_synced_at": iso(c.last_synced_at), "bills_count": counts.get(c.id, 0),
            "last_reminder": {"status": l.status, "at": iso(l.sent_at or l.created_at)} if l else None,
        })
    return {"total": total, "items": items}


@router.patch("/customers/{customer_id}")
def customer_patch(customer_id: int, body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    c = _customer(db, auth.tenant.id, customer_id)
    if "phone_number" in body:
        raw = str(body["phone_number"] or "").strip()
        if raw == "":
            c.phone_number = None
        else:
            norm = normalize_phone(raw)
            if not norm:
                raise HTTPException(400, "That doesn't look like a valid phone number")
            c.phone_number = norm
    if "whatsapp_opt_out" in body:
        c.whatsapp_opt_out = bool(body["whatsapp_opt_out"])
    c.updated_at = utcnow()
    return {"id": c.id, "phone_number": c.phone_number, "whatsapp_opt_out": c.whatsapp_opt_out}


@router.get("/customers/{customer_id}/invoices")
def customer_invoices(customer_id: int, auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    c = _customer(db, auth.tenant.id, customer_id)
    today = today_utc()
    invs = db.scalars(select(Invoice).where(Invoice.tenant_id == auth.tenant.id, Invoice.customer_id == c.id, Invoice.status == "outstanding")
                      .order_by(Invoice.due_date.asc().nulls_first())).all()
    items = [{
        "id": i.id, "bill_ref": i.bill_ref, "bill_date": d2s(i.bill_date), "due_date": d2s(i.due_date),
        "opening_amount": f(i.opening_amount), "pending_amount": f(i.pending_amount), "is_on_account": i.is_on_account,
        "overdue_days": max(0, (today - i.due_date).days) if i.due_date and i.due_date < today else 0, "status": i.status,
    } for i in invs]
    return {"customer": {"id": c.id, "name": c.name, "phone_number": c.phone_number, "total_pending": f(c.total_pending),
                         "whatsapp_opt_out": c.whatsapp_opt_out}, "items": items}


@router.post("/customers/{customer_id}/remind")
def remind(customer_id: int, body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    tid = auth.tenant.id
    c = _customer(db, tid, customer_id)
    if c.whatsapp_opt_out:
        raise HTTPException(400, f"{c.name} has opted out of WhatsApp reminders")
    phone = normalize_phone(c.phone_number)
    if not phone:
        raise HTTPException(400, f"{c.name} has no valid phone number - add one first")
    acct = _wa_account(db, tid)
    if not acct or acct.status != "connected" or acct.template_status != "APPROVED":
        raise HTTPException(409, "Connect WhatsApp and verify template approval before sending reminders")
    open_bills = db.scalars(select(Invoice).where(
        Invoice.tenant_id == tid, Invoice.customer_id == c.id, Invoice.status == "outstanding", Invoice.is_on_account.is_(False)
    ).order_by(Invoice.id)).all()
    if not open_bills:
        raise HTTPException(400, f"{c.name} has no outstanding bills to remind about")

    invoice_id, mode = body.get("invoice_id"), body.get("mode")
    targets, target_id, target_ref = open_bills, None, None
    reminder_mode = "bill_wise" if (mode == "bill_wise" or invoice_id) else "customer_wise"

    if invoice_id:
        try:
            wanted = int(invoice_id)
        except (TypeError, ValueError):
            wanted = -1
        specific = next((i for i in open_bills if i.id == wanted), None)
        if not specific:
            raise HTTPException(404, "Selected invoice was not found or is already cleared")
        targets, target_id, target_ref, reminder_mode = [specific], specific.id, specific.bill_ref, "bill_wise"

    if mode == "bill_wise" and not invoice_id:
        logs = [make_log(db, tid, acct, customer=c, phone=phone, amount=inv.pending_amount, invoice_id=inv.id, bill_ref=inv.bill_ref,
                         mode="bill_wise", bills=1) for inv in open_bills]
        return {"count": len(logs), "reminders": [log_json(l) for l in logs], "reminder": log_json(logs[0]), "reminder_mode": "bill_wise",
                "detail": f"Sent {len(logs)} individual bill reminders to {c.name}"}

    amount = sum(i.pending_amount for i in targets)
    lg = make_log(db, tid, acct, customer=c, phone=phone, amount=amount, invoice_id=target_id or targets[0].id,
                  bill_ref=target_ref or ", ".join(i.bill_ref for i in targets), mode=reminder_mode, bills=len(targets))
    return {"reminder": log_json(lg)}


# ----------------------------------------------------------------------------- support
@router.post("/support/inquiry")
def support_inquiry(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth)):
    msg = str(body.get("message") or "").strip()
    if not msg:
        raise HTTPException(400, "Please provide a message")
    log.info("[Support Inquiry] %s (%s): %s -> support@manweta.com", auth.user.email, auth.tenant.name, body.get("subject"))
    return {"success": True, "ticket_id": f"MWT-{str(int(time.time() * 1000))[-6:]}", "recipient": "support@manweta.com",
            "message": "Your inquiry has been routed to Manweta AI Support (support@manweta.com). Our team will reply within 2-4 business hours."}


@router.post("/contact")
def contact(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth)):
    if not str(body.get("message") or "").strip():
        raise HTTPException(400, "Please enter your message")
    log.info("Support ticket from %s (%s): %s", auth.user.email, auth.tenant.name, body.get("subject") or "General Inquiry")
    return {"status": "sent", "message": "Your message has been sent to support@manweta.com. Our support team will get back to you shortly."}


# ----------------------------------------------------------------------------- reminders
@router.get("/reminders/settings")
def reminder_settings(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    return {"settings": settings_json(get_or_create_settings(db, auth.tenant.id)), "timezones": TIMEZONES}


@router.put("/reminders/settings")
def reminder_settings_put(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    tid = auth.tenant.id
    if body.get("enabled"):
        a = _wa_account(db, tid)
        if not a or a.status != "connected":
            raise HTTPException(409, "Connect WhatsApp before turning reminders on")
        if not body.get("remind_overdue") and not body.get("remind_upcoming"):
            raise HTTPException(400, "Choose at least one of: overdue bills, bills due soon")
    s = get_or_create_settings(db, tid)
    s.enabled = bool(body.get("enabled"))
    if body.get("send_hour") is not None:
        s.send_hour = _to_int(body["send_hour"], "send_hour")
    if body.get("timezone"):
        s.timezone = str(body["timezone"])
    if body.get("remind_overdue") is not None:
        s.remind_overdue = bool(body["remind_overdue"])
    if body.get("remind_upcoming") is not None:
        s.remind_upcoming = bool(body["remind_upcoming"])
    if body.get("days_before_due") is not None:
        s.days_before_due = _to_int(body["days_before_due"], "days_before_due")
    if body.get("repeat_every_days") is not None:
        s.repeat_every_days = _to_int(body["repeat_every_days"], "repeat_every_days")
    if body.get("min_amount") is not None:
        try:
            s.min_amount = float(body["min_amount"])
        except (TypeError, ValueError):
            raise HTTPException(400, "Invalid value for min_amount")
    if body.get("reminder_mode") in ("customer_wise", "bill_wise"):
        s.reminder_mode = body["reminder_mode"]
    db.flush()
    return {"settings": settings_json(s)}


@router.get("/reminders/preview")
def reminder_preview(mode: str | None = None, auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    rep = calculate_candidates(db, auth.tenant.id, mode)
    return {"count": len(rep["candidates"]), "total_amount": sum(c["amount"] for c in rep["candidates"]), "skipped": rep["skipped"],
            "reminder_mode": rep["reminder_mode"], "candidates": rep["candidates"][:200]}


@router.post("/reminders/run")
def reminder_run(body: dict = Body(default={}), auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    tid = auth.tenant.id
    acct = _wa_account(db, tid)
    if not acct or acct.status != "connected" or acct.template_status != "APPROVED":
        raise HTTPException(409, "Connect WhatsApp and ensure reminder template is APPROVED before running")
    rep = calculate_candidates(db, tid, body.get("mode"))
    cust = {c.id: c for c in db.scalars(select(Customer).where(Customer.id.in_([x["customer_id"] for x in rep["candidates"]] or [0])))}
    sent = 0
    for cand in rep["candidates"]:
        make_log(db, tid, acct, customer=cust[cand["customer_id"]], phone=cand["phone"], amount=cand["amount"], invoice_id=cand["invoice_id"],
                 bill_ref=cand.get("bill_ref"), mode=cand.get("mode", "customer_wise"), bills=cand.get("bills", 1))
        sent += 1
    return {"attempted": len(rep["candidates"]), "sent": sent, "failed": 0, "reminder_mode": rep["reminder_mode"], "skipped": rep["skipped"]}


@router.get("/reminders/logs")
def reminder_logs(status: str = "", limit: str | None = None, offset: str | None = None,
                  auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    lim, off = _paging(limit, offset)
    q = select(ReminderLog).where(ReminderLog.tenant_id == auth.tenant.id)
    if status.strip():
        q = q.where(ReminderLog.status == status.strip())
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(ReminderLog.id.desc()).limit(lim).offset(off)).all()
    return {"total": total, "items": [log_json(l) for l in rows]}


@router.get("/replies")
def replies(limit: str | None = None, auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    lim, _ = _paging(limit, None)
    rows = db.execute(select(InboundMessage, Customer.name).outerjoin(Customer, Customer.id == InboundMessage.customer_id)
                      .where(InboundMessage.tenant_id == auth.tenant.id).order_by(InboundMessage.id.desc()).limit(lim)).all()
    return {"items": [{"id": m.id, "customer_id": m.customer_id, "customer_name": name, "phone_number": m.phone_number,
                       "message_type": m.message_type, "body": m.body, "received_at": iso(m.received_at)} for m, name in rows]}
