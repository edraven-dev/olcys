/** The schedule panel: Polish labels, times in UTC, tick outcomes and the form model. Synthetic data only. */
import type { CaseScheduleState } from '@olcys/core';
import { SCHEDULE_PROBLEMS, SCHEDULE_TICK_OUTCOMES } from '@olcys/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { scheduleRequest, validateScheduleForm } from '../src/features/cases/schedule-model.ts';
import { ScheduleView } from '../src/features/cases/SchedulePanel.tsx';
import { pl } from '../src/i18n/pl.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const CASE_ID = '01900000-0000-7000-8000-000000000001';
const RUN_ID = '01900000-0000-7000-8000-0000000000a1';

const state: CaseScheduleState = {
  schedule: { cron: '0 3 * * *', enabled: true },
  nextRuns: ['2026-11-22T03:00:00.000Z', '2026-11-23T03:00:00.000Z', '2026-11-24T03:00:00.000Z'],
  recentTicks: [
    {
      id: 't2',
      caseId: CASE_ID,
      jobId: `${CASE_ID}@2026-11-21T03:00:00.000Z`,
      scheduledFor: '2026-11-21T03:00:00.000Z',
      firedAt: '2026-11-21T03:00:20.000Z',
      outcome: 'skipped_overlap',
    },
    {
      id: 't1',
      caseId: CASE_ID,
      jobId: `${CASE_ID}@2026-11-20T03:00:00.000Z`,
      scheduledFor: '2026-11-20T03:00:00.000Z',
      firedAt: '2026-11-20T03:00:20.000Z',
      outcome: 'started',
      runId: RUN_ID,
    },
  ],
  recentChanges: [
    {
      id: 'c1',
      caseId: CASE_ID,
      after: { cron: '0 3 * * *', enabled: true },
      changedBy: 'analityk',
      reason: 'weryfikacja okresowa',
      at: '2026-11-19T10:00:00.000Z',
    },
  ],
  minIntervalMinutes: 60,
};

describe('schedule panel', () => {
  it('shows the schedule, the next runs in UTC, the last change and the ticks in Polish', () => {
    const html = renderToStaticMarkup(<ScheduleView state={state} caseId={CASE_ID} caseOpen />);
    const content = text(html);
    expect(content).toContain('0 3 * * *');
    expect(content).toContain('włączony');
    expect(content).toContain('Najbliższe analizy (UTC)');
    expect(content).toContain('2026-11-22 03:00:00 UTC');
    expect(content).toContain('2026-11-24 03:00:00 UTC');
    expect(content).toContain('Ostatnia zmiana:');
    expect(content).toContain('powód: weryfikacja okresowa');
    expect(content).toContain('pominięto — poprzednia analiza w toku');
    expect(content).toContain('uruchomiono analizę');
    expect(html).toContain(`/przebiegi/${RUN_ID}/`);
    expect(content).not.toContain('Sprawa jest zamknięta');
  });

  it('says when nothing runs: no schedule, a closed case, a schedule refused in this mode', () => {
    const none = text(
      renderToStaticMarkup(<ScheduleView state={{ nextRuns: [], recentTicks: [] }} caseId={CASE_ID} caseOpen />),
    );
    expect(none).toContain('Sprawa nie ma harmonogramu.');
    expect(none).toContain('Harmonogram nie był jeszcze wyzwalany.');
    const closed = text(
      renderToStaticMarkup(<ScheduleView state={{ ...state, nextRuns: [] }} caseId={CASE_ID} caseOpen={false} />),
    );
    expect(closed).toContain('Sprawa jest zamknięta');
    expect(closed).toContain('Brak zaplanowanych analiz.');
    const refused = text(
      renderToStaticMarkup(
        <ScheduleView state={{ ...state, nextRuns: [], problem: 'schedule_too_frequent' }} caseId={CASE_ID} caseOpen />,
      ),
    );
    expect(refused).toContain('zbyt częsty');
  });

  it('labels every tick outcome and schedule problem', () => {
    expect(Object.keys(pl.schedule.outcomes)).toEqual([...SCHEDULE_TICK_OUTCOMES]);
    expect(Object.keys(pl.schedule.problem)).toEqual([...SCHEDULE_PROBLEMS]);
    for (const code of [...SCHEDULE_PROBLEMS, 'case_closed', 'case_not_found']) {
      expect(pl.errors[code as keyof typeof pl.errors]).toBeTruthy();
    }
  });
});

describe('schedule form model', () => {
  it('requires an expression and a reason', () => {
    expect(validateScheduleForm({ cron: ' ', enabled: true, reason: 'ok' })).toEqual({
      cron: 'Podaj wyrażenie cron.',
      reason: 'Podaj powód zmiany (co najmniej 3 znaki).',
    });
    expect(validateScheduleForm({ cron: '0 3 * * *', enabled: false, reason: 'wstrzymanie' })).toEqual({});
  });

  it('sends only the expression, the flag and the reason — never who changed it', () => {
    expect(scheduleRequest({ cron: '  0  3 * * * ', enabled: true, reason: ' weryfikacja okresowa ' })).toEqual({
      cron: '0 3 * * *',
      enabled: true,
      reason: 'weryfikacja okresowa',
    });
  });
});
