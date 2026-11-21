/**
 * Contribution waterfall of one hop, in log-odds bits: prior → each evidence item (signed) → total W.
 * Marks are plain SVG; labels and values are HTML text so they stay legible at phone width. Direction is carried by
 * the sign of the value as well as by colour; superseded items stay visible at zero length with a text tag.
 */
import type { HopResult } from '@olcys/core';
import { pl } from '../../i18n/pl.ts';
import { lookup, t } from '../../i18n/t.ts';
import { formatBits, formatNumber } from '../../lib/format.ts';
import { waterfallBars, waterfallDomain, type WaterfallBar } from './score-model.ts';

export function barLabel(bar: WaterfallBar): string {
  if (bar.kind === 'prior') return pl.waterfall.prior;
  if (bar.kind === 'anchor') return pl.waterfall.anchor;
  if (bar.kind === 'total') return pl.waterfall.total;
  return lookup(pl.features, bar.feature) ?? t(pl.common.unknownKey, { key: bar.feature ?? '' });
}

function tone(bar: WaterfallBar): string {
  if (bar.kind === 'total') return 'total';
  if (bar.kind !== 'feature') return 'neutral';
  if (!bar.counted) return 'muted';
  return bar.bits >= 0 ? 'up' : 'down';
}

function tooltip(bar: WaterfallBar): string {
  const base = t(pl.waterfall.rowTitle, { label: barLabel(bar), bits: formatBits(bar.bits) });
  const c = bar.contribution;
  if (!c) return base;
  const parts = [
    base,
    `${pl.waterfall.columns.grade}: ${c.reliability}`,
    `${pl.waterfall.columns.bf}: ${formatNumber(c.bayesFactor)}`,
    `${pl.waterfall.columns.rho}: ${formatNumber(c.rho)}`,
    `${pl.waterfall.columns.bfPrime}: ${formatNumber(c.discountedBayesFactor)}`,
  ];
  if (!c.counted) parts.push(pl.waterfall.notCountedHint);
  return parts.join(' · ');
}

export function Waterfall({ hop, title, caption }: { hop: HopResult; title: string; caption: string }) {
  const bars = waterfallBars(hop);
  const [min, max] = waterfallDomain(bars);
  const x = (value: number) => ((value - min) / (max - min || 1)) * 1000;
  const zero = x(0);
  return (
    <figure className="waterfall" aria-label={t(pl.waterfall.chartLabel, { title })}>
      <figcaption>
        <strong>{title}</strong>
        <span className="muted"> {caption}</span>
      </figcaption>
      <ol className="wf-rows">
        {bars.map((bar) => {
          const left = Math.min(x(bar.start), x(bar.end));
          const width = Math.abs(x(bar.end) - x(bar.start));
          return (
            <li key={bar.key} className={`wf-row wf-${tone(bar)}`} title={tooltip(bar)}>
              <span className="wf-label">
                {barLabel(bar)}
                {!bar.counted ? <span className="tag">{pl.waterfall.notCounted}</span> : null}
              </span>
              <svg className="wf-track" viewBox="0 0 1000 20" preserveAspectRatio="none" aria-hidden="true">
                <line className="wf-zero" x1={zero} x2={zero} y1="0" y2="20" />
                {width > 0 ? <rect className="wf-bar" x={left} y="4" width={Math.max(width, 3)} height="12" /> : null}
              </svg>
              <span className="wf-value">{bar.counted ? formatBits(bar.bits) : <s>{formatBits(bar.bits)}</s>}</span>
            </li>
          );
        })}
      </ol>
      <p className="muted small">{pl.waterfall.axis}</p>
    </figure>
  );
}

/** Table alternative of the waterfall (every value of the chart, plus the evidence reference). */
export function ContributionTable({
  hop,
  evidenceHref,
}: {
  hop: HopResult;
  evidenceHref: (captureId: string) => string | undefined;
}) {
  const bars = waterfallBars(hop);
  return (
    <div className="table-wrap">
      <table className="numeric">
        <thead>
          <tr>
            <th scope="col">{pl.waterfall.columns.feature}</th>
            <th scope="col">{pl.waterfall.columns.grade}</th>
            <th scope="col">{pl.waterfall.columns.bf}</th>
            <th scope="col">{pl.waterfall.columns.rho}</th>
            <th scope="col">{pl.waterfall.columns.bfPrime}</th>
            <th scope="col">{pl.waterfall.columns.bits}</th>
            <th scope="col">{pl.waterfall.columns.counted}</th>
            <th scope="col">{pl.waterfall.columns.evidence}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => {
            const c = bar.contribution;
            const href = c?.evidence.captureId ? evidenceHref(c.evidence.captureId) : undefined;
            return (
              <tr key={bar.key}>
                <th scope="row">{barLabel(bar)}</th>
                <td>{c ? c.reliability : pl.common.dash}</td>
                <td>{c ? formatNumber(c.bayesFactor) : pl.common.dash}</td>
                <td>{c ? formatNumber(c.rho) : pl.common.dash}</td>
                <td>{c ? formatNumber(c.discountedBayesFactor) : pl.common.dash}</td>
                <td>{formatBits(bar.bits)}</td>
                <td>{bar.counted ? pl.common.yes : pl.common.no}</td>
                <td>
                  {href ? <a href={href}>{pl.evidence.capture}</a> : null}
                  {c?.detail ? <span className="muted small"> {c.detail}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
