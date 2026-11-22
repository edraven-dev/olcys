/**
 * Why a run is incomplete. Stages record an English engine sentence (`progress.partial`, for logs and tooling) and,
 * where the cause is known, a stable machine code with parameters (`progress.partialCodes`); the UI and the report
 * render Polish text from the code and fall back to the sentence for codes they do not know.
 */

export const PARTIAL_CODES = [
  'sources_unavailable',
  'pages_unavailable',
  'chain_incomplete',
  'counterparty_chain_incomplete',
  'cluster_expansion_limited',
  'address_type_probes_failed',
  'valuation_unavailable',
  'flow_graph_truncated',
] as const;
export type PartialCode = (typeof PARTIAL_CODES)[number];

/** A parameter is a scalar or a list of flat items (e.g. `{ chain, status, count }` per kind of gap). */
export type PartialParams = Record<string, string | number | Record<string, string | number>[]>;

export interface PartialReason {
  /** The English engine sentence (always present). */
  text: string;
  /** Stable code; absent for reasons recorded without one (older runs, other stages). */
  code?: string;
  params?: PartialParams;
}

/** Reads the reasons of a run from its progress record: coded ones keep their code, the rest only their text. */
export function readPartialReasons(progress: Readonly<Record<string, unknown>> | undefined): PartialReason[] {
  const texts = Array.isArray(progress?.['partial'])
    ? progress['partial'].filter((r): r is string => typeof r === 'string')
    : [];
  const coded = Array.isArray(progress?.['partialCodes'])
    ? progress['partialCodes'].filter(
        (r): r is PartialReason => typeof r === 'object' && r !== null && typeof (r as PartialReason).text === 'string',
      )
    : [];
  const unused = [...coded];
  return texts.map((text) => {
    const at = unused.findIndex((c) => c.text === text);
    if (at === -1) return { text };
    const [match] = unused.splice(at, 1);
    return match ?? { text };
  });
}

/** The progress fields for a list of reasons (`partial` texts and `partialCodes` of the coded ones). */
export function partialProgress(reasons: readonly PartialReason[]): Record<string, unknown> {
  if (!reasons.length) return {};
  const coded = reasons.filter((r) => r.code !== undefined);
  return {
    partial: reasons.map((r) => r.text),
    ...(coded.length ? { partialCodes: coded } : {}),
  };
}

/** How list parameters are rendered: `item` is the template of one entry, `labels` translates item fields by value. */
export interface PartialItemFormat {
  item: string;
  labels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (values[key] === undefined ? whole : String(values[key])));

/**
 * Polish (or any) text of a reason: the catalogue template of its code with `{param}` filled in, else the sentence.
 * List parameters are rendered entry by entry with `format`, joined by commas.
 */
export function renderPartialReason(
  reason: PartialReason,
  templates: Readonly<Record<string, string | undefined>>,
  format?: PartialItemFormat,
): string {
  const template = reason.code ? templates[reason.code] : undefined;
  if (!template) return reason.text;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = reason.params?.[key];
    if (value === undefined) return whole;
    if (!Array.isArray(value)) return String(value);
    if (!format) return reason.text;
    return value
      .map((entry) => {
        const labelled = Object.fromEntries(
          Object.entries(entry).map(([field, v]) => [field, format.labels?.[field]?.[String(v)] ?? v]),
        );
        return fill(format.item, labelled);
      })
      .join(', ');
  });
}
