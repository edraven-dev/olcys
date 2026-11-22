/**
 * Address types in chapter 4 (rejected attributions): the Polish type label with what it rests on, next to the rule
 * decision it explains — also for a candidate whose EVM network was not attributed. Synthetic addresses.
 */
import type { AddressTypeClassification, ExclusionDecision } from '@olcys/core';
import { createMemoryRepositories } from '@olcys/db';
import { describe, expect, it } from 'vitest';
import { buildReportData, renderReport, type ReportData } from '../src/index.ts';
import { A, personaData } from './fixtures.ts';

/** The rejection card of decision `id`. */
function card(html: string, id: string): string {
  const rejected = sectionOf(html, 'odrzucone');
  const from = rejected.slice(rejected.indexOf(`id="odrzucony-${id}"`));
  return from.slice(0, from.indexOf('</article>'));
}

const key = (c: AddressTypeClassification): string => `${c.address.chain}:${c.address.address}`;

function sectionOf(html: string, id: string): string {
  const start = html.indexOf(`<section class="report-section" id="${id}">`);
  const next = html.indexOf('<section class="report-section"', start + 1);
  return html.slice(start, next === -1 ? html.indexOf('<footer', start) : next);
}

const SAFE = `0x${'5a'.repeat(20)}`;
const DELEGATED = `0x${'7a'.repeat(20)}`;
const SWEEPER = '0x2b5712612396864a3b6db2fd30c5a0169ec1e34b';
const WALLET = `0x${'3c'.repeat(20)}`;
const IMPLEMENTATION = `0x${'c0'.repeat(20)}`;

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
  // CONTRACT-1 as the extractor reported it: without an attributed EVM network; the engine records where it was fetched.
  const a2 = d.exclusions.find((e) => e.ruleId === 'A2');
  if (a2) {
    a2.address = { chain: 'evm:unknown', address: A.CONTRACT1 };
    a2.resolved = { chain: 'evm:1', address: A.CONTRACT1 };
  }
  d.exclusions.push(
    decision({ id: 'ex-safe', address: { chain: 'evm:1', address: SAFE }, ruleId: 'A2' }),
    // An unregistered delegation, kept by A3.
    decision({ id: 'ex-wallet', address: { chain: 'evm:1', address: WALLET }, ruleId: 'A3', evidence: {} }),
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
    // The same address on another network sorts before evm:1; the decision was not made on it.
    { address: { chain: 'evm:10', address: A.CONTRACT1 }, type: 'eoa', codeSize: 0, fetchIds: ['f-op'] },
    {
      address: { chain: 'evm:1', address: WALLET },
      type: 'delegated_eoa',
      codePrefix: '0xef0100',
      codeSize: 23,
      delegate: IMPLEMENTATION,
      fetchIds: ['f10'],
    },
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
  it('names the type behind A2 on the rejection card: the network the decision was fetched on, not list order', () => {
    const own = card(renderReport(data()), 'ex-3');
    expect(own).toContain('Typ adresu: <strong>kontrakt</strong>');
    expect(own).toContain('kod pod adresem: 0x60806040… (48 B)');
    expect(own).not.toContain('konto zewnętrzne (EOA)');
  });

  it('without a recorded network takes the classification the decision cites, otherwise shows none', () => {
    const cited = data();
    const a2 = cited.exclusions.find((e) => e.id === 'ex-3');
    if (a2) {
      delete a2.resolved;
      a2.evidence = { fetchIds: ['f3'] };
    }
    expect(card(renderReport(cited), 'ex-3')).toContain('Typ adresu: <strong>kontrakt</strong>');
    if (a2) a2.evidence = {};
    expect(card(renderReport(cited), 'ex-3')).not.toContain('Typ adresu');
  });

  it('lists checked personal smart accounts and flagged sweeper delegations with their type and evidence', () => {
    const rejected = sectionOf(renderReport(data()), 'odrzucone');
    const entry = (needle: string) => {
      const at = rejected.indexOf(needle);
      return rejected.slice(rejected.lastIndexOf('<li>', at), rejected.indexOf('</li>', at));
    };
    // A kept Safe shows why it stayed attributable: its singleton and its code.
    const safe = entry(SAFE);
    expect(safe).toContain('typ adresu: konto Safe');
    expect(safe).toContain('kontrakt bazowy Safe (singleton w slocie 0)');
    expect(safe).toContain('0x41675c099f32341bf84bfc5382af534df5c7461a');
    expect(safe).toContain('kod pod adresem: 0x608060… (171 B)');
    // A kept delegation without a registry entry still names its delegate.
    const wallet = entry(WALLET);
    expect(wallet).toContain('typ adresu: EOA z delegacją EIP-7702');
    expect(wallet).toContain(`delegat EIP-7702: <code class="addr">${IMPLEMENTATION}</code>`);
    const swept = entry(DELEGATED);
    expect(swept).toContain('typ adresu: EOA z delegacją EIP-7702');
    expect(swept).toContain('SWEEPER-1 (SYNTHETIC)');
    expect(swept).toContain('znany „sweeper”');
  });

  it('says when a probe failed: the type rests on the remaining checks', () => {
    expect(card(renderReport(data()), 'ex-1')).toContain('Sprawdzenie „konto Safe (slot 0)” nie powiodło się');
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
    expect(built.addressTypes?.map(key)).toEqual(types.map(key).toSorted());
    expect((await buildReportData(repos, collected.id)).addressTypes).toHaveLength(types.length);
  });
});
