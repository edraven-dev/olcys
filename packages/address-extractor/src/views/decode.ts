/**
 * Artifact decoding: BOM → `charset=` of the media type → `<meta charset>` / `http-equiv` prescan → UTF-8.
 */

const PRESCAN_BYTES = 1024;

function bomEncoding(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  return undefined;
}

function mediaTypeCharset(mediaType: string): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(mediaType);
  return match?.[1];
}

function isHtml(mediaType: string): boolean {
  return /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(mediaType);
}

/** `<meta charset=…>` or `<meta http-equiv="content-type" content="…; charset=…">` in the first 1024 bytes. */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, PRESCAN_BYTES));
  const direct = /<meta\s[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
  if (direct?.[1]) return direct[1];
  return undefined;
}

function supported(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label.trim().toLowerCase()).encoding;
  } catch {
    return undefined;
  }
}

/** Decodes artifact bytes to a string; unknown labels fall back to UTF-8 (`fatal: false`, never throws). */
export function decodeArtifact(bytes: Uint8Array, mediaType: string): { text: string; encoding: string } {
  const encoding =
    supported(bomEncoding(bytes)) ??
    supported(mediaTypeCharset(mediaType)) ??
    (isHtml(mediaType) ? supported(metaCharset(bytes)) : undefined) ??
    'utf-8';
  const text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
  return { text, encoding };
}
