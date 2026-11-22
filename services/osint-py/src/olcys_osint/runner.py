"""One username search: database pin, site selection, guarded Maigret run, status mapping, request log."""

import asyncio
import base64
import hashlib
import logging
import platform
import re
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import maigret_lib
from .guarded_checker import ACTIVE, GuardContext, Pacer, now_iso
from .ids import extract_profile
from .models import (
    SCHEMA_VERSION,
    DatabaseInfo,
    PolicyInfo,
    RequestRecord,
    ServiceInfo,
    SiteResult,
    UsernameSearchRequest,
    UsernameSearchResponse,
)
from .policy import hosts_of, select_sites
from .settings import SERVICE_VERSION, Settings
from .status import http_reason, map_status, verdict_fields

STATUSES = ("found", "not_found", "blocked", "login_wall", "captcha", "unknown", "illegal", "skipped")
BODY_STATUSES = frozenset({"found", "blocked", "login_wall", "captcha"})
# One search at a time: the pacing and the request budget are per search, and a target site must not see two at once.
_SEARCH_LOCK = asyncio.Lock()

# Maigret logs the probed URL (which contains the username); nothing of it may reach stdout.
_quiet = logging.getLogger("olcys_osint.maigret")
_quiet.addHandler(logging.NullHandler())
_quiet.propagate = False
_quiet.setLevel(logging.CRITICAL)


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code, self.code, self.message = status_code, code, message


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def database_path(request: UsernameSearchRequest, settings: Settings) -> tuple[str, Path]:
    """The pinned database file for the request, or an ``ApiError`` (nothing is downloaded or updated)."""
    if request.database == "fixture":
        return "fixture", settings.fixture_db_path
    if not settings.allow_external:
        raise ApiError(
            409, "external_disabled", "OLCYS_OSINT_ALLOW_EXTERNAL is not true: third-party sites are not contacted"
        )
    pinned = settings.policy["upstreamDatabase"]
    path = settings.upstream_db_path
    if path is None:
        lib = maigret_lib.load()
        path = Path(lib.maigret.__file__).parent / "resources" / "data.json"
    digest = sha256_file(path)
    if digest != pinned["sha256"]:
        raise ApiError(409, "db_hash_mismatch", f"site database does not match the pinned SHA-256 {pinned['sha256']}")
    return pinned["id"], path


def profile_url(site: Any, username: str) -> str:
    url = site.url.format(urlMain=site.url_main, urlSubpath=getattr(site, "url_subpath", ""), username=quote(username))
    return re.sub("(?<!:)/+", "/", url)


def _service_info(lib: Any) -> ServiceInfo:
    return ServiceInfo(
        version=SERVICE_VERSION,
        maigretVersion=str(lib.version),
        socidExtractorVersion=package_version("socid-extractor"),
        python=platform.python_version(),
    )


def _context(request: UsernameSearchRequest, settings: Settings, selected: dict[str, Any]) -> GuardContext:
    limits = settings.limits
    policy = settings.policy
    rps = settings.requests_per_second if settings.requests_per_second is not None else limits["requestsPerSecond"]
    interval = (
        settings.host_interval_seconds if settings.host_interval_seconds is not None else limits["hostIntervalSeconds"]
    )
    hosts = frozenset(host for site in selected.values() for host in hosts_of(site))
    fixture = request.database == "fixture"
    return GuardContext(
        user_agent=settings.user_agent,
        allowed_hosts=hosts,
        denied_suffixes=tuple(
            [*policy["deniedHostSuffixes"], *(s.strip().lower().lstrip("*.") for s in request.deniedHostSuffixes)]
        ),
        fixture_base_url=settings.fixture_base_url if fixture else None,
        fixture_prefixes=dict(policy["fixtureHostPrefixes"]),
        allow_external=settings.allow_external,
        max_redirects=limits["maxRedirects"],
        max_body_bytes=limits["maxBodyBytes"],
        max_response_bytes=limits["maxResponseBytes"],
        request_timeout=request.timeoutSeconds,
        pacer=Pacer(rps, interval),
        connections=limits["connections"],
    )


def _decode(body: bytes) -> str:
    return body.decode("utf-8", "ignore")


async def run_search(request: UsernameSearchRequest, settings: Settings) -> UsernameSearchResponse:
    db_id, db_path = database_path(request, settings)
    lib = maigret_lib.load()
    policy = settings.policy
    database = lib.MaigretDatabase().load_from_path(str(db_path))
    tags = list(request.tags or policy["tagsAllowed"])
    selected, excluded = select_sites(database.sites_dict, tags, policy, request.deniedHostSuffixes)

    async with _SEARCH_LOCK:
        started = now_iso()
        ctx = _context(request, settings, selected)
        token = ACTIVE.set(ctx)
        try:
            budget = 60 + len(selected) * max(1.0, float(settings.limits["hostIntervalSeconds"]))
            raw = await lib.search(
                username=request.username,
                site_dict=selected,
                logger=_quiet,
                query_notify=None,
                proxy=None,
                tor_proxy=None,
                i2p_proxy=None,
                timeout=request.timeoutSeconds * (ctx.max_redirects + 1) + budget,
                is_parsing_enabled=False,
                is_enrich_enabled=False,
                id_type="username",
                forced=False,
                max_connections=ctx.connections,
                no_progressbar=True,
                cookies=None,
                retries=0,
                check_domains=False,
                cloudflare_bypass=None,
                keywords=None,
                dns_resolver="threaded",
            )
        finally:
            await ctx.close()
            ACTIVE.reset(token)
        finished = now_iso()

    results: list[SiteResult] = []
    requests_by_id: dict[str, dict[str, Any]] = {}
    for name, site in selected.items():
        result = raw.get(name, {})
        verdict, error_type, error_desc = verdict_fields(result)
        status, reason = map_status(verdict, error_type, error_desc)
        checker = result.get("checker")
        records = list(getattr(checker, "records", []))
        final = next(
            (r for r in reversed(records) if r["httpStatus"] is not None and r["purpose"] != "robots.txt"), None
        )
        http_status = final["httpStatus"] if final else None
        reason = http_reason(status, reason, http_status)
        ids: dict[str, str] = {}
        links: list[str] = []
        if status == "found" and final and final["body"]:
            ids, links = extract_profile(_decode(final["body"]), final["logicalUrl"])
        for record in records:
            record["site"] = name
            requests_by_id[record["id"]] = {"record": record, "keep_body": status in BODY_STATUSES}
        results.append(
            SiteResult(
                site=name,
                platform=name.lower(),
                tags=list(site.tags or []),
                profileUrl=profile_url(site, request.username),
                status=status,  # type: ignore[arg-type]
                reason=reason,
                httpStatus=http_status,
                requestIds=[r["id"] for r in records],
                ids=ids,
                idsLinks=links,
            )
        )

    request_models: list[RequestRecord] = []
    for entry in sorted(
        (e for e in requests_by_id.values()), key=lambda e: (e["record"]["requestedAt"], e["record"]["id"])
    ):
        r = entry["record"]
        body = r["body"] if entry["keep_body"] else None
        request_models.append(
            RequestRecord(
                id=r["id"],
                method="GET",
                url=r["url"],
                logicalUrl=r["logicalUrl"],
                host=r["host"],
                site=r["site"],
                purpose=r["purpose"],
                containsIdentifier=r["containsIdentifier"],
                allowed=r["allowed"],
                denyReason=r["denyReason"],
                requestedAt=r["requestedAt"],
                receivedAt=r["receivedAt"],
                httpStatus=r["httpStatus"],
                responseHeaders=r["responseHeaders"],
                bodySha256=r["bodySha256"],
                bodyBase64=base64.b64encode(body).decode("ascii") if body else None,
                bodyTruncated=bool(r["bodyTruncated"]),
                userAgent=r["userAgent"],
                error=r["error"],
            )
        )

    summary = {status: sum(1 for r in results if r.status == status) for status in STATUSES}
    return UsernameSearchResponse(
        schemaVersion=SCHEMA_VERSION,
        service=_service_info(lib),
        username=request.username,
        database=DatabaseInfo(
            id=db_id,
            sha256=sha256_file(db_path),
            sitesTotal=len(database.sites_dict),
            sitesSelected=len(selected),
            excludedByPolicy=len(excluded),
        ),
        policy=PolicyInfo(
            version=policy["version"],
            allowExternal=settings.allow_external,
            tags=[t for t in tags if t in policy["tagsAllowed"]],
            userAgent=settings.user_agent,
        ),
        startedAt=started,
        finishedAt=finished,
        results=results,
        requests=request_models,
        summary=summary,
    )
