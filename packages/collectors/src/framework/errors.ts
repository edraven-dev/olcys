import type { SourceId } from '@olcys/core';

export type RefusalReason = 'red' | 'amber_without_justification' | 'unknown_source' | 'not_in_scope';

/** A collector was asked to run for a source outside the run's locked scope (a planner bug); nothing was requested. */
export class SourceRefusedError extends Error {
  readonly sourceId: SourceId;
  readonly reason: RefusalReason;
  constructor(sourceId: SourceId, reason: RefusalReason) {
    super(`source ${sourceId} refused: ${reason}`);
    this.name = 'SourceRefusedError';
    this.sourceId = sourceId;
    this.reason = reason;
  }
}

/** `config/sources.yaml` (or an inline register) is invalid; `problems` lists every failing path. */
export class SourceConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid source register: ${problems.join('; ')}`);
    this.name = 'SourceConfigError';
    this.problems = problems;
  }
}

/** Offline mode: the fixture site has no path prefix for this host, so the request cannot be served. */
export class NoFixtureError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`no fixture mapping for host ${host}`);
    this.name = 'NoFixtureError';
    this.host = host;
  }
}

/** Live mode: the request would disclose a synthetic persona identifier to a real third party. */
export class SyntheticIdentifierError extends Error {
  readonly token: string;
  constructor(token: string) {
    super('request refused: it contains a synthetic test identifier and the run is live');
    this.name = 'SyntheticIdentifierError';
    this.token = token;
  }
}
