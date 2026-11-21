/**
 * Building blocks shared by the report sections. The three statement classes are rendered only through `block()`,
 * so every statement sits in a labelled, visually distinct container: facts, computed results or inferences.
 */
import type { ChainId, Id } from '@olcys/core';
import { KNOWN_CHAINS } from '@olcys/core';
import { join, markup, t, type Html, type SafeHtml } from '../html.ts';
import { pl } from '../i18n/pl.ts';
import type { BandId, View } from '../view.ts';

export const STATEMENT_CLASSES = ['facts', 'computed', 'inferences'] as const;
export type StatementClass = (typeof STATEMENT_CLASSES)[number];

/** Polish ids used in markup (`data-statement`), stable for tests and readers of the HTML. */
export const STATEMENT_IDS: Record<StatementClass, string> = {
  facts: 'fakty',
  computed: 'obliczenia',
  inferences: 'wnioski',
};

function isEmpty(body: Html): boolean {
  if (body === null || body === undefined || body === false || body === '') return true;
  if (Array.isArray(body)) return (body as readonly Html[]).every(isEmpty);
  return typeof body === 'object' && 'value' in body && body.value === '';
}

/** A labelled block of one statement class; empty bodies render nothing. */
export function block(kind: StatementClass, body: Html): SafeHtml {
  if (isEmpty(body)) return markup``;
  const id = STATEMENT_IDS[kind];
  return markup`<div class="blk blk-${id}" data-statement="${id}"><p class="blk-label">${pl.classes[kind]}</p>${body}</div>`;
}

/** One labelled statement inside a compact entry (e.g. a step of the funds-flow narrative). */
export function statement(kind: StatementClass, body: Html): SafeHtml {
  if (isEmpty(body)) return markup``;
  const id = STATEMENT_IDS[kind];
  return markup`<p class="st st-${id}" data-statement="${id}"><span class="st-label">${pl.classes[kind]}:</span> ${body}</p>`;
}

export function section(id: string, title: string, body: Html): SafeHtml {
  return markup`<section class="report-section" id="${id}"><h2>${title}</h2>${body}</section>`;
}

export function para(content: Html, className?: string): SafeHtml {
  return className ? markup`<p class="${className}">${content}</p>` : markup`<p>${content}</p>`;
}

export function list(items: readonly Html[], className?: string): SafeHtml {
  if (!items.length) return markup``;
  const lis = items.map((item) => markup`<li>${item}</li>`);
  return className ? markup`<ul class="${className}">${lis}</ul>` : markup`<ul>${lis}</ul>`;
}

export function kv(rows: readonly (readonly [string, Html])[]): SafeHtml {
  return markup`<dl class="kv">${rows.map(([label, value]) => markup`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
}

export function table(headers: readonly string[], rows: readonly (readonly Html[])[], className = 'grid'): SafeHtml {
  return markup`<div class="table-wrap"><table class="${className}"><thead><tr>${headers.map((h) => markup`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map(
    (row) => markup`<tr>${row.map((cell) => markup`<td>${cell}</td>`)}</tr>`,
  )}</tbody></table></div>`;
}

export const addr = (address: string): SafeHtml => markup`<code class="addr">${address}</code>`;
export const hash = (sha: string): SafeHtml => markup`<code class="hash">${sha}</code>`;
/** URLs are evidence, shown as text and never as links (opening them would disclose the analyst's IP). */
export const url = (value: string): SafeHtml => markup`<span class="url">${value}</span>`;
export const muted = (content: Html): SafeHtml => markup`<span class="muted">${content}</span>`;

export function chainName(chain: ChainId | string): string {
  if (chain === 'evm:unknown') return 'EVM';
  return KNOWN_CHAINS.find((c) => c.id === chain)?.name ?? chain;
}

/** In-document reference to a capture in the evidence register (chapter 8). */
export function captureRef(view: View, captureId: Id | undefined): SafeHtml {
  if (!captureId) return markup``;
  const n = view.captureNo.get(captureId);
  if (n === undefined) return t(pl.common.captureMissing, { id: captureId });
  return markup`<a class="ref" href="#zab-${n}">${t(pl.common.captureRef, { n })}</a>`;
}

/** First `max` items plus a note when the list was cut. */
export function capped<T>(items: readonly T[], max: number, render: (item: T) => Html): SafeHtml {
  const shown = items.slice(0, max).map(render);
  const note =
    items.length > max ? para(t(pl.common.truncated, { shown: max, total: items.length }), 'muted') : markup``;
  return join([list(shown), note]);
}

/** The challenge brief's score band (`excluded` only for addresses rejected by a rule). */
export function bandBadge(band: BandId): SafeHtml {
  return markup`<span class="band band-${band}">${pl.bands[band].label}</span>`;
}

export function technical(content: Html): SafeHtml {
  return markup`<p class="technical"><span class="technical-label">${pl.common.technical}:</span> ${content}</p>`;
}
