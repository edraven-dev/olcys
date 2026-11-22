/**
 * The structured report model (`ReportModel` of `@olcys/core`), derived from the same `ReportData` the HTML renderer
 * uses and with the same catalogue sentences: the console renders it natively instead of embedding the HTML.
 * The three statement classes stay separate: facts (what a source showed), computed results (deterministic) and
 * inferences (hypotheses that need verification). Pure and deterministic.
 */
import type {
  AddressRef,
  AnalyticConfidence,
  Capture,
  LinkAssessment,
  ReportComputed,
  ReportFact,
  ReportInference,
  ReportModel,
} from '@olcys/core';
import { formatAmount, formatPln, formatUtc, plural } from './format.ts';
import { fill } from './html.ts';
import { pl } from './i18n/pl.ts';
import { flowSteps } from './render/chain.ts';
import { isWalletSwap, changeWhere } from './render/annex.ts';
import { COMPUTED_PREFIX, isKycLead, linkEvidence, propertyLabel, uniqueRejected } from './render/links.ts';
import type { ReportData } from './types.ts';
import { chainName } from './render/blocks.ts';
import { buildView, cmp, icdTerm, linkBand, lowestConfidence, refKey, timeOf, type View } from './view.ts';

/** Plain text of a `SafeHtml` or string produced by the renderer helpers. */
const plain = (value: { toString(): string }): string => value.toString().replace(/<[^>]+>/g, '');

const ref = (r: AddressRef): string => `${chainName(r.chain)}`;

/** Polish reason of a rejected match (`code` or `code: detail`); an unknown code is shown as it is. */
function rejectReason(reason: string): string {
  const code = (reason.split(':')[0] ?? '').trim();
  const known = (pl.rejectReasons as Record<string, string>)[code];
  return known ?? reason;
}

function factsOf(view: View): ReportFact[] {
  const { data } = view;
  const fromObservations = data.observations
    .filter((o) => !o.property.startsWith(COMPUTED_PREFIX))
    .map((o): { fact: ReportFact; at: string } => {
      const capture = view.captureById.get(o.captureId);
      const at = capture?.collectedAt ?? o.observedAt;
      const fact: ReportFact = {
        id: o.id,
        statement: fill(pl.facts.observation, {
          source: view.sourceName(o.sourceId),
          subject: o.subject.key,
          property: propertyLabel(o.property),
          value: o.value,
        }),
        captureId: o.captureId,
        url: capture?.url ?? '',
        collectedAt: at,
      };
      return { fact, at };
    });
  const fromCandidates = data.candidates.map((c): { fact: ReportFact; at: string } => {
    const capture = view.captureById.get(c.captureId);
    const fact: ReportFact = {
      id: c.id,
      statement: fill(pl.model.candidateQuote, {
        address: c.address.address,
        url: capture?.url ?? c.captureId,
        source: capture ? view.sourceName(capture.sourceId) : pl.common.unknown,
      }),
      captureId: c.captureId,
      url: capture?.url ?? '',
      collectedAt: capture?.collectedAt ?? '',
    };
    if (c.context?.snippet) fact.quote = c.context.snippet;
    return { fact, at: capture?.collectedAt ?? '' };
  });
  return [...fromObservations, ...fromCandidates]
    .toSorted((a, b) => timeOf(a.at) - timeOf(b.at) || cmp(a.fact.id, b.fact.id))
    .map((entry) => entry.fact);
}

function basedOnAddress(view: View, address: AddressRef): string[] {
  return [...view.observationsFor(address).map((o) => o.id), ...view.candidatesFor(address).map((c) => c.id)];
}

/** Facts and computed checks the link rests on, from both hops of its paths (as the HTML renderer cites them). */
function linkBasedOn(view: View, link: LinkAssessment): string[] {
  const e = linkEvidence(view, link);
  return [...new Set([...e.facts, ...e.candidates, ...e.computed].map((x) => x.id))];
}

function computedOf(view: View): ReportComputed[] {
  const { data } = view;
  const out: ReportComputed[] = [];
  // Checks OŁCyŚ computed itself on a page (e.g. the signed-message verification) are results, never source facts.
  for (const o of data.observations.filter((x) => x.property.startsWith(COMPUTED_PREFIX))) {
    out.push({
      id: o.id,
      kind: 'validation',
      statement: fill(pl.facts.observation, {
        source: view.sourceName(o.sourceId),
        subject: o.subject.key,
        property: propertyLabel(o.property),
        value: pl.signedCheck[o.value] ?? o.value,
      }),
      basedOn: [],
      data: o,
    });
  }
  const rejected = uniqueRejected(data);
  rejected.forEach((r, i) =>
    out.push({
      id: `rejected-${r.captureId}-${i}`,
      kind: 'validation',
      statement: fill(pl.model.rejected, { raw: r.raw, reason: rejectReason(r.reason) }),
      basedOn: [],
      data: r,
    }),
  );
  for (const l of data.links.toSorted((a, b) => b.score - a.score || cmp(a.id, b.id))) {
    out.push({
      id: l.id,
      kind: 'score',
      statement: fill(pl.model.likelihood, {
        address: l.address.address,
        chain: chainName(l.address.chain),
        identity: view.identityLabel(l.identityId),
        term: icdTerm(l),
        score: l.score,
        band: pl.bands[linkBand(l)].label,
      }),
      basedOn: linkBasedOn(view, l),
      data: l,
    });
  }
  for (const e of data.exclusions.toSorted((a, b) => cmp(a.ruleId, b.ruleId) || cmp(a.id, b.id))) {
    out.push({
      id: e.id,
      kind: 'exclusion',
      statement: fill(pl.model.exclusion, {
        id: e.ruleId,
        name: pl.exclusionRules[e.ruleId] ?? e.ruleId,
        outcome: pl.outcomes[e.outcome] ?? e.outcome,
        address: e.address.address,
        chain: chainName(e.address.chain),
      }),
      basedOn: basedOnAddress(view, e.address),
      data: e,
    });
  }
  for (const a of data.activity) {
    out.push({
      id: `activity-${refKey(a.address)}`,
      kind: 'activity',
      statement: fill(pl.model.activity, {
        address: a.address.address,
        chain: ref(a.address),
        count: a.txCount,
        counterparties: a.counterpartyCount,
      }),
      basedOn: basedOnAddress(view, a.address),
      data: a,
    });
  }
  for (const e of data.cashOuts.toSorted((a, b) => cmp(a.occurredAt, b.occurredAt) || cmp(a.id, b.id))) {
    const strength = pl.strengths[e.strength] ?? e.strength;
    out.push({
      id: e.id,
      kind: 'cash_out',
      statement: fill(pl.model.cashOut, {
        id: e.ruleId,
        name: pl.cashOutRules[e.ruleId] ?? e.ruleId,
        strength,
        amount: formatAmount(e.amount, e.asset),
        address: e.address.address,
        counterparty: e.counterparty.entity ?? e.counterparty.address,
      }),
      basedOn: basedOnAddress(view, e.address),
      data: e,
    });
    if (e.valuation) {
      out.push({
        id: `${e.id}-valuation`,
        kind: 'valuation',
        statement: fill(pl.model.valuation, {
          amount: formatAmount(e.amount, e.asset),
          pln: formatPln(e.valuation.pln),
        }),
        basedOn: [],
        data: e.valuation,
      });
    }
  }
  return out;
}

function inferencesOf(view: View): ReportInference[] {
  const { data } = view;
  const out: ReportInference[] = [];
  for (const l of view.linked.filter((x) => x.score >= 40)) {
    out.push({
      id: `inference-${l.id}`,
      statement: fill(pl.summary.inferenceLink, {
        address: l.address.address,
        chain: chainName(l.address.chain),
        identity: view.identityLabel(l.identityId),
        term: icdTerm(l),
        score: l.score,
        band: pl.bands[linkBand(l)].label,
      }),
      basedOn: [l.id],
      alternatives: [...pl.model.alternatives.link],
      origin: 'rule',
      requiresVerification: true,
    });
  }
  for (const e of view.removing.filter(isKycLead)) {
    out.push({
      id: `inference-${e.id}`,
      statement: fill(pl.summary.inferenceKyc, { address: e.address.address }),
      basedOn: [e.id],
      alternatives: [...pl.model.alternatives.kyc],
      origin: 'rule',
      requiresVerification: true,
    });
  }
  for (const e of data.cashOuts.toSorted((a, b) => cmp(a.occurredAt, b.occurredAt) || cmp(a.id, b.id))) {
    out.push({
      id: `inference-${e.id}`,
      statement: fill(pl.summary.inferenceCashOut, {
        date: formatUtc(e.occurredAt),
        pln: e.valuation ? formatPln(e.valuation.pln) : pl.activity.noValuation,
        counterparty: e.counterparty.entity ?? e.counterparty.address,
      }),
      basedOn: [e.id],
      alternatives: [...pl.model.alternatives.cashOut],
      origin: 'rule',
      requiresVerification: true,
    });
  }
  for (const s of data.changes.filter(isWalletSwap)) {
    out.push({
      id: `inference-${s.id}`,
      statement: fill(pl.summary.inferenceSwap, {
        where: plain(changeWhere(s)),
        before: s.before ?? '',
        after: s.after ?? '',
      }),
      basedOn: [s.id],
      alternatives: [...pl.model.alternatives.swap],
      origin: 'rule',
      requiresVerification: true,
    });
  }
  const linkById = new Map(data.links.map((l) => [l.id, l]));
  for (const j of data.judgements ?? []) {
    const link = linkById.get(j.linkAssessmentId);
    out.push({
      id: `inference-${j.id}`,
      statement: fill(pl.model.judgement, {
        analyst: j.analyst,
        at: formatUtc(j.at),
        label: pl.judgements.values[j.judgement].label,
        text: j.justification,
      }),
      basedOn: link ? [link.id] : [],
      alternatives: [],
      origin: 'analyst',
      requiresVerification: true,
    });
  }
  return out;
}

type FlowStepInput = ReturnType<typeof flowSteps>[number];

function fundFlowStep(s: FlowStepInput): ReportModel['fundFlow'][number] {
  const description =
    s.kind === 'indicator'
      ? fill(pl.model.indicatorPrefix, {
          text: fill(pl.flow.indicator, {
            amount: formatAmount(s.amount, s.asset),
            from: s.from,
            to: s.to,
            txs: s.txHashes.join(', ') || pl.common.none,
            chain: chainName(s.chain),
          }),
        })
      : fill(pl.flow.step, { amount: formatAmount(s.amount, s.asset), from: s.from, to: s.to });
  const step: ReportModel['fundFlow'][number] = { at: s.at, description, txHashes: s.txHashes };
  const value = s.valuation ?? s.eventValuation;
  if (value) step.valuation = value;
  return step;
}

function registerEntry(view: View, c: Capture): ReportModel['evidenceRegister'][number] {
  const entry: ReportModel['evidenceRegister'][number] = {
    captureId: c.id,
    url: c.url,
    collectedAt: c.collectedAt,
    manifestSha256: c.manifestSha256,
    sourceName: view.sourceName(c.sourceId),
  };
  if (c.timestamp) entry.timestamp = c.timestamp;
  return entry;
}

export function buildReportModel(data: ReportData): ReportModel {
  const view = buildView(data);
  const cfg = data.run.config;
  const algorithms = [...new Set(data.links.map((l) => l.algorithmVersion))].toSorted(cmp);
  const confidence: AnalyticConfidence = lowestConfidence(view.linked.map((l) => l.analyticConfidence)) ?? 'Low';
  const steps = flowSteps(view);
  return {
    reportId: data.reportId,
    caseId: data.case.id,
    runId: data.run.id,
    language: 'pl',
    generatedAt: data.generatedAt,
    reproducibility: {
      toolVersion: cfg.toolVersion,
      ...(cfg.gitCommit ? { gitCommit: cfg.gitCommit } : {}),
      algorithmVersion: algorithms.join(', '),
      weightsVersion: cfg.weightsVersion,
      weightsSha256: cfg.weightsSha256,
      rulesVersions: cfg.rulesVersions ?? {},
      ...(cfg.llm?.modelDigest ? { modelDigests: { [cfg.llm.model]: cfg.llm.modelDigest } } : {}),
      mode: data.run.mode,
      ...(data.weightsStatus ? { weightsStatus: data.weightsStatus } : {}),
      sourcesConfigSha256: cfg.sourcesConfigSha256,
      dataSha256: view.dataSha256,
    },
    summary: {
      headline: fill(pl.summary.lead, { identifiers: plural(data.case.identifiers.length, pl.counts.identifiers) }),
      likelihoodStatements: view.linked.map((l) =>
        fill(pl.model.likelihood, {
          address: l.address.address,
          chain: chainName(l.address.chain),
          identity: view.identityLabel(l.identityId),
          term: icdTerm(l),
          score: l.score,
          band: pl.bands[linkBand(l)].label,
        }),
      ),
      analyticConfidence: confidence,
    },
    facts: factsOf(view),
    computed: computedOf(view),
    inferences: inferencesOf(view),
    fundFlow: steps.map(fundFlowStep),
    changesSincePrevious: data.changes.toSorted(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.key.locator, b.key.locator) || cmp(a.id, b.id),
    ),
    evidenceRegister: view.captures.map((c) => registerEntry(view, c)),
  };
}
