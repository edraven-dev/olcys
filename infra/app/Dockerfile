# OŁCyŚ application image: API, worker and web console, started by `docker compose --profile app up`.
# Runs the TypeScript sources directly on Node 26 (type stripping), exactly as `pnpm dev` does on the host.
FROM node:26.13.1-alpine

ENV HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    VLLM_NO_USAGE_STATS=1 \
    OLLAMA_NO_CLOUD=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DO_NOT_TRACK=1

# The pnpm version pinned in package.json (`packageManager`).
RUN npm install --global pnpm@12.22.0

WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile && mkdir -p data

# Migrations first (idempotent), then API (127.0.0.1:4000), worker and console (127.0.0.1:5173).
CMD ["sh", "-c", "pnpm db:migrate && exec pnpm dev"]
