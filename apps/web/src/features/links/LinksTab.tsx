import { useEffect } from 'react';
import type {
  AddressCandidate,
  AnalystOverride,
  ApiMeta,
  Capture,
  Identifier,
  Observation,
  OnlineAccount,
} from '@olcys/core';
import { CandidateSnippet, CaptureCard, ObservationLine } from '../../components/evidence.tsx';
import {
  AddressText,
  BandBadge,
  EmptyState,
  ErrorState,
  Icon,
  KindBlock,
  KindLegend,
  LoadingState,
  ResourceNotices,
  ScoreMeter,
  Verbatim,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, plural, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import { SCORE_BANDS } from '../../lib/band.ts';
import { chainName } from '../../lib/chains.ts';
import {
  isRejectedLink,
  isRejectingDecision,
  keyOf,
  linkBand,
  type ExclusionView,
  type LinkView,
  type SourceItem,
} from '../../lib/domain.ts';
import { formatDateTime, formatLikelihoodRatio, formatProbability, shortHash } from '../../lib/format.ts';
import { Link, routePath, useLocation } from '../../lib/router.tsx';
import { useJson, useList } from '../../lib/use-api.ts';
import type { RunScope } from '../run/RunPage.tsx';
import { isTerminal } from '../run/run-model.ts';
import { CaseOverrides, JudgementSection, OverrideForm } from './AnalystPanel.tsx';
import { evidenceRefs, isAnchorHop, synergyOf } from './score-model.ts';
import { ContributionTable, Waterfall } from './Waterfall.tsx';

/** Analyst actions on the links of a run, when the API supports them (`ApiMeta.features.judgements`). */
export interface AnalystScope {
  enabled: boolean;
  caseId: string;
  onOverrideSaved?: () => void;
  /** Refreshes the links (and their judgements) after a judgement was saved. */
  onJudgementSaved?: () => void;
}

interface LinkContext {
  identities: ReadonlyMap<string, Identifier>;
  accounts: ReadonlyMap<string, OnlineAccount>;
  captures: ReadonlyMap<string, Capture>;
  observations: ReadonlyMap<string, Observation>;
  candidates: ReadonlyMap<string, AddressCandidate>;
  sourceNames: ReadonlyMap<string, string>;
}

export function LinksTab({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const links = useList<LinkView>(apiPaths.runList(run.id, 'links'), { version });
  const exclusions = useList<ExclusionView>(apiPaths.runList(run.id, 'exclusions'), { version });
  const accounts = useList<OnlineAccount>(apiPaths.runList(run.id, 'accounts'), { version });
  const captures = useList<Capture>(apiPaths.runList(run.id, 'captures'), { version });
  const observations = useList<Observation>(apiPaths.runList(run.id, 'observations'), { version });
  const candidates = useList<AddressCandidate>(apiPaths.runList(run.id, 'candidates'), { version });
  const sources = useList<SourceItem>(apiPaths.sources);
  const meta = useJson<ApiMeta>(apiPaths.meta);
  const judgements = meta.data?.features.judgements === true;
  const overrides = useList<AnalystOverride>(judgements ? apiPaths.caseOverrides(run.caseId) : null, { version });
  const location = useLocation();
  const loaded = links.data !== undefined;

  // `#link-<id>` (e.g. from the graph) opens that link's explanation and scrolls to it.
  useEffect(() => {
    if (!loaded || !location.hash.startsWith('#link-')) return;
    const card = document.getElementById(location.hash.slice(1));
    const details = card?.querySelector('details.explain');
    if (details instanceof HTMLDetailsElement) details.open = true;
    card?.scrollIntoView();
  }, [loaded, location.hash]);

  if (!links.data) {
    if (links.error) return <ErrorState title={pl.links.loadError} error={links.error} onRetry={links.reload} />;
    return <LoadingState />;
  }

  const excluded = new Set((exclusions.data ?? []).filter(isRejectingDecision).map((d) => keyOf(d.address)));
  const main = links.data
    .filter((link) => !isRejectedLink(link, excluded))
    .toSorted((a, b) => b.score - a.score || a.address.address.localeCompare(b.address.address));
  const rejectedCount = new Set([
    ...excluded,
    ...links.data.filter((l) => isRejectedLink(l, excluded)).map((l) => keyOf(l.address)),
  ]).size;
  const ctx: LinkContext = {
    identities: new Map((scope.kase?.identifiers ?? []).map((i) => [i.id, i])),
    accounts: new Map((accounts.data ?? []).map((a) => [a.id, a])),
    captures: new Map((captures.data ?? []).map((c) => [c.id, c])),
    observations: new Map((observations.data ?? []).map((o) => [o.id, o])),
    candidates: new Map((candidates.data ?? []).map((c) => [c.id, c])),
    sourceNames: new Map((sources.data ?? []).map((s) => [s.id, s.name])),
  };
  const analyst: AnalystScope = {
    enabled: judgements,
    caseId: run.caseId,
    onOverrideSaved: overrides.reload,
    onJudgementSaved: links.reload,
  };

  return (
    <section aria-labelledby="links-title" className="stack">
      <div>
        <h2 id="links-title">{pl.links.title}</h2>
        <p>{pl.links.intro}</p>
        <p className="notice">
          <Icon name="info" />
          <strong>{pl.links.automationBias}</strong>
        </p>
      </div>
      <ResourceNotices resources={[links, exclusions, accounts, captures, observations, candidates, sources]} />
      {judgements ? <CaseOverrides run={run} overrides={overrides} ctx={ctx} /> : null}
      <BandLegend />
      <KindLegend />
      {main.length > 0 ? <p className="muted">{plural(main.length, pl.links.count)}</p> : null}
      {rejectedCount > 0 ? (
        <p>
          <Link to={routePath({ name: 'run', caseId: run.caseId, runId: run.id, tab: 'rejected' })}>
            {t(pl.links.rejectedNote, { count: rejectedCount, tab: pl.tabs.rejected })}
          </Link>
        </p>
      ) : null}
      {main.length === 0 ? (
        <EmptyState text={isTerminal(run.status) ? pl.links.emptyFinished : pl.links.emptyRunning} />
      ) : (
        <ol className="link-list">
          {main.map((link) => (
            <LinkCard key={link.id} link={link} ctx={ctx} excluded={excluded} analyst={analyst} />
          ))}
        </ol>
      )}
    </section>
  );
}

function BandLegend() {
  return (
    <details className="band-legend card">
      <summary>{pl.links.bandLegend}</summary>
      <ul className="plain-list">
        {SCORE_BANDS.map((band) => (
          <li key={band}>
            <BandBadge band={band} /> <span className="muted">{pl.bandHints[band]}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function identityText(identity: Identifier | undefined): { value: string; kind: string } {
  if (!identity) return { value: pl.links.unknownIdentity, kind: pl.common.notAvailable };
  const kind = pl.identifierKinds[identity.kind] ?? identity.kind;
  return { value: identity.value, kind: identity.platform ? `${kind}, ${identity.platform}` : kind };
}

export function LinkCard({
  link,
  ctx,
  excluded,
  analyst,
}: {
  link: LinkView;
  ctx: LinkContext;
  excluded: ReadonlySet<string>;
  analyst?: AnalystScope;
}) {
  const band = linkBand(link, excluded);
  const identity = identityText(ctx.identities.get(link.identityId));
  const term = lookup(pl.icd203, link.icd203) ?? link.icd203;
  const synergy = synergyOf(link, ctx.accounts);
  const titleId = `link-${link.id}-title`;
  return (
    <li className="link-card card" id={`link-${link.id}`}>
      <article aria-labelledby={titleId}>
        <header className="link-head">
          <div className="link-score">
            <span className="score-number">{link.score}</span>
            <span className="score-of">/100</span>
            <ScoreMeter score={link.score} band={band} />
            <BandBadge band={band} />
          </div>
          <div className="link-main">
            <h3 id={titleId} className="link-address">
              <AddressText value={link.address.address} />
            </h3>
            <dl className="inline-facts">
              <div>
                <dt>{pl.links.chain}</dt>
                <dd>{chainName(link.address.chain)}</dd>
              </div>
              <div>
                <dt>{pl.links.icd203}</dt>
                <dd>{term}</dd>
              </div>
              <div>
                <dt>{pl.links.identity}</dt>
                <dd>
                  <code className="mono">{identity.value}</code> <span className="muted">({identity.kind})</span>
                </dd>
              </div>
              <div>
                <dt>{pl.links.relation}</dt>
                <dd>{lookup(pl.relations, link.relation) ?? link.relation}</dd>
              </div>
              <div>
                <dt>{pl.links.tier}</dt>
                <dd>{lookup(pl.tiers, link.tier) ?? link.tier}</dd>
              </div>
            </dl>
            {synergy.independentSources.length > 0 ? (
              <p className={`chip${synergy.independentSources.length >= 2 ? ' chip-strong' : ''}`}>
                <Icon name="link" />
                {plural(synergy.independentSources.length, pl.synergy.chip)}: {synergy.independentSources.join(', ')}
              </p>
            ) : null}
          </div>
        </header>

        <KindBlock kind="inference" headingLevel={4}>
          <p>
            {t(pl.links.statement, {
              address: link.address.address,
              chain: chainName(link.address.chain),
              identity: identity.value,
              kind: identity.kind,
              term,
            })}
          </p>
          <p className="muted small">{pl.links.statementHint}</p>
        </KindBlock>
        <div className="confidence-box">
          <p>
            <strong>
              {t(pl.score.confidence, {
                level: lookup(pl.analyticConfidence, link.analyticConfidence) ?? link.analyticConfidence,
              })}
            </strong>
          </p>
          <p className="muted small">{pl.score.confidenceHint}</p>
        </div>
        <JudgementSection
          link={link}
          enabled={analyst?.enabled ?? false}
          {...(analyst?.onJudgementSaved ? { onSaved: analyst.onJudgementSaved } : {})}
        />

        <details className="explain">
          <summary>{pl.links.explain}</summary>
          <ScoreExplanation link={link} ctx={ctx} />
          <LinkEvidence link={link} ctx={ctx} />
          {analyst?.enabled ? (
            <OverrideForm
              link={link}
              ctx={ctx}
              caseId={analyst.caseId}
              {...(analyst.onOverrideSaved ? { onSaved: analyst.onOverrideSaved } : {})}
            />
          ) : null}
        </details>
      </article>
    </li>
  );
}

function SynergyBox({ link, ctx }: { link: LinkView; ctx: LinkContext }) {
  const synergy = synergyOf(link, ctx.accounts);
  const sources = synergy.independentSources.join(', ');
  const text =
    synergy.independentSources.length === 0
      ? pl.synergy.none
      : synergy.independentSources.length >= 2
        ? t(pl.synergy.many, {
            count: synergy.independentSources.length,
            sources,
            bonus: synergy.bonusPoints,
            best: synergy.bestSingleScore,
          })
        : t(pl.synergy.single, { sources });
  return (
    <div className="synergy">
      <h4>
        <Icon name="link" />
        {pl.synergy.title}
      </h4>
      <p>{text}</p>
      {synergy.repeatedPaths > 0 || synergy.repeatedItems > 0 ? (
        <p className="muted small">
          {t(pl.synergy.repeats, { paths: synergy.repeatedPaths, items: synergy.repeatedItems })}
        </p>
      ) : null}
    </div>
  );
}

const enfsi = (verbal: string) => lookup(pl.enfsi, verbal) ?? verbal;

function ScoreExplanation({ link, ctx }: { link: LinkView; ctx: LinkContext }) {
  const evidenceHref = (captureId: string) => (ctx.captures.has(captureId) ? `#ev-${link.id}-${captureId}` : undefined);
  return (
    <KindBlock kind="computed" title={pl.score.computedTitle}>
      <p className="formula">{t(pl.score.formula, { p: formatProbability(link.probability), score: link.score })}</p>
      <SynergyBox link={link} ctx={ctx} />
      {link.ungated ? (
        <p className="notice">
          {t(pl.score.ungated, {
            score: link.ungated.score,
            term: lookup(pl.icd203, link.ungated.icd203) ?? link.ungated.icd203,
          })}
        </p>
      ) : null}
      {link.paths.map((path, index) => {
        const account = path.accountId ? ctx.accounts.get(path.accountId) : undefined;
        const n = index + 1;
        return (
          <section key={`${path.accountId ?? 'path'}-${n}`} className="path">
            <h4>
              {account
                ? t(pl.score.pathTitle, { n, platform: account.platform, handle: account.handle })
                : t(pl.score.pathUnknownAccount, { n })}
            </h4>
            {path.counted === false ? <p className="notice small">{pl.score.pathNotCounted}</p> : null}
            <p className="formula">
              {t(pl.score.pathFormula, {
                pIdentity: formatProbability(path.identityHop.probability),
                pAddress: formatProbability(path.addressHop.probability),
                p: formatProbability(path.probability),
              })}
            </p>
            <div className="hops">
              {[path.identityHop, path.addressHop].map((hop) => (
                <div key={hop.hop} className="hop">
                  <Waterfall
                    hop={hop}
                    title={hop.hop === 'identity' ? pl.hops.identity : pl.hops.address}
                    caption={
                      isAnchorHop(hop)
                        ? pl.score.anchorCaption
                        : t(pl.score.hopCaption, {
                            p: formatProbability(hop.probability),
                            lr: formatLikelihoodRatio(hop.likelihoodRatio),
                            enfsi: enfsi(hop.enfsiVerbal),
                          })
                    }
                  />
                  <details>
                    <summary>{pl.common.showTable}</summary>
                    <ContributionTable hop={hop} evidenceHref={evidenceHref} />
                  </details>
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {link.gates.length > 0 ? (
        <div>
          <h4>{pl.score.gates}</h4>
          <ul className="plain-list">
            {link.gates.map((gate) => (
              <li key={gate.gate}>
                <span className={`badge tone-${gate.passed ? 'good' : 'critical'}`}>
                  <Icon name={gate.passed ? 'check' : 'cross'} />
                  {gate.passed ? pl.score.gatePassed : pl.score.gateFailed}
                </span>{' '}
                {lookup(pl.gates, gate.gate) ?? t(pl.common.unknownKey, { key: gate.gate })}
                {gate.detail ? (
                  <>
                    {' '}
                    <Verbatim>{gate.detail}</Verbatim>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="muted small">
        {t(pl.score.footer, {
          algorithm: link.algorithmVersion,
          weights: link.weightsVersion,
          sha: shortHash(link.weightsSha256),
          rules: link.rulesVersion,
          at: formatDateTime(link.computedAt),
        })}
      </p>
    </KindBlock>
  );
}

function LinkEvidence({ link, ctx }: { link: LinkView; ctx: LinkContext }) {
  const refs = evidenceRefs(link);
  const observations = refs.observationIds.flatMap((id) => {
    const o = ctx.observations.get(id);
    return o ? [o] : [];
  });
  const candidates = refs.candidateIds.flatMap((id) => {
    const c = ctx.candidates.get(id);
    return c ? [c] : [];
  });
  const captureIds = new Set([
    ...refs.captureIds,
    ...observations.map((o) => o.captureId),
    ...candidates.map((c) => c.captureId),
  ]);
  const captures = [...captureIds].flatMap((id) => {
    const c = ctx.captures.get(id);
    return c ? [c] : [];
  });
  return (
    <KindBlock kind="fact" title={pl.evidence.title}>
      {captures.length === 0 ? (
        <p className="muted">{pl.evidence.none}</p>
      ) : (
        <ul className="plain-list capture-list">
          {captures.map((capture) => (
            <CaptureCard
              key={capture.id}
              capture={capture}
              id={`ev-${link.id}-${capture.id}`}
              sourceName={ctx.sourceNames.get(capture.sourceId)}
            >
              {observations
                .filter((o) => o.captureId === capture.id)
                .map((o) => (
                  <ObservationLine key={o.id} observation={o} />
                ))}
              {candidates
                .filter((c) => c.captureId === capture.id)
                .map((c) => (
                  <CandidateSnippet key={c.id} candidate={c} />
                ))}
            </CaptureCard>
          ))}
        </ul>
      )}
    </KindBlock>
  );
}
