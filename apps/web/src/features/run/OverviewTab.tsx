import type { Capture, EgressLogEntry, RunStep } from '@olcys/core';
import { renderPartialReason } from '@olcys/core';
import {
  CaptureStatusBadge,
  HashText,
  Icon,
  KindBlock,
  ResourceNotices,
  resourceIssue,
  Verbatim,
  type IconName,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import {
  isRejectedLink,
  isRejectingDecision,
  isWalletSwap,
  keyOf,
  type CashOutView,
  type ChangeView,
  type ExclusionView,
  type LinkView,
  type SourceItem,
} from '../../lib/domain.ts';
import { formatInteger, formatPln, sumDecimals } from '../../lib/format.ts';
import { Link, routePath, type RunTab } from '../../lib/router.tsx';
import { useList, type Resource } from '../../lib/use-api.ts';
import type { RunScope } from './RunPage.tsx';
import {
  currentStep,
  egressSummary,
  isTerminal,
  partialReasons,
  progressCounters,
  progressRatio,
  RUN_STEP_ORDER,
  stepStates,
  summariseSources,
  type StepState,
} from './run-model.ts';

const STEP_ICON: Record<StepState, IconName> = { pending: 'dot', running: 'clock', done: 'check', failed: 'cross' };

export function OverviewTab({ scope }: { scope: RunScope }) {
  const { run } = scope;
  const states = stepStates(run);
  const ratio = progressRatio(run);
  const step = currentStep(run);
  const counters = progressCounters(run);
  const partial = partialReasons(run);
  return (
    <div className="stack">
      <section aria-labelledby="progress-title" className="card">
        <h2 id="progress-title">{pl.overview.progressTitle}</h2>
        <p>
          <label htmlFor="run-progress">{t(pl.overview.progress, { done: ratio.done, total: ratio.total })}</label>
        </p>
        <progress id="run-progress" max={ratio.total} value={ratio.done} aria-label={pl.overview.progressLabel} />
        {step && !isTerminal(run.status) ? (
          <p>{t(pl.overview.current, { step: lookup(pl.steps, step) ?? step })}</p>
        ) : null}
        <ol className="steps">
          {RUN_STEP_ORDER.map((id: RunStep) => (
            <li key={id} className={`step step-${states[id]}`}>
              <Icon name={STEP_ICON[states[id]]} />
              <span>{pl.steps[id]}</span>
              <span className="step-state">{pl.stepState[states[id]]}</span>
            </li>
          ))}
        </ol>
        {run.status === 'failed' ? (
          <div className="state state-error" role="alert">
            <p>
              <Icon name="warn" />
              {pl.overview.failed}
            </p>
            {run.error ? (
              <details>
                <summary>{pl.common.technical}</summary>
                <Verbatim>{run.error}</Verbatim>
              </details>
            ) : null}
          </div>
        ) : null}
        {partial.length > 0 ? (
          <div className="notice">
            <p>
              <Icon name="warn" />
              {pl.overview.partial}
            </p>
            <ul>
              {partial.map((reason) => (
                <li key={reason.text}>
                  {reason.code && pl.overview.partialReasons[reason.code] ? (
                    renderPartialReason(reason, pl.overview.partialReasons, {
                      item: pl.overview.partialItem,
                      labels: { status: pl.overview.partialStatuses },
                    })
                  ) : (
                    <Verbatim>{reason.text}</Verbatim>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {counters.length > 0 ? (
          <dl className="counters" aria-label={pl.overview.counters}>
            {counters.map(([key, value]) => (
              <div key={key}>
                <dt>{lookup(pl.overview.counterLabels, key) ?? <Verbatim>{key}</Verbatim>}</dt>
                <dd>{formatInteger(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>
      <ResultSummary scope={scope} />
      <SourcesSummary scope={scope} />
      <Reproducibility scope={scope} />
    </div>
  );
}

function ResultTile({
  label,
  value,
  detail,
  tab,
  scope,
}: {
  label: string;
  value: string;
  detail?: string;
  tab: RunTab;
  scope: RunScope;
}) {
  return (
    <li className="tile">
      <Link to={routePath({ name: 'run', caseId: scope.run.caseId, runId: scope.run.id, tab })}>
        <span className="tile-label">{label}</span>
        <span className="tile-value">{value}</span>
        {detail ? <span className="tile-detail">{detail}</span> : null}
      </Link>
    </li>
  );
}

/** A count from a list that could not be read is "read error", never 0. */
const shown = (resource: Resource<unknown>, value: string) =>
  resourceIssue(resource) === 'unavailable' ? pl.common.unavailableShort : value;

function ResultSummary({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const done = isTerminal(run.status);
  const id = done ? run.id : null;
  const links = useList<LinkView>(id && apiPaths.runList(id, 'links'), { version });
  const exclusions = useList<ExclusionView>(id && apiPaths.runList(id, 'exclusions'), { version });
  const cashOuts = useList<CashOutView>(id && apiPaths.runList(id, 'cash-outs'), { version });
  const captures = useList<Capture>(id && apiPaths.runList(id, 'captures'), { version });
  const changes = useList<ChangeView>(id && run.previousRunId ? apiPaths.runList(id, 'changes') : null, { version });
  if (!done) {
    return (
      <section aria-labelledby="result-title" className="card">
        <h2 id="result-title">{pl.overview.resultTitle}</h2>
        <p className="muted">{pl.overview.resultPending}</p>
      </section>
    );
  }
  const excluded = new Set((exclusions.data ?? []).filter(isRejectingDecision).map((d) => keyOf(d.address)));
  const main = (links.data ?? []).filter((l) => !isRejectedLink(l, excluded));
  const rejected = new Set([
    ...excluded,
    ...(links.data ?? []).filter((l) => isRejectedLink(l, excluded)).map((l) => keyOf(l.address)),
  ]);
  const plnValues = (cashOuts.data ?? []).flatMap((e) => {
    const pln = e.valuation?.pln ?? e.plnTotal;
    return pln ? [pln] : [];
  });
  const alerts = (changes.data ?? []).filter(isWalletSwap).length;
  return (
    <section aria-labelledby="result-title" className="card">
      <KindBlock kind="computed" title={pl.overview.resultTitle}>
        <ul className="tiles">
          <ResultTile
            scope={scope}
            tab="links"
            label={pl.overview.resultLinks}
            value={shown(links, formatInteger(main.length))}
            detail={t(pl.overview.resultLinksDetail, { high: main.filter((l) => l.score >= 60).length })}
          />
          <ResultTile
            scope={scope}
            tab="rejected"
            label={pl.overview.resultRejected}
            value={shown(exclusions, shown(links, formatInteger(rejected.size)))}
          />
          <ResultTile
            scope={scope}
            tab="activity"
            label={pl.overview.resultCashOut}
            value={shown(cashOuts, formatInteger(cashOuts.data?.length ?? 0))}
            detail={plnValues.length > 0 ? formatPln(sumDecimals(plnValues)) : undefined}
          />
          <ResultTile
            scope={scope}
            tab="sources"
            label={pl.overview.resultCaptures}
            value={shown(captures, formatInteger(captures.data?.length ?? 0))}
          />
          {run.previousRunId ? (
            <ResultTile
              scope={scope}
              tab="changes"
              label={pl.overview.resultChanges}
              value={shown(changes, formatInteger(changes.data?.length ?? 0))}
              detail={alerts > 0 ? t(pl.run.alertBadge, { count: alerts }) : undefined}
            />
          ) : null}
        </ul>
      </KindBlock>
      <ResourceNotices resources={[links, exclusions, cashOuts, captures, changes]} />
    </section>
  );
}

function SourcesSummary({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  // Refreshed every few seconds while the run is in progress, so sources appear as they are collected.
  const pollMs = isTerminal(run.status) ? undefined : 3000;
  const captures = useList<Capture>(apiPaths.runList(run.id, 'captures'), { version, pollMs });
  const egress = useList<EgressLogEntry>(apiPaths.runList(run.id, 'egress'), { version, pollMs });
  const sources = useList<SourceItem>(apiPaths.sources);
  const names = new Map((sources.data ?? []).map((s) => [s.id, s.name]));
  const summaries = summariseSources(captures.data ?? [], egress.data ?? []);
  const available = summaries.filter((s) => !s.unavailable);
  const unavailable = summaries.filter((s) => s.unavailable);
  const totals = egressSummary(egress.data ?? []);
  const table = (rows: typeof summaries) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">{pl.overview.sourceColumns.source}</th>
            <th scope="col">{pl.overview.sourceColumns.outcome}</th>
            <th scope="col">{pl.overview.sourceColumns.captures}</th>
            <th scope="col">{pl.overview.sourceColumns.requests}</th>
            <th scope="col">{pl.overview.sourceColumns.disclosed}</th>
            <th scope="col">{pl.overview.sourceColumns.denied}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sourceId}>
              <th scope="row">{names.get(row.sourceId) ?? row.sourceId}</th>
              <td>
                {Object.entries(row.statuses).map(([status, count]) => (
                  <span key={status} className="nowrap">
                    <CaptureStatusBadge status={status as Capture['status']} /> {count}{' '}
                  </span>
                ))}
              </td>
              <td>{formatInteger(row.captures)}</td>
              <td>{formatInteger(row.requests)}</td>
              <td>{formatInteger(row.disclosed)}</td>
              <td>{formatInteger(row.denied)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <section aria-labelledby="sources-summary-title" className="card">
      <h2 id="sources-summary-title">{pl.overview.sourcesTitle}</h2>
      <ResourceNotices resources={[captures, egress, sources]} />
      {summaries.length === 0 ? <p className="muted">{pl.overview.noSources}</p> : table(available)}
      {unavailable.length > 0 ? (
        <div className="notice">
          <h3>
            <Icon name="lock" />
            {pl.overview.unavailableTitle}
          </h3>
          <p className="hint">{pl.overview.unavailableHint}</p>
          {table(unavailable)}
        </div>
      ) : null}
      {egress.data ? (
        <p className="muted">
          {t(pl.egress.summary, totals)}{' '}
          <Link to={routePath({ name: 'run', caseId: run.caseId, runId: run.id, tab: 'sources' })}>
            {pl.egress.title}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function Reproducibility({ scope }: { scope: RunScope }) {
  const { config } = scope.run;
  return (
    <section aria-labelledby="repro-title" className="card">
      <h2 id="repro-title">{pl.overview.reproTitle}</h2>
      <dl className="facts">
        <dt>{pl.overview.repro.toolVersion}</dt>
        <dd>
          <Verbatim>{config.toolVersion}</Verbatim>
        </dd>
        {config.gitCommit ? (
          <>
            <dt>{pl.overview.repro.gitCommit}</dt>
            <dd>
              <HashText value={config.gitCommit} />
            </dd>
          </>
        ) : null}
        <dt>{pl.overview.repro.sourcesSha}</dt>
        <dd>
          <HashText value={config.sourcesConfigSha256} />
        </dd>
        <dt>{pl.overview.repro.weights}</dt>
        <dd>
          <Verbatim>{config.weightsVersion}</Verbatim>
        </dd>
        <dt>{pl.overview.repro.weightsSha}</dt>
        <dd>
          <HashText value={config.weightsSha256} />
        </dd>
        <dt>{pl.overview.repro.rules}</dt>
        <dd>
          <Verbatim>{Object.values(config.rulesVersions ?? {}).join(' · ')}</Verbatim>
        </dd>
        <dt>{pl.overview.repro.llm}</dt>
        <dd>{config.llm ? <Verbatim>{config.llm.model}</Verbatim> : pl.overview.repro.llmNone}</dd>
      </dl>
    </section>
  );
}
