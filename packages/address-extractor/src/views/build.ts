/**
 * Capture artifacts → text views. `html` artifacts give visible_text, inline_joined, attribute, meta and json_ld;
 * `json` artifacts give json_ld; `text` artifacts give visible_text with one segment per line. Never `qr` / `ocr`.
 */
import type { CaptureContent, ViewText } from '../pipeline-types.ts';
import { FlowBuilder, LineBuilder } from './builders.ts';
import { decodeArtifact } from './decode.ts';
import { buildHtmlViews } from './html.ts';
import { appendJsonDocument } from './json.ts';

function buildTextView(captureId: string, text: string, artifactIndex: number): ViewText | undefined {
  const builder = new FlowBuilder();
  let offset = 0;
  let line = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const full = match[0];
    if (full.length === 0) break;
    const content = full.replace(/[\r\n]+$/, '');
    if (content.length > 0) {
      builder.appendText(
        content,
        true,
        {
          tag: '#text',
          path: '#text',
          inCode: false,
          quoted: false,
          hidden: false,
          container: 0,
          source: { start: offset, end: offset + content.length },
        },
        { tag: '#text', container: 0, headingPath: [] },
        Int32Array.from({ length: content.length }, (_, i) => offset + i),
      );
    }
    builder.newline();
    offset += full.length;
    line += 1;
  }
  const out = builder.text();
  if (out.length === 0 || line === 0) return undefined;
  return {
    captureId,
    view: 'visible_text',
    text: out,
    segments: builder.segments,
    blocks: builder.blocks,
    warnings: builder.truncated ? ['view_truncated'] : [],
    artifactIndex,
    sourceMap: builder.sourceMap(),
  };
}

function buildJsonArtifactView(captureId: string, text: string, artifactIndex: number): ViewText | undefined {
  const builder = new LineBuilder();
  const ok = appendJsonDocument(builder, text, 0, { nextContainer: 1 });
  const out = builder.text();
  if (out.length === 0) return undefined;
  const warnings = [...(ok ? [] : ['json_parse_failed']), ...(builder.truncated ? ['view_truncated'] : [])];
  return {
    captureId,
    view: 'json_ld',
    text: out,
    segments: builder.segments,
    blocks: builder.blocks,
    warnings,
    artifactIndex,
    sourceMap: builder.sourceMap(),
  };
}

/** Builds every text view of a capture (pure; no I/O). */
export function buildViews(content: CaptureContent): ViewText[] {
  const views: ViewText[] = [];
  content.artifacts.forEach((artifact, index) => {
    if (artifact.kind !== 'html' && artifact.kind !== 'text' && artifact.kind !== 'json') return;
    const { text } = decodeArtifact(artifact.bytes, artifact.mediaType);
    if (artifact.kind === 'html') {
      views.push(...buildHtmlViews(content.captureId, text, index));
    } else if (artifact.kind === 'json') {
      const view = buildJsonArtifactView(content.captureId, text, index);
      if (view) views.push(view);
    } else {
      const view = buildTextView(content.captureId, text, index);
      if (view) views.push(view);
    }
  });
  return views;
}
