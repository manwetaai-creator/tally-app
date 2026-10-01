"""Meta WhatsApp Cloud API webhook: verification, delivery statuses, inbound replies (STOP/START)."""
import hashlib
import hmac
import json
import secrets

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..txroute import TxRoute
from ..config import get_settings
from ..db import get_db
from ..models import Customer, InboundMessage, ReminderLog, WhatsAppAccount, utcnow
from ..utils import OPT_IN_WORDS, OPT_OUT_WORDS, normalize_phone

router = APIRouter(prefix="/api/v1/whatsapp", tags=["webhook"], route_class=TxRoute)
_RANK = {"queued": 0, "sent": 1, "delivered": 2, "read": 3}


@router.get("/webhook")
def verify(hub_mode: str | None = Query(None, alias="hub.mode"), hub_verify_token: str | None = Query(None, alias="hub.verify_token"),
           hub_challenge: str | None = Query(None, alias="hub.challenge")):
    if hub_mode == "subscribe" and hub_verify_token == get_settings().meta_webhook_verify_token:
        return PlainTextResponse(hub_challenge or "", status_code=200)
    return PlainTextResponse("Forbidden", status_code=403)


@router.post("/webhook")
async def receive(request: Request, db: Session = Depends(get_db)):
    raw = await request.body()
    secret = get_settings().meta_app_secret
    if secret:
        sig = request.headers.get("x-hub-signature-256", "")
        expected = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            raise HTTPException(403, "Invalid signature")
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return PlainTextResponse("EVENT_RECEIVED", status_code=200)

    for entry in body.get("entry") or []:
        for change in entry.get("changes") or []:
            val = change.get("value") or {}

            for st in val.get("statuses") or []:
                new = st.get("status")
                if not st.get("id") or not new:
                    continue
                log = db.scalar(select(ReminderLog).where(ReminderLog.wa_message_id == st["id"]))
                if not log:
                    continue
                # Meta can deliver statuses out of order - never move 'read' back to 'delivered'.
                if new == "failed" or _RANK.get(new, -1) >= _RANK.get(log.status, -1):
                    log.status = new
                    log.status_updated_at = utcnow()
                    if new == "failed":
                        errs = st.get("errors") or [{}]
                        log.error_message = errs[0].get("title") or errs[0].get("message") or log.error_message

            pnid = (val.get("metadata") or {}).get("phone_number_id")
            acct = db.scalar(select(WhatsAppAccount).where(WhatsAppAccount.phone_number_id == pnid)) if pnid else None
            for msg in val.get("messages") or []:
                from_number = msg.get("from") or ""
                body_text = (msg.get("text") or {}).get("body") or (msg.get("button") or {}).get("text") or ""
                clean = normalize_phone(from_number)
                q = select(Customer).where(Customer.phone_number == clean) if clean else None
                if q is not None and acct:
                    q = q.where(Customer.tenant_id == acct.tenant_id)
                customer = db.scalars(q).first() if q is not None else None
                tenant_id = acct.tenant_id if acct else (customer.tenant_id if customer else None)
                if tenant_id is None:
                    continue  # cannot attribute the message to a client
                db.add(InboundMessage(
                    tenant_id=tenant_id, customer_id=customer.id if customer else None,
                    wa_message_id=msg.get("id") or "wamid." + secrets.token_hex(8), phone_number=from_number,
                    message_type=msg.get("type") or "text", body=body_text, received_at=utcnow(),
                ))
                word = body_text.strip().lower()
                if customer and word in OPT_OUT_WORDS:
                    customer.whatsapp_opt_out = True
                elif customer and word in OPT_IN_WORDS:
                    customer.whatsapp_opt_out = False
    return PlainTextResponse("EVENT_RECEIVED", status_code=200)
