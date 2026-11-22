import type { ReportFile } from '@olcys/core';
import { useId, useState } from 'react';
import { AddressText, Icon } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { t } from '../../i18n/t.ts';
import { api, errorMessage } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';

const MAX_PURPOSE = 500;

/** Saves a blob under `fileName` through a temporary object URL and a normal download link (no scripts, no popups). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const labelOf = (file: ReportFile): string => {
  const base = pl.report.downloads.kinds[file.kind];
  return file.captureId ? t(base, { id: file.captureId.slice(0, 8) }) : base;
};

/**
 * Downloads of the report and its exports with SHA-256 digests. A purpose is an optional text: when it is filled in it
 * goes along as the `X-Olcys-Purpose` header for the access log; a download always works without it.
 */
export function DownloadsPanel({ files }: { files: readonly ReportFile[] }) {
  const purposeId = useId();
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState<string>();
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<unknown>();

  const download = async (file: ReportFile) => {
    setBusy(file.path);
    setDone(undefined);
    setError(undefined);
    try {
      saveBlob(await api.download(file.path, purpose), file.fileName);
      setDone(file.fileName);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-labelledby="report-downloads" className="card stack">
      <h3 id="report-downloads">{pl.report.downloads.title}</h3>
      <p>{pl.report.downloads.intro}</p>
      <div className="field">
        <label htmlFor={purposeId}>{pl.report.downloads.purposeLabel}</label>
        <p id={`${purposeId}-hint`} className="hint">
          {pl.report.downloads.purposeHint}
        </p>
        <input
          id={purposeId}
          type="text"
          maxLength={MAX_PURPOSE}
          autoComplete="off"
          aria-describedby={`${purposeId}-hint`}
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{pl.report.downloads.file}</th>
              <th scope="col">{pl.report.downloads.size}</th>
              <th scope="col">{pl.report.downloads.sha}</th>
              <th scope="col">
                <span className="visually-hidden">{pl.report.downloads.download}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={`${file.kind}|${file.path}|${file.fileName}`}>
                <td>
                  {labelOf(file)}
                  <span className="muted small block">{file.fileName}</span>
                  {!file.available && file.kind === 'pdf' ? (
                    <span className="muted small block">{pl.report.downloads.pdfUnavailable}</span>
                  ) : null}
                </td>
                <td>{file.bytes === undefined ? pl.common.dash : formatBytes(file.bytes)}</td>
                <td className="break">{file.sha256 ? <AddressText value={file.sha256} /> : pl.common.dash}</td>
                <td>
                  <button
                    type="button"
                    className="button"
                    disabled={!file.available || busy !== undefined}
                    aria-label={`${pl.report.downloads.download}: ${labelOf(file)}`}
                    onClick={() => void download(file)}
                  >
                    <Icon name="download" />
                    {busy === file.path
                      ? pl.report.downloads.downloading
                      : file.available
                        ? pl.report.downloads.download
                        : pl.report.downloads.unavailable}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">{pl.report.downloads.exportsHint}</p>
      <div aria-live="polite">
        {done ? (
          <p className="hint">
            <Icon name="check" />
            {t(pl.report.downloads.downloaded, { name: done })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="notice">
            {pl.report.downloads.failed} {errorMessage(error)}
          </p>
        ) : null}
      </div>
    </section>
  );
}
