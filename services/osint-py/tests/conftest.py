"""Test fixtures: a loopback site that answers like the barriers a real site shows, and Maigret test databases."""

import asyncio
import copy
import hashlib
import json
from collections import Counter
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path

import pytest
import pytest_asyncio
from aiohttp import web

from olcys_osint.settings import Settings, load_policy

CAPTCHA_PAGE = "<html><head><title>Attention Required! | Cloudflare</title></head><body>captcha</body></html>"
LOGIN_PAGE = "<html><body><h1>Zaloguj się, aby zobaczyć profil</h1></body></html>"
PROFILE_PAGE = "<html><body><h1>profil {user}</h1></body></html>"


class Loopback:
    def __init__(self, port: int) -> None:
        self.port = port
        self.hits: Counter[str] = Counter()
        self.user_agents: list[str] = []
        self.headers: list[dict[str, str]] = []
        self.robots_text = ""
        self.robots_status = 404

    @property
    def base(self) -> str:
        return f"http://localhost:{self.port}"

    def site(self, tag: str, check: str = "status_code", **extra: object) -> dict[str, object]:
        entry: dict[str, object] = {
            "tags": ["social"],
            "checkType": check,
            "urlMain": f"{self.base}/",
            "url": f"{self.base}/{tag}/{{username}}",
            "usernameClaimed": "claimed",
            "usernameUnclaimed": "unclaimed",
        }
        entry.update(extra)
        return entry


@pytest_asyncio.fixture
async def loopback() -> AsyncIterator[Loopback]:
    state: Loopback

    async def robots(_request: web.Request) -> web.StreamResponse:
        state.hits["robots"] += 1
        return web.Response(text=state.robots_text, status=state.robots_status, content_type="text/plain")

    async def handler(request: web.Request) -> web.StreamResponse:
        kind = request.match_info["kind"]
        user = request.match_info["user"]
        state.hits[kind] += 1
        state.user_agents.append(request.headers.get("User-Agent", ""))
        state.headers.append(dict(request.headers))
        if kind == "ok":
            return web.Response(text=PROFILE_PAGE.format(user=user), content_type="text/html")
        if kind == "missing":
            return web.Response(status=404, text="no such user")
        if kind == "forbidden":
            return web.Response(status=403, text="forbidden")
        if kind == "limited":
            return web.Response(status=429, text="slow down", headers={"Retry-After": "1"})
        if kind == "captcha":
            return web.Response(text=CAPTCHA_PAGE, content_type="text/html")
        if kind == "login":
            return web.Response(text=LOGIN_PAGE, content_type="text/html")
        if kind == "slow":
            await asyncio.sleep(5)
            return web.Response(text="late")
        if kind == "hop":
            raise web.HTTPFound(f"/ok/{user}")
        if kind == "escape":
            raise web.HTTPFound("http://elsewhere.invalid/profile")
        if kind == "loop":
            raise web.HTTPFound(f"/loop/{user}")
        return web.Response(status=500)

    app = web.Application()
    app.router.add_get("/robots.txt", robots)
    app.router.add_get("/{kind}/{user}", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    state = Loopback(port)
    try:
        yield state
    finally:
        await runner.cleanup()


def write_db(path: Path, sites: dict[str, object]) -> str:
    text = json.dumps({"sites": sites, "engines": {}, "tags": ["social"]})
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode()).hexdigest()


@pytest.fixture
def make_settings(tmp_path: Path):
    """Settings for searches over a test database served by the loopback site (``database: upstream``)."""

    def build(sites: dict[str, object], **overrides: object) -> Settings:
        db = tmp_path / "test-db.json"
        digest = write_db(db, sites)
        policy = copy.deepcopy(load_policy())
        policy["upstreamDatabase"] = {"id": "test-db", "sha256": digest}
        base = Settings(
            allow_external=True,
            policy=policy,
            upstream_db_path=db,
            host_interval_seconds=0.0,
            requests_per_second=200.0,
        )
        return replace(base, **overrides)

    return build


@pytest_asyncio.fixture
async def fake_fixture_site() -> AsyncIterator[str]:
    """Stands in for the synthetic fixture site: same prefixes and answers for the persona's pages."""
    pages = {
        "/robots.txt": (200, "User-agent: *\nDisallow: /private/\n"),
        "/wykop/ludzie/fikcyjny_kacper": (200, "<html>wykop fikcyjny_kacper</html>"),
        "/github/fikcyjny-kacper": (200, "<html>github fikcyjny-kacper</html>"),
        "/private/archiwum/fikcyjny_kacper": (200, "<html>should never be fetched</html>"),
        "/keybase/fikcyjny_kacper": (403, "<html><main data-olcys-barrier='blocked'>blocked</main></html>"),
    }
    seen: list[str] = []

    async def handler(request: web.Request) -> web.Response:
        seen.append(request.path)
        status, body = pages.get(request.path, (404, "nie znaleziono"))
        return web.Response(status=status, text=body, content_type="text/html")

    app = web.Application()
    app.router.add_get("/{tail:.*}", handler)
    app["seen"] = seen
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    app_state["seen"] = seen
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        await runner.cleanup()


app_state: dict[str, list[str]] = {}
