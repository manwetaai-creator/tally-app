"""End-to-end smoke test against a real Postgres (a local container or a Neon branch).

    DATABASE_URL=postgresql://... python -m pytest tests -q
"""
import json
import uuid

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_health():
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/").status_code == 200  # UI index.html


def test_demo_login_and_overview():
    with TestClient(app) as c:  # runs lifespan: creates tables + seeds demo data
        r = c.post("/api/v1/auth/login", json={"email": "demo@manweta.ai", "password": "password123"})
        assert r.status_code == 200, r.text
        token = r.json()["access_token"]
        assert c.get("/api/v1/auth/me", headers=auth(token)).json()["tenant"]["name"].startswith("ABC Traders")
        ov = c.get("/api/v1/portal/overview", headers=auth(token)).json()
        assert ov["receivables"]["open_bills"] == 8
        assert ov["onboarding_complete"] is True
        assert c.post("/api/v1/auth/login", json={"email": "demo@manweta.ai", "password": "wrong"}).status_code == 401
        assert c.get("/api/v1/portal/overview").status_code == 401


def test_full_flow_new_tenant():
    with TestClient(app) as c:
        email = f"t-{uuid.uuid4().hex[:10]}@example.com"
        s = c.post("/api/v1/auth/signup", json={"company_name": "Test Co", "email": email, "password": "supersecret1"})
        assert s.status_code == 200, s.text
        h = auth(s.json()["access_token"])

        code = c.get("/api/v1/portal/tally", headers=h).json()["activation_code"]
        act = c.post("/api/v1/connector/activate", json={"activation_code": code, "machine_name": "PC"})
        assert act.status_code == 200, act.text
        ch = auth(act.json()["api_key"])

        payload = {"customers": [{"name": "Acme", "mobile": "98765 43210", "total_pending": 1500, "bills": [
            {"bill_ref": "B1", "due_date": "2020-01-01", "pending_amount": 1500, "opening_amount": 1500}]}]}
        sy = c.post("/api/v1/connector/sync", json=payload, headers=ch)
        assert sy.status_code == 200 and sy.json()["records_count"] == 1
        assert c.post("/api/v1/connector/sync", json=payload, headers=ch).status_code == 200  # idempotent upsert

        items = c.get("/api/v1/portal/customers", headers=h).json()["items"]
        assert len(items) == 1 and items[0]["phone_number"] == "919876543210" and items[0]["bills_count"] == 1

        prev = c.get("/api/v1/portal/reminders/preview", headers=h).json()
        assert prev["count"] == 1

        assert c.post("/api/v1/portal/reminders/run", headers=h, json={}).status_code == 409  # WhatsApp not connected
        wa = c.post("/api/v1/portal/whatsapp/manual", headers=h, json={"waba_id": "1", "phone_number_id": "2222222222", "access_token": "tok"})
        assert wa.json()["account"]["ready_to_send"] is True and "access_token" not in json.dumps(wa.json())

        run = c.post("/api/v1/portal/reminders/run", headers=h, json={}).json()
        assert run["sent"] == 1
        assert c.get("/api/v1/portal/reminders/preview", headers=h).json()["skipped"]["recently_reminded"] == 1

        hook = {"entry": [{"changes": [{"value": {"metadata": {"phone_number_id": "2222222222"},
                "messages": [{"from": "919876543210", "id": "wamid.x", "type": "text", "text": {"body": "STOP"}}]}}]}]}
        assert c.post("/api/v1/whatsapp/webhook", json=hook).status_code == 200
        assert c.get("/api/v1/portal/customers", headers=h).json()["items"][0]["whatsapp_opt_out"] is True
        assert c.get("/api/v1/portal/replies", headers=h).json()["items"][0]["body"] == "STOP"
