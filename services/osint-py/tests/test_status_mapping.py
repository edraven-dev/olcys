import pytest

from olcys_osint.status import http_reason, map_status


@pytest.mark.parametrize(
    ("verdict", "error_type", "error_desc", "expected"),
    [
        ("Claimed", None, None, ("found", None)),
        ("Available", None, None, ("not_found", None)),
        ("Illegal", "Unsupported username format", 'Want "^[a-z]+$"', ("illegal", 'Want "^[a-z]+$"')),
        ("Unknown", "Captcha", "Cloudflare", ("captcha", "Cloudflare")),
        ("Unknown", "Bot protection", "Cloudflare", ("blocked", "bot_protection")),
        ("Unknown", "Access denied", "403 status code", ("blocked", "access_denied")),
        ("Unknown", "Rate limited", "429 status code", ("blocked", "rate_limited")),
        ("Unknown", "Censorship", "x", ("blocked", "censorship")),
        ("Unknown", "Login required", "401 status code", ("login_wall", "401 status code")),
        ("Unknown", "Site-specific", "Zaloguj się", ("login_wall", "Zaloguj się")),
        ("Unknown", "Site-specific", "Site is disabled", ("unknown", "site_specific")),
        ("Unknown", "Request timeout", "", ("unknown", "timeout")),
        ("Unknown", "Connecting failure", "", ("unknown", "connection_failure")),
        ("Unknown", "Server", "503 status code", ("unknown", "server_error")),
        ("Unknown", "Guarded", "host x is not allow-listed", ("skipped", "host x is not allow-listed")),
        ("Unknown", None, None, ("unknown", "no_answer")),
    ],
)
def test_map_status(verdict, error_type, error_desc, expected):
    assert map_status(verdict, error_type, error_desc) == expected


def test_barrier_is_never_not_found():
    for kind in ("Captcha", "Bot protection", "Access denied", "Login required", "Rate limited"):
        assert map_status("Available", kind, "")[0] not in ("not_found", "found")


def test_429_is_rate_limited():
    assert http_reason("blocked", "access_denied", 429) == "rate_limited"
    assert http_reason("blocked", "access_denied", 403) == "access_denied"
