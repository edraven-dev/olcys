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
    DO_NOT_TRACK=1

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN useradd --system --uid 10001 --home /app olcys

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
USER olcys

EXPOSE 8000
CMD ["uvicorn", "olcys_osint.main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000"]
