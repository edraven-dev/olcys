import type { Capture, CustodyEvent } from '@olcys/core';

/** The `collected` custody event of a capture (the repository assigns nothing; the caller adds the id). */
export function custodyCollected(capture: Capture, actor: string): Omit<CustodyEvent, 'id'> {
  return {
    at: capture.collectedAt,
    actor,
    action: 'collected',
    runId: capture.runId,
    subject: { type: 'capture', id: capture.id },
    detail: {
      manifestSha256: capture.manifestSha256,
      sourceId: capture.sourceId,
      status: capture.status,
      clockSynced: capture.clockSynced,
    },
  };
}
