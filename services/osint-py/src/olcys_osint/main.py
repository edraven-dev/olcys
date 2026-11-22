"""Internal HTTP API of the Python worker (called only by apps/worker, bound to the compose network and loopback).

Implemented: ``POST /v1/usernames/search`` (Maigret as a library, pinned site database, tag allow-list, own host
allow-list and request log), ``POST /v1/profiles/extract`` (socid-extractor on a captured page, no network),
``POST /v1/pdf/sign/prepare`` and ``POST /v1/pdf/sign/finish`` (pyHanko, PAdES with a local demo key; the timestamp
request is made by the Node worker through its egress client, never by this service), ``GET /v1/pdf/signer`` (public
certificates only), ``GET /healthz``.

Rules: no proxies, no CAPTCHA or anti-bot bypass, no Maigret ``--ai`` mode, no auto-updating site database, no X
GraphQL probe. Third-party sites are only contacted when ``OLCYS_OSINT_ALLOW_EXTERNAL=true``; otherwise only the
fixture site. Scraped text is data: it is parsed, never executed and never sent to a model.
"""

import base64
import binascii
import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.requests import Request

from .demo_signer import load_or_create_demo_signer
from .ids import extract_profile
from .models import (
    ProfileExtractRequest,
    ProfileExtractResponse,
    UsernameSearchRequest,
    UsernameSearchResponse,
)
from .pdf_sign import MAX_PDF_BYTES, PdfSigningService
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


# --- PDF signing ---------------------------------------------------------------------------------------------------

MAX_BODY_BYTES = MAX_PDF_BYTES * 4 // 3 + 4096
_SIGNING: dict[str, PdfSigningService] = {}


def signing_service() -> PdfSigningService:
    """The signing service, created on first use (the demo identity is generated then when none exists)."""
    if "service" not in _SIGNING:
        directory = Path(os.environ.get("OLCYS_SIGNING_DIR", "/signing"))
        try:
            _SIGNING["service"] = PdfSigningService(
                load_or_create_demo_signer(directory, int(os.environ.get("OLCYS_SIGNING_KEY_BITS", "3072")))
            )
        except OSError as error:
            raise ApiError(503, "signing_unavailable", f"no signing key: {type(error).__name__}") from error
    return _SIGNING["service"]


async def read_json(request: Request) -> dict[str, object]:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise ApiError(413, "too_large", "the request body is too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise ApiError(413, "too_large", "the request body is too large")
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks))
    except ValueError as error:
        raise ApiError(422, "invalid_request", "the body is not JSON") from error
    if not isinstance(body, dict):
        raise ApiError(422, "invalid_request", "the body must be an object")
    return body


def decode_b64(value: object, name: str) -> bytes:
    if not isinstance(value, str):
        raise ApiError(422, "invalid_request", f"invalid fields: {name}")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ApiError(422, "invalid_request", f"invalid fields: {name}") from error


@app.post("/v1/pdf/sign/prepare")
async def pdf_sign_prepare(request: Request) -> dict[str, str]:
    body = await read_json(request)
    pdf = decode_b64(body.get("pdfBase64"), "pdfBase64")
    if len(pdf) > MAX_PDF_BYTES:
        raise ApiError(413, "too_large", "the PDF is larger than 50 MB")
    field_name, reason = body.get("fieldName", "Podpis"), body.get("reason", "Raport z analizy OSINT")
    if not isinstance(field_name, str) or not isinstance(reason, str) or not field_name or len(field_name) > 64:
        raise ApiError(422, "invalid_request", "invalid fields: fieldName, reason")
    session_id, digest = await signing_service().prepare(pdf, field_name, reason)
    return {"sessionId": session_id, "signatureDigestSha256": digest}


@app.post("/v1/pdf/sign/finish")
async def pdf_sign_finish(request: Request) -> dict[str, object]:
    body = await read_json(request)
    session_id, token = body.get("sessionId"), body.get("timestampTokenBase64")
    if not isinstance(session_id, str):
        raise ApiError(422, "invalid_request", "invalid fields: sessionId")
    token_der = None if token is None else decode_b64(token, "timestampTokenBase64")
    pdf, cert_sha256, signed_at, timestamped = await signing_service().finish(session_id, token_der)
    return {
        "pdfBase64": base64.b64encode(pdf).decode("ascii"),
        "signerCertSha256": cert_sha256,
        "signedAt": signed_at,
        "timestamped": timestamped,
    }


@app.get("/v1/pdf/signer")
def pdf_signer() -> dict[str, object]:
    """Public part of the demo identity (certificate and CA) so that a verifier can trust it explicitly."""
    service = signing_service()
    return {
        "qualified": False,
        "certificateSha256": service.cert_sha256,
        "certificatePem": service.certificate_pem,
        "caPem": service.ca_pem,
    }
