"""Database tables. Mirrors the in-memory Store of the original server.ts, one table per collection."""
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

Money = Numeric(14, 2)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


def _ts(**kw):
    return mapped_column(DateTime(timezone=True), **kw)


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_at: Mapped[datetime] = _ts(default=utcnow)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = _ts(default=utcnow)
    last_login_at: Mapped[datetime | None] = _ts(nullable=True)


Index("uq_users_email_lower", func.lower(User.__table__.c.email), unique=True)


class AuthSession(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 of the bearer token
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = _ts(default=utcnow)
    expires_at: Mapped[datetime] = _ts()


class ActivationCode(Base):
    __tablename__ = "activation_codes"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="unused")  # unused|used|expired|disabled
    created_at: Mapped[datetime] = _ts(default=utcnow)
    expires_at: Mapped[datetime | None] = _ts(nullable=True)
    used_at: Mapped[datetime | None] = _ts(nullable=True)


class Connector(Base):
    __tablename__ = "connectors"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    connector_code: Mapped[str] = mapped_column(String(32), unique=True)
    machine_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tally_version: Mapped[str | None] = mapped_column(String(100), nullable=True)
    api_key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_at: Mapped[datetime] = _ts(default=utcnow)
    last_seen_at: Mapped[datetime | None] = _ts(nullable=True)
    last_sync_at: Mapped[datetime | None] = _ts(nullable=True)
    updated_at: Mapped[datetime] = _ts(default=utcnow)


class Customer(Base):
    __tablename__ = "customers"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    phone_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    total_pending: Mapped[Decimal] = mapped_column(Money, default=0)
    bill_outstanding: Mapped[Decimal] = mapped_column(Money, default=0)
    on_account: Mapped[Decimal] = mapped_column(Money, default=0)
    closing_balance: Mapped[Decimal] = mapped_column(Money, default=0)
    whatsapp_opt_out: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_at: Mapped[datetime] = _ts(default=utcnow)
    updated_at: Mapped[datetime] = _ts(default=utcnow)
    last_synced_at: Mapped[datetime | None] = _ts(nullable=True)


Index("uq_customers_tenant_name", Customer.__table__.c.tenant_id, func.lower(Customer.__table__.c.name), unique=True)
Index("ix_customers_phone", Customer.__table__.c.tenant_id, Customer.__table__.c.phone_number)


class Invoice(Base):
    __tablename__ = "invoices"
    __table_args__ = (UniqueConstraint("tenant_id", "customer_id", "bill_ref", name="uq_invoice_bill"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), index=True)
    bill_ref: Mapped[str] = mapped_column(String(255))
    bill_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    opening_amount: Mapped[Decimal] = mapped_column(Money, default=0)
    pending_amount: Mapped[Decimal] = mapped_column(Money, default=0)
    overdue_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_on_account: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="outstanding")  # outstanding|closed
    external_key: Mapped[str] = mapped_column(String(600), default="")
    created_at: Mapped[datetime] = _ts(default=utcnow)
    updated_at: Mapped[datetime] = _ts(default=utcnow)
    last_synced_at: Mapped[datetime] = _ts(default=utcnow)


class ReminderSettings(Base):
    __tablename__ = "reminder_settings"
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    send_hour: Mapped[int] = mapped_column(Integer, default=10)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata")
    remind_overdue: Mapped[bool] = mapped_column(Boolean, default=True)
    remind_upcoming: Mapped[bool] = mapped_column(Boolean, default=False)
    days_before_due: Mapped[int] = mapped_column(Integer, default=3)
    repeat_every_days: Mapped[int] = mapped_column(Integer, default=7)
    min_amount: Mapped[Decimal] = mapped_column(Money, default=500)
    reminder_mode: Mapped[str] = mapped_column(String(16), default="customer_wise")
    last_auto_run_at: Mapped[datetime | None] = _ts(nullable=True)


class WhatsAppAccount(Base):
    __tablename__ = "whatsapp_accounts"
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), default="connected")
    waba_id: Mapped[str] = mapped_column(String(64))
    phone_number_id: Mapped[str] = mapped_column(String(64), index=True)
    display_phone_number: Mapped[str] = mapped_column(String(64))
    verified_name: Mapped[str] = mapped_column(String(255))
    quality_rating: Mapped[str] = mapped_column(String(16), default="GREEN")
    connection_method: Mapped[str] = mapped_column(String(24), default="manual")
    template_name: Mapped[str] = mapped_column(String(128), default="manweta_payment_reminder")
    template_status: Mapped[str] = mapped_column(String(16), default="APPROVED")
    template_language: Mapped[str] = mapped_column(String(16), default="en")
    template_reject_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    access_token_enc: Mapped[str] = mapped_column(Text)  # Fernet-encrypted when ENCRYPTION_KEY is set
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    connected_at: Mapped[datetime] = _ts(default=utcnow)


class ReminderLog(Base):
    __tablename__ = "reminder_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), index=True)
    customer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    invoice_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bill_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    reminder_mode: Mapped[str] = mapped_column(String(16), default="customer_wise")
    bills_count: Mapped[int] = mapped_column(Integer, default=1)
    channel: Mapped[str] = mapped_column(String(16), default="whatsapp")
    phone_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    template_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    amount: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|sent|delivered|read|failed
    trigger: Mapped[str] = mapped_column(String(16), default="manual")  # auto|manual
    wa_message_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = _ts(nullable=True)
    created_at: Mapped[datetime] = _ts(default=utcnow)
    status_updated_at: Mapped[datetime | None] = _ts(nullable=True)


class InboundMessage(Base):
    __tablename__ = "inbound_messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    wa_message_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone_number: Mapped[str] = mapped_column(String(32))
    message_type: Mapped[str] = mapped_column(String(32), default="text")
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    received_at: Mapped[datetime] = _ts(default=utcnow)


class SyncRun(Base):
    __tablename__ = "sync_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    tenant_id: Mapped[int] = mapped_column(ForeignKey("tenants.id", ondelete="CASCADE"), index=True)
    connector_id: Mapped[int] = mapped_column(ForeignKey("connectors.id", ondelete="CASCADE"))
    started_at: Mapped[datetime] = _ts(default=utcnow)
    completed_at: Mapped[datetime | None] = _ts(nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="success")
    records_count: Mapped[int] = mapped_column(Integer, default=0)


class InstallerRelease(Base):
    """Single-row table (id=1): the Windows Tally Connector installer served to every tenant."""
    __tablename__ = "installer_release"
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    version: Mapped[str] = mapped_column(String(32))
    file_name: Mapped[str] = mapped_column(String(255))
    file_size: Mapped[int] = mapped_column(BigInteger, default=0)
    file_size_formatted: Mapped[str] = mapped_column(String(32), default="")
    sha256: Mapped[str] = mapped_column(String(64), default="")
    # '/blobs/<file>' (bundled), 'https://...' (external) or 'azure-blob://<container>/<blob name>'
    blob_url: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(24), default="local_blob")  # blob_storage|local_blob|bundled
    uploaded_at: Mapped[datetime] = _ts(default=utcnow)
