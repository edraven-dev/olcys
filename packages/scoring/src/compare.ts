/** Locale-independent string order (UTF-16 code units), so sorted output is identical on every machine. */
export function compareText(a: string | undefined, b: string | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  if (x === y) return 0;
  return x < y ? -1 : 1;
}
