/**
 * Evidence building blocks. Captured content is untrusted third-party data: files are offered only as downloads
 * from the console's own API (`/api/blobs/<sha256>`), never embedded, framed or rendered; URLs are copyable text,
 * never links that would make the analyst's browser contact the source.
 */
import { waybackTimestampToIso, type AddressCandidate, type Capture, type Observation } from '@olcys/core';
import type { ReactNode } from 'react';
import { pl } from '../i18n/pl.ts';
import { lookup, t } from '../i18n/t.ts';
import { apiPaths } from '../lib/api.ts';
import { formatBytes } from '../lib/format.ts';
import { AddressText, CaptureStatusBadge, DateTime, HashText, Icon } from './ui.tsx';

export function CaptureFiles({ capture }: { capture: Pick<Capture, 'artifacts'> }) {
  if (capture.artifacts.length === 0) return <span className="muted">{pl.common.dash}</span>;
  return (
    <ul className="plain-list files">
      {capture.artifacts.map((artifact) => (
        <li key={`${artifact.kind}-${artifact.blob.sha256}`}>
          <a
            href={apiPaths.blob(artifact.blob.sha256)}
            download={`${artifact.blob.sha256}.bin`}
            rel="noopener"
            title={t(pl.evidence.fileTitle, { sha: artifact.blob.sha256 })}
          >
            <Icon name="download" />
            {t(pl.evidence.fileLink, {
              kind: lookup(pl.artifactKinds, artifact.kind) ?? artifact.kind,
              size: formatBytes(artifact.blob.bytes),
            })}
          </a>{' '}
          <HashText value={artifact.blob.sha256} length={8} />
        </li>
      ))}
    </ul>
  );
}

/** An archived copy (Wayback snapshot): the archive's snapshot time is history, never the time of collection. */
function ArchiveFacts({ archive }: { archive: NonNullable<Capture['archive']> }) {
  let iso: string | undefined;
  try {
    iso = waybackTimestampToIso(archive.snapshotTimestamp);
  } catch {
    iso = undefined;
  }
  return (
    <>
      <dt>{pl.evidence.archive}</dt>
      <dd>
        {t(pl.evidence.archiveOf, { provider: pl.evidence.archiveProviders[archive.provider] ?? archive.provider })}{' '}
        {iso ? <DateTime iso={iso} /> : archive.snapshotTimestamp}
      </dd>
      <dt>{pl.evidence.archiveOriginal}</dt>
      <dd>
        <AddressText value={archive.originalUrl} />
      </dd>
    </>
  );
}

/** One capture with its Berkeley-Protocol collection fields. */
export function CaptureCard({
  capture,
  sourceName,
  id,
  children,
}: {
  capture: Capture;
  sourceName?: string;
  id?: string;
  children?: ReactNode;
}) {
  return (
    <li className="capture-card" id={id}>
      <p className="capture-head">
        <CaptureStatusBadge status={capture.status} /> <strong>{sourceName ?? capture.sourceId}</strong>{' '}
        <span className="muted">{t(pl.evidence.http, { code: capture.httpStatus })}</span>
      </p>
      <dl className="facts compact">
        <dt>{pl.evidence.url}</dt>
        <dd>
          <AddressText value={capture.url} />
        </dd>
        <dt>{pl.evidence.collectedAt}</dt>
        <dd>
          <DateTime iso={capture.collectedAt} />
          {capture.clockSynced ? null : <span className="tag tag-warn">{pl.evidence.clockNotSynced}</span>}
        </dd>
        {capture.archive ? <ArchiveFacts archive={capture.archive} /> : null}
        <dt>{pl.evidence.manifest}</dt>
        <dd>
          <HashText value={capture.manifestSha256} />
        </dd>
        <dt>{pl.evidence.files}</dt>
        <dd>
          <CaptureFiles capture={capture} />
        </dd>
      </dl>
      {children}
    </li>
  );
}

export function ObservationLine({ observation }: { observation: Observation }) {
  return (
    <p className="observation">
      <code className="mono">
        {t(pl.evidence.observation, { property: observation.property, value: observation.value })}
      </code>
      <span className="muted small"> {t(pl.evidence.locator, { locator: observation.locator })}</span>
    </p>
  );
}

/** Snippet as plain text with the matched address highlighted; redaction markers stay visible as text. */
export function CandidateSnippet({ candidate }: { candidate: AddressCandidate }) {
  const snippet = candidate.context.snippet;
  const at = snippet.indexOf(candidate.raw);
  const state = !candidate.checksum.present
    ? pl.evidence.checksumNone
    : candidate.checksum.valid
      ? pl.evidence.checksumValid
      : pl.evidence.checksumInvalid;
  return (
    <div className="snippet">
      <p className="muted small">{pl.evidence.snippet}</p>
      <blockquote className="mono prewrap">
        {at < 0 ? (
          snippet
        ) : (
          <>
            {snippet.slice(0, at)}
            <mark>{candidate.raw}</mark>
            {snippet.slice(at + candidate.raw.length)}
          </>
        )}
      </blockquote>
      <p className="muted small">
        {t(pl.evidence.checksum, { scheme: candidate.checksum.scheme, state })} ·{' '}
        {lookup(pl.textViews, candidate.view) ?? candidate.view}
      </p>
    </div>
  );
}
