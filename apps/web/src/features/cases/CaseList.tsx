import type { Case, RunWithProgress } from '@olcys/core';
import { Async, DateTime, Icon, resourceIssue, RunStatusBadge, useDocumentTitle } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { apiPaths } from '../../lib/api.ts';
import { Link, routePath } from '../../lib/router.tsx';
import { useList } from '../../lib/use-api.ts';

export function CaseListPage() {
  useDocumentTitle(pl.cases.listTitle);
  const cases = useList<Case>(apiPaths.cases);
  return (
    <section aria-labelledby="cases-title" className="page">
      <div className="page-head">
        <h1 id="cases-title">{pl.cases.listTitle}</h1>
        <Link className="button primary" to={routePath({ name: 'newCase' })}>
          {pl.cases.newCase}
        </Link>
      </div>
      <Async
        resource={cases}
        loadingText={pl.cases.loading}
        errorTitle={pl.cases.loadError}
        isEmpty={(items) => items.length === 0}
        emptyText={pl.cases.empty}
      >
        {(items) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{pl.cases.columns.title}</th>
                  <th scope="col">{pl.cases.columns.status}</th>
                  <th scope="col">{pl.cases.columns.purpose}</th>
                  <th scope="col">{pl.cases.columns.createdAt}</th>
                  <th scope="col">{pl.cases.columns.createdBy}</th>
                  <th scope="col">{pl.cases.columns.lastRun}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      <Link to={routePath({ name: 'case', caseId: item.id })}>{item.title}</Link>
                    </th>
                    <td>{pl.cases.status[item.status] ?? item.status}</td>
                    <td className="clamp">{item.purpose}</td>
                    <td>
                      <DateTime iso={item.createdAt} />
                    </td>
                    <td>{item.createdBy}</td>
                    <td>
                      <LastRun caseId={item.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </section>
  );
}

function LastRun({ caseId }: { caseId: string }) {
  const runs = useList<RunWithProgress>(apiPaths.caseRuns(caseId));
  const last = runs.data?.[0];
  if (resourceIssue(runs) === 'unavailable') {
    return (
      <button type="button" className="button ghost" onClick={runs.reload}>
        <Icon name="warn" />
        {pl.common.unavailableShort}
      </button>
    );
  }
  if (!runs.data) return <span className="muted">{pl.common.dash}</span>;
  if (!last) return <span className="muted">{pl.cases.noRun}</span>;
  return (
    <Link to={routePath({ name: 'run', caseId, runId: last.id, tab: 'overview' })} className="inline-status">
      <RunStatusBadge status={last.status} /> <DateTime iso={last.queuedAt} />
    </Link>
  );
}
