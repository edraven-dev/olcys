import type { ApiMeta, LegacyReportView, ReportModel, ReportView } from '@olcys/core';
import { useState } from 'react';
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

/** The report is rendered natively from the report model the API serves; files are offered as downloads. */
export function ReportTab({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const done = isTerminal(run.status);
  const [regenerations, setRegenerations] = useState(0);
  const report = useResource<ReportView | LegacyReportView | null>(
    done ? `${apiPaths.reportView(run.id)}#${reportVersion(version, regenerations)}` : null,
    () => loadReport(run.id),
  );
  const meta = useJson<ApiMeta>(apiPaths.meta);
  // The API renders a new report version after a decision without making the response wait: load it again shortly.
  const refreshAfterDecision = () => {
    for (const delay of [1500, 5000]) setTimeout(() => setRegenerations((n) => n + 1), delay);
  };
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
          {report.data.legacy || !meta.data?.features.inferenceDrafts ? null : (
            <DraftInferences
              runId={run.id}
              version={reportVersion(version, regenerations)}
              targets={anchorTargets(report.data.report)}
              onDecided={refreshAfterDecision}
            />
          )}
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
