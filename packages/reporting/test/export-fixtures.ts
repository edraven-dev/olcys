import { createHash } from 'node:crypto';
import type { AnalystJudgement } from '@olcys/core';
import type { ReportData } from '../src/index.ts';
import { A, personaData } from './fixtures.ts';

export { A };

/** The persona report with one analyst judgement `same` on the BTC-1 link. */
export function exportData(): ReportData {
  const judgement: AnalystJudgement = {
    id: 'judg-1',
    linkAssessmentId: 'link-btc1',
    judgement: 'same',
    justification: 'Podpis wiadomości zgadza się z adresem; zweryfikowano ręcznie.',
    analyst: 'analityk-testowy',
    at: '2026-11-21T12:00:00.000Z',
  };
  return { ...personaData(), judgements: [judgement] };
}

/** UUIDv5 computed independently of the implementation (SHA-1 over namespace bytes + name). */
export function referenceUuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name)
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
}
