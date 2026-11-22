"""robots.txt (RFC 9309): once per host and search, through the guarded path; as the Node RobotsCache."""

import pytest

from olcys_osint.models import UsernameSearchRequest
from olcys_osint.runner import run_search

REQUEST = UsernameSearchRequest(username="someone", database="upstream", timeoutSeconds=1)


def sites(loopback):
    return {"Found": loopback.site("ok"), "Second": loopback.site("hop")}


async def test_disallowed_path_is_skipped_and_never_requested(loopback, make_settings):
    loopback.robots_status, loopback.robots_text = 200, "User-agent: *\nDisallow: /ok/\n"
    response = await run_search(
        REQUEST, make_settings({"Found": loopback.site("ok"), "Other": loopback.site("missing")})
    )
    results = {r.site: r for r in response.results}
    assert results["Found"].status == "skipped" and results["Found"].reason == "robots_disallowed"
    assert results["Other"].status == "not_found"
    assert loopback.hits["ok"] == 0
    # One robots.txt fetch for the host, logged without an identifier, with the honest User-Agent.
    assert loopback.hits["robots"] == 1
    robots = [r for r in response.requests if r.purpose == "robots.txt"]
    assert len(robots) == 1 and robots[0].containsIdentifier is False
    assert robots[0].url.endswith("/robots.txt") and robots[0].httpStatus == 200
    assert results["Found"].httpStatus is None


async def test_rules_for_our_user_agent_apply(loopback, make_settings):
    loopback.robots_status = 200
    loopback.robots_text = "User-agent: OLCYS\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    response = await run_search(REQUEST, make_settings({"Found": loopback.site("ok")}))
    assert response.results[0].status == "skipped"


@pytest.mark.parametrize("status", [404, 403, 410])
async def test_4xx_means_no_restrictions(loopback, make_settings, status):
    loopback.robots_status, loopback.robots_text = status, "User-agent: *\nDisallow: /\n"
    response = await run_search(REQUEST, make_settings(sites(loopback)))
    assert {r.status for r in response.results} == {"found"}
    assert loopback.hits["robots"] == 1


async def test_429_is_a_rate_limit_for_the_host(loopback, make_settings):
    loopback.robots_status = 429
    response = await run_search(REQUEST, make_settings(sites(loopback)))
    assert {(r.status, r.reason) for r in response.results} == {("blocked", "rate_limited")}
    assert loopback.hits["ok"] == 0 and loopback.hits["robots"] == 1


@pytest.mark.parametrize("status", [500, 503])
async def test_5xx_disallows_the_host_for_this_search(loopback, make_settings, status):
    loopback.robots_status = status
    response = await run_search(REQUEST, make_settings(sites(loopback)))
    assert {(r.status, r.reason) for r in response.results} == {("skipped", "robots_unavailable")}
    assert loopback.hits["ok"] == 0 and loopback.hits["robots"] == 1


async def test_unreachable_robots_disallows_the_host(loopback, make_settings):
    loopback.robots_status = 200
    settings = make_settings(
        {"Down": {**loopback.site("ok"), "url": "http://localhost:1/{username}", "urlMain": "http://localhost:1/"}}
    )
    response = await run_search(REQUEST, settings)
    assert response.results[0].status == "skipped" and response.results[0].reason == "robots_unavailable"
