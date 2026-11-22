import type { Capture, ChangeEvent, ReportComputed, ReportFact, ReportInference, ReportModel } from '@olcys/core';
import { useState } from 'react';
import { CaptureCard } from '../../components/evidence.tsx';
import { AddressText, DateTime, HashText, KindBadge, LoadingState, type InfoKind } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import { isDecimalString, formatPln } from '../../lib/format.ts';
import { useJson } from '../../lib/use-api.ts';
import { ChangeGroups } from '../changes/ChangesTab.tsx';

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** The case report rendered natively from the report model: facts, computed results and inferences stay apart. */
export function ReportDocument({
  report,
  names = NO_NAMES,
}: {
  report: ReportModel;
  names?: ReadonlyMap<string, string>;
}) {
  const targets = new Map<string, string>([
    ...report.facts.map((f): [string, string] => [f.id, `fact-${f.id}`]),
    ...report.computed.map((c): [string, string] => [c.id, `computed-${c.id}`]),
    ...report.changesSincePrevious.map((c): [string, string] => [c.id, `change-${c.id}`]),
  ]);
  return (
    <article className="stack" aria-labelledby="report-document-title">
      <h3 id="report-document-title" className="visually-hidden">
        {pl.report.title}
      </h3>
      <p className="muted">{t(pl.report.generatedAt, { at: report.generatedAt })}</p>
      <Legend />
      <Reproducibility report={report} />
      <Summary report={report} />
      <FactsSection facts={report.facts} />
      <ComputedSection items={report.computed} targets={targets} />
      <InferencesSection items={report.inferences} targets={targets} />
      <FundFlow report={report} />
      <Changes changes={report.changesSincePrevious} names={names} />
      <Register report={report} />
    </article>
  );
}

function Legend() {
  const rows: [InfoKind, string][] = [
    ['fact', pl.report.legend.facts],
    ['computed', pl.report.legend.computed],
    ['inference', pl.report.legend.inferences],
  ];
  return (
    <aside className="kind-legend" aria-label={pl.report.legend.title}>
      <h4>{pl.report.legend.title}</h4>
      {rows.map(([kind, text]) => (
        <p key={kind}>
          <KindBadge kind={kind} /> <span className="muted">{text}</span>
        </p>
      ))}
    </aside>
  );
}

function Reproducibility({ report }: { report: ReportModel }) {
  const r = report.reproducibility;
  const rules = Object.entries(r.rulesVersions);
  const models = Object.entries(r.modelDigests ?? {});
  const status = r.weightsStatus ? (lookupStatus(r.weightsStatus) ?? r.weightsStatus) : pl.common.dash;
  return (
    <section aria-labelledby="report-repro" className="card">
      <h3 id="report-repro">{pl.report.sections.repro}</h3>
      <dl className="facts compact">
        <dt>{pl.report.repro.tool}</dt>
        <dd>{r.toolVersion}</dd>
        {r.gitCommit ? (
          <>
            <dt>{pl.report.repro.commit}</dt>
            <dd>
              <code className="mono">{r.gitCommit}</code>
            </dd>
          </>
        ) : null}
        <dt>{pl.report.repro.algorithm}</dt>
        <dd>{r.algorithmVersion || pl.common.dash}</dd>
        <dt>{pl.report.repro.weights}</dt>
        <dd>
          <code className="mono">{r.weightsVersion}</code>
        </dd>
        <dt>{pl.report.repro.weightsSha}</dt>
        <dd>
          <HashText value={r.weightsSha256} />
        </dd>
        <dt>{pl.report.repro.weightsStatus}</dt>
        <dd>{status}</dd>
        <dt>{pl.report.repro.rules}</dt>
        <dd>{rules.length === 0 ? pl.common.dash : rules.map(([, version]) => version).join(', ')}</dd>
        {models.length > 0 ? (
          <>
            <dt>{pl.report.repro.models}</dt>
            <dd>
              {models.map(([model, digest]) => (
                <span key={model} className="block">
                  <code className="mono">{model}</code> <HashText value={digest} />
                </span>
              ))}
            </dd>
          </>
        ) : null}
        <dt>{pl.report.repro.mode}</dt>
        <dd>{(pl.report.repro.modes as Record<string, string>)[r.mode] ?? r.mode}</dd>
        {r.sourcesConfigSha256 ? (
          <>
            <dt>{pl.report.repro.sourcesSha}</dt>
            <dd>
              <HashText value={r.sourcesConfigSha256} />
            </dd>
          </>
        ) : null}
        {r.dataSha256 ? (
          <>
            <dt>{pl.report.repro.dataSha}</dt>
            <dd>
              <HashText value={r.dataSha256} />
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

const lookupStatus = (status: string): string | undefined =>
  (pl.report.repro.weightsStatuses as Record<string, string>)[status];

/** ICD 203: each likelihood statement is its own paragraph and the analytic confidence is a separate sentence. */
function Summary({ report }: { report: ReportModel }) {
  const { headline, likelihoodStatements, analyticConfidence } = report.summary;
  return (
    <section aria-labelledby="report-summary" className="card">
      <h3 id="report-summary">{pl.report.sections.summary}</h3>
      <p>{headline}</p>
      {likelihoodStatements.length === 0 ? (
        <p className="muted">{pl.report.noLikelihoods}</p>
      ) : (
        <>
          {likelihoodStatements.map((statement) => (
            <p key={statement}>{statement}</p>
          ))}
          <p>{t(pl.report.confidence, { level: pl.report.confidenceLevels[analyticConfidence] })}</p>
        </>
      )}
    </section>
  );
}

function ClassSection({
  kind,
  id,
  title,
  children,
}: {
  kind: InfoKind;
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={`kind-block kind-block-${kind}`}>
      <div className="kind-block-head">
        <KindBadge kind={kind} />
        <h3 id={id} className="kind-block-title">
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

function FactsSection({ facts }: { facts: readonly ReportFact[] }) {
  return (
    <ClassSection kind="fact" id="report-facts" title={pl.report.sections.facts}>
      {facts.length === 0 ? (
        <p className="muted">{pl.report.none}</p>
      ) : (
        <ul className="plain-list">
          {facts.map((fact) => (
            <FactItem key={fact.id} fact={fact} />
          ))}
        </ul>
      )}
    </ClassSection>
  );
}

function FactItem({ fact }: { fact: ReportFact }) {
  return (
    <li id={`fact-${fact.id}`}>
      <p>{fact.statement}</p>
      {fact.quote ? <blockquote className="prewrap">{fact.quote}</blockquote> : null}
      <p className="muted small">
        {pl.report.collectedAt}: <DateTime iso={fact.collectedAt} />
      </p>
      <CaptureToggle captureId={fact.captureId} />
    </li>
  );
}

/** „Pokaż zabezpieczenie”: loads the capture on demand and shows its card. */
function CaptureToggle({ captureId }: { captureId: string }) {
  const [open, setOpen] = useState(false);
  const capture = useJson<Capture>(open ? apiPaths.capture(captureId) : null);
  return (
    <div>
      <button type="button" className="button small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? pl.report.hideCapture : pl.report.showCapture}
      </button>
      {open ? (
        capture.error ? (
          <p className="notice">{pl.report.captureError}</p>
        ) : capture.data ? (
          <ul className="plain-list">
            <CaptureCard capture={capture.data} />
          </ul>
        ) : (
          <LoadingState text={pl.report.captureLoading} />
        )
      ) : null}
    </div>
  );
}

function BasedOn({ ids, targets }: { ids: readonly string[]; targets: ReadonlyMap<string, string> }) {
  if (ids.length === 0) return null;
  return (
    <p className="muted small">
      {pl.report.basedOn}:{' '}
      {ids.map((id, index) => {
        const target = targets.get(id);
        return (
          <span key={id}>
            {index > 0 ? ', ' : null}
            {target ? <a href={`#${target}`}>{id}</a> : <code className="mono">{id}</code>}
          </span>
        );
      })}
    </p>
  );
}

function ComputedSection({
  items,
  targets,
}: {
  items: readonly ReportComputed[];
  targets: ReadonlyMap<string, string>;
}) {
  return (
    <ClassSection kind="computed" id="report-computed" title={pl.report.sections.computed}>
      {items.length === 0 ? (
        <p className="muted">{pl.report.none}</p>
      ) : (
        <ul className="plain-list">
          {items.map((item) => (
            <li key={item.id} id={`computed-${item.id}`}>
              <p>
                <span className="tag">{pl.report.computedKinds[item.kind]}</span> {item.statement}
              </p>
              <BasedOn ids={item.basedOn.filter((id) => targets.has(id))} targets={targets} />
              <details>
                <summary>{pl.report.data}</summary>
                <pre className="mono prewrap">{JSON.stringify(item.data, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </ClassSection>
  );
}

function InferencesSection({
  items,
  targets,
}: {
  items: readonly ReportInference[];
  targets: ReadonlyMap<string, string>;
}) {
  return (
    <ClassSection kind="inference" id="report-inferences" title={pl.report.sections.inferences}>
      {items.length === 0 ? (
        <p className="muted">{pl.report.none}</p>
      ) : (
        <ul className="plain-list">
          {items.map((item) => (
            <li key={item.id} id={`inference-${item.id}`}>
              <p>
                <span className={`tag${item.origin === 'ai_suggestion' ? ' tag-ai' : ''}`}>
                  {pl.report.origins[item.origin]}
                </span>
                <span className="tag tag-warn">{pl.report.requiresVerification}</span> {item.statement}
              </p>
              <BasedOn ids={item.basedOn} targets={targets} />
              {item.alternatives.length > 0 ? (
                <div>
                  <h4>{pl.report.alternatives}</h4>
                  <ul>
                    {item.alternatives.map((alternative) => (
                      <li key={alternative}>{alternative}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </ClassSection>
  );
}

function FundFlow({ report }: { report: ReportModel }) {
  const c = pl.report.fundFlowColumns;
  return (
    <section aria-labelledby="report-flow" className="card">
      <h3 id="report-flow">{pl.report.sections.fundFlow}</h3>
      {report.fundFlow.length === 0 ? (
        <p className="muted">{pl.report.none}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{c.at}</th>
                <th scope="col">{c.description}</th>
                <th scope="col">{c.tx}</th>
                <th scope="col">{c.pln}</th>
              </tr>
            </thead>
            <tbody>
              {report.fundFlow.map((step) => (
                <tr key={`${step.at}|${step.txHashes.join(',')}|${step.description}`}>
                  <td>
                    <DateTime iso={step.at} />
                  </td>
                  <td className="break">{step.description}</td>
                  <td className="break">
                    {step.txHashes.length === 0
                      ? pl.common.dash
                      : step.txHashes.map((hash) => <AddressText key={hash} value={hash} truncate />)}
                  </td>
                  <td>
                    {step.valuation && isDecimalString(step.valuation.pln)
                      ? formatPln(step.valuation.pln)
                      : pl.report.noValuation}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Changes({ changes, names }: { changes: readonly ChangeEvent[]; names: ReadonlyMap<string, string> }) {
  return (
    <section aria-labelledby="report-changes" className="card">
      <h3 id="report-changes">{pl.report.sections.changes}</h3>
      {changes.length === 0 ? (
        <p className="muted">{pl.changes.none}</p>
      ) : (
        <ChangeGroups changes={[...changes]} names={names} />
      )}
    </section>
  );
}

function Register({ report }: { report: ReportModel }) {
  const c = pl.report.registerColumns;
  return (
    <section aria-labelledby="report-register" className="card">
      <h3 id="report-register">{pl.report.sections.register}</h3>
      {report.evidenceRegister.length === 0 ? (
        <p className="muted">{pl.report.none}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{c.n}</th>
                <th scope="col">{c.capture}</th>
                <th scope="col">{c.url}</th>
                <th scope="col">{c.collectedAt}</th>
                <th scope="col">{c.manifest}</th>
                <th scope="col">{c.timestamp}</th>
              </tr>
            </thead>
            <tbody>
              {report.evidenceRegister.map((entry, index) => (
                <tr key={entry.captureId} id={`capture-${entry.captureId}`}>
                  <td>{index + 1}</td>
                  <td>{entry.sourceName ?? entry.captureId}</td>
                  <td className="break">
                    <AddressText value={entry.url} />
                  </td>
                  <td>
                    <DateTime iso={entry.collectedAt} />
                  </td>
                  <td>
                    <HashText value={entry.manifestSha256} />
                  </td>
                  <td>
                    {entry.timestamp
                      ? t(pl.report.timestampAt, {
                          at: entry.timestamp.genTime,
                          host: hostOf(entry.timestamp.tsaUrl),
                        })
                      : pl.report.timestampNone}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Host of the timestamp authority; a value that is not a URL is shown as it is. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
