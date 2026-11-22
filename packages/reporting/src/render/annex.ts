/** Chapter 7 (changes since the previous run), 8 (evidence register, egress log) and 9 (methodology, limitations). */
import type { Capture, ChangeEvent } from '@olcys/core';
import { isAddressValuedProperty } from '@olcys/core';
import { formatUtc, plural } from '../format.ts';
import { join, markup, t, type Html, type SafeHtml } from '../html.ts';
import { pl } from '../i18n/pl.ts';
import { BAND_IDS, cmp, ICD203_SCALE, type View } from '../view.ts';
import { addr, block, captureRef, hash, list, muted, para, section, table, url } from './blocks.ts';
import { propertyLabel } from './links.ts';

/** A changed address-valued property (e.g. the profile's "Bitcoin address"): the wallet-swap alert. */
export function isWalletSwap(change: ChangeEvent): boolean {
  if (change.kind !== 'VALUE_CHANGED') return false;
  const flagged = (change as ChangeEvent & { wallet?: boolean }).wallet;
  return flagged === true || isAddressValuedProperty(change.key.property);
}

export function changeWhere(change: ChangeEvent): SafeHtml {
  if (change.key.platform === 'link') return t(pl.changes.linkWhere, { address: addr(change.key.locator) });
  return t(pl.changes.where, {
    platform: change.key.platform,
    property: propertyLabel(change.key.property),
    locator: change.key.locator,
  });
}

function changeValue(change: ChangeEvent, side: 'before' | 'after'): Html {
  const value = change[side];
  if (value === undefined) return '—';
  return isAddressValuedProperty(change.key.property) ? addr(value) : value;
}

function snapshotLine(view: View, change: ChangeEvent, side: 'before' | 'after'): SafeHtml {
  const captureId = side === 'before' ? change.beforeCaptureId : change.afterCaptureId;
  const capture = captureId ? view.captureById.get(captureId) : undefined;
  return t(pl.changes[side], {
    at: capture ? formatUtc(capture.collectedAt) : pl.common.unknown,
    ref: captureRef(view, captureId),
    where: changeWhere(change),
    value: changeValue(change, side),
  });
}

function alertCard(view: View, change: ChangeEvent): SafeHtml {
  return markup`<article class="card card-alert" id="zmiana-${change.id}"><h3>${pl.changes.alertTitle}</h3>${block('facts', list([snapshotLine(view, change, 'before'), snapshotLine(view, change, 'after')]))}${block(
    'computed',
    para(t(pl.changes.alertComputed, { kind: pl.changes.kinds[change.kind], where: changeWhere(change) })),
  )}${block('inferences', para(pl.changes.alertInference))}</article>`;
}

const order = (a: ChangeEvent, b: ChangeEvent) =>
  cmp(a.kind, b.kind) ||
  cmp(a.key.platform, b.key.platform) ||
  cmp(a.key.locator, b.key.locator) ||
  cmp(a.key.property, b.key.property) ||
  cmp(a.id, b.id);

export function changesSection(view: View): SafeHtml {
  const { data } = view;
  const title = pl.sections.changes;
  if (!data.previousRun && !data.changes.length) return section('zmiany', title, para(pl.changes.firstRun, 'empty'));
  const compared = data.previousRun
    ? para(
        t(pl.changes.compared, {
          previous: markup`<code>${data.previousRun.id}</code>`,
          at: formatUtc(data.previousRun.startedAt ?? data.previousRun.queuedAt),
        }),
      )
    : '';
  if (!data.changes.length) return section('zmiany', title, join([compared, para(pl.changes.none, 'empty')]));
  const swaps = data.changes.filter(isWalletSwap).toSorted(order);
  const others = data.changes.filter((c) => !isWalletSwap(c)).toSorted(order);
  const c = pl.changes.columns;
  const rows = others.map((ch) => [
    pl.changes.kinds[ch.kind] ?? ch.kind,
    changeWhere(ch),
    changeValue(ch, 'before'),
    ch.kind === 'SCORE_CHANGED'
      ? t(pl.changes.score, {
          before: ch.scoreBefore ?? ch.before ?? '—',
          after: ch.scoreAfter ?? ch.after ?? '—',
          cause: ch.cause ? pl.changes.causes[ch.cause] : pl.common.unknown,
        })
      : changeValue(ch, 'after'),
    ch.beforeCaptureId || ch.afterCaptureId
      ? t(pl.changes.evidence, {
          before: ch.beforeCaptureId ? captureRef(view, ch.beforeCaptureId) : '—',
          after: ch.afterCaptureId ? captureRef(view, ch.afterCaptureId) : '—',
        })
      : '—',
  ]);
  return section(
    'zmiany',
    title,
    join([
      compared,
      swaps.map((s) => alertCard(view, s)),
      rows.length
        ? block('computed', table([c.kind, c.where, c.before, c.after, c.evidence], rows, 'grid compact'))
        : '',
    ]),
  );
}

function registerRow(view: View, capture: Capture, earlier: boolean): SafeHtml {
  const n = view.captureNo.get(capture.id) ?? 0;
  const e = pl.evidence;
  const status = t(e.httpStatus, {
    status: pl.captureStatus[capture.status] ?? capture.status,
    code: capture.httpStatus,
  });
  const artifacts = (capture.artifacts ?? [])
    .toSorted((a, b) => cmp(a.kind, b.kind) || cmp(a.blob.sha256, b.blob.sha256))
    .map((a) => t(e.artifact, { kind: a.kind, sha: hash(a.blob.sha256) }));
  return markup`<tr id="zab-${n}"><td>${n}</td><td><strong>${view.sourceName(capture.sourceId)}</strong>${
    earlier ? markup` <span class="muted">(${e.earlier})</span>` : ''
  }<br>${url(capture.url)}${
    capture.finalUrl && capture.finalUrl !== capture.url
      ? markup`<br>${muted(t(e.finalUrl, { url: url(capture.finalUrl) }))}`
      : ''
  }${
    capture.archive
      ? markup`<br>${muted(
          t(e.archive, {
            provider: capture.archive.provider,
            snapshot: capture.archive.snapshotTimestamp,
            url: url(capture.archive.originalUrl),
          }),
        )}`
      : ''
  }<br>${muted(
    t(e.collector, {
      collector: capture.collector,
      tool: capture.toolVersion,
      clock: capture.clockSynced ? pl.common.yes : pl.common.no,
    }),
  )}</td><td>${formatUtc(capture.collectedAt)}</td><td class="status-${capture.status}">${status}</td><td>${join([t(e.manifest, { sha: hash(capture.manifestSha256) }), ...artifacts], markup`<br>`)}</td></tr>`;
}

function egressSummary(view: View): SafeHtml {
  const entries = view.data.egress;
  const e = pl.evidence;
  if (!entries.length) return para(e.egressNone, 'empty');
  const byHost = new Map<
    string,
    { sources: Set<string>; requests: number; allowed: number; denied: number; identifier: number; errors: number }
  >();
  for (const entry of entries) {
    const row = byHost.get(entry.host) ?? {
      sources: new Set<string>(),
      requests: 0,
      allowed: 0,
      denied: 0,
      identifier: 0,
      errors: 0,
    };
    row.sources.add(entry.sourceId);
    row.requests += 1;
    if (entry.allowed) row.allowed += 1;
    else row.denied += 1;
    if (entry.containsIdentifier) row.identifier += 1;
    if (entry.error) row.errors += 1;
    byHost.set(entry.host, row);
  }
  const rows = [...byHost.entries()]
    .toSorted(([a], [b]) => cmp(a, b))
    .map(([host, r]) => [
      markup`<code>${host}</code>`,
      [...r.sources]
        .toSorted(cmp)
        .map((s) => view.sourceName(s))
        .join(', '),
      String(r.requests),
      String(r.allowed),
      String(r.denied),
      String(r.identifier),
      String(r.errors),
    ]);
  const c = e.egressColumns;
  return join([
    para(e.egressIntro),
    para(
      t(e.egressTotals, {
        requests: plural(entries.length, pl.counts.requests),
        hosts: plural(byHost.size, pl.counts.hosts),
        denied: entries.filter((x) => !x.allowed).length,
        withIdentifier: entries.filter((x) => x.containsIdentifier).length,
        errors: entries.filter((x) => x.error).length,
      }),
    ),
    table([c.host, c.source, c.requests, c.allowed, c.denied, c.identifier, c.errors], rows, 'grid compact'),
  ]);
}

export function evidenceSection(view: View): SafeHtml {
  const own = new Set(view.data.captures.map((c) => c.id));
  const c = pl.evidence.columns;
  const register = view.captures.length
    ? markup`<div class="table-wrap"><table class="grid compact register"><thead><tr><th scope="col">${c.n}</th><th scope="col">${c.source}</th><th scope="col">${c.collectedAt}</th><th scope="col">${c.status}</th><th scope="col">${c.hashes}</th></tr></thead><tbody>${view.captures.map((capture) => registerRow(view, capture, !own.has(capture.id)))}</tbody></table></div>`
    : para(pl.evidence.none, 'empty');
  return section(
    'rejestr',
    pl.sections.evidence,
    join([
      para(pl.evidence.intro),
      block('facts', register),
      markup`<h3>${pl.evidence.egressTitle}</h3>`,
      block('facts', egressSummary(view)),
    ]),
  );
}

export function methodologySection(view: View): SafeHtml {
  const { data } = view;
  const m = pl.methodology;
  const bands = BAND_IDS.map((id) => [
    pl.bands[id].range,
    markup`<strong>${pl.bands[id].label}</strong>`,
    pl.bands[id].meaning,
  ]);
  let lower = 0;
  const icd = ICD203_SCALE.map((s) => {
    const row = [
      t(m.icdRange, { from: Math.round(lower * 100), to: Math.round(s.max * 100) }),
      pl.icd203[s.term] ?? s.term,
    ];
    lower = s.max;
    return row;
  });
  const sources = data.sources
    .toSorted((a, b) => cmp(a.id, b.id))
    .map((s) => [
      s.name,
      pl.compliance[s.compliance] ?? s.compliance,
      pl.reliability[s.reliability] ?? s.reliability,
      s.sendsIdentifiersExternally ? pl.common.yes : pl.common.no,
    ]);
  const sc = m.sourcesColumns;
  return section(
    'metodyka',
    pl.sections.methodology,
    join([
      markup`<h3>${m.scoreTitle}</h3>`,
      para(m.score),
      para(m.formula, 'formula'),
      para(m.dedupe),
      para(m.gates),
      markup`<h3>${m.analystTitle}</h3>`,
      para(m.analyst),
      para(
        t(m.weights, {
          version: data.run.config.weightsVersion,
          status: data.weightsStatus ? (pl.weightsStatus[data.weightsStatus] ?? data.weightsStatus) : pl.common.unknown,
          sha: hash(data.run.config.weightsSha256),
        }),
      ),
      markup`<h4>${m.bandsTitle}</h4>`,
      table([m.bandsColumns.range, m.bandsColumns.band, m.bandsColumns.meaning], bands),
      markup`<h4>${m.icdTitle}</h4>`,
      table([m.icdColumns.range, m.icdColumns.term], icd),
      para(m.icdNote),
      markup`<h3>${m.exclusionTitle}</h3>`,
      list(Object.entries(pl.exclusionRules).map(([id, name]) => markup`<strong>${id}</strong> — ${name}`)),
      markup`<h3>${m.cashOutTitle}</h3>`,
      list(Object.entries(pl.cashOutRules).map(([id, name]) => markup`<strong>${id}</strong> — ${name}`)),
      markup`<h3>${m.valuationTitle}</h3>`,
      para(m.valuation),
      markup`<h3>${m.osintTitle}</h3>`,
      list(m.osint),
      sources.length
        ? markup`<h4>${m.sourcesTitle}</h4>${table([sc.source, sc.compliance, sc.reliability, sc.identifiers], sources)}`
        : '',
      markup`<h3>${m.limitationsTitle}</h3>`,
      list(m.limitations),
      markup`<h3>${m.reproTitle}</h3>`,
      list(m.repro),
    ]),
  );
}
