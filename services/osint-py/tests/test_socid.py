"""socid-extractor on captured pages: no network, no AI fallback."""

import json

from olcys_osint.ids import _links, extract_profile

GITHUB_API_BODY = json.dumps(
    {
        "login": "olcys-test",
        "id": 424242,
        "gists_url": "https://api.example.org/gists{/gist_id}",
        "received_events_url": "https://api.example.org/events",
        "blog": "https://example.org/olcys-test",
        "name": "Kacper Fikcyjny (test)",
        "followers": 3,
    }
)


def test_scheme_flags_yield_ids_and_links():
    ids, links = extract_profile(GITHUB_API_BODY, "https://api.github.com/users/olcys-test")
    assert ids["uid"] == "424242"
    assert ids["fullname"] == "Kacper Fikcyjny (test)"
    assert ids["_extractor"] == "GitHub API"
    assert links == ["https://example.org/olcys-test"]


def test_unknown_page_yields_nothing():
    assert extract_profile("<html><body>nic ciekawego</body></html>") == ({}, [])


def test_links_are_parsed_never_evaluated():
    assert _links('["https://a.example/x", "https://b.example/y"]') == ["https://a.example/x", "https://b.example/y"]
    assert _links("['https://a.example/x']") == ["https://a.example/x"]
    assert _links("__import__('os').system('echo pwned')") == []
    assert _links(None) == []


def test_ai_fallback_is_never_used(monkeypatch):
    import socid_extractor.ai_fallback as ai

    def boom(*_args, **_kwargs):
        raise AssertionError("AI fallback must not run")

    monkeypatch.setattr(ai, "extract_with_ai", boom)
    assert extract_profile("<html>nothing to see</html>") == ({}, [])
