/**
 * @olcys/api — HTTP API for the analyst console. Binds to 127.0.0.1; the web app reaches it through the Vite dev
 * proxy (`/api`). The MVP runs the analysis pipeline and the schedules of periodic re-runs in this process.
 */
import { createRuntime, createScheduler, schedulingSettings } from '@olcys/worker';
import { analystName } from './analyst-routes.ts';
import { buildApp } from './app.ts';
import { listFromEnv } from './guard.ts';
import { defaultStages, reportRenderer } from './stages.ts';

const runtime = await createRuntime({ stages: defaultStages });
const settings = schedulingSettings(process.env);
const app = buildApp({
  ...runtime,
  httpLog: true,
  hsts: process.env['OLCYS_HSTS'] === '1',
  // Loopback hosts are always allowed; OLCYS_API_ALLOWED_HOSTS adds more (comma-separated).
  guard: { allowedHosts: listFromEnv(process.env['OLCYS_API_ALLOWED_HOSTS']), webPort: process.env['WEB_PORT'] },
  // One analyst identity for cases, schedule changes, judgements and overrides.
  analyst: analystName(process.env),
  schedule: { minIntervalMinutes: settings.minIntervalMinutes },
  renderReport: reportRenderer(runtime),
});
const port = Number(process.env['API_PORT'] ?? 4000);
await app.listen({ host: '127.0.0.1', port });
// Periodic re-runs are evaluated in this process too, every OLCYS_SCHEDULER_INTERVAL_SECONDS.
const scheduler = createScheduler({ runtime, settings });
await scheduler.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void scheduler
      .stop()
      .then(() => app.close())
      .then(() => runtime.close())
      .finally(() => process.exit(0));
  });
}
