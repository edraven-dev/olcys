"""PAdES signing: prepare -> external time-stamp -> finish. Test certificates and tokens are made in the test."""

import asyncio
import base64
import datetime as dt
import hashlib
import io
import socket

import pytest
from asn1crypto import tsp
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi.testclient import TestClient
from pyhanko.keys import load_certs_from_pemder_data, load_private_key_from_pemder_data
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.writer import PdfFileWriter
from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper
from pyhanko.sign.validation import async_validate_pdf_signature
from pyhanko.sign.validation.status import SignatureCoverageLevel
from pyhanko_certvalidator import ValidationContext

from olcys_osint import main
from olcys_osint.demo_signer import DEMO_COMMON_NAME, generate_demo_signer, load_or_create_demo_signer
from olcys_osint.pdf_sign import PdfSigningService
from olcys_osint.runner import ApiError


def minimal_pdf() -> bytes:
    out = io.BytesIO()
    writer = PdfFileWriter()
    page = generic.DictionaryObject(
        {
            generic.pdf_name("/Type"): generic.pdf_name("/Page"),
            generic.pdf_name("/MediaBox"): generic.ArrayObject([generic.NumberObject(n) for n in (0, 0, 200, 200)]),
            generic.pdf_name("/Resources"): generic.DictionaryObject(),
        }
    )
    writer.insert_page(page)
    writer.write(out)
    return out.getvalue()


@pytest.fixture(scope="module")
def identity():
    return generate_demo_signer(bits=2048)


@pytest.fixture
def service(identity):
    return PdfSigningService(identity)


def tsa_stamper(fixed: dt.datetime | None = None) -> tuple[DummyTimeStamper, object]:
    now = dt.datetime.now(dt.UTC)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Testowy TSA (synthetic)")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    asn_cert = next(iter(load_certs_from_pemder_data(cert_pem)))
    asn_key = load_private_key_from_pemder_data(key_pem, passphrase=None)
    return DummyTimeStamper(asn_cert, asn_key, fixed_dt=fixed), asn_cert


def stamp_token(embedded):
    for attr in embedded.signer_info["unsigned_attrs"] or []:
        if attr["type"].native == "signature_time_stamp_token":
            return attr["values"][0]
    return None


async def sign(service, token: bool, tsa=None):
    session, digest = await service.prepare(minimal_pdf(), "Podpis", "Raport z analizy OSINT")
    token_der = None
    if token:
        stamper, _ = tsa or tsa_stamper()
        token_der = (await stamper.async_timestamp(bytes.fromhex(digest), "sha256")).dump()
    return session, digest, token_der


def validate(pdf: bytes, identity, extra_roots=()):
    roots = list(load_certs_from_pemder_data(identity.ca_pem)) + list(extra_roots)
    reader = PdfFileReader(io.BytesIO(pdf))
    embedded = reader.embedded_signatures
    assert len(embedded) == 1
    context = ValidationContext(trust_roots=roots, allow_fetching=False)
    status = asyncio.run(async_validate_pdf_signature(embedded[0], context))
    return embedded[0], status


async def test_prepare_stamp_finish_is_pades_b_t(service, identity):
    stamper, tsa_cert = tsa_stamper()
    session, digest, token = await sign(service, True, (stamper, tsa_cert))
    pdf, cert_sha, _signed_at, timestamped = await service.finish(session, token)
    assert timestamped is True
    assert cert_sha == hashlib.sha256(load_certs_from_pemder_data(identity.cert_pem).__next__().dump()).hexdigest()
    embedded, status = await asyncio.to_thread(validate, pdf, identity, [tsa_cert])
    assert status.intact and status.valid and status.trusted
    assert status.coverage == SignatureCoverageLevel.ENTIRE_FILE
    assert status.timestamp_validity is not None and status.timestamp_validity.intact
    token = stamp_token(embedded)
    assert token is not None
    imprint = token["content"]["encap_content_info"]["content"].parsed["message_imprint"]
    signature_value = embedded.signer_info["signature"].native
    assert imprint["hashed_message"].native == hashlib.sha256(signature_value).digest()
    assert digest == hashlib.sha256(signature_value).hexdigest()


async def test_without_a_token_the_signature_is_pades_b_b(service, identity):
    session, _digest, _ = await sign(service, False)
    pdf, _cert, _at, timestamped = await service.finish(session, None)
    assert timestamped is False
    embedded, status = await asyncio.to_thread(validate, pdf, identity)
    assert status.intact and status.valid and status.trusted
    assert stamp_token(embedded) is None


async def test_certificate_says_it_is_a_non_qualified_demo(identity):
    cert = x509.load_pem_x509_certificate(identity.cert_pem)
    assert cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value == DEMO_COMMON_NAME
    assert "niekwalifikowany" in DEMO_COMMON_NAME


async def test_unknown_session_is_gone(service):
    with pytest.raises(ApiError) as error:
        await service.finish("0" * 32, None)
    assert (error.value.status_code, error.value.code) == (410, "session_expired")


async def test_expired_session_is_gone(identity):
    clock = {"now": 1000.0}
    service = PdfSigningService(identity, clock=lambda: clock["now"])
    session, _digest, _ = await sign(service, False)
    clock["now"] += 601
    with pytest.raises(ApiError) as error:
        await service.finish(session, None)
    assert error.value.code == "session_expired"


async def test_token_for_another_digest_is_rejected_and_the_session_survives(service):
    session, _digest, _ = await sign(service, False)
    stamper, _ = tsa_stamper()
    other = (await stamper.async_timestamp(hashlib.sha256(b"inny dokument").digest(), "sha256")).dump()
    with pytest.raises(ApiError) as error:
        await service.finish(session, other)
    assert (error.value.status_code, error.value.code) == (400, "timestamp_mismatch")
    pdf, *_ = await service.finish(session, None)
    assert pdf.startswith(b"%PDF")


async def test_session_limit(identity):
    service = PdfSigningService(identity)
    for _ in range(8):
        await sign(service, False)
    with pytest.raises(ApiError) as error:
        await sign(service, False)
    assert error.value.status_code == 429


async def test_signing_never_opens_a_connection(service, monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("signing must not open a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    stamper, _ = tsa_stamper()
    session, _digest, token = await sign(service, True, (stamper, None))
    pdf, *_ = await service.finish(session, token)
    assert pdf.startswith(b"%PDF")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OLCYS_SIGNING_DIR", str(tmp_path / "signing"))
    monkeypatch.setenv("OLCYS_SIGNING_KEY_BITS", "2048")
    main._SIGNING.clear()
    yield TestClient(main.app)
    main._SIGNING.clear()


def test_http_flow_creates_the_demo_identity_on_first_use(client, tmp_path):
    pdf = base64.b64encode(minimal_pdf()).decode()
    prepared = client.post("/v1/pdf/sign/prepare", json={"pdfBase64": pdf, "fieldName": "Podpis", "reason": "test"})
    assert prepared.status_code == 200
    body = prepared.json()
    assert len(body["signatureDigestSha256"]) == 64
    finished = client.post("/v1/pdf/sign/finish", json={"sessionId": body["sessionId"], "timestampTokenBase64": None})
    assert finished.status_code == 200
    assert finished.json()["timestamped"] is False
    assert base64.b64decode(finished.json()["pdfBase64"]).startswith(b"%PDF")
    key = tmp_path / "signing" / "signing-key.pem"
    assert key.exists() and key.stat().st_mode & 0o077 == 0
    signer = client.get("/v1/pdf/signer").json()
    assert signer["qualified"] is False and "PRIVATE KEY" not in str(signer)


def test_http_errors(client):
    gone = client.post("/v1/pdf/sign/finish", json={"sessionId": "x", "timestampTokenBase64": None})
    assert (gone.status_code, gone.json()["code"]) == (410, "session_expired")
    bad = client.post("/v1/pdf/sign/prepare", json={"pdfBase64": "%%%"})
    assert bad.status_code == 422
    junk = client.post("/v1/pdf/sign/prepare", json={"pdfBase64": base64.b64encode(b"not a pdf").decode()})
    assert (junk.status_code, junk.json()["code"]) == (400, "invalid_pdf")


def test_a_51_mb_body_is_refused(client):
    huge = base64.b64encode(b"\0" * (51 * 1024 * 1024)).decode()
    response = client.post("/v1/pdf/sign/prepare", json={"pdfBase64": huge})
    assert response.status_code == 413


def test_demo_identity_is_kept_not_regenerated(tmp_path):
    first = load_or_create_demo_signer(tmp_path / "k", bits=2048)
    assert load_or_create_demo_signer(tmp_path / "k", bits=2048) == first


def as_response(token_der: bytes) -> bytes:
    """What the worker's timestamper hands over: the TSA's full RFC 3161 TimeStampResp, not the bare token."""
    from asn1crypto import cms

    fields = {"status": {"status": "granted"}, "time_stamp_token": cms.ContentInfo.load(token_der)}
    return tsp.TimeStampResp(fields).dump()


async def test_a_full_time_stamp_response_reaches_pades_b_t(service, identity):
    stamper, tsa_cert = tsa_stamper()
    session, _digest, token = await sign(service, True, (stamper, tsa_cert))
    pdf, _cert, _at, timestamped = await service.finish(session, as_response(token))
    assert timestamped is True
    embedded, status = await asyncio.to_thread(validate, pdf, identity, [tsa_cert])
    assert status.valid and status.trusted
    assert stamp_token(embedded) is not None
    assert status.timestamp_validity is not None and status.timestamp_validity.intact


async def test_a_response_that_is_not_granted_is_refused(service):
    session, *_ = await sign(service, False)
    rejection = bytes.fromhex("3005300302010 2".replace(" ", ""))  # TimeStampResp { status: rejection }
    with pytest.raises(ApiError) as error:
        await service.finish(session, rejection)
    assert (error.value.status_code, error.value.code) == (400, "timestamp_mismatch")


async def test_garbage_is_not_a_token(service):
    session, *_ = await sign(service, False)
    with pytest.raises(ApiError) as error:
        await service.finish(session, b"\x30\x03\x02\x01\x01")
    assert error.value.code == "timestamp_mismatch"


def test_size_boundary_is_50_mib(client):
    limit = 50 * 1024 * 1024
    at_limit = client.post("/v1/pdf/sign/prepare", json={"pdfBase64": base64.b64encode(b"\0" * limit).decode()})
    assert (at_limit.status_code, at_limit.json()["code"]) == (400, "invalid_pdf")
    over = client.post("/v1/pdf/sign/prepare", json={"pdfBase64": base64.b64encode(b"\0" * (limit + 1)).decode()})
    assert over.status_code == 413
