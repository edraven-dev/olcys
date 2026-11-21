"""Internal HTTP API of the Python worker. Skeleton only.

Endpoints to implement:
  POST /v1/usernames/search  Maigret with a pinned site DB and a tag allow-list
  POST /v1/profiles/extract  socid-extractor on an already captured page
  POST /v1/pdf/sign/prepare  pyHanko interrupted signing, phase 1 (document digest to timestamp)
  POST /v1/pdf/sign/finish   pyHanko interrupted signing, phase 2 (embed signature + RFC 3161 token)

The timestamp request between the two phases is made by the Node worker through its egress client, so this
service never contacts a timestamping authority itself.

Rules: no proxies, no CAPTCHA bypass, no Maigret --ai mode, no auto-updating site DB. Third-party
sites are only contacted when OLCYS_OSINT_ALLOW_EXTERNAL=true; otherwise only the fixture site.
"""

import os

from fastapi import FastAPI, HTTPException

app = FastAPI(title="olcys-osint", version="0.0.0", docs_url=None, redoc_url=None, openapi_url=None)

ALLOW_EXTERNAL = os.environ.get("OLCYS_OSINT_ALLOW_EXTERNAL", "false").lower() == "true"


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {"status": "ok", "service": "olcys-osint", "allow_external": ALLOW_EXTERNAL}


@app.post("/v1/usernames/search")
def usernames_search() -> None:
    raise HTTPException(status_code=501, detail="Not implemented yet")
