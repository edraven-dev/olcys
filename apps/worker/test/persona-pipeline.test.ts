/**
 * The demo scenario end to end on the synthetic persona: the runtime with the real stages (collectors over the egress
 * client and robots.txt, address extraction, scoring) against the in-process fixture site, then a v2 re-run that must
 * report the swapped wallet. In-memory store, no network.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { buildPropertyTimelines, InMemoryBlobStore, latestExtractions, verifyCapture } from '@olcys/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer, type FixtureServer } from '../../fixture-site/src/fixture-server.ts';
import { buildWaybackHistory } from '@olcys/collectors';
import { createRuntime, defaultStages, type Runtime } from '../src/index.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const JUSTIFICATION = 'Sprawa demonstracyjna: dane syntetyczne persony';

let server: FixtureServer;
let runtime: Runtime;
let manifest: {
  addresses: Record<string, { address: string }>;
  expected: { v1: { rejected: { slot: string; rule: string }[]; cashOut: { rule: string; slot: string }[] } };
};
const addressOf = (slot: string): string => manifest.addresses[slot]?.address.toLowerCase() ?? '';
/** Wei as a decimal string of ether (whole units, no trailing zeros). */
const ethOf = (wei: string): string => {
  const whole = BigInt(wei) / 10n ** 18n;
  const frac = (BigInt(wei) % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const slotOf = (address: string): string =>
  Object.entries(manifest.addresses).find(([, a]) => a.address === address)?.[0] ?? '';

beforeAll(async () => {
  manifest = JSON.parse(await readFile(join(REPO, 'fixtures/persona/manifest.json'), 'utf8')) as typeof manifest;
  server = await createFixtureServer({
    root: join(REPO, 'apps/fixture-site/public'),
    variant: 'v1',
    host: '127.0.0.1',
    port: 0,
    allowVariantSwitch: true,
  });
  runtime = await createRuntime({
    env: { OLCYS_MODE: 'offline' },
    repos: createMemoryRepositories(),
    blobs: new InMemoryBlobStore(),
    logger: silent,
    stages: (rt) =>
      defaultStages({
        mode: rt.mode,
        sources: rt.sources,
        env: { OLCYS_FIXTURE_BASE_URL: server.url, FIXTURE_SITE_URL: server.url },
      }),
  });
});
afterAll(async () => {
  await runtime?.idle();
  await runtime?.close();
  await server?.close();
});

describe('demo scenario on the synthetic persona', () => {
  it(
    'collects, extracts, analyses and scores the persona, then detects the swapped wallet on re-run',
    { timeout: 120_000 },
    async () => {
      const kase = await runtime.repos.cases.create(
        {
          title: 'Kacper Fikcyjny (demonstracja)',
          purpose: 'Demonstracja na danych syntetycznych',
          legalBasis: 'demonstracja',
          identifiers: [
            { kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true },
            { kind: 'full_name', value: 'Kacper Fikcyjny', isAnchor: false },
            { kind: 'email', value: 'kacper.fikcyjny@example.org', isAnchor: false },
          ],
          scope: {
            enabledSources: [
              'bitcointalk',
              'wykop',
              'github',
              'telegram_preview',
              // Official Polish registries (GREEN): CEIDG finds the persona's firm by name, its NIP leads to the VAT white list.
              'ceidg',
              'vat_whitelist',
              'krs',
              // GREEN and on by default for new cases: the mock search over the fixture site's sitemap.
              'mock_search',
              'mempool_space',
              'etherscan_v2',
              'trongrid',
              'nbp_api',
              // GREEN: history of the persona's own profile from the (synthetic) Wayback Machine.
              'wayback_cdx',
            ],
            amberJustifications: {
              bitcointalk: JUSTIFICATION,
              wykop: JUSTIFICATION,
              github: JUSTIFICATION,
              telegram_preview: JUSTIFICATION,
              etherscan_v2: JUSTIFICATION,
              trongrid: JUSTIFICATION,
            },
            chains: [],
            maxPivotDepth: 2,
          },
        },
        'test',
      );

      const first = await runtime.startRun(kase.id, {});
      await runtime.idle();
      const run1 = await runtime.repos.runs.get(first.id);
      expect(run1?.status).toBe('succeeded');
      expect(run1?.config.weightsVersion).toBe('weights.v2');

      const links = await runtime.repos.analysis.listLinks(first.id);
      const score = (slot: string) =>
        links.filter((l) => l.address.address.toLowerCase() === addressOf(slot)).map((l) => l.score);
      expect(score('BTC-1')).toContain(99);
      expect(score('TRON-1')).toContain(77);
      expect(score('ETH-2')).toContain(24);

      // Chain analysis: the expected misattributions are rejected and the cash-out indicators recorded.
      const exclusions = await runtime.repos.analysis.listExclusions(first.id);
      const ruleOf = (slot: string) =>
        exclusions.filter((d) => d.address.address.toLowerCase() === addressOf(slot)).map((d) => d.ruleId);
      // A documentation vector (A8) is already rejected by the extractor's deny list, before it becomes a candidate.
      const extracted = await runtime.repos.evidence.listExtractionResults(first.id);
      const rejectedByExtractor = new Set(
        extracted
          .flatMap((r) => r.rejected)
          .filter((r) => r.reason.startsWith('documentation_example'))
          .map((r) => r.raw.toLowerCase()),
      );
      for (const { slot, rule } of manifest.expected.v1.rejected.filter(
        (r) => !(r.rule === 'A8' && rejectedByExtractor.has(addressOf(r.slot))),
      ))
        expect([slot, ruleOf(slot)]).toEqual([slot, expect.arrayContaining([rule])]);
      // Co-spend clustering: the persona's own Bitcoin transactions never spend two addresses together (change
      // outputs are not merged), so the heuristic leaves BTC-1 a cluster of one and flags nothing.
      const clusters = (await runtime.repos.clusters?.list(first.id)) ?? [];
      const btc1 = clusters.find((c) => c.seeds.includes(addressOf('BTC-1')));
      expect(btc1).toMatchObject({
        members: [addressOf('BTC-1')],
        size: 1,
        mergeEvidence: [],
        skipped: [],
        serviceMembers: [],
        heuristic: 'co_spend',
        flags: { serviceMerge: false, capped: false },
      });
      expect(exclusions.filter((d) => d.ruleId === 'A7')).toEqual([]);
      expect(links.filter((l) => l.relation === 'CLUSTER_ASSOCIATED')).toEqual([]);
      const cashOuts = await runtime.repos.analysis.listCashOuts(first.id);
      const cashOutOf = (slot: string) =>
        cashOuts.filter((e) => e.address.address.toLowerCase() === addressOf(slot)).map((e) => e.ruleId);
      for (const { slot, rule } of manifest.expected.v1.cashOut)
        expect([slot, cashOutOf(slot)]).toEqual([slot, expect.arrayContaining([rule])]);
      // PLN values come from the synthetic NBP Table A the fixture site serves (the table number says SYN), with the
      // NBP table reference on every valuation; the run is not partial for lack of rates.
      const valued = cashOuts.filter((e) => e.valuation);
      expect(valued.length).toBeGreaterThan(0);
      for (const event of valued)
        expect(event.valuation?.nbp).toMatchObject({ table: expect.stringMatching(/^SYN\d+\/A\/NBP\/\d{4}$/) });
      // The rate came from the fixture site, so the valuation says it is synthetic.
      expect(valued.every((e) => e.valuation?.nbp.synthetic === true)).toBe(true);
      expect(valued.every((e) => e.valuation?.pln && e.valuation.nbp.currency === 'USD')).toBe(true);
      expect(run1?.progress['partialCodes']).toBeUndefined();

      // Fund flows (computed): derived from the fixture site's own data, never from invented numbers.
      const flows = (await runtime.repos.analysis.listFlows?.(first.id)) ?? [];
      const flowsOf = (slot: string, sign: 1 | -1) =>
        flows.filter(
          (e) => (sign > 0 ? e.from : e.to).address.toLowerCase() === addressOf(slot) && Math.sign(e.hop) === sign,
        );
      // ETH-1: what the fixture's tx list says went in and out (1.5 ETH in, the sweep to the labelled hot wallet out).
      const txlist = JSON.parse(
        await readFile(
          join(REPO, 'apps/fixture-site/public/shared/chain/etherscan', addressOf('ETH-1'), 'txlist.json'),
          'utf8',
        ),
      ) as { result: { hash: string; from: string; to: string; value: string }[] };
      const expectedOut = txlist.result.filter((t) => t.from === addressOf('ETH-1'));
      const expectedIn = txlist.result.filter((t) => t.to === addressOf('ETH-1'));
      expect(flowsOf('ETH-1', 1).map((e) => [e.hop, e.to.address.toLowerCase(), e.amount, e.txHash])).toEqual(
        expectedOut.map((t) => [1, t.to, ethOf(t.value), t.hash]),
      );
      // The hot wallet is a labelled service: the path ends there, nothing is followed past it.
      expect(flows.filter((e) => e.from.address.toLowerCase() === addressOf('HOT-1'))).toEqual([]);
      expect(flowsOf('ETH-1', -1).map((e) => [e.hop, e.from.address.toLowerCase(), e.amount, e.txHash])).toEqual(
        expectedIn.map((t) => [-1, t.from, ethOf(t.value), t.hash]),
      );
      // TRON-1 (manifest: 3000 USDT to the deposit address, which sweeps to the labelled hot wallet; six round P2P
      // transfers; 5000 USDT from a DEX pair).
      const tronDown = flowsOf('TRON-1', 1);
      const deposit = tronDown.find((e) => e.to.address === manifest.addresses['TRON-DEP']?.address);
      expect(deposit).toMatchObject({ hop: 1, amount: '3000', asset: 'USDT' });
      expect(flows.find((e) => e.from.address === manifest.addresses['TRON-DEP']?.address)).toMatchObject({
        hop: 2,
        amount: '3000',
        to: { address: manifest.addresses['TRON-HOT']?.address },
      });
      expect(flows.filter((e) => e.from.address === manifest.addresses['TRON-HOT']?.address)).toEqual([]);
      expect(tronDown.filter((e) => slotOf(e.to.address).startsWith('TRON-P2P'))).toHaveLength(6);
      expect(
        flowsOf('TRON-1', -1).find((e) => e.from.address === manifest.addresses['TRON-DEX']?.address),
      ).toMatchObject({
        hop: -1,
        amount: '5000',
      });
      // Every leg is valued (synthetic NBP), computed once per transfer and hop.
      expect(flows.every((e) => e.valuation?.nbp.synthetic === true)).toBe(true);
      expect(
        new Set(flows.map((e) => `${e.txHash}|${e.index ?? ''}|${e.from.address}|${e.to.address}|${e.hop}`)).size,
      ).toBe(flows.length);
      // Per analysed address: a timeline (chronological) and an acyclic layered Sankey.
      const views = (await runtime.repos.analysis.listFlowViews?.(first.id)) ?? [];
      const tronView = views.find((v) => v.address.address === manifest.addresses['TRON-1']?.address);
      expect(tronView?.timeline.map((e) => e.at)).toEqual(tronView?.timeline.map((e) => e.at).toSorted());
      expect(tronView?.timeline.some((e) => e.kind === 'cash_out' && e.ruleId === 'B1')).toBe(true);
      const layers = new Map((tronView?.sankey.nodes ?? []).map((nd) => [nd.id, nd.layer]));
      expect(tronView?.sankey.links.length).toBeGreaterThan(0);
      for (const link of tronView?.sankey.links ?? [])
        expect((layers.get(link.target) ?? NaN) - (layers.get(link.source) ?? NaN)).toBe(1);
      expect(views.every((v) => !v.truncated)).toBe(true);
      // Address types are stored with the run: CONTRACT-1 stays a plain contract (every probe negative), the persona's
      // accounts stay EOAs, Bitcoin is classified locally.
      const types = await runtime.repos.addressTypes!.list(first.id);
      const typeOf = (slot: string) => types.find((c) => c.address.address.toLowerCase() === addressOf(slot));
      expect(typeOf('CONTRACT-1')).toMatchObject({ type: 'contract', address: { chain: 'evm:1' } });
      expect(typeOf('CONTRACT-1')?.fetchIds).toHaveLength(5);
      for (const slot of ['ETH-1', 'ETH-2', 'TRON-1']) expect([slot, typeOf(slot)?.type]).toEqual([slot, 'eoa']);
      expect(typeOf('BTC-1')).toMatchObject({ type: 'utxo_script', scriptType: 'p2wpkh', fetchIds: [] });
      expect(types.filter((c) => c.failedProbe)).toEqual([]);
      // Exchange deposits and contracts are never attributed: score 0.
      expect(score('ETH-1').every((s) => s === 0)).toBe(true);
      expect(score('CONTRACT-1').every((s) => s === 0)).toBe(true);
      expect((await runtime.repos.analysis.listActivity(first.id)).length).toBeGreaterThan(0);

      expect([...rejectedByExtractor]).toContain(addressOf('D2'));
      // The Polish report of the run is stored and self-contained.
      const report = await runtime.repos.analysis.latestReport(first.id, 'html');
      expect(report?.mediaType).toContain('text/html');
      const html = new TextDecoder().decode(await runtime.blobs.get(report!.blobSha256));
      expect(html).toContain('lang="pl"');
      expect(html).toContain(manifest.addresses['BTC-1']!.address);
      // The exchange label that rejected the deposit address is shown with it, the contract with its address type.
      expect(html).toContain('Giełda Testowa (SYNTHETIC)');
      expect(html).toContain('Typ adresu: <strong>kontrakt</strong>');
      // Valuations cite the synthetic NBP table, so they cannot pass for real rates.
      expect(html).toContain('(kurs syntetyczny — dane demonstracyjne)');
      expect(html).toMatch(/tabela SYN\d+\/A\/NBP\/\d{4} z dnia/);
      // The flow chapter carries the second hop (the deposit address's sweep), marked as a computed path.
      expect(html).toContain('Krok przepływu: 2 od analizowanego adresu');

      // Every capture has its manifest blob (verifiable down to the artifacts) and exactly one `collected` custody event.
      const captures = await runtime.repos.evidence.listCaptures(first.id);
      expect(captures.length).toBeGreaterThan(0);
      const custody = await runtime.repos.custody!.listBySubjects(captures.map((c) => c.id));
      for (const capture of captures) {
        // oxlint-disable-next-line no-await-in-loop
        const verification = await verifyCapture(capture.manifestSha256, runtime.blobs);
        expect([capture.url, verification.ok]).toEqual([capture.url, true]);
        expect(custody.filter((e) => e.subject.id === capture.id).map((e) => e.action)).toEqual(['collected']);
      }
      expect(custody).toHaveLength(captures.length);

      // Nothing secret or third-party-only becomes an ownership link with a positive score.
      expect(score('TRON-2').every((s) => s === 0)).toBe(true);
      const egress = await runtime.repos.evidence.listEgressLog(first.id);
      expect(egress.length).toBeGreaterThan(0);
      // Offline nothing leaves the machine: every request sent went to the local fixture host; anything else (e.g. NBP
      // rates without recordings) was refused before sending.
      expect(egress.filter((e) => e.allowed).every((e) => e.host === '127.0.0.1')).toBe(true);
      expect(egress.filter((e) => e.host !== '127.0.0.1').every((e) => !e.allowed)).toBe(true);
      // NBP rates were served by the fixture site, not by the real NBP.
      expect(egress.some((e) => e.sourceId === 'nbp_api' && e.allowed && e.host === '127.0.0.1')).toBe(true);
      // Only sources the case enables were contacted; the labels the chain analysis used are stored for the report.
      const contacted = new Set(egress.filter((e) => e.allowed).map((e) => e.sourceId));
      expect([...contacted].filter((id) => id !== 'fixture_site' && !kase.scope.enabledSources.includes(id))).toEqual(
        [],
      );
      expect(contacted).toContain('trongrid');
      // The search ran for the identifiers without disclosing any of them; the pages it found were collected once,
      // by their own collectors, and its result lists are never read for addresses (no second copy of a mention).
      expect(contacted).toContain('mock_search');
      expect(egress.filter((e) => e.sourceId === 'mock_search').every((e) => !e.containsIdentifier)).toBe(true);
      const searchCaptures = new Set(captures.filter((c) => c.sourceId === 'mock_search').map((c) => c.id));
      expect(searchCaptures.size).toBe(3);
      expect(extracted.filter((r) => searchCaptures.has(r.captureId))).toEqual([]);
      const pageUrls = captures.filter((c) => c.sourceId !== 'mock_search').map((c) => c.url);
      expect(new Set(pageUrls).size).toBe(pageUrls.length);
      // Registry facts: the firm, its NIP, the two bank accounts and the official proof of the white-list check. They
      // carry no address tier (the scores above are unchanged) and nothing in the registries is an address candidate.
      expect(contacted).toContain('ceidg');
      expect(contacted).toContain('vat_whitelist');
      expect(contacted.has('krs')).toBe(false);
      const observations = await runtime.repos.evidence.listObservations(first.id);
      const registryFacts = (property: string) =>
        observations.filter((o) => o.property === property).map((o) => o.value);
      expect(registryFacts('registry.business_name')).toEqual(
        expect.arrayContaining(['Kacper Fikcyjny Usługi Testowe']),
      );
      expect(new Set(registryFacts('registry.nip'))).toEqual(new Set(['0001234562']));
      expect(registryFacts('registry.ceidg.result_count')).toEqual(['1']);
      expect(registryFacts('registry.bank_account').toSorted()).toEqual([
        '25000000000000000000010001',
        '95000000000000000000010002',
      ]);
      expect(registryFacts('registry.vat_request_id')).toHaveLength(1);
      expect(observations.some((o) => /pesel/i.test(o.property) || /pesel/i.test(o.locator))).toBe(false);
      const registryCaptureIds = new Set(
        captures.filter((c) => ['ceidg', 'vat_whitelist'].includes(c.sourceId)).map((c) => c.id),
      );
      expect(registryCaptureIds.size).toBe(2);
      // No registry answer yields an address candidate, and no registry request carries a token.
      expect(extracted.filter((r) => registryCaptureIds.has(r.captureId)).flatMap((r) => r.candidates)).toEqual([]);
      expect(
        egress.filter((e) => ['ceidg', 'vat_whitelist'].includes(e.sourceId)).every((e) => e.containsIdentifier),
      ).toBe(true);
      // Archive history: the older snapshots of the persona's forum profile are collected as archived copies, in the
      // same origin group as the live page; they add history, never score (the scores above are unchanged).
      expect(contacted).toContain('wayback_cdx');
      const archived = captures.filter((c) => c.archive);
      expect(archived.map((c) => c.archive?.snapshotTimestamp)).toEqual(['20240312101500', '20250102030405']);
      expect(
        archived.every((c) => c.archive?.originalUrl === 'https://bitcointalk.org/index.php?action=profile;u=900001'),
      ).toBe(true);
      expect(archived.every((c) => c.sourceId === 'wayback_cdx' && c.status === 'ok')).toBe(true);
      const history = buildWaybackHistory(captures, observations);
      expect(history.map((h) => [h.snapshotTimestamp, h.fetched, h.digestCheck])).toEqual([
        ['20240312101500', true, 'match'],
        ['20250102030405', true, 'match'],
      ]);
      // The older snapshot mentions BTC-1 (extraction finds it); no counted evidence item rests on an archived copy.
      const archivedIds = new Set(archived.map((c) => c.id));
      const archivedCandidates = extracted.filter((r) => archivedIds.has(r.captureId)).flatMap((r) => r.candidates);
      expect(archivedCandidates.map((c) => c.address.address.toLowerCase())).toContain(addressOf('BTC-1'));
      const countedFromArchive = links
        .flatMap((l) => l.paths)
        .flatMap((p) => p.addressHop.contributions)
        .filter((c) => c.counted && c.evidence.captureId && archivedIds.has(c.evidence.captureId));
      expect(countedFromArchive).toEqual([]);
      // Nothing about the archive reaches a third party: only the persona's own forum profile was looked up.
      // The archive's robots.txt is the one request without a subject-derived URL.
      expect(
        egress
          .filter((e) => e.sourceId === 'wayback_cdx' && e.purpose !== 'robots.txt')
          .every((e) => e.containsIdentifier && e.allowed),
      ).toBe(true);
      expect(egress.filter((e) => e.sourceId === 'wayback_cdx' && e.purpose === 'wayback availability')).toHaveLength(
        1,
      );
      const stored = new Set((await runtime.repos.labels.list()).map((l) => l.id));
      const used = exclusions.flatMap((d) => d.evidence.labelIds ?? []);
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter((id) => !stored.has(id))).toEqual([]);

      const switched = await fetch(`${server.url}/__fixture/variant`, { method: 'POST', body: 'v2' });
      expect(switched.status).toBe(204);
      const second = await runtime.startRun(kase.id, {});
      await runtime.idle();
      expect((await runtime.repos.runs.get(second.id))?.previousRunId).toBe(first.id);
      const changes = await runtime.repos.analysis.listChanges(second.id);
      const swap = changes.find((c) => c.kind === 'VALUE_CHANGED' && c.key.property === 'profile.bitcoin_address');
      // The search finds the same pages in the same order in both variants: no change is reported for it.
      expect(changes.filter((c) => c.key.property.startsWith('search.'))).toEqual([]);
      const secondReport = await runtime.repos.analysis.latestReport(second.id, 'html');
      const secondHtml = new TextDecoder().decode(await runtime.blobs.get(secondReport!.blobSha256));
      expect(secondHtml).toContain(manifest.addresses['BTC-2']!.address);
      expect(swap).toMatchObject({
        before: manifest.addresses['BTC-1']?.address,
        after: manifest.addresses['BTC-2']?.address,
      });

      // Page timeline (wallets only) of the persona's forum profile: the live profile is fetched by nickname, but its
      // account is the canonical member page the archive lists, so archived copies and runs form one timeline: 2024
      // without a wallet, 2025 with BTC-1, run 1 with BTC-1, run 2 with the swapped wallet.
      const runIds = [first.id, second.id];
      const load = async <T>(read: (runId: string) => Promise<T[]>): Promise<T[]> =>
        (await Promise.all(runIds.map(read))).flat();
      const timelineCaptures = await load((id) => runtime.repos.evidence.listCaptures(id));
      const timelineObservations = await load((id) => runtime.repos.evidence.listObservations(id));
      const timelines = buildPropertyTimelines(
        {
          captures: timelineCaptures,
          extractions: latestExtractions(
            await Promise.all(runIds.map((id) => runtime.repos.evidence.listExtractionResults(id))),
          ),
          archive: buildWaybackHistory(timelineCaptures, timelineObservations),
          observations: timelineObservations,
          accounts: await load((id) => runtime.repos.evidence.listAccounts(id)),
        },
        { walletOnly: true },
      );
      // The account records the capture that read its profile (not the page that linked to it).
      const bitcointalkAccounts = (await runtime.repos.evidence.listAccounts(first.id)).filter(
        (acct) => acct.platform === 'bitcointalk' && acct.platformUserId === '900001',
      );
      expect(bitcointalkAccounts.length).toBeGreaterThan(0);
      for (const acct of bitcointalkAccounts) {
        const read = timelineCaptures.find((c) => c.id === acct.profileCaptureId);
        expect(read?.technical?.logicalUrl ?? read?.url).toMatch(/action=profile;(u|user)=/);
      }
      const profile = timelines.find((t) => t.key.property === 'page.address');
      expect(profile?.key.locator).toBe('web:https://bitcointalk.org/index.php?action=profile;u=900001#page.address');
      expect(profile?.points.map((p) => [p.provenance, p.archive?.snapshotTimestamp, p.values?.length])).toEqual([
        ['archive', '20240312101500', 0],
        ['archive', '20250102030405', 1],
        ['live', undefined, 1],
        ['live', undefined, 1],
      ]);
      expect(profile?.points.filter((p) => p.provenance === 'live').map((p) => p.runId)).toEqual([first.id, second.id]);
      expect(profile?.changes).toHaveLength(2);
      expect(profile?.changes.every((c) => c.wallet)).toBe(true);
      expect(profile?.changes[0]).toMatchObject({
        before: [],
        lastSeenBefore: { provenance: 'archive', observedAt: '2024-03-12T10:15:00.000Z' },
        firstSeenAfter: { provenance: 'archive', observedAt: '2025-01-02T03:04:05.000Z' },
      });
      expect(profile?.changes[1]).toMatchObject({
        lastSeenBefore: { provenance: 'live', runId: first.id },
        firstSeenAfter: { provenance: 'live', runId: second.id },
      });
      // The live property timeline of the profile's Bitcoin address stays separate.
      const field = timelines.find((t) => t.key.property === 'profile.bitcoin_address');
      expect(field?.points.every((p) => p.provenance === 'live')).toBe(true);
      expect(field?.changes).toEqual([
        expect.objectContaining({
          before: [manifest.addresses['BTC-1']?.address],
          after: [manifest.addresses['BTC-2']?.address],
        }),
      ]);

      // A rescore of the first run re-scores its saved evidence: no fetching, the v1 data, no data changes.
      const rescore = await runtime.startRun(kase.id, { trigger: 'rescore', rescoreOfRunId: first.id });
      await runtime.idle();
      const rescored = await runtime.repos.runs.get(rescore.id);
      expect(rescored).toMatchObject({ status: 'succeeded', previousRunId: first.id, rescoreOfRunId: first.id });
      expect(await runtime.repos.evidence.listCaptures(rescore.id)).toEqual([]);
      expect(await runtime.repos.evidence.listEgressLog(rescore.id)).toEqual([]);
      const rescoredLinks = await runtime.repos.analysis.listLinks(rescore.id);
      const rescoredScore = (slot: string) =>
        rescoredLinks.filter((l) => l.address.address.toLowerCase() === addressOf(slot)).map((l) => l.score);
      expect(rescoredScore('BTC-1')).toContain(99);
      expect(rescoredScore('BTC-2')).toEqual([]);
      expect(await runtime.repos.analysis.listChanges(rescore.id)).toEqual([]);

      // Rescoring a rescore still reads the evidence of the run that collected it.
      const again = await runtime.startRun(kase.id, { trigger: 'rescore', rescoreOfRunId: rescore.id });
      await runtime.idle();
      expect(await runtime.repos.runs.get(again.id)).toMatchObject({
        status: 'succeeded',
        rescoreOfRunId: first.id,
        previousRunId: rescore.id,
      });
      const againLinks = await runtime.repos.analysis.listLinks(again.id);
      expect(
        againLinks.filter((l) => l.address.address.toLowerCase() === addressOf('BTC-1')).map((l) => l.score),
      ).toContain(99);
    },
  );
});
