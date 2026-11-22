/**
 * `pnpm db:reset --yes`: destroys the compose PostgreSQL container and its data volume, starts a fresh one (roles and
 * schemas come from infra/postgres/init on first start) and applies the migrations. Without `--yes` it only prints
 * the plan and refuses. `--dry-run` prints the plan and stops, with or without `--yes`.
 */
import { detectCompose, exec, type Exec } from './exec.ts';

export interface ResetPlan {
  composeCommand: string[];
  volume: string;
  steps: { description: string; command: string; args: string[] }[];
}

export function buildPlan(compose: string[], env: Record<string, string | undefined>): ResetPlan {
  const [bin = '', ...rest] = compose;
  const project = env['COMPOSE_PROJECT_NAME'] || 'olcys';
  const volume = `${project}_postgres-data`;
  // The container runtime CLI for the volume: the first word of the compose command (docker / podman).
  const engine = bin === 'docker-compose' ? 'docker' : bin === 'podman-compose' ? 'podman' : bin;
  return {
    composeCommand: compose,
    volume,
    steps: [
      { description: 'stop the postgres service', command: bin, args: [...rest, 'stop', 'postgres'] },
      { description: 'remove the postgres container', command: bin, args: [...rest, 'rm', '--force', 'postgres'] },
      { description: `delete the data volume ${volume}`, command: engine, args: ['volume', 'rm', '--force', volume] },
      {
        description: 'start a fresh postgres and wait until healthy (runs infra/postgres/init)',
        command: bin,
        args: [...rest, 'up', '-d', '--wait', 'postgres'],
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
  const plan = buildPlan(compose, deps.env);
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
