import type { CaseWithIdentifiers, RunWithProgress } from '@olcys/core';
import { lazy, Suspense, useState } from 'react';
import {
  Async,
  DateTime,
  Icon,
  LoadingState,
  ResourceNotices,
  RunStatusBadge,
  useDocumentTitle,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import { isWalletSwap, type ChangeView } from '../../lib/domain.ts';
import { formatDateTime, formatDuration } from '../../lib/format.ts';
import { Link, RUN_TABS, routePath, type RunTab } from '../../lib/router.tsx';
import { useJson, useList } from '../../lib/use-api.ts';
import { ActivityTab } from '../activity/ActivityTab.tsx';
import { ChangesTab } from '../changes/ChangesTab.tsx';
import { LinksTab } from '../links/LinksTab.tsx';
import { RejectedTab } from '../rejected/RejectedTab.tsx';
import { ReportTab } from '../report/ReportTab.tsx';
import { SourcesTab } from '../sources/SourcesTab.tsx';
import { OverviewTab } from './OverviewTab.tsx';
import { currentStep, isTerminal } from './run-model.ts';

// Cytoscape is large: the graph tab is fetched only when it is opened.
const GraphTab = lazy(() => import('../graph/GraphTab.tsx').then((m) => ({ default: m.GraphTab })));

/** What every result tab receives. `version` changes whenever the run's status does, so lists reload. */
export interface RunScope {
  run: RunWithProgress;
  kase: CaseWithIdentifiers | undefined;
  version: string;
}

export function RunPage({ caseId, runId, tab }: { caseId: string; runId: string; tab: RunTab }) {
  const [pollMs, setPollMs] = useState<number | undefined>(1000);
  const run = useJson<RunWithProgress>(apiPaths.run(runId), { pollMs });
  const kase = useJson<CaseWithIdentifiers>(apiPaths.case(caseId));
  const status = run.data?.status;
  const wanted = status && isTerminal(status) ? undefined : 1000;
  if (wanted !== pollMs) setPollMs(wanted);
  useDocumentTitle(`${pl.tabs[tab]} · ${kase.data?.title ?? ''}`);

  return (
    <section className="page" aria-labelledby="run-title">
      <nav aria-label={pl.app.breadcrumb} className="breadcrumb">
        <Link to={routePath({ name: 'cases' })}>{pl.cases.listTitle}</Link>
        <span aria-hidden="true"> › </span>
        <Link to={routePath({ name: 'case', caseId })}>{kase.data?.title ?? pl.common.loading}</Link>
      </nav>
      <ResourceNotices resources={[kase]} />
      <Async resource={run} errorTitle={pl.run.loadError}>
        {(data) => {
          const scope: RunScope = {
            run: data,
            kase: kase.data,
            version: `${data.status}|${data.finishedAt ?? ''}`,
          };
          return (
            <>
              <RunHeader scope={scope} />
              <nav className="tabs" aria-label={pl.tabs.label}>
                <ul>
                  {RUN_TABS.map((id) => (
                    <li key={id}>
                      <Link
                        to={routePath({ name: 'run', caseId, runId, tab: id })}
                        aria-current={id === tab ? 'page' : undefined}
                      >
                        {pl.tabs[id]}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="tab-panel">
                <TabContent tab={tab} scope={scope} />
              </div>
            </>
          );
        }}
      </Async>
    </section>
  );
}

function TabContent({ tab, scope }: { tab: RunTab; scope: RunScope }) {
  switch (tab) {
    case 'overview':
      return <OverviewTab scope={scope} />;
    case 'links':
      return <LinksTab scope={scope} />;
    case 'graph':
      return (
        <Suspense fallback={<LoadingState text={pl.graph.loading} />}>
          <GraphTab scope={scope} />
        </Suspense>
      );
    case 'rejected':
      return <RejectedTab scope={scope} />;
    case 'activity':
      return <ActivityTab scope={scope} />;
    case 'sources':
      return <SourcesTab scope={scope} />;
    case 'changes':
      return <ChangesTab scope={scope} />;
    case 'report':
      return <ReportTab scope={scope} />;
  }
}

function RunHeader({ scope }: { scope: RunScope }) {
  const { run } = scope;
  const changes = useList<ChangeView>(run.previousRunId ? apiPaths.runList(run.id, 'changes') : null, {
    version: scope.version,
  });
  const alerts = (changes.data ?? []).filter(isWalletSwap).length;
  const announcement = statusAnnouncement(run);
  return (
    <header className="run-header card">
      <div className="page-head">
        <h1 id="run-title">{t(pl.run.title, { date: formatDateTime(run.queuedAt) })}</h1>
        <RunStatusBadge status={run.status} />
      </div>
      <ul className="meta-list">
        <li>{pl.triggers[run.trigger] ?? run.trigger}</li>
        <li>{t(pl.run.mode, { mode: pl.modes[run.mode] ?? run.mode })}</li>
        {run.finishedAt ? (
          <li>{t(pl.run.duration, { value: formatDuration(run.startedAt, run.finishedAt) })}</li>
        ) : null}
        <li>
          {run.previousRunId ? (
            <Link to={routePath({ name: 'run', caseId: run.caseId, runId: run.previousRunId, tab: 'overview' })}>
              {pl.run.previous}
            </Link>
          ) : (
            pl.run.firstRun
          )}
        </li>
        <li>
          <DateTime iso={run.startedAt ?? run.queuedAt} />
        </li>
      </ul>
      {alerts > 0 ? (
        <Link className="alert-link" to={routePath({ name: 'run', caseId: run.caseId, runId: run.id, tab: 'changes' })}>
          <Icon name="warn" />
          {t(pl.run.alertBadge, { count: alerts })}
        </Link>
      ) : null}
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </header>
  );
}

/** Polite live-region text: the current stage while running, the final status once finished. */
function statusAnnouncement(run: RunWithProgress): string {
  if (isTerminal(run.status)) return t(pl.run.live.finished, { status: pl.runStatus[run.status] });
  const step = currentStep(run);
  return step ? t(pl.run.live.stage, { stage: pl.steps[step as keyof typeof pl.steps] ?? step }) : '';
}
