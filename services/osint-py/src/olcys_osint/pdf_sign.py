"""PAdES signing of report PDFs with pyHanko, in two steps (interrupted signing).

``prepare`` adds an invisible certified signature field, reserves space for the CMS, signs the prepared document with
the local demo key and returns ``sha256(signature value)`` — the digest the Node worker has time-stamped (RFC 3161).
``finish`` receives the token (or none), embeds it as the signature time-stamp and completes the PDF (PAdES B-T, or
B-B without a token). This module never opens a network connection: the TSA is called by the Node side through its
egress client, and pyHanko is only given the finished token. Invisible signature only (an appearance stream with
unembedded fonts would break PDF/A).
"""

import hashlib
import io
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from asn1crypto import cms, tsp
from pyhanko.keys import load_certs_from_pemder_data, load_private_key_from_pemder_data
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers
from pyhanko.sign.signers.pdf_byterange import PreparedByteRangeDigest
from pyhanko.sign.signers.pdf_signer import PdfSignatureMetadata, PdfSigner, PdfTBSDocument, PostSignInstructions
from pyhanko.sign.timestamps import TimeStamper
from pyhanko_certvalidator.registry import SimpleCertificateStore

from .demo_signer import DemoSigner
from .runner import ApiError

SESSION_TTL_SECONDS = 600
MAX_SESSIONS = 8
MAX_PDF_BYTES = 50 * 1024 * 1024
BYTES_RESERVED = 32768
DIGEST = "sha256"
_DIGEST_NAMES = {"sha256": "2.16.840.1.101.3.4.2.1"}


class PrefetchedTimeStamper(TimeStamper):
    """Hands out a token obtained elsewhere (by the Node worker); it never contacts a TSA itself."""

    def __init__(self, token_der: bytes, expected_digest: bytes) -> None:
        super().__init__(include_nonce=False)
        self._info = cms.ContentInfo.load(token_der)
        self._expected = expected_digest

    def imprint(self) -> bytes:
        signed = self._info["content"]
        tst_info = signed["encap_content_info"]["content"].parsed
        if not isinstance(tst_info, tsp.TSTInfo):
            raise ValueError("not a time-stamp token")
        imprint = tst_info["message_imprint"]
        if imprint["hash_algorithm"]["algorithm"].dotted != _DIGEST_NAMES[DIGEST]:
            raise ValueError("unexpected imprint algorithm")
        return bytes(imprint["hashed_message"].native)

    async def async_timestamp(self, message_digest, md_algorithm):  # noqa: ARG002
        if md_algorithm != DIGEST or message_digest != self._expected or self.imprint() != self._expected:
            raise ApiError(400, "timestamp_mismatch", "the time-stamp token does not cover the signature digest")
        return self._info

    async def async_request_tsa_response(self, req):  # pragma: no cover - the service never asks a TSA
        raise RuntimeError("no network: the token is supplied by the caller")


@dataclass
class Session:
    created: float
    prepared: PreparedByteRangeDigest
    output: io.BytesIO
    post_sign: PostSignInstructions | None
    signed_attrs: cms.CMSAttributes
    signature: bytes
    field_name: str


class PdfSigningService:
    def __init__(self, signer: DemoSigner, clock=time.monotonic) -> None:
        cert = next(iter(load_certs_from_pemder_data(signer.cert_pem)))
        ca = next(iter(load_certs_from_pemder_data(signer.ca_pem)))
        key = load_private_key_from_pemder_data(signer.key_pem, passphrase=None)
        self._registry = SimpleCertificateStore.from_certs([cert, ca])
        self._signer = signers.SimpleSigner(
            signing_cert=cert, signing_key=key, cert_registry=self._registry, prefer_pss=False
        )
        self._cert = cert
        self._clock = clock
        self._sessions: dict[str, Session] = {}
        self.certificate_pem = signer.cert_pem.decode("ascii")
        self.ca_pem = signer.ca_pem.decode("ascii")
        self.cert_sha256 = hashlib.sha256(cert.dump()).hexdigest()

    def _purge(self) -> None:
        now = self._clock()
        for key in [k for k, s in self._sessions.items() if now - s.created > SESSION_TTL_SECONDS]:
            del self._sessions[key]

    async def prepare(self, pdf: bytes, field_name: str, reason: str) -> tuple[str, str]:
        self._purge()
        if len(self._sessions) >= MAX_SESSIONS:
            raise ApiError(429, "too_many_sessions", "too many signing sessions are open")
        try:
            writer = IncrementalPdfFileWriter(io.BytesIO(pdf))
        except Exception as error:  # a malformed PDF is the caller's problem, not a server fault
            raise ApiError(400, "invalid_pdf", f"the PDF cannot be read: {type(error).__name__}") from error
        meta = PdfSignatureMetadata(
            field_name=field_name,
            reason=reason,
            md_algorithm=DIGEST,
            subfilter=fields.SigSeedSubFilter.PADES,
            certify=True,
            docmdp_permissions=fields.MDPPerm.FILL_FORMS,
            embed_validation_info=False,
        )
        pdf_signer = PdfSigner(meta, signer=self._signer)
        prepared, tbs, output = await pdf_signer.async_digest_doc_for_signing(writer, bytes_reserved=BYTES_RESERVED)
        signed_attrs = await self._signer.signed_attrs(prepared.document_digest, DIGEST, use_pades=True)
        signature = await self._signer.async_sign_raw(signed_attrs.untag().dump(), DIGEST)
        session_id = secrets.token_hex(16)
        self._sessions[session_id] = Session(
            created=self._clock(),
            prepared=prepared,
            output=output,
            post_sign=tbs.post_sign_instructions,
            signed_attrs=signed_attrs,
            signature=signature,
            field_name=field_name,
        )
        return session_id, hashlib.sha256(signature).hexdigest()

    async def finish(self, session_id: str, token_der: bytes | None) -> tuple[bytes, str, str, bool]:
        self._purge()
        session = self._sessions.get(session_id)
        if session is None:
            raise ApiError(410, "session_expired", "unknown or expired signing session")
        stamper = None
        if token_der is not None:
            try:
                stamper = PrefetchedTimeStamper(token_der, hashlib.sha256(session.signature).digest())
                stamper.imprint()
            except ApiError:
                raise
            except Exception as error:
                raise ApiError(400, "timestamp_mismatch", "the time-stamp token cannot be read") from error
            if stamper.imprint() != hashlib.sha256(session.signature).digest():
                raise ApiError(400, "timestamp_mismatch", "the time-stamp token does not cover the signature digest")
        external = signers.ExternalSigner(
            signing_cert=self._cert,
            cert_registry=self._registry,
            signature_value=session.signature,
            signature_mechanism=self._signer.get_signature_mechanism_for_digest(DIGEST),
            prefer_pss=False,
        )
        cms_object = await external.async_sign_prescribed_attributes(DIGEST, session.signed_attrs, timestamper=stamper)
        await PdfTBSDocument.async_finish_signing(session.output, session.prepared, cms_object, post_sign_instr=None)
        del self._sessions[session_id]
        return session.output.getvalue(), self.cert_sha256, datetime.now(UTC).isoformat(), stamper is not None


__all__ = ["PdfSigningService", "PrefetchedTimeStamper", "MAX_PDF_BYTES"]
