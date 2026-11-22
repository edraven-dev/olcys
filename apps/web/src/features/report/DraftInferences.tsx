/**
 * Draft inferences for section C. The analyst asks the local model for drafts (button „Zaproponuj wnioski (AI)”,
 * offered only when the API reports the model as enabled); each draft is shown as „Sugestia AI — niezweryfikowana”
 * until the analyst confirms (optionally editing the text) or rejects it with a justification. Only confirmed drafts
 * enter the report; scores and the summary are never touched.
 */
import type { DraftInferencesResult, InferenceDraft, LlmSuggestion } from '@olcys/core';
import { INFERENCE_DRAFT_TASK } from '@olcys/core';
import { useId, useState, type FormEvent } from 'react';
import { Icon } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { api, ApiRequestError, apiPaths, errorMessage } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useList } from '../../lib/use-api.ts';
import { JUSTIFICATION, justificationError } from '../links/analyst-model.ts';

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((x) => typeof x === 'string');

/** The stored draft, or `undefined` for a suggestion of another shape. */
export function draftOf(suggestion: LlmSuggestion): InferenceDraft | undefined {
  const o = suggestion.output as Partial<InferenceDraft> | undefined;
  if (!o || typeof o.statement !== 'string' || !isStrings(o.basedOn) || !isStrings(o.alternatives)) return undefined;
  return {
    statement: o.statement,
    basedOn: o.basedOn,
    alternatives: o.alternatives,
    verificationSteps: o.verificationSteps ?? [],
  };
}

/** The sentence that tells the analyst what the model did (a failure is a message, never an error screen). */
export function resultMessage(result: DraftInferencesResult): string {
  if (result.status === 'drafted') {
    const dropped = result.dropped.unknownBasis + result.dropped.restatesScore;
    const template = result.created > 0 ? pl.drafts.result.drafted : pl.drafts.result.none;
    return t(template ?? '', { created: result.created, dropped });
  }
  if (result.status === 'skipped') return lookup(pl.drafts.result, result.reason) ?? result.reason;
  return t(lookup(pl.drafts.result, 'failed') ?? '', {
    reason: lookup(pl.drafts.failures, result.reason) ?? result.reason,
  });
}

export function DraftInferences({
  runId,
  version,
  targets,
  canGenerate,
  onDecided,
}: {
  runId: string;
  version: string;
  /** The model is enabled: only the button that asks for new drafts depends on it, saved drafts stay reviewable. */
  canGenerate: boolean;
  /** Anchors of the report's facts and results, to link the cited ids. */
  targets: ReadonlyMap<string, string>;
  /** Called after a decision, so the report (re-rendered by the API) can be loaded again. */
  onDecided: () => void;
}) {
  const suggestions = useList<LlmSuggestion>(apiPaths.runSuggestions(runId), { version });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const items = (suggestions.data ?? []).filter((s) => s.task === INFERENCE_DRAFT_TASK && draftOf(s));

  const propose = async () => {
    setBusy(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const result = await api.post<DraftInferencesResult>(apiPaths.reportDrafts(runId), {});
      setMessage(resultMessage(result));
      suggestions.reload();
    } catch (failure) {
      setError(
        (failure instanceof ApiRequestError ? lookup(pl.drafts.errors, failure.code) : null) ?? errorMessage(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  // Saved drafts are reviewed (confirmed or rejected) even when the model has been switched off since.
  if (!canGenerate && items.length === 0) return null;
  return (
    <section aria-labelledby="report-drafts-title" className="card stack">
      <h3 id="report-drafts-title">{pl.drafts.title}</h3>
      <p className="hint">{pl.drafts.intro}</p>
      {canGenerate ? (
        <p>
          <button type="button" className="button" disabled={busy} onClick={() => void propose()}>
            {busy ? pl.drafts.proposing : pl.drafts.propose}
          </button>
        </p>
      ) : (
        <p className="hint">{pl.drafts.modelOff}</p>
      )}
      {message ? (
        <output className="hint block">
          <Icon name="info" />
          {message}
        </output>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          <Icon name="warn" />
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="muted">{pl.drafts.none}</p>
      ) : (
        items.map((s) => (
          <DraftCard
            key={s.id}
            suggestion={s}
            targets={targets}
            onDecided={() => {
              suggestions.reload();
              onDecided();
            }}
          />
        ))
      )}
    </section>
  );
}

function DraftCard({
  suggestion,
  targets,
  onDecided,
}: {
  suggestion: LlmSuggestion;
  targets: ReadonlyMap<string, string>;
  onDecided: () => void;
}) {
  const id = useId();
  const draft = draftOf(suggestion);
  const [deciding, setDeciding] = useState<'confirmed' | 'rejected'>();
  const [text, setText] = useState(draft?.statement ?? '');
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!draft) return null;
  const badge =
    suggestion.status === 'confirmed'
      ? pl.drafts.badgeConfirmed
      : suggestion.status === 'rejected'
        ? pl.drafts.badgeRejected
        : pl.drafts.badge;
  const shown = suggestion.status === 'confirmed' && suggestion.editedText ? suggestion.editedText : draft.statement;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = justificationError(justification);
    if (!deciding || problem) {
      setError(problem ? pl.drafts.errors[problem] : pl.errors.required);
      return;
    }
    if (deciding === 'confirmed' && text.trim() === '') {
      setError(pl.errors.required);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.post<LlmSuggestion>(apiPaths.suggestionDecision(suggestion.id), {
        decision: deciding,
        justification: justification.trim(),
        // The edited text is sent only when the analyst changed the draft.
        ...(deciding === 'confirmed' && text.trim() !== draft.statement ? { editedText: text.trim() } : {}),
      });
      setDeciding(undefined);
      setJustification('');
      onDecided();
    } catch (failure) {
      setError(
        (failure instanceof ApiRequestError ? lookup(pl.drafts.errors, failure.code) : null) ?? errorMessage(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="analyst-box ai-suggestion" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>
        <span className="tag tag-warn">{badge}</span>
      </h4>
      <p className="prewrap">{shown}</p>
      {suggestion.status === 'confirmed' && suggestion.editedText ? (
        <p className="hint">{pl.drafts.editedNote}</p>
      ) : null}
      <p className="muted small">
        {pl.drafts.basedOn}:{' '}
        {draft.basedOn.map((ref, index) => {
          const target = targets.get(ref);
          return (
            <span key={ref}>
              {index > 0 ? ', ' : null}
              {target ? <a href={`#${target}`}>{ref}</a> : <code className="mono">{ref}</code>}
            </span>
          );
        })}
      </p>
      <div>
        <h5>{pl.drafts.alternatives}</h5>
        <ul>
          {draft.alternatives.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
      {draft.verificationSteps.length > 0 ? (
        <div>
          <h5>{pl.drafts.steps}</h5>
          <ul>
            {draft.verificationSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="muted small">{t(pl.drafts.model, { model: suggestion.model, prompt: suggestion.promptVersion })}</p>
      {suggestion.status === 'confirmed' ? (
        <p className="hint">{pl.drafts.inReport}</p>
      ) : (
        <p className="hint">{pl.drafts.notInReport}</p>
      )}
      {suggestion.status !== 'pending' ? (
        <p className="small">
          {t(pl.drafts.decidedBy, {
            analyst: suggestion.decidedBy ?? '',
            at: suggestion.decidedAt ? formatDateTime(suggestion.decidedAt) : '',
          })}
          {suggestion.justification ? <span className="prewrap">{`: ${suggestion.justification}`}</span> : null}
        </p>
      ) : deciding ? (
        <form onSubmit={(event) => void submit(event)}>
          {deciding === 'confirmed' ? (
            <div className="field">
              <label htmlFor={`${id}-text`}>{pl.drafts.editedText}</label>
              <textarea
                id={`${id}-text`}
                rows={4}
                maxLength={4000}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={`${id}-justification`}>{pl.drafts.justification}</label>
            <p id={`${id}-hint`} className="hint">
              {t(pl.drafts.justificationHint, JUSTIFICATION)}
            </p>
            <textarea
              id={`${id}-justification`}
              aria-describedby={`${id}-hint`}
              rows={2}
              maxLength={JUSTIFICATION.max}
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
            />
          </div>
          {error ? (
            <p className="field-error" role="alert">
              <Icon name="warn" />
              {error}
            </p>
          ) : null}
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? pl.drafts.saving : deciding === 'confirmed' ? pl.drafts.submitConfirm : pl.drafts.submitReject}
          </button>{' '}
          <button type="button" className="button" onClick={() => setDeciding(undefined)} disabled={busy}>
            {pl.drafts.cancel}
          </button>
        </form>
      ) : (
        <p>
          <button type="button" className="button" onClick={() => setDeciding('confirmed')}>
            <Icon name="check" />
            {pl.drafts.confirm}
          </button>{' '}
          <button type="button" className="button" onClick={() => setDeciding('rejected')}>
            <Icon name="cross" />
            {pl.drafts.reject}
          </button>
        </p>
      )}
    </article>
  );
}
