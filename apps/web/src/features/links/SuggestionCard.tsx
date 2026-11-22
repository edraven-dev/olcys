/**
 * A model suggestion about an address mention, shown next to the mention. It is labelled „Sugestia AI —
 * niezweryfikowana” until an analyst decides; deciding records the analyst's confirmation or rejection with a
 * justification and never changes a stored score. The analyst identity is the API's configured one.
 */
import type { LlmSuggestion } from '@olcys/core';
import { useId, useState, type FormEvent } from 'react';
import { Icon } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { api, ApiRequestError, apiPaths, errorMessage } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { JUSTIFICATION, justificationError } from './analyst-model.ts';

interface RoleOutput {
  evidenceSpan?: string;
  agreement?: string;
}

function outputOf(suggestion: LlmSuggestion): RoleOutput {
  const out = suggestion.output;
  return typeof out === 'object' && out !== null ? (out as RoleOutput) : {};
}

/** True for the role suggestions of an address mention (other tasks are not shown here). */
export const isRoleSuggestion = (s: LlmSuggestion): boolean => s.task === 'address-role-classification';

export function SuggestionCard({
  suggestion,
  canDecide = true,
  onDecided,
}: {
  suggestion: LlmSuggestion;
  canDecide?: boolean;
  onDecided?: () => void;
}) {
  const id = useId();
  const [current, setCurrent] = useState(suggestion);
  const [deciding, setDeciding] = useState<'confirmed' | 'rejected'>();
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // A refreshed list replaces what was decided here only when it already knows the decision.
  const shown = suggestion.status !== 'pending' ? suggestion : current;
  const out = outputOf(shown);
  const badge =
    shown.status === 'confirmed'
      ? pl.suggestion.badgeConfirmed
      : shown.status === 'rejected'
        ? pl.suggestion.badgeRejected
        : pl.suggestion.badge;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = justificationError(justification);
    if (!deciding || problem) {
      setError(problem ? pl.suggestion.errors[problem] : pl.errors.required);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const decided = await api.post<LlmSuggestion>(apiPaths.suggestionDecision(suggestion.id), {
        decision: deciding,
        justification: justification.trim(),
      });
      setCurrent(decided);
      setDeciding(undefined);
      setJustification('');
      onDecided?.();
    } catch (failure) {
      setError(
        (failure instanceof ApiRequestError ? lookup(pl.suggestion.errors, failure.code) : null) ??
          errorMessage(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="analyst-box ai-suggestion" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>
        <span className="tag tag-warn">{badge}</span> {pl.suggestion.title}
      </h4>
      <p>
        <strong>{t(pl.suggestion.role, { role: lookup(pl.roleCues, shown.label) ?? shown.label })}</strong>
      </p>
      {out.evidenceSpan ? (
        <p className="small">
          <span className="muted">{pl.suggestion.span}: </span>
          <q className="prewrap">{out.evidenceSpan}</q>
        </p>
      ) : null}
      {shown.rationale ? (
        <p className="small">
          <span className="muted">{pl.suggestion.rationale}: </span>
          {shown.rationale}
        </p>
      ) : null}
      {out.agreement === 'differs' ? <p className="hint">{pl.suggestion.differs}</p> : null}
      <p className="muted small">{t(pl.suggestion.model, { model: shown.model, prompt: shown.promptVersion })}</p>
      <p className="notice small">
        <Icon name="info" />
        {pl.suggestion.notice}
      </p>
      {shown.status !== 'pending' ? (
        <p className="small">
          {t(pl.suggestion.decidedBy, {
            analyst: shown.decidedBy ?? '',
            at: shown.decidedAt ? formatDateTime(shown.decidedAt) : '',
          })}
          {shown.justification ? <span className="prewrap">{`: ${shown.justification}`}</span> : null}
        </p>
      ) : canDecide ? (
        deciding ? (
          <form onSubmit={(event) => void submit(event)}>
            <div className="field">
              <label htmlFor={`${id}-justification`}>{pl.suggestion.justification}</label>
              <p id={`${id}-hint`} className="hint">
                {t(pl.suggestion.justificationHint, JUSTIFICATION)}
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
              {busy
                ? pl.suggestion.saving
                : deciding === 'confirmed'
                  ? pl.suggestion.submitConfirm
                  : pl.suggestion.submitReject}
            </button>{' '}
            <button type="button" className="button" onClick={() => setDeciding(undefined)} disabled={busy}>
              {pl.suggestion.cancel}
            </button>
          </form>
        ) : (
          <p>
            <button type="button" className="button" onClick={() => setDeciding('confirmed')}>
              <Icon name="check" />
              {pl.suggestion.confirm}
            </button>{' '}
            <button type="button" className="button" onClick={() => setDeciding('rejected')}>
              <Icon name="cross" />
              {pl.suggestion.reject}
            </button>
          </p>
        )
      ) : null}
    </section>
  );
}
