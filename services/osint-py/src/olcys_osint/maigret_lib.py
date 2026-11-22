"""Loads Maigret as a library with every rule-breaking path removed.

Maigret's package imports proxy and TLS-impersonation helpers (``aiohttp_socks``, ``curl_cffi``) at import time.
Those packages are excluded from the lock file and never installed (see ``pyproject.toml``), so the import is done
once with inert placeholder modules that are removed from ``sys.modules`` again right afterwards. Afterwards every
code path that could reach the network on its own, or evade a block, is replaced by a function that raises:

* the checkers for TLS impersonation (curl_cffi), the Cloudflare "webgate" solvers, DNS probing and Tor/I2P proxies;
* site activation (token refresh, X's GraphQL probe) and cookie jar import;
* the site database updater (no automatic update, no download);
* the HTTP checker itself, which is replaced by ``GuardedChecker`` (the only network path).

Only ``maigret.search`` (the coroutine ``maigret.checking.maigret``), ``MaigretDatabase`` and the result types are used.
The CLI entry point, the ``--ai`` module and the web UI are never imported or called.
"""

import importlib
import inspect
import sys
import types
from typing import Any

PLACEHOLDERS = ("aiohttp_socks", "curl_cffi", "curl_cffi.requests")
_loaded: types.SimpleNamespace | None = None


class ForbiddenPathError(RuntimeError):
    """A Maigret code path that OŁCyŚ rules forbid was reached (a bug, never an expected failure)."""


def _forbidden(what: str):
    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise ForbiddenPathError(f"{what} is disabled in this service")

    return refuse


def _forbidden_class(what: str) -> type:
    def init(_self: Any, *_args: Any, **_kwargs: Any) -> None:
        raise ForbiddenPathError(f"{what} is disabled in this service")

    return type("Forbidden" + what.title().replace(" ", ""), (), {"__init__": init})


def _placeholder_modules() -> dict[str, types.ModuleType]:
    socks = types.ModuleType("aiohttp_socks")
    for name in ("ProxyConnectionError", "ProxyError", "ProxyTimeoutError"):
        setattr(socks, name, type(name, (Exception,), {}))
    socks.ProxyConnector = _forbidden_class("proxy connector")  # type: ignore[attr-defined]
    curl = types.ModuleType("curl_cffi")
    curl.CurlError = type("CurlError", (Exception,), {})  # type: ignore[attr-defined]
    requests = types.ModuleType("curl_cffi.requests")
    requests.AsyncSession = _forbidden_class("TLS impersonation")  # type: ignore[attr-defined]
    curl.requests = requests  # type: ignore[attr-defined]
    return {"aiohttp_socks": socks, "curl_cffi": curl, "curl_cffi.requests": requests}


def load() -> types.SimpleNamespace:
    """Imports and hardens Maigret once; returns the few names the service uses."""
    global _loaded
    if _loaded is not None:
        return _loaded
    from .guarded_checker import GuardedChecker

    already = [name for name in PLACEHOLDERS if name in sys.modules]
    if already:  # pragma: no cover - would mean the real packages were installed
        raise ForbiddenPathError(f"forbidden packages are present: {already}")
    sys.modules.update(_placeholder_modules())
    try:
        maigret = importlib.import_module("maigret")
        checking = importlib.import_module("maigret.checking")
        sites = importlib.import_module("maigret.sites")
        result = importlib.import_module("maigret.result")
        db_updater = importlib.import_module("maigret.db_updater")
    finally:
        for name in PLACEHOLDERS:
            sys.modules.pop(name, None)

    checking.SimpleAiohttpChecker = GuardedChecker
    checking.ProxiedAiohttpChecker = _forbidden_class("proxied checker")
    checking.CurlCffiChecker = _forbidden_class("TLS impersonation checker")
    checking.CloudflareWebgateChecker = _forbidden_class("Cloudflare webgate checker")
    checking.AiodnsDomainResolver = _forbidden_class("DNS domain check")
    checking.ParsingActivator = _forbidden_class("site activation")
    checking.import_aiohttp_cookies = _forbidden("cookie import")
    checking.build_cloudflare_bypass_config = _forbidden("Cloudflare bypass")
    checking.run_url_mutations = _forbidden("URL mutations")
    checking.debug_ip_request = _forbidden("IP request")
    for name, function in list(vars(db_updater).items()):
        if inspect.isfunction(function) and function.__module__ == db_updater.__name__:
            setattr(db_updater, name, _forbidden("database update"))
    sites.MaigretDatabase.load_from_http = _forbidden("database download")  # type: ignore[method-assign]

    _loaded = types.SimpleNamespace(
        maigret=maigret,
        search=checking.maigret,
        MaigretDatabase=sites.MaigretDatabase,
        MaigretCheckStatus=result.MaigretCheckStatus,
        version=maigret.__version__,
    )
    return _loaded
