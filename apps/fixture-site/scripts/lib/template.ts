/** Minimal template rendering: `{{NAME}}` is escaped for the target file type, `{{{NAME}}}` is inserted raw. */

export type Escape = 'html' | 'json' | 'none';

export function escapeKindFor(path: string): Escape {
  if (path.endsWith('.html') || path.endsWith('.svg')) return 'html';
  if (path.endsWith('.json')) return 'json';
  return 'none';
}

function escape(kind: Escape, value: string): string {
  if (kind === 'json') return JSON.stringify(value).slice(1, -1);
  if (kind === 'html') {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
  return value;
}

export function renderTemplate(text: string, tokens: Readonly<Record<string, string>>, name: string): string {
  const kind = escapeKindFor(name);
  return text.replace(/\{\{\{([A-Z0-9_]+)\}\}\}|\{\{([A-Z0-9_]+)\}\}/g, (_match, raw?: string, escaped?: string) => {
    const key = raw ?? escaped ?? '';
    const value = tokens[key];
    if (value === undefined) throw new Error(`unknown template token ${key} in ${name}`);
    return raw === undefined ? escape(kind, value) : value;
  });
}
