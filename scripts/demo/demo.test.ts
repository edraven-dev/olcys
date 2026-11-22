import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { compareRuns, formatMismatches, type RunResults } from './compare.ts';
import { loadExpectations, type Expectations } from './expectations.ts';
import { assertLoopbackUrl, NotLoopbackError } from './local-http.ts';
import { runDemo } from './run.ts';
import { summarise } from './summary.ts';

const ref = (address: string) => ({ chain: 'x', address });

/** Results that match the manifest exactly, built from the manifest itself. */
function perfect(e: Expectations): { v1: RunResults; v2: RunResults } {
  const v1: RunResults = {
    runId: 'run-1',
    status: 'succeeded',
    links: e.v1.links.map((l) => ({
      address: ref(l.display),
      score: l.score,
      relation: 'OWNERSHIP',
      band: 'BARDZO_WYSOKIE',
    })),
    exclusions: e.v1.rejected
      .filter((r) => r.rule !== 'A8')
      .map((r) => ({ address: ref(r.display), ruleId: r.rule, reason: `${r.rule}: x` })),
    extractions: [
      {
        rejected: e.v1.rejected
          .filter((r) => r.rule === 'A8')
          .map((r) => ({ raw: r.display, reason: 'documentation_example: test vector' })),
      },
    ],
    cashOuts: e.v1.cashOut.map((c) => ({ address: ref(c.display), ruleId: c.rule, amount: '1', asset: 'ETH' })),
    changes: [],
    reportHtml: `<html>${e.addressOf('BTC-1').display}</html>`,
  };
  const v2: RunResults = {
    runId: 'run-2',
    status: 'succeeded',
    links: e.v2.links.map((l) => ({ address: ref(l.display), score: l.score, relation: 'OWNERSHIP' })),
    exclusions: [],
    extractions: [],
    cashOuts: [],
    changes: e.v2.changes.map((c) => ({
      kind: c.kind,
      key: { property: c.property },
      before: c.from.display,
      after: c.to.display,
    })),
    reportHtml: `<html>${e.addressOf('BTC-2').display}</html>`,
  };
  return { v1, v2 };
}

describe('manifest and comparison', () => {
  it('resolves the manifest slots from the persona manifest', async () => {
    const e = await loadExpectations();
    expect(e.v1.links.map((l) => [l.slot, l.score])).toEqual([
      ['BTC-1', 99],
      ['TRON-1', 77],
      ['ETH-2', 24],
    ]);
    expect(e.v2.changes[0]?.to.slot).toBe('BTC-2');
    expect(e.v2.changes[0]?.to.display).toMatch(/^bc1q/);
  });

  it('accepts matching results', async () => {
    const e = await loadExpectations();
    const { v1, v2 } = perfect(e);
    const outcome = compareRuns(e, v1, v2);
    expect(outcome.mismatches).toEqual([]);
    expect(outcome.checks).toBeGreaterThan(15);
  });

  it('reports a wrong score, a missing rule, a missing change and a missing report address', async () => {
    const e = await loadExpectations();
    const { v1, v2 } = perfect(e);
    v1.links[0]!.score = 50;
    v1.exclusions = v1.exclusions.filter((d) => d.ruleId !== 'A2');
    v1.cashOuts = v1.cashOuts.filter((c) => c.ruleId !== 'B5');
    v2.changes = [];
    v2.reportHtml = '<html></html>';
    const { mismatches } = compareRuns(e, v1, v2);
    expect(mismatches.map((m) => m.check)).toEqual([
      'uruchomienie 1: wynik powiązania BTC-1',
      'uruchomienie 1: CONTRACT-1 odrzucony regułą A2',
      'uruchomienie 1: przesłanka B5 dla TRON-1',
      'uruchomienie 2: zmiana profile.bitcoin_address',
      'uruchomienie 2: raport zawiera adres BTC-2',
    ]);
    expect(mismatches[0]).toMatchObject({ expected: '99', actual: '50' });
    expect(formatMismatches(mismatches)).toContain('oczekiwano: 99');
  });

  it('flags a positive score for a rejected address and a failed run', async () => {
    const e = await loadExpectations();
    const { v1, v2 } = perfect(e);
    v1.links.push({ address: ref(e.addressOf('ETH-1').display), score: 40, relation: 'OWNERSHIP' });
    v2.status = 'failed';
    const checks = compareRuns(e, v1, v2).mismatches.map((m) => m.check);
    expect(checks).toContain('uruchomienie 1: ETH-1 bez dodatniego wyniku');
    expect(checks).toContain('uruchomienie 2: stan końcowy');
  });
});

describe('summary', () => {
  it('prints the links, rejections, cash-out indicators, the alert and the URLs in Polish', async () => {
    const e = await loadExpectations();
    const { v1, v2 } = perfect(e);
    const text = summarise({
      caseId: 'case-1',
      apiUrl: 'http://127.0.0.1:4000',
      webUrl: 'http://127.0.0.1:5173',
      v1,
      v2,
      expect: e,
      outcome: compareRuns(e, v1, v2),
    }).join('\n');
    expect(text).toContain('Sprawa: case-1');
    expect(text).toContain('BTC-1 (');
    expect(text).toContain('adres depozytowy giełdy');
    expect(text).toContain('smart kontrakt');
    expect(text).toContain('B5');
    expect(text).toContain('adres portfela w profilu zmienił się: BTC-1');
    expect(text).toContain('→ BTC-2');
    expect(text).toContain('http://127.0.0.1:5173/sprawy/case-1');
    expect(text).toContain('http://127.0.0.1:4000/api/runs/run-1/report');
    expect(text).toContain('Samokontrola:');
  });
});

describe('loopback guard and health hints', () => {
  const servers: Server[] = [];
  afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it('refuses anything but loopback URLs', () => {
    expect(assertLoopbackUrl('http://127.0.0.1:4000/')).toBe('http://127.0.0.1:4000');
    expect(() => assertLoopbackUrl('http://example.org')).toThrow(NotLoopbackError);
    expect(() => assertLoopbackUrl('ftp://127.0.0.1')).toThrow(NotLoopbackError);
    expect(() => assertLoopbackUrl('nonsense')).toThrow(NotLoopbackError);
  });

  it('refuses a non-loopback API before sending anything', async () => {
    await expect(
      runDemo({ apiUrl: 'http://192.0.2.1:4000', fixtureUrl: 'http://127.0.0.1:4100', log() {} }),
    ).rejects.toThrow(NotLoopbackError);
  });

  it('gives a hint when the API is down and when the fixture site refuses the variant switch', async () => {
    const quiet = createServer((req, res) => {
      if (req.url === '/api/health' || req.url === '/healthz') return void res.end('ok');
      res.statusCode = 405;
      res.end();
    });
    servers.push(quiet);
    await new Promise<void>((r) => quiet.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(quiet.address() as AddressInfo).port}`;
    await expect(runDemo({ apiUrl: url, fixtureUrl: url, log() {} })).rejects.toThrow('FIXTURE_ALLOW_VARIANT_SWITCH=1');

    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const dead = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((r) => closed.close(r));
    await expect(runDemo({ apiUrl: dead, fixtureUrl: url, log() {} })).rejects.toThrow('pnpm dev:deps');
  });
});
