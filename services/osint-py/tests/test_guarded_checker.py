"""Statuses, redirects and request log against a loopback site (no real network)."""

from olcys_osint.models import UsernameSearchRequest
from olcys_osint.runner import run_search


def search(username: str = "someone", **extra: object) -> UsernameSearchRequest:
    return UsernameSearchRequest(username=username, database="upstream", timeoutSeconds=1, **extra)  # type: ignore[arg-type]


def by_site(response):
    return {r.site: r for r in response.results}


async def test_statuses_for_each_kind_of_answer(loopback, make_settings):
    sites = {
        "Found": loopback.site("ok"),
        "Missing": loopback.site("missing"),
        "Forbidden": loopback.site("forbidden"),
        "Limited": loopback.site("limited"),
        "Captcha": loopback.site("captcha", "message", absenceStrs=["never-present"]),
        "Wall": loopback.site(
            "login", "message", absenceStrs=["never-present"], errors={"Zaloguj się": "Login required"}
        ),
        "Slow": loopback.site("slow"),
    }
    response = await run_search(search(), make_settings(sites))
    results = by_site(response)
    assert {k: v.status for k, v in results.items()} == {
        "Found": "found",
        "Missing": "not_found",
        "Forbidden": "blocked",
        "Limited": "blocked",
        "Captcha": "captcha",
        "Wall": "login_wall",
        "Slow": "unknown",
    }
    assert results["Limited"].reason == "rate_limited"
    assert results["Limited"].httpStatus == 429
    assert results["Slow"].reason == "timeout"
    # A rate limit is answered once and never retried.
    assert loopback.hits["limited"] == 1
    assert loopback.hits["forbidden"] == 1
    assert response.summary["found"] == 1 and response.summary["blocked"] == 2


async def test_request_log_and_honest_user_agent(loopback, make_settings):
    settings = make_settings({"Found": loopback.site("ok"), "Missing": loopback.site("missing")})
    response = await run_search(search("olcys_test"), settings)
    pages = [r for r in response.requests if r.purpose != "robots.txt"]
    assert len(pages) == 2
    for record in pages:
        assert record.method == "GET"
        assert record.containsIdentifier is True
        assert record.allowed is True
        assert record.userAgent == settings.user_agent
        assert record.host == "localhost"
        assert record.requestedAt.endswith("Z")
    assert set(loopback.user_agents) == {settings.user_agent}
    assert all("proxy" not in {k.lower() for k in headers} for headers in loopback.headers)
    found = next(r for r in pages if r.site == "Found")
    missing = next(r for r in pages if r.site == "Missing")
    assert found.bodyBase64 and found.bodySha256
    assert missing.bodyBase64 is None and missing.bodySha256  # bodies only for found/barrier sites, hash always
    assert found.id in by_site(response)["Found"].requestIds


async def test_redirect_hops_are_logged_and_checked(loopback, make_settings):
    sites = {"Hop": loopback.site("hop"), "Escape": loopback.site("escape"), "Loop": loopback.site("loop")}
    response = await run_search(search(), make_settings(sites))
    results = by_site(response)
    assert results["Hop"].status == "found"
    assert len([r for r in response.requests if r.site == "Hop" and r.purpose != "robots.txt"]) == 2
    assert results["Escape"].status == "skipped"
    denied = [r for r in response.requests if not r.allowed]
    assert len(denied) == 1 and denied[0].host == "elsewhere.invalid"
    assert denied[0].denyReason and "not allow-listed" in denied[0].denyReason
    assert results["Loop"].status == "unknown" and results["Loop"].reason == "too_many_redirects"
    assert loopback.hits["loop"] == 6  # the first request plus five hops, then stop


async def test_truncated_page_is_unknown_not_a_verdict(loopback, make_settings):
    settings = make_settings({"Big": loopback.site("big"), "Small": loopback.site("ok")})
    settings.policy["limits"]["maxBodyBytes"] = 1000
    response = await run_search(search(), settings)
    results = by_site(response)
    assert results["Big"].status == "unknown" and results["Big"].reason == "body_truncated"
    # The prefix is not kept as evidence either.
    big = next(r for r in response.requests if r.site == "Big" and r.purpose != "robots.txt")
    assert big.bodyBase64 is None and big.bodyTruncated is True


async def test_total_size_budget_truncates_pages_but_keeps_the_log(loopback, make_settings):
    names = ["A", "B", "C", "D"]
    settings = make_settings({n: loopback.site("ok") | {"url": f"{loopback.base}/ok/{{username}}x{n}"} for n in names})
    settings.policy["limits"]["maxResponseBytes"] = 70
    response = await run_search(search(), settings)
    assert len(response.results) == 4  # no result is dropped
    truncated = [r for r in response.results if r.reason == "body_truncated"]
    assert truncated and all(r.status == "unknown" for r in truncated)
    assert sum(len(__import__("base64").b64decode(r.bodyBase64 or "")) for r in response.requests) <= 70
    assert len(response.requests) >= 4  # the request log stays complete
