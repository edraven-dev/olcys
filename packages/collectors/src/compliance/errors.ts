import type { SourceId } from '@olcys/core';

/** A collector was built for a RED source; RED sources are never contacted. */
export class SourceForbiddenError extends Error {
  readonly sourceId: SourceId;
  constructor(sourceId: SourceId) {
    super(`source ${sourceId} is RED and must never be contacted`);
    this.name = 'SourceForbiddenError';
    this.sourceId = sourceId;
  }
}

/** A collector's descriptor differs from the register entry (or the source is not in the register at all). */
export class SourceDescriptorMismatchError extends Error {
  readonly sourceId: SourceId;
  /** Names of the descriptor fields that differ (`*` when the source is missing from the register). */
  readonly fields: readonly string[];
  constructor(sourceId: SourceId, fields: readonly string[]) {
    super(`descriptor of source ${sourceId} differs from the register: ${fields.join(', ')}`);
    this.name = 'SourceDescriptorMismatchError';
    this.sourceId = sourceId;
    this.fields = fields;
  }
}
