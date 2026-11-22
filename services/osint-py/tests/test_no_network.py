"""Importing and searching the fixture DB touches only loopback; the service code has no other network client."""

import re
from pathlib import Path

import pytest
import pytest_socket

from olcys_osint.models import UsernameSearchRequest
from olcys_osint.runner import run_search
from olcys_osint.settings import Settings

SRC = Path(__file__).resolve().parents[1] / "src" / "olcys_osint"
CLIENTS = re.compile(
    r"^\s*(import|from)\s+(requests|httpx|urllib\.request|urllib3|http\.client|socket|websockets)\b", re.M
)


def test_no_other_network_client_in_service_code():
    offenders = [p.name for p in SRC.glob("*.py") if CLIENTS.search(p.read_text(encoding="utf-8"))]
    assert offenders == []


def test_only_the_guarded_checker_opens_sessions():
    users = [p.name for p in SRC.glob("*.py") if "ClientSession(" in p.read_text(encoding="utf-8")]
    assert users == ["guarded_checker.py"]


def test_external_connections_are_blocked_in_tests():
    import socket

    with pytest.raises(pytest_socket.SocketConnectBlockedError):
        socket.create_connection(("192.0.2.1", 80), timeout=1)


async def test_fixture_search_needs_only_loopback(fake_fixture_site):
    settings = Settings(fixture_base_url=fake_fixture_site, host_interval_seconds=0.0, requests_per_second=200.0)
    response = await run_search(UsernameSearchRequest(username="fikcyjny_kacper", database="fixture"), settings)
    assert response.results
