import type {
  AddressCandidate,
  AddressLabel,
  Capture,
  ExclusionRuleId,
  ExtractionResult,
  Observation,
  OnlineAccount,
} from '@olcys/core';
import { CandidateSnippet } from '../../components/evidence.tsx';
import {
  AddressText,
  DateTime,
  EmptyState,
  ErrorState,
  Icon,
  KindBlock,
  LoadingState,
  ResourceNotices,
  resourceIssue,
  StaleNotice,
  Verbatim,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import { chainName } from '../../lib/chains.ts';
import {
  isRejectedLink,
  isRejectingDecision,
  isWeakIdentity,
  keyOf,
  type CashOutView,
  type ExclusionView,
  type LinkView,
} from '../../lib/domain.ts';
import { formatNumber, formatProbability } from '../../lib/format.ts';
import { Link, routePath } from '../../lib/router.tsx';
import { useList, useOptionalList } from '../../lib/use-api.ts';
import type { RunScope } from '../run/RunPage.tsx';
import {
  describeMentions,
  nonAsciiCodepoints,
  reasonCode,
  rejectedCandidates,
  splitNonAscii,
  type MentionView,
} from './rejected-model.ts';

const OUTCOME_TONE: Record<ExclusionView['outcome'], string> = {
  excluded: 'critical',
  reclassified: 'warning',
  kept: 'good',
  flagged: 'warning',
};

export function RejectedTab({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const exclusions = useList<ExclusionView>(apiPaths.runList(run.id, 'exclusions'), { version });
  const links = useList<LinkView>(apiPaths.runList(run.id, 'links'), { version });
  const captures = useList<Capture>(apiPaths.runList(run.id, 'captures'), { version });
  const candidates = useList<AddressCandidate>(apiPaths.runList(run.id, 'candidates'), { version });
  const accounts = useList<OnlineAccount>(apiPaths.runList(run.id, 'accounts'), { version });
  const observations = useList<Observation>(apiPaths.runList(run.id, 'observations'), { version });
  const cashOuts = useList<CashOutView>(apiPaths.runList(run.id, 'cash-outs'), { version });
  const extractions = useOptionalList<ExtractionResult>(apiPaths.runList(run.id, 'extractions'), { version });
  const labels = useOptionalList<AddressLabel>(apiPaths.labels);

  const missing = [exclusions, links].find((r) => r.data === undefined && r.error);
  if (missing) return <ErrorState title={pl.rejected.loadError} error={missing.error} onRetry={missing.reload} />;
  if (!exclusions.data || !links.data) return <LoadingState />;

  const decisions = [...exclusions.data].toSorted(
    (a, b) => a.ruleId.localeCompare(b.ruleId) || a.address.address.localeCompare(b.address.address),
  );
  const ruleDecisions = decisions.filter((d) => d.outcome !== 'kept');
  const kept = decisions.filter((d) => d.outcome === 'kept');
  const decided = new Set(decisions.map((d) => keyOf(d.address)));
  const excluded = new Set(decisions.filter(isRejectingDecision).map((d) => keyOf(d.address)));
  const relationLinks = links.data
    .filter((l) => isRejectedLink(l, excluded) && !decided.has(keyOf(l.address)))
    .toSorted((a, b) => b.score - a.score);
  const weak = links.data
    .filter((l) => !isRejectedLink(l, excluded) && isWeakIdentity(l))
    .toSorted((a, b) => b.score - a.score);
  const rejected = rejectedCandidates(extractions.data ?? []);
  const captureById = new Map((captures.data ?? []).map((c) => [c.id, c]));
  const accountById = new Map((accounts.data ?? []).map((a) => [a.id, a]));
  const labelList = labels.data ?? [];

  const subjectHandles = new Set(
    [
      ...(scope.kase?.identifiers ?? []).map((i) => i.value),
      ...links.data
        .filter((l) => !isRejectedLink(l, excluded))
        .flatMap((l) => l.paths.map((p) => (p.accountId ? accountById.get(p.accountId)?.handle : undefined))),
    ]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase()),
  );
  const mentionsOf = (key: string) =>
    describeMentions(
      (candidates.data ?? []).filter((c) => keyOf(c.address) === key),
      observations.data ?? [],
      accounts.data ?? [],
      captureById,
      subjectHandles,
    );
  const labelsOf = (decision: ExclusionView) =>
    labelList.filter(
      (label) =>
        decision.evidence.labelIds?.includes(label.id) ||
        keyOf(label.address) === keyOf(decision.address) ||
        label.id === decision.evidence.forwardsTo?.labelId,
    );

  return (
    <section aria-labelledby="rejected-title" className="stack">
      <div>
        <h2 id="rejected-title">{pl.rejected.title}</h2>
        <p>{pl.rejected.intro}</p>
        <p className="muted">
          {t(pl.rejected.summary, {
            rules: ruleDecisions.length,
            relations: relationLinks.length,
            weak: weak.length,
            candidates: rejected.length,
          })}
        </p>
      </div>
      <ResourceNotices
        resources={[exclusions, links, captures, candidates, accounts, observations, cashOuts, labels]}
      />

      <section aria-labelledby="rej-rules" className="stack">
        <h3 id="rej-rules">{pl.rejected.sections.rules}</h3>
        {ruleDecisions.length === 0 ? (
          <EmptyState text={pl.rejected.empty.rules} />
        ) : (
          <ul className="plain-list stack">
            {ruleDecisions.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                labels={labelsOf(decision)}
                mentions={mentionsOf(keyOf(decision.address))}
                captures={captureById}
                cashOuts={(cashOuts.data ?? []).filter(
                  (e) =>
                    e.exclusionDecisionId === decision.id ||
                    (decision.ruleId === 'A4' && keyOf(e.address) === keyOf(decision.address)),
                )}
                scope={scope}
              />
            ))}
          </ul>
        )}
      </section>

      <details className="card">
        <summary>
          {pl.rejected.sections.kept} ({kept.length})
        </summary>
        {kept.length === 0 ? (
          <EmptyState text={pl.rejected.empty.kept} />
        ) : (
          <ul className="plain-list stack">
            {kept.map((decision) => (
              <DecisionCard
                key={decision.id}
                decision={decision}
                labels={labelsOf(decision)}
                mentions={[]}
                captures={captureById}
                cashOuts={[]}
                scope={scope}
              />
            ))}
          </ul>
        )}
      </details>

      <section aria-labelledby="rej-relations" className="stack">
        <h3 id="rej-relations">{pl.rejected.sections.relations}</h3>
        {relationLinks.length === 0 ? (
          <EmptyState text={pl.rejected.empty.relations} />
        ) : (
          <ul className="plain-list stack">
            {relationLinks.map((link) => (
              <li key={link.id} className="card rejected-card">
                <p className="card-head">
                  <AddressText value={link.address.address} /> <span>{chainName(link.address.chain)}</span>{' '}
                  <span className="badge tone-critical">
                    <Icon name="ban" />
                    {lookup(pl.relations, link.relation) ?? link.relation}
                  </span>
                </p>
                <KindBlock kind="computed" headingLevel={4}>
                  <p>
                    {Object.hasOwn(pl.rejected.relationText, link.relation)
                      ? pl.rejected.relationText[link.relation as keyof typeof pl.rejected.relationText]
                      : pl.rejected.relationText.other}
                  </p>
                  {link.ungated ? (
                    <p className="muted small">
                      {t(pl.score.ungated, {
                        score: link.ungated.score,
                        term: lookup(pl.icd203, link.ungated.icd203) ?? link.ungated.icd203,
                      })}
                    </p>
                  ) : null}
                </KindBlock>
                <Mentions mentions={mentionsOf(keyOf(link.address))} captures={captureById} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="rej-weak" className="stack">
        <h3 id="rej-weak">{pl.rejected.sections.weakIdentity}</h3>
        <p className="muted">{pl.rejected.weakIntro}</p>
        {weak.length === 0 ? (
          <EmptyState text={pl.rejected.empty.weakIdentity} />
        ) : (
          <ul className="plain-list stack">
            {weak.map((link) => {
              const path = [...link.paths].toSorted((a, b) => b.probability - a.probability)[0];
              const account = path?.accountId ? accountById.get(path.accountId) : undefined;
              return (
                <li key={link.id} className="card rejected-card">
                  <p className="card-head">
                    <AddressText value={link.address.address} /> <span>{chainName(link.address.chain)}</span>
                  </p>
                  <KindBlock kind="computed" headingLevel={4}>
                    <p>
                      {t(pl.rejected.weakText, {
                        platform: account?.platform ?? pl.common.notAvailable,
                        handle: account?.handle ?? pl.common.notAvailable,
                        pIdentity: formatProbability(path?.identityHop.probability ?? 0),
                        pAddress: formatProbability(path?.addressHop.probability ?? 0),
                        score: link.score,
                        term: lookup(pl.icd203, link.icd203) ?? link.icd203,
                      })}
                    </p>
                  </KindBlock>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="rej-candidates" className="stack">
        <h3 id="rej-candidates">{pl.rejected.sections.candidates}</h3>
        {resourceIssue(extractions) === 'stale' ? <StaleNotice resource={extractions} /> : null}
        {resourceIssue(extractions) === 'unavailable' ? (
          <ErrorState title={pl.common.unavailable} error={extractions.error} onRetry={extractions.reload} />
        ) : rejected.length === 0 ? (
          <EmptyState text={pl.rejected.empty.candidates} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{pl.rejected.candidateColumns.raw}</th>
                  <th scope="col">{pl.rejected.candidateColumns.reason}</th>
                  <th scope="col">{pl.rejected.candidateColumns.view}</th>
                  <th scope="col">{pl.rejected.candidateColumns.page}</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((candidate) => {
                  const code = reasonCode(candidate.reason);
                  const known = lookup(pl.rejected.reasons, code);
                  const codepoints = nonAsciiCodepoints(candidate.raw);
                  return (
                    <tr key={`${candidate.captureId}-${candidate.raw}-${code}`}>
                      <td>
                        <code className="mono break">
                          {splitNonAscii(candidate.raw).map((part) =>
                            part.nonAscii ? (
                              <mark key={part.offset}>{part.text}</mark>
                            ) : (
                              <span key={part.offset}>{part.text}</span>
                            ),
                          )}
                        </code>
                        {codepoints.length > 0 ? (
                          <p className="small">
                            <Icon name="warn" />
                            {t(pl.rejected.nonAscii, { codepoints: codepoints.join(', ') })}
                          </p>
                        ) : null}
                      </td>
                      <td>
                        {known ?? pl.rejected.reasons['other']}
                        {!known || candidate.reason !== code ? (
                          <details>
                            <summary>{pl.common.technical}</summary>
                            <Verbatim>{candidate.reason}</Verbatim>
                          </details>
                        ) : null}
                      </td>
                      <td>{lookup(pl.textViews, candidate.view) ?? candidate.view}</td>
                      <td>
                        {captureById.get(candidate.captureId) ? (
                          <AddressText value={captureById.get(candidate.captureId)?.url ?? ''} truncate />
                        ) : (
                          <Verbatim>{candidate.captureId}</Verbatim>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

/** Where the address was mentioned (facts): source page, author and whether it is a third party's statement. */
export function Mentions({
  mentions,
  captures,
}: {
  mentions: readonly MentionView[];
  captures: ReadonlyMap<string, Capture>;
}) {
  if (mentions.length === 0) return null;
  return (
    <KindBlock kind="fact" title={pl.rejected.mentionedIn} headingLevel={4}>
      <ul className="plain-list stack">
        {mentions.map(({ candidate, author, thirdParty }) => {
          const capture = captures.get(candidate.captureId);
          const cues = candidate.context.roleCues.map((cue) => lookup(pl.roleCues, cue) ?? cue);
          return (
            <li key={candidate.id}>
              {capture ? (
                <p className="small">
                  <AddressText value={capture.url} truncate /> · <DateTime iso={capture.collectedAt} />
                </p>
              ) : null}
              <p className="small">
                {author ? t(pl.rejected.mentionAuthor, { author }) : pl.rejected.mentionAuthorUnknown}{' '}
                {thirdParty ? (
                  <span className="badge tone-warning">
                    <Icon name="warn" />
                    {pl.rejected.mentionThirdParty}
                  </span>
                ) : null}
              </p>
              {cues.length > 0 ? <p className="muted small">{t(pl.rejected.cues, { cues: cues.join(', ') })}</p> : null}
              <CandidateSnippet candidate={candidate} />
            </li>
          );
        })}
      </ul>
    </KindBlock>
  );
}

export function DecisionCard({
  decision,
  labels,
  mentions,
  captures,
  cashOuts,
  scope,
}: {
  decision: ExclusionView;
  labels: AddressLabel[];
  mentions: MentionView[];
  captures: ReadonlyMap<string, Capture>;
  cashOuts: CashOutView[];
  scope: RunScope;
}) {
  const ruleTitle = lookup(pl.rejected.rules, decision.ruleId) ?? decision.ruleId;
  const { evidence } = decision;
  const isDeposit = decision.ruleId === ('A4' satisfies ExclusionRuleId);
  const activityPath = (eventId: string) =>
    `${routePath({ name: 'run', caseId: scope.run.caseId, runId: scope.run.id, tab: 'activity' })}?adres=${encodeURIComponent(keyOf(decision.address))}#cashout-${eventId}`;
  return (
    <li className="card rejected-card" id={`exclusion-${decision.id}`}>
      <p className="card-head">
        <AddressText value={decision.address.address} /> <span>{chainName(decision.address.chain)}</span>{' '}
        <span className={`badge tone-${OUTCOME_TONE[decision.outcome] ?? 'neutral'}`}>
          <Icon name={decision.outcome === 'kept' ? 'check' : 'ban'} />
          {pl.rejected.outcomes[decision.outcome] ?? decision.outcome}
        </span>
      </p>
      <KindBlock kind="computed" title={`${decision.ruleId}: ${ruleTitle}`} headingLevel={4}>
        <dl className="facts compact">
          {decision.relation ? (
            <>
              <dt>{pl.rejected.fields.newRelation}</dt>
              <dd>{lookup(pl.relations, decision.relation) ?? decision.relation}</dd>
            </>
          ) : null}
          {evidence.kappa !== undefined ? (
            <>
              <dt>{pl.rejected.fields.kappa}</dt>
              <dd>{formatNumber(evidence.kappa)}</dd>
            </>
          ) : null}
          {evidence.forwardsTo ? (
            <>
              <dt>{pl.rejected.fields.forwardsTo}</dt>
              <dd>
                {evidence.forwardsTo.entity} —{' '}
                {lookup(pl.categories, evidence.forwardsTo.category) ?? evidence.forwardsTo.category}
                <br />
                <AddressText value={evidence.forwardsTo.address} truncate />
              </dd>
            </>
          ) : null}
          {evidence.txHashes && evidence.txHashes.length > 0 ? (
            <>
              <dt>{pl.rejected.fields.transactions}</dt>
              <dd>
                <ul className="plain-list">
                  {evidence.txHashes.map((hash) => (
                    <li key={hash}>
                      <AddressText value={hash} truncate />
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
        {evidence.codePrefix ? (
          <p className="small">
            {t(pl.rejected.fields.code, { prefix: evidence.codePrefix, bytes: evidence.codeBytes ?? '?' })}
          </p>
        ) : null}
        {evidence.denyList ? (
          <p className="small">
            {t(pl.rejected.fields.denyList, { name: evidence.denyList.name, source: evidence.denyList.source })}
          </p>
        ) : null}
        <details>
          <summary>{pl.common.technical}</summary>
          <p className="small">{pl.rejected.fields.reason}</p>
          <Verbatim>{decision.reason}</Verbatim>
          <p className="small">
            {pl.rejected.fields.rulesVersion}: <Verbatim>{decision.rulesVersion}</Verbatim>
          </p>
        </details>
      </KindBlock>
      {labels.length > 0 ? (
        <KindBlock kind="fact" title={pl.rejected.fields.label} headingLevel={4}>
          {labels.map((label) => (
            <dl key={label.id} className="facts compact">
              <dt>{pl.rejected.fields.label}</dt>
              <dd>
                {label.entity} — {lookup(pl.categories, label.category) ?? label.category}
              </dd>
              <dt>{pl.rejected.fields.dataset}</dt>
              <dd>
                <Verbatim>{label.provenance.datasetId}</Verbatim>
              </dd>
              <dt>{pl.rejected.fields.labelUrl}</dt>
              <dd>
                <AddressText value={label.provenance.url} truncate />
              </dd>
              <dt>{pl.rejected.fields.license}</dt>
              <dd>{label.provenance.license}</dd>
              <dt>{pl.rejected.fields.lastmod}</dt>
              <dd>
                <DateTime iso={label.provenance.lastmod} />
              </dd>
              <dt>{pl.rejected.fields.retrievedAt}</dt>
              <dd>
                <DateTime iso={label.provenance.retrievedAt} />
              </dd>
              <dt>{pl.rejected.fields.confidence}</dt>
              <dd>{label.confidence}</dd>
            </dl>
          ))}
        </KindBlock>
      ) : null}
      <Mentions mentions={mentions} captures={captures} />
      {isDeposit ? (
        <KindBlock kind="inference" headingLevel={4}>
          <p>{pl.rejected.custodialNote}</p>
          {/* Only the analysis engine decides that the subject published the address (a KYC lead). */}
          {evidence.kycLead === true ? <p>{pl.rejected.kycLead}</p> : null}
          {cashOuts.map((event) => (
            <p key={event.id}>
              <Link to={activityPath(event.id)}>{pl.rejected.cashOutLink}</Link>
            </p>
          ))}
        </KindBlock>
      ) : null}
    </li>
  );
}
