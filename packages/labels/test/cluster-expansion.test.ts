import { newId } from '@olcys/core';
import type { AddressCluster } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { evaluateClusterCollapse, planClusterExpansion, toClusterSummary } from '../src/index.ts';
import { addr, rules } from './cospend-helpers.ts';

const cluster = (members: string[], extra: Partial<AddressCluster> = {}): AddressCluster => ({
  id: 'c_0123456789abcdef',
  runId: newId(),
  chain: 'bitcoin',
  heuristic: 'co_spend',
  algorithmVersion: 'cospend.v1',
  seeds: [members[0] ?? ''],
  members,
  size: members.length,
  mergeEvidence: members.slice(1).map((address) => ({ address, txid: 'tx' })),
  skipped: [],
  serviceMembers: [],
  flags: { serviceMerge: false, capped: false },
  ...extra,
});

describe('planClusterExpansion', () => {
  const members = Array.from({ length: 400 }, (_, i) => addr(`m${String(i).padStart(3, '0')}`));
  const plan = (opts: Partial<Parameters<typeof planClusterExpansion>[2]> = {}, fetched = new Set<string>()) =>
    planClusterExpansion([cluster(members)], fetched, {
      maxDepth: 2,
      maxAddresses: 200,
      exclude: () => false,
      ...opts,
    });

  it('AC10: returns at most maxAddresses, in merge order, without seeds and fetched addresses', () => {
    const out = plan({}, new Set([members[1] ?? '']));
    expect(out).toHaveLength(200);
    expect(out[0]).toBe(members[2]);
    expect(out).not.toContain(members[0]);
    expect(out).not.toContain(members[1]);
    expect(plan({ maxAddresses: 3 })).toEqual(members.slice(1, 4));
  });

  it('AC10: never returns excluded addresses (labelled services, deny list) or goes beyond the depth', () => {
    const blocked = new Set(members.slice(1, 50));
    const out = plan({ exclude: (a) => blocked.has(a) });
    expect(out.some((a) => blocked.has(a))).toBe(false);
    expect(out).toHaveLength(200);
    expect(plan({ round: 3 })).toEqual([]);
    expect(plan({ round: 2 })).toHaveLength(200);
  });

  it('returns nothing for a singleton cluster', () => {
    expect(
      planClusterExpansion([cluster([addr('A')])], new Set(), { maxDepth: 2, maxAddresses: 200, exclude: () => false }),
    ).toEqual([]);
  });
});

describe('A7 from a cluster summary', () => {
  const deps = { rules, runId: newId() };
  it('AC6: flags a seed spent together with a labelled service', () => {
    const c = cluster([addr('A')], {
      serviceMembers: [{ address: addr('HOT-BTC-1'), labelId: newId() }],
      flags: { serviceMerge: true, capped: false },
    });
    const decisions = evaluateClusterCollapse(toClusterSummary(c), deps);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      ruleId: 'A7',
      outcome: 'flagged',
      address: { chain: 'bitcoin', address: addr('A') },
      evidence: { cluster: { id: c.id, serviceMembers: [addr('HOT-BTC-1')] } },
    });
    expect(decisions[0]?.evidence.labelIds).toEqual(c.serviceMembers.map((m) => m.labelId));
    expect(decisions[0]?.reason).toMatch(/^A7: .*heuristic/);
  });

  it('AC8: flags growth by a factor of 100 or more, and a capped cluster', () => {
    const grown = cluster([addr('A')], {
      previousSize: 40,
      size: 5000,
      flags: { serviceMerge: false, capped: false, growthFactor: 125 },
    });
    expect(evaluateClusterCollapse(toClusterSummary(grown), deps)).toHaveLength(1);
    const mild = cluster([addr('A')], {
      previousSize: 40,
      size: 80,
      flags: { serviceMerge: false, capped: false, growthFactor: 2 },
    });
    expect(evaluateClusterCollapse(toClusterSummary(mild), deps)).toEqual([]);
    const capped = cluster([addr('A')], { flags: { serviceMerge: false, capped: true } });
    expect(evaluateClusterCollapse(toClusterSummary(capped), deps)[0]?.evidence.cluster?.capped).toBe(true);
  });

  it('does not flag an ordinary cluster', () => {
    expect(evaluateClusterCollapse(toClusterSummary(cluster([addr('A'), addr('B')])), deps)).toEqual([]);
  });
});
