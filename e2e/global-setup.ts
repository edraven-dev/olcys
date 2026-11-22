/** Playwright global setup: starts the stack, records where it listens, returns the teardown that stops it by PID. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATE_FILE } from './state.ts';
import { startStack } from './stack/start.ts';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const { state, stop } = await startStack();
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
  return stop;
}
