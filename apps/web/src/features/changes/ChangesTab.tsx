import type { Capture, RunWithProgress, SourceId } from '@olcys/core';
import { CaptureCard } from '../../components/evidence.tsx';
import {
  Async,
  CopyButton,
  EmptyState,
  Icon,
  KindBlock,
  LoadingState,
  ResourceNotices,
  Verbatim,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, plural, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import type { ChangeView, SourceItem } from '../../lib/domain.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useJson, useList } from '../../lib/use-api.ts';
import type { RunScope } from '../run/RunPage.tsx';
import { UNAVAILABLE_STATUSES } from '../run/run-model.ts';
import { PageTimelinePanel } from './PageTimeline.tsx';
import { CHANGE_KIND_ORDER, diffParts, groupChanges, type DiffPart } from './changes-model.ts';

const propertyLabel = (property: string) => lookup(pl.changes.properties, property);
const platformLabel = (platform: string, names: ReadonlyMap<string, string>) =>
  platform === 'link' ? pl.changes.linkScore : (names.get(platform) ?? platform);

export function ChangesTab({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const previous = useJson<RunWithProgress>(run.previousRunId ? apiPaths.run(run.previousRunId) : null);
  const changes = useList<ChangeView>(run.previousRunId ? apiPaths.runList(run.id, 'changes') : null, { version });
  const captures = useList<Capture>(apiPaths.runList(run.id, 'captures'), { version });
  const sources = useList<SourceItem>(apiPaths.sources);
  const names = new Map((sources.data ?? []).map((s) => [s.id, s.name]));

  const unavailable: SourceId[] = [
    ...new Set((captures.data ?? []).filter((c) => UNAVAILABLE_STATUSES.includes(c.status)).map((c) => c.sourceId)),
  ];

  return (
    <section aria-labelledby="changes-title" className="stack">
      <h2 id="changes-title">{pl.changes.title}</h2>
      {!run.previousRunId ? (
        <EmptyState text={pl.changes.firstRun} />
      ) : (
        <>
          <p className="muted">
            {t(pl.changes.compared, {
              date: formatDateTime(run.queuedAt),
              prevDate: previous.data ? formatDateTime(previous.data.queuedAt) : pl.common.dash,
            })}
          </p>
          {run.trigger === 'rescore' ? <p className="notice">{pl.changes.rescoreNotice}</p> : null}
          {unavailable.length > 0 ? (
            <p className="notice">
              <Icon name="lock" />
              {t(pl.changes.unavailable, { sources: unavailable.map((id) => names.get(id) ?? id).join(', ') })}
            </p>
          ) : null}
          <ResourceNotices resources={[previous, captures, sources]} />
          <Async
            resource={changes}
            errorTitle={pl.changes.loadError}
            isEmpty={(list) => list.length === 0}
            emptyText={pl.changes.none}
          >
            {(list) => <ChangeGroups changes={list} names={names} />}
          </Async>
        </>
      )}
      <PageTimelinePanel caseId={run.caseId} version={version} />
    </section>
  );
}

function Parts({ parts }: { parts: DiffPart[] }) {
  return (
    <code className="mono break">
      {parts.map((part) =>
        part.changed ? <mark key={part.offset}>{part.text}</mark> : <span key={part.offset}>{part.text}</span>,
      )}
    </code>
  );
}

export function ChangeGroups({ changes, names }: { changes: ChangeView[]; names: ReadonlyMap<string, string> }) {
  const { alerts, byKind } = groupChanges(changes);
  return (
    <>
      {alerts.map((alert) => (
        <WalletSwapAlert key={alert.id} change={alert} names={names} />
      ))}
      {CHANGE_KIND_ORDER.map((kind) => {
        const items = byKind[kind];
        if (items.length === 0) return null;
        return (
          <section key={kind} aria-labelledby={`changes-${kind}`} className="card">
            <h3 id={`changes-${kind}`}>
              {pl.changes.kinds[kind]} <span className="muted">({plural(items.length, pl.changes.count)})</span>
            </h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{pl.changes.columns.where}</th>
                    <th scope="col">{pl.changes.columns.property}</th>
                    <th scope="col">{pl.changes.columns.before}</th>
                    <th scope="col">{pl.changes.columns.after}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((change) => (
                    <tr key={change.id}>
                      <td className="break">
                        {platformLabel(change.key.platform, names)} <Verbatim>{change.key.locator}</Verbatim>
                      </td>
                      <td>{propertyLabel(change.key.property) ?? <Verbatim>{change.key.property}</Verbatim>}</td>
                      {kind === 'SCORE_CHANGED' ? (
                        <td colSpan={2}>
                          {t(pl.changes.score, {
                            before: change.scoreBefore ?? change.before ?? pl.common.dash,
                            after: change.scoreAfter ?? change.after ?? pl.common.dash,
                            cause: change.cause ? pl.changes.causes[change.cause] : pl.common.notAvailable,
                          })}
                        </td>
                      ) : (
                        <>
                          <td className="break">
                            {change.before ? <Verbatim>{change.before}</Verbatim> : pl.common.dash}
                          </td>
                          <td className="break">
                            {change.after ? <Verbatim>{change.after}</Verbatim> : pl.common.dash}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

function WalletSwapAlert({ change, names }: { change: ChangeView; names: ReadonlyMap<string, string> }) {
  const parts = diffParts(change.before ?? '', change.after ?? '');
  const id = `alert-${change.id}`;
  return (
    <section className="alert-card" aria-labelledby={id} role="alert">
      <h3 id={id}>
        <Icon name="warn" />
        {pl.changes.alertTitle}
      </h3>
      <p>
        {t(pl.changes.alertWhere, {
          platform: platformLabel(change.key.platform, names),
          property: propertyLabel(change.key.property) ?? change.key.property,
          locator: change.key.locator,
        })}
      </p>
      <KindBlock kind="fact" headingLevel={4}>
        <dl className="facts">
          <dt>{pl.changes.before}</dt>
          <dd>
            <Parts parts={parts.before} /> <CopyButton value={change.before ?? ''} />
          </dd>
          <dt>{pl.changes.after}</dt>
          <dd>
            <Parts parts={parts.after} /> <CopyButton value={change.after ?? ''} />
          </dd>
        </dl>
        <div className="snapshots">
          <Snapshot title={pl.changes.snapshotBefore} captureId={change.beforeCaptureId} names={names} />
          <Snapshot title={pl.changes.snapshotAfter} captureId={change.afterCaptureId} names={names} />
        </div>
      </KindBlock>
    </section>
  );
}

function Snapshot({
  title,
  captureId,
  names,
}: {
  title: string;
  captureId: string | undefined;
  names: ReadonlyMap<string, string>;
}) {
  const capture = useJson<Capture>(captureId ? apiPaths.capture(captureId) : null);
  return (
    <div className="snapshot">
      <h4>{title}</h4>
      {!captureId || capture.error ? (
        <p className="muted">{pl.changes.snapshotMissing}</p>
      ) : !capture.data ? (
        <LoadingState />
      ) : (
        <ul className="plain-list">
          <CaptureCard capture={capture.data} sourceName={names.get(capture.data.sourceId)} />
        </ul>
      )}
    </div>
  );
}
