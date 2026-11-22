"""The environment cannot import proxy, Tor, TLS-impersonation or anti-bot packages, and a search never uses a proxy."""

import importlib.metadata
import importlib.util
import subprocess
import sys

import aiohttp
import pytest

from olcys_osint import maigret_lib
from olcys_osint.guarded_checker import GuardedChecker
from olcys_osint.models import UsernameSearchRequest
from olcys_osint.runner import run_search

# Import and distribution names of every helper that would proxy, tunnel, impersonate a browser or solve a challenge.
FORBIDDEN_MODULES = [
    "aiohttp_socks",
    "python_socks",
    "socks",
    "sockshandler",
    "curl_cffi",
    "cloudscraper",
    "stem",
    "torrequest",
    "tls_client",
    "undetected_chromedriver",
    "selenium",
    "playwright",
    "flask_socks",
]
FORBIDDEN_DISTRIBUTIONS = {
    "aiohttp-socks",
    "python-socks",
    "pysocks",
    "curl-cffi",
    "cloudscraper",
    "stem",
    "torrequest",
    "tls-client",
    "undetected-chromedriver",
    "selenium",
    "playwright",
    "openai",
}


def test_forbidden_packages_are_not_installed():
    installed = {d.metadata["Name"].lower().replace("_", "-") for d in importlib.metadata.distributions()}
    assert not installed & FORBIDDEN_DISTRIBUTIONS
    for name in FORBIDDEN_MODULES:
        assert importlib.util.find_spec(name) is None, f"{name} must not be importable"


def test_fresh_interpreter_cannot_import_them():
    code = (
        "import importlib.util, sys\n"
        f"bad = [m for m in {FORBIDDEN_MODULES!r} if importlib.util.find_spec(m) is not None]\n"
        "sys.exit(1 if bad else 0)"
    )
    assert subprocess.run([sys.executable, "-I", "-c", code], check=False).returncode == 0


def test_maigret_loads_without_leaving_placeholders_behind():
    lib = maigret_lib.load()
    for name in maigret_lib.PLACEHOLDERS:
        assert name not in sys.modules
        assert importlib.util.find_spec(name.split(".")[0]) is None
    import maigret.checking as checking

    assert checking.SimpleAiohttpChecker is GuardedChecker
    assert lib.version == "0.6.6"


@pytest.mark.parametrize(
    "path",
    [
        "CurlCffiChecker",
        "CloudflareWebgateChecker",
        "ProxiedAiohttpChecker",
        "AiodnsDomainResolver",
        "ParsingActivator",
    ],
)
def test_bypass_checkers_cannot_be_constructed(path):
    maigret_lib.load()
    import maigret.checking as checking

    with pytest.raises(maigret_lib.ForbiddenPathError):
        getattr(checking, path)()


def test_other_forbidden_paths_raise():
    maigret_lib.load()
    import maigret.checking as checking
    import maigret.db_updater as updater
    import maigret.sites as sites

    for call in (
        lambda: checking.build_cloudflare_bypass_config({}, True),
        lambda: checking.import_aiohttp_cookies("cookies.txt"),
        lambda: sites.MaigretDatabase().load_from_http("https://example.org/data.json"),
    ):
        with pytest.raises(maigret_lib.ForbiddenPathError):
            call()
    names = ("resolve_db_path", "force_update", "_fetch_meta", "_download_and_verify", "_save_state")
    for name in names:
        with pytest.raises(maigret_lib.ForbiddenPathError):
            getattr(updater, name)()


async def test_a_search_never_uses_a_proxy(loopback, make_settings, monkeypatch):
    for variable in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(variable, "http://127.0.0.1:9")  # nothing listens there: a proxy would break the search
    monkeypatch.setenv("NO_PROXY", "")
    seen: list[dict] = []
    original = aiohttp.ClientSession._request

    async def spy(self, method, str_or_url, **kwargs):
        seen.append({"trust_env": self._trust_env, "kwargs": dict(kwargs)})
        return await original(self, method, str_or_url, **kwargs)

    monkeypatch.setattr(aiohttp.ClientSession, "_request", spy)
    response = await run_search(
        UsernameSearchRequest(username="someone", database="upstream", timeoutSeconds=2),
        make_settings({"Found": loopback.site("ok")}),
    )
    assert response.results[0].status == "found"
    assert seen and all(call["trust_env"] is False for call in seen)
    assert all(not call["kwargs"].get("proxy") and call["kwargs"].get("allow_redirects") is False for call in seen)
    assert all(not isinstance(call["kwargs"].get("cookies"), dict) for call in seen)


def test_checker_refuses_proxy_and_cookies():
    with pytest.raises(RuntimeError):
        GuardedChecker(proxy="socks5://127.0.0.1:9050")
    with pytest.raises(RuntimeError):
        GuardedChecker(cookie_jar=object())
