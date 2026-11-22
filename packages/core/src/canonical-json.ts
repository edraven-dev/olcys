/**
 * RFC 8785 JSON Canonicalization Scheme (JCS): object keys sorted by UTF-16 code units, no insignificant whitespace,
 * ECMAScript number and string serialisation. Used for every hash over structured data (manifests, reports, prompts).
 * Pure and browser-safe.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      const withToJson = value as { toJSON?: () => unknown };
      if (typeof withToJson.toJSON === 'function') return serialize(withToJson.toJSON(), path);
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => {
            if (item === undefined) throw new TypeError(`canonicalJson: undefined array item at ${path}[${i}]`);
            return serialize(item, `${path}[${i}]`);
          })
          .join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .toSorted()
        .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}
