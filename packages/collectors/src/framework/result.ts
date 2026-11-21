import type {
  Capture,
  CaptureStatus,
  CollectorResult,
  Observation,
  OnlineAccount,
  RunContext,
  SourceId,
} from '@olcys/core';
import { newId } from '@olcys/core';
import { note, rollupStatus, type NoteCode } from './status.ts';

/** What a page fetch contributes to a collector result. */
export interface PageOutcome {
  status: CaptureStatus;
  capture?: Capture;
  notes: string[];
}

/** Accumulates one collector run's captures, accounts, observations and notes; `build()` rolls up the status. */
export class ResultBuilder {
  readonly #ctx: RunContext;
  readonly #sourceId: SourceId;
  readonly #captures: Capture[] = [];
  readonly #accounts: OnlineAccount[] = [];
  readonly #observations: Observation[] = [];
  readonly #notes: string[] = [];
  readonly #statuses: CaptureStatus[] = [];
  #affirmativeNotFound = false;

  constructor(ctx: RunContext, sourceId: SourceId) {
    this.#ctx = ctx;
    this.#sourceId = sourceId;
  }

  addPage(page: PageOutcome): void {
    if (page.capture) this.#captures.push(page.capture);
    this.#statuses.push(page.status);
    this.#notes.push(...page.notes);
  }

  /** Records a status without a capture (e.g. markup that could not be read). */
  addStatus(status: CaptureStatus): void {
    this.#statuses.push(status);
  }

  account(fields: Omit<OnlineAccount, 'id' | 'runId'>): OnlineAccount {
    const account: OnlineAccount = { id: newId(), runId: this.#ctx.runId, ...fields };
    this.#accounts.push(account);
    return account;
  }

  /** Adds a fact read from `capture`; empty values are skipped. Values are always strings. */
  observe(capture: Capture, subject: Observation['subject'], property: string, value: string, locator: string): void {
    if (value === '') return;
    this.#observations.push({
      id: newId(),
      runId: this.#ctx.runId,
      captureId: capture.id,
      sourceId: this.#sourceId,
      subject,
      property,
      value,
      locator,
      observedAt: capture.collectedAt,
    });
  }

  note(code: NoteCode, detail: string): void {
    this.#notes.push(note(code, detail));
  }

  /** The source answered that the subject does not exist (or does not appear) there. */
  affirmNotFound(detail: string): void {
    this.#affirmativeNotFound = true;
    this.note('not_found', detail);
  }

  build(): CollectorResult {
    return {
      status: rollupStatus(this.#statuses, this.#affirmativeNotFound),
      captures: [...this.#captures],
      accounts: [...this.#accounts],
      observations: [...this.#observations],
      notes: [...this.#notes],
    };
  }
}
