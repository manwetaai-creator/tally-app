"""Reminder candidate selection (ported from calculateCandidates) and the WhatsApp send step.

send_whatsapp_reminder() is the single seam to replace when you go live with Meta's Cloud API.
Right now it behaves like the original app: it *simulates* a successful send (status 'delivered')."""
import base64
import secrets
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Customer, Invoice, ReminderLog, ReminderSettings, WhatsAppAccount, utcnow
from .utils import d2s, f, normalize_phone, today_utc


def get_or_create_settings(db: Session, tenant_id: int) -> ReminderSettings:
    s = db.get(ReminderSettings, tenant_id)
    if s is None:
        s = ReminderSettings(tenant_id=tenant_id)
        db.add(s)
        db.flush()
    return s


@dataclass
class SendResult:
    status: str  # sent|delivered|failed
    wa_message_id: str | None
    error: str | None = None


def send_whatsapp_reminder(account: WhatsAppAccount, phone: str, customer_name: str, amount: float, due: str | None) -> SendResult:
    """TODO(live): POST https://graph.facebook.com/v21.0/{account.phone_number_id}/messages with the approved
    template (decrypt the token with security.decrypt_secret(account.access_token_enc)), and return
    status='sent' + the real wamid. Delivery/read updates then arrive through the webhook."""
    return SendResult(status="delivered", wa_message_id="wamid.HBgM" + base64.b64encode(secrets.token_bytes(16)).decode())


def make_log(db: Session, tenant_id: int, account: WhatsAppAccount, *, customer: Customer, phone: str, amount, invoice_id,
             bill_ref, mode: str, bills: int, trigger: str = "manual") -> ReminderLog:
    res = send_whatsapp_reminder(account, phone, customer.name, f(amount), None)
    now = utcnow()
    log = ReminderLog(
        tenant_id=tenant_id, customer_id=customer.id, customer_name=customer.name, invoice_id=invoice_id,
        bill_ref=bill_ref, reminder_mode=mode, bills_count=bills, channel="whatsapp", phone_number=phone,
        template_name=account.template_name, amount=amount, status=res.status, trigger=trigger,
        wa_message_id=res.wa_message_id, error_message=res.error, sent_at=now if res.status != "failed" else None,
        created_at=now, status_updated_at=now,
    )
    db.add(log)
    db.flush()
    return log


def calculate_candidates(db: Session, tenant_id: int, mode_override: str | None = None) -> dict:
    s = get_or_create_settings(db, tenant_id)
    mode = mode_override if mode_override in ("customer_wise", "bill_wise") else (s.reminder_mode or "customer_wise")
    today = today_utc()
    window = today + timedelta(days=s.days_before_due or 3)
    cutoff = utcnow() - timedelta(days=s.repeat_every_days or 7)
    min_amount = f(s.min_amount)
    bill_wise = mode == "bill_wise"

    report = {
        "candidates": [],
        "skipped": {"missing_phone": 0, "opted_out": 0, "recently_reminded": 0, "below_minimum": 0},
        "reminder_mode": mode,
    }

    customers = db.scalars(select(Customer).where(Customer.tenant_id == tenant_id, Customer.status == "active")).all()
    invoices = db.scalars(select(Invoice).where(
        Invoice.tenant_id == tenant_id, Invoice.status == "outstanding", Invoice.is_on_account.is_(False), Invoice.pending_amount > 0,
    )).all()
    by_customer: dict[int, list[Invoice]] = {}
    for inv in invoices:
        by_customer.setdefault(inv.customer_id, []).append(inv)

    # newest non-failed log per customer
    last_ids = select(func.max(ReminderLog.id)).where(ReminderLog.tenant_id == tenant_id, ReminderLog.status != "failed").group_by(ReminderLog.customer_id)
    last_created = {l.customer_id: l.created_at for l in db.scalars(select(ReminderLog).where(ReminderLog.id.in_(last_ids)))}

    for c in customers:
        qualifying = []
        for i in by_customer.get(c.id, []):
            if not i.due_date:
                continue
            if s.remind_overdue and i.due_date < today:
                qualifying.append(i)
            elif s.remind_upcoming and today <= i.due_date <= window:
                qualifying.append(i)
        if not qualifying:
            continue
        weight = len(qualifying) if bill_wise else 1

        if c.whatsapp_opt_out:
            report["skipped"]["opted_out"] += weight
            continue
        phone = normalize_phone(c.phone_number)
        if not phone:
            report["skipped"]["missing_phone"] += weight
            continue
        total = sum(f(i.pending_amount) for i in qualifying)
        if total < min_amount:
            report["skipped"]["below_minimum"] += weight
            continue
        last = last_created.get(c.id)
        if last is not None and last >= cutoff:
            report["skipped"]["recently_reminded"] += weight
            continue

        if bill_wise:
            for inv in qualifying:
                od = max(0, (today - inv.due_date).days) if inv.due_date < today else 0
                reason = f"{inv.bill_ref}: {od} days overdue" if od > 0 else f"{inv.bill_ref}: Due soon ({d2s(inv.due_date)})"
                report["candidates"].append({
                    "customer_id": c.id, "name": c.name, "phone": phone, "amount": f(inv.pending_amount),
                    "due_date": d2s(inv.due_date), "reason": reason, "overdue_days": od, "bills": 1,
                    "bill_ref": inv.bill_ref, "invoice_id": inv.id, "mode": "bill_wise",
                })
        else:
            max_od = max([(today - i.due_date).days for i in qualifying if i.due_date < today] or [0])
            earliest = min(i.due_date for i in qualifying)
            n = len(qualifying)
            word = "bill" if n == 1 else "bills"
            reason = f"{max_od} days overdue ({n} {word})" if max_od > 0 else f"Due soon ({n} {word}, earliest: {d2s(earliest)})"
            report["candidates"].append({
                "customer_id": c.id, "name": c.name, "phone": phone, "amount": total, "due_date": d2s(earliest),
                "reason": reason, "overdue_days": max_od, "bills": n, "invoice_id": qualifying[0].id,
                "bill_ref": ", ".join(i.bill_ref for i in qualifying), "mode": "customer_wise",
            })

    report["candidates"].sort(key=lambda x: (-x["overdue_days"], -x["amount"]))
    return report
