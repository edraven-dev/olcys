/**
 * What the exports carry: the accepted ownership links of the report (or, on request, also the rejected ones) with
 * their evidence captures. Facts and computed results only; inferences and AI suggestions never reach an export.
 */
import type { AdmiraltyReliability, AnalystJudgement, Capture, LinkAssessment } from '@olcys/core';
import type { ReportData } from '../types.ts';
import { buildView, cmp, type View } from '../view.ts';

export interface ExportInput {
  data: ReportData;
}

export interface ExportedLink {
  link: LinkAssessment;
  /** Set for a link that is not an accepted ownership claim: the relation or the exclusion rule that rejected it. */
  rejected?: string;
  /** Evidence captures behind the link, oldest first. */
  captures: Capture[];
  judgements: AnalystJudgement[];
}

export interface ExportSelection {
  view: View;
  links: ExportedLink[];
}

/** Captures the link's scored evidence refers to (directly, or through an observation or a candidate). */
export function linkCaptures(view: View, link: LinkAssessment): Capture[] {
  const ids = new Set<string>();
  for (const path of link.paths ?? []) {
    for (const hop of [path.identityHop, path.addressHop]) {
      for (const c of hop.contributions) {
        if (c.evidence.captureId) ids.add(c.evidence.captureId);
        const observation = c.evidence.observationId ? view.observationById.get(c.evidence.observationId) : undefined;
        if (observation) ids.add(observation.captureId);
        const candidate = c.evidence.candidateId ? view.candidateById.get(c.evidence.candidateId) : undefined;
        if (candidate) ids.add(candidate.captureId);
      }
    }
  }
  return [...ids]
    .map((id) => view.captureById.get(id))
    .filter((c): c is Capture => c !== undefined)
    .toSorted((a, b) => cmp(a.collectedAt, b.collectedAt) || cmp(a.id, b.id));
}

/** The best (lowest letter) Admiralty grade among the evidence items that counted towards the link. */
export function bestReliability(link: LinkAssessment): AdmiraltyReliability | undefined {
  const grades = (link.paths ?? [])
    .flatMap((p) => p.identityHop.contributions.concat(p.addressHop.contributions))
    .filter((c) => c.counted)
    .map((c) => c.reliability);
  return grades.reduce<AdmiraltyReliability | undefined>(
    (best, g) => (best === undefined || g < best ? g : best),
    undefined,
  );
}

export function selectLinks(input: ExportInput, includeRejected = false): ExportSelection {
  const view = buildView(input.data);
  const accepted = new Set(view.linked.map((l) => l.id));
  const judgementsOf = (id: string) =>
    (input.data.judgements ?? [])
      .filter((j) => j.linkAssessmentId === id)
      .toSorted((a, b) => cmp(a.at, b.at) || cmp(a.id, b.id));
  const reason = (l: LinkAssessment): string => {
    const gate = (l.gates ?? []).find((g) => g.gate === 'exclusion' && !g.passed);
    const rule = view.exclusionsFor(l.address).find((e) => view.removing.includes(e));
    if (rule) return `${rule.ruleId}: ${rule.outcome}`;
    return gate ? 'exclusion' : l.relation;
  };
  const rows = (links: LinkAssessment[], rejected: boolean): ExportedLink[] =>
    links.map((link) => ({
      link,
      ...(rejected ? { rejected: reason(link) } : {}),
      captures: linkCaptures(view, link),
      judgements: judgementsOf(link.id),
    }));
  const rejectedLinks = includeRejected
    ? input.data.links.filter((l) => !accepted.has(l.id)).toSorted((a, b) => b.score - a.score || cmp(a.id, b.id))
    : [];
  return { view, links: [...rows(view.linked, false), ...rows(rejectedLinks, true)] };
}

/** Case subject's display name: the full-name identifier, else the first anchor, else the first identifier. */
export function subjectName(data: ReportData): string {
  const ids = data.case.identifiers;
  return (ids.find((i) => i.kind === 'full_name') ?? ids.find((i) => i.isAnchor) ?? ids[0])?.value ?? data.case.title;
}

export function isoMs(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}
