/**
 * Starts the whole stack of the acceptance test and of the demo video as child processes on free loopback ports:
 * production build of the console + `vite preview`, and the API/worker/fixture site on the memory store (offline
 * mode, no DB, no compose). PIDs are recorded and stopped by PID, never by pattern.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { E2E_ROOT, REPO_ROOT, type StackState } from '../state.ts';
import { freePort } from './ports.ts';

const children: ChildProcess[] = [];
const quietEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  OLCYS_TELEMETRY: 'off',
  DO_NOT_TRACK: '1',
  NEXT_TELEMETRY_DISABLED: '1',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
});

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} -> ${code}`)),
    );
  });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // The e2e harness only talks to its own loopback servers.
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const stopAll = async (): Promise<void> => {
  for (const child of [...children].reverse()) {
    if (child.pid && child.exitCode === null) {
      child.removeAllListeners('exit');
      child.kill('SIGTERM');
    }
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', () => resolve()))),
    ),
  );
};

export async function startStack(): Promise<{ state: StackState; stop: () => Promise<void> }> {
  try {
    return await start();
  } catch (error) {
    await stopAll();
    throw error;
  }
}

async function start(): Promise<{ state: StackState; stop: () => Promise<void> }> {
  const webPort = await freePort();
  const web = `${REPO_ROOT}/apps/web`;
  const viteBin = `${REPO_ROOT}/node_modules/.bin/vite`;
  const env = { ...quietEnv(), WEB_PORT: String(webPort) };

  // Spawn the stack first, so the build overlaps with its start.
  const stack = spawn(process.execPath, [`${E2E_ROOT}/stack/serve.ts`], {
    cwd: REPO_ROOT,
    env: { ...env, E2E_WEB_PORT: String(webPort) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(stack);
  const ready = new Promise<{ apiPort: number; fixtureUrl: string }>((resolve, reject) => {
    stack.once('exit', (code) => reject(new Error(`stack exited early (${code})`)));
    const lines = createInterface({ input: stack.stdout! });
    lines.on('line', (line) => {
      if (line.startsWith('READY ')) resolve(JSON.parse(line.slice('READY '.length)));
      else console.info(line);
    });
  });
  const [{ apiPort, fixtureUrl }] = await Promise.all([ready, run(viteBin, ['build'], web, env)]);

  const preview = spawn(viteBin, ['preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: web,
    env: { ...env, API_PORT: String(apiPort) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(preview);
  const baseURL = `http://127.0.0.1:${webPort}`;
  await waitFor(baseURL, 60_000);
  await waitFor(`${baseURL}/api/health`, 30_000);

  const state: StackState = {
    baseURL,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    fixtureUrl,
    pids: children.map((child) => child.pid!).filter(Boolean),
  };
  console.info(
    `E2E stack: console ${baseURL}, API ${state.apiUrl}, fixture ${fixtureUrl} (pids ${state.pids.join(', ')})`,
  );

  return { state, stop: stopAll };
}
