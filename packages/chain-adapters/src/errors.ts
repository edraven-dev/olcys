import type { Id } from '@olcys/core';

/** Expected failures of a chain provider call; callers branch on `kind`, never on the message. */
export const CHAIN_ERROR_KINDS = [
  'unsupported_chain',
  'unsupported_operation',
  'invalid_request',
  'not_found',
  'auth_error',
  'plan_restricted',
  'rate_limited',
  'blocked',
  'egress_denied',
  'replay_miss',
  'upstream_error',
  'invalid_response',
  'window_exceeded',
  'budget_exceeded',
  /** A challenge or CAPTCHA page (e.g. `cf-mitigated: challenge`): never solved, the provider is stopped. */
  'captcha',
  /** The provider is reachable but unusable (e.g. Otterscan API level too low): stopped for the run, not retried. */
  'provider_unavailable',
] as const;
export type ChainErrorKind = (typeof CHAIN_ERROR_KINDS)[number];

export class ChainProviderError extends Error {
  readonly kind: ChainErrorKind;
  readonly providerId: string;
  readonly fetchId?: Id;

  constructor(kind: ChainErrorKind, providerId: string, message: string, options?: { fetchId?: Id; cause?: unknown }) {
    super(`${providerId}: ${kind}: ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChainProviderError';
    this.kind = kind;
    this.providerId = providerId;
    if (options?.fetchId !== undefined) this.fetchId = options.fetchId;
  }
}

export function isChainProviderError(error: unknown): error is ChainProviderError {
  return error instanceof ChainProviderError;
}
