"""Creates the demo signing identity (self-signed, NOT qualified) in a directory, once: ``make_demo_signer.py <dir>``.

Run it through ``pnpm signing:init`` (inside the service container, into its signing volume). The directory is never
committed; an existing identity is kept.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from olcys_osint.demo_signer import DEMO_COMMON_NAME, load_or_create_demo_signer  # noqa: E402


def main() -> int:
    directory = Path(sys.argv[1] if len(sys.argv) > 1 else "/signing")
    signer = load_or_create_demo_signer(directory)
    print(f"demo signing identity ready in {directory}: {DEMO_COMMON_NAME}")
    print(f"certificate bytes: {len(signer.cert_pem)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
