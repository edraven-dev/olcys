/**
 * Misattribution rules of `config/rules/exclusion.v1.yaml`. Rules RECLASSIFY instead of discarding: a labelled hot
 * wallet is excluded with its label provenance; an address forwarding deposits to a labelled exchange hot wallet
 * becomes `CUSTODIAL_EXCHANGE` and emits a B1 cash-out seed. An exchange address is never attributed to the person,
 * but the interaction stays recorded. Implemented: A1 (labelled service), A2 (deployed contract code; personal smart
 * accounts kept), A3 (EIP-7702 delegated account: kept, a known sweeper delegate flagged), A4 (exchange deposit
 * address), A8 (deny list). A2/A3 read the address type from the classifier (`classifyAddress`).
 */
import type {
  AddressLabel,
  AddressRef,
  AddressTypeClassification,
  EntityCategory,
  ExclusionDecision,
  ExclusionRuleId,
  ForwardingLeg,
  Id,
  LabelLookup,
  NormalizedTransfer,
} from '@olcys/core';
import { chainFamily, findForwardingPairs, forwardingParamsFor, newId } from '@olcys/core';
import type { DenyList, ExclusionRulesConfig } from './config.ts';
import { canonicalAddress } from './lookup.ts';
import { findDelegate, type DelegateInfo } from './registries.ts';

/** Categories that never decide A1: they describe a person's own account or a risk, not a service. */
const NOT_A_SERVICE: ReadonlySet<EntityCategory> = new Set<EntityCategory>([
  'personal_smart_account',
  'scam',
  'sanctioned_entity',
]);
export interface AddressFacts {
  /** The candidate as extracted (may be `evm:unknown`). */
  address: AddressRef;
  /** The address type (`classifyAddress`) of the address the chain data was fetched on. */
  classification?: AddressTypeClassification;
  /**
   * The concrete address the chain data was fetched on, for an `evm:unknown` candidate (the chain fetch's explicit
   * resolution). Without it an `evm:unknown` candidate gets no transfer-based rule (A4).
   */
  resolved?: AddressRef;
  /** Transfers of the address; only those on the address's (resolved) chain are used. */
  transfers: readonly NormalizedTransfer[];
  /** The address was published by an account of the case (not a third party): a deposit address is a KYC lead. */
  published: boolean;
  truncated?: boolean;
}

export interface ExclusionDeps {
  labels: LabelLookup;
  rules: ExclusionRulesConfig;
  denyList: DenyList;
  runId: Id;
  /** EIP-7702 delegate registry (`loadDelegateRegistry`): A3 names known delegates and flags known sweepers. */
  delegates?: ReadonlyMap<string, DelegateInfo>;
}

const sameAddress = (chain: string, a: string, b: string): boolean =>
  chain.startsWith('evm:') ? a.toLowerCase() === b.toLowerCase() : a === b;

function decision(
  deps: ExclusionDeps,
  address: AddressRef,
  ruleId: ExclusionRuleId,
  fields: Pick<ExclusionDecision, 'outcome' | 'reason' | 'evidence'> & Partial<ExclusionDecision>,
): ExclusionDecision {
  return { id: newId(), runId: deps.runId, address, ruleId, rulesVersion: deps.rules.version, ...fields };
}

function isDecidingService(label: AddressLabel, trustOrder: readonly string[]): boolean {
  return (
    label.provenance.deciding === true &&
    label.provenance.sourceType !== undefined &&
    trustOrder.includes(label.provenance.sourceType) &&
    !NOT_A_SERVICE.has(label.category)
  );
}

/** A8 and A1 only: cheap checks before any chain data is fetched (excluded addresses need no transfer history). */
export async function prescreenExclusions(address: AddressRef, deps: ExclusionDeps): Promise<ExclusionDecision[]> {
  const out: ExclusionDecision[] = [];
  const deny = deps.denyList.match(address);
  if (deny) {
    out.push(
      decision(deps, address, 'A8', {
        outcome: 'excluded',
        reason: `A8: ${deny.kind.replace('_', ' ')} on the deny list (${deny.name})`,
        evidence: { denyList: { kind: deny.kind, name: deny.name, source: deny.source } },
      }),
    );
  }
  // A former exchange address stays an exchange address: no point-in-time filter here.
  const labels = await deps.labels.labelsFor(address);
  const deciding = labels.filter((l) => isDecidingService(l, deps.rules.a1.trustOrder));
  const top = deciding[0];
  if (top) {
    const others = labels.filter((l) => !deciding.includes(l));
    out.push(
      decision(deps, address, 'A1', {
        outcome: 'excluded',
        reason: `A1: labelled ${top.category} "${top.entity}" in dataset ${top.provenance.datasetId}${
          top.provenance.version ? ` ${top.provenance.version}` : ''
        } (${top.provenance.sourceType})`,
        evidence: { labelIds: [...deciding, ...others].map((l) => l.id) },
      }),
    );
  }
  return out;
}

/** Native symbol or token contract: only legs of the same asset are paired. */
const keyOf = (t: NormalizedTransfer): string => t.asset.contract ?? t.asset.symbol;

const leg = (t: NormalizedTransfer): ForwardingLeg => ({
  txHash: t.txHash,
  amount: t.amount,
  blockHeight: t.blockHeight,
  blockTime: t.blockTime,
  assetKey: keyOf(t),
});

async function a4(facts: AddressFacts, deps: ExclusionDeps): Promise<ExclusionDecision | undefined> {
  const family = chainFamily(facts.address.chain);
  if (family !== 'evm' && family !== 'tron') return undefined;
  const type = facts.classification?.type ?? 'unknown';
  if (!['eoa', 'delegated_eoa', 'contract', 'unknown'].includes(type)) return undefined;
  const self = facts.address.address;
  // Transfers never cross chains: an `evm:unknown` candidate is evaluated only on its explicitly resolved chain.
  const chain = facts.address.chain === 'evm:unknown' ? facts.resolved?.chain : facts.address.chain;
  if (chain === undefined || chain === 'evm:unknown') return undefined;
  const transfers = facts.transfers.filter((t) => t.chain === chain);

  const receives: ForwardingLeg[] = [];
  const forwards: ForwardingLeg[] = [];
  const hotWallet = new Map<ForwardingLeg, { transfer: NormalizedTransfer; label: AddressLabel }>();
  const senders = new Map<ForwardingLeg, string>();
  const sources = new Map<ForwardingLeg, NormalizedTransfer>();
  for (const t of transfers) {
    const incoming = sameAddress(chain, t.to, self) && !sameAddress(chain, t.from, self);
    const outgoing = sameAddress(chain, t.from, self) && !sameAddress(chain, t.to, self);
    if (incoming) {
      const l = leg(t);
      receives.push(l);
      senders.set(l, t.from);
      sources.set(l, t);
    } else if (outgoing) {
      // Sequential label lookups keep the decision deterministic; transfers per address are few in the MVP.
      // oxlint-disable-next-line no-await-in-loop
      const labels = await deps.labels.labelsFor({ chain, address: t.to }, t.blockTime);
      const exchange = labels.find((l) => l.category === 'exchange' && isDecidingService(l, deps.rules.a1.trustOrder));
      if (!exchange) continue;
      const l = leg(t);
      forwards.push(l);
      hotWallet.set(l, { transfer: t, label: exchange });
    }
  }
  if (forwards.length === 0 || receives.length === 0) return undefined;
  const params = forwardingParamsFor(chain, deps.rules.a4);
  const pairs = findForwardingPairs(receives, forwards, params);
  if (pairs.length === 0) return undefined;
  const best = pairs.reduce((a, b) => (b.kappa > a.kappa ? b : a));
  const target = hotWallet.get(best.forward);
  if (!target) return undefined;
  const distinctSenders = new Set(pairs.map((p) => senders.get(p.receive))).size;
  return decision(deps, facts.address, 'A4', {
    outcome: 'reclassified',
    relation: 'CUSTODIAL_EXCHANGE',
    emitsCashOut: 'B1',
    reason: `A4: forwards received funds to the labelled exchange hot wallet ${target.transfer.to} ("${target.label.entity}"); ${pairs.length} pair(s), max kappa ${best.kappa}`,
    evidence: {
      kappa: best.kappa,
      labelIds: [...new Set(pairs.map((p) => hotWallet.get(p.forward)?.label.id ?? target.label.id))],
      txHashes: pairs.flatMap((p) => [p.receive.txHash, p.forward.txHash]),
      fetchIds: [...new Set(transfers.map((t) => t.fetchId))],
      forwardsTo: {
        address: target.transfer.to,
        entity: target.label.entity,
        category: target.label.category,
        labelId: target.label.id,
      },
      // Each pair keeps the hot wallet its own forward reached (one address may sweep to several exchanges).
      pairs: pairs.map((p) => {
        const reached = hotWallet.get(p.forward);
        const pair: NonNullable<ExclusionDecision['evidence']['pairs']>[number] = {
          receiveTx: p.receive.txHash,
          forwardTx: p.forward.txHash,
          amountIn: p.receive.amount,
          amountOut: p.forward.amount,
          delta: p.delta,
          kappa: p.kappa,
          // exactly which transfers matched (a transaction may move several assets)
          assetKey: p.receive.assetKey,
        };
        const received = sources.get(p.receive);
        if (received) {
          pair.receiveKind = received.kind;
          if (received.index !== undefined) pair.receiveIndex = received.index;
        }
        if (reached) {
          pair.forwardKind = reached.transfer.kind;
          if (reached.transfer.index !== undefined) pair.forwardIndex = reached.transfer.index;
          pair.forwardsTo = {
            address: reached.transfer.to,
            entity: reached.label.entity,
            category: reached.label.category,
            labelId: reached.label.id,
          };
        }
        return pair;
      }),
      kycLead: facts.published,
      params: {
        ...(params.clock === 'blocks' ? { tauBlocks: params.tau } : { tauSeconds: params.tau }),
        alpha: params.alpha,
        clock: params.clock,
        distinctSenders,
      },
    },
  });
}

/** Code evidence of A2/A3: the first bytes and the length of the deployed code. */
function codeEvidence(c: AddressTypeClassification): Pick<ExclusionDecision['evidence'], 'codePrefix' | 'codeBytes'> {
  return {
    ...(c.codePrefix ? { codePrefix: c.codePrefix } : {}),
    ...(c.codeSize !== undefined ? { codeBytes: c.codeSize } : {}),
  };
}

/**
 * A3: an EIP-7702 delegated account stays a person's account; a delegate the registry lists as a sweeper flags it.
 * With `recordDelegate: false` the decision names neither the delegate nor its registry entry (the stored address type
 * still holds the delegate).
 */
function a3(facts: AddressFacts, c: AddressTypeClassification, deps: ExclusionDeps): ExclusionDecision {
  const known = c.delegate && deps.delegates ? findDelegate(deps.delegates, c.address.chain, c.delegate) : undefined;
  const sweeper = known?.kind === 'sweeper' && deps.rules.a3.flagKnownSweepers;
  const record = deps.rules.a3.recordDelegate;
  const named = known
    ? ` (${known.kind === 'sweeper' ? 'known sweeper' : 'wallet implementation'} "${known.name}")`
    : '';
  const delegate = record ? `the delegate ${c.delegate ?? 'unknown'}${named}` : 'the delegate';
  return decision(deps, facts.address, 'A3', {
    outcome: sweeper ? 'flagged' : 'kept',
    reason: sweeper
      ? `A3: EIP-7702 delegated account; ${delegate} is listed as a sweeper that forwards incoming funds to a third party — the account's key is likely compromised`
      : `A3: EIP-7702 delegated account (${delegate}); still a person's account`,
    evidence: {
      fetchIds: c.fetchIds,
      ...codeEvidence(c),
      ...(record && c.delegate ? { delegate: c.delegate } : {}),
      ...(record && known ? { delegateInfo: { kind: known.kind, name: known.name, source: known.source } } : {}),
    },
  });
}

function a2a3(facts: AddressFacts, deps: ExclusionDeps): ExclusionDecision | undefined {
  const c = facts.classification;
  if (!c) return undefined;
  if (c.type === 'delegated_eoa') return a3(facts, c, deps);
  if (deps.rules.a2.keepAttributable.includes(c.type)) {
    const detail =
      c.type === 'safe'
        ? `Safe singleton ${c.safeMasterCopy ?? 'unknown'}`
        : c.type === 'erc4337_account'
          ? `ERC-4337 EntryPoint ${c.entryPoint ?? 'unknown'}`
          : 'contract code';
    return decision(deps, facts.address, 'A2', {
      outcome: 'kept',
      reason: `A2: ${c.type} is a personal smart account (${detail}); still attributable`,
      evidence: { fetchIds: c.fetchIds, ...codeEvidence(c) },
    });
  }
  if (c.type === 'contract' || c.type === 'token_contract') {
    return decision(deps, facts.address, 'A2', {
      outcome: 'excluded',
      reason: `A2: the address holds ${c.type === 'token_contract' ? 'token contract' : 'contract'} bytecode (no Safe, ERC-4337 account or EIP-7702 delegation); a smart contract is not a personal holding`,
      evidence: { fetchIds: c.fetchIds, ...codeEvidence(c) },
    });
  }
  return undefined;
}

/** All rule decisions for one address; combine them with `effectiveOutcome`. */
export async function evaluateExclusions(facts: AddressFacts, deps: ExclusionDeps): Promise<ExclusionDecision[]> {
  const address = facts.address.chain.startsWith('evm:') ? canonicalAddress(facts.address) : facts.address;
  const normalised = { ...facts, address };
  const decisions = await prescreenExclusions(address, deps);
  if (decisions.some((d) => d.ruleId === 'A8' || d.ruleId === 'A1')) return decisions;
  const deposit = await a4(normalised, deps);
  if (deposit) decisions.push(deposit);
  const contract = a2a3(normalised, deps);
  if (contract) decisions.push(contract);
  return decisions;
}

const PRECEDENCE: Record<ExclusionRuleId, number> = { A8: 0, A1: 1, A4: 2, A2: 3, A5: 4, A6: 4, A7: 4, A3: 5 };
const score = (d: ExclusionDecision): number => (d.outcome === 'kept' ? 10 : PRECEDENCE[d.ruleId]);

/** Precedence A8 > A1 > A4 > A2-excluded > A5/A6/A7 flagged > A3 flagged > kept. */
export function effectiveOutcome(decisions: readonly ExclusionDecision[]): {
  outcome: ExclusionDecision['outcome'] | 'none';
  decisive?: ExclusionDecision;
} {
  const decisive = decisions.toSorted((a, b) => score(a) - score(b))[0];
  return decisive ? { outcome: decisive.outcome, decisive } : { outcome: 'none' };
}

/** Addresses that must not be analysed as the subject's holdings (excluded outcomes). */
export function isExcluded(decisions: readonly ExclusionDecision[]): boolean {
  return effectiveOutcome(decisions).outcome === 'excluded';
}
