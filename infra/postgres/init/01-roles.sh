#!/usr/bin/env bash
# Runs once, on first initialisation of the postgres volume (docker-entrypoint-initdb.d).
#
# Roles:
#   $POSTGRES_USER (olcys_owner)  owns the schemas and runs migrations (packages/db).
#   olcys_app                     used by apps/api and apps/worker at runtime.
#
# Evidence tables are append-only for olcys_app: default privileges grant SELECT and INSERT only.
# A migration that needs UPDATE on a specific mutable table (e.g. run status) must grant it explicitly
# and say why. pg-boss gets its own schema owned by olcys_app.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v app_password="${OLCYS_APP_PASSWORD:?OLCYS_APP_PASSWORD must be set}" <<-'EOSQL'
	CREATE ROLE olcys_app LOGIN PASSWORD :'app_password';

	CREATE SCHEMA IF NOT EXISTS olcys AUTHORIZATION CURRENT_USER;
	GRANT USAGE ON SCHEMA olcys TO olcys_app;
	ALTER DEFAULT PRIVILEGES IN SCHEMA olcys GRANT SELECT, INSERT ON TABLES TO olcys_app;
	ALTER DEFAULT PRIVILEGES IN SCHEMA olcys GRANT USAGE, SELECT ON SEQUENCES TO olcys_app;

	CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION olcys_app;

	REVOKE CREATE ON SCHEMA public FROM PUBLIC;
	ALTER ROLE olcys_app SET search_path = olcys, public;
	ALTER DATABASE :"DBNAME" SET timezone TO 'UTC';
EOSQL
