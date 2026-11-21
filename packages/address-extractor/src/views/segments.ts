/**
 * Lookups from positions in a view text to segments and container runs (contiguous segments of one container).
 */
import type { ViewBlock, ViewSegment, ViewText } from '../pipeline-types.ts';

interface RunIndex {
  /** For each segment: first and last segment index of its container run. */
  runStart: Int32Array;
  runEnd: Int32Array;
}

const runCache = new WeakMap<ViewText, RunIndex>();

function runs(view: ViewText): RunIndex {
  const cached = runCache.get(view);
  if (cached) return cached;
  const count = view.segments.length;
  const runStart = new Int32Array(count);
  const runEnd = new Int32Array(count);
  let first = 0;
  for (let i = 0; i < count; i += 1) {
    if (i > 0 && view.segments[i]?.container !== view.segments[i - 1]?.container) first = i;
    runStart[i] = first;
  }
  let last = count - 1;
  for (let i = count - 1; i >= 0; i -= 1) {
    if (i < count - 1 && view.segments[i]?.container !== view.segments[i + 1]?.container) last = i;
    runEnd[i] = last;
  }
  const index = { runStart, runEnd };
  runCache.set(view, index);
  return index;
}

/** Index of the last segment starting at or before `pos` (separators belong to the preceding segment); -1 if none. */
export function segmentIndexAt(view: ViewText, pos: number): number {
  let lo = 0;
  let hi = view.segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((view.segments[mid]?.start ?? 0) <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function segmentAt(view: ViewText, pos: number): ViewSegment | undefined {
  const index = segmentIndexAt(view, pos);
  return index >= 0 ? view.segments[index] : view.segments[0];
}

export function blockOf(view: ViewText, segment: ViewSegment | undefined): ViewBlock | undefined {
  return segment ? view.blocks[segment.blockIndex] : undefined;
}

/** Original-text range of the container run around `pos` (the whole text when there are no segments). */
export function containerRange(view: ViewText, pos: number): { start: number; end: number; container: number } {
  const index = Math.max(0, segmentIndexAt(view, pos));
  const segment = view.segments[index];
  if (!segment) return { start: 0, end: view.text.length, container: 0 };
  const { runStart, runEnd } = runs(view);
  const first = view.segments[runStart[index] ?? index] ?? segment;
  const last = view.segments[runEnd[index] ?? index] ?? segment;
  return { start: first.start, end: last.end, container: segment.container };
}

/** All segments intersecting `[start, end)`. */
export function segmentsIn(view: ViewText, start: number, end: number): ViewSegment[] {
  const out: ViewSegment[] = [];
  for (let i = Math.max(0, segmentIndexAt(view, start)); i < view.segments.length; i += 1) {
    const segment = view.segments[i];
    if (!segment || segment.start >= end) break;
    if (segment.end > start) out.push(segment);
  }
  return out;
}
