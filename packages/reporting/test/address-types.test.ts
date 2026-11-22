/**
 * Address types in chapter 4 (rejected attributions): the Polish type label with what it rests on, next to the rule
 * decision it explains — also for a candidate whose EVM network was not attributed. Synthetic addresses.
 */
import type { AddressTypeClassification, ExclusionDecision } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { buildReportData, renderReport, type ReportData } from '../src/index.ts';
import { A, personaData } from './fixtures.ts';

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section class="report-section" id="${id}">`);
  const next = html.indexOf('<section class="report-section"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('<footer', start) : next);
}

const SAFE = `0x${'5a'.repeat(20)}`;
const DELEGATED = `0x${'7a'.repeat(20)}`;
const SWEEPER = '0x2b5712612396864a3b6db2fd30c5a0169ec1e34b';

const decision = (over: Partial<ExclusionDecision> & Pick<ExclusionDecision, 'id' | 'address' | 'ruleId'>) =>
  ({
    runId: 'run-0002',
    outcome: 'kept',
    reason: `${over.ruleId}: test`,
    evidence: {},
    rulesVersion: 'exclusion.v1',
    ...over,
  }) as ExclusionDecision;

function data(): ReportData {
  const d = personaData();
  // CONTRACT-1 as the extractor reported it: without an attributed EVM network.
  const a2 = d.exclusions.find((e) => e.ruleId === 'A2');
  if (a2) a2.address = { chain: 'evm:unknown', address: A.CONTRACT1 };
  d.exclusions.push(
    decision({ id: 'ex-safe', address: { chain: 'evm:1', address: SAFE }, ruleId: 'A2' }),
    decision({
      id: 'ex-sweeper',
      address: { chain: 'evm:1', address: DELEGATED },
      ruleId: 'A3',
      outcome: 'flagged',
      evidence: {
        delegate: SWEEPER,
        delegateInfo: { kind: 'sweeper', name: 'SWEEPER-1 (SYNTHETIC)', source: 'synthetic demo entry' },
      },
    }),
  );
  const types: AddressTypeClassification[] = [
    {
      address: { chain: 'evm:1', address: A.CONTRACT1 },
      type: 'contract',
      codePrefix: '0x60806040',
      codeSize: 48,
      fetchIds: ['f1', 'f2', 'f3', 'f4', 'f5'],
    },
    {
      address: { chain: 'evm:1', address: SAFE },
      type: 'safe',
      codePrefix: '0x608060',
      codeSize: 171,
      safeMasterCopy: '0x41675c099f32341bf84bfc5382af534df5c7461a',
      fetchIds: ['f6', 'f7'],
    },
    {
      address: { chain: 'evm:1', address: DELEGATED },
      type: 'delegated_eoa',
      codePrefix: '0xef0100',
      codeSize: 23,
      delegate: SWEEPER,
      fetchIds: ['f8'],
    },
    {
      address: { chain: 'evm:1', address: A.ETH1 },
      type: 'unknown',
      codePrefix: '0x60806040',
      codeSize: 48,
      failedProbe: { probe: 'safe', message: 'etherscan-v2: rate_limited: HTTP 429' },
      fetchIds: ['f9'],
    },
  ];
  d.addressTypes = types;
  return d;
}

describe('address types in the report', () => {
  it('names the type behind A2 on the rejection card, matched across an unattributed EVM network', () => {
    const rejected = sectionOf(renderReport(data()), 'odrzucone');
    const card = rejected.slice(rejected.indexOf('id="odrzucony-ex-3"'));
    expect(card.slice(0, card.indexOf('</article>'))).toContain('Typ adresu: <strong>kontrakt</strong>');
    expect(card).toContain('kod pod adresem: 0x60806040… (48 B)');
  });

  it('lists checked personal smart accounts and flagged sweeper delegations with their type', () => {
    const rejected = sectionOf(renderReport(data()), 'odrzucone');
    expect(rejected).toContain('typ adresu: konto Safe');
    expect(rejected).toContain('typ adresu: EOA z delegacją EIP-7702');
    expect(rejected).toContain('SWEEPER-1 (SYNTHETIC)');
    expect(rejected).toContain('znany „sweeper”');
  });

  it('says when a probe failed: the type rests on the remaining checks', () => {
    const rejected = sectionOf(renderReport(data()), 'odrzucone');
    const card = rejected.slice(rejected.indexOf('id="odrzucony-ex-1"'));
    expect(card.slice(0, card.indexOf('</article>'))).toContain('Sprawdzenie „konto Safe (slot 0)” nie powiodło się');
  });

  it('renders as before when the store keeps no address types', () => {
    const plain = personaData();
    expect(renderReport(plain)).not.toContain('Typ adresu');
  });

  it('loads the address types of the evidence run from the store, ordered by address', async () => {
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
    const collected = { ...fixture.run, id: 'run-0001', caseId: kase.id, status: 'succeeded' as const };
    delete collected.previousRunId;
    const rescore = { ...fixture.run, caseId: kase.id, trigger: 'rescore' as const, rescoreOfRunId: collected.id };
    await repos.runs.create(collected);
    await repos.runs.create(rescore);
    const types = data().addressTypes ?? [];
    await repos.addressTypes!.add(collected.id, types);
    const built = await buildReportData(repos, rescore.id, { evidenceRunId: collected.id });
    expect(built.addressTypes?.map((c) => c.address.address)).toEqual(types.map((c) => c.address.address).toSorted());
    expect((await buildReportData(repos, collected.id)).addressTypes).toHaveLength(types.length);
  });
});
