/**
 * `pnpm --filter @olcys/worker tsa:flush`: retries the queued and failed RFC 3161 requests once (live mode only;
 * idempotent). Prints a one-line JSON report; exits non-zero when a request was rejected.
 */
import { createRuntime } from './runtime.ts';

const runtime = await createRuntime();
try {
  const report = await runtime.timestamper.flush();
  console.info(JSON.stringify(report));
  if (!report.ran) {
    console.info(
      report.reason === 'disabled'
        ? 'TSA_ENABLED=false: nothing to do'
        : 'OLCYS_MODE is not live: the TSA is only contacted in live mode',
    );
  }
  if (report.rejected > 0) process.exitCode = 1;
} finally {
  await runtime.close();
}
