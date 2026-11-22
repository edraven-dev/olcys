/**
 * Co-spend clusters in chapter 5: a short Polish subsection that presents them as a heuristic, with the merge evidence
 * and the skipped CoinJoin transactions; singletons stay a one-line note; no cluster, no subsection. Synthetic data.
 */
import type { AddressCluster, AddressLabel } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { buildReportData, renderReport, type ReportData } from '../src/index.ts';
import { buildView } from '../src/view.ts';
import { personaData } from './fixtures.ts';

const cluster = (id: string, extra: Partial<AddressCluster> = {}): AddressCluster => ({
  id,
  runId: 'run-0001',
  chain: 'bitcoin',
  heuristic: 'co_spend',
  algorithmVersion: 'cospend.v1',
  seeds: ['bc1q-seed'],
  members: ['bc1q-seed'],
  size: 1,
  mergeEvidence: [],
  skipped: [],
  serviceMembers: [],
  flags: { serviceMerge: false, capped: false },
  ...extra,
});

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section class="report-section" id="${id}">`);
  const next = html.indexOf('<section class="report-section"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('<footer', start) : next);
}

const withClusters = (clusters: AddressCluster[]): ReportData => ({ ...personaData(), clusters });

describe('clusters in the report', () => {
  it('presents a merged cluster as a heuristic with merge evidence and skipped transactions', () => {
    const html = sectionOf(
      renderReport(
        withClusters([
          cluster('c_0123456789abcdef', {
            seeds: ['bc1q-seed'],
            members: ['bc1q-partner', 'bc1q-seed'],
            size: 2,
            mergeEvidence: [{ address: 'bc1q-partner', txid: 'tx-merge-1' }],
            skipped: [{ txid: 'tx-coinjoin-1', reason: 'coinjoin_wasabi' }],
            serviceMembers: [{ address: 'bc1q-hot', labelId: 'label-1' }],
            previousSize: 1,
            flags: { serviceMerge: true, capped: false, growthFactor: 2 },
          }),
        ]),
      ),
      'aktywnosc',
    );
    expect(html).toContain('Klastry adresów Bitcoin (heurystyka wspólnego wydatkowania)');
    expect(html).toContain('To wynik heurystyczny, a nie fakt');
    expect(html).toContain('Klaster c_0123456789abcdef');
    expect(html).toContain('tx-merge-1');
    expect(html).toContain('tx-coinjoin-1');
    expect(html).toContain('CoinJoin typu Wasabi');
    expect(html).toContain('bc1q-hot');
    expect(html).toContain('Rozmiar: 2 adresy');
    expect(html).toContain('wzrost ×2');
    // Statement class: a computed result, never a fact.
    expect(html).toMatch(/data-statement="obliczenia"[^]*Klaster|Klaster[^]*data-statement="obliczenia"/);
  });

  it('keeps clusters of one address to a single note', () => {
    const html = sectionOf(renderReport(withClusters([cluster('c_aaaaaaaaaaaaaaaa')])), 'aktywnosc');
    expect(html).toContain('Klastry adresów Bitcoin');
    expect(html).not.toContain('Klaster c_aaaaaaaaaaaaaaaa');
    expect(html).toContain('Pozostałe adresy (1) nie weszły w żaden klaster');
  });

  it('shows a singleton that skipped a CoinJoin transaction', () => {
    const html = sectionOf(
      renderReport(
        withClusters([cluster('c_bbbbbbbbbbbbbbbb', { skipped: [{ txid: 'tx-w', reason: 'coinjoin_whirlpool' }] })]),
      ),
      'aktywnosc',
    );
    expect(html).toContain('Klaster c_bbbbbbbbbbbbbbbb');
    expect(html).toContain('CoinJoin typu Whirlpool');
  });

  it('has no subsection without clusters', () => {
    expect(renderReport(personaData())).not.toContain('Klastry adresów Bitcoin');
  });

  it('never counts a cluster-associated lead as an ownership link', () => {
    const data = personaData();
    const first = data.links[0];
    if (!first) throw new Error('fixture has no link');
    const lead = { ...first, id: 'link-cluster', relation: 'CLUSTER_ASSOCIATED' as const, score: 0 };
    const view = buildView({ ...data, links: [...data.links, lead] });
    expect(view.linked.map((l) => l.id)).not.toContain('link-cluster');
    expect(view.linked).toHaveLength(buildView(data).linked.length);
  });

  it('says how many skipped transactions are not shown', () => {
    const skipped = Array.from({ length: 35 }, (_, i) => ({ txid: `tx-skip-${i}`, reason: 'equal_outputs' as const }));
    const html = sectionOf(renderReport(withClusters([cluster('c_cccccccccccccccc', { skipped })])), 'aktywnosc');
    expect(html).toContain('tx-skip-29');
    expect(html).not.toContain('tx-skip-30');
    expect(html).toContain('Pokazano 30 z 35 pozycji');
  });

  it('keeps the label of a service named only by a cluster', async () => {
    const repos = createMemoryRepositories();
    const fixture = personaData();
    const kase = await repos.cases.create(
      {
        title: fixture.case.title,
        purpose: fixture.case.purpose,
        legalBasis: fixture.case.legalBasis,
        identifiers: [{ kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true }],
        scope: fixture.case.scope,
      },
      'analityk-testowy',
    );
    const run = { ...fixture.run, id: 'run-0001', caseId: kase.id, status: 'succeeded' as const };
    delete run.previousRunId;
    await repos.runs.create(run);
    const label: AddressLabel = {
      id: 'label-svc',
      address: { chain: 'bitcoin', address: 'bc1q-service-only-in-cluster' },
      entity: 'Giełda Testowa (SYNTHETIC)',
      category: 'exchange',
      attributes: {},
      provenance: {
        datasetId: 'test-por',
        url: 'https://example.invalid',
        license: 'CC0-1.0',
        lastmod: '2026-01-01T00:00:00Z',
        retrievedAt: '2026-01-01T00:00:00Z',
        sourceType: 'por_file',
        deciding: true,
        synthetic: true,
      },
      confidence: 95,
    };
    await repos.labels.upsert([label]);
    await repos.clusters!.add(run.id, [
      cluster('c_dddddddddddddddd', {
        runId: run.id,
        serviceMembers: [{ address: label.address.address, labelId: label.id }],
        flags: { serviceMerge: true, capped: false },
      }),
    ]);
    expect((await buildReportData(repos, run.id)).labels.map((l) => l.id)).toContain(label.id);
  });
});
