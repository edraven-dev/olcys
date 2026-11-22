/** Process and environment helpers shared by the developer scripts. Injectable so tests never start a process. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const REPO_ROOT = join(dirname(import.meta.filename), '..', '..');

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command (no shell) and collects its output; a missing binary yields code 127 instead of throwing. */
export type Exec = (command: string, args: readonly string[]) => Promise<ExecResult>;

export const exec: Exec = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: stderr + error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/**
 * The compose command: `OLCYS_COMPOSE` ("docker compose", "podman compose", "docker-compose", ...) or the first of
 * `docker compose` / `podman compose` that answers `version`. Returns undefined when none works.
 */
export async function detectCompose(run: Exec, env: Record<string, string | undefined>): Promise<string[] | undefined> {
  const configured = env['OLCYS_COMPOSE']?.trim();
  if (configured) return configured.split(/\s+/);
  for (const candidate of [
    ['docker', 'compose'],
    ['podman', 'compose'],
  ]) {
    // Sequential on purpose: the first working candidate wins.
    // oxlint-disable-next-line no-await-in-loop
    const result = await run(candidate[0] ?? '', [...candidate.slice(1), 'version']);
    if (result.code === 0) return candidate;
  }
  return undefined;
}

/** Whether a `.env` file exists in the repository root. */
export const envFilePresent = (root: string = REPO_ROOT): boolean => existsSync(join(root, '.env'));

/** `{ node: ">=26.13.1", pnpm: "12.22.0" }` from the root package.json. */
export function toolchainRequirements(root: string = REPO_ROOT): { node: string; pnpm: string } {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
    packageManager?: string;
  };
  return { node: pkg.engines?.node ?? '', pnpm: (pkg.packageManager ?? '').replace(/^pnpm@/, '') };
}
