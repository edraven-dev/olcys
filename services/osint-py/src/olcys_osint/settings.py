"""Runtime configuration: environment, committed policy file and database locations."""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SERVICE_VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = ROOT / "config" / "policy.json"
FIXTURE_DB_PATH = ROOT / "data" / "maigret-db" / "fixture.json"
DEFAULT_USER_AGENT = f"OLCYS/{SERVICE_VERSION} (OSINT research prototype)"


def load_policy(path: Path = POLICY_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Settings:
    allow_external: bool = False
    fixture_base_url: str = "http://127.0.0.1:4100"
    user_agent: str = DEFAULT_USER_AGENT
    policy: dict[str, Any] = field(default_factory=load_policy)
    fixture_db_path: Path = FIXTURE_DB_PATH
    # None: the Maigret wheel's own data.json (pinned by SHA-256 in the policy).
    upstream_db_path: Path | None = None
    # Overrides of the policy's pacing, for tests against loopback servers only.
    host_interval_seconds: float | None = None
    requests_per_second: float | None = None

    @property
    def limits(self) -> dict[str, Any]:
        return self.policy["limits"]


def settings_from_env(env: dict[str, str] | None = None) -> Settings:
    source = os.environ if env is None else env
    return Settings(
        allow_external=source.get("OLCYS_OSINT_ALLOW_EXTERNAL", "false").strip().lower() == "true",
        fixture_base_url=(source.get("OLCYS_FIXTURE_BASE_URL") or "http://127.0.0.1:4100").rstrip("/"),
        user_agent=source.get("OLCYS_USER_AGENT") or DEFAULT_USER_AGENT,
    )
