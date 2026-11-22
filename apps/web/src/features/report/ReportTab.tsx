import type { ApiMeta, LegacyReportView, ReportModel, ReportView } from '@olcys/core';
import { useEffect, useState } from 'react';
import { ErrorState, Icon, LoadingState, StaleNotice } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { api, ApiRequestError, apiPaths } from '../../lib/api.ts';
import type { SourceItem } from '../../lib/domain.ts';
import { useJson, useList, useResource, type Resource } from '../../lib/use-api.ts';
import type { RunScope } from '../run/RunPage.tsx';
import { isTerminal } from '../run/run-model.ts';
import { DownloadsPanel } from './DownloadsPanel.tsx';
import { DraftInferences } from './DraftInferences.tsx';
import { ReportDocument } from './ReportDocument.tsx';

/** `null` while the run has no report (404), so the tab can say so instead of failing. */
async function loadReport(runId: string): Promise<ReportView | LegacyReportView | null> {
  try {
    return await api.get<ReportView | LegacyReportView>(apiPaths.reportView(runId));
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/** Anchors of the report's facts and computed results, by id (the document's own ids). */
const anchorTargets = (report: ReportModel): Map<string, string> =>
  new Map<string, string>([
    ...report.facts.map((f): [string, string] => [f.id, `fact-${f.id}`]),
    ...report.computed.map((c): [string, string] => [c.id, `computed-${c.id}`]),
  ]);

/** Cache key of the report: changes with the run and with every successful regeneration of the report. */
export const reportVersion = (runVersion: string, regenerations: number): string =>
  `${runVersion}#regenerated-${regenerations}`;

/**
 * Waits between checks while the API renders the report version that shows a decision: backoff up to about a minute
 * in total (1+2+4+8 s, then 10 s steps).
 */
export const REPORT_POLL_SCHEDULE_MS: readonly number[] = [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000];

type Awaiting = { from: string; attempt: number; state: 'waiting' | 'timeout' | 'failed' };

/** The report is rendered natively from the report model the API serves; files are offered as downloads. */
export function ReportTab({
  scope,
  pollSchedule = REPORT_POLL_SCHEDULE_MS,
}: {
  scope: RunScope;
  /** Waits between checks for the re-rendered report (milliseconds); tests pass short ones. */
  pollSchedule?: readonly number[];
}) {
  const { run, version } = scope;
  const done = isTerminal(run.status);
  const [regenerations, setRegenerations] = useState(0);
  const report = useResource<ReportView | LegacyReportView | null>(
    done ? `${apiPaths.reportView(run.id)}#${reportVersion(version, regenerations)}` : null,
    () => loadReport(run.id),
  );
  const meta = useJson<ApiMeta>(apiPaths.meta);
  // A decision makes the API render a new report version in the background: poll until the published version id
  // changes (never a fixed number of reloads), then show it. A render that takes too long ends in a message with retry.
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null);
  const publishedVersion = report.data && !report.data.legacy ? report.data.version : undefined;
  const refreshAfterDecision = () =>
    setAwaiting((current) =>
      current?.state === 'waiting'
        ? current
        : { from: publishedVersion ?? '', attempt: (current?.attempt ?? 0) + 1, state: 'waiting' },
    );
  const retryAwaiting = () =>
    setAwaiting((current) => (current ? { ...current, attempt: current.attempt + 1, state: 'waiting' } : current));
  const waitingAttempt = awaiting?.state === 'waiting' ? awaiting.attempt : 0;
  const waitingFrom = awaiting?.from ?? '';
  useEffect(() => {
    if (waitingAttempt === 0) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (step: number): Promise<void> => {
      if (step >= pollSchedule.length) {
        setAwaiting((c) => (c ? { ...c, state: 'timeout' } : c));
        return;
      }
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, pollSchedule[step]);
      });
      if (cancelled) return;
      try {
        const latest = await loadReport(run.id);
        if (cancelled) return;
        if (latest && !latest.legacy && latest.version !== waitingFrom) {
          setAwaiting(null);
          setRegenerations((n) => n + 1);
          return;
        }
      } catch {
        // A failed check is retried on the next step; only the end of the schedule reports it.
        if (step + 1 >= pollSchedule.length && !cancelled) {
          setAwaiting((c) => (c ? { ...c, state: 'failed' } : c));
          return;
        }
      }
      await check(step + 1);
    };
    void check(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [waitingAttempt, waitingFrom, run.id, pollSchedule]);
  const sources = useList<SourceItem>(apiPaths.sources);
  const names = new Map((sources.data ?? []).map((s) => [s.id, s.name]));
  return (
    <section aria-labelledby="report-title" className="stack">
      <h2 id="report-title">{pl.report.title}</h2>
      <p>{pl.report.intro}</p>
      {!done ? (
        <p className="muted">{pl.report.pending}</p>
      ) : report.data === undefined ? (
        report.error ? (
          <ErrorState title={pl.report.error} error={report.error} onRetry={report.reload} />
        ) : (
          <LoadingState text={pl.report.checking} />
        )
      ) : report.data === null ? (
        <p className="notice">{pl.report.missing}</p>
      ) : (
        <>
          {report.error ? <StaleNotice resource={report as Resource<unknown>} /> : null}
          {report.data.legacy ? <p className="notice">{pl.report.legacy}</p> : null}
          <DownloadsPanel files={report.data.files} />
          {report.data.legacy ? null : (
            <DraftInferences
              runId={run.id}
              version={reportVersion(version, regenerations)}
              targets={anchorTargets(report.data.report)}
              canGenerate={meta.data?.features.inferenceDrafts === true}
              onDecided={refreshAfterDecision}
            />
          )}
          {awaiting?.state === 'waiting' ? (
            <output className="hint block">
              <Icon name="info" />
              {pl.drafts.waitingReport}
            </output>
          ) : null}
          {awaiting && awaiting.state !== 'waiting' ? (
            <div className="notice" role="alert">
              <p>{awaiting.state === 'timeout' ? pl.drafts.reportTimeout : pl.drafts.reportCheckFailed}</p>
              <button type="button" className="button" onClick={retryAwaiting}>
                {pl.drafts.retryReport}
              </button>
            </div>
          ) : null}
          {report.data.legacy ? null : <ReportDocument report={report.data.report} names={names} />}
        </>
      )}
      {done && report.data && meta.data?.features.judgements ? (
        <RegenerateReport runId={run.id} onRegenerated={() => setRegenerations((n) => n + 1)} />
      ) : null}
    </section>
  );
}

/** A new version of the report, e.g. with the analyst judgements recorded since; earlier versions stay stored. */
function RegenerateReport({ runId, onRegenerated }: { runId: string; onRegenerated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();
  const regenerate = async () => {
    setBusy(true);
    setDone(false);
    setError(undefined);
    try {
      await api.post(apiPaths.report(runId), {});
      setDone(true);
      onRegenerated();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <p className="hint">{pl.overrides.regenerateHint}</p>
      <p>
        <button type="button" className="button" disabled={busy} onClick={() => void regenerate()}>
          {busy ? pl.overrides.regenerating : pl.overrides.regenerate}
        </button>
      </p>
      {done ? (
        <output className="hint block">
          <Icon name="check" />
          {pl.overrides.regenerated}
        </output>
      ) : null}
      {error ? <ErrorState error={error} /> : null}
    </div>
  );
}
