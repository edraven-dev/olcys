import json
import subprocess
import sys
from pathlib import Path

from olcys_osint.models import UsernameSearchResponse

ROOT = Path(__file__).resolve().parents[1]


def test_committed_schemas_are_current():
    result = subprocess.run([sys.executable, str(ROOT / "scripts" / "generate_schemas.py"), "--check"], check=False)
    assert result.returncode == 0


def test_sample_response_validates():
    sample = (ROOT / "tests" / "data" / "usernames-search.sample.json").read_text(encoding="utf-8")
    response = UsernameSearchResponse.model_validate_json(sample)
    assert response.schemaVersion == "usernames-search.v1"
    assert json.loads(sample)["results"]
