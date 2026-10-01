"""Route class that commits the request's DB session *before* the response is sent.

(Newer FastAPI versions run yield-dependency cleanup after the response goes out, which would let the browser's
next request race the commit - e.g. GET /auth/me right after signup.)"""
from fastapi import Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.routing import APIRoute


class TxRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def tx_handler(request: Request) -> Response:
            response = await handler(request)  # raises on HTTPException -> get_db rolls back, nothing is committed
            db = getattr(request.state, "db", None)
            if db is not None and response.status_code < 400:
                await run_in_threadpool(db.commit)
            return response

        return tx_handler
