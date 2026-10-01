"""Small helpers shared by the routers. Behaviour is ported 1:1 from server.ts."""
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

OPT_OUT_WORDS = {"stop", "unsubscribe", "cancel", "end", "quit", "halt"}
OPT_IN_WORDS = {"start", "unstop", "subscribe", "yes", "rejoin"}


def normalize_phone(raw: Any) -> str | None:
    if not raw:
        return None
    digits = re.sub(r"\D", "", str(raw))
    if not digits:
        return None
    c = digits
    if c.startswith("00"):
        c = c[2:]
    if len(c) == 10:
        c = "91" + c
    elif len(c) == 11 and c.startswith("0"):
        c = "91" + c[1:]
    if len(c) < 10 or len(c) > 15:
        return None
    return c


def iso(dt: datetime | None) -> str | None:
    """JS-style ISO string, e.g. 2026-10-01T04:16:00.000Z (the UI parses these with new Date())."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def d2s(d: date | None) -> str | None:
    return d.isoformat() if d else None


def parse_date(v: Any) -> date | None:
    if not v:
        return None
    try:
        return date.fromisoformat(str(v).strip()[:10])
    except ValueError:
        return None


def num(v: Any, default: float | Decimal = 0) -> Decimal:
    """Lenient number parse (the connector sends JSON numbers, sometimes strings / nulls)."""
    if v is None or v == "":
        return Decimal(str(default))
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal(str(default))


def f(v: Decimal | float | int | None) -> float:
    return float(v) if v is not None else 0.0


def today_utc() -> date:
    return datetime.now(timezone.utc).date()
