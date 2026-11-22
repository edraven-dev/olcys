/**
 * `pnpm db:reset --yes`: destroys the compose PostgreSQL container and its data volume, starts a fresh one (roles and
 * schemas come from infra/postgres/init on first start) and applies the migrations. Without `--yes` it only prints
 * the plan and refuses. `--dry-run` prints the plan and stops, with or without `--yes`.
 *
 * The volume name comes from the resolved compose configuration (`config --format json`), so `-p`, `-f`,
 * `COMPOSE_PROJECT_NAME` and the file's `name:` are all honoured, and the volume command keeps the engine prefix of the
 * compose command (`docker --context x compose` → `docker --context x volume rm`). When either cannot be determined,
 * nothing is deleted.
 */
import { detectCompose, exec, type Exec } from './exec.ts';

/** The database service and its data volume key in compose.yml. */
const SERVICE = 'postgres';
const VOLUME_KEY = 'postgres-data';

export interface ResetPlan {
  composeCommand: string[];
  volume: string;
  steps: { description: string; command: string; args: string[] }[];
}

/**
 * The container engine command behind a compose command: the words before `compose` (`docker --context x compose -p y`
 * → `docker --context x`), or `docker` / `podman` for the standalone `docker-compose` / `podman-compose` binaries.
 */
export function engineOf(compose: readonly string[]): string[] | undefined {
  const at = compose.indexOf('compose');
  if (at > 0) return compose.slice(0, at);
  const bin = (compose[0] ?? '').split('/').at(-1);
  if (bin === 'docker-compose') return ['docker'];
  if (bin === 'podman-compose') return ['podman'];
  return undefined;
}

/** The resolved name of the database volume, from `<compose> config --format json`; undefined when unknown. */
export async function resolveVolume(run: Exec, compose: readonly string[]): Promise<string | undefined> {
  const [bin = '', ...rest] = compose;
  const result = await run(bin, [...rest, 'config', '--format', 'json']);
  const start = result.stdout.indexOf('{');
  if (result.code !== 0 || start === -1) return undefined;
  try {
    const config = JSON.parse(result.stdout.slice(start)) as { volumes?: Record<string, { name?: unknown } | null> };
    const name = config.volumes?.[VOLUME_KEY]?.name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

export function buildPlan(compose: string[], engine: readonly string[], volume: string): ResetPlan {
  const [bin = '', ...rest] = compose;
  const [engineBin = '', ...engineArgs] = engine;
  return {
    composeCommand: compose,
    volume,
    steps: [
      { description: 'stop the postgres service', command: bin, args: [...rest, 'stop', SERVICE] },
      { description: 'remove the postgres container', command: bin, args: [...rest, 'rm', '--force', SERVICE] },
      {
        description: `delete the data volume ${volume}`,
        command: engineBin,
        args: [...engineArgs, 'volume', 'rm', '--force', volume],
      },
      {
        description: 'start a fresh postgres and wait until healthy (runs infra/postgres/init)',
        command: bin,
        args: [...rest, 'up', '-d', '--wait', SERVICE],
      },
    ],
  };
}

export function describePlan(plan: ResetPlan): string {
  return [
    'db:reset will DESTROY the local development database (all cases, runs and evidence in it):',
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s.description}: ${[s.command, ...s.args].join(' ')}`),
    `  ${plan.steps.length + 1}. apply migrations (pnpm db:migrate as the owner role)`,
  ].join('\n');
}

export interface ResetDeps {
  run: Exec;
  migrate: () => Promise<{ applied: string[] }>;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

/** Returns the process exit code. */
export async function resetDatabase(argv: readonly string[], deps: ResetDeps): Promise<number> {
  const compose = await detectCompose(deps.run, deps.env);
  if (!compose) {
    deps.log('db:reset: no working `docker compose` or `podman compose` (set OLCYS_COMPOSE to override)');
    return 1;
  }
  const engine = engineOf(compose);
  if (!engine) {
    deps.log(
      `db:reset: cannot tell the container engine of "${compose.join(' ')}" (expected "<engine> compose", ` +
        'docker-compose or podman-compose); nothing was changed',
    );
    return 1;
  }
  const volume = await resolveVolume(deps.run, compose);
  if (!volume) {
    deps.log(
      `db:reset: cannot resolve the ${VOLUME_KEY} volume from \`${compose.join(' ')} config --format json\`; ` +
        'refusing to delete anything',
    );
    return 1;
  }
  const plan = buildPlan(compose, engine, volume);
  deps.log(describePlan(plan));
  if (argv.includes('--dry-run')) {
    deps.log('dry run: nothing was changed');
    return 0;
  }
  if (!argv.includes('--yes')) {
    deps.log('Refusing to continue without --yes. Run `pnpm db:reset --yes` to confirm.');
    return 1;
  }
  for (const step of plan.steps) {
    deps.log(`> ${step.description}`);
    // Sequential on purpose: each step depends on the previous one.
    // oxlint-disable-next-line no-await-in-loop
    const result = await deps.run(step.command, step.args);
    if (result.code !== 0) {
      deps.log(`db:reset failed at "${step.description}" (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`);
      return 1;
    }
  }
  deps.log('> apply migrations');
  const { applied } = await deps.migrate();
  deps.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  deps.log('db:reset done: empty, migrated database. Run `pnpm seed` to create the demo case.');
  return 0;
}

if (import.meta.main) {
  const ownerUrl = process.env['DATABASE_URL_OWNER'];
  if (!ownerUrl) {
    console.error('DATABASE_URL_OWNER is not set (copy .env.example to .env)');
    process.exit(1);
  }
  const { migrate } = await import('../../packages/db/src/index.ts');
  const code = await resetDatabase(process.argv.slice(2), {
    run: exec,
    migrate: () => migrate(ownerUrl),
    env: process.env,
    log: (line) => console.info(line),
  });
  process.exit(code);
}
