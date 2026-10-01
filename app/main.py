"""Manweta AI - FastAPI entrypoint. Serves the API and the (unchanged) dashboard UI from /static."""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .config import get_settings
from .db import SessionLocal, engine, init_db
from .routers import auth, connector, portal, webhook
from .seed import seed_demo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("manweta")
settings = get_settings()
STATIC = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not settings.encryption_key:
        log.warning("ENCRYPTION_KEY is not set - WhatsApp tokens will be stored unencrypted. Set it in production.")
    if settings.insecure_password_reset:
        log.warning("INSECURE_PASSWORD_RESET=true: anyone who knows an email can reset that account's password.")
    init_db()
    if settings.seed_demo_data:
        with SessionLocal() as db:
            seed_demo(db)
            db.commit()
    yield


app = FastAPI(
    title="Manweta AI", version="1.0.0", lifespan=lifespan,
    docs_url="/api/docs" if settings.enable_docs else None, redoc_url=None,
    openapi_url="/api/openapi.json" if settings.enable_docs else None,
)


@app.get("/health")
def health():  # liveness: must not touch the DB (Neon may be waking up)
    return {"status": "ok", "service": "Manweta AI", "version": "1.0.0"}


@app.get("/health/ready")
def ready():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return {"status": "ready"}


app.include_router(auth.router)
app.include_router(portal.router)
app.include_router(portal.public_router)
app.include_router(connector.router)
app.include_router(webhook.router)

app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")
if (STATIC / "blobs").is_dir():
    app.mount("/blobs", StaticFiles(directory=STATIC / "blobs"), name="blobs")


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(404, "Not Found")
    target = (STATIC / full_path).resolve()
    if full_path and target.is_file() and STATIC.resolve() in target.parents:
        return FileResponse(target)
    return FileResponse(STATIC / "index.html")
