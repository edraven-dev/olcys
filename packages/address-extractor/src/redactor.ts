/**
 * The extractor's secret detection behind the core `SecretRedactor` port, for packages that must redact text before
 * storing it (collectors redact page bodies in memory). Findings carry kinds and spans, never secret values.
 */
import type { RedactionResult, SecretRedactor } from '@olcys/core';
import { normaliseView } from './normalise/normalise.ts';
import { redactText } from './patterns/redact.ts';
import { detectSecrets } from './patterns/secrets.ts';
import type { ViewText } from './pipeline-types.ts';

function plainTextView(text: string): ViewText {
  return {
    captureId: 'redactor',
    view: 'visible_text',
    text,
    segments: [
      {
        start: 0,
        end: text.length,
        tag: '#text',
        path: '#text',
        inCode: false,
        quoted: false,
        hidden: false,
        blockIndex: 0,
        container: 0,
      },
    ],
    blocks: [{ index: 0, start: 0, end: text.length, tag: '#text', container: 0, headingPath: [] }],
    warnings: [],
  };
}

export function createSecretRedactor(): SecretRedactor {
  return {
    redact(text: string): RedactionResult {
      if (!text) return { text, findings: [] };
      const view = plainTextView(text);
      const findings = detectSecrets(view, normaliseView(view));
      if (findings.length === 0) return { text, findings: [] };
      return {
        text: redactText(text, findings),
        findings: findings.map((f) => ({ kind: f.kind, start: f.span.start, end: f.span.end })),
      };
    },
  };
}
