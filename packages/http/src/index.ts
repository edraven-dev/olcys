/**
 * @olcys/http — the only module allowed to open network connections (lint-enforced). Allow-listed, rate-limited,
 * logged requests with provenance envelopes; live / offline / replay modes.
 */
export {
  createEgressClient,
  DEFAULT_LOCAL_HOSTS,
  normaliseHost,
  redactUrl,
  requestHash,
  type EgressClientOptions,
  type EgressSinks,
} from './egress-client.ts';
export { EgressDeniedError, ReplayMissError } from './errors.ts';
export {
  isAllowedByRobots,
  normaliseRobotsPath,
  parseRobots,
  RobotsCache,
  type RobotsCacheOptions,
  type RobotsDecision,
} from './robots.ts';
