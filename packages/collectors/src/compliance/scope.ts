/** Case-scope validation and the egress allow-list derived from the sources a case enables. */
import { domainToASCII } from 'node:url';
import type { CaseScope, FetchMode, SourceId } from '@olcys/core';
import { ChainIdSchema } from '@olcys/core';
import { FIXTURE_SOURCE_ID, MIN_AMBER_JUSTIFICATION } from '../framework/source-registry.ts';
import { redBlockedHosts, type SourceRegister } from './register.ts';

export const MIN_PIVOT_DEPTH = 0;
export const MAX_PIVOT_DEPTH = 3;

export type ScopeViolation =
  | {
      code: 'unknown_source' | 'source_forbidden' | 'amber_justification_required' | 'orphan_justification';
      sourceId: SourceId;
    }
  | { code: 'justification_too_short'; sourceId: SourceId; minLength: 20 }
  | { code: 'pivot_depth_out_of_range'; min: 0; max: 3 }
  | { code: 'unknown_chain'; chain: string };

/**
 * Violations of a case scope, in a stable order (sources, justifications, pivot depth, chains); empty when valid.
 * A justification is the trimmed text, at least 20 characters. A justification for a source that is not enabled, or
 * is not AMBER, is orphaned (keeps the stored record honest).
 */
export function validateCaseScope(scope: CaseScope, register: SourceRegister): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  const enabled = new Set(scope.enabledSources);
  for (const id of enabled) {
    const entry = register.entries.get(id);
    if (!entry) violations.push({ code: 'unknown_source', sourceId: id });
    else if (entry.compliance === 'RED') violations.push({ code: 'source_forbidden', sourceId: id });
    else if (entry.compliance === 'AMBER') {
      const text = (scope.amberJustifications[id] ?? '').trim();
      if (text.length === 0) violations.push({ code: 'amber_justification_required', sourceId: id });
      else if (text.length < MIN_AMBER_JUSTIFICATION) {
        violations.push({ code: 'justification_too_short', sourceId: id, minLength: 20 });
      }
    }
  }
  for (const id of Object.keys(scope.amberJustifications)) {
    const entry = register.entries.get(id);
    const justified = enabled.has(id) && entry?.compliance === 'AMBER';
    // Enabled RED and unknown sources are already reported above.
    if (!justified && !(enabled.has(id) && (!entry || entry.compliance === 'RED'))) {
      violations.push({ code: 'orphan_justification', sourceId: id });
    }
  }
  const depth = scope.maxPivotDepth;
  if (!Number.isInteger(depth) || depth < MIN_PIVOT_DEPTH || depth > MAX_PIVOT_DEPTH) {
    violations.push({ code: 'pivot_depth_out_of_range', min: 0, max: 3 });
  }
  for (const chain of new Set(scope.chains)) {
    if (!ChainIdSchema.safeParse(chain).success) violations.push({ code: 'unknown_chain', chain });
  }
  return violations;
}

function normaliseHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = lower.startsWith('*.');
  const base = domainToASCII(wildcard ? lower.slice(2) : lower) || (wildcard ? lower.slice(2) : lower);
  return wildcard ? `*.${base}` : base;
}

/** True when `host` (or the domain of a `*.` pattern) is `blocked` or one of its subdomains. */
function isUnder(host: string, blocked: string): boolean {
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  return bare === blocked || bare.endsWith(`.${blocked}`);
}

/**
 * Hosts the egress client may contact for a case: lower-case, punycode, no trailing dot, sorted, unique.
 * `offline` → the fixture site's hosts only. `live` and `replay` → the union of `allowedHosts` over the enabled
 * non-RED sources (AMBER only with a justification) plus `extraHosts`, minus every RED `blockedHosts` entry and its
 * subdomains (RED wins). Replay still uses the list, so a cassette cannot introduce an unlisted host.
 */
export function allowListFor(
  register: SourceRegister,
  scope: Pick<CaseScope, 'enabledSources' | 'amberJustifications'>,
  mode: FetchMode,
  extraHosts: readonly string[] = [],
): string[] {
  const hosts: string[] = [];
  if (mode === 'offline') {
    hosts.push(...(register.entries.get(FIXTURE_SOURCE_ID)?.allowedHosts ?? []));
  } else {
    for (const id of new Set(scope.enabledSources)) {
      const entry = register.entries.get(id);
      if (!entry || entry.compliance === 'RED') continue;
      if (
        entry.compliance === 'AMBER' &&
        (scope.amberJustifications[id] ?? '').trim().length < MIN_AMBER_JUSTIFICATION
      ) {
        continue;
      }
      hosts.push(...entry.allowedHosts);
    }
    hosts.push(...extraHosts);
  }
  const blocked = redBlockedHosts(register.entries.values()).map((h) => normaliseHost(h).replace(/^\*\./, ''));
  return [...new Set(hosts.map(normaliseHost).filter((h) => h && !blocked.some((b) => isUnder(h, b))))].toSorted();
}
