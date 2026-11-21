/**
 * JSON → json_ld view: one segment per string value (keys appear only in `jsonPointer`), one container per object
 * or array so sibling values share a window.
 */
import type { LineBuilder } from './builders.ts';

function escapePointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

export interface JsonViewState {
  nextContainer: number;
}

/**
 * Appends the string values of `jsonText` to `builder`. `sourceOffset` is the position of `jsonText` in the decoded
 * artifact. Returns false when the text is not valid JSON (it is then appended as one raw segment).
 */
export function appendJsonDocument(
  builder: LineBuilder,
  jsonText: string,
  sourceOffset: number,
  state: JsonViewState,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const container = state.nextContainer++;
    builder.append(
      jsonText,
      {
        tag: '#json',
        path: '#json',
        inCode: false,
        quoted: false,
        hidden: false,
        container,
        source: { start: sourceOffset, end: sourceOffset + jsonText.length },
      },
      { tag: '#json', container, headingPath: [] },
    );
    return false;
  }

  let cursor = 0;
  const locate = (value: string): { start: number; end: number } => {
    const quoted = JSON.stringify(value);
    let at = jsonText.indexOf(quoted, cursor);
    if (at < 0) at = jsonText.indexOf(quoted);
    if (at < 0) return { start: sourceOffset, end: sourceOffset + jsonText.length };
    cursor = at + quoted.length;
    return { start: sourceOffset + at + 1, end: sourceOffset + at + quoted.length - 1 };
  };

  const walk = (value: unknown, pointer: string, container: number): void => {
    if (typeof value === 'string') {
      if (value.trim().length === 0) return;
      builder.append(
        value,
        {
          tag: '#json',
          path: '#json',
          jsonPointer: pointer,
          inCode: false,
          quoted: false,
          hidden: false,
          container,
          source: locate(value),
        },
        { tag: '#json', container, headingPath: [] },
      );
      return;
    }
    if (Array.isArray(value)) {
      const own = state.nextContainer++;
      value.forEach((item, index) => walk(item, `${pointer}/${index}`, own));
      return;
    }
    if (value !== null && typeof value === 'object') {
      const own = state.nextContainer++;
      for (const [key, item] of Object.entries(value)) walk(item, `${pointer}/${escapePointerToken(key)}`, own);
    }
  };

  walk(parsed, '', state.nextContainer++);
  return true;
}
