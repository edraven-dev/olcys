/**
 * Version of the scoring arithmetic: hop formula, discounting, family dedup (`e1`–`e4` prefixes share a family),
 * noisy-OR over the strongest path per service, gates and bands. Stored on every `LinkAssessment`.
 */
export const ALGORITHM_VERSION = 'two-hop-llr/1.0.0';

/** Version of the rules that turn collected evidence into features, relations and tiers. */
export const RELATION_RULES_VERSION = 'relations.v1';
