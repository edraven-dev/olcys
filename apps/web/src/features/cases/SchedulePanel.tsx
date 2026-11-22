import type { CaseScheduleState } from '@olcys/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Async, DateTime, EmptyState, ErrorState, Icon } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';
import { api, apiPaths } from '../../lib/api.ts';
import { formatDateTime, formatUtc } from '../../lib/format.ts';
import { Link, routePath } from '../../lib/router.tsx';
import { useJson } from '../../lib/use-api.ts';
import {
  initialScheduleForm,
  isScheduleActive,
  SCHEDULE_POLL_MS,
  scheduleRequest,
  validateScheduleForm,
  type ScheduleFormErrors,
  type ScheduleFormState,
} from './schedule-model.ts';

/**
 * „Harmonogram analiz” on the case page: the case's cron schedule (UTC), the next runs, the latest ticks with their
 * outcome and the form to change the schedule (a reason is required). Refreshes while the schedule is active.
 */
export function SchedulePanel({
  caseId,
  caseOpen,
  onActiveChange,
}: {
  caseId: string;
  caseOpen: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const [pollMs, setPollMs] = useState<number | undefined>(undefined);
  const schedule = useJson<CaseScheduleState>(apiPaths.caseSchedule(caseId), { pollMs });
  const [saved, setSaved] = useState(false);
  const active = isScheduleActive(schedule.data, caseOpen);
  const wantedPoll = active ? SCHEDULE_POLL_MS : undefined;
  if (wantedPoll !== pollMs) setPollMs(wantedPoll);
  useEffect(() => {
    if (schedule.data) onActiveChange?.(active);
  }, [active, schedule.data, onActiveChange]);

  return (
    <section aria-labelledby="case-schedule" className="card">
      <h2 id="case-schedule">{pl.schedule.title}</h2>
      <p className="hint">{pl.schedule.intro}</p>
      <Async resource={schedule} errorTitle={pl.schedule.loadError}>
        {(state) => (
          <>
            <ScheduleView state={state} caseId={caseId} caseOpen={caseOpen} />
            {caseOpen ? (
              <ScheduleForm
                key={`${state.schedule?.cron ?? ''}|${String(state.schedule?.enabled ?? '')}`}
                caseId={caseId}
                state={state}
                onEdit={() => setSaved(false)}
                onSaved={() => {
                  setSaved(true);
                  schedule.reload();
                }}
              />
            ) : null}
            {saved ? (
              <output className="hint block">
                <Icon name="check" />
                {pl.schedule.saved}
              </output>
            ) : null}
          </>
        )}
      </Async>
    </section>
  );
}

export function ScheduleView({
  state,
  caseId,
  caseOpen,
}: {
  state: CaseScheduleState;
  caseId: string;
  caseOpen: boolean;
}) {
  const lastChange = state.recentChanges?.[0];
  return (
    <>
      {state.schedule ? (
        <dl className="facts">
          <dt>{pl.schedule.current}</dt>
          <dd>
            <code className="mono">{state.schedule.cron}</code>{' '}
            <span className={`badge ${state.schedule.enabled ? 'tone-good' : 'tone-neutral'}`}>
              {state.schedule.enabled ? pl.schedule.state.enabled : pl.schedule.state.disabled}
            </span>
          </dd>
          <dt>{pl.schedule.nextRuns}</dt>
          <dd>
            {state.nextRuns.length > 0 ? (
              <ul className="plain-list">
                {state.nextRuns.map((iso) => (
                  <li key={iso}>
                    <time dateTime={iso}>{formatUtc(iso)}</time>
                  </li>
                ))}
              </ul>
            ) : (
              pl.schedule.noNextRuns
            )}
          </dd>
        </dl>
      ) : (
        <EmptyState text={pl.schedule.none} />
      )}
      {caseOpen ? null : (
        <p className="state state-warning">
          <Icon name="lock" />
          {pl.schedule.closed}
        </p>
      )}
      {state.problem ? (
        <p className="state state-warning" role="alert">
          <Icon name="warn" />
          {pl.schedule.problem[state.problem] ?? state.problem}
        </p>
      ) : null}
      {lastChange ? (
        <p className="hint">
          {t(pl.schedule.lastChange, {
            at: formatDateTime(lastChange.at),
            by: lastChange.changedBy,
            reason: lastChange.reason,
          })}
        </p>
      ) : null}
      <h3>{pl.schedule.ticksTitle}</h3>
      {state.recentTicks.length === 0 ? (
        <EmptyState text={pl.schedule.noTicks} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{pl.schedule.tickColumns.scheduledFor}</th>
                <th scope="col">{pl.schedule.tickColumns.firedAt}</th>
                <th scope="col">{pl.schedule.tickColumns.outcome}</th>
                <th scope="col">{pl.schedule.tickColumns.run}</th>
              </tr>
            </thead>
            <tbody>
              {state.recentTicks.map((tick) => (
                <tr key={tick.id}>
                  <td>
                    <time dateTime={tick.scheduledFor}>{formatUtc(tick.scheduledFor)}</time>
                  </td>
                  <td>
                    <DateTime iso={tick.firedAt} />
                  </td>
                  <td>
                    <span className={`badge ${tick.outcome === 'started' ? 'tone-good' : 'tone-neutral'}`}>
                      {pl.schedule.outcomes[tick.outcome] ?? tick.outcome}
                    </span>
                  </td>
                  <td>
                    {tick.runId ? (
                      <Link
                        to={routePath({ name: 'run', caseId, runId: tick.runId, tab: 'overview' })}
                        aria-label={t(pl.schedule.openRunLabel, { date: formatUtc(tick.scheduledFor) })}
                      >
                        {pl.schedule.openRun}
                      </Link>
                    ) : (
                      pl.common.dash
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ScheduleForm({
  caseId,
  state,
  onEdit,
  onSaved,
}: {
  caseId: string;
  state: CaseScheduleState;
  onEdit: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<ScheduleFormState>(() => initialScheduleForm(state));
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [failure, setFailure] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<ScheduleFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    onEdit();
  };
  const describedBy = (field: string, ...extra: (string | false)[]) =>
    [`${id}-${field}-hint`, ...extra, errors[field as keyof ScheduleFormErrors] ? `${id}-${field}-error` : false]
      .filter(Boolean)
      .join(' ');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateScheduleForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.put<CaseScheduleState>(apiPaths.caseSchedule(caseId), scheduleRequest(form));
      setForm((current) => ({ ...current, reason: '' }));
      onSaved();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" noValidate aria-labelledby={`${id}-title`} onSubmit={(event) => void submit(event)}>
      <h3 id={`${id}-title`}>{pl.schedule.formTitle}</h3>
      <div className={`field${errors.cron ? ' field-invalid' : ''}`}>
        <label htmlFor={`${id}-cron`}>{pl.schedule.cron}</label>
        <p id={`${id}-cron-hint`} className="hint">
          {pl.schedule.cronHint}
        </p>
        {state.minIntervalMinutes ? (
          <p id={`${id}-cron-minimum`} className="hint">
            {t(pl.schedule.minInterval, { minutes: state.minIntervalMinutes })}
          </p>
        ) : null}
        <input
          id={`${id}-cron`}
          className="mono"
          value={form.cron}
          onChange={(event) => update({ cron: event.target.value })}
          aria-invalid={Boolean(errors.cron)}
          aria-describedby={describedBy('cron', Boolean(state.minIntervalMinutes) && `${id}-cron-minimum`)}
          spellCheck={false}
          autoComplete="off"
          required
        />
        {errors.cron ? (
          <p id={`${id}-cron-error`} className="field-error">
            <Icon name="warn" />
            {errors.cron}
          </p>
        ) : null}
      </div>
      <label className="check">
        <input type="checkbox" checked={form.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        {pl.schedule.enabled}
      </label>
      <div className={`field${errors.reason ? ' field-invalid' : ''}`}>
        <label htmlFor={`${id}-reason`}>{pl.schedule.reason}</label>
        <p id={`${id}-reason-hint`} className="hint">
          {pl.schedule.reasonHint}
        </p>
        <textarea
          id={`${id}-reason`}
          rows={2}
          value={form.reason}
          onChange={(event) => update({ reason: event.target.value })}
          aria-invalid={Boolean(errors.reason)}
          aria-describedby={describedBy('reason')}
          required
        />
        {errors.reason ? (
          <p id={`${id}-reason-error`} className="field-error">
            <Icon name="warn" />
            {errors.reason}
          </p>
        ) : null}
      </div>
      {failure ? <ErrorState title={pl.schedule.saveError} error={failure} /> : null}
      <div className="actions">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? pl.schedule.saving : pl.schedule.save}
        </button>
      </div>
    </form>
  );
}
