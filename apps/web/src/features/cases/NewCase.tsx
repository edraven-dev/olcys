import type { CaseWithIdentifiers, ComplianceStatus, IdentifierKind, RunWithProgress } from '@olcys/core';
import { useId, useState, type ReactNode } from 'react';
import { Async, ComplianceBadge, ErrorState, Icon, useDocumentTitle } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';
import { api, ApiRequestError, apiPaths } from '../../lib/api.ts';
import { CONSOLE_CHAINS, chainName } from '../../lib/chains.ts';
import type { SourceItem } from '../../lib/domain.ts';
import { Link, navigate, routePath } from '../../lib/router.tsx';
import { useList } from '../../lib/use-api.ts';
import {
  buildCreateCaseRequest,
  errorsFromIssues,
  initialFormState,
  newIdentifierRow,
  validateCaseForm,
  type CaseFormState,
  type FormErrors,
  type IdentifierRow,
} from './case-form.ts';

const IDENTIFIER_KINDS = Object.keys(pl.identifierKinds) as IdentifierKind[];
const COMPLIANCE_ORDER: readonly ComplianceStatus[] = ['GREEN', 'AMBER', 'RED'];
const PLATFORM_SUGGESTIONS = ['bitcointalk', 'wykop', 'github', 'telegram', 'keybase', 'nostr', 'farcaster', 'ens'];

export function NewCasePage() {
  useDocumentTitle(pl.caseForm.title);
  const sources = useList<SourceItem>(apiPaths.sources);
  return (
    <section aria-labelledby="new-case-title" className="page">
      <h1 id="new-case-title">{pl.caseForm.title}</h1>
      <p className="lead">{pl.caseForm.intro}</p>
      <Async resource={sources} loadingText={pl.caseForm.sourcesLoading} errorTitle={pl.caseForm.sourcesError}>
        {(items) => <CaseForm sources={items} />}
      </Async>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {children(describedBy)}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          <Icon name="warn" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CaseForm({ sources }: { sources: SourceItem[] }) {
  const formId = useId();
  const [state, setState] = useState<CaseFormState>(() => initialFormState(sources));
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<CaseFormState>) => setState((s) => ({ ...s, ...patch }));
  const updateRow = (rowId: string, patch: Partial<IdentifierRow>) =>
    setState((s) => ({ ...s, identifiers: s.identifiers.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)) }));

  const submit = async (startRun: boolean) => {
    const found = validateCaseForm(state, sources);
    setErrors(found);
    setSubmitError(undefined);
    if (Object.keys(found).length > 0) {
      document.getElementById(`${formId}-summary`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<CaseWithIdentifiers>(apiPaths.cases, buildCreateCaseRequest(state, sources));
      if (startRun) {
        const run = await api.post<RunWithProgress>(apiPaths.caseRuns(created.id), { trigger: 'manual' });
        navigate(routePath({ name: 'run', caseId: created.id, runId: run.id, tab: 'overview' }));
      } else {
        navigate(routePath({ name: 'case', caseId: created.id }));
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.issues.length > 0) setErrors(errorsFromIssues(error.issues));
      setSubmitError(error);
      setBusy(false);
    }
  };

  const errorCount = Object.keys(errors).length;
  const fid = (name: string) => `${formId}-${name}`;

  return (
    <form
      className="case-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(true);
      }}
    >
      <div id={`${formId}-summary`} tabIndex={-1}>
        {errorCount > 0 ? (
          <p className="state state-error" role="alert">
            <Icon name="warn" />
            {pl.caseForm.fixErrors}
          </p>
        ) : null}
        {submitError ? <ErrorState error={submitError} /> : null}
      </div>

      <fieldset>
        <legend>{pl.caseForm.sectionCase}</legend>
        <Field id={fid('title')} label={pl.caseForm.caseTitle} error={errors['title']}>
          {(describedBy) => (
            <input
              id={fid('title')}
              value={state.title}
              onChange={(e) => update({ title: e.target.value })}
              aria-invalid={Boolean(errors['title'])}
              aria-describedby={describedBy}
              required
            />
          )}
        </Field>
        <Field id={fid('purpose')} label={pl.caseForm.purpose} hint={pl.caseForm.purposeHint} error={errors['purpose']}>
          {(describedBy) => (
            <textarea
              id={fid('purpose')}
              rows={3}
              value={state.purpose}
              onChange={(e) => update({ purpose: e.target.value })}
              aria-invalid={Boolean(errors['purpose'])}
              aria-describedby={describedBy}
              required
            />
          )}
        </Field>
        <Field
          id={fid('legal')}
          label={pl.caseForm.legalBasis}
          hint={pl.caseForm.legalBasisHint}
          error={errors['legalBasis']}
        >
          {(describedBy) => (
            <input
              id={fid('legal')}
              value={state.legalBasis}
              onChange={(e) => update({ legalBasis: e.target.value })}
              aria-invalid={Boolean(errors['legalBasis'])}
              aria-describedby={describedBy}
              required
            />
          )}
        </Field>
      </fieldset>

      <fieldset>
        <legend>{pl.caseForm.sectionIdentifiers}</legend>
        {errors['identifiers'] ? <p className="field-error">{errors['identifiers']}</p> : null}
        <datalist id={fid('platforms')}>
          {PLATFORM_SUGGESTIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </datalist>
        {state.identifiers.map((row, index) => (
          <IdentifierFields
            key={row.rowId}
            row={row}
            index={index}
            idBase={fid(row.rowId)}
            platformsId={fid('platforms')}
            errors={errors}
            canRemove={state.identifiers.length > 1}
            onChange={(patch) => updateRow(row.rowId, patch)}
            onRemove={() => update({ identifiers: state.identifiers.filter((r) => r.rowId !== row.rowId) })}
          />
        ))}
        <button
          type="button"
          className="button"
          onClick={() => update({ identifiers: [...state.identifiers, newIdentifierRow()] })}
          disabled={state.identifiers.length >= 20}
        >
          {pl.caseForm.addIdentifier}
        </button>
      </fieldset>

      <fieldset>
        <legend>{pl.caseForm.sectionScope}</legend>
        <h2 className="h3">{pl.caseForm.sources}</h2>
        {errors['sources'] ? <p className="field-error">{errors['sources']}</p> : null}
        {COMPLIANCE_ORDER.map((status) => (
          <SourceGroup
            key={status}
            status={status}
            sources={sources.filter((s) => s.compliance === status)}
            state={state}
            errors={errors}
            idBase={fid('src')}
            onToggle={(id, on) => update({ enabled: { ...state.enabled, [id]: on } })}
            onJustify={(id, text) => update({ justifications: { ...state.justifications, [id]: text } })}
          />
        ))}

        <fieldset className="nested">
          <legend>{pl.caseForm.chains}</legend>
          <div className="check-grid">
            {CONSOLE_CHAINS.map((chain) => (
              <label key={chain.id} className="check">
                <input
                  type="checkbox"
                  checked={state.chains.includes(chain.id)}
                  onChange={(e) =>
                    update({
                      chains: e.target.checked
                        ? [...state.chains, chain.id]
                        : state.chains.filter((c) => c !== chain.id),
                    })
                  }
                />
                {chainName(chain.id)}
              </label>
            ))}
          </div>
        </fieldset>

        <Field id={fid('depth')} label={pl.caseForm.maxPivotDepth} hint={pl.caseForm.maxPivotDepthHint}>
          {(describedBy) => (
            <select
              id={fid('depth')}
              value={state.maxPivotDepth}
              onChange={(e) => update({ maxPivotDepth: Number(e.target.value) })}
              aria-describedby={describedBy}
            >
              {[0, 1, 2, 3].map((depth) => (
                <option key={depth} value={depth}>
                  {depth}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>

      <fieldset>
        <legend>{pl.caseForm.sectionMinimisation}</legend>
        <p className="hint">{pl.caseForm.minimisation}</p>
        <label className={`check${errors['minimisation'] ? ' field-invalid' : ''}`}>
          <input
            type="checkbox"
            checked={state.minimisation}
            onChange={(e) => update({ minimisation: e.target.checked })}
            aria-invalid={Boolean(errors['minimisation'])}
          />
          {pl.caseForm.minimisationConfirm}
        </label>
        {errors['minimisation'] ? <p className="field-error">{errors['minimisation']}</p> : null}
      </fieldset>

      <div className="actions">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? pl.caseForm.submitting : pl.caseForm.submitAndRun}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void submit(false)}>
          {pl.caseForm.submit}
        </button>
        <Link className="button ghost" to={routePath({ name: 'cases' })}>
          {pl.caseForm.cancel}
        </Link>
      </div>
    </form>
  );
}

function IdentifierFields({
  row,
  index,
  idBase,
  platformsId,
  errors,
  canRemove,
  onChange,
  onRemove,
}: {
  row: IdentifierRow;
  index: number;
  idBase: string;
  platformsId: string;
  errors: FormErrors;
  canRemove: boolean;
  onChange(patch: Partial<IdentifierRow>): void;
  onRemove(): void;
}) {
  const n = index + 1;
  const err = (field: string) => errors[`identifiers.${index}.${field}`];
  return (
    <fieldset className="identifier-row nested">
      <legend>{t(pl.caseForm.identifierLegend, { n })}</legend>
      <div className="row-grid">
        <Field id={`${idBase}-kind`} label={pl.caseForm.kind}>
          {() => (
            <select
              id={`${idBase}-kind`}
              value={row.kind}
              onChange={(e) => onChange({ kind: e.target.value as IdentifierKind })}
            >
              {IDENTIFIER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {pl.identifierKinds[kind]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${idBase}-value`} label={pl.caseForm.value} error={err('value')}>
          {(describedBy) => (
            <input
              id={`${idBase}-value`}
              className={row.kind === 'crypto_address' ? 'mono' : undefined}
              value={row.value}
              onChange={(e) => onChange({ value: e.target.value })}
              aria-invalid={Boolean(err('value'))}
              aria-describedby={describedBy}
              autoComplete="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <Field
          id={`${idBase}-platform`}
          label={pl.caseForm.platform}
          hint={pl.caseForm.platformHint}
          error={err('platform')}
        >
          {(describedBy) => (
            <input
              id={`${idBase}-platform`}
              list={platformsId}
              value={row.platform}
              onChange={(e) => onChange({ platform: e.target.value })}
              aria-describedby={describedBy}
              autoComplete="off"
            />
          )}
        </Field>
        {row.kind === 'crypto_address' ? (
          <Field id={`${idBase}-chain`} label={pl.caseForm.chain} error={err('chain')}>
            {(describedBy) => (
              <select
                id={`${idBase}-chain`}
                value={row.chain}
                onChange={(e) => onChange({ chain: e.target.value })}
                aria-invalid={Boolean(err('chain'))}
                aria-describedby={describedBy}
              >
                <option value="">{pl.caseForm.chooseChain}</option>
                {CONSOLE_CHAINS.map((chain) => (
                  <option key={chain.id} value={chain.id}>
                    {chainName(chain.id)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={row.isAnchor}
          onChange={(e) => onChange({ isAnchor: e.target.checked })}
          aria-describedby={`${idBase}-anchor-hint`}
        />
        {pl.caseForm.anchor}
      </label>
      <p id={`${idBase}-anchor-hint`} className="hint">
        {pl.caseForm.anchorHint}
      </p>
      {canRemove ? (
        <button type="button" className="button ghost" onClick={onRemove}>
          {t(pl.caseForm.removeIdentifier, { n })}
        </button>
      ) : null}
    </fieldset>
  );
}

function SourceGroup({
  status,
  sources,
  state,
  errors,
  idBase,
  onToggle,
  onJustify,
}: {
  status: ComplianceStatus;
  sources: SourceItem[];
  state: CaseFormState;
  errors: FormErrors;
  idBase: string;
  onToggle(id: string, on: boolean): void;
  onJustify(id: string, text: string): void;
}) {
  if (sources.length === 0) return null;
  return (
    <details className={`source-group source-group-${status.toLowerCase()}`} open={status !== 'RED'}>
      <summary>
        <ComplianceBadge status={status} /> {pl.caseForm.group[status]} ({sources.length})
      </summary>
      <ul className="source-list">
        {sources.map((source) => {
          const id = `${idBase}-${source.id}`;
          const locked = status === 'RED';
          const checked = !locked && Boolean(state.enabled[source.id]);
          const error = errors[`source.${source.id}`];
          return (
            <li key={source.id} className={`source-item${locked ? ' locked' : ''}`}>
              <label className="check" htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  aria-describedby={`${id}-note`}
                  onChange={(e) => onToggle(source.id, e.target.checked)}
                />
                {locked ? <Icon name="lock" /> : null}
                <span className="source-name">{t(pl.caseForm.enableSource, { name: source.name })}</span>
              </label>
              <p id={`${id}-note`} className="hint">
                <span className="tag">{pl.sourceKinds[source.kind] ?? source.kind}</span>{' '}
                {locked ? t(pl.caseForm.redLocked, { note: source.complianceNote }) : source.complianceNote}
                {source.sendsIdentifiersExternally ? (
                  <span className="tag tag-warn">
                    <Icon name="warn" />
                    {pl.caseForm.disclosesIdentifier}
                  </span>
                ) : null}
                {source.reliability ? (
                  <span className="tag">{t(pl.caseForm.reliability, { grade: source.reliability })}</span>
                ) : null}
              </p>
              {source.tosUrl ? <p className="hint mono small">{t(pl.caseForm.tos, { url: source.tosUrl })}</p> : null}
              {status === 'AMBER' && checked ? (
                <Field
                  id={`${id}-why`}
                  label={t(pl.caseForm.amberJustification, { name: source.name })}
                  hint={pl.caseForm.amberJustificationHint}
                  error={error}
                >
                  {(describedBy) => (
                    <textarea
                      id={`${id}-why`}
                      rows={2}
                      value={state.justifications[source.id] ?? ''}
                      onChange={(e) => onJustify(source.id, e.target.value)}
                      aria-invalid={Boolean(error)}
                      aria-describedby={describedBy}
                      required
                    />
                  )}
                </Field>
              ) : error ? (
                <p className="field-error">{error}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
