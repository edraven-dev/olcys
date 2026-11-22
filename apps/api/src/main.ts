/**
 * @olcys/api — HTTP API for the analyst console. Binds to 127.0.0.1; the web app reaches it through the Vite dev
 * proxy (`/api`). The MVP runs the analysis pipeline and the schedules of periodic re-runs in this process.
 */
import { createRuntime, createScheduler, schedulingSettings } from '@olcys/worker';
import { buildApp } from './app.ts';
import { defaultStages } from './stages.ts';

const runtime = await createRuntime({ stages: defaultStages });
const settings = schedulingSettings(process.env);
const app = buildApp({
  ...runtime,
  httpLog: true,
  schedule: {
    minIntervalMinutes: settings.minIntervalMinutes,
    analyst: process.env['OLCYS_ANALYST_NAME']?.trim() || 'analyst',
  },
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
