"""The only network path of the service: a guarded HTTP checker injected where Maigret builds its own.

Every request is allow-listed (the fixture site, or the hosts of the selected sites when external access is enabled),
paced (global and per host), logged with ``containsIdentifier: true`` and sent with an honest User-Agent, without
proxy, cookies or environment settings. Redirects are followed manually (at most ``maxRedirects``) and each hop is
checked and logged again. Nothing is retried. HEAD requests are sent as GET.
"""

import asyncio
import contextvars
import hashlib
import ipaddress
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import aiohttp

KEPT_HEADERS = (
    "content-type",
    "content-length",
    "location",
    "retry-after",
    "date",
    "cf-mitigated",
    "x-olcys-synthetic",
)
PURPOSE = "username enumeration"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def CheckError(type_: str, desc: str = ""):  # noqa: N802 - mirrors the class it builds
    """Maigret's ``CheckError`` (imported late: importing Maigret needs the placeholder modules of ``maigret_lib``)."""
    from maigret.errors import CheckError as MaigretCheckError

    return MaigretCheckError(type_, desc)


class Denied(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Pacer:
    """Global request rate and a minimum interval per host; slots are handed out in arrival order."""

    def __init__(self, requests_per_second: float, host_interval_seconds: float) -> None:
        self._interval = 1.0 / requests_per_second if requests_per_second > 0 else 0.0
        self._host_interval = host_interval_seconds
        self._next_global = 0.0
        self._next_host: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def wait(self, host: str) -> None:
        async with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_global, self._next_host.get(host, 0.0))
            self._next_global = slot + self._interval
            self._next_host[host] = slot + self._host_interval
        if slot > now:
            await asyncio.sleep(slot - now)


@dataclass
class GuardContext:
    """Everything one search needs; installed in ``ACTIVE`` for the duration of the search."""

    user_agent: str
    allowed_hosts: frozenset[str]
    denied_suffixes: tuple[str, ...]
    fixture_base_url: str | None  # set: fixture mode; every live URL is mapped onto the fixture site
    fixture_prefixes: dict[str, str]
    allow_external: bool
    max_redirects: int
    max_body_bytes: int
    max_response_bytes: int
    request_timeout: float
    pacer: Pacer
    connections: int = 4
    received_bytes: int = 0
    log: list[dict[str, Any]] = field(default_factory=list)
    # Per origin: a parser (2xx), or a denial reason (robots.txt unavailable or rate limited). Fetched once per search.
    robots: dict[str, RobotFileParser | str] = field(default_factory=dict)
    robots_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    _session: aiohttp.ClientSession | None = None

    def session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(limit=self.connections, resolver=aiohttp.ThreadedResolver()),
                cookie_jar=aiohttp.DummyCookieJar(),
                trust_env=False,  # no proxy settings from the environment
                auto_decompress=True,
            )
        return self._session

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    # --- URL mapping and allow-list -------------------------------------------------------------------------
    def _fixture_origin(self) -> tuple[str, str]:
        base = urlsplit(self.fixture_base_url or "")
        return base.scheme, base.netloc

    def to_fixture(self, logical: str) -> str:
        """Live URL -> fixture URL (fixture mode). Raises ``Denied`` for a host without a fixture mapping."""
        parts = urlsplit(logical)
        scheme, netloc = self._fixture_origin()
        if (parts.scheme, parts.netloc) == (scheme, netloc):
            return logical
        host = (parts.hostname or "").lower()
        prefix = self.fixture_prefixes.get(host)
        if prefix is None:
            raise Denied(f"no fixture mapping for host {host}")
        base_path = urlsplit(self.fixture_base_url or "").path.rstrip("/")
        return urlunsplit((scheme, netloc, f"{base_path}{prefix}{parts.path}", parts.query, ""))

    def to_logical(self, url: str) -> str:
        """Fixture URL -> the live URL it stands for (unchanged when it is not a mapped fixture URL)."""
        parts = urlsplit(url)
        scheme, netloc = self._fixture_origin()
        if not self.fixture_base_url or (parts.scheme, parts.netloc) != (scheme, netloc):
            return url
        path = parts.path[len(urlsplit(self.fixture_base_url).path.rstrip("/")) :] or "/"
        for host, prefix in sorted(self.fixture_prefixes.items(), key=lambda item: -len(item[1])):
            if path == prefix or path.startswith(prefix + "/"):
                return urlunsplit(("https", host, path[len(prefix) :] or "/", parts.query, ""))
        return url

    def check_host(self, url: str) -> None:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise Denied("unsupported URL")
        host = parts.hostname.lower()
        if self.fixture_base_url:
            if (parts.scheme, parts.netloc) != self._fixture_origin():
                raise Denied(f"host {host} is not the fixture site")
            return
        if not self.allow_external:
            raise Denied("external access is disabled")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise Denied("IP literals are not contacted")
        if any(host == s or host.endswith("." + s) for s in self.denied_suffixes):
            raise Denied(f"host {host} is denied")
        if host not in self.allowed_hosts:
            raise Denied(f"host {host} is not allow-listed")


ACTIVE: contextvars.ContextVar[GuardContext | None] = contextvars.ContextVar("olcys_guard", default=None)


class GuardedChecker:
    """Drop-in for Maigret's ``SimpleAiohttpChecker`` (``prepare`` / ``check`` / ``close``)."""

    def __init__(self, *_args: Any, **kwargs: Any) -> None:
        if kwargs.get("proxy") or kwargs.get("cookie_jar"):
            raise RuntimeError("proxies and cookies are not supported")
        self.logger = kwargs.get("logger")
        self.url: str | None = None
        self.headers: dict[str, str] | None = None
        self.allow_redirects = True
        self.timeout = 0
        self.method = "get"
        self.payload = None
        self.encoding: str | None = None
        self.records: list[dict[str, Any]] = []

    def prepare(
        self, url, headers=None, allow_redirects=True, timeout=0, method="get", payload=None, encoding=None
    ) -> None:
        self.url, self.headers, self.allow_redirects = url, headers, allow_redirects
        self.timeout, self.method, self.payload, self.encoding = timeout, method, payload, encoding

    async def close(self) -> None:
        return None

    def _record(
        self, ctx: GuardContext, logical: str, actual: str, purpose: str = PURPOSE, identifier: bool = True
    ) -> dict[str, Any]:
        record = {
            "id": str(uuid.uuid7()),
            "method": "GET",
            "url": actual,
            "logicalUrl": logical,
            "host": (urlsplit(actual).hostname or "").lower(),
            "purpose": purpose,
            "containsIdentifier": identifier,
            "allowed": True,
            "denyReason": None,
            "requestedAt": now_iso(),
            "receivedAt": None,
            "httpStatus": None,
            "responseHeaders": {},
            "bodySha256": None,
            "body": None,
            "bodyTruncated": False,
            "error": None,
            "userAgent": ctx.user_agent,
        }
        self.records.append(record)
        ctx.log.append(record)
        return record

    async def check(self) -> tuple[str | None, int, CheckError | None]:
        ctx = ACTIVE.get()
        if ctx is None:
            raise RuntimeError("GuardedChecker used outside a guarded search")
        assert self.url is not None
        headers = {k: v for k, v in (self.headers or {}).items() if k.lower() not in ("user-agent", "connection")}
        headers["User-Agent"] = ctx.user_agent
        logical = self.url
        for _hop in range(ctx.max_redirects + 1):
            try:
                actual = ctx.to_fixture(logical) if ctx.fixture_base_url else logical
            except Denied as denial:
                return self._denied(ctx, logical, logical, denial.reason)
            try:
                ctx.check_host(actual)
                if ctx.received_bytes >= ctx.max_response_bytes:
                    raise Denied("response size budget exhausted")
            except Denied as denial:
                return self._denied(ctx, logical, actual, denial.reason)
            try:
                await self._check_robots(ctx, actual, headers)
            except Denied as denial:
                return self._denied(ctx, logical, actual, denial.reason)
            record = self._record(ctx, logical, actual)
            await ctx.pacer.wait(record["host"])
            try:
                timeout = aiohttp.ClientTimeout(total=ctx.request_timeout)
                async with ctx.session().get(
                    actual, headers=headers, allow_redirects=False, timeout=timeout
                ) as response:
                    body, truncated = await self._read(ctx, response)
                    record["receivedAt"] = now_iso()
                    record["httpStatus"] = response.status
                    record["responseHeaders"] = {
                        name: response.headers[name] for name in KEPT_HEADERS if name in response.headers
                    }
                    record["bodySha256"] = hashlib.sha256(body).hexdigest()
                    record["body"], record["bodyTruncated"] = body, truncated
                    location = response.headers.get("location")
                    status = response.status
                    charset = self.encoding or response.charset or "utf-8"
            except TimeoutError as error:
                record["error"] = "timeout"
                return None, 0, CheckError("Request timeout", str(error))
            except aiohttp.ClientConnectorError as error:
                record["error"] = "connection failure"
                return None, 0, CheckError("Connecting failure", str(error))
            except aiohttp.ClientError as error:
                record["error"] = type(error).__name__
                return None, 0, CheckError("Connecting failure", str(error))
            if self.allow_redirects and 300 <= status < 400 and location:
                logical = ctx.to_logical(urljoin(actual, location))
                continue
            if record["bodyTruncated"]:
                # A page cut at the size limit must not be judged: found or not found on a prefix is a guess.
                return None, 0, CheckError("Body truncated", "size limit reached")
            return body.decode(charset, "ignore"), status, None
        return None, 0, CheckError("Redirect", f"more than {ctx.max_redirects} redirects")

    async def _check_robots(self, ctx: GuardContext, actual: str, headers: dict[str, str]) -> None:
        """RFC 9309: robots.txt of the origin, once per search, through the same guarded and logged path.

        2xx: rules apply; 4xx: no restrictions, except 429 (a rate limit: the host is off for this search);
        5xx, redirect or unreachable: the host is off for this search.
        """
        parts = urlsplit(actual)
        origin = f"{parts.scheme}://{parts.netloc}"
        lock = ctx.robots_locks.setdefault(origin, asyncio.Lock())
        async with lock:
            if origin not in ctx.robots:
                ctx.robots[origin] = await self._fetch_robots(ctx, origin, headers)
        rules = ctx.robots[origin]
        if isinstance(rules, str):
            raise Denied(rules)
        if not rules.can_fetch(ctx.user_agent, actual):
            raise Denied("robots_disallowed")

    async def _fetch_robots(self, ctx: GuardContext, origin: str, headers: dict[str, str]) -> RobotFileParser | str:
        url = f"{origin}/robots.txt"
        record = self._record(ctx, ctx.to_logical(url), url, "robots.txt", False)
        await ctx.pacer.wait(record["host"])
        try:
            timeout = aiohttp.ClientTimeout(total=ctx.request_timeout)
            async with ctx.session().get(url, headers=headers, allow_redirects=False, timeout=timeout) as response:
                body, truncated = await self._read(ctx, response)
                record["receivedAt"] = now_iso()
                record["httpStatus"] = response.status
                record["bodySha256"] = hashlib.sha256(body).hexdigest()
                record["bodyTruncated"] = truncated
                status = response.status
        except (TimeoutError, aiohttp.ClientError) as error:
            record["error"] = type(error).__name__
            return "robots_unavailable"
        if status == 429:
            return "robots_rate_limited"
        parser = RobotFileParser()
        if 200 <= status < 300:
            parser.parse(body.decode("utf-8", "ignore").splitlines())
            parser.modified()
            return parser
        if 400 <= status < 500:
            parser.allow_all = True
            return parser
        return "robots_unavailable"

    def _denied(self, ctx: GuardContext, logical: str, actual: str, reason: str):
        record = self._record(ctx, logical, actual)
        record["allowed"], record["denyReason"] = False, reason
        return None, 0, CheckError("Guarded", reason)

    @staticmethod
    async def _read(ctx: GuardContext, response: aiohttp.ClientResponse) -> tuple[bytes, bool]:
        chunks: list[bytes] = []
        size = 0
        truncated = False
        # The total kept in one search is capped so that the base64-encoded answer stays under the receiver's limit.
        limit = min(ctx.max_body_bytes, max(ctx.max_response_bytes - ctx.received_bytes, 0))
        async for chunk in response.content.iter_chunked(65536):
            room = limit - size
            if len(chunk) > room:
                chunks.append(chunk[: max(room, 0)])
                truncated = True
                break
            chunks.append(chunk)
            size += len(chunk)
        body = b"".join(chunks)
        ctx.received_bytes += len(body)
        return body, truncated
