/**
 * `pnpm doctor`: read-only diagnostics of the local development environment. Prints one line per check and an
 * OK/FAIL summary; exits non-zero when any check fails (warnings do not fail).
 */
import { createServer } from 'node:net';
import { detectCompose, envFilePresent, exec, toolchainRequirements, type Exec } from './exec.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  run: Exec;
  env: Record<string, string | undefined>;
  nodeVersion: string;
  requirements: { node: string; pnpm: string };
  envFile: boolean;
  /** True when nothing listens on the loopback port (we could bind it). */
  portFree: (port: number) => Promise<boolean>;
}

/** Services started by a plain `docker compose up`, with the env variable that configures the host port. */
const DEFAULT_SERVICES = [
  { service: 'postgres', portVar: 'POSTGRES_PORT', port: 5432 },
  { service: 'gotenberg', portVar: 'GOTENBERG_PORT', port: 3100 },
  { service: 'fixture-site', portVar: 'FIXTURE_PORT', port: 4100 },
] as const;
/** Ports used by `pnpm dev` (host processes). Busy is only a warning: the dev servers may be running. */
const APP_PORTS = [
  { name: 'api', portVar: 'API_PORT', port: 4000 },
  { name: 'web', portVar: 'WEB_PORT', port: 5173 },
] as const;

type Version = [number, number, number];
export function parseVersion(text: string): Version | undefined {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
}
/** Negative when a < b. */
export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export interface ComposeContainer {
  service: string;
  state: string;
  health: string;
  /** Host ports the container publishes; undefined when `compose ps` gave no port data. */
  published?: number[] | undefined;
}

const field = (item: unknown, key: string): unknown =>
  typeof item === 'object' && item !== null ? (item as Record<string, unknown>)[key] : undefined;

/** Host ports from docker compose `Publishers`, podman's `Ports` array or the `Ports` text ("127.0.0.1:5432->5432/tcp"). */
function publishedPorts(o: Record<string, unknown>): number[] | undefined {
  const publishers = o['Publishers'];
  const ports = o['Ports'];
  if (Array.isArray(publishers)) {
    return publishers.flatMap((p) => {
      const port = field(p, 'PublishedPort');
      return typeof port === 'number' && port > 0 ? [port] : [];
    });
  }
  if (Array.isArray(ports)) {
    return ports.flatMap((p) => {
      const port = field(p, 'host_port');
      const range = field(p, 'range');
      if (typeof port !== 'number' || port <= 0) return [];
      return Array.from({ length: typeof range === 'number' && range > 1 ? range : 1 }, (_, i) => port + i);
    });
  }
  if (typeof ports === 'string') return [...ports.matchAll(/:(\d+)->/g)].map((m) => Number(m[1]));
  return undefined;
}

function toContainer(raw: unknown): ComposeContainer | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const service = o['Service'] ?? o['Names'] ?? o['Name'];
  if (typeof service !== 'string') return undefined;
  return {
    service,
    state: typeof o['State'] === 'string' ? o['State'].toLowerCase() : '',
    health: typeof o['Health'] === 'string' ? o['Health'].toLowerCase() : '',
    published: publishedPorts(o),
  };
}

/** Parses `compose ps --format json`: a JSON array, or one JSON object per line (banner lines are ignored). */
export function parseComposePs(stdout: string): ComposeContainer[] | undefined {
  const text = stdout.trim();
  try {
    if (text === '') return [];
    const parsed: unknown = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map(toContainer).filter((c): c is ComposeContainer => c !== undefined);
  } catch {
    const containers: ComposeContainer[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const c = toContainer(JSON.parse(line));
        if (c) containers.push(c);
      } catch {
        return undefined;
      }
    }
    return containers.length > 0 ? containers : undefined;
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  // --- toolchain ---
  const needNode = parseVersion(deps.requirements.node);
  const haveNode = parseVersion(deps.nodeVersion);
  if (!needNode || !haveNode)
    add('node', 'fail', `cannot compare ${deps.nodeVersion} with "${deps.requirements.node}"`);
  else if (compareVersions(haveNode, needNode) < 0)
    add('node', 'fail', `${deps.nodeVersion} is older than required ${deps.requirements.node}`);
  else add('node', 'ok', `${deps.nodeVersion} (required ${deps.requirements.node})`);

  const pnpm = await deps.run('pnpm', ['--version']);
  const needPnpm = parseVersion(deps.requirements.pnpm);
  const havePnpm = parseVersion(pnpm.stdout);
  if (pnpm.code !== 0 || !havePnpm) add('pnpm', 'fail', 'pnpm not found on PATH');
  else if (needPnpm && compareVersions(havePnpm, needPnpm) < 0)
    add('pnpm', 'fail', `${pnpm.stdout.trim()} is older than required ${deps.requirements.pnpm}`);
  else add('pnpm', 'ok', `${pnpm.stdout.trim()} (required ${deps.requirements.pnpm})`);

  add(
    '.env',
    deps.envFile ? 'ok' : 'fail',
    deps.envFile ? 'present' : 'missing: run `cp .env.example .env` (defaults are local development values)',
  );

  // --- compose services ---
  const compose = await detectCompose(deps.run, deps.env);
  /** Running containers of the default services: their published ports decide whether a busy port is ours. */
  const running = new Map<string, ComposeContainer>();
  if (!compose) {
    add('compose', 'fail', 'neither `docker compose` nor `podman compose` works (set OLCYS_COMPOSE to override)');
  } else {
    add('compose', 'ok', compose.join(' '));
    const [bin = '', ...rest] = compose;
    const ps = await deps.run(bin, [...rest, 'ps', '--all', '--format', 'json']);
    const containers = ps.code === 0 ? parseComposePs(ps.stdout) : undefined;
    if (!containers) {
      add(
        'services',
        'fail',
        `cannot read \`${compose.join(' ')} ps --format json\` (${ps.stderr.trim().slice(0, 200)})`,
      );
    } else {
      for (const { service } of DEFAULT_SERVICES) {
        const c = containers.find((x) => x.service === service);
        if (c?.state === 'running') running.set(service, c);
        if (!c) add(`service ${service}`, 'fail', 'not created: run `pnpm dev:deps`');
        else if (c.state !== 'running')
          add(`service ${service}`, 'fail', `state is "${c.state}": run \`pnpm dev:deps\``);
        else if (c.health === 'healthy' || c.health === '')
          add(`service ${service}`, 'ok', c.health === '' ? 'running (no health check)' : 'healthy');
        else add(`service ${service}`, 'fail', `running but health is "${c.health}"`);
      }
      // Optional profiles are reported only when their containers exist.
      for (const c of containers.filter((x) => !DEFAULT_SERVICES.some((d) => d.service === x.service))) {
        const ok = c.state === 'running' && (c.health === '' || c.health === 'healthy');
        add(
          `service ${c.service}`,
          ok ? 'ok' : 'warn',
          `${c.state}${c.health ? `, ${c.health}` : ''} (optional profile)`,
        );
      }
    }
  }

  // --- ports ---
  for (const { service, portVar, port: dflt } of DEFAULT_SERVICES) {
    const port = Number(deps.env[portVar] ?? dflt);
    const ours = running.get(service);
    if (ours?.published?.includes(port)) {
      add(`port ${port}`, 'ok', `published by our ${service} (${portVar})`);
      continue;
    }
    if (ours?.published) {
      // E.g. the port was changed in .env but the container was not recreated.
      const actual = ours.published.join(', ') || 'no host port';
      add(
        `port ${port}`,
        'fail',
        `${portVar} is ${port} but the running ${service} publishes ${actual}: run \`pnpm dev:deps\``,
      );
      continue;
    }
    // Sequential: each probe binds and releases a socket.
    // oxlint-disable-next-line no-await-in-loop
    const free = await deps.portFree(port);
    if (!ours) {
      if (free) add(`port ${port}`, 'ok', `free for ${service} (${portVar})`);
      else
        add(`port ${port}`, 'fail', `taken by another process; ${service} cannot bind it (change ${portVar} in .env)`);
    } else if (free) {
      add(
        `port ${port}`,
        'fail',
        `nothing listens on it although ${service} is running: run \`pnpm dev:deps\` (${portVar})`,
      );
    } else {
      add(
        `port ${port}`,
        'warn',
        `in use, but \`compose ps\` gave no port data to confirm it is our ${service} (${portVar})`,
      );
    }
  }
  for (const { name, portVar, port: dflt } of APP_PORTS) {
    const port = Number(deps.env[portVar] ?? dflt);
    // oxlint-disable-next-line no-await-in-loop
    if (await deps.portFree(port)) add(`port ${port}`, 'ok', `free for ${name} (${portVar})`);
    else
      add(
        `port ${port}`,
        'warn',
        `in use: fine if \`pnpm dev\` is running, otherwise another process holds ${name}'s port`,
      );
  }
  return checks;
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✔', warn: '!', fail: '✖' };

export function renderDoctor(checks: readonly Check[]): { text: string; ok: boolean } {
  const lines = checks.map((c) => `${SYMBOL[c.status]} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn').length;
  lines.push(
    '',
    failed.length === 0
      ? `OK: all checks passed${warned ? ` (${warned} warning${warned === 1 ? '' : 's'})` : ''}`
      : `FAIL: ${failed.length} check${failed.length === 1 ? '' : 's'} failed (${failed.map((c) => c.name).join(', ')})`,
  );
  return { text: lines.join('\n'), ok: failed.length === 0 };
}

/** Binds the loopback port briefly; EADDRINUSE and EACCES count as not free. */
export const portIsFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });

if (import.meta.main) {
  const checks = await runDoctor({
    run: exec,
    env: process.env,
    nodeVersion: process.versions.node,
    requirements: toolchainRequirements(),
    envFile: envFilePresent(),
    portFree: portIsFree,
  });
  const { text, ok } = renderDoctor(checks);
  console.info(text);
  process.exit(ok ? 0 : 1);
}
