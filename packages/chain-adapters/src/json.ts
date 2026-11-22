/**
 * JSON parsing that never loses precision: numbers that are not safe integers (wei balances, sun amounts, NBP rates
 * such as `3.6500`) keep their exact source text as a string (JSON.parse source-text access, Node ≥ 21).
 */
type ExactReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const keepExactNumbers: ExactReviver = function (_key, value, context) {
  if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source !== undefined) return context.source;
  return value;
};

export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, keepExactNumbers as (this: unknown, key: string, value: unknown) => unknown);
}

/** A JSON integer field that may arrive as a number or as an exact string. */
export function integerText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
