import type { CaseWithIdentifiers, RunWithProgress } from '@olcys/core';
import { useState } from 'react';
import {
  AddressText,
  Async,
  ComplianceBadge,
  DateTime,
  EmptyState,
  ErrorState,
  Icon,
  ResourceNotices,
  resourceIssue,
  RunStatusBadge,
  useDocumentTitle,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { plural, t } from '../../i18n/t.ts';
import { api, apiPaths } from '../../lib/api.ts';
import { chainName } from '../../lib/chains.ts';
import { isWalletSwap, type ChangeView, type SourceItem } from '../../lib/domain.ts';
import { formatDateTime, formatDuration } from '../../lib/format.ts';
import { Link, navigate, routePath } from '../../lib/router.tsx';
import { useJson, useList } from '../../lib/use-api.ts';

export const isActiveRun = (run: Pick<RunWithProgress, 'status'>) =>
  run.status === 'queued' || run.status === 'running';

export function CasePage({ caseId }: { caseId: string }) {
  const kase = useJson<CaseWithIdentifiers>(apiPaths.case(caseId));
  useDocumentTitle(kase.data?.title ?? pl.cases.listTitle);
  return (
    <section className="page" aria-labelledby="case-title">
      <nav aria-label={pl.app.breadcrumb} className="breadcrumb">
        <Link to={routePath({ name: 'cases' })}>{pl.cases.listTitle}</Link>
      </nav>
      <Async resource={kase} errorTitle={pl.casePage.loadError}>
        {(data) => <CaseDetail kase={data} />}
      </Async>
    </section>
  );
}

function CaseDetail({ kase }: { kase: CaseWithIdentifiers }) {
  const sources = useList<SourceItem>(apiPaths.sources);
  const byId = new Map((sources.data ?? []).map((s) => [s.id, s]));
  return (
    <>
      <ResourceNotices resources={[sources]} />
      <div className="page-head">
        <h1 id="case-title">{kase.title}</h1>
        <span className="badge tone-neutral">{pl.cases.status[kase.status] ?? kase.status}</span>
      </div>
      <p className="muted">
        {pl.casePage.created} <DateTime iso={kase.createdAt} /> · {kase.createdBy}
      </p>

      <RunsSection caseId={kase.id} />

      <section aria-labelledby="case-purpose" className="card">
        <h2 id="case-purpose">{pl.casePage.sectionPurpose}</h2>
        <dl className="facts">
          <dt>{pl.casePage.purpose}</dt>
          <dd className="prewrap">{kase.purpose}</dd>
          <dt>{pl.casePage.legalBasis}</dt>
          <dd className="prewrap">{kase.legalBasis}</dd>
        </dl>
      </section>

      <section aria-labelledby="case-identifiers" className="card">
        <h2 id="case-identifiers">{pl.casePage.sectionIdentifiers}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{pl.casePage.identifierColumns.kind}</th>
                <th scope="col">{pl.casePage.identifierColumns.value}</th>
                <th scope="col">{pl.casePage.identifierColumns.platform}</th>
                <th scope="col">{pl.casePage.identifierColumns.chain}</th>
                <th scope="col">{pl.casePage.identifierColumns.anchor}</th>
              </tr>
            </thead>
            <tbody>
              {kase.identifiers.map((identifier) => (
                <tr key={identifier.id}>
                  <td>{pl.identifierKinds[identifier.kind] ?? identifier.kind}</td>
                  <td>
                    <AddressText value={identifier.value} truncate={identifier.kind === 'crypto_address'} />
                  </td>
                  <td>{identifier.platform ?? pl.common.dash}</td>
                  <td>{identifier.chain ? chainName(identifier.chain) : pl.common.dash}</td>
                  <td>{identifier.isAnchor ? pl.common.yes : pl.common.no}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="case-scope" className="card">
        <h2 id="case-scope">{pl.casePage.sectionScope}</h2>
        <h3>{pl.casePage.enabledSources}</h3>
        <ul className="plain-list">
          {kase.scope.enabledSources.map((id) => {
            const source = byId.get(id);
            const why = kase.scope.amberJustifications[id];
            return (
              <li key={id}>
                {source ? <ComplianceBadge status={source.compliance} /> : null} {source?.name ?? id}
                {why ? <p className="hint">{t(pl.casePage.justification, { text: why })}</p> : null}
              </li>
            );
          })}
        </ul>
        <h3>{pl.casePage.chains}</h3>
        <p>{kase.scope.chains.map(chainName).join(' · ') || pl.common.dash}</p>
        <p>{t(pl.casePage.depth, { depth: kase.scope.maxPivotDepth })}</p>
      </section>
    </>
  );
}

function RunsSection({ caseId }: { caseId: string }) {
  const [pollMs, setPollMs] = useState<number | undefined>(undefined);
  const runs = useList<RunWithProgress>(apiPaths.caseRuns(caseId), { pollMs });
  const [startError, setStartError] = useState<unknown>();
  const [starting, setStarting] = useState(false);
  const items = [...(runs.data ?? [])].toSorted((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  const active = items.some(isActiveRun);
  const wantedPoll = active ? 2000 : undefined;
  if (wantedPoll !== pollMs) setPollMs(wantedPoll);

  const start = async () => {
    setStarting(true);
    setStartError(undefined);
    try {
      const run = await api.post<RunWithProgress>(apiPaths.caseRuns(caseId), { trigger: 'manual' });
      navigate(routePath({ name: 'run', caseId, runId: run.id, tab: 'overview' }));
    } catch (error) {
      setStartError(error);
      setStarting(false);
    }
  };

  return (
    <section aria-labelledby="case-runs" className="card">
      <div className="section-head">
        <h2 id="case-runs">{pl.casePage.sectionRuns}</h2>
        <button type="button" className="button primary" onClick={() => void start()} disabled={starting || active}>
          {starting ? pl.casePage.starting : items.length > 0 ? pl.casePage.rerun : pl.casePage.startRun}
        </button>
      </div>
      {active ? (
        <output className="hint block">
          <Icon name="clock" />
          {pl.casePage.runActive}
        </output>
      ) : null}
      {startError ? <ErrorState error={startError} /> : null}
      <Async resource={runs} isEmpty={(list) => list.length === 0} emptyText={pl.casePage.noRuns}>
        {() =>
          items.length === 0 ? (
            <EmptyState text={pl.casePage.noRuns} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{pl.casePage.runColumns.queuedAt}</th>
                    <th scope="col">{pl.casePage.runColumns.status}</th>
                    <th scope="col">{pl.casePage.runColumns.trigger}</th>
                    <th scope="col">{pl.casePage.runColumns.mode}</th>
                    <th scope="col">{pl.casePage.runColumns.duration}</th>
                    <th scope="col">{pl.casePage.runColumns.changes}</th>
                    <th scope="col">{pl.casePage.runColumns.results}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <DateTime iso={run.queuedAt} />
                      </td>
                      <td>
                        <RunStatusBadge status={run.status} />
                      </td>
                      <td>{pl.triggers[run.trigger] ?? run.trigger}</td>
                      <td>{pl.modes[run.mode] ?? run.mode}</td>
                      <td>{formatDuration(run.startedAt, run.finishedAt) || pl.common.dash}</td>
                      <td>
                        <RunAlerts run={run} />
                      </td>
                      <td>
                        <Link
                          to={routePath({ name: 'run', caseId, runId: run.id, tab: 'overview' })}
                          aria-label={t(pl.casePage.openRunLabel, { date: formatDateTime(run.queuedAt) })}
                        >
                          {pl.casePage.openRun}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Async>
    </section>
  );
}

/** Wallet-swap alerts of a finished re-run (the diff is fetched lazily per row). */
function RunAlerts({ run }: { run: RunWithProgress }) {
  const enabled = Boolean(run.previousRunId) && !isActiveRun(run);
  const changes = useList<ChangeView>(enabled ? apiPaths.runList(run.id, 'changes') : null, {
    version: run.finishedAt ?? run.status,
  });
  if (enabled && resourceIssue(changes) === 'unavailable') {
    return (
      <button type="button" className="button ghost" onClick={changes.reload}>
        <Icon name="warn" />
        {pl.common.unavailableShort}
      </button>
    );
  }
  if (!enabled || !changes.data) return <span className="muted">{pl.common.dash}</span>;
  const alerts = changes.data.filter(isWalletSwap).length;
  const total = changes.data.length;
  return (
    <Link to={routePath({ name: 'run', caseId: run.caseId, runId: run.id, tab: 'changes' })}>
      {total}
      {alerts > 0 ? (
        <span className="badge tone-critical">
          <Icon name="warn" />
          {plural(alerts, pl.casePage.alerts)}
        </span>
      ) : null}
    </Link>
  );
}
