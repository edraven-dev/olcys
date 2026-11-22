import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_ROOT = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(E2E_ROOT, '..');
export const STATE_FILE = join(E2E_ROOT, '.state', 'stack.json');

/** Where the stack started by the global setup listens (all loopback). */
export interface StackState {
  baseURL: string;
  apiUrl: string;
  fixtureUrl: string;
  pids: number[];
}

export function readState(): StackState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as StackState;
}
