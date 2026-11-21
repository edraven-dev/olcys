/**
 * Shared building blocks. Status is never conveyed by colour alone: every badge carries text and an icon.
 */
import type { CaptureStatus, ComplianceStatus, RunStatus } from '@olcys/core';
import { useEffect, useState, type ReactNode } from 'react';
import { pl } from '../i18n/pl.ts';
import { t } from '../i18n/t.ts';
import { errorMessage } from '../lib/api.ts';
import type { ScoreBand } from '../lib/band.ts';
import { formatDateTime, formatUtc, middleTruncate, shortHash } from '../lib/format.ts';
import type { Resource } from '../lib/use-api.ts';

// --- icons ------------------------------------------------------------------------------------------------------

const ICON_PATHS = {
  check: 'M3 8.5l3 3 7-7',
  cross: 'M4 4l8 8M12 4l-8 8',
  warn: 'M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.6v.4',
  lock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  info: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7.2v4M8 4.8v.4',
  clock: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 4.5V8l2.5 1.6',
  dot: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  download: 'M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13.5h10',
  fact: 'M4 1.8h5.5L12.5 5v9.2H4zM9.5 1.8V5h3M6 8h4.5M6 10.5h4.5',
  computed: 'M3.5 2.5h9v11h-9zM5.5 5h5M5.5 8h1M8 8h1M10.5 8h0M5.5 10.5h1M8 10.5h1',
  inference:
    'M6 11.5h4M6.5 13.8h3M8 1.8a4.2 4.2 0 0 0-2.4 7.6c.4.3.6.8.6 1.3v.8h3.6v-.8c0-.5.2-1 .6-1.3A4.2 4.2 0 0 0 8 1.8z',
  ban: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM3.6 3.6l8.8 8.8',
  link: 'M6.5 9.5l3-3M5 7.5L3.5 9a2.1 2.1 0 0 0 3 3L8 10.5M8 5.5L9.5 4a2.1 2.1 0 0 1 3 3L11 8.5',
} as const;
export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// --- badges -----------------------------------------------------------------------------------------------------

export type InfoKind = 'fact' | 'computed' | 'inference';
const KIND_ICON: Record<InfoKind, IconName> = { fact: 'fact', computed: 'computed', inference: 'inference' };
const KIND_HINT: Record<InfoKind, string> = {
  fact: pl.kinds.factHint,
  computed: pl.kinds.computedHint,
  inference: pl.kinds.inferenceHint,
};

export function KindBadge({ kind }: { kind: InfoKind }) {
  return (
    <span className={`kind-badge kind-${kind}`} title={KIND_HINT[kind]}>
      <Icon name={KIND_ICON[kind]} />
      {pl.kinds[kind]}
    </span>
  );
}

/** A block whose statement class (fact / computation / inference) is labelled and styled distinctly. */
export function KindBlock({
  kind,
  title,
  children,
  headingLevel = 3,
}: {
  kind: InfoKind;
  title?: string;
  children: ReactNode;
  headingLevel?: 3 | 4;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <div className={`kind-block kind-block-${kind}`}>
      <div className="kind-block-head">
        <KindBadge kind={kind} />
        {title ? <Heading className="kind-block-title">{title}</Heading> : null}
      </div>
      {children}
    </div>
  );
}

export function KindLegend() {
  return (
    <aside className="kind-legend" aria-label={pl.kinds.legend}>
      {(['fact', 'computed', 'inference'] as const).map((kind) => (
        <p key={kind}>
          <KindBadge kind={kind} /> <span className="muted">{KIND_HINT[kind]}</span>
        </p>
      ))}
    </aside>
  );
}

const RUN_STATUS_ICON: Record<RunStatus, IconName> = {
  queued: 'clock',
  running: 'clock',
  succeeded: 'check',
  partial: 'warn',
  failed: 'cross',
  cancelled: 'ban',
};
const RUN_STATUS_TONE: Record<RunStatus, string> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'good',
  partial: 'warning',
  failed: 'critical',
  cancelled: 'neutral',
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge tone-${RUN_STATUS_TONE[status] ?? 'neutral'}`}>
      <Icon name={RUN_STATUS_ICON[status] ?? 'info'} />
      {pl.runStatus[status] ?? status}
    </span>
  );
}

const CAPTURE_TONE: Record<CaptureStatus, string> = {
  ok: 'good',
  not_found: 'neutral',
  blocked: 'warning',
  login_wall: 'warning',
  captcha: 'warning',
  error: 'critical',
};
const CAPTURE_ICON: Record<CaptureStatus, IconName> = {
  ok: 'check',
  not_found: 'dot',
  blocked: 'ban',
  login_wall: 'lock',
  captcha: 'ban',
  error: 'cross',
};

export function CaptureStatusBadge({ status }: { status: CaptureStatus }) {
  return (
    <span className={`badge tone-${CAPTURE_TONE[status] ?? 'neutral'}`}>
      <Icon name={CAPTURE_ICON[status] ?? 'info'} />
      {pl.captureStatus[status] ?? status}
    </span>
  );
}

const COMPLIANCE_ICON: Record<ComplianceStatus, IconName> = { GREEN: 'check', AMBER: 'warn', RED: 'lock' };

export function ComplianceBadge({ status }: { status: ComplianceStatus }) {
  return (
    <span className={`badge compliance-${status.toLowerCase()}`} title={pl.complianceHint[status]}>
      <Icon name={COMPLIANCE_ICON[status]} />
      {pl.compliance[status]}
    </span>
  );
}

const BAND_ICON: Record<ScoreBand, IconName> = {
  BARDZO_WYSOKIE: 'check',
  PRAWDOPODOBNE: 'check',
  SREDNIE: 'info',
  NISKIE: 'dot',
  WYKLUCZENIE: 'ban',
};

export function BandBadge({ band, withRange = true }: { band: ScoreBand; withRange?: boolean }) {
  return (
    <span className={`badge band band-${band.toLowerCase()}`} title={pl.bandHints[band]}>
      <Icon name={BAND_ICON[band]} />
      {pl.bands[band]}
      {withRange ? <span className="band-range">{pl.bandRanges[band]}</span> : null}
    </span>
  );
}

/** 0–100 meter with the cheat-sheet band boundaries (10, 40, 60, 80) as ticks. */
export function ScoreMeter({ score, band }: { score: number; band: ScoreBand }) {
  const value = Math.max(0, Math.min(100, score));
  return (
    <svg
      className={`score-meter band-${band.toLowerCase()}`}
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      role="img"
      aria-label={t(pl.links.scoreMeter, { score: value, band: pl.bands[band] })}
    >
      <rect className="score-meter-track" x="0" y="2" width="100" height="6" />
      <rect className="score-meter-fill" x="0" y="2" width={value} height="6" />
      {[10, 40, 60, 80].map((tick) => (
        <line key={tick} className="score-meter-tick" x1={tick} x2={tick} y1="0" y2="10" />
      ))}
    </svg>
  );
}

// --- values -----------------------------------------------------------------------------------------------------

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <button
      type="button"
      className="icon-button"
      onClick={copy}
      aria-label={label ?? t(pl.common.copyLabel, { value })}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      <span className="visually-hidden" aria-live="polite">
        {copied ? pl.common.copied : ''}
      </span>
    </button>
  );
}

/** Address in monospace, middle-truncated when asked, full value in the tooltip and on copy. */
export function AddressText({ value, truncate = false }: { value: string; truncate?: boolean }) {
  return (
    <span className="mono-value">
      <code className="mono" title={t(pl.common.fullValue, { value })}>
        {truncate ? middleTruncate(value) : value}
      </code>
      <CopyButton value={value} />
    </span>
  );
}

export function HashText({ value, length = 12 }: { value: string; length?: number }) {
  return (
    <span className="mono-value">
      <code className="mono" title={t(pl.common.fullValue, { value })}>
        {shortHash(value, length)}…
      </code>
      <CopyButton value={value} />
    </span>
  );
}

export function DateTime({ iso }: { iso: string | undefined }) {
  if (!iso) return <span className="muted">{pl.common.dash}</span>;
  return (
    <time dateTime={iso} title={t(pl.common.utcTitle, { value: formatUtc(iso) })}>
      {formatDateTime(iso)}
    </time>
  );
}

/** Text that came from a source or the engine: shown verbatim, never translated or rendered as HTML. */
export function Verbatim({ children }: { children: string }) {
  return <code className="mono verbatim">{children}</code>;
}

// --- async states ------------------------------------------------------------------------------------------------

export function LoadingState({ text = pl.common.loading }: { text?: string }) {
  return (
    <output className="state state-loading">
      <Icon name="clock" />
      {text}
    </output>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <p className="state state-empty">
      <Icon name="info" />
      {text}
    </p>
  );
}

export function ErrorState({ title, error, onRetry }: { title?: string; error: unknown; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p>
        <Icon name="warn" />
        {title ? <strong>{title} </strong> : null}
        {errorMessage(error)}
      </p>
      {onRetry ? (
        <button type="button" className="button" onClick={onRetry}>
          {pl.common.retry}
        </button>
      ) : null}
    </div>
  );
}

/**
 * What is wrong with a resource: `stale` — the last refresh failed and older data is shown; `unavailable` — the
 * request failed and there is no data (never to be confused with an empty result).
 */
export function resourceIssue(resource: Pick<Resource<unknown>, 'data' | 'error'>): 'stale' | 'unavailable' | null {
  if (!resource.error) return null;
  return resource.data === undefined ? 'unavailable' : 'stale';
}

/** Warning shown above data that could not be refreshed, with the time of the data and a retry. */
export function StaleNotice({ resource }: { resource: Resource<unknown> }) {
  const time = resource.updatedAt ? formatDateTime(new Date(resource.updatedAt).toISOString()) : pl.common.dash;
  return (
    <div className="state state-warning" role="alert">
      <p>
        <Icon name="warn" />
        <strong>{t(pl.common.stale, { time })} </strong>
        {errorMessage(resource.error)}
      </p>
      <button type="button" className="button" onClick={resource.reload}>
        {pl.common.retry}
      </button>
    </div>
  );
}

/** Notices for every failed resource of a view (stale data or an unavailable section), each with a retry. */
export function ResourceNotices({ resources }: { resources: readonly Resource<unknown>[] }) {
  const failed = resources.filter((r) => resourceIssue(r) !== null);
  if (failed.length === 0) return null;
  return (
    <div className="stack">
      {failed.map((resource, index) =>
        resourceIssue(resource) === 'stale' ? (
          // oxlint-disable-next-line react/no-array-index-key -- resources have no identity of their own
          <StaleNotice key={index} resource={resource} />
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- resources have no identity of their own
          <ErrorState key={index} title={pl.common.unavailable} error={resource.error} onRetry={resource.reload} />
        ),
      )}
    </div>
  );
}

/**
 * Renders loading / error / empty states around a resource; children receive the loaded data. A failed request is
 * always visible: without data as "section unavailable", with older data as a stale-data warning above it.
 */
export function Async<T>({
  resource,
  errorTitle = pl.common.unavailable,
  loadingText,
  isEmpty,
  emptyText,
  children,
}: {
  resource: Resource<T>;
  errorTitle?: string;
  loadingText?: string;
  isEmpty?: (data: T) => boolean;
  emptyText?: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.data === undefined) {
    if (resource.error) return <ErrorState title={errorTitle} error={resource.error} onRetry={resource.reload} />;
    return <LoadingState text={loadingText} />;
  }
  const stale = resource.error ? <StaleNotice resource={resource as Resource<unknown>} /> : null;
  if (isEmpty && emptyText && isEmpty(resource.data)) {
    return (
      <>
        {stale}
        <EmptyState text={emptyText} />
      </>
    );
  }
  return (
    <>
      {stale}
      {children(resource.data)}
    </>
  );
}

export function useDocumentTitle(page: string): void {
  useEffect(() => {
    document.title = t(pl.app.pageTitle, { page });
  }, [page]);
}
