# Newest stable Python and uv at the time of writing. Commit uv.lock and switch to `uv sync --frozen`
# once dependencies stabilise.
FROM ghcr.io/astral-sh/uv:0.13.9 AS uv

FROM python:3.15.2-slim-trixie
COPY --from=uv /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    DO_NOT_TRACK=1

WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev

COPY src ./src
RUN useradd --system --uid 10001 --home /app olcys
USER olcys

EXPOSE 8000
CMD ["uvicorn", "olcys_osint.main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000"]
