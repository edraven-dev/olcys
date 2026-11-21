/**
 * @olcys/api — HTTP API for the analyst console. Skeleton only: business routes are not implemented yet.
 * Binds to 127.0.0.1; the web app reaches it through the Vite dev proxy (`/api`).
 */
import { CORE_CONTRACTS_VERSION } from '@olcys/core';
import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/api/health', async () => ({
  status: 'ok',
  service: '@olcys/api',
  contracts: CORE_CONTRACTS_VERSION,
}));

const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ host: '127.0.0.1', port });
