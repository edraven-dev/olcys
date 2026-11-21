/**
 * HTML → views: visible_text, inline_joined, attribute, meta and json_ld, with DOM context per segment
 * (code, quote, hidden, block, container, anchor, enclosing link, structural label) and source ranges.
 */
import type { TextView } from '@olcys/core';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type { ViewText } from '../pipeline-types.ts';
import { alignDecoded } from './align.ts';
import { collapsedValue, FlowBuilder, LineBuilder, type BlockContext, type SegmentMeta } from './builders.ts';
import { appendJsonDocument, type JsonViewState } from './json.ts';

type ParentNode = DefaultTreeAdapterMap['parentNode'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'option',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);
const SKIP_TAGS = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'head',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
]);
const CODE_TAGS = new Set(['pre', 'code', 'kbd', 'samp', 'tt', 'textarea']);
const CODE_CLASS = /^(?:code|codeblock|highlight|hljs|language-[\w-]+)$/;
const PRESERVE_TAGS = new Set(['pre', 'textarea', 'listing', 'xmp']);
const QUOTE_TAGS = new Set(['blockquote', 'q']);
const CONTAINER_TAGS = new Set([
  'article',
  'section',
  'main',
  'aside',
  'header',
  'footer',
  'nav',
  'li',
  'tr',
  'table',
  'ul',
  'ol',
  'dl',
  'blockquote',
  'form',
]);
const CONTAINER_CLASSES = new Set([
  'post',
  'message',
  'entry',
  'comment',
  'windowbg',
  'windowbg2',
  'tgme_widget_message',
]);
const ATTRIBUTE_NAMES = new Set([
  'href',
  'src',
  'value',
  'title',
  'alt',
  'placeholder',
  'aria-label',
  'label',
  'action',
  'cite',
  'content',
]);
const ANCHOR_ID = /^(?:msg|post|wpis|entry|comment)[-_]?\w+$/i;
const HEADING = /^h([1-6])$/;
const JSON_SCRIPT = /^\s*application\/(?:ld\+)?json\s*(?:;.*)?$/i;
const LABEL_MAX = 100;

interface Inherited {
  path: string;
  inCode: boolean;
  preserve: boolean;
  quoted: boolean;
  hidden: boolean;
  container: number;
  dataAnchor?: string;
  href?: string;
  structuralLabel?: string;
}

function isElement(node: ChildNode | ParentNode): node is Element {
  return 'tagName' in node;
}

function isText(node: ChildNode): node is TextNode {
  return node.nodeName === '#text';
}

function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function classList(el: Element): string[] {
  return (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean);
}

function elementChildren(el: ParentNode): Element[] {
  return el.childNodes.filter((c): c is Element => isElement(c));
}

/** Collapsed text content of an element (scripts and styles skipped). */
function textContent(node: ParentNode): string {
  const out: string[] = [];
  const visit = (n: ParentNode): void => {
    for (const child of n.childNodes) {
      if (isText(child)) out.push(child.value);
      else if (isElement(child) && !SKIP_TAGS.has(child.tagName)) visit(child);
    }
  };
  visit(node);
  return out
    .join(' ')
    .replace(/[\t\n\f\r ]+/g, ' ')
    .trim();
}

function cleanLabel(text: string): string | undefined {
  const label = text
    .replace(/\s*:\s*$/, '')
    .trim()
    .slice(0, LABEL_MAX);
  return label.length > 0 ? label : undefined;
}

function isHidden(el: Element): boolean {
  if (attr(el, 'hidden') !== undefined) return true;
  if (attr(el, 'aria-hidden')?.trim().toLowerCase() === 'true') return true;
  const style = attr(el, 'style');
  return style !== undefined && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

function isContainer(el: Element, classes: string[]): boolean {
  if (CONTAINER_TAGS.has(el.tagName)) return true;
  const role = attr(el, 'role')?.trim().toLowerCase();
  if (role === 'note' || role === 'article') return true;
  return classes.some((c) => CONTAINER_CLASSES.has(c));
}

/** Range of an attribute VALUE in the source (parse5 locates `name="value"`). */
function attributeValueRange(
  el: Element,
  name: string,
  source: string,
  value: string,
): { start: number; end: number } | undefined {
  const loc = el.sourceCodeLocation?.attrs?.[name];
  if (!loc) return undefined;
  const raw = source.slice(loc.startOffset, loc.endOffset);
  const eq = raw.indexOf('=');
  if (eq < 0) return { start: loc.endOffset, end: loc.endOffset };
  let start = loc.startOffset + eq + 1;
  while (start < loc.endOffset && /\s/.test(source[start] ?? '')) start += 1;
  const quote = source[start];
  if (quote === '"' || quote === "'") return { start: start + 1, end: Math.max(start + 1, loc.endOffset - 1) };
  return { start, end: Math.max(start, Math.min(loc.endOffset, start + value.length)) };
}

interface TableInfo {
  headers: string[];
}

/** Builds the HTML views of one decoded artifact. */
export function buildHtmlViews(captureId: string, html: string, artifactIndex: number): ViewText[] {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const visible = new FlowBuilder();
  const joined = new FlowBuilder();
  const attributes = new LineBuilder();
  const meta = new LineBuilder();
  const json = new LineBuilder();
  const jsonState: JsonViewState = { nextContainer: 1 };
  const warnings: string[] = [];

  const containerIds = new Map<Element, number>();
  let nextContainer = 1;
  let lastNamedAnchor: string | undefined;
  const headings: (string | undefined)[] = [];
  const tables: TableInfo[] = [];
  const labelFor = new Map<string, string>();
  let lang: string | undefined;

  const headingPath = (): string[] => headings.filter((h): h is string => typeof h === 'string');

  // Pre-pass: <label for>, <html lang>, <title>/<meta>, JSON scripts (also in <head>).
  const prepass = (node: ParentNode): void => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      const tag = child.tagName;
      if (tag === 'html') lang = attr(child, 'lang')?.trim() || lang;
      if (tag === 'label') {
        const target = attr(child, 'for');
        const text = cleanLabel(textContent(child));
        if (target && text) labelFor.set(target, text);
      }
      if (tag === 'title') {
        const titleNode = child.childNodes.find(isText);
        const titleLoc = titleNode?.sourceCodeLocation;
        const { text, sources } = collapsedValue(
          titleNode?.value ?? '',
          titleNode && titleLoc
            ? alignDecoded(html, titleLoc.startOffset, titleLoc.endOffset, titleNode.value, 'text')
            : undefined,
        );
        const loc = child.sourceCodeLocation;
        meta.append(
          text,
          {
            tag: 'title',
            path: 'title',
            inCode: false,
            quoted: false,
            hidden: false,
            container: 0,
            ...(loc?.startTag && loc.endTag
              ? { source: { start: loc.startTag.endOffset, end: loc.endTag.startOffset } }
              : {}),
          },
          { tag: 'title', container: 0, headingPath: [], structuralLabel: 'title' },
          sources,
        );
        continue;
      }
      if (tag === 'meta') {
        const content = attr(child, 'content');
        const name = attr(child, 'name') ?? attr(child, 'property') ?? attr(child, 'itemprop');
        if (content && content.trim() && name) {
          const range = attributeValueRange(child, 'content', html, content);
          meta.append(
            content,
            {
              tag: 'meta',
              path: `meta[${name}]`,
              attribute: 'content',
              inCode: false,
              quoted: false,
              hidden: false,
              container: 0,
              ...(range ? { source: range } : {}),
            },
            {
              tag: 'meta',
              container: 0,
              headingPath: [],
              ...(cleanLabel(name) ? { structuralLabel: name.trim() } : {}),
            },
            range ? alignDecoded(html, range.start, range.end, content, 'attribute') : undefined,
          );
        }
        continue;
      }
      if (tag === 'script') {
        const type = attr(child, 'type');
        const textNode = child.childNodes.find(isText);
        if (type && JSON_SCRIPT.test(type) && textNode?.value.trim()) {
          const loc = textNode.sourceCodeLocation;
          const base = loc ? alignDecoded(html, loc.startOffset, loc.endOffset, textNode.value, 'raw') : 0;
          if (!appendJsonDocument(json, textNode.value, base, jsonState)) warnings.push('json_parse_failed');
        }
        continue;
      }
      if (tag === 'template') {
        prepass((child as DefaultTreeAdapterMap['template']).content);
        continue;
      }
      prepass(child);
    }
  };
  prepass(doc);

  const segmentMeta = (tag: string, inh: Inherited): SegmentMeta => {
    const anchor = inh.dataAnchor ?? lastNamedAnchor;
    return {
      tag,
      path: inh.path,
      inCode: inh.inCode,
      quoted: inh.quoted,
      hidden: inh.hidden,
      container: inh.container,
      ...(anchor ? { anchor } : {}),
      ...(inh.href ? { href: inh.href } : {}),
    };
  };

  const blockContext = (tag: string, inh: Inherited): BlockContext => ({
    tag,
    container: inh.container,
    headingPath: headingPath(),
    ...(inh.structuralLabel ? { structuralLabel: inh.structuralLabel } : {}),
  });

  const cellLabel = (cell: Element): string | undefined => {
    const row = cell.parentNode;
    if (!row || !isElement(row) || row.tagName !== 'tr') return undefined;
    const cells = elementChildren(row).filter((c) => c.tagName === 'td' || c.tagName === 'th');
    const index = cells.indexOf(cell);
    if (index > 0) {
      const first = cells[0];
      const text = first ? cleanLabel(textContent(first)) : undefined;
      if (text) return text;
    }
    if (cell.tagName === 'td') {
      const header = tables.at(-1)?.headers[index];
      if (header) return header;
    }
    return undefined;
  };

  const tableHeaders = (table: Element): string[] => {
    const rows: Element[] = [];
    for (const child of elementChildren(table)) {
      if (child.tagName === 'tr') rows.push(child);
      else if (child.tagName === 'thead' || child.tagName === 'tbody' || child.tagName === 'tfoot') {
        rows.push(...elementChildren(child).filter((r) => r.tagName === 'tr'));
      }
    }
    for (const row of rows) {
      const cells = elementChildren(row).filter((c) => c.tagName === 'td' || c.tagName === 'th');
      if (cells.length > 0 && cells.every((c) => c.tagName === 'th')) {
        return cells.map((c) => cleanLabel(textContent(c)) ?? '');
      }
    }
    return [];
  };

  const emitAttributes = (el: Element, inh: Inherited): void => {
    for (const a of el.attrs) {
      const name = a.name;
      if (!ATTRIBUTE_NAMES.has(name) && !name.startsWith('data-')) continue;
      if (name === 'content' && el.tagName === 'meta') continue;
      const value = a.value.replace(/[\r\n]/g, ' ');
      if (value.trim().length === 0) continue;
      const range = attributeValueRange(el, name, html, a.value);
      const base = segmentMeta(el.tagName, inh);
      const href = el.tagName === 'a' ? attr(el, 'href') : inh.href;
      attributes.append(
        value,
        { ...base, attribute: name, ...(href ? { href } : {}), ...(range ? { source: range } : {}) },
        blockContext(el.tagName, inh),
        range ? alignDecoded(html, range.start, range.end, a.value, 'attribute') : undefined,
      );
    }
  };

  const walk = (node: ParentNode, inh: Inherited): void => {
    const counts = new Map<string, number>();
    for (const child of node.childNodes) {
      if (isElement(child)) counts.set(child.tagName, (counts.get(child.tagName) ?? 0) + 1);
    }
    const seen = new Map<string, number>();

    for (const child of node.childNodes) {
      if (isText(child)) {
        const loc = child.sourceCodeLocation;
        const metaInfo: SegmentMeta = {
          ...segmentMeta(isElement(node) ? node.tagName : '#text', inh),
          ...(loc ? { source: { start: loc.startOffset, end: loc.endOffset } } : {}),
        };
        const block = blockContext(isElement(node) ? node.tagName : '#text', inh);
        const sources = loc ? alignDecoded(html, loc.startOffset, loc.endOffset, child.value, 'text') : undefined;
        visible.appendText(child.value, inh.preserve, metaInfo, block, sources);
        if (inh.inCode) {
          if (child.value.trim().length > 0) joined.newline();
        } else {
          joined.appendText(child.value, inh.preserve, metaInfo, block, sources);
        }
        continue;
      }
      if (!isElement(child)) continue;
      const tag = child.tagName;
      if (SKIP_TAGS.has(tag)) continue;

      const index = (seen.get(tag) ?? 0) + 1;
      seen.set(tag, index);
      const classes = classList(child);
      const piece = `${tag}${classes[0] ? `.${classes[0]}` : ''}${(counts.get(tag) ?? 0) > 1 ? `:nth-of-type(${index})` : ''}`;

      if (tag === 'a') {
        const named = attr(child, 'name') ?? attr(child, 'id');
        if (named?.trim()) lastNamedAnchor = named.trim();
      }

      const codeClass = classes.some((c) => CODE_CLASS.test(c));
      const isDivCode = tag === 'div' && classes.includes('code');
      const own: Inherited = {
        path: inh.path ? `${inh.path}>${piece}` : piece,
        inCode: inh.inCode || CODE_TAGS.has(tag) || codeClass,
        preserve: inh.preserve || PRESERVE_TAGS.has(tag) || isDivCode,
        quoted: inh.quoted || QUOTE_TAGS.has(tag) || (tag === 'div' && classes.includes('quote')),
        hidden: inh.hidden || isHidden(child),
        container: inh.container,
        ...(inh.dataAnchor ? { dataAnchor: inh.dataAnchor } : {}),
        ...(inh.href ? { href: inh.href } : {}),
        ...(inh.structuralLabel ? { structuralLabel: inh.structuralLabel } : {}),
      };
      if (isContainer(child, classes)) {
        let id = containerIds.get(child);
        if (id === undefined) {
          id = nextContainer++;
          containerIds.set(child, id);
        }
        own.container = id;
      }
      const dataAnchor = attr(child, 'data-post') ?? attr(child, 'data-post-id') ?? attr(child, 'data-entry-id');
      const id = attr(child, 'id');
      if (dataAnchor?.trim()) own.dataAnchor = dataAnchor.trim();
      else if (id && ANCHOR_ID.test(id)) own.dataAnchor = id;
      if (tag === 'a') {
        const href = attr(child, 'href');
        if (href?.trim()) own.href = href.trim();
      }
      if (tag === 'td' || tag === 'th') {
        const label = cellLabel(child);
        if (label) own.structuralLabel = label;
        else delete own.structuralLabel;
      } else if (tag === 'dd') {
        let prev: Element | undefined;
        for (const sibling of elementChildren(node)) {
          if (sibling === child) break;
          if (sibling.tagName === 'dt') prev = sibling;
        }
        const label = prev ? cleanLabel(textContent(prev)) : undefined;
        if (label) own.structuralLabel = label;
      }
      if (id && labelFor.has(id)) own.structuralLabel = labelFor.get(id);

      emitAttributes(child, own);

      const block = BLOCK_TAGS.has(tag);
      if (block) {
        visible.newline();
        joined.newline();
      } else {
        visible.space();
      }
      if (tag === 'table') tables.push({ headers: tableHeaders(child) });
      if (own.inCode && !inh.inCode) joined.newline();

      walk(child, own);

      if (own.inCode && !inh.inCode) joined.newline();
      if (tag === 'table') tables.pop();
      const heading = HEADING.exec(tag);
      if (heading?.[1]) {
        const level = Number(heading[1]);
        headings.length = level - 1;
        headings[level - 1] = textContent(child).slice(0, 200) || undefined;
      }
      if (block) {
        visible.newline();
        joined.newline();
      } else {
        visible.space();
      }
    }
  };

  const html5 = doc.childNodes.find((n): n is Element => isElement(n) && n.tagName === 'html');
  const body = html5 ? elementChildren(html5).find((n) => n.tagName === 'body') : undefined;
  if (body) {
    const rootInh: Inherited = {
      path: 'body',
      inCode: false,
      preserve: false,
      quoted: false,
      hidden: isHidden(body),
      container: 0,
    };
    emitAttributes(body, rootInh);
    walk(body, rootInh);
  }

  const views: ViewText[] = [];
  const push = (view: TextView, builder: FlowBuilder | LineBuilder, extra: string[] = []): void => {
    const text = builder.text();
    if (text.length === 0) return;
    views.push({
      captureId,
      view,
      text,
      segments: builder.segments,
      blocks: builder.blocks,
      ...(lang ? { lang } : {}),
      warnings: [...extra, ...(builder.truncated ? ['view_truncated'] : [])],
      artifactIndex,
      sourceMap: builder.sourceMap(),
    });
  };
  push('visible_text', visible);
  push('inline_joined', joined);
  push('attribute', attributes);
  push('meta', meta);
  push('json_ld', json, warnings);
  return views;
}
