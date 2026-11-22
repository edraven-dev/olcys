"""Internal HTTP API of the Python worker (called only by apps/worker, bound to the compose network and loopback).

Implemented: ``POST /v1/usernames/search`` (Maigret as a library, pinned site database, tag allow-list, own host
allow-list and request log), ``POST /v1/profiles/extract`` (socid-extractor on a captured page, no network),
``GET /healthz``. Planned: ``/v1/pdf/sign/prepare`` and ``/v1/pdf/sign/finish`` (pyHanko; the timestamp request is made
by the Node worker through its egress client, never by this service).

Rules: no proxies, no CAPTCHA or anti-bot bypass, no Maigret ``--ai`` mode, no auto-updating site database, no X
GraphQL probe. Third-party sites are only contacted when ``OLCYS_OSINT_ALLOW_EXTERNAL=true``; otherwise only the
fixture site. Scraped text is data: it is parsed, never executed and never sent to a model.
"""

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.requests import Request

from .ids import extract_profile
from .models import (
    ProfileExtractRequest,
    ProfileExtractResponse,
    UsernameSearchRequest,
    UsernameSearchResponse,
)
from .runner import ApiError, run_search
from .settings import SERVICE_VERSION, settings_from_env

app = FastAPI(title="olcys-osint", version=SERVICE_VERSION, docs_url=None, redoc_url=None, openapi_url=None)
SETTINGS = settings_from_env()


@app.exception_handler(ApiError)
async def api_error(_request: Request, error: ApiError) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"code": error.code, "message": error.message})


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, error: RequestValidationError) -> JSONResponse:
    fields = ", ".join(".".join(str(part) for part in e["loc"][1:]) or "body" for e in error.errors())
    return JSONResponse(status_code=422, content={"code": "invalid_request", "message": f"invalid fields: {fields}"})


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "olcys-osint",
        "version": SERVICE_VERSION,
        "allow_external": SETTINGS.allow_external,
    }


@app.post("/v1/usernames/search")
async def usernames_search(request: UsernameSearchRequest) -> UsernameSearchResponse:
    return await run_search(request, SETTINGS)


@app.post("/v1/profiles/extract")
def profiles_extract(request: ProfileExtractRequest) -> ProfileExtractResponse:
    ids, links = extract_profile(request.html, request.url)
    return ProfileExtractResponse(ids=ids, idsLinks=links)
