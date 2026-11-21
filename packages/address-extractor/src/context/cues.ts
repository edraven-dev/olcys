/**
 * Role cues around an address: every lexicon hit in the window (same container, ±200 chars), negations removed,
 * ordered by distance to the address (closest first — the scorer's „closest term wins”). Structural cues (quoted
 * segment, `>` line, memo, listing density) count as distance 0. `['unclear']` when nothing matched.
 */
import { ROLE_CUES, type RoleCue } from '@olcys/core';
import { foldText } from '../text/fold.ts';
import { NEGATIONS, ROLE_LEXICON } from './lexicon.ts';

const TOKEN = /[\p{L}\p{N}_']+/gu;
const LISTING_CONTAINER = 10;
const LISTING_PAGE = 50;
const LISTING_PAGE_CONTAINER = 3;

function negated(folded: string, start: number): boolean {
  const before = [...folded.slice(Math.max(0, start - 80), start).matchAll(TOKEN)].map((m) => m[0]);
  return before.slice(-2).some((token) => NEGATIONS.has(token));
}

export interface RoleCueExtra {
  quoted: boolean;
  memo?: string;
  containerAddresses: number;
  pageAddresses: number;
  /** Length of the address in the window (distances after it are measured from its end). */
  candidateLength?: number;
}

export function detectRoleCues(windowText: string, candidateOffset: number, extra: RoleCueExtra): RoleCue[] {
  const folded = foldText(windowText);
  const candidateEnd = candidateOffset + (extra.candidateLength ?? 0);
  const best = new Map<RoleCue, number>();
  const note = (cue: RoleCue, distance: number): void => {
    const current = best.get(cue);
    if (current === undefined || distance < current) best.set(cue, distance);
  };

  for (const { cue, pattern } of ROLE_LEXICON) {
    for (const match of folded.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start < candidateEnd && end > candidateOffset) continue;
      if (cue === 'quote' && end > candidateOffset) continue;
      if (negated(folded, start)) continue;
      note(cue, end <= candidateOffset ? candidateOffset - end : start - candidateEnd);
    }
  }

  if (extra.quoted) note('quote', 0);
  const lineStart = folded.lastIndexOf('\n', candidateOffset - 1) + 1;
  if (/^\s*>/.test(folded.slice(lineStart, candidateOffset))) note('quote', 0);
  if (extra.memo) note('exchange_deposit', 0);
  if (
    extra.containerAddresses >= LISTING_CONTAINER ||
    (extra.pageAddresses > LISTING_PAGE && extra.containerAddresses >= LISTING_PAGE_CONTAINER)
  ) {
    note('listing', 0);
  }

  if (best.size === 0) return ['unclear'];
  return [...best]
    .toSorted((a, b) => a[1] - b[1] || ROLE_CUES.indexOf(a[0]) - ROLE_CUES.indexOf(b[0]))
    .map(([cue]) => cue);
}
