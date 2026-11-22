import type { OnlineAccount } from '@olcys/core';
import cytoscape from 'cytoscape';
import { describe, expect, it } from 'vitest';
import { toElements } from '../src/features/graph/graph-style.ts';
import { buildGraph, DEFAULT_GRAPH_OPTIONS, type GraphInput } from '../src/features/graph/build-elements.ts';
import { pl } from '../src/i18n/pl.ts';
import { plural, t } from '../src/i18n/t.ts';
import type { LinkView } from '../src/lib/domain.ts';
import { btcLink, identity } from './fixtures/persona.ts';

const MAIN = 50;
const FLOWS = 298;

function generated(): GraphInput {
  const accounts: OnlineAccount[] = [];
  const links: LinkView[] = [];
  for (let i = 0; i < MAIN; i += 1) {
    accounts.push({
      id: `acc-${i}`,
      runId: 'r',
      platform: 'forum',
      handle: `user${i}`,
      profileUrl: `x${i}`,
      discoveredVia: { sourceId: 's', method: 'search' },
    });
    links.push({
      ...btcLink,
      id: `link-${i}`,
      address: { chain: 'bitcoin' as const, address: `bc1qgenerated${String(i).padStart(4, '0')}` },
      paths: [{ ...btcLink.paths[0]!, accountId: `acc-${i}` }],
    });
  }
  const activity = Array.from({ length: MAIN }, (_, i) => ({
    address: links[i]!.address,
    window: {},
    txCount: 1,
    volumeIn: { native: '0' },
    volumeOut: { native: '0' },
    counterpartyCount: 0,
    serviceInteractions: Array.from({ length: FLOWS }, (_unused, j) => j)
      .filter((j) => j % MAIN === i)
      .map((j) => ({ category: 'exchange' as const, entity: `Usługa ${j}`, direction: 'out' as const, count: 1 })),
    swaps: [],
    cashOut: { events: [], score: 0 },
    computedAt: '2026-11-21T00:00:00Z',
    rulesVersion: 'cashout.v1',
  }));
  // One more rejected address without a link brings the total to 800 elements.
  const bare = {
    id: 'x1',
    runId: 'r',
    address: { chain: 'tron' as const, address: 'TGeneratedRejected' },
    ruleId: 'A8' as const,
    outcome: 'excluded' as const,
    reason: 'A8',
    evidence: {},
    rulesVersion: 'v',
  };
  return {
    caseTitle: 'Sprawa',
    identifiers: [identity],
    accounts,
    links,
    exclusions: [bare],
    activity,
  };
}

describe('truncation guard', () => {
  const input = generated();
  const options = { ...DEFAULT_GRAPH_OPTIONS, showFlows: true };
  const full = buildGraph(input, { ...options, maxElements: 10_000 });
  const cut = buildGraph(input, options);

  it('generates 800 elements', () => {
    expect(full.total).toBe(800);
    expect(full.truncated).toBe(false);
  });

  it('keeps at most 500, the subject and every main-table link', () => {
    expect(cut.truncated).toBe(true);
    expect(cut.total).toBe(800);
    expect(cut.nodes.length + cut.edges.length).toBe(500);
    expect(cut.nodes.some((n) => n.kind === 'subject')).toBe(true);
    const kept = new Set(cut.edges.filter((e) => e.kind === 'address_hop').map((e) => e.linkId));
    expect(kept.size).toBe(MAIN);
    const ids = new Set(cut.nodes.map((n) => n.id));
    expect(cut.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  it('drops the lowest-priority elements first (flows before rejected before main)', () => {
    expect(cut.edges.some((e) => e.kind === 'exclusion' || e.kind === 'published')).toBe(false);
    expect(cut.nodes.some((n) => n.rejected)).toBe(true);
    expect(cut.edges.filter((e) => e.kind === 'flow').length).toBeLessThan(FLOWS);
  });

  it('formats the banner text', () => {
    const text = t(pl.graph.truncated, {
      total: plural(cut.total, pl.graph.elements),
      max: 500,
    });
    expect(text).toBe('Graf ma 800 elementów — wyświetlono 500. Zawęź filtry.');
  });
});

describe('truncation keeps complete paths', () => {
  it('keeps every kept address connected to the subject when the main links alone exceed the limit', () => {
    const base = generated();
    const many = 250;
    const accounts = Array.from({ length: many }, (_, i) => ({
      ...base.accounts[0]!,
      id: `many-acc-${i}`,
      handle: `h${i}`,
    }));
    const links = accounts.map((account, i) => ({
      ...btcLink,
      id: `many-link-${i}`,
      address: { chain: 'bitcoin' as const, address: `bc1qmany${String(i).padStart(4, '0')}` },
      paths: [{ ...btcLink.paths[0]!, accountId: account.id }],
    }));
    const b = buildGraph(
      { caseTitle: 'Sprawa', identifiers: [identity], accounts, links, exclusions: [] },
      DEFAULT_GRAPH_OPTIONS,
    );
    expect(b.truncated).toBe(true);
    expect(b.nodes.length + b.edges.length).toBeLessThanOrEqual(500);
    const addresses = b.nodes.filter((n) => n.kind === 'address');
    expect(addresses.length).toBeGreaterThan(100);
    const cy = cytoscape({ headless: true, elements: toElements(b) });
    const reachable = new Set(
      cy
        .$id('subject')
        .successors()
        .nodes()
        .map((n) => n.id()),
    );
    expect(addresses.every((a) => reachable.has(a.id))).toBe(true);
    // No dangling accounts either.
    expect(b.nodes.filter((n) => n.kind === 'account').every((a) => reachable.has(a.id))).toBe(true);
    cy.destroy();
  });
});
