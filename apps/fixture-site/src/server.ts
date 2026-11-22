/**
 * CLI entry of the synthetic fixture site (no dependencies; runs in compose on node:26-alpine).
 *
 * Env: FIXTURE_HOST (127.0.0.1), FIXTURE_PORT (4100), FIXTURE_VARIANT (v1|v2), FIXTURE_ALLOW_VARIANT_SWITCH (1 enables
 * `POST /__fixture/variant`). Everything served here is SYNTHETIC; never put real people's data in public/.
 */
import { resolve } from 'node:path';
import { createFixtureServer } from './fixture-server.ts';

const server = await createFixtureServer({
  root: resolve(import.meta.dirname, '..', 'public'),
  variant: process.env['FIXTURE_VARIANT'] === 'v2' ? 'v2' : 'v1',
  host: process.env['FIXTURE_HOST'] ?? '127.0.0.1',
  port: Number(process.env['FIXTURE_PORT'] ?? 4100),
  allowVariantSwitch: process.env['FIXTURE_ALLOW_VARIANT_SWITCH'] === '1',
});
console.info(`[fixture-site] variant ${server.variant()} on ${server.url}`);
