/**
 * Corpus templates (`fixtures/corpus/templates/<lang>/<name>.<html|txt|json>`): a YAML front matter in a leading
 * `<!-- … -->` comment (title, maximum renders, slot definitions with role labels) and a body with placeholders.
 *
 *   {{ADDR:<slot>[:<ctx>]}}       address occurrence          {{NEG:<slot>[:<ctx>]}}   hard-negative occurrence
 *   {{URI:<slot>[:<ctx>]}}        payment URI (BIP-21/EIP-681) {{EXPLORER:<slot>[:<ctx>]}} block-explorer URL
 *   {{NET:<slot>}}                network keyword for the slot's address (sets the expected chain)
 *   {{SECRET:<kind>:<n>}}         secret placeholder — kept on disk (renumbered 1, 2, … per kind and document),
 *                                 filled in memory by the benchmark
 *   {{#ROWS:<min>-<max>}}…{{/ROWS}} repeated block (fresh slot values per row)
 *   {{BANNER}} {{NICK}} {{DATE}} {{TIME}} {{AMOUNT}} {{KWOTA}} {{PLN}} {{NUM}} {{N}}   fillers
 *
 * The context (`ctx`) of a placeholder is inferred from its position (attribute, `<pre>`/`<code>`, table cell,
 * JSON-LD script, plain text or JSON document) unless given explicitly.
 */
import { ROLE_CUES, type ChainId, type RoleCue } from '@olcys/core';
import { parse as parseYaml } from 'yaml';
import {
  NEGATIVE_KINDS,
  OBFUSCATIONS,
  SECRET_KINDS,
  type NegativeKind,
  type Obfuscation,
} from '../../../bench/types.ts';

export const DOC_TYPES = ['html', 'txt', 'json'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const CONTEXTS = ['text', 'pre', 'td', 'attr', 'href', 'jsonld', 'plain', 'json'] as const;
export type Ctx = (typeof CONTEXTS)[number];

export const POOLS = [
  'any',
  'bitcoin',
  'bitcoin.base58',
  'bitcoin.p2pkh',
  'bitcoin.p2sh',
  'bitcoin.bech32',
  'evm',
  'evm.eip55',
  'evm.unchecksummed',
  'tron',
] as const;
export type PoolName = (typeof POOLS)[number];

export interface AddrSlot {
  type: 'addr';
  pool: PoolName;
  role: RoleCue | 'none';
  /** Fixed expected chain, or `net` (decided by a `{{NET:<slot>}}` keyword). Default: by format / marker. */
  chain?: ChainId | 'net';
  /** `auto` (default: obfuscated at a per-context rate), `none`, or a fixed list (always one of them). */
  obf?: 'auto' | 'none' | Obfuscation[];
}

export interface NegSlot {
  type: 'neg';
  kinds: NegativeKind[];
}

export type SlotDef = AddrSlot | NegSlot;

export type Placeholder =
  | { kind: 'addr' | 'uri' | 'explorer' | 'neg'; slot: string; ctx: Ctx; attribute?: string }
  | { kind: 'net'; slot: string }
  | { kind: 'secret'; secret: (typeof SECRET_KINDS)[number]; index: number; ctx: Ctx }
  | { kind: 'filler'; name: string };

export type BodyNode =
  | { kind: 'text'; value: string }
  | { kind: 'ph'; ph: Placeholder; raw: string }
  | { kind: 'rows'; min: number; max: number; children: BodyNode[] };

export interface TemplateDef {
  name: string;
  lang: 'pl' | 'en';
  type: DocType;
  title: string;
  renders: number;
  /** Rendered only once no regular template can be filled (absorbs what is left in the pools). */
  fallback: boolean;
  slots: Record<string, SlotDef>;
  nodes: BodyNode[];
  /** Slots referenced inside a ROWS block (fresh value per row). */
  rowSlots: Set<string>;
  /** Path below the corpus directory. */
  path: string;
}

const FRONT_MATTER = /^<!--\n([\s\S]*?)\n-->\n/;
const PLACEHOLDER = /\{\{(#ROWS:\d+-\d+|\/ROWS|[A-Z]+(?::[\w-]+)*)\}\}/g;
const FILLERS = new Set(['BANNER', 'NICK', 'DATE', 'TIME', 'AMOUNT', 'KWOTA', 'PLN', 'NUM', 'N']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
const TAG = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)([^>]*)>/gi;

interface TagEvent {
  index: number;
  end: number;
  closing: boolean;
  name: string;
  attributes: string;
}

function fail(path: string, message: string): never {
  throw new Error(`template ${path}: ${message}`);
}

function parseSlot(path: string, name: string, raw: unknown): SlotDef {
  if (typeof raw !== 'object' || raw === null) fail(path, `slot ${name} must be a mapping`);
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value['neg'])) {
    const kinds = value['neg'] as unknown[];
    for (const kind of kinds) {
      if (!(NEGATIVE_KINDS as readonly unknown[]).includes(kind))
        fail(path, `slot ${name}: unknown negative kind ${String(kind)}`);
    }
    return { type: 'neg', kinds: kinds as NegativeKind[] };
  }
  const pool = value['pool'];
  if (!(POOLS as readonly unknown[]).includes(pool)) fail(path, `slot ${name}: unknown pool ${String(pool)}`);
  const role = value['role'];
  if (role !== 'none' && !(ROLE_CUES as readonly unknown[]).includes(role)) fail(path, `slot ${name}: unknown role`);
  const slot: AddrSlot = { type: 'addr', pool: pool as PoolName, role: role as AddrSlot['role'] };
  if (value['chain'] !== undefined) slot.chain = value['chain'] as AddrSlot['chain'];
  const obf = value['obf'];
  if (obf === 'auto' || obf === 'none') slot.obf = obf;
  else if (Array.isArray(obf)) {
    for (const o of obf) {
      if (!(OBFUSCATIONS as readonly unknown[]).includes(o))
        fail(path, `slot ${name}: unknown obfuscation ${String(o)}`);
    }
    slot.obf = obf as Obfuscation[];
  } else if (obf !== undefined) fail(path, `slot ${name}: obf must be auto, none or a list`);
  return slot;
}

/** Tag events of an HTML body (comments and doctype skipped). */
function tagEvents(body: string): TagEvent[] {
  const events: TagEvent[] = [];
  for (const m of body.matchAll(TAG)) {
    if (m[2] === undefined) continue;
    events.push({
      index: m.index,
      end: m.index + m[0].length,
      closing: m[1] === '/',
      name: m[2].toLowerCase(),
      attributes: m[3] ?? '',
    });
  }
  return events;
}

/** Context of a position in an HTML body: attribute value, JSON-LD script, code block, table cell or text. */
function htmlContext(body: string, events: TagEvent[], index: number): { ctx: Ctx; attribute?: string } {
  const lastLt = body.lastIndexOf('<', index);
  const lastGt = body.lastIndexOf('>', index);
  if (lastLt > lastGt) {
    const attribute = /([\w-]+)\s*=\s*["'][^"']*$/.exec(body.slice(lastLt, index))?.[1]?.toLowerCase();
    return { ctx: attribute === 'href' ? 'href' : 'attr', ...(attribute ? { attribute } : {}) };
  }
  const stack: TagEvent[] = [];
  for (const e of events) {
    if (e.index >= index) break;
    if (e.closing) {
      const at = stack.map((s) => s.name).lastIndexOf(e.name);
      if (at >= 0) stack.length = at;
    } else if (!VOID.has(e.name) && !e.attributes.trimEnd().endsWith('/')) {
      stack.push(e);
    }
  }
  if (stack.some((e) => e.name === 'script' && /application\/ld\+json/i.test(e.attributes))) return { ctx: 'jsonld' };
  if (stack.some((e) => e.name === 'pre' || e.name === 'code' || e.name === 'textarea')) return { ctx: 'pre' };
  const top = stack.at(-1);
  if (top && (top.name === 'td' || top.name === 'th')) return { ctx: 'td' };
  return { ctx: 'text' };
}

function parsePlaceholder(
  path: string,
  type: DocType,
  body: string,
  events: TagEvent[],
  raw: string,
  index: number,
): Placeholder {
  const parts = raw.split(':');
  const head = parts[0] ?? '';
  if (FILLERS.has(head) && parts.length === 1) return { kind: 'filler', name: head };
  const inferred =
    type === 'txt'
      ? { ctx: 'plain' as Ctx }
      : type === 'json'
        ? { ctx: 'json' as Ctx }
        : htmlContext(body, events, index);
  const explicit = head === 'SECRET' ? undefined : (parts[2] as Ctx | undefined);
  if (explicit !== undefined && !(CONTEXTS as readonly string[]).includes(explicit))
    fail(path, `unknown context in ${raw}`);
  const ctx = explicit ?? inferred.ctx;
  const attribute = 'attribute' in inferred ? inferred.attribute : undefined;
  switch (head) {
    case 'ADDR':
    case 'URI':
    case 'EXPLORER':
    case 'NEG': {
      const slot = parts[1];
      if (!slot) fail(path, `missing slot in ${raw}`);
      const kind = head === 'ADDR' ? 'addr' : head === 'URI' ? 'uri' : head === 'EXPLORER' ? 'explorer' : 'neg';
      return { kind, slot, ctx, ...(attribute ? { attribute } : {}) };
    }
    case 'NET': {
      const slot = parts[1];
      if (!slot) fail(path, `missing slot in ${raw}`);
      return { kind: 'net', slot };
    }
    case 'SECRET': {
      const secret = parts[1] as (typeof SECRET_KINDS)[number];
      const n = Number(parts[2]);
      if (!SECRET_KINDS.includes(secret) || !Number.isInteger(n) || n < 1) fail(path, `bad secret placeholder ${raw}`);
      return { kind: 'secret', secret, index: n, ctx: inferred.ctx };
    }
    default:
      return fail(path, `unknown placeholder {{${raw}}}`);
  }
}

export function parseTemplate(path: string, source: string): TemplateDef {
  const match = /^templates\/(pl|en)\/([a-z0-9-]+)\.(html|txt|json)$/.exec(path);
  if (!match) fail(path, 'path must be templates/<pl|en>/<name>.<html|txt|json>');
  const [, lang, name, ext] = match;
  const fm = FRONT_MATTER.exec(source);
  if (!fm) fail(path, 'missing front matter comment');
  const meta = (parseYaml(fm[1] ?? '') ?? {}) as Record<string, unknown>;
  const body = source.slice(fm[0].length);
  const type = ext as DocType;
  const slots: Record<string, SlotDef> = {};
  for (const [slotName, def] of Object.entries((meta['slots'] ?? {}) as Record<string, unknown>)) {
    slots[slotName] = parseSlot(path, slotName, def);
  }
  const events = type === 'html' ? tagEvents(body) : [];

  const root: BodyNode[] = [];
  let current = root;
  let rows: Extract<BodyNode, { kind: 'rows' }> | undefined;
  const rowSlots = new Set<string>();
  const topSlots = new Set<string>();
  let last = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (m.index > last) current.push({ kind: 'text', value: body.slice(last, m.index) });
    last = m.index + m[0].length;
    const raw = m[1] ?? '';
    if (raw.startsWith('#ROWS:')) {
      if (rows) fail(path, 'nested ROWS blocks');
      const [min, max] = raw.slice(6).split('-').map(Number);
      rows = { kind: 'rows', min: min ?? 1, max: max ?? 1, children: [] };
      root.push(rows);
      current = rows.children;
      continue;
    }
    if (raw === '/ROWS') {
      if (!rows) fail(path, 'unbalanced /ROWS');
      rows = undefined;
      current = root;
      continue;
    }
    const ph = parsePlaceholder(path, type, body, events, raw, m.index);
    if ('slot' in ph) {
      const def = slots[ph.slot];
      if (!def) fail(path, `undeclared slot ${ph.slot}`);
      if ((ph.kind === 'neg') !== (def.type === 'neg')) fail(path, `slot ${ph.slot} used with the wrong placeholder`);
      (rows ? rowSlots : topSlots).add(ph.slot);
    }
    current.push({ kind: 'ph', ph, raw: m[0] });
  }
  if (rows) fail(path, 'unterminated ROWS block');
  if (last < body.length) root.push({ kind: 'text', value: body.slice(last) });
  for (const slot of rowSlots) if (topSlots.has(slot)) fail(path, `slot ${slot} used inside and outside ROWS`);
  for (const slot of Object.keys(slots)) {
    if (!rowSlots.has(slot) && !topSlots.has(slot)) fail(path, `slot ${slot} is never used`);
  }
  const renders = Number(meta['renders'] ?? 1);
  if (!Number.isInteger(renders) || renders < 1) fail(path, 'renders must be a positive integer');
  return {
    name: name ?? '',
    lang: lang as 'pl' | 'en',
    type,
    title: String(meta['title'] ?? ''),
    renders,
    fallback: meta['fallback'] === true,
    slots,
    nodes: root,
    rowSlots,
    path,
  };
}
