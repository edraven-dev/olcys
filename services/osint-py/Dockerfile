FROM ghcr.io/astral-sh/uv:0.13.9 AS uv

FROM python:3.15.2-slim-trixie AS base
COPY --from=uv /uv /uvx /bin/

# Telemetry stays off; no network is needed at runtime except to the hosts the service itself allows.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    VLLM_NO_USAGE_STATS=1 \
    OLLAMA_NO_CLOUD=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DO_NOT_TRACK=1

WORKDIR /app
COPY pyproject.toml uv.lock ./
# The demo signing identity (created on first use, never part of the image or the repository) lives in /signing.
RUN useradd --system --uid 10001 --home /app olcys && mkdir /signing && chown olcys /signing
ENV OLCYS_SIGNING_DIR=/signing

# Tests run offline: `docker build --target test -t olcys-osint-test services/osint-py`
# then `docker run --rm --network none olcys-osint-test`.
FROM base AS test
RUN uv sync --frozen
COPY src ./src
COPY config ./config
COPY data ./data
COPY schemas ./schemas
COPY scripts ./scripts
COPY tests ./tests
USER olcys
CMD ["pytest", "-q"]

FROM base AS runtime
RUN uv sync --frozen --no-dev
COPY src ./src
COPY config ./config
COPY data ./data
COPY scripts/make_demo_signer.py ./scripts/make_demo_signer.py
USER olcys

EXPOSE 8000
CMD ["uvicorn", "olcys_osint.main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000"]
