"""HTTP contract: errors (409, 422), health and profile extraction."""

import pytest
from fastapi.testclient import TestClient

from olcys_osint import main
from olcys_osint.settings import Settings, load_policy

BODY = {"username": "olcys_test", "database": "upstream"}


@pytest.fixture
def client():
    return TestClient(main.app)


def test_healthz(client):
    assert client.get("/healthz").json()["status"] == "ok"


def test_upstream_needs_external_access(client, monkeypatch):
    monkeypatch.setattr(main, "SETTINGS", Settings(allow_external=False))
    response = client.post("/v1/usernames/search", json=BODY)
    assert response.status_code == 409
    assert response.json()["code"] == "external_disabled"


def test_modified_upstream_database_is_refused(client, monkeypatch, tmp_path):
    db = tmp_path / "data.json"
    db.write_text('{"sites": {}, "engines": {}, "tags": []}')
    monkeypatch.setattr(main, "SETTINGS", Settings(allow_external=True, upstream_db_path=db))
    response = client.post("/v1/usernames/search", json=BODY)
    assert response.status_code == 409
    assert response.json()["code"] == "db_hash_mismatch"


def test_the_wheels_database_matches_the_pin(monkeypatch):
    from olcys_osint import maigret_lib
    from olcys_osint.models import UsernameSearchRequest
    from olcys_osint.runner import database_path

    lib = maigret_lib.load()
    assert lib.version == "0.6.6"
    request = UsernameSearchRequest(username="olcys_test", database="upstream")
    database_id, path = database_path(request, Settings(allow_external=True))
    assert database_id == load_policy()["upstreamDatabase"]["id"]
    assert path.name == "data.json"


@pytest.mark.parametrize(
    "body",
    [
        {"username": "has space", "database": "fixture"},
        {"username": "a/b", "database": "fixture"},
        {"username": "x" * 65, "database": "fixture"},
        {"username": "ok", "database": "live"},
        {"username": "ok", "database": "fixture", "tags": ["dating"]},
        {"username": "ok", "database": "fixture", "timeoutSeconds": 31},
        {"username": "ok", "database": "fixture", "proxy": "socks5://127.0.0.1:9050"},
        {"database": "fixture"},
    ],
)
def test_invalid_requests_are_422(client, body):
    response = client.post("/v1/usernames/search", json=body)
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"


def test_profiles_extract_without_network(client):
    page = (
        '{"login":"olcys-test","id":424242,"gists_url":"u","received_events_url":"u",'
        '"blog":"https://example.org/olcys-test","name":"Kacper Fikcyjny (test)"}'
    )
    response = client.post(
        "/v1/profiles/extract", json={"html": page, "url": "https://api.github.com/users/olcys-test"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["ids"]["uid"] == "424242"
    assert data["idsLinks"] == ["https://example.org/olcys-test"]
