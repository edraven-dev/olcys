import cytoscape from 'cytoscape';
import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  DEFAULT_GRAPH_OPTIONS,
  describeGraph,
  nodeIds,
  sumDecimals,
  type GraphBuild,
  type GraphEdgeData,
} from '../src/features/graph/build-elements.ts';
import { toElements } from '../src/features/graph/graph-style.ts';
import { formatPln, formatProbability } from '../src/lib/format.ts';
import { activity, EXCHANGE, graphInput } from './fixtures/graph.ts';
import { BTC_1, ETH_1, ETH_2, ethWeakLink, thirdPartyLink, tronLink, btcLink } from './fixtures/persona.ts';

const build = (options: Partial<typeof DEFAULT_GRAPH_OPTIONS> = {}): GraphBuild =>
  buildGraph(graphInput, { ...DEFAULT_GRAPH_OPTIONS, ...options });
const node = (b: GraphBuild, id: string) => b.nodes.find((n) => n.id === id);
const edgesOf = (b: GraphBuild, kind: GraphEdgeData['kind']) => b.edges.filter((e) => e.kind === kind);
const addr = (chain: 'bitcoin' | 'evm:1' | 'tron', address: string) => nodeIds.address({ chain, address });
const TRON_2 = thirdPartyLink.address.address;

describe('buildGraph with the persona data', () => {
  const b = build();

  it('has one subject, the three identifiers, the accounts and the addresses', () => {
    expect(b.nodes.filter((n) => n.kind === 'subject')).toHaveLength(1);
    expect(b.nodes.filter((n) => n.kind === 'identifier').map((n) => n.label)).toEqual([
      'Kacper Fikcyjny',
      'fikcyjny_kacper',
      'kacper@example.invalid',
    ]);
    expect(
      b.nodes
        .filter((n) => n.kind === 'account')
        .map((n) => `${n.sublabel}/${n.label}`)
        .toSorted(),
    ).toEqual(
      [
        'bitcointalk/fikcyjny_kacper',
        'github/fikcyjny-kacper',
        'telegram/kanal_fikcyjny',
        'wykop/fikcyjny_kacper',
        'tablica/fikcyjny_kacper',
      ].toSorted(),
    );
    expect(
      b.nodes
        .filter((n) => n.kind === 'address' && n.address)
        .map((n) => n.address?.address)
        .toSorted(),
    ).toEqual([BTC_1, tronLink.address.address, ETH_2, ETH_1, TRON_2].toSorted());
    expect(b.nodes.filter((n) => n.kind === 'entity').map((n) => n.label)).toEqual([EXCHANGE]);
  });

  it('labels hops with the engine probabilities, tiers and anchors', () => {
    const anchor = edgesOf(b, 'identity_hop').find((e) => e.target === nodeIds.account('acc-btt'));
    expect(anchor?.label).toBe(`P = ${formatProbability(btcLink.paths[0]!.identityHop.probability)} (kotwica)`);
    expect(anchor?.probability).toBe(btcLink.paths[0]!.identityHop.probability);
    const github = edgesOf(b, 'identity_hop').find((e) => e.target === nodeIds.account('acc-gh'));
    expect(github?.label).toBe(`P = ${formatProbability(ethWeakLink.paths[0]!.identityHop.probability)}`);
    const eth2 = edgesOf(b, 'address_hop').find((e) => e.target === addr('evm:1', ETH_2));
    expect(eth2?.source).toBe(nodeIds.account('acc-gh'));
    expect(eth2?.label).toBe(`P = ${formatProbability(ethWeakLink.paths[0]!.addressHop.probability)} · E2`);
    expect(eth2?.linkId).toBe(ethWeakLink.id);
  });

  it('shows third-party and exchange addresses as rejected, never as ownership', () => {
    const third = edgesOf(b, 'third_party');
    expect(third.map((e) => e.target)).toEqual([addr('tron', TRON_2)]);
    expect(node(b, addr('tron', TRON_2))?.rejected).toBe(true);
    const eth1 = node(b, addr('evm:1', ETH_1));
    expect(eth1?.rejected).toBe(true);
    expect(eth1?.ruleId).toBe('A4');
    expect(eth1?.label).toContain('odrzucony');
    const published = edgesOf(b, 'published');
    expect(published.map((e) => e.label)).toEqual(['opublikował · adres powierniczy giełdy']);
    const exclusion = edgesOf(b, 'exclusion');
    expect(exclusion).toHaveLength(1);
    expect(exclusion[0]).toMatchObject({ source: eth1?.id, target: nodeIds.entity(EXCHANGE), label: 'reguła A4' });
    const hopTargets = edgesOf(b, 'address_hop').map((e) => e.target);
    expect(hopTargets).not.toContain(addr('tron', TRON_2));
    expect(hopTargets).not.toContain(addr('evm:1', ETH_1));
  });

  it('reaches the BTC address from the subject in headless Cytoscape', () => {
    const cy = cytoscape({ headless: true, elements: toElements(b) });
    const reachable = cy.$id('subject').successors().nodes();
    expect(reachable.map((n) => n.id())).toContain(addr('bitcoin', BTC_1));
    // The exchange deposit is reached only by the "published" edge.
    const into = cy.$id(addr('evm:1', ETH_1)).incomers('edge');
    expect(into.map((e) => e.data('kind'))).toEqual(['published']);
    cy.destroy();
  });

  it('every edge connects existing nodes', () => {
    const ids = new Set(b.nodes.map((n) => n.id));
    expect(b.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(b.truncated).toBe(false);
    expect(b.total).toBe(b.nodes.length + b.edges.length);
  });
});

describe('filters', () => {
  it('"show rejected" off removes rejected addresses, the entity and their edges', () => {
    const b = build({ showRejected: false });
    for (const id of [addr('evm:1', ETH_1), addr('tron', TRON_2), nodeIds.entity(EXCHANGE)]) {
      expect(node(b, id)).toBeUndefined();
    }
    expect(b.edges.some((e) => ['published', 'third_party', 'exclusion'].includes(e.kind))).toBe(false);
    expect(node(b, addr('bitcoin', BTC_1))).toBeDefined();
  });

  it('a minimum score removes the weaker addresses and accounts that carry no other link', () => {
    const b = build({ minScore: 30 });
    expect(node(b, addr('evm:1', ETH_2))).toBeUndefined();
    expect(node(b, nodeIds.account('acc-gh'))).toBeUndefined();
    expect(node(b, addr('bitcoin', BTC_1))).toBeDefined();
    // The rejected ones carry no score and stay.
    expect(node(b, addr('evm:1', ETH_1))).toBeDefined();
  });

  it('the flow overlay adds the summed PLN amount from the activity data', () => {
    expect(edgesOf(build(), 'flow')).toEqual([]);
    const flows = edgesOf(build({ showFlows: true }), 'flow');
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ source: addr('evm:1', ETH_1), target: nodeIds.entity(EXCHANGE) });
    expect(flows[0]?.label).toBe(formatPln('2000.00'));
    expect(flows[0]?.label).toBe(formatPln(sumDecimals(activity.serviceInteractions.map((s) => s.pln ?? '0'))));
  });

  it('flags a partially valued flow instead of showing a sum that looks complete', () => {
    const [first] = activity.serviceInteractions;
    const partial = { ...activity, serviceInteractions: [{ ...first!, count: 3, priced: 2, pln: '100.00' }] };
    const b = buildGraph({ ...graphInput, activity: [partial] }, { ...DEFAULT_GRAPH_OPTIONS, showFlows: true });
    expect(edgesOf(b, 'flow')[0]?.label).toBe(`${formatPln('100.00')} (wycena niepełna: 2 z 3)`);
    const none = { ...partial, serviceInteractions: [{ ...first!, count: 3, priced: 0, pln: undefined }] };
    const b2 = buildGraph({ ...graphInput, activity: [none] }, { ...DEFAULT_GRAPH_OPTIONS, showFlows: true });
    expect(edgesOf(b2, 'flow')[0]?.label).toBe('3 transakcje');
  });

  it('flows of a hidden address are not drawn', () => {
    const b = build({ showFlows: true, showRejected: false });
    expect(edgesOf(b, 'flow')).toEqual([]);
  });

  it('falls back to the transaction count when a service interaction has no valuation', () => {
    const b = buildGraph(
      {
        ...graphInput,
        activity: [{ ...activity, serviceInteractions: [{ ...activity.serviceInteractions[0]!, pln: undefined }] }],
      },
      { ...DEFAULT_GRAPH_OPTIONS, showFlows: true },
    );
    expect(edgesOf(b, 'flow')[0]?.label).toBe('1 transakcja');
  });
});

const rejectedWith = (relation: typeof btcLink.relation, n: number) => ({
  ...btcLink,
  id: `other-${n}`,
  address: { chain: 'bitcoin' as const, address: `bc1qother${n}` },
  relation,
  score: 0,
  gates: [{ gate: 'relation', passed: false }],
});

describe('other rejected relations', () => {
  it('draws them as their own edge kind with a Polish relation label', () => {
    const input = {
      ...graphInput,
      exclusions: [],
      links: [
        rejectedWith('TX_COUNTERPARTY', 1),
        rejectedWith('CLUSTER_ASSOCIATED', 2),
        rejectedWith('SELF_DECLARED', 3),
      ],
    };
    const b = buildGraph(input, DEFAULT_GRAPH_OPTIONS);
    expect(edgesOf(b, 'published')).toEqual([]);
    expect(edgesOf(b, 'other_relation').map((e) => e.label)).toEqual([
      'kontrahent transakcji',
      'powiązany klastrem — heurystyka',
      'relacja bez roszczenia własności',
    ]);
    expect(b.nodes.filter((n) => n.rejected)).toHaveLength(3);
  });
});

describe('structure edge cases', () => {
  it('links an identifier straight to the address when the path has no account', () => {
    const direct = { ...btcLink, id: 'direct', paths: [{ ...btcLink.paths[0]!, accountId: undefined }] };
    const b = buildGraph({ ...graphInput, links: [direct], exclusions: [] }, DEFAULT_GRAPH_OPTIONS);
    const edge = edgesOf(b, 'address_hop')[0];
    expect(edge?.source).toBe(nodeIds.identifier('ident-nick'));
    expect(edge?.target).toBe(addr('bitcoin', BTC_1));
  });

  it('keeps an excluded address without a link and without a known entity', () => {
    const bare = { ...graphInput.exclusions[0]!, evidence: {} };
    const b = buildGraph({ ...graphInput, links: [], exclusions: [bare] }, DEFAULT_GRAPH_OPTIONS);
    expect(node(b, addr('evm:1', ETH_1))?.rejected).toBe(true);
    expect(b.nodes.some((n) => n.kind === 'entity')).toBe(false);
  });

  it('sums decimals exactly', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals(['1520.37', '479.63'])).toBe('2000.00');
    expect(sumDecimals(['5', '-7.5'])).toBe('-2.5');
    expect(sumDecimals([])).toBe('0');
  });
});

const sized = (nodes: number, edges: number) =>
  describeGraph({
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}`, kind: 'account' as const, label: 'x' })),
    edges: Array.from({ length: edges }, (_, i) => ({
      id: `e${i}`,
      source: 'a',
      target: 'b',
      kind: 'flow' as const,
      label: 'x',
    })),
  });

describe('plural description', () => {
  it('uses the Polish plural forms', () => {
    expect(sized(1, 1)).toContain('1 węzeł i 1 krawędź');
    expect(sized(2, 2)).toContain('2 węzły i 2 krawędzie');
    expect(sized(5, 5)).toContain('5 węzłów i 5 krawędzi');
    expect(sized(14, 15)).toContain('14 węzłów i 15 krawędzi');
    expect(sized(22, 23)).toContain('22 węzły i 23 krawędzie');
    expect(sized(12, 12)).toContain('12 węzłów i 12 krawędzi');
    expect(sized(2, 0)).toBe('Graf powiązań: 2 węzły i 0 krawędzi. Pełna treść jest dostępna w widoku listy.');
  });
});
