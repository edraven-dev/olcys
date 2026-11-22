/**
 * CI gate: the extractor on the full synthetic corpus must meet the acceptance thresholds (bench/thresholds.ts).
 * A failure lists the gate, its value and the counts behind it; see `pnpm --filter @olcys/address-extractor bench`
 * for the full report with the failing documents.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderReportMarkdown } from '../bench/report.ts';
import { runBenchmark } from '../bench/run.ts';
import { countLeaks, countLeaksIn } from '../bench/secrets.ts';
import { VARIANT_KINDS, ZERO_CANDIDATE_KINDS } from '../bench/thresholds.ts';
import { parseDenyList } from '../src/deny-list.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const denyList = parseDenyList(readFileSync(join(repoRoot, 'config/rules/deny-list.v1.yaml'), 'utf8'));

describe('extraction benchmark on the synthetic corpus', () => {
  it('meets every threshold, redacts every secret and never leaks one', async () => {
    const { report, secretFragments } = await runBenchmark({ denyList });

    const failed = report.gates
      .filter((g) => !g.passed)
      .map((g) => `${g.id}: ${g.value} (required ${g.comparison} ${g.threshold}) ${g.detail ?? ''}`);
    expect(failed).toEqual([]);

    // Secrets: ≥ 200 of 4 kinds, all redacted, no fragment in results, logs or the rendered report.
    expect(report.secrets.total).toBeGreaterThanOrEqual(200);
    expect(Object.keys(report.secrets.byKind)).toHaveLength(4);
    expect(report.secrets.recall).toBe(1);
    expect(report.secrets.leaks).toBe(0);
    const markdown = renderReportMarkdown(report);
    expect(countLeaksIn(report, secretFragments) + countLeaks(markdown, secretFragments)).toBe(0);

    // Hard negatives: no candidate from hashes, CIDs or token strings; BIP-350 wrong-variant vectors rejected.
    expect(ZERO_CANDIDATE_KINDS.filter((kind) => report.negatives[kind]?.accepted !== 0)).toEqual([]);
    for (const kind of VARIANT_KINDS) {
      const entry = report.negatives[kind];
      expect(entry?.total).toBeGreaterThan(0);
      expect(entry?.rejectedAsExpected).toBe(entry?.total);
    }

    // SpiderFoot baseline: accepts bech32 corruptions and 0x + 64 prefixes, so its precision is lower.
    expect(report.negatives['tx_hash']?.spiderfootAccepted).toBeGreaterThan(0);
    expect(report.negatives['corrupt1']?.spiderfootAccepted).toBeGreaterThan(0);
    expect(report.hardNegativeDocuments.spiderfoot.precision).toBeLessThan(report.hardNegativeDocuments.ours.precision);
    expect(markdown).toContain('## Porównanie z SpiderFoot');

    // Report contents: per chain / obfuscation / channel with intervals, attribution, roles, throughput.
    for (const chain of ['bitcoin', 'evm', 'tron']) expect(report.byChain[chain]?.recallCi95).toHaveLength(2);
    expect(report.byObfuscation['zero_width']).not.toBe('not_run');
    expect(report.byObfuscation['qr']).toBe('not_run');
    expect(report.byChannel['ocr']).toBe('not_run');
    expect(report.baselines.iocsearcher).toBe('not_run');
    expect(report.attribution['evm']?.total).toBeGreaterThan(0);
    expect(report.attribution['p2sh_3']?.total).toBeGreaterThan(0);
    expect(report.roleMacroF1).toBeGreaterThan(0);
    expect(report.throughput.docsPerSecond).toBeGreaterThan(0);
  }, 60_000);
});
