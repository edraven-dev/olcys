/**
 * Text builders shared by the view constructors: a flowing-text builder (visible_text, inline_joined) and a
 * one-value-per-line builder (attribute, meta, json_ld). Every character written carries its UTF-16 offset in the
 * decoded artifact (`-1` for separators the builder inserts), so two matches can be compared by real position.
 */
import type { ViewBlock, ViewSegment } from '../pipeline-types.ts';

/** Views longer than this are truncated (warning `view_truncated`). */
export const MAX_VIEW_CHARS = 5_000_000;

export type SegmentMeta = Omit<ViewSegment, 'start' | 'end' | 'blockIndex'>;

export interface BlockContext {
  tag: string;
  container: number;
  headingPath: string[];
  structuralLabel?: string;
}

/** Source offset of every character of a value (`undefined` → separators, no source). */
export type SourceOffsets = ArrayLike<number> | undefined;

abstract class BaseBuilder {
  protected readonly parts: string[] = [];
  private readonly offsets: number[] = [];
  length = 0;
  truncated = false;
  readonly segments: ViewSegment[] = [];
  readonly blocks: ViewBlock[] = [];

  /** Appends text with its source offsets; returns the appended range or undefined when the view is full. */
  protected write(text: string, sources: SourceOffsets): { start: number; end: number } | undefined {
    if (this.truncated || text.length === 0) return undefined;
    let chunk = text;
    if (this.length + chunk.length > MAX_VIEW_CHARS) {
      chunk = chunk.slice(0, MAX_VIEW_CHARS - this.length);
      this.truncated = true;
      if (chunk.length === 0) return undefined;
    }
    const start = this.length;
    this.parts.push(chunk);
    for (let i = 0; i < chunk.length; i += 1) this.offsets.push(sources ? (sources[i] ?? -1) : -1);
    this.length += chunk.length;
    return { start, end: this.length };
  }

  text(): string {
    return this.parts.join('');
  }

  /** Per-character source offsets of `text()`. */
  sourceMap(): Int32Array {
    return Int32Array.from(this.offsets);
  }
}

/** Collapses whitespace and trims a value, keeping the source offset of every remaining character. */
export function collapsedValue(raw: string, sources: SourceOffsets): { text: string; sources: number[] | undefined } {
  const { text, from } = collapse(raw, false);
  const first = text.startsWith(' ') ? 1 : 0;
  const last = text.endsWith(' ') && text.length > first ? text.length - 1 : text.length;
  return {
    text: text.slice(first, last),
    sources: sources ? from.slice(first, last).map((i) => sources[i] ?? -1) : undefined,
  };
}

/** Collapses ASCII whitespace runs to one space (or normalises line ends when `preserve`), keeping index links. */
function collapse(raw: string, preserve: boolean): { text: string; from: number[] } {
  let text = '';
  const from: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? '';
    if (preserve) {
      if (char === '\r') {
        text += '\n';
        from.push(i);
        if (raw[i + 1] === '\n') i += 1;
        continue;
      }
      text += char;
      from.push(i);
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\f' || char === '\r') {
      if (!text.endsWith(' ')) {
        text += ' ';
        from.push(i);
      }
      continue;
    }
    text += char;
    from.push(i);
  }
  return { text, from };
}

/** Flowing text with block boundaries (`\n`) and optional inline boundaries (one space). */
export class FlowBuilder extends BaseBuilder {
  private last = '';
  private pendingSpace = false;
  private pendingNewline = false;
  private blockOpen = false;

  /** Block boundary: the next text starts on a new line and in a new block. */
  newline(): void {
    if (this.length > 0) this.pendingNewline = true;
    this.blockOpen = false;
  }

  /** Inline boundary: one space unless whitespace is already there. */
  space(): void {
    if (this.length > 0 && this.last !== ' ' && this.last !== '\n') this.pendingSpace = true;
  }

  private flush(): void {
    if (this.pendingNewline) {
      if (this.last !== '\n') this.writeSeparator('\n');
    } else if (this.pendingSpace && this.last !== ' ' && this.last !== '\n') {
      this.writeSeparator(' ');
    }
    this.pendingNewline = false;
    this.pendingSpace = false;
  }

  private writeSeparator(sep: string): void {
    if (this.write(sep, undefined)) this.last = sep;
  }

  /** Appends text of one text node. Collapses ASCII whitespace unless `preserve`. */
  appendText(raw: string, preserve: boolean, meta: SegmentMeta, block: BlockContext, sources?: SourceOffsets): void {
    const collapsed = collapse(raw, preserve);
    let text = collapsed.text;
    let from = collapsed.from;
    if (text.length === 0) return;
    let trailingSpace = false;
    if (!preserve) {
      if (text === ' ') {
        this.space();
        return;
      }
      if (text.startsWith(' ')) {
        this.space();
        text = text.slice(1);
        from = from.slice(1);
      }
      if (text.endsWith(' ')) {
        trailingSpace = true;
        text = text.slice(0, -1);
        from = from.slice(0, -1);
      }
    }
    this.flush();
    if (!this.blockOpen) this.openBlock(block);
    const range = this.write(text, sources ? from.map((i) => sources[i] ?? -1) : undefined);
    if (!range) return;
    this.last = text.at(-1) ?? this.last;
    const current = this.blocks.at(-1);
    if (current) current.end = range.end;
    this.segments.push({ ...meta, start: range.start, end: range.end, blockIndex: this.blocks.length - 1 });
    if (trailingSpace) this.space();
  }

  private openBlock(block: BlockContext): void {
    this.blockOpen = true;
    this.blocks.push({
      index: this.blocks.length,
      start: this.length,
      end: this.length,
      tag: block.tag,
      container: block.container,
      headingPath: block.headingPath,
      ...(block.structuralLabel ? { structuralLabel: block.structuralLabel } : {}),
    });
  }
}

/** One segment (and one block) per value, values separated by `\n`. */
export class LineBuilder extends BaseBuilder {
  append(value: string, meta: SegmentMeta, block: BlockContext, sources?: SourceOffsets): void {
    if (value.length === 0) return;
    if (this.length > 0 && !this.write('\n', undefined)) return;
    const range = this.write(value, sources);
    if (!range) return;
    const index = this.blocks.length;
    this.blocks.push({
      index,
      start: range.start,
      end: range.end,
      tag: block.tag,
      container: block.container,
      headingPath: block.headingPath,
      ...(block.structuralLabel ? { structuralLabel: block.structuralLabel } : {}),
    });
    this.segments.push({ ...meta, start: range.start, end: range.end, blockIndex: index });
  }
}
