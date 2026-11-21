/**
 * Shared vocabulary: observation property prefixes, pipeline steps and scoring constants.
 */

/** Allowed observation property prefixes. Anything OŁCyŚ computes itself is `computed.*` (facts vs computations). */
export const OBSERVATION_PREFIXES = [
  'profile.',
  'post.',
  'account.',
  'claim.',
  'verification.',
  'archive.',
  'computed.',
  'enumeration.',
  'search.',
  'registry.',
  'page.',
] as const;

const ADDRESS_VALUED = /(?:^|[._])(?:[a-z0-9]+_)?address(?:es|_mention)?$/;

/**
 * True when an observation property holds a crypto address (e.g. `profile.bitcoin_address`,
 * `post.signed_message.address`, `claim.drips.ethereum_address`, `page.address`). Locator indexes such as `[2]` are
 * ignored so repeated values form one set. Computed and registry properties never count (a registry "address" is a
 * postal location).
 */
export function isAddressValuedProperty(property: string): boolean {
  const base = property.replace(/\[\d+\]/g, '');
  if (base.startsWith('computed.') || base.startsWith('registry.')) return false;
  return ADDRESS_VALUED.test(base);
}

/** Ordered pipeline steps of an analysis run (used for progress in the UI). */
export const RUN_STEPS = [
  'run.start',
  'pivot.plan',
  'collect.source',
  'extract.capture',
  'pivot.expand',
  'chain.fetch',
  'labels.classify',
  'analytics.compute',
  'score.links',
  'diff.previous',
  'report.render',
  'run.finish',
] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/** ICD 203 term used for links that carry no ownership claim (e.g. third-party attributions). */
export const NOT_ASSESSED = 'not assessed';

/**
 * Gates applied outside the score arithmetic. Hard gates (`relation`, `exclusion`) fail with `passed: false`; the
 * others are informational (`checksum` scheme and strength, ungraded items, review flag, unconfirmed LLM suggestions
 * excluded, anchor assumption P = 0.99).
 */
export const LINK_GATE_IDS = [
  'invalid_checksum',
  'relation',
  'exclusion',
  'analyst_grading',
  'review_required',
  'checksum',
  'llm_zero_weight',
  'identity_anchor',
] as const;
export type LinkGateId = (typeof LINK_GATE_IDS)[number];
