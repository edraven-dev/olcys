/**
 * Pure element builder for the link-analysis graph: subject → identifiers → accounts → addresses → entities.
 * No DOM, no Cytoscape: the view turns the result into Cytoscape elements. Everything is derived from the run's
 * existing lists (links, exclusions, accounts, activity), nothing is invented.
 */
import type {
  ActivityIndicators,
  AddressRef,
  DecimalString,
  EntityCategory,
  EvidenceTier,
  ExclusionRuleId,
  Id,
  Identifier,
  OnlineAccount,
} from '@olcys/core';
import { pl } from '../../i18n/pl.ts';
import { lookup, plural, t } from '../../i18n/t.ts';
import { chainName } from '../../lib/chains.ts';
import {
  isRejectedLink,
  isRejectingDecision,
  keyOf,
  type ExclusionView,
  type LinkPathView,
  type LinkView,
} from '../../lib/domain.ts';
import { formatPln, formatProbability, middleTruncate } from '../../lib/format.ts';

export const GRAPH_NODE_KINDS = ['subject', 'identifier', 'account', 'address', 'entity'] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_EDGE_KINDS = [
  'input',
  'identity_hop',
  'address_hop',
  'published',
  'third_party',
  'other_relation',
  'exclusion',
  'flow',
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphNodeData {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  /** Address rejected as the person's holding (exclusion rule, exchange deposit, third-party attribution). */
  rejected?: boolean;
  ruleId?: ExclusionRuleId;
  /** Best Confidence Score of the links that end in this address. */
  score?: number;
  linkIds?: Id[];
  /** Full address (address nodes) — labels are truncated. */
  address?: AddressRef;
  category?: EntityCategory;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  probability?: number;
  tier?: EvidenceTier;
  label: string;
  linkId?: Id;
}

export interface GraphOptions {
  showRejected: boolean;
  showFlows: boolean;
  minScore: number;
  maxElements: number;
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  showRejected: true,
  showFlows: false,
  minScore: 0,
  maxElements: 500,
};

export interface GraphBuild {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  /** Elements (nodes + edges) before truncation. */
  total: number;
  truncated: boolean;
}

export interface GraphInput {
  caseTitle: string;
  identifiers: readonly Identifier[];
  accounts: readonly OnlineAccount[];
  links: readonly LinkView[];
  exclusions: readonly ExclusionView[];
  activity?: readonly ActivityIndicators[];
}

export const SUBJECT_ID = 'subject';
export const nodeIds = {
  identifier: (id: string) => `identifier:${id}`,
  account: (id: string) => `account:${id}`,
  address: (ref: AddressRef) => `address:${keyOf(ref)}`,
  entity: (name: string) => `entity:${name}`,
};

// Truncation priority: lower tiers are kept first.
const TIER_SUBJECT = 0;
const TIER_IDENTIFIER = 1;
const TIER_MAIN = 2;
const TIER_REJECTED = 3;
const TIER_FLOW = 4;

interface Draft {
  nodes: Map<string, { data: GraphNodeData; tier: number }>;
  edges: Map<string, { data: GraphEdgeData; tier: number }>;
  /** Edges that must be kept together (a link's identifier → account → address path), in insertion order. */
  bundles: Map<string, { tier: number; edges: string[] }>;
}

function addNode(draft: Draft, data: GraphNodeData, tier: number): GraphNodeData {
  const existing = draft.nodes.get(data.id);
  if (existing) {
    existing.tier = Math.min(existing.tier, tier);
    return existing.data;
  }
  draft.nodes.set(data.id, { data, tier });
  return data;
}

function addEdge(draft: Draft, data: GraphEdgeData, tier: number, bundle = `edge:${data.id}`): void {
  const group = draft.bundles.get(bundle) ?? { tier, edges: [] };
  if (!group.edges.includes(data.id)) group.edges.push(data.id);
  draft.bundles.set(bundle, group);
  const existing = draft.edges.get(data.id);
  if (existing) {
    existing.tier = Math.min(existing.tier, tier);
    if ((data.probability ?? 0) > (existing.data.probability ?? 0)) existing.data = data;
    return;
  }
  draft.edges.set(data.id, { data, tier });
}

const hopLabel = (p: number) => formatProbability(p);

/** Exact sum of decimal strings (BigInt on a common scale) — never through floats. */
export function sumDecimals(values: readonly DecimalString[]): DecimalString {
  const scale = Math.max(0, ...values.map((v) => v.split('.')[1]?.length ?? 0));
  let total = 0n;
  for (const value of values) {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
    const scaled = BigInt(whole + fraction.padEnd(scale, '0'));
    total += negative ? -scaled : scaled;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

function entityOf(decision: ExclusionView): { name: string; category?: EntityCategory } | undefined {
  const { evidence } = decision;
  if (evidence.forwardsTo) return { name: evidence.forwardsTo.entity, category: evidence.forwardsTo.category };
  if (evidence.denyList) return { name: evidence.denyList.name };
  if (evidence.delegateInfo) return { name: evidence.delegateInfo.name };
  return undefined;
}

function addressNodeData(ref: AddressRef): GraphNodeData {
  return {
    id: nodeIds.address(ref),
    kind: 'address',
    label: middleTruncate(ref.address),
    sublabel: chainName(ref.chain),
    address: ref,
  };
}

function identifierNodeData(identifier: Identifier): GraphNodeData {
  const kind = lookup(pl.identifierKinds, identifier.kind) ?? identifier.kind;
  return {
    id: nodeIds.identifier(identifier.id),
    kind: 'identifier',
    label: middleTruncate(identifier.value, 18, 8),
    sublabel: identifier.platform ? `${kind}, ${identifier.platform}` : kind,
  };
}

/** Builds the graph for the given filters; `truncated` is set when more than `maxElements` elements exist. */
export function buildGraph(input: GraphInput, options: GraphOptions): GraphBuild {
  const draft: Draft = { nodes: new Map(), edges: new Map(), bundles: new Map() };
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const rejectingDecisions = input.exclusions.filter(isRejectingDecision);
  const excludedKeys = new Set(rejectingDecisions.map((d) => keyOf(d.address)));

  addNode(draft, { id: SUBJECT_ID, kind: 'subject', label: input.caseTitle }, TIER_SUBJECT);
  for (const identifier of input.identifiers) {
    const node = identifierNodeData(identifier);
    addNode(draft, node, TIER_IDENTIFIER);
    addEdge(
      draft,
      {
        id: `input:${identifier.id}`,
        source: SUBJECT_ID,
        target: node.id,
        kind: 'input',
        label: pl.graph.legend.input,
      },
      TIER_IDENTIFIER,
    );
  }
  const identifierIds = new Set(input.identifiers.map((i) => i.id));

  // Addresses rejected as holdings: every link to them is rejected (or an exclusion rule took them out).
  const keysWithMainLink = new Set(
    input.links.filter((l) => !isRejectedLink(l, excludedKeys)).map((l) => keyOf(l.address)),
  );
  const addressLinkIds = new Map<string, Id[]>();
  const addressScore = new Map<string, number>();

  for (const link of input.links) {
    const rejected = isRejectedLink(link, excludedKeys);
    if (rejected && !options.showRejected) continue;
    if (!rejected && link.score < options.minScore) continue;
    if (!identifierIds.has(link.identityId)) continue;
    const key = keyOf(link.address);
    const tier = rejected ? TIER_REJECTED : TIER_MAIN;
    const addressNode = addNode(draft, addressNodeData(link.address), tier);
    addressLinkIds.set(key, [...(addressLinkIds.get(key) ?? []), link.id]);
    addressScore.set(key, Math.max(addressScore.get(key) ?? 0, link.score));

    const identifierNode = nodeIds.identifier(link.identityId);
    const paths: LinkPathView[] = link.paths.length > 0 ? link.paths : [];
    const kind = rejected ? rejectedKind(link, excludedKeys) : 'address_hop';
    if (paths.length === 0) {
      // No account in the path (a crypto-address input, or a third-party attribution without an account).
      addEdge(draft, linkEdge(kind, identifierNode, addressNode.id, link, undefined), tier, link.id);
      continue;
    }
    for (const [index, path] of paths.entries()) {
      // One bundle per path: a long link is shown with as many complete paths as fit.
      const bundle = `${link.id}#${index}`;
      const account = path.accountId ? accounts.get(path.accountId) : undefined;
      if (path.accountId === undefined || !account) {
        addEdge(draft, linkEdge(kind, identifierNode, addressNode.id, link, path), tier, bundle);
        continue;
      }
      const accountNode = addNode(
        draft,
        { id: nodeIds.account(account.id), kind: 'account', label: account.handle, sublabel: account.platform },
        tier,
      );
      const p = path.identityHop.probability;
      const anchor =
        path.anchor ??
        (path.identityHop.contributions.length === 0 &&
          input.identifiers.some((i) => i.id === link.identityId && i.isAnchor));
      addEdge(
        draft,
        {
          id: `identity_hop:${identifierNode}>${accountNode.id}`,
          source: identifierNode,
          target: accountNode.id,
          kind: 'identity_hop',
          probability: p,
          label: t(anchor ? pl.graph.edgeLabel.anchor : pl.graph.edgeLabel.identityHop, { p: hopLabel(p) }),
        },
        tier,
        bundle,
      );
      addEdge(draft, linkEdge(kind, accountNode.id, addressNode.id, link, path), tier, bundle);
    }
  }

  for (const [key, ids] of addressLinkIds) {
    const node = draft.nodes.get(`address:${key}`)?.data;
    if (!node) continue;
    node.linkIds = ids;
    node.score = addressScore.get(key) ?? 0;
    if (!keysWithMainLink.has(key)) markRejected(node);
  }

  if (options.showRejected) {
    for (const decision of rejectingDecisions) {
      const node = addNode(draft, addressNodeData(decision.address), TIER_REJECTED);
      markRejected(node);
      node.ruleId = decision.ruleId;
      const entity = entityOf(decision);
      if (!entity) continue;
      const entityNode = addNode(
        draft,
        {
          id: nodeIds.entity(entity.name),
          kind: 'entity',
          label: entity.name,
          ...(entity.category ? { category: entity.category } : {}),
        },
        TIER_REJECTED,
      );
      addEdge(
        draft,
        {
          id: `exclusion:${decision.id}`,
          source: node.id,
          target: entityNode.id,
          kind: 'exclusion',
          label: t(pl.graph.edgeLabel.exclusion, { rule: decision.ruleId }),
        },
        TIER_REJECTED,
      );
    }
  }

  if (options.showFlows) addFlows(draft, input.activity ?? []);

  return truncate(draft, options.maxElements);
}

function markRejected(node: GraphNodeData): void {
  node.rejected = true;
  const base = node.label.replace(` (${pl.graph.rejectedSuffix})`, '');
  node.label = `${base} (${pl.graph.rejectedSuffix})`;
}

function rejectedKind(link: LinkView, excludedKeys: ReadonlySet<string>): GraphEdgeKind {
  if (link.relation === 'THIRD_PARTY_ATTRIBUTION') return 'third_party';
  // An address the subject's account published but that is no holding (exchange deposit, KYC lead).
  if (link.relation === 'CUSTODIAL_EXCHANGE' || excludedKeys.has(keyOf(link.address))) return 'published';
  // Any other rejected relation (transaction counterparty, cluster heuristic, failed gate): no claim by the subject.
  return 'other_relation';
}

function linkEdge(
  kind: GraphEdgeKind,
  source: string,
  target: string,
  link: LinkView,
  path: LinkPathView | undefined,
): GraphEdgeData {
  const relation = lookup(pl.relations, link.relation) ?? link.relation;
  const probability = kind === 'address_hop' ? (path?.addressHop.probability ?? link.probability) : undefined;
  const label =
    kind === 'address_hop'
      ? t(pl.graph.edgeLabel.addressHop, { p: hopLabel(probability ?? 0), tier: link.tier })
      : kind === 'third_party'
        ? pl.graph.edgeLabel.thirdParty
        : kind === 'other_relation'
          ? (lookup(pl.graph.otherRelation, link.relation) ?? pl.graph.otherRelationFallback)
          : t(pl.graph.edgeLabel.published, { relation });
  return {
    id: `${kind}:${link.id}:${source}>${target}`,
    source,
    target,
    kind,
    ...(probability === undefined ? {} : { probability }),
    tier: link.tier,
    label,
    linkId: link.id,
  };
}

/** Flow overlay: address ⇄ service per direction, summed per pair; PLN when every interaction has a valuation. */
function addFlows(draft: Draft, activity: readonly ActivityIndicators[]): void {
  const groups = new Map<string, { from: string; to: string; count: number; priced: number; pln: DecimalString[] }>();
  for (const indicators of activity) {
    const addressId = nodeIds.address(indicators.address);
    if (!draft.nodes.has(addressId)) continue;
    for (const interaction of indicators.serviceInteractions) {
      const entityId = nodeIds.entity(interaction.entity);
      const [from, to] = interaction.direction === 'out' ? [addressId, entityId] : [entityId, addressId];
      const id = `flow:${from}>${to}`;
      const group = groups.get(id) ?? { from, to, count: 0, priced: 0, pln: [] };
      group.count += interaction.count;
      if (interaction.pln !== undefined) {
        group.pln.push(interaction.pln);
        // Older data has no `priced`: a present `pln` then covers every interaction.
        group.priced += interaction.priced ?? interaction.count;
      }
      groups.set(id, group);
      if (!draft.nodes.has(entityId)) {
        addNode(
          draft,
          { id: entityId, kind: 'entity', label: interaction.entity, category: interaction.category },
          TIER_FLOW,
        );
      }
    }
  }
  for (const [id, group] of groups) {
    addEdge(
      draft,
      {
        id,
        source: group.from,
        target: group.to,
        kind: 'flow',
        label: t(pl.graph.edgeLabel.flow, { amount: flowAmount(group) }),
      },
      TIER_FLOW,
    );
  }
}

/** PLN sum when every interaction is valued; a partial sum is flagged with how many were; no valuation: the count. */
function flowAmount(group: { count: number; priced: number; pln: readonly DecimalString[] }): string {
  if (group.pln.length === 0 || group.priced === 0) return plural(group.count, pl.graph.flowCount);
  const sum = formatPln(sumDecimals(group.pln));
  if (group.priced >= group.count) return sum;
  return `${sum} ${t(pl.graph.partialValuation, { priced: group.priced, total: group.count })}`;
}

/**
 * Keeps the lowest tiers first (subject, identifiers, main links, rejected, flows). Within a tier whole bundles (a
 * link's identifier → account → address path with its edges) are kept before anything else, so a truncated graph never
 * holds addresses cut off from the subject; an edge always has both of its ends.
 */
function truncate(draft: Draft, maxElements: number): GraphBuild {
  const total = draft.nodes.size + draft.edges.size;
  const nodes: GraphNodeData[] = [];
  const edges: GraphEdgeData[] = [];
  const keptNodes = new Set<string>();
  const keptEdges = new Set<string>();
  let budget = Math.max(0, maxElements);

  const connected = new Set([...draft.edges.values()].flatMap((e) => [e.data.source, e.data.target]));
  const takeNode = (id: string) => {
    const node = draft.nodes.get(id);
    if (!node || keptNodes.has(id)) return;
    nodes.push(node.data);
    keptNodes.add(id);
    budget -= 1;
  };
  const takeBundle = (bundle: { tier: number; edges: string[] }) => {
    const pending = bundle.edges.map((id) => draft.edges.get(id)).filter((e) => e && !keptEdges.has(e.data.id));
    const ends = new Set(pending.flatMap((e) => (e ? [e.data.source, e.data.target] : [])));
    // Subject and identifiers are only ever added by their own tiers.
    const missing = [...ends].filter((id) => !keptNodes.has(id));
    if (bundle.tier > TIER_IDENTIFIER && missing.some((id) => (draft.nodes.get(id)?.tier ?? 0) <= TIER_IDENTIFIER))
      return;
    if (missing.length + pending.length > budget) return;
    for (const id of missing) takeNode(id);
    for (const edge of pending) {
      if (!edge) continue;
      edges.push(edge.data);
      keptEdges.add(edge.data.id);
      budget -= 1;
    }
  };

  for (let tier = TIER_SUBJECT; tier <= TIER_FLOW; tier += 1) {
    if (tier === TIER_SUBJECT && budget > 0) takeNode(SUBJECT_ID);
    for (const bundle of draft.bundles.values()) if (bundle.tier === tier) takeBundle(bundle);
    // Nodes that have no edge at all (e.g. an excluded address with no known entity); never a cut-off end of an edge.
    for (const [id, node] of draft.nodes) if (node.tier === tier && budget > 0 && !connected.has(id)) takeNode(id);
  }
  return { nodes, edges, total, truncated: nodes.length + edges.length < total };
}

/** `Graf powiązań: 14 węzłów i 15 krawędzi. …` — plural-correct description for the graph container. */
export function describeGraph(build: Pick<GraphBuild, 'nodes' | 'edges'>): string {
  return t(pl.graph.ariaDescription, {
    nodes: plural(build.nodes.length, pl.graph.nodes),
    edges: plural(build.edges.length, pl.graph.edges),
  });
}
