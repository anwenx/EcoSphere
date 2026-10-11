import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .routing import InputError
from .schemas import OptimizeRequest, OptimizeResponse
from .solver import run_optimization

app = FastAPI(title="EcoSphere Optimizer", version="0.1.0")


def require_token(authorization: str | None = Header(default=None)) -> None:
    """Service-to-service auth: the Express API sends `Authorization: Bearer <OPTIMIZER_SERVICE_TOKEN>`."""
    token = os.environ.get("OPTIMIZER_SERVICE_TOKEN")
    if not token:
        raise HTTPException(status_code=503, detail="OPTIMIZER_SERVICE_TOKEN is not configured")
    if authorization is None or not hmac.compare_digest(authorization, f"Bearer {token}"):
        raise HTTPException(status_code=401, detail="Invalid service token")


@app.exception_handler(InputError)
async def input_error_handler(_: Request, exc: InputError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.get("/health")
def health():
    return {"status": "ok"}


# Plain `def` so FastAPI runs the CPU-bound solve in its threadpool instead of blocking the event loop.
@app.post("/optimize", response_model=OptimizeResponse, dependencies=[Depends(require_token)])
def optimize(req: OptimizeRequest) -> OptimizeResponse:
    return run_optimization(req)
