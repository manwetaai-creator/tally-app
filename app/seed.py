"""Demo data identical to seedDemoData() in the original server.ts (only inserted once)."""
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from .models import (
    ActivationCode, Connector, Customer, InboundMessage, Invoice, ReminderLog, ReminderSettings, SyncRun, Tenant, User,
    WhatsAppAccount, utcnow,
)
from .security import encrypt_secret, hash_password, sha256_hex
from .utils import today_utc

DEMO_EMAIL = "demo@manweta.ai"


def seed_demo(db: Session) -> None:
    db.execute(text("SELECT pg_advisory_xact_lock(727202)"))  # several workers start at once; seed only once
    if db.scalar(select(User.id).where(func.lower(User.email) == DEMO_EMAIL)):
        return
    now = utcnow()
    today = today_utc()
    ago = lambda **kw: now - timedelta(**kw)  # noqa: E731
    D = Decimal

    t = Tenant(tenant_code="TC-DEMO-001", name="ABC Traders & Distributors", status="active", created_at=ago(days=30))
    db.add(t)
    db.flush()
    db.add(User(tenant_id=t.id, email=DEMO_EMAIL, full_name="Rajesh Kumar", password_hash=hash_password("password123"),
                created_at=ago(days=30), last_login_at=now))
    db.add(ActivationCode(tenant_id=t.id, code="MP-8924-1182", status="unused", expires_at=now + timedelta(days=1)))
    conn = Connector(tenant_id=t.id, connector_code="CN-DESKTOP-901", machine_name="ACCOUNTS-PC (TallyPrime)",
                     tally_version="TallyPrime 4.1.0", api_key_hash=sha256_hex("demo_api_key"), status="active",
                     created_at=ago(days=14), last_seen_at=ago(minutes=12), last_sync_at=ago(minutes=45))
    db.add(conn)
    db.add(WhatsAppAccount(
        tenant_id=t.id, status="connected", waba_id="109283746501928", phone_number_id="209384756102938",
        display_phone_number="+91 98000 00001", verified_name="ABC Traders Official", quality_rating="GREEN",
        connection_method="manual", template_name="manweta_payment_reminder", template_status="APPROVED",
        template_language="en", access_token_enc=encrypt_secret("meta_demo_access_token"), connected_at=ago(days=10),
    ))
    db.add(ReminderSettings(tenant_id=t.id, enabled=True, send_hour=10, timezone="Asia/Kolkata", remind_overdue=True,
                            remind_upcoming=True, days_before_due=3, repeat_every_days=7, min_amount=D(500),
                            reminder_mode="customer_wise", last_auto_run_at=ago(days=1)))
    db.flush()

    synced = ago(minutes=45)

    def customer(name, phone, pending, created_days, opt_out=False):
        c = Customer(tenant_id=t.id, name=name, phone_number=phone, total_pending=D(pending), bill_outstanding=D(pending),
                     on_account=D(0), closing_balance=D(pending), whatsapp_opt_out=opt_out, status="active",
                     created_at=ago(days=created_days), last_synced_at=synced)
        db.add(c)
        db.flush()
        return c

    def bill(c, ref, bill_off, due_off, amount, created_days):
        due = today + timedelta(days=due_off)
        inv = Invoice(tenant_id=t.id, customer_id=c.id, bill_ref=ref, bill_date=today + timedelta(days=bill_off), due_date=due,
                      opening_amount=D(amount), pending_amount=D(amount), overdue_days=max(0, -due_off), is_on_account=False,
                      status="outstanding", external_key=f"{t.id}_{c.name}_{ref}", created_at=ago(days=created_days), last_synced_at=synced)
        db.add(inv)
        db.flush()
        return inv

    c1 = customer("Rahul Traders", "919876543210", 12500, 25)
    i1 = bill(c1, "INV-2026-089", -40, -15, 8000, 40)
    bill(c1, "INV-2026-105", -20, -5, 4500, 20)
    c2 = customer("Priya Textiles", "919876543211", 28400, 20)
    i2 = bill(c2, "INV-2026-102", -25, -8, 18400, 25)
    bill(c2, "INV-2026-118", -14, 2, 6000, 14)
    bill(c2, "INV-2026-125", -10, 6, 4000, 10)
    c3 = customer("Sharma Electronics", "919876543212", 9750, 15)
    bill(c3, "INV-2026-114", -18, 2, 9750, 18)
    c4 = customer("Gupta Wholesale Mart", None, 45000, 30)  # missing-phone test case
    bill(c4, "INV-2026-075", -50, -20, 45000, 50)
    c5 = customer("Apex Distributors", "919876543214", 18200, 25, opt_out=True)  # opted-out test case
    bill(c5, "INV-2026-095", -30, -12, 18200, 30)

    sent = ago(days=2)
    db.add(ReminderLog(tenant_id=t.id, customer_id=c1.id, customer_name=c1.name, invoice_id=i1.id, phone_number=c1.phone_number,
                       template_name="manweta_payment_reminder", amount=D(12500), status="read", trigger="auto",
                       wa_message_id="wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgSRTNDRjc4REI3MkREQzk0M0FCAA==", sent_at=sent,
                       created_at=sent, status_updated_at=sent + timedelta(seconds=120)))
    db.add(ReminderLog(tenant_id=t.id, customer_id=c2.id, customer_name=c2.name, invoice_id=i2.id, phone_number=c2.phone_number,
                       template_name="manweta_payment_reminder", amount=D(28400), status="delivered", trigger="auto",
                       wa_message_id="wamid.HBgMOTE5ODc2NTQzMjExFQIAERgSRTNDRjc4REI3MkREQzk0M0FDAB==", sent_at=sent,
                       created_at=sent, status_updated_at=sent + timedelta(seconds=45)))
    db.add(InboundMessage(tenant_id=t.id, customer_id=c1.id, wa_message_id="wamid.inbound.001", phone_number="919876543210",
                          message_type="text", body="Hi Rajesh, NEFT payment of ₹12,500 done today ref #UTR99281. Please update statement.",
                          received_at=ago(days=1)))
    db.add(InboundMessage(tenant_id=t.id, customer_id=c2.id, wa_message_id="wamid.inbound.002", phone_number="919876543211",
                          message_type="text", body="Acknowledged. Arranging payment by this Friday.", received_at=ago(hours=18)))
    db.add(SyncRun(tenant_id=t.id, connector_id=conn.id, started_at=ago(minutes=46), completed_at=synced, status="success", records_count=5))
    db.flush()
