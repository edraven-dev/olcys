/**
 * JSON → json_ld view: one segment per string value (keys appear only in `jsonPointer`), one container per object
 * or array so sibling values share a window. A small parser keeps the raw offset of every decoded character, so an
 * escaped string (`"0x…"`) still maps to its own position in the source.
 */
import type { LineBuilder } from './builders.ts';

type JsonNode =
  | { kind: 'string'; value: string; offsets: Int32Array }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'object'; entries: [string, JsonNode][] }
  | { kind: 'scalar' };

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};
const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Strict JSON (RFC 8259) parser; string values carry the offset of each decoded UTF-16 unit. Throws SyntaxError. */
function parseJson(text: string): JsonNode {
  let pos = 0;
  const fail = (what: string): never => {
    throw new SyntaxError(`invalid JSON: ${what} at ${pos}`);
  };
  const skipWhitespace = (): void => {
    while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) {
      pos += 1;
    }
  };

  const parseString = (): { value: string; offsets: Int32Array } => {
    pos += 1; // opening quote
    const parts: string[] = [];
    const offsets: number[] = [];
    let runStart = pos;
    const flushRun = (): void => {
      if (pos > runStart) {
        parts.push(text.slice(runStart, pos));
        for (let i = runStart; i < pos; i += 1) offsets.push(i);
      }
    };
    while (pos < text.length) {
      const char = text[pos] ?? '';
      if (char === '"') {
        flushRun();
        pos += 1;
        return { value: parts.join(''), offsets: Int32Array.from(offsets) };
      }
      if (char === '\\') {
        flushRun();
        const escape = text[pos + 1] ?? '';
        const simple = SIMPLE_ESCAPES[escape];
        if (simple !== undefined) {
          parts.push(simple);
          offsets.push(pos);
          pos += 2;
        } else if (escape === 'u' && HEX4.test(text.slice(pos + 2, pos + 6))) {
          parts.push(String.fromCharCode(Number.parseInt(text.slice(pos + 2, pos + 6), 16)));
          offsets.push(pos);
          pos += 6;
        } else {
          fail('bad escape');
        }
        runStart = pos;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) fail('control character in string');
      pos += 1;
    }
    return fail('unterminated string');
  };

  const parseValue = (): JsonNode => {
    skipWhitespace();
    const char = text[pos];
    if (char === '"') return { kind: 'string', ...parseString() };
    if (char === '{') {
      pos += 1;
      const entries: [string, JsonNode][] = [];
      skipWhitespace();
      if (text[pos] === '}') {
        pos += 1;
        return { kind: 'object', entries };
      }
      for (;;) {
        skipWhitespace();
        if (text[pos] !== '"') fail('expected a key');
        const key = parseString().value;
        skipWhitespace();
        if (text[pos] !== ':') fail('expected a colon');
        pos += 1;
        entries.push([key, parseValue()]);
        skipWhitespace();
        if (text[pos] === ',') {
          pos += 1;
          continue;
        }
        if (text[pos] === '}') {
          pos += 1;
          return { kind: 'object', entries };
        }
        fail('expected , or }');
      }
    }
    if (char === '[') {
      pos += 1;
      const items: JsonNode[] = [];
      skipWhitespace();
      if (text[pos] === ']') {
        pos += 1;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(parseValue());
        skipWhitespace();
        if (text[pos] === ',') {
          pos += 1;
          continue;
        }
        if (text[pos] === ']') {
          pos += 1;
          return { kind: 'array', items };
        }
        fail('expected , or ]');
      }
    }
    SCALAR.lastIndex = pos;
    const scalar = SCALAR.exec(text);
    if (!scalar) return fail('unexpected token');
    pos += scalar[0].length;
    return { kind: 'scalar' };
  };

  const root = parseValue();
  skipWhitespace();
  if (pos !== text.length) fail('trailing content');
  return root;
}

function escapePointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

export interface JsonViewState {
  nextContainer: number;
}

/**
 * Appends the string values of `jsonText` to `builder`. `base` is the position of `jsonText` in the decoded artifact,
 * or the artifact offset of each of its characters. Returns false when the text is not valid JSON (it is then appended as one raw segment).
 */
export function appendJsonDocument(
  builder: LineBuilder,
  jsonText: string,
  base: number | Int32Array,
  state: JsonViewState,
): boolean {
  const at = (i: number): number => (typeof base === 'number' ? base + i : (base[i] ?? -1));
  const sourceOffset = at(0);
  let root: JsonNode;
  try {
    root = parseJson(jsonText);
  } catch {
    const container = state.nextContainer++;
    const offsets = Int32Array.from({ length: jsonText.length }, (_, i) => at(i));
    builder.append(
      jsonText,
      {
        tag: '#json',
        path: '#json',
        inCode: false,
        quoted: false,
        hidden: false,
        container,
        source: { start: sourceOffset, end: at(jsonText.length - 1) + 1 },
      },
      { tag: '#json', container, headingPath: [] },
      offsets,
    );
    return false;
  }

  const walk = (node: JsonNode, pointer: string, container: number): void => {
    if (node.kind === 'string') {
      if (node.value.trim().length === 0) return;
      const absolute = node.offsets.map((o) => at(o));
      builder.append(
        node.value,
        {
          tag: '#json',
          path: '#json',
          jsonPointer: pointer,
          inCode: false,
          quoted: false,
          hidden: false,
          container,
          source: { start: absolute[0] ?? sourceOffset, end: (absolute.at(-1) ?? sourceOffset) + 1 },
        },
        { tag: '#json', container, headingPath: [] },
        absolute,
      );
      return;
    }
    if (node.kind === 'array') {
      const own = state.nextContainer++;
      node.items.forEach((item, index) => walk(item, `${pointer}/${index}`, own));
      return;
    }
    if (node.kind === 'object') {
      const own = state.nextContainer++;
      for (const [key, item] of node.entries) walk(item, `${pointer}/${escapePointerToken(key)}`, own);
    }
  };

  walk(root, '', state.nextContainer++);
  return true;
}
