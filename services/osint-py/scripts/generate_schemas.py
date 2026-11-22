"""Writes the JSON Schemas (draft 2020-12) of the API models into ``schemas/``. ``--check`` only compares."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from olcys_osint.models import (  # noqa: E402
    ProfileExtractRequest,
    ProfileExtractResponse,
    UsernameSearchRequest,
    UsernameSearchResponse,
)

OUT = Path(__file__).resolve().parents[1] / "schemas"
MODELS = (UsernameSearchRequest, UsernameSearchResponse, ProfileExtractRequest, ProfileExtractResponse)


def render() -> dict[str, str]:
    files = {}
    for model in MODELS:
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", **model.model_json_schema()}
        files[f"{model.__name__}.schema.json"] = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
    return files


def main() -> int:
    files = render()
    if "--check" in sys.argv:
        # Compared as data: the repository formatter may lay the files out differently.
        stale = [
            n
            for n, text in files.items()
            if not (OUT / n).exists() or json.loads((OUT / n).read_text()) != json.loads(text)
        ]
        print("stale: " + ", ".join(stale) if stale else "schemas are current")
        return 1 if stale else 0
    OUT.mkdir(exist_ok=True)
    for name, text in files.items():
        (OUT / name).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
