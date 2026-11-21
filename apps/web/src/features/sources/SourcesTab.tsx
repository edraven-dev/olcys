import type { Capture, EgressLogEntry, Observation, OnlineAccount } from '@olcys/core';
import { useState } from 'react';
import { CaptureFiles } from '../../components/evidence.tsx';
import {
  AddressText,
  CaptureStatusBadge,
  DateTime,
  EmptyState,
  ErrorState,
  HashText,
  Icon,
  KindBlock,
  LoadingState,
  Verbatim,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import type { SourceItem } from '../../lib/domain.ts';
import { formatBytes } from '../../lib/format.ts';
import { useList } from '../../lib/use-api.ts';
import type { RunScope } from '../run/RunPage.tsx';
import { egressSummary } from '../run/run-model.ts';

export function SourcesTab({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const captures = useList<Capture>(apiPaths.runList(run.id, 'captures'), { version });
  const observations = useList<Observation>(apiPaths.runList(run.id, 'observations'), { version });
  const accounts = useList<OnlineAccount>(apiPaths.runList(run.id, 'accounts'), { version });
  const egress = useList<EgressLogEntry>(apiPaths.runList(run.id, 'egress'), { version });
  const sources = useList<SourceItem>(apiPaths.sources);
  const names = new Map((sources.data ?? []).map((s) => [s.id, s.name]));
  const sourceName = (id: string) => names.get(id) ?? id;

  return (
    <section aria-labelledby="sources-title" className="stack">
      <div>
        <h2 id="sources-title">{pl.sources.title}</h2>
        <p>{pl.sources.intro}</p>
      </div>

      <KindBlock kind="fact" title={pl.sources.capturesTitle}>
        {captures.error ? (
          <ErrorState title={pl.sources.loadError} error={captures.error} onRetry={captures.reload} />
        ) : !captures.data ? (
          <LoadingState />
        ) : captures.data.length === 0 ? (
          <EmptyState text={pl.sources.noCaptures} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{pl.sources.captureColumns.source}</th>
                  <th scope="col">{pl.sources.captureColumns.url}</th>
                  <th scope="col">{pl.sources.captureColumns.collectedAt}</th>
                  <th scope="col">{pl.sources.captureColumns.status}</th>
                  <th scope="col">{pl.sources.captureColumns.manifest}</th>
                  <th scope="col">{pl.sources.captureColumns.files}</th>
                </tr>
              </thead>
              <tbody>
                {captures.data.map((capture) => (
                  <tr key={capture.id} id={`capture-${capture.id}`}>
                    <td>{sourceName(capture.sourceId)}</td>
                    <td className="break">
                      <AddressText value={capture.url} />
                    </td>
                    <td>
                      <DateTime iso={capture.collectedAt} />
                    </td>
                    <td>
                      <CaptureStatusBadge status={capture.status} />
                      <span className="muted small block">{t(pl.evidence.http, { code: capture.httpStatus })}</span>
                    </td>
                    <td>
                      <HashText value={capture.manifestSha256} />
                    </td>
                    <td>
                      <CaptureFiles capture={capture} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </KindBlock>

      <KindBlock kind="fact" title={pl.sources.observationsTitle}>
        {!observations.data ? (
          observations.error ? (
            <ErrorState error={observations.error} onRetry={observations.reload} />
          ) : (
            <LoadingState />
          )
        ) : observations.data.length === 0 ? (
          <EmptyState text={pl.sources.noObservations} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{pl.sources.observationColumns.property}</th>
                  <th scope="col">{pl.sources.observationColumns.value}</th>
                  <th scope="col">{pl.sources.observationColumns.locator}</th>
                  <th scope="col">{pl.sources.observationColumns.capture}</th>
                </tr>
              </thead>
              <tbody>
                {observations.data.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {lookup(pl.changes.properties, o.property) ?? null} <Verbatim>{o.property}</Verbatim>
                    </td>
                    <td className="break">
                      <AddressText value={o.value} truncate />
                    </td>
                    <td className="break">
                      <Verbatim>{o.locator}</Verbatim>
                    </td>
                    <td>
                      <a href={`#capture-${o.captureId}`}>{t(pl.sources.toCapture, { id: o.captureId.slice(0, 8) })}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </KindBlock>

      <KindBlock kind="fact" title={pl.sources.accountsTitle}>
        {!accounts.data ? (
          <LoadingState />
        ) : accounts.data.length === 0 ? (
          <EmptyState text={pl.sources.noAccounts} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{pl.sources.accountColumns.platform}</th>
                  <th scope="col">{pl.sources.accountColumns.handle}</th>
                  <th scope="col">{pl.sources.accountColumns.profile}</th>
                  <th scope="col">{pl.sources.accountColumns.via}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.map((a) => (
                  <tr key={a.id}>
                    <td>{a.platform}</td>
                    <td>
                      <code className="mono">{a.handle}</code>
                    </td>
                    <td className="break">
                      <AddressText value={a.profileUrl} truncate />
                    </td>
                    <td>{lookup(pl.discovery, a.discoveredVia.method) ?? a.discoveredVia.method}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </KindBlock>

      <EgressLog entries={egress.data} error={egress.error} reload={egress.reload} sourceName={sourceName} />
    </section>
  );
}

export function EgressLog({
  entries,
  error,
  reload,
  sourceName,
}: {
  entries: EgressLogEntry[] | undefined;
  error?: unknown;
  reload?: () => void;
  sourceName: (id: string) => string;
}) {
  const [onlyDisclosed, setOnlyDisclosed] = useState(false);
  const [onlyDenied, setOnlyDenied] = useState(false);
  const rows = (entries ?? []).filter((e) => (!onlyDisclosed || e.containsIdentifier) && (!onlyDenied || !e.allowed));
  return (
    <section aria-labelledby="egress-title" className="card stack">
      <h3 id="egress-title">{pl.egress.title}</h3>
      <p className="muted">{pl.egress.description}</p>
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!entries ? (
        error ? null : (
          <LoadingState />
        )
      ) : entries.length === 0 ? (
        <EmptyState text={pl.egress.empty} />
      ) : (
        <>
          <p>{t(pl.egress.summary, egressSummary(entries))}</p>
          <div className="filters">
            <label className="check">
              <input type="checkbox" checked={onlyDisclosed} onChange={(e) => setOnlyDisclosed(e.target.checked)} />
              {pl.egress.filterDisclosure}
            </label>
            <label className="check">
              <input type="checkbox" checked={onlyDenied} onChange={(e) => setOnlyDenied(e.target.checked)} />
              {pl.egress.filterDenied}
            </label>
          </div>
          {rows.length === 0 ? (
            <EmptyState text={pl.egress.emptyFiltered} />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{pl.egress.columns.at}</th>
                    <th scope="col">{pl.egress.columns.source}</th>
                    <th scope="col">{pl.egress.columns.host}</th>
                    <th scope="col">{pl.egress.columns.method}</th>
                    <th scope="col">{pl.egress.columns.purpose}</th>
                    <th scope="col">{pl.egress.columns.disclosure}</th>
                    <th scope="col">{pl.egress.columns.decision}</th>
                    <th scope="col">{pl.egress.columns.http}</th>
                    <th scope="col">{pl.egress.columns.bytes}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <DateTime iso={e.at} />
                      </td>
                      <td>{sourceName(e.sourceId)}</td>
                      <td>
                        <Verbatim>{e.host}</Verbatim>
                      </td>
                      <td>{e.method}</td>
                      <td>
                        <Verbatim>{e.purpose}</Verbatim>
                      </td>
                      <td>
                        {e.containsIdentifier ? (
                          <span className="badge tone-warning">
                            <Icon name="warn" />
                            {pl.egress.disclosed}
                          </span>
                        ) : (
                          pl.common.no
                        )}
                      </td>
                      <td>
                        {e.allowed ? (
                          <span className="badge tone-good">
                            <Icon name="check" />
                            {pl.egress.allowed}
                          </span>
                        ) : (
                          <span className="badge tone-critical">
                            <Icon name="ban" />
                            {t(pl.egress.denied, { reason: e.denyReason ?? pl.common.notAvailable })}
                          </span>
                        )}
                        {e.error ? (
                          <span className="muted small block">{t(pl.egress.error, { error: e.error })}</span>
                        ) : null}
                      </td>
                      <td>{e.httpStatus ?? pl.common.dash}</td>
                      <td>{e.bytes !== undefined ? formatBytes(e.bytes) : pl.common.dash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
