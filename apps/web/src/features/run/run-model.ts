/** Pure view models for the run overview: step states, stage counters and per-source outcomes. */
import type { Capture, CaptureStatus, EgressLogEntry, RunStep, RunWithProgress } from '@olcys/core';
import { pl } from '../../i18n/pl.ts';

export type StepState = 'pending' | 'running' | 'done' | 'failed';

/** Pipeline order, from the catalogue (a test keeps it equal to `RUN_STEPS` in core). */
export const RUN_STEP_ORDER = Object.keys(pl.steps) as RunStep[];

export const isTerminal = (status: RunWithProgress['status']) => status !== 'queued' && status !== 'running';

export function currentStep(run: Pick<RunWithProgress, 'progress'>): string | undefined {
  const step = run.progress?.['step'];
  return typeof step === 'string' ? step : undefined;
}

export function stepStates(run: Pick<RunWithProgress, 'status' | 'progress'>): Record<RunStep, StepState> {
  const states = Object.fromEntries(RUN_STEP_ORDER.map((s) => [s, 'pending'])) as Record<RunStep, StepState>;
  if (run.status === 'succeeded' || run.status === 'partial') {
    for (const step of RUN_STEP_ORDER) states[step] = 'done';
    return states;
  }
  if (run.status === 'queued') return states;
  const index = RUN_STEP_ORDER.indexOf(currentStep(run) as RunStep);
  RUN_STEP_ORDER.forEach((step, i) => {
    if (index < 0) return;
    if (i < index) states[step] = 'done';
    else if (i === index) states[step] = run.status === 'running' ? 'running' : 'failed';
  });
  return states;
}

export function progressRatio(run: Pick<RunWithProgress, 'status' | 'progress'>): { done: number; total: number } {
  const done = Number(run.progress?.['done']);
  const total = Number(run.progress?.['total']);
  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) return { done: Math.min(done, total), total };
  return { done: isTerminal(run.status) ? 1 : 0, total: 1 };
}

const RESERVED = new Set(['step', 'done', 'total', 'partial']);

/** Numeric counters reported by the stages (`captures`, `candidates`, …). */
export function progressCounters(run: Pick<RunWithProgress, 'progress'>): [string, number][] {
  return Object.entries(run.progress ?? {}).filter(
    (entry): entry is [string, number] => !RESERVED.has(entry[0]) && typeof entry[1] === 'number',
  );
}

export function partialReasons(run: Pick<RunWithProgress, 'progress'>): string[] {
  const partial = run.progress?.['partial'];
  return Array.isArray(partial) ? partial.filter((p): p is string => typeof p === 'string') : [];
}

export const UNAVAILABLE_STATUSES: readonly CaptureStatus[] = ['blocked', 'login_wall', 'captcha'];

export interface SourceSummary {
  sourceId: string;
  captures: number;
  statuses: Partial<Record<CaptureStatus, number>>;
  requests: number;
  disclosed: number;
  denied: number;
  /** Blocked, login wall or CAPTCHA: no access is not "no data". */
  unavailable: boolean;
}

export function summariseSources(captures: readonly Capture[], egress: readonly EgressLogEntry[]): SourceSummary[] {
  const map = new Map<string, SourceSummary>();
  const entry = (sourceId: string) => {
    let summary = map.get(sourceId);
    if (!summary) {
      summary = { sourceId, captures: 0, statuses: {}, requests: 0, disclosed: 0, denied: 0, unavailable: false };
      map.set(sourceId, summary);
    }
    return summary;
  };
  for (const capture of captures) {
    const summary = entry(capture.sourceId);
    summary.captures += 1;
    summary.statuses[capture.status] = (summary.statuses[capture.status] ?? 0) + 1;
    if (UNAVAILABLE_STATUSES.includes(capture.status)) summary.unavailable = true;
  }
  for (const request of egress) {
    const summary = entry(request.sourceId);
    summary.requests += 1;
    if (request.containsIdentifier) summary.disclosed += 1;
    if (!request.allowed) summary.denied += 1;
  }
  return [...map.values()].toSorted((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export function egressSummary(egress: readonly EgressLogEntry[]): {
  hosts: number;
  total: number;
  disclosed: number;
  denied: number;
} {
  return {
    hosts: new Set(egress.map((e) => e.host)).size,
    total: egress.length,
    disclosed: egress.filter((e) => e.containsIdentifier).length,
    denied: egress.filter((e) => !e.allowed).length,
  };
}
