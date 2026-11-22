import type { ApiMeta } from '@olcys/core';
import { Async, ComplianceBadge, HashText, useDocumentTitle } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import type { SourceItem } from '../../lib/domain.ts';
import { useJson, useList, type Resource } from '../../lib/use-api.ts';

/** Read-only view of the runtime configuration; nothing here can be changed or reveals a secret. */
export function SettingsPage() {
  useDocumentTitle(pl.settings.title);
  const meta = useJson<ApiMeta>(apiPaths.meta);
  const sources = useList<SourceItem>(apiPaths.sources);
  return (
    <section className="page stack" aria-labelledby="settings-title">
      <h1 id="settings-title">{pl.settings.title}</h1>
      <p className="muted">{pl.settings.readOnly}</p>
      <Async resource={meta} errorTitle={pl.settings.loadError}>
        {(data) => <SettingsView meta={data} sources={sources} />}
      </Async>
    </section>
  );
}

const weightsLabel = (status: string | undefined): string => {
  if (!status) return pl.settings.scoring.unknown;
  return (pl.settings.scoring as Record<string, string>)[status] ?? status;
};

/** The settings for already loaded data (also used by tests). */
export function SettingsView({ meta, sources }: { meta: ApiMeta; sources: Resource<SourceItem[]> }) {
  const rules = Object.entries(meta.scoring?.rulesVersions ?? {});
  return (
    <>
      <section aria-labelledby="settings-mode" className="card">
        <h2 id="settings-mode">{pl.settings.mode.title}</h2>
        <p>{pl.settings.mode[meta.mode]}</p>
      </section>

      <section aria-labelledby="settings-versions" className="card">
        <h2 id="settings-versions">{pl.settings.versions.title}</h2>
        <dl className="facts compact">
          <dt>{pl.settings.versions.tool}</dt>
          <dd>{meta.toolVersion}</dd>
          <dt>{pl.settings.versions.contracts}</dt>
          <dd>{meta.contracts}</dd>
          <dt>{pl.settings.versions.extractor}</dt>
          <dd>{meta.extractorVersion ?? pl.common.dash}</dd>
          <dt>{pl.settings.versions.rules}</dt>
          <dd>{rules.length === 0 ? pl.common.dash : rules.map(([, version]) => version).join(', ')}</dd>
        </dl>
      </section>

      <section aria-labelledby="settings-llm" className="card">
        <h2 id="settings-llm">{pl.settings.llm.title}</h2>
        {meta.llm ? (
          <dl className="facts compact">
            <dt>{pl.settings.llm.status}</dt>
            <dd>{meta.llm.enabled ? pl.settings.llm.enabled : pl.settings.llm.disabled}</dd>
            <dt>{pl.settings.llm.host}</dt>
            <dd>
              <code className="mono">{meta.llm.baseUrlHost || pl.common.dash}</code>
            </dd>
            <dt>{pl.settings.llm.model}</dt>
            <dd>
              <code className="mono">{meta.llm.model}</code>
            </dd>
            <dt>{pl.settings.llm.digest}</dt>
            <dd>{meta.llm.modelDigest ? <HashText value={meta.llm.modelDigest} /> : pl.common.dash}</dd>
          </dl>
        ) : (
          <p className="muted">{pl.settings.llm.notConfigured}</p>
        )}
        <p className="hint">{pl.settings.llm.howToSwap}</p>
        <p className="hint">{pl.settings.llm.zeroWeight}</p>
      </section>

      <section aria-labelledby="settings-scoring" className="card">
        <h2 id="settings-scoring">{pl.settings.scoring.title}</h2>
        <dl className="facts compact">
          <dt>{pl.settings.scoring.algorithm}</dt>
          <dd>{meta.scoring?.weightsVersion ?? pl.common.dash}</dd>
          <dt>{pl.settings.scoring.sha}</dt>
          <dd>{meta.scoring ? <HashText value={meta.scoring.weightsSha256} /> : pl.common.dash}</dd>
          <dt>{pl.settings.scoring.status}</dt>
          <dd>{weightsLabel(meta.scoring?.weightsStatus)}</dd>
        </dl>
      </section>

      <section aria-labelledby="settings-sources" className="card">
        <h2 id="settings-sources">{pl.settings.sources.title}</h2>
        <Async resource={sources} errorTitle={pl.settings.sources.loadError}>
          {(list) => <SourceRegister sources={list} />}
        </Async>
      </section>

      <section aria-labelledby="settings-privacy" className="card">
        <h2 id="settings-privacy">{pl.settings.privacy.title}</h2>
        <p>{pl.settings.privacy.intro}</p>
        {meta.telemetryOptOuts && meta.telemetryOptOuts.length > 0 ? (
          <ul className="plain-list">
            {meta.telemetryOptOuts.map((optOut) => (
              <li key={optOut.name}>
                <code className="mono">{optOut.name}</code>:{' '}
                {optOut.set ? pl.settings.privacy.on : pl.settings.privacy.off}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{pl.settings.privacy.none}</p>
        )}
      </section>
    </>
  );
}

function SourceRegister({ sources }: { sources: readonly SourceItem[] }) {
  const count = (status: SourceItem['compliance']) => sources.filter((s) => s.compliance === status).length;
  return (
    <>
      <p>
        {t(pl.settings.sources.summary, {
          total: sources.length,
          green: count('GREEN'),
          amber: count('AMBER'),
          red: count('RED'),
        })}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{pl.settings.sources.columns.name}</th>
              <th scope="col">{pl.settings.sources.columns.status}</th>
              <th scope="col">{pl.settings.sources.columns.default}</th>
              <th scope="col">{pl.settings.sources.columns.discloses}</th>
              <th scope="col">{pl.settings.sources.columns.note}</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td>
                  {source.name} <code className="mono small">{source.id}</code>
                </td>
                <td>
                  <ComplianceBadge status={source.compliance} />
                </td>
                <td>{source.enabledByDefault ? pl.common.yes : pl.common.no}</td>
                <td>{source.sendsIdentifiersExternally ? pl.common.yes : pl.common.no}</td>
                <td>{source.complianceNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
