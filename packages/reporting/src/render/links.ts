/** Chapter 3 (accepted identity↔address links) and chapter 4 (rejected attributions). */
import type {
  AddressCandidate,
  AddressLabel,
  AddressRef,
  AddressTypeClassification,
  AnalystOverride,
  ExclusionDecision,
  FeatureContribution,
  HopResult,
  Id,
  LinkAssessment,
  Observation,
  OnlineAccount,
} from '@olcys/core';
import { formatBits, formatFactor, formatProbability, formatUtc, plural, shortHash } from '../format.ts';
import { codePoint, fill, join, markup, t, type Html, type SafeHtml } from '../html.ts';
import { pl } from '../i18n/pl.ts';
import type { RejectedCandidate, ReportData } from '../types.ts';
import { cmp, icdTerm, linkBand, refKey, sameRef, type View } from '../view.ts';
import {
  addr,
  bandBadge,
  block,
  captureRef,
  chainName,
  hash,
  kv,
  list,
  muted,
  para,
  section,
  table,
  technical,
  url,
} from './blocks.ts';

const COMPUTED_PREFIX = 'computed.';

export function propertyLabel(property: string): string {
  const base = property.replace(/\[\d+\]/g, '');
  return pl.properties[base] ?? fill(pl.propertyFallback, { property });
}

function captureMeta(view: View, captureId: Id): SafeHtml {
  const capture = view.captureById.get(captureId);
  if (!capture) return muted(captureRef(view, captureId));
  return muted(
    t(pl.facts.meta, {
      at: formatUtc(capture.collectedAt),
      ref: captureRef(view, captureId),
      sha: hash(shortHash(capture.manifestSha256)),
    }),
  );
}

function observationValue(o: Observation): Html {
  if (o.property.startsWith(COMPUTED_PREFIX) && pl.signedCheck[o.value]) return pl.signedCheck[o.value];
  return /address/.test(o.property) ? addr(o.value) : markup`„${o.value}”`;
}

export function observationFact(view: View, o: Observation): SafeHtml {
  return markup`${t(pl.facts.observation, {
    source: view.sourceName(o.sourceId),
    subject: o.subject.key,
    property: propertyLabel(o.property),
    value: observationValue(o),
  })}<br>${captureMeta(view, o.captureId)}`;
}

/** Post authors the source shows for the item containing the mention (by DOM anchor when known). */
function authorsOf(view: View, c: AddressCandidate): string[] {
  const onPage = view.data.observations.filter((o) => o.captureId === c.captureId && o.property === 'post.author');
  const anchor = c.context?.anchor;
  const matched = anchor ? onPage.filter((o) => o.locator.includes(anchor)) : [];
  return [...new Set((matched.length ? matched : onPage).map((o) => o.value))].toSorted(cmp);
}

export function candidateFact(view: View, c: AddressCandidate, withAuthor = false): SafeHtml {
  const capture = view.captureById.get(c.captureId);
  const snippet = c.context?.snippet;
  const authors = withAuthor ? authorsOf(view, c) : [];
  const author = withAuthor
    ? markup`<br>${authors.length ? t(pl.facts.author, { authors: authors.join(', ') }) : pl.facts.authorUnknown}`
    : '';
  return markup`${t(pl.facts.candidate, {
    url: url(capture?.url ?? c.captureId),
    source: capture ? view.sourceName(capture.sourceId) : pl.common.unknown,
  })}${snippet ? markup`<blockquote>${t(pl.facts.snippet, { snippet })}</blockquote>` : ''}${author}<br>${captureMeta(view, c.captureId)}`;
}

function accountFact(view: View, a: OnlineAccount): SafeHtml {
  return markup`${t(pl.facts.account, { handle: a.handle, platform: a.platform, url: url(a.profileUrl) })}${
    a.discoveredVia?.captureId ? markup`<br>${captureMeta(view, a.discoveredVia.captureId)}` : ''
  }`;
}

const byCapture = (view: View) => (a: { captureId: Id; id: Id }, b: { captureId: Id; id: Id }) =>
  (view.captureNo.get(a.captureId) ?? 1e9) - (view.captureNo.get(b.captureId) ?? 1e9) || cmp(a.id, b.id);

/** Evidence the link rests on: path accounts, cited observations/candidates and every trace of the address. */
function linkEvidence(view: View, link: LinkAssessment) {
  const accounts = new Map<Id, OnlineAccount>();
  const observations = new Map<Id, Observation>();
  const candidates = new Map<Id, AddressCandidate>();
  for (const path of link.paths ?? []) {
    const account = path.accountId ? view.accountById.get(path.accountId) : undefined;
    if (account) accounts.set(account.id, account);
    for (const hop of [path.identityHop, path.addressHop]) {
      for (const c of hop?.contributions ?? []) {
        const o = c.evidence?.observationId ? view.observationById.get(c.evidence.observationId) : undefined;
        if (o) observations.set(o.id, o);
        const cand = c.evidence?.candidateId ? view.candidateById.get(c.evidence.candidateId) : undefined;
        if (cand) candidates.set(cand.id, cand);
      }
    }
  }
  for (const o of view.observationsFor(link.address)) observations.set(o.id, o);
  for (const c of view.candidatesFor(link.address)) candidates.set(c.id, c);
  // Checks OŁCyŚ computed on the cited pages (e.g. the signed-message verification) are shown as computed results.
  const cited = new Set([...observations.values(), ...candidates.values()].map((x) => x.captureId));
  for (const o of view.data.observations)
    if (o.property.startsWith(COMPUTED_PREFIX) && cited.has(o.captureId)) observations.set(o.id, o);
  const sortedObs = [...observations.values()].toSorted(byCapture(view));
  return {
    accounts: [...accounts.values()].toSorted((a, b) => cmp(a.platform, b.platform) || cmp(a.handle, b.handle)),
    facts: sortedObs.filter((o) => !o.property.startsWith(COMPUTED_PREFIX)),
    computed: sortedObs.filter((o) => o.property.startsWith(COMPUTED_PREFIX)),
    candidates: [...candidates.values()].toSorted(byCapture(view)),
  };
}

function evidenceCell(view: View, c: FeatureContribution): SafeHtml {
  const ev = c.evidence ?? {};
  const captureId =
    ev.captureId ??
    (ev.observationId ? view.observationById.get(ev.observationId)?.captureId : undefined) ??
    (ev.candidateId ? view.candidateById.get(ev.candidateId)?.captureId : undefined);
  const capture = captureId ? view.captureById.get(captureId) : undefined;
  return markup`${capture ? view.sourceName(capture.sourceId) : ''} ${captureRef(view, captureId)}${c.detail ? markup`<br>${muted(c.detail)}` : ''}`;
}

function hopRows(view: View, hop: HopResult | undefined, anchor?: boolean): Html[][] {
  if (!hop) return [];
  const label = pl.hopsShort[hop.hop] ?? hop.hop;
  const contributions = hop.contributions ?? [];
  const isAnchor = anchor ?? (contributions.length === 0 && Math.abs(hop.probability - 0.99) < 1e-6);
  const prior: Html[] = [
    label,
    isAnchor ? pl.links.anchor : pl.links.prior,
    '',
    '',
    '',
    '',
    formatBits(hop.priorBits),
    pl.links.counted,
    '',
  ];
  return [
    prior,
    ...contributions.map((c) => [
      label,
      pl.features[c.feature] ?? fill(pl.featureFallback, { key: c.feature }),
      c.reliability,
      formatFactor(c.bayesFactor),
      formatFactor(c.rho),
      formatFactor(c.discountedBayesFactor),
      formatBits(c.bits),
      c.counted
        ? pl.links.counted
        : c.uncountedReason === 'ungraded'
          ? pl.links.notCountedUngraded
          : pl.links.notCounted,
      evidenceCell(view, c),
    ]),
  ];
}

function hopLine(hop: HopResult | undefined): SafeHtml {
  if (!hop) return markup``;
  return t(pl.links.hop, {
    hop: pl.hops[hop.hop] ?? hop.hop,
    p: formatProbability(hop.probability),
    lr: `≈ ${formatFactor(hop.likelihoodRatio)}`,
    enfsi: pl.enfsi[hop.enfsiVerbal] ?? hop.enfsiVerbal,
  });
}

/**
 * Trace synergy as assessed by the scoring engine (independent services, bonus, ignored repeats). Without the
 * engine's assessment the report only counts where the address appeared and makes no independence claim.
 */
function synergyText(view: View, link: LinkAssessment): SafeHtml {
  const s = link.synergy;
  if (s) {
    const services = s.independentSources.map((id) => view.sourceName(id)).join(', ');
    const main =
      s.independentSources.length >= 2
        ? t(pl.links.synergyYes, {
            independent: plural(s.independentSources.length, pl.counts.independentSources),
            sources: services,
            bonus: s.bonusPoints,
            best: s.bestSingleScore,
          })
        : t(pl.links.synergyNo, { sources: services || pl.common.none });
    const repeats =
      s.repeatedPaths || s.repeatedItems
        ? para(t(pl.links.synergyRepeats, { paths: s.repeatedPaths, items: s.repeatedItems }))
        : '';
    return join([para(main), repeats]);
  }
  const sources = view.appearances(link.address);
  if (!sources.length) return para(pl.links.synergyNone);
  const names = join(
    sources.map((x) =>
      t(pl.links.synergySource, {
        source: view.sourceName(x.sourceId),
        occurrences: plural(x.pages, pl.counts.occurrences),
      }),
    ),
    ', ',
  );
  return para(t(pl.links.appearances, { sources: plural(sources.length, pl.counts.sourcesLoc), list: names }));
}

const judgementsOf = (view: View, link: LinkAssessment) =>
  (view.data.judgements ?? []).filter((j) => j.linkAssessmentId === link.id);

/**
 * The analyst's judgements on the link, oldest first, with the current (latest) one named: a separate statement next
 * to the computed score, which it never changes. `heading` names the link where no card of its own does.
 */
function judgementsBlock(view: View, link: LinkAssessment, heading?: SafeHtml): SafeHtml {
  const own = judgementsOf(view, link);
  const latest = own.at(-1);
  if (!latest) return markup``;
  const j = pl.judgements;
  const entries = own.map(
    (x) =>
      markup`${t(j.entry, { label: markup`<strong>${j.values[x.judgement].label}</strong>`, analyst: x.analyst, at: formatUtc(x.at) })}<br>${muted(j.values[x.judgement].description)}<br>${t(j.justification, { text: x.justification })}`,
  );
  return block(
    'analyst',
    join([
      heading ? para(heading) : '',
      para(t(j.current, { label: j.values[latest.judgement].label })),
      list(entries),
      para(j.notice, 'muted'),
      para(j.automationBias, 'muted'),
    ]),
  );
}

/**
 * Judgements on links without a card of their own in chapters 3–4 (rejected by an exclusion rule or by a relation
 * that is not ownership), so that every recorded analyst statement appears in the report exactly once.
 */
function otherJudgements(view: View): SafeHtml {
  const carded = new Set([...view.linked, ...view.thirdParty].map((l) => l.id));
  const others = view.data.links
    .filter((l) => !carded.has(l.id) && judgementsOf(view, l).length > 0)
    .toSorted((a, b) => cmp(refKey(a.address), refKey(b.address)) || cmp(a.relation, b.relation) || cmp(a.id, b.id));
  if (!others.length) return markup``;
  return join([
    markup`<h3>${pl.judgements.otherTitle}</h3>`,
    para(pl.judgements.otherIntro),
    others.map((l) =>
      judgementsBlock(
        view,
        l,
        t(pl.judgements.otherLink, {
          address: addr(l.address.address),
          chain: chainName(l.address.chain),
          relation: pl.relations[l.relation] ?? l.relation,
          score: l.score,
        }),
      ),
    ),
  ]);
}

function overrideTarget(view: View, o: AnalystOverride): SafeHtml {
  const x = pl.overrides.targets;
  const parts: SafeHtml[] = [];
  const { observationId, candidateId, sourceId, accountId, address } = o.target;
  if (observationId) {
    const observation = view.observationById.get(observationId);
    parts.push(
      observation
        ? markup`${t(x.observation, { property: propertyLabel(observation.property) })} ${captureRef(view, observation.captureId)}`
        : t(x.observation, { property: markup`<code>${observationId}</code>` }),
    );
  }
  if (candidateId) parts.push(t(x.candidate, { id: markup`<code>${candidateId}</code>` }));
  if (sourceId) parts.push(t(x.source, { source: view.sourceName(sourceId) }));
  if (accountId) {
    const account = view.accountById.get(accountId);
    parts.push(t(x.account, { account: account ? `${account.platform} / ${account.handle}` : accountId }));
  }
  if (address) parts.push(t(x.address, { address: addr(address.address) }));
  return join(parts, markup`<br>`);
}

function overrideValue(o: AnalystOverride): string {
  if (o.kind === 'reliability_grade') return pl.reliability[o.value as keyof typeof pl.reliability] ?? o.value;
  if (o.kind === 'review_decision')
    return pl.overrides.decisions[o.value as keyof typeof pl.overrides.decisions] ?? o.value;
  return pl.features[o.value] ?? o.value;
}

/** The analyst overrides a rescore run applied (its config snapshot names them as `rulesVersions.overrides`). */
function overridesBlock(view: View): SafeHtml {
  const applied = view.data.overrides ?? [];
  if (!applied.length) return markup``;
  const c = pl.overrides.columns;
  return block(
    'analyst',
    join([
      markup`<h3>${pl.overrides.title}</h3>`,
      para(pl.overrides.intro),
      table(
        [c.kind, c.target, c.value, c.analyst, c.justification],
        applied.map((o) => [
          pl.overrides.kinds[o.kind] ?? o.kind,
          overrideTarget(view, o),
          overrideValue(o),
          markup`${o.analyst}<br>${muted(formatUtc(o.at))}`,
          o.justification,
        ]),
        'grid compact',
      ),
    ]),
  );
}

function linkCard(view: View, link: LinkAssessment): SafeHtml {
  const address = link.address.address;
  const identity = view.identityById.get(link.identityId);
  const ev = linkEvidence(view, link);
  const band = linkBand(link);
  const paths = link.paths ?? [];
  const flagged = view.exclusionsFor(link.address).filter((e) => e.outcome === 'flagged');
  const c = pl.links.columns;

  const facts = list([
    ...ev.accounts.map((a) => accountFact(view, a)),
    ...ev.facts.map((o) => observationFact(view, o)),
    ...ev.candidates.map((cand) => candidateFact(view, cand)),
  ]);

  const pathItems = paths.map((p, i) => {
    const account = p.accountId ? view.accountById.get(p.accountId) : undefined;
    return markup`${t(pl.links.path, {
      n: i + 1,
      account: account ? `${account.platform} / ${account.handle}` : (p.service ?? pl.links.pathNoAccount),
      pIdentity: formatProbability(p.identityHop?.probability ?? Number.NaN),
      pAddress: formatProbability(p.addressHop?.probability ?? Number.NaN),
      p: formatProbability(p.probability),
    })}${p.counted === false ? markup` <strong class="warning">${pl.links.pathNotCounted}</strong>` : ''}${
      p.originGroup ? markup`<br>${muted(t(pl.links.originGroup, { group: p.originGroup }))}` : ''
    }<br>${muted(hopLine(p.identityHop))}<br>${muted(hopLine(p.addressHop))}`;
  });
  const rows = paths.flatMap((p) => [...hopRows(view, p.identityHop, p.anchor), ...hopRows(view, p.addressHop)]);
  const gates = (link.gates ?? []).map((g) =>
    join([
      pl.gates[g.gate] ?? g.gate,
      ': ',
      g.passed ? pl.links.gatePassed : pl.links.gateFailed,
      g.detail ? muted(markup` (${g.detail})`) : '',
    ]),
  );

  const computed = join([
    markup`<p class="score-line"><span class="score">${link.score}/100</span> ${bandBadge(band)} <span class="term">${icdTerm(link)}</span></p>`,
    kv([
      [pl.summary.tableColumns.score, t(pl.links.score, { score: link.score })],
      [pl.summary.tableColumns.band, t(pl.links.band, { band: pl.bands[band].label, range: pl.bands[band].range })],
      [pl.summary.tableColumns.term, icdTerm(link)],
      [pl.links.confidence, pl.analyticConfidence[link.analyticConfidence] ?? link.analyticConfidence],
    ]),
    para(
      t(pl.links.relation, {
        relation: pl.relations[link.relation] ?? link.relation,
        tier: pl.tiers[link.tier] ?? link.tier,
      }),
    ),
    flagged.map((e) => para(t(pl.links.flagged, { rule: e.ruleId, name: pl.exclusionRules[e.ruleId] }), 'warning')),
    ev.computed.length
      ? list(
          ev.computed.map((o) =>
            t(pl.links.computedCheck, {
              property: propertyLabel(o.property),
              value: observationValue(o),
              ref: captureRef(view, o.captureId),
            }),
          ),
        )
      : '',
    markup`<h4>${pl.links.synergyTitle}</h4>`,
    synergyText(view, link),
    paths.length ? markup`<h4>${pl.links.pathsTitle}</h4>${list(pathItems)}` : '',
    para(t(pl.links.combined, { p: formatProbability(link.probability), score: link.score })),
    rows.length
      ? markup`<h4>${pl.links.contributionsTitle}</h4>${table(
          [c.hop, c.feature, c.grade, c.bf, c.rho, c.bfPrime, c.bits, c.counted, c.evidence],
          rows,
          'grid compact',
        )}`
      : '',
    gates.length ? markup`<h4>${pl.links.gatesTitle}</h4>${list(gates)}` : '',
    para(
      muted(
        t(pl.links.versions, {
          algorithm: link.algorithmVersion,
          weights: link.weightsVersion,
          sha: shortHash(link.weightsSha256 ?? ''),
          rules: link.rulesVersion,
          at: formatUtc(link.computedAt),
        }),
      ),
    ),
  ]);

  const weak = paths.find((p) => (p.identityHop?.probability ?? 1) < 0.5 && (p.addressHop?.probability ?? 0) > 0.95);
  const weakAccount = weak?.accountId ? view.accountById.get(weak.accountId) : undefined;
  const inferences = join([
    para(
      t(pl.links.hypothesis, {
        address: addr(address),
        identity: identity?.value ?? link.identityId,
        term: icdTerm(link),
        score: link.score,
      }),
    ),
    weak
      ? para(
          t(pl.links.weakIdentity, {
            account: weakAccount ? `${weakAccount.platform} / ${weakAccount.handle}` : pl.links.pathNoAccount,
            p: formatProbability(weak.identityHop.probability),
          }),
          'warning',
        )
      : '',
    markup`<h4>${pl.links.alternativesTitle}</h4>${list(pl.links.alternatives)}`,
    markup`<h4>${pl.links.stepsTitle}</h4>${list(pl.links.steps)}`,
  ]);

  return markup`<article class="card" id="powiazanie-${link.id}"><h3>${addr(address)}</h3><p class="card-sub">${t(pl.links.chain, { chain: chainName(link.address.chain) })} · ${t(
    pl.links.identity,
    {
      kind: identity ? pl.identifierKinds[identity.kind] : pl.common.unknown,
      value: identity?.value ?? link.identityId,
    },
  )}</p>${block('facts', ev.accounts.length || ev.facts.length || ev.candidates.length ? facts : para(pl.links.noFacts))}${block(
    'computed',
    computed,
  )}${judgementsBlock(view, link)}${block('inferences', inferences)}</article>`;
}

export function linksSection(view: View): SafeHtml {
  return section(
    'powiazania',
    pl.sections.links,
    join([
      para(pl.links.intro),
      overridesBlock(view),
      view.linked.length ? view.linked.map((l) => linkCard(view, l)) : para(pl.links.none, 'empty'),
    ]),
  );
}

/** Distinct rejected matches (same raw text and reason code counted once), ordered by reason and text. */
export function uniqueRejected(data: ReportData): RejectedCandidate[] {
  const seen = new Map<string, RejectedCandidate>();
  for (const r of data.rejectedCandidates) {
    const key = `${reasonCode(r.reason)}|${r.raw}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()].toSorted((a, b) => cmp(reasonCode(a.reason), reasonCode(b.reason)) || cmp(a.raw, b.raw));
}

const reasonCode = (reason: string): string => (reason.split(':')[0] ?? '').trim();

function nonAscii(raw: string): string {
  const points = [...new Set([...raw].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7e))];
  return points.map((ch) => `${codePoint(ch.codePointAt(0) ?? 0)} (${ch})`).join(', ');
}

/**
 * A4 deposit address that the subject published: a KYC lead. Only the analytics decision can say so
 * (`evidence.kycLead`, set when authorship is established); a mention alone is not authorship.
 */
export function isKycLead(e: ExclusionDecision): boolean {
  return e.ruleId === 'A4' && (e.evidence as { kycLead?: boolean } | undefined)?.kycLead === true;
}

function interactions(view: View, ref: AddressRef): number {
  const txs = new Set(
    view.data.transfers
      .filter(
        (tr) =>
          sameRef({ chain: tr.chain, address: tr.from }, ref) || sameRef({ chain: tr.chain, address: tr.to }, ref),
      )
      .map((tr) => `${tr.txHash}#${tr.index ?? ''}`),
  );
  return txs.size;
}

function tracesFacts(view: View, ref: AddressRef, withAuthor = false): SafeHtml[] {
  return [
    ...view
      .observationsFor(ref)
      .toSorted(byCapture(view))
      .map((o) => observationFact(view, o)),
    ...view
      .candidatesFor(ref)
      .toSorted(byCapture(view))
      .map((c) => candidateFact(view, c, withAuthor)),
  ];
}

/** Label provenance as a fact; `other` when the label describes another address cited by the rule. */
function labelFact(l: AddressLabel, other: boolean): SafeHtml {
  return t(other ? pl.facts.labelOther : pl.facts.label, {
    dataset: l.provenance?.datasetId ?? pl.common.unknown,
    license: l.provenance?.license ?? pl.common.unknown,
    lastmod: l.provenance?.lastmod ? formatUtc(l.provenance.lastmod) : pl.common.unknown,
    entity: l.entity,
    category: pl.categories[l.category] ?? l.category,
    ...(other ? { address: addr(l.address.address) } : {}),
  });
}

/**
 * The address type behind a decision: the classification of the address the decision's chain data was fetched on
 * (`resolved` for a candidate without an attributed EVM network), else the one whose requests the decision cites
 * (A2/A3 record the classification's fetch ids). Never chosen by list order: without either, no type is shown.
 */
function addressTypeOf(view: View, e: ExclusionDecision): AddressTypeClassification | undefined {
  const types = view.data.addressTypes ?? [];
  const ref = e.resolved ?? e.address;
  const exact = types.find((c) => sameRef(c.address, ref));
  if (exact) return exact;
  const cited = new Set(e.evidence?.fetchIds ?? []);
  return cited.size ? types.find((c) => c.fetchIds.some((id) => cited.has(id))) : undefined;
}

/** What the address type rests on: code, delegate (with its registry entry), Safe singleton, EntryPoint, proxy. */
function addressTypeDetails(c: AddressTypeClassification, e: ExclusionDecision): SafeHtml[] {
  const x = pl.addressType;
  const known = e.evidence?.delegateInfo;
  return [
    c.codeSize === 0 ? t(x.noCode) : undefined,
    c.codePrefix && c.codeSize ? t(x.code, { prefix: c.codePrefix, bytes: c.codeSize }) : undefined,
    c.delegate && known
      ? t(x.delegateKnown, {
          address: addr(c.delegate),
          kind: x.delegateKinds[known.kind] ?? known.kind,
          name: known.name,
          source: known.source,
        })
      : c.delegate
        ? t(x.delegate, { address: addr(c.delegate) })
        : undefined,
    c.safeMasterCopy ? t(x.safeMasterCopy, { address: addr(c.safeMasterCopy) }) : undefined,
    c.entryPoint ? t(x.entryPoint, { address: addr(c.entryPoint) }) : undefined,
    c.implementation ? t(x.implementation, { address: addr(c.implementation) }) : undefined,
    c.scriptType ? t(x.scriptType, { script: c.scriptType.toUpperCase() }) : undefined,
    c.failedProbe ? t(x.failedProbe, { probe: x.probes[c.failedProbe.probe] ?? c.failedProbe.probe }) : undefined,
  ].filter((d): d is SafeHtml => d !== undefined);
}

/** The address type of a rejected address with what it rests on (an entry of the card's computed results). */
function addressTypeEntries(view: View, e: ExclusionDecision): SafeHtml[] {
  const c = addressTypeOf(view, e);
  if (!c) return [];
  const details = addressTypeDetails(c, e);
  return [
    markup`${t(pl.addressType.line, { type: markup`<strong>${pl.addressTypes[c.type] ?? c.type}</strong>` })}${
      details.length ? markup`<br>${muted(join(details, '; '))}` : ''
    }`,
  ];
}

/**
 * ` · typ adresu: …` with the same details after a decision in the lists of warnings and checked addresses, so a kept
 * Safe or ERC-4337 account shows why it stayed attributable.
 */
function addressTypeSuffix(view: View, e: ExclusionDecision): SafeHtml {
  const c = addressTypeOf(view, e);
  if (!c) return markup``;
  const details = addressTypeDetails(c, e);
  return markup` · ${t(pl.addressType.short, { type: pl.addressTypes[c.type] ?? c.type })}${
    details.length ? markup`<br>${muted(join(details, '; '))}` : ''
  }`;
}

function exclusionCard(view: View, e: ExclusionDecision): SafeHtml {
  const address = e.address.address;
  const labelIds = new Set(e.evidence?.labelIds ?? []);
  const own = view.labelsFor(e.address);
  // Labels cited by the rule that describe another address (e.g. the hot wallet a deposit address forwards to).
  const cited = view.data.labels.filter((l) => labelIds.has(l.id) && !sameRef(l.address, e.address));
  const mentions = view.candidatesFor(e.address).length + view.observationsFor(e.address).length;
  const facts = list([
    ...own.map((l) => labelFact(l, false)),
    ...cited.map((l) => labelFact(l, true)),
    ...tracesFacts(view, e.address, true),
  ]);
  const count = interactions(view, e.address);
  const txHashes = e.evidence?.txHashes ?? [];
  const computed = join([
    para(
      markup`<strong>${t(pl.rejected.rule, { id: e.ruleId, name: pl.exclusionRules[e.ruleId] ?? e.ruleId })}</strong>`,
    ),
    list([
      t(pl.rejected.outcome, { outcome: pl.outcomes[e.outcome] ?? e.outcome }),
      e.relation ? t(pl.rejected.newRelation, { relation: pl.relations[e.relation] ?? e.relation }) : '',
      typeof e.evidence?.kappa === 'number' ? t(pl.rejected.kappa, { kappa: formatProbability(e.evidence.kappa) }) : '',
      txHashes.length ? t(pl.rejected.transactions, { hashes: join(txHashes.map(hash), ', ') }) : '',
      ...addressTypeEntries(view, e),
      t(pl.rejected.score, { band: bandBadge('excluded') }),
      count > 0
        ? t(pl.rejected.interactions, { count: plural(count, pl.counts.transfers) })
        : pl.rejected.noInteractions,
    ]),
    technical(t(pl.rejected.reason, { reason: e.reason, version: e.rulesVersion })),
  ]);
  const cashOuts = view.data.cashOuts.filter(
    (c) =>
      sameRef(c.address, e.address) ||
      (!!c.counterparty?.address && sameRef({ chain: c.address.chain, address: c.counterparty.address }, e.address)),
  );
  const kyc = isKycLead(e);
  const inferences = list([
    kyc ? pl.rejected.kycLead : '',
    !kyc && e.ruleId === 'A4' && mentions > 0
      ? t(pl.rejected.authorshipUnconfirmed, { mentions: plural(mentions, pl.counts.mentionsLoc) })
      : '',
    cashOuts.length ? pl.rejected.cashOutLink : '',
    ['A1', 'A2', 'A4'].includes(e.ruleId) ? pl.rejected.serviceInference : '',
  ]);
  return markup`<article class="card card-rejected" id="odrzucony-${e.id}"><h3>${addr(address)}</h3><p class="card-sub">${t(pl.links.chain, { chain: chainName(e.address.chain) })}</p>${block('facts', facts)}${block('computed', computed)}${block('inferences', inferences)}</article>`;
}

function thirdPartyCard(view: View, link: LinkAssessment): SafeHtml {
  const address = link.address.address;
  return markup`<article class="card card-rejected" id="strona-trzecia-${link.id}"><h3>${addr(address)}</h3><p class="card-sub">${t(pl.links.chain, { chain: chainName(link.address.chain) })}</p>${block('facts', list(tracesFacts(view, link.address, true)))}${block(
    'computed',
    join([
      para(t(pl.rejected.thirdPartyScore, { relation: pl.relations[link.relation] ?? link.relation })),
      para(pl.rejected.thirdPartyText),
    ]),
  )}${judgementsBlock(view, link)}${block('inferences', para(pl.rejected.thirdPartyInference))}</article>`;
}

export function rejectedSection(view: View): SafeHtml {
  const rejected = uniqueRejected(view.data);
  const c = pl.rejected.columns;
  const rows = rejected.map((r) => {
    const code = reasonCode(r.reason);
    const detail = r.reason.slice(code.length).replace(/^\s*:\s*/, '');
    const capture = view.captureById.get(r.captureId);
    const odd = nonAscii(r.raw);
    return [
      markup`${addr(r.raw)}${odd ? markup`<br>${muted(t(pl.rejected.nonAscii, { codepoints: odd }))}` : ''}`,
      markup`${pl.rejectReasons[code] ?? pl.rejectReasons['other']}${detail ? markup`<br>${muted(detail)}` : ''}${
        pl.rejectReasons[code] ? '' : markup`<br>${muted(code)}`
      }`,
      pl.textViews[r.view] ?? r.view,
      markup`${capture ? url(capture.url) : ''} ${captureRef(view, r.captureId)}`,
    ];
  });
  return section(
    'odrzucone',
    pl.sections.rejected,
    join([
      para(pl.rejected.intro),
      markup`<h3>${pl.rejected.rulesTitle}</h3>`,
      view.removing.length ? view.removing.map((e) => exclusionCard(view, e)) : para(pl.rejected.rulesNone, 'empty'),
      view.flagged.length
        ? markup`<h3>${pl.rejected.flaggedTitle}</h3>${para(pl.rejected.flaggedIntro)}${block(
            'computed',
            list(
              view.flagged.map(
                (e) =>
                  markup`${addr(e.address.address)} (${chainName(e.address.chain)}) — ${t(pl.rejected.rule, {
                    id: e.ruleId,
                    name: pl.exclusionRules[e.ruleId] ?? e.ruleId,
                  })}: ${pl.outcomes[e.outcome]}${addressTypeSuffix(view, e)}${
                    view.roleOf(e.address).kind === 'linked' ? markup` · ${pl.rejected.flaggedLinked}` : ''
                  }${technical(t(pl.rejected.reason, { reason: e.reason, version: e.rulesVersion }))}`,
              ),
            ),
          )}`
        : '',
      view.kept.length
        ? markup`<h3>${pl.rejected.keptTitle}</h3>${list(
            view.kept.map(
              (e) =>
                markup`${addr(e.address.address)} — ${t(pl.rejected.rule, {
                  id: e.ruleId,
                  name: pl.exclusionRules[e.ruleId] ?? e.ruleId,
                })}: ${pl.outcomes[e.outcome]}${addressTypeSuffix(view, e)}`,
            ),
          )}`
        : '',
      markup`<h3>${pl.rejected.thirdPartyTitle}</h3>`,
      view.thirdParty.length
        ? view.thirdParty.map((l) => thirdPartyCard(view, l))
        : para(pl.rejected.thirdPartyNone, 'empty'),
      otherJudgements(view),
      markup`<h3>${pl.rejected.candidatesTitle}</h3>`,
      rejected.length
        ? join([
            para(pl.rejected.candidatesIntro),
            block('computed', table([c.raw, c.reason, c.view, c.page], rows, 'grid compact')),
          ])
        : para(pl.rejected.candidatesNone, 'empty'),
    ]),
  );
}
