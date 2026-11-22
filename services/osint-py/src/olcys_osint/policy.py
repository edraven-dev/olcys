"""Site selection policy (``config/policy.json``): which sites of a Maigret database may be contacted at all."""

from typing import Any
from urllib.parse import urlsplit


def hosts_of(site: Any) -> set[str]:
    hosts: set[str] = set()
    for template in (getattr(site, "url", None), getattr(site, "url_probe", None), getattr(site, "url_main", None)):
        if not template:
            continue
        host = urlsplit(str(template).replace("{urlMain}", getattr(site, "url_main", "") or "")).hostname
        if host:
            hosts.add(host.lower())
    return hosts


def under_suffix(host: str, suffixes: list[str] | tuple[str, ...]) -> bool:
    return any(host == s or host.endswith("." + s) for s in suffixes)


def exclusion_reason(site: Any, tags: set[str], policy: dict[str, Any], denied_suffixes: list[str]) -> str | None:
    """Why ``site`` must not be contacted (None: it may). Checked in this order; the first reason wins."""
    site_tags = set(getattr(site, "tags", []) or [])
    if getattr(site, "name", "") in policy["excludedSites"]:
        return "excluded_site"
    if site_tags & set(policy["tagsDenied"]):
        return "denied_tag"
    if not site_tags & tags:
        return "tag_not_requested"
    if getattr(site, "disabled", False):
        return "disabled"
    if getattr(site, "protocol", "") not in ("", None):
        return f"protocol_{site.protocol}"
    if getattr(site, "type", "username") != "username":
        return "identifier_type"
    if getattr(site, "similar_search", False):
        return "similar_search"
    if getattr(site, "activation", None):
        return "activation"
    if getattr(site, "protection", None):
        return "protection"
    if getattr(site, "request_method", "") and str(site.request_method).upper() not in ("GET", "HEAD"):
        return "request_method"
    if getattr(site, "request_payload", None):
        return "request_payload"
    if not getattr(site, "url", None):
        return "no_url"
    suffixes = [*policy["deniedHostSuffixes"], *denied_suffixes]
    if any(under_suffix(host, suffixes) for host in hosts_of(site)):
        return "denied_host"
    return None


def select_sites(
    sites: dict[str, Any], tags: list[str], policy: dict[str, Any], denied_suffixes: list[str]
) -> tuple[dict[str, Any], dict[str, str]]:
    allowed = set(tags) & set(policy["tagsAllowed"])
    clean = [s.strip().lower().lstrip("*.") for s in denied_suffixes if s.strip()]
    selected: dict[str, Any] = {}
    excluded: dict[str, str] = {}
    for name, site in sorted(sites.items()):
        reason = exclusion_reason(site, allowed, policy, clean)
        if reason is None:
            selected[name] = site
        else:
            excluded[name] = reason
    return selected, excluded
