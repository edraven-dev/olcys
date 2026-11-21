/**
 * Text builders shared by the view constructors: a flowing-text builder (visible_text, inline_joined) and a
 * one-value-per-line builder (attribute, meta, json_ld).
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

abstract class BaseBuilder {
  protected readonly parts: string[] = [];
  length = 0;
  truncated = false;
  readonly segments: ViewSegment[] = [];
  readonly blocks: ViewBlock[] = [];

  /** Appends raw text (no separators); returns the appended range or undefined when the view is full. */
  protected write(text: string): { start: number; end: number } | undefined {
    if (this.truncated || text.length === 0) return undefined;
    let chunk = text;
    if (this.length + chunk.length > MAX_VIEW_CHARS) {
      chunk = chunk.slice(0, MAX_VIEW_CHARS - this.length);
      this.truncated = true;
      if (chunk.length === 0) return undefined;
    }
    const start = this.length;
    this.parts.push(chunk);
    this.length += chunk.length;
    return { start, end: this.length };
  }

  text(): string {
    return this.parts.join('');
  }
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
    if (this.write(sep)) this.last = sep;
  }

  /** Appends text of one text node. Collapses ASCII whitespace unless `preserve`. */
  appendText(raw: string, preserve: boolean, meta: SegmentMeta, block: BlockContext): void {
    let text = preserve ? raw.replace(/\r\n?/g, '\n') : raw.replace(/[\t\n\f\r ]+/g, ' ');
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
      }
      if (text.endsWith(' ')) {
        trailingSpace = true;
        text = text.slice(0, -1);
      }
    }
    this.flush();
    if (!this.blockOpen) this.openBlock(block);
    const range = this.write(text);
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
  append(value: string, meta: SegmentMeta, block: BlockContext): void {
    if (value.length === 0) return;
    if (this.length > 0 && !this.write('\n')) return;
    const range = this.write(value);
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
