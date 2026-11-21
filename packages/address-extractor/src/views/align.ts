/**
 * Source offsets of decoded HTML values: maps every UTF-16 unit of a value the parser produced (character references
 * decoded, CR LF → LF) back to its position in the raw document.
 */
import { decodeHTML, decodeHTMLAttribute } from 'entities/decode';

const REFERENCE = /&(?:#[xX][0-9a-fA-F]+;?|#\d+;?|[A-Za-z][A-Za-z0-9]*;?)/y;

/** `text`: text content (references decoded); `attribute`: attribute value rules; `raw`: script/style text. */
export type DecodeMode = 'text' | 'attribute' | 'raw';

/**
 * Offset in `source` of every unit of `value`, the parser's decoding of `source[start, end)`. Units produced by one
 * character reference all map to its `&`.
 */
export function alignDecoded(source: string, start: number, end: number, value: string, mode: DecodeMode): Int32Array {
  const map = new Int32Array(value.length);
  if (end - start === value.length && source.startsWith(value, start)) {
    for (let k = 0; k < value.length; k += 1) map[k] = start + k;
    return map;
  }
  let i = start;
  let j = 0;
  while (j < value.length) {
    if (i >= end) {
      map[j] = Math.max(start, end - 1);
      j += 1;
      continue;
    }
    const char = source[i];
    if (char === '&' && mode !== 'raw') {
      REFERENCE.lastIndex = i;
      const reference = REFERENCE.exec(source);
      if (reference && i + reference[0].length <= end) {
        const decoded = mode === 'attribute' ? decodeHTMLAttribute(reference[0]) : decodeHTML(reference[0]);
        if (decoded !== reference[0] && value.startsWith(decoded, j)) {
          for (let k = 0; k < decoded.length; k += 1) map[j + k] = i;
          i += reference[0].length;
          j += decoded.length;
          continue;
        }
      }
    }
    if (char === '\r' && value[j] === '\n') {
      map[j] = i;
      i += source[i + 1] === '\n' ? 2 : 1;
      j += 1;
      continue;
    }
    map[j] = i;
    i += 1;
    j += 1;
  }
  return map;
}
