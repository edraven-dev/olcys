"""The offline demo: the persona's nickname over the fixture DB (a stand-in site, or the real fixture site)."""

import os

import pytest
from conftest import app_state

from olcys_osint.models import UsernameSearchRequest
from olcys_osint.runner import run_search
from olcys_osint.settings import Settings


def statuses(response):
    return {r.site: r.status for r in response.results}


async def search(base: str, username: str):
    settings = Settings(fixture_base_url=base, host_interval_seconds=0.0, requests_per_second=200.0)
    return await run_search(UsernameSearchRequest(username=username, database="fixture"), settings)


async def test_persona_nickname_hits_and_misses(fake_fixture_site):
    response = await search(fake_fixture_site, "fikcyjny_kacper")
    assert statuses(response) == {
        "Archiwum": "skipped",
        "GitHub": "not_found",
        "Keybase": "blocked",
        "Telegram": "not_found",
        "Wykop": "found",
    }
    archive = next(r for r in response.results if r.site == "Archiwum")
    assert archive.reason == "robots_disallowed"
    assert "/private/archiwum/fikcyjny_kacper" not in app_state["seen"]
    # X and the dating site are excluded by policy and never requested.
    assert response.database.excludedByPolicy == 2
    assert not any("x.com" in r.logicalUrl or "randki" in r.logicalUrl for r in response.requests)
    wykop = next(r for r in response.results if r.site == "Wykop")
    assert wykop.profileUrl == "https://wykop.pl/ludzie/fikcyjny_kacper"
    request = next(r for r in response.requests if r.site == "Wykop")
    assert request.logicalUrl == "https://wykop.pl/ludzie/fikcyjny_kacper"
    assert request.url == f"{fake_fixture_site}/wykop/ludzie/fikcyjny_kacper"
    assert request.bodyBase64
    assert response.policy.allowExternal is False


async def test_dash_variant_is_the_code_hosting_account(fake_fixture_site):
    response = await search(fake_fixture_site, "fikcyjny-kacper")
    assert statuses(response)["GitHub"] == "found"
    assert statuses(response)["Wykop"] == "not_found"


async def test_unmapped_fixture_host_is_skipped_not_contacted(fake_fixture_site):

    from olcys_osint.settings import load_policy

    policy = load_policy()
    policy["fixtureHostPrefixes"] = {k: v for k, v in policy["fixtureHostPrefixes"].items() if k != "t.me"}
    settings = Settings(
        fixture_base_url=fake_fixture_site, policy=policy, host_interval_seconds=0.0, requests_per_second=200.0
    )
    response = await run_search(UsernameSearchRequest(username="fikcyjny_kacper", database="fixture"), settings)
    assert statuses(response)["Telegram"] == "skipped"
    denied = [r for r in response.requests if not r.allowed and "fixture mapping" in (r.denyReason or "")]
    assert len(denied) == 1 and denied[0].denyReason == "no fixture mapping for host t.me"
    assert all("telegram" not in path for path in app_state["seen"])


@pytest.mark.skipif(not os.environ.get("OLCYS_E2E_FIXTURE_URL"), reason="needs the running fixture site")
async def test_real_fixture_site():
    base = os.environ["OLCYS_E2E_FIXTURE_URL"]
    response = await search(base, "fikcyjny_kacper")
    assert statuses(response) == {
        "Archiwum": "skipped",
        "GitHub": "not_found",
        "Keybase": "blocked",
        "Telegram": "not_found",
        "Wykop": "found",
    }
    response = await search(base, "fikcyjny-kacper")
    assert statuses(response)["GitHub"] == "found"
