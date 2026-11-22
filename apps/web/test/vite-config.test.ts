/** The dev server takes WEB_PORT and API_PORT from the same settings the API reads; tests use a temp dir, not the root. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { serverSettings } from '../vite.settings.ts';

const dir = mkdtempSync(join(tmpdir(), 'olcys-vite-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('dev server settings', () => {
  it('default to 5173 and API 4000 without any setting', () => {
    expect(serverSettings('test', dir, {})).toEqual({
      host: '127.0.0.1',
      port: 5173,
      apiTarget: 'http://127.0.0.1:4000',
    });
  });

  it('read WEB_PORT and API_PORT from a .env file in the env directory', () => {
    writeFileSync(join(dir, '.env'), 'WEB_PORT=5200\nAPI_PORT=4010\n');
    expect(serverSettings('test', dir, {})).toEqual({
      host: '127.0.0.1',
      port: 5200,
      apiTarget: 'http://127.0.0.1:4010',
    });
  });

  it('bind WEB_HOST when the container stack sets it', () => {
    expect(serverSettings('test', dir, { WEB_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('let the process environment win over the file', () => {
    expect(serverSettings('test', dir, { WEB_PORT: '5300' }).port).toBe(5300);
  });
});
