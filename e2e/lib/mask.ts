/**
 * Masking of identifying data in presentation materials (README screenshots, the demo video). The application is
 * never changed: Playwright injects a script that finds the sensitive text in the rendered page and paints it over
 * with the CSS Custom Highlight API (`::highlight`, text hidden behind a blur), which leaves the DOM, and therefore
 * React and every assertion, untouched. Inputs holding such values are blurred. Synthetic data only, but the rule
 * for published materials is the same as for real ones.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { REPO_ROOT } from '../state.ts';

/** Masking is on for screenshots and the video unless `--no-mask` (env `E2E_NO_MASK=1`) says it is a live rehearsal. */
export const maskEnabled = (): boolean => process.env['E2E_NO_MASK'] !== '1';

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Case-insensitive literal without the `i` flag (which would also loosen the base58 patterns). */
const caseless = (text: string): string =>
  [...text]
    .map((ch) => (ch.toLowerCase() !== ch.toUpperCase() ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escape(ch)))
    .join('');

/** How the console abbreviates long values: the first 10 and the last 8 characters. */
export const shorten = (value: string): string => `${value.slice(0, 10)}…${value.slice(-8)}`;

const NOT_WORD = String.raw`(?<![\p{L}\p{N}_])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

/** The pattern sources for the generic formats; the persona literals are added by {@link buildMaskPattern}. */
export const GENERIC_PATTERNS: Record<string, string> = {
  email: String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`,
  evmTx: `${NOT_WORD}0x[0-9a-fA-F]{64}${NOT_WORD_AFTER}`,
  evm: `${NOT_WORD}0x[0-9a-fA-F]{40}${NOT_WORD_AFTER}`,
  hex64: `${NOT_WORD}[0-9a-fA-F]{64}${NOT_WORD_AFTER}`,
  bech32: `${NOT_WORD}(?:bc1|tb1)[\\p{L}\\p{N}]{20,100}`,
  base58: `${NOT_WORD}[13]${BASE58}{25,34}${NOT_WORD_AFTER}`,
  tron: `${NOT_WORD}T${BASE58}{33}${NOT_WORD_AFTER}`,
  // The console shortens addresses and hashes to „head…tail”.
  shortenedEmail: String.raw`[\p{L}\p{N}._%+-]{4,}…[\p{L}\p{N}.-]{3,}\.\p{L}{2,}`,
  shortened: `${NOT_WORD}(?:0x[0-9a-fA-F]{6,}|bc1[\\p{L}\\p{N}]{3,}|[T13]${BASE58}{5,}|[0-9a-fA-F]{8,})…[\\p{L}\\p{N}]{4,}`,
};

export interface MaskSource {
  /** Persona and address values from the fixture manifests. */
  literals: string[];
}

interface PersonaManifest {
  persona: Record<string, string>;
  syntheticIdentifiers: string[];
  addresses: Record<string, { address: string }>;
}

/** The synthetic persona's identifiers and every address of the fixture set, from the two manifests. */
export async function loadMaskSource(root: string = REPO_ROOT): Promise<MaskSource> {
  const demo = JSON.parse(await readFile(join(root, 'fixtures/demo/manifest.json'), 'utf8')) as {
    addressesFrom: string;
  };
  const persona = JSON.parse(await readFile(join(root, demo.addressesFrom), 'utf8')) as PersonaManifest;
  const literals = new Set<string>([
    ...Object.values(persona.persona),
    ...persona.syntheticIdentifiers,
    ...Object.values(persona.addresses).map((a) => a.address),
  ]);
  const all = [...literals].filter((value) => value.length >= 5);
  // The console shortens long values to „first 10 … last 8”.
  return { literals: [...all, ...all.filter((value) => value.length >= 20).map(shorten)] };
}

/** One global, unicode RegExp: URLs that carry a persona value, the persona values, and the generic formats. */
export function buildMaskRegExp(source: MaskSource): RegExp {
  const literals = [...source.literals].sort((a, b) => b.length - a.length).map(caseless);
  const alternatives = [
    ...(literals.length > 0
      ? [
          String.raw`https?:\/\/[^\s"'<>]*?(?:${literals.join('|')})[^\s"'<>]*`,
          `${NOT_WORD}(?:${literals.join('|')})${NOT_WORD_AFTER}`,
        ]
      : []),
    ...Object.values(GENERIC_PATTERNS),
  ];
  return new RegExp(alternatives.join('|'), 'gu');
}

/** What the mask would cover in `text` (used by the unit test and the checks). */
export function maskedParts(text: string, source: MaskSource): string[] {
  return [...text.matchAll(buildMaskRegExp(source))].map((match) => match[0]);
}

/** Script injected into every page of the context (an init script: it also bypasses the page's CSP). */
export function maskInitScript(source: MaskSource): string {
  const re = buildMaskRegExp(source);
  return `(() => {
  const RE = new RegExp(${JSON.stringify(re.source)}, 'gu');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'OPTION', 'NOSCRIPT']);
  const displayCache = new Map();
  const isInline = (el) => {
    let v = displayCache.get(el);
    if (v === undefined) { const d = getComputedStyle(el).display; v = d === 'inline' || d === 'contents'; displayCache.set(el, v); }
    return v;
  };
  const blockOf = (node) => {
    let el = node.parentElement;
    while (el && isInline(el)) el = el.parentElement;
    return el;
  };
  function segments() {
    displayCache.clear();
    const out = []; let text = ''; let prevBlock = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        for (let p = n.parentElement; p; p = p.parentElement) if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const block = blockOf(n);
      if (prevBlock !== null && block !== prevBlock) text += '\\n';
      prevBlock = block;
      out.push({ node: n, start: text.length });
      text += n.nodeValue;
    }
    return { out, text };
  }
  function locate(out, offset) {
    let lo = 0, hi = out.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (out[mid].start <= offset) lo = mid; else hi = mid - 1; }
    return out[lo];
  }
  function rangesFor(re) {
    if (!document.body) return [];
    const { out, text } = segments();
    if (out.length === 0) return [];
    const ranges = [];
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const a = locate(out, m.index), b = locate(out, m.index + m[0].length - 1);
      const r = document.createRange();
      r.setStart(a.node, Math.max(0, Math.min(a.node.nodeValue.length, m.index - a.start)));
      r.setEnd(b.node, Math.max(0, Math.min(b.node.nodeValue.length, m.index + m[0].length - b.start)));
      ranges.push(r);
    }
    return ranges;
  }
  const blurred = new WeakSet();
  const fieldText = (el) => el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].textContent : '') : el.value || '';
  function fields(re) {
    for (const el of document.querySelectorAll('input, textarea, select')) {
      re.lastIndex = 0;
      const hit = re.test(fieldText(el));
      if (hit) { el.style.filter = 'blur(7px)'; blurred.add(el); }
      else if (blurred.has(el)) { el.style.filter = ''; blurred.delete(el); }
    }
  }
  let current = [];
  function scan() {
    if (!document.body) return;
    current = rangesFor(RE);
    const highlight = new Highlight();
    for (const r of current) highlight.add(r);
    CSS.highlights.set('olcys-mask', highlight);
    fields(RE);
  }
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('::highlight(olcys-mask){color:transparent;background-color:rgba(100,116,139,.28);text-shadow:0 0 9px #0f172a,0 0 9px #0f172a;}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {}
  let pending = false;
  const schedule = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; scan(); }, 40); };
  new MutationObserver(schedule).observe(document, { childList: true, characterData: true, subtree: true });
  for (const type of ['input', 'change', 'focusin']) document.addEventListener(type, schedule, true);
  setInterval(scan, 500);
  document.addEventListener('DOMContentLoaded', scan);
  // Independent check used by the tests: text matching \`check\` that is not covered by a mask range.
  window.__olcysMaskUnmasked = (checkSource) => {
    scan();
    const check = new RegExp(checkSource, 'gu');
    const covered = (m) => current.some((r) => r.compareBoundaryPoints(Range.START_TO_START, m) <= 0 && r.compareBoundaryPoints(Range.END_TO_END, m) >= 0);
    const bad = rangesFor(check).filter((m) => !covered(m)).map((m) => m.toString());
    for (const el of document.querySelectorAll('input, textarea, select')) {
      check.lastIndex = 0;
      if (check.test(fieldText(el)) && !String(el.style.filter).includes('blur')) bad.push('field: ' + fieldText(el));
    }
    return bad;
  };
})();`;
}

/**
 * Fails when the page shows persona text or an address that the mask does not cover. The check list is independent
 * of the mask patterns: the persona's full name, nickname, e-mail and every fixture address, plus any e-mail.
 */
export async function assertMasked(page: Page, source: MaskSource): Promise<void> {
  const long = source.literals.filter((value) => value.length > 20);
  // The console also shows addresses and hashes shortened to „head…tail”.
  const shortened = long.map(shorten);
  const check = buildMaskRegExp({
    literals: [...source.literals.filter((v) => /[@_\s-]/.test(v)), ...long, ...shortened],
  }).source;
  const bad = (await page.evaluate(`window.__olcysMaskUnmasked(${JSON.stringify(check)})`)) as string[] | undefined;
  if (!bad) throw new Error('The masking script is not active on this page.');
  if (bad.length > 0) throw new Error(`Unmasked identifying text in the page: ${bad.slice(0, 5).join(' | ')}`);
}
