"""Endpoints used by the Windows Tally Connector (API-key authenticated)."""
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..txroute import TxRoute
from ..db import get_db
from ..deps import get_connector
from ..models import ActivationCode, Connector, Customer, Invoice, SyncRun, Tenant, utcnow
from ..security import generate_api_key, new_connector_code, sha256_hex
from ..utils import normalize_phone, num, parse_date

router = APIRouter(tags=["connector"], route_class=TxRoute)


@router.post("/api/v1/connector/activate")
def activate(body: dict = Body(default={}), db: Session = Depends(get_db)):
    code_str = body.get("activation_code")
    if not code_str:
        raise HTTPException(400, "activation_code is required")
    code = db.scalar(select(ActivationCode).where(ActivationCode.code == str(code_str).strip(), ActivationCode.status == "unused").with_for_update())
    if not code:
        raise HTTPException(404, "Invalid or already used activation code")
    now = utcnow()
    if code.expires_at and code.expires_at <= now:
        code.status = "expired"
        db.commit()  # persist the expiry even though we are about to return an error
        raise HTTPException(400, "Activation code has expired")

    raw_key = generate_api_key()
    connector = Connector(
        tenant_id=code.tenant_id, connector_code=new_connector_code(), machine_name=body.get("machine_name") or None,
        tally_version=body.get("tally_version") or None, api_key_hash=sha256_hex(raw_key), status="active",
        last_seen_at=now, updated_at=now,
    )
    code.status, code.used_at = "used", now
    db.add(connector)
    db.flush()
    return {"api_key": raw_key, "connector_id": connector.connector_code, "sync_interval_seconds": 3600}


@router.post("/api/v1/connector/sync")
def sync(payload: dict[str, Any] = Body(default={}), connector: Connector = Depends(get_connector), db: Session = Depends(get_db)):
    tenant = db.get(Tenant, connector.tenant_id)
    if not tenant:
        raise HTTPException(401, "Tenant not found")
    now = utcnow()
    customers_data = payload.get("customers") or []

    existing = {c.name.lower(): c for c in db.scalars(select(Customer).where(Customer.tenant_id == tenant.id))}
    invoices = {(i.customer_id, i.bill_ref): i for i in db.scalars(select(Invoice).where(Invoice.tenant_id == tenant.id))}

    def int_or_none(v):
        try:
            return int(float(v)) if v not in (None, "", 0) else None
        except (TypeError, ValueError):
            return None

    def keep(d: dict, key: str, current):
        """JS `d.key ?? current`."""
        return num(d[key]) if d.get(key) is not None else current

    count = 0
    for cd in customers_data:
        if not isinstance(cd, dict) or not cd.get("name"):
            continue
        name = str(cd["name"])
        cust = existing.get(name.lower())
        if cust is None:
            cust = Customer(
                tenant_id=tenant.id, name=name, phone_number=normalize_phone(cd.get("mobile")),
                total_pending=num(cd.get("total_pending")), bill_outstanding=num(cd.get("bill_outstanding")),
                on_account=num(cd.get("on_account")), closing_balance=num(cd.get("closing_balance")),
                whatsapp_opt_out=False, status="active", created_at=now, updated_at=now, last_synced_at=now,
            )
            db.add(cust)
            db.flush()
            existing[name.lower()] = cust
        else:
            cust.total_pending = keep(cd, "total_pending", cust.total_pending)
            cust.bill_outstanding = keep(cd, "bill_outstanding", cust.bill_outstanding)
            cust.on_account = keep(cd, "on_account", cust.on_account)
            cust.closing_balance = keep(cd, "closing_balance", cust.closing_balance)
            if cd.get("mobile"):
                cust.phone_number = normalize_phone(cd["mobile"]) or cust.phone_number
            cust.last_synced_at = cust.updated_at = now
        count += 1

        for bill in cd.get("bills") or []:
            if not isinstance(bill, dict) or not bill.get("bill_ref"):
                continue
            ref = str(bill["bill_ref"])
            inv = invoices.get((cust.id, ref))
            if inv is None:
                inv = Invoice(
                    tenant_id=tenant.id, customer_id=cust.id, bill_ref=ref, bill_date=parse_date(bill.get("bill_date")),
                    due_date=parse_date(bill.get("due_date")), opening_amount=num(bill.get("opening_amount")),
                    pending_amount=num(bill.get("pending_amount")),
                    overdue_days=int_or_none(bill.get("overdue_days")),
                    is_on_account=bool(bill.get("is_on_account")), status="outstanding",
                    external_key=f"{tenant.id}_{cust.name}_{ref}", created_at=now, updated_at=now, last_synced_at=now,
                )
                db.add(inv)
                invoices[(cust.id, ref)] = inv
            else:
                inv.bill_date = parse_date(bill.get("bill_date")) or inv.bill_date
                inv.due_date = parse_date(bill.get("due_date")) or inv.due_date
                inv.pending_amount = keep(bill, "pending_amount", inv.pending_amount)
                if bill.get("overdue_days") is not None:
                    inv.overdue_days = int_or_none(bill.get("overdue_days")) or 0
                inv.is_on_account = bool(bill.get("is_on_account"))
                inv.last_synced_at = inv.updated_at = now

    connector.last_seen_at = connector.last_sync_at = connector.updated_at = now
    run = SyncRun(tenant_id=tenant.id, connector_id=connector.id, started_at=now, completed_at=utcnow(), status="success", records_count=count)
    db.add(run)
    db.flush()
    return {"status": "success", "tenant_id": tenant.tenant_code, "connector_id": connector.connector_code,
            "sync_run_id": run.id, "records_count": count}


@router.post("/api/v1/reminders/send")
def reminders_send(connector: Connector = Depends(get_connector)):
    # Same placeholder response as the original server (no sending happens here).
    return {"status": "success", "attempted": 2, "sent": 2, "failed": 0}
