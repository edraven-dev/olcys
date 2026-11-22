"""socid-extractor on an already captured page: no network, never ``eval``, never the AI fallback."""

import ast
import json
from typing import Any

from socid_extractor import extract


def _links(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(item) for item in raw]
    if not isinstance(raw, str) or not raw.strip():
        return []
    for parse in (json.loads, ast.literal_eval):
        try:
            value = parse(raw)
        except ValueError, SyntaxError, MemoryError, RecursionError:
            continue
        if isinstance(value, (list, tuple)):
            return [str(item) for item in value if isinstance(item, str)]
        if isinstance(value, str):
            return [value]
    return []


LINK_KEYS = frozenset({"links", "blog_url", "website", "homepage", "url", "profile_url"})


def _is_http(value: str) -> bool:
    return value.startswith(("http://", "https://"))


def extract_profile(html: str, url: str | None = None) -> tuple[dict[str, str], list[str]]:
    """Returns (ids, idsLinks): fields as strings; ``links`` is parsed and URL-valued link fields are added."""
    try:
        data = extract(html, use_ai_fallback=False, request_url=url)
    except ValueError, KeyError, TypeError, AttributeError, IndexError:
        # Scraped markup is untrusted: a scheme that does not fit the page yields nothing, anything else is a bug.
        return {}, []
    links = _links(data.pop("links", None))
    for key, value in data.items():
        if key in LINK_KEYS and isinstance(value, str) and _is_http(value) and value not in links:
            links.append(value)
    return {key: str(value) for key, value in data.items() if not key.startswith("_") or key == "_extractor"}, links
