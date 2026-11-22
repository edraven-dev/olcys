/** The dev server takes WEB_PORT and API_PORT from the same settings the API reads (process env over the root .env). */
import { afterEach, describe, expect, it } from 'vitest';
import config from '../vite.config.ts';

const settings = (): { port: number; proxy: Record<string, string> } => {
  const resolved = (config as (env: { mode: string; command: string }) => { server: never })({
    mode: 'test',
    command: 'serve',
  });
  return resolved.server;
};

describe('vite config', () => {
  const before = { web: process.env.WEB_PORT, api: process.env.API_PORT };
  afterEach(() => {
    for (const [key, value] of [
      ['WEB_PORT', before.web],
      ['API_PORT', before.api],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('defaults to 5173 and API 4000 and follows WEB_PORT and API_PORT', () => {
    delete process.env.WEB_PORT;
    delete process.env.API_PORT;
    expect(settings()).toMatchObject({ port: 5173, proxy: { '/api': 'http://127.0.0.1:4000' } });
    process.env.WEB_PORT = '5200';
    process.env.API_PORT = '4010';
    expect(settings()).toMatchObject({ port: 5200, proxy: { '/api': 'http://127.0.0.1:4010' } });
  });
});
