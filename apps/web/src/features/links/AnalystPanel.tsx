/**
 * Analyst judgements and overrides in the links view. A judgement is recorded next to the computed link and never
 * changes the displayed score; an override changes the input of a later rescore run only, which produces a new,
 * separately versioned result. The analyst is set by the server, never by this form.
 */
import type {
  AnalystJudgement,
  AnalystOverride,
  AnalystOverrideKind,
  JudgementValue,
  RunWithProgress,
} from '@olcys/core';
import { useId, useState, type FormEvent } from 'react';
import { DateTime, ErrorState, Icon } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { api, ApiRequestError, apiPaths, errorMessage } from '../../lib/api.ts';
import type { LinkView } from '../../lib/domain.ts';
import { formatDateTime, middleTruncate } from '../../lib/format.ts';
import { navigate, routePath } from '../../lib/router.tsx';
import type { Resource } from '../../lib/use-api.ts';
import { isTerminal } from '../run/run-model.ts';
import {
  accountTargets,
  appliedIn,
  EVIDENCE_FEATURES,
  gradeTargets,
  JUDGEMENT_OPTIONS,
  JUSTIFICATION,
  justificationError,
  mergeJudgements,
  OVERRIDE_KINDS,
  overrideRequest,
  REVIEW_OPTIONS,
  reviewTargets,
  SETTABLE_GRADES,
  type AnalystLookups,
  type TargetOption,
} from './analyst-model.ts';

export interface AnalystContext extends AnalystLookups {
  sourceNames: ReadonlyMap<string, string>;
}

/** Polish text for an error of the judgement and override routes (stable codes), else the generic message. */
function analystError(error: unknown): string {
  const text = error instanceof ApiRequestError ? lookup(pl.judgement.errors, error.code) : null;
  return text ?? errorMessage(error);
}

function JustificationField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={`${id}-justification`}>{pl.judgement.justification}</label>
      <p id={`${id}-justification-hint`} className="hint">
        {t(pl.judgement.justificationHint, JUSTIFICATION)}
      </p>
      <textarea
        id={`${id}-justification`}
        aria-describedby={`${id}-justification-hint`}
        rows={3}
        maxLength={JUSTIFICATION.max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function FormFeedback({ error, saved }: { error: string | undefined; saved: string | undefined }) {
  if (error) {
    return (
      <p className="field-error" role="alert">
        <Icon name="warn" />
        {error}
      </p>
    );
  }
  return saved ? (
    <output className="hint block">
      <Icon name="check" />
      {saved}
    </output>
  ) : null;
}

/**
 * Judgements of one link (oldest first, the current one named) and, when enabled, the form to add one. The list
 * follows the link's refreshed judgements; a judgement saved here shows at once and `onSaved` refreshes the links.
 */
export function JudgementSection({
  link,
  enabled,
  onSaved,
}: {
  link: LinkView;
  enabled: boolean;
  onSaved?: () => void;
}) {
  const id = useId();
  const [local, setLocal] = useState<AnalystJudgement[]>([]);
  const [value, setValue] = useState<JudgementValue>();
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = mergeJudgements(link.judgements ?? [], local);
  if (!enabled && items.length === 0) return null;
  const current = items.at(-1);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const problem = justificationError(justification);
    if (!value || problem) {
      setError(problem ? pl.judgement.errors[problem] : pl.errors.required);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const created = await api.post<AnalystJudgement>(apiPaths.linkJudgements(link.id), {
        judgement: value,
        justification: justification.trim(),
      });
      setLocal((list) => [...list, created]);
      setJustification('');
      setSaved(true);
      onSaved?.();
    } catch (failure) {
      setError(analystError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="analyst-box" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>
        <Icon name="check" />
        {pl.judgement.title}
      </h4>
      <p className="notice small">
        <Icon name="info" />
        {pl.judgement.notice}
      </p>
      {current ? (
        <p>
          <strong>{t(pl.judgement.current, { label: pl.judgement.values[current.judgement] })}</strong>
        </p>
      ) : (
        <p className="muted small">{pl.judgement.none}</p>
      )}
      {items.length > 0 ? (
        <ol className="plain-list judgement-list">
          {items.map((j) => (
            <li key={j.id}>
              <strong>{pl.judgement.values[j.judgement]}</strong>{' '}
              <span className="muted small">
                {t(pl.judgement.by, { analyst: j.analyst, at: formatDateTime(j.at) })}
              </span>
              <p className="small">{j.justification}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {enabled ? (
        <details>
          <summary>{pl.judgement.add}</summary>
          <form onSubmit={(event) => void submit(event)}>
            <fieldset>
              <legend>{pl.judgement.legend}</legend>
              {JUDGEMENT_OPTIONS.map((option) => (
                <div key={option} className="judgement-option">
                  <label className="check">
                    <input
                      type="radio"
                      name={`${id}-judgement`}
                      value={option}
                      checked={value === option}
                      aria-describedby={`${id}-${option}-hint`}
                      onChange={() => setValue(option)}
                    />
                    {pl.judgement.values[option]}
                  </label>
                  <p id={`${id}-${option}-hint`} className="hint">
                    {pl.judgement.hints[option]}
                  </p>
                </div>
              ))}
            </fieldset>
            <JustificationField id={id} value={justification} onChange={setJustification} />
            <FormFeedback error={error} saved={saved ? pl.judgement.saved : undefined} />
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? pl.judgement.saving : pl.judgement.save}
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

function targetLabel(option: TargetOption, ctx: AnalystContext): string {
  const x = pl.overrides.targets;
  const source = (id: string | undefined) => (id ? (ctx.sourceNames.get(id) ?? id) : pl.common.notAvailable);
  switch (option.kind) {
    case 'observation':
      return t(x.observation, { property: option.observation.property, source: source(option.observation.sourceId) });
    case 'candidate':
      return t(x.candidate, {
        address: middleTruncate(option.candidate.address.address),
        source: source(option.sourceId),
      });
    case 'source':
      return t(x.source, { source: source(option.sourceId) });
    case 'account':
      return t(x.account, { platform: option.account.platform, handle: option.account.handle });
  }
}

const VALUES: Readonly<Record<AnalystOverrideKind, readonly string[]>> = {
  reliability_grade: SETTABLE_GRADES,
  review_decision: REVIEW_OPTIONS,
  add_evidence: EVIDENCE_FEATURES,
};

function valueLabel(kind: AnalystOverrideKind, value: string): string {
  if (kind === 'reliability_grade') return lookup(pl.reliability, value) ?? value;
  if (kind === 'review_decision') return lookup(pl.overrides.decisions, value) ?? value;
  return lookup(pl.features, value) ?? value;
}

/** Form for one override concerning this link; the override takes effect only in a later rescore run. */
export function OverrideForm({
  link,
  ctx,
  caseId,
  onSaved,
}: {
  link: LinkView;
  ctx: AnalystContext;
  caseId: string;
  onSaved?: (override: AnalystOverride) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<AnalystOverrideKind>('reliability_grade');
  const [targetKey, setTargetKey] = useState('');
  const [value, setValue] = useState('');
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const options =
    kind === 'reliability_grade'
      ? gradeTargets(link, ctx)
      : kind === 'review_decision'
        ? reviewTargets(link, ctx)
        : accountTargets(link, ctx);
  const target = options.find((o) => o.key === targetKey) ?? options[0];
  const values = VALUES[kind];
  const chosen = values.includes(value) ? value : (values[0] ?? '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const problem = justificationError(justification);
    if (!target || problem) {
      setError(problem ? pl.judgement.errors[problem] : pl.overrides.noTargets);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const created = await api.post<AnalystOverride>(
        apiPaths.caseOverrides(caseId),
        overrideRequest(link, { kind, target: target.target, value: chosen, justification }),
      );
      setJustification('');
      setSaved(true);
      onSaved?.(created);
    } catch (failure) {
      setError(analystError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="analyst-box" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>
        <Icon name="computed" />
        {pl.overrides.title}
      </h4>
      <p className="notice small">
        <Icon name="clock" />
        {pl.overrides.notice}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor={`${id}-kind`}>{pl.overrides.kind}</label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as AnalystOverrideKind);
              setTargetKey('');
              setValue('');
              setError(undefined);
            }}
          >
            {OVERRIDE_KINDS.map((k) => (
              <option key={k} value={k}>
                {pl.overrides.kinds[k]}
              </option>
            ))}
          </select>
        </div>
        {options.length === 0 ? (
          <p className="muted small">{pl.overrides.noTargets}</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`${id}-target`}>
                {kind === 'add_evidence' ? pl.overrides.account : pl.overrides.target}
              </label>
              <select
                id={`${id}-target`}
                value={target?.key ?? ''}
                onChange={(event) => setTargetKey(event.target.value)}
              >
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {targetLabel(o, ctx)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-value`}>
                {kind === 'reliability_grade'
                  ? pl.overrides.grade
                  : kind === 'review_decision'
                    ? pl.overrides.decision
                    : pl.overrides.feature}
              </label>
              <select id={`${id}-value`} value={chosen} onChange={(event) => setValue(event.target.value)}>
                {values.map((v) => (
                  <option key={v} value={v}>
                    {valueLabel(kind, v)}
                  </option>
                ))}
              </select>
              {kind === 'add_evidence' ? (
                <p className="hint">{lookup(pl.overrides.featureHints, chosen) ?? ''}</p>
              ) : null}
            </div>
            <JustificationField id={id} value={justification} onChange={setJustification} />
            <FormFeedback error={error} saved={saved ? pl.overrides.saved : undefined} />
            <button type="submit" className="button" disabled={busy}>
              {busy ? pl.overrides.saving : pl.overrides.save}
            </button>
          </>
        )}
      </form>
    </section>
  );
}

function overrideTargetText(o: AnalystOverride, ctx: AnalystContext): string {
  const x = pl.overrides.targets;
  const { observationId, candidateId, sourceId, accountId, address } = o.target;
  const parts: string[] = [];
  if (observationId) {
    const observation = ctx.observations.get(observationId);
    const source = observation ? (ctx.sourceNames.get(observation.sourceId) ?? observation.sourceId) : '';
    parts.push(
      observation
        ? t(x.observation, { property: observation.property, source })
        : t(pl.overrides.unknownTarget, { id: observationId }),
    );
  }
  if (candidateId) {
    const candidate = ctx.candidates.get(candidateId);
    const found = candidate ? ctx.captures.get(candidate.captureId)?.sourceId : undefined;
    parts.push(
      candidate
        ? t(x.candidate, {
            address: middleTruncate(candidate.address.address),
            source: found ? (ctx.sourceNames.get(found) ?? found) : pl.common.notAvailable,
          })
        : t(pl.overrides.unknownTarget, { id: candidateId }),
    );
  }
  if (sourceId) parts.push(t(x.source, { source: ctx.sourceNames.get(sourceId) ?? sourceId }));
  if (accountId) {
    const account = ctx.accounts.get(accountId);
    parts.push(
      account
        ? t(x.account, { platform: account.platform, handle: account.handle })
        : t(pl.overrides.unknownTarget, { id: accountId }),
    );
  }
  if (address) parts.push(t(x.address, { address: middleTruncate(address.address) }));
  return parts.join(' · ');
}

/**
 * The overrides of the case with whether this run applied them, and the rescore that applies the pending ones. The
 * rescore re-analyses this run's saved evidence without fetching anything.
 */
export function CaseOverrides({
  run,
  overrides,
  ctx,
}: {
  run: RunWithProgress;
  overrides: Resource<AnalystOverride[]>;
  ctx: AnalystContext;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const items = overrides.data ?? [];
  const c = pl.overrides.columns;

  const rescore = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.post<RunWithProgress>(apiPaths.caseRuns(run.caseId), {
        trigger: 'rescore',
        rescoreOfRunId: run.id,
      });
      navigate(routePath({ name: 'run', caseId: run.caseId, runId: next.id, tab: 'overview' }));
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <section className="card analyst-box" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{pl.overrides.panelTitle}</h3>
      <p className="notice small">
        <Icon name="clock" />
        {pl.overrides.notice}
      </p>
      <p className="muted small">{pl.overrides.panelIntro}</p>
      {overrides.error && !overrides.data ? <ErrorState error={overrides.error} onRetry={overrides.reload} /> : null}
      {items.length === 0 ? (
        <p className="muted">{pl.overrides.none}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{c.kind}</th>
                <th scope="col">{c.target}</th>
                <th scope="col">{c.value}</th>
                <th scope="col">{c.analyst}</th>
                <th scope="col">{c.status}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>{pl.overrides.kinds[o.kind]}</td>
                  <td>{overrideTargetText(o, ctx)}</td>
                  <td>{valueLabel(o.kind, o.value)}</td>
                  <td>
                    {o.analyst}
                    <br />
                    <DateTime iso={o.at} />
                  </td>
                  <td>{appliedIn(run, o) ? pl.overrides.applied : pl.overrides.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">{pl.overrides.rescoreHint}</p>
      {error ? <ErrorState error={error} /> : null}
      <button
        type="button"
        className="button"
        disabled={busy || !isTerminal(run.status)}
        onClick={() => void rescore()}
      >
        {busy ? pl.overrides.rescoring : pl.overrides.rescore}
      </button>
    </section>
  );
}
