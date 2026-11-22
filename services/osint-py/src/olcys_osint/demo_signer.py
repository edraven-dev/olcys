"""Demo signing identity: a throw-away CA and an RSA leaf certificate, clearly marked as non-qualified.

The private key is created on this machine on first use (or by ``scripts/make_demo_signer.py``) in a directory that is
never part of the repository (a compose volume, or ``${OLCYS_DATA_DIR}/signing`` on the host). It is never logged,
returned by the API or sent anywhere. A qualified certificate on an HSM (PKCS#11) is the production follow-up.
"""

import datetime as dt
import os
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

# X.509 limits a name attribute to 64 bytes, so the full wording "certyfikat demonstracyjny — niekwalifikowany" is split
# between the organisation and the common name.
DEMO_COMMON_NAME = "OŁCyŚ — certyfikat demo (niekwalifikowany)"
DEMO_CA_NAME = "OŁCyŚ — urząd certyfikacji demo (niekwalifikowany)"
DOCUMENT_SIGNING_OID = x509.ObjectIdentifier("1.3.6.1.5.5.7.3.36")
KEY_FILE, CERT_FILE, CA_FILE = "signing-key.pem", "signing-cert.pem", "signing-ca.pem"


@dataclass(frozen=True)
class DemoSigner:
    key_pem: bytes
    cert_pem: bytes
    ca_pem: bytes


def _name(common_name: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Certyfikat demonstracyjny, niekwalifikowany"),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ]
    )


def generate_demo_signer(bits: int = 3072, now: dt.datetime | None = None, days: int = 365) -> DemoSigner:
    """A fresh demo CA and leaf. ``bits`` below 3072 is for tests only."""
    start = (now or dt.datetime.now(dt.UTC)) - dt.timedelta(days=1)
    end = start + dt.timedelta(days=days)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=max(bits, 2048))
    ca_name = _name(DEMO_CA_NAME)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name(DEMO_COMMON_NAME))
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([DOCUMENT_SIGNING_OID]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    pem = serialization.Encoding.PEM
    return DemoSigner(
        key_pem=key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
        cert_pem=cert.public_bytes(pem),
        ca_pem=ca_cert.public_bytes(pem),
    )


def write_demo_signer(directory: Path, signer: DemoSigner) -> None:
    """Writes the three PEM files; the key file is readable by the owner only. Existing files are never overwritten."""
    directory.mkdir(parents=True, exist_ok=True)
    for name, data, mode in (
        (KEY_FILE, signer.key_pem, 0o600),
        (CERT_FILE, signer.cert_pem, 0o644),
        (CA_FILE, signer.ca_pem, 0o644),
    ):
        fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)


def load_or_create_demo_signer(directory: Path, bits: int = 3072) -> DemoSigner:
    """The signer stored in ``directory``; created on first use when the directory is writable."""
    files = [directory / KEY_FILE, directory / CERT_FILE, directory / CA_FILE]
    if not all(f.is_file() for f in files):
        if any(f.exists() for f in files):
            raise FileNotFoundError("the signing directory is incomplete (key, certificate and CA are all required)")
        write_demo_signer(directory, generate_demo_signer(bits))
    return DemoSigner(key_pem=files[0].read_bytes(), cert_pem=files[1].read_bytes(), ca_pem=files[2].read_bytes())
