"""Maps Maigret's verdicts onto the service's statuses. A barrier or a failure is never "not found"."""

import re
from typing import Any

LOGIN_WORDING = re.compile(r"log ?in|sign ?in|zaloguj", re.IGNORECASE)
BLOCK_TYPES = {
    "bot protection": "bot_protection",
    "access denied": "access_denied",
    "censorship": "censorship",
    "request blocked": "request_blocked",
    "rate limited": "rate_limited",
}
UNKNOWN_TYPES = {
    "request timeout": "timeout",
    "connecting failure": "connection_failure",
    "connecting failure (dns)": "dns_failure",
    "server": "server_error",
    "redirect": "too_many_redirects",
    "request failed": "no_answer",
    "ssl": "tls_error",
    "body truncated": "body_truncated",
}


def map_status(verdict: str, error_type: str | None, error_desc: str | None) -> tuple[str, str | None]:
    """``verdict``: ``Claimed`` / ``Available`` / ``Unknown`` / ``Illegal`` (Maigret); returns (status, reason)."""
    desc = (error_desc or "").strip()
    kind = (error_type or "").strip().lower()
    if kind == "guarded":
        if desc == "robots_rate_limited":
            return "blocked", "rate_limited"
        return "skipped", desc or "denied"
    if kind == "captcha":
        return "captcha", desc or "captcha"
    if kind == "login required" or (kind == "site-specific" and LOGIN_WORDING.search(desc)):
        return "login_wall", desc or "login_required"
    if kind in BLOCK_TYPES:
        return "blocked", BLOCK_TYPES[kind]
    if kind.startswith("just a moment"):
        return "blocked", "bot_protection"
    if verdict == "Illegal":
        return "illegal", desc or kind or "unsupported_username"
    if kind:
        return "unknown", UNKNOWN_TYPES.get(kind, re.sub(r"\W+", "_", kind).strip("_"))
    if verdict == "Claimed":
        return "found", None
    if verdict == "Available":
        return "not_found", None
    return "unknown", "no_answer"


def http_reason(status: str, reason: str | None, http_status: int | None) -> str | None:
    """A 429 is always reported as rate limited."""
    if status == "blocked" and http_status == 429:
        return "rate_limited"
    return reason


def verdict_fields(result: dict[str, Any]) -> tuple[str, str | None, str | None]:
    status = result.get("status")
    error = getattr(status, "error", None)
    return (
        str(getattr(status, "status", "Unknown")),
        getattr(error, "type", None),
        getattr(error, "desc", None),
    )
