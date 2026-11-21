/**
 * @olcys/api — HTTP API for the analyst console. Binds to 127.0.0.1; the web app reaches it through the Vite dev
 * proxy (`/api`). The MVP runs the analysis pipeline in this process.
 */
import { createRuntime } from '@olcys/worker';
import { buildApp } from './app.ts';
import { defaultStages } from './stages.ts';

const runtime = await createRuntime({ stages: defaultStages });
const app = buildApp({ ...runtime, httpLog: true });
const port = Number(process.env['API_PORT'] ?? 4000);
await app.listen({ host: '127.0.0.1', port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => runtime.close())
      .finally(() => process.exit(0));
  });
}
