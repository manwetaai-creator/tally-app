"""SQLAlchemy engine / session setup for Neon Postgres."""
from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings


def normalize_url(url: str) -> str:
    """Accept postgres:// and postgresql:// URLs and force the psycopg (v3) driver."""
    url = url.strip()
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


engine = create_engine(
    normalize_url(get_settings().database_url),
    pool_size=5,
    max_overflow=5,
    pool_pre_ping=True,  # Neon suspends idle computes / drops idle connections
    pool_recycle=240,
    # Neon's pooled endpoint is PgBouncer; avoid server-side prepared statements.
    connect_args={"prepare_threshold": None},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db(request: Request) -> Iterator[Session]:
    """Per-request session. Commit happens in TxRoute (before the response is sent), rollback on any error."""
    db = SessionLocal()
    request.state.db = db
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db() -> None:
    """Create tables if missing. An advisory lock keeps concurrent instances from racing."""
    from .models import Base

    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(727201)"))
        Base.metadata.create_all(conn)
