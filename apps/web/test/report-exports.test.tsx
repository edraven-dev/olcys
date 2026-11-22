import { describe, expect, it } from 'vitest';
import { reportVersion } from '../src/features/report/ReportTab.tsx';

describe('report cache key', () => {
  it('reloads the report after each regeneration', () => {
    expect(reportVersion('v1', 0)).not.toBe(reportVersion('v1', 1));
    expect(reportVersion('v1', 1)).not.toBe(reportVersion('v2', 1));
  });
});
