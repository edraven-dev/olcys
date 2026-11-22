import type { PropertyTimeline, TimelinePoint } from '@olcys/core';
import { AddressText, Async, DateTime, Icon, Verbatim } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, plural, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import { useJson } from '../../lib/use-api.ts';

const propertyLabel = (property: string) =>
  lookup(pl.changes.properties, property) ?? lookup(pl.archiveHistory.properties, property);

const gapReason = (point: TimelinePoint): string =>
  lookup(pl.archiveHistory.gapReasons, point.gapReason ?? 'ok') ?? point.gapReason ?? pl.common.notAvailable;

function Provenance({ point }: { point: TimelinePoint }) {
  return (
    <span className={`badge ${point.provenance === 'archive' ? 'tone-info' : 'tone-good'}`}>
      {pl.archiveHistory.provenance[point.provenance]}
    </span>
  );
}

/** One end of an interval or bracket: when, where it came from, and whether the date is only inferred. */
function Moment({ point }: { point: TimelinePoint }) {
  return (
    <span className="archive-moment">
      <DateTime iso={point.observedAt} /> <Provenance point={point} />
      {point.archive?.inferredFromDigest ? <span className="muted"> ({pl.archiveHistory.approximate})</span> : null}
    </span>
  );
}

function Values({ values }: { values: readonly string[] }) {
  if (values.length === 0) return <span className="muted">{pl.archiveHistory.noValue}</span>;
  return (
    <>
      {values.map((value) => (
        <div key={value}>
          <AddressText value={value} />
        </div>
      ))}
    </>
  );
}

function TimelineCard({ timeline, index }: { timeline: PropertyTimeline; index: number }) {
  const id = `archive-history-${index}`;
  const label = propertyLabel(timeline.key.property);
  const gaps = timeline.points.filter((p) => p.values === null);
  return (
    <section className="card" aria-labelledby={id}>
      <h4 id={id}>
        {pl.archiveHistory.timelineOf}: {label ?? <Verbatim>{timeline.key.property}</Verbatim>}{' '}
        <Verbatim>{timeline.key.locator}</Verbatim>
      </h4>
      <h5>{pl.archiveHistory.intervals}</h5>
      <ol className="plain-list">
        {timeline.intervals.map((interval) => (
          <li key={`${interval.from.observedAt}-${interval.from.provenance}-${interval.from.captureId ?? ''}`}>
            <Values values={interval.values} />
            <Moment point={interval.from} /> {pl.common.dash} <Moment point={interval.to} />
          </li>
        ))}
      </ol>
      {gaps.length > 0 ? (
        <ul className="plain-list">
          {gaps.map((gap) => (
            <li key={`${gap.observedAt}-${gap.provenance}-${gap.captureId ?? gap.archive?.snapshotTimestamp ?? ''}`}>
              <Icon name="warn" /> {t(pl.archiveHistory.gap, { reason: gapReason(gap) })} · <Moment point={gap} />
            </li>
          ))}
        </ul>
      ) : null}
      <h5>{pl.archiveHistory.changes}</h5>
      {timeline.changes.length === 0 ? (
        <p className="muted">{pl.archiveHistory.noChanges}</p>
      ) : (
        <ul className="plain-list">
          {timeline.changes.map((change) => (
            <li key={`${change.lastSeenBefore.observedAt}-${change.firstSeenAfter.observedAt}`}>
              <strong>{change.wallet ? pl.archiveHistory.walletSwap : pl.archiveHistory.valueChange}</strong>
              <div>
                <Values values={change.before} /> → <Values values={change.after} />
              </div>
              <div>
                {pl.archiveHistory.lastSeenBefore}: <Moment point={change.lastSeenBefore} />
              </div>
              <div>
                {pl.archiveHistory.firstSeenAfter}: <Moment point={change.firstSeenAfter} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The timelines of the wallet properties: archived copies and live runs, kept apart by their provenance badge. */
export function ArchiveHistoryView({ timelines }: { timelines: readonly PropertyTimeline[] }) {
  const changes = timelines.reduce((sum, timeline) => sum + timeline.changes.length, 0);
  return (
    <>
      <p className="muted">
        {pl.archiveHistory.intro} ({plural(changes, pl.archiveHistory.count)})
      </p>
      {timelines.map((timeline, index) => (
        <TimelineCard key={timeline.key.locator} timeline={timeline} index={index} />
      ))}
    </>
  );
}

export function ArchiveHistoryPanel({ caseId, version }: { caseId: string; version: string }) {
  const timelines = useJson<PropertyTimeline[]>(apiPaths.caseTimeline(caseId, { walletOnly: true }), { version });
  return (
    <section aria-labelledby="archive-history-title" className="stack">
      <h3 id="archive-history-title">{pl.archiveHistory.title}</h3>
      <Async
        resource={timelines}
        errorTitle={pl.archiveHistory.loadError}
        isEmpty={(list) => list.length === 0}
        emptyText={pl.archiveHistory.none}
      >
        {(list) => <ArchiveHistoryView timelines={list} />}
      </Async>
    </section>
  );
}
