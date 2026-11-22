"""Policy: excluded sites are never contacted and are counted."""

import pytest

from olcys_osint.models import UsernameSearchRequest
from olcys_osint.runner import run_search

EXCLUDED = {
    "X": {},
    "Reddit": {"url": "https://www.reddit.com/user/{username}", "urlMain": "https://www.reddit.com/"},
    "Dating": {"tags": ["dating", "social"]},
    "Activated": {
        "activation": {"method": "twitter", "marks": ["x"], "url": "https://x.example/t", "src": "a", "dst": "b"}
    },
    "Tor": {"protocol": "tor"},
    "Disabled": {"disabled": True},
    "Protected": {"protection": ["tls_fingerprint"]},
    "Similar": {"similarSearch": True},
    "Posting": {"requestMethod": "POST", "requestPayload": {"u": "{username}"}},
    "Denied": {"url": "https://profiles.denied.example/{username}", "urlMain": "https://profiles.denied.example/"},
    "OtherTag": {"tags": ["forum"]},
}


@pytest.mark.parametrize("deny", [["denied.example"]])
async def test_excluded_sites_are_not_contacted(loopback, make_settings, deny):
    sites = {"Allowed": loopback.site("ok")}
    for name, patch in EXCLUDED.items():
        site = loopback.site(f"never-{name.lower()}")
        site.update(patch)
        sites[name] = site
    response = await run_search(
        UsernameSearchRequest(username="someone", database="upstream", timeoutSeconds=1, deniedHostSuffixes=deny),
        make_settings(sites),
    )
    assert [r.site for r in response.results] == ["Allowed"]
    assert response.database.sitesTotal == len(sites)
    assert response.database.sitesSelected == 1
    assert response.database.excludedByPolicy == len(EXCLUDED)
    assert sum(v for k, v in loopback.hits.items() if k.startswith("never")) == 0
    assert loopback.hits["ok"] == 1


async def test_tag_allow_list(loopback, make_settings):
    sites = {"Coding": loopback.site("ok", tags=["coding"]), "Social": loopback.site("missing")}
    request = UsernameSearchRequest(username="someone", database="upstream", timeoutSeconds=1, tags=["coding"])
    response = await run_search(request, make_settings(sites))
    assert [r.site for r in response.results] == ["Coding"]
    assert response.policy.tags == ["coding"]
