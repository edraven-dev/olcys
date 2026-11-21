import type { AccountDiscoveryMethod, Capture, CollectorInput, Id, IdentifierKind, Observation } from '@olcys/core';
import type { ResultBuilder } from '../framework/result.ts';
import { recogniseAccountUrl, type FixtureMapping } from '../framework/urls.ts';

export const HANDLE_KINDS: readonly IdentifierKind[] = ['nickname', 'social_login', 'messenger_id'];

/** Observation emitter for one subject; locator `<key>#<property>` (`[i]` for repeated properties). */
export function observer(
  rb: ResultBuilder,
  capture: Capture,
  type: Observation['subject']['type'],
  key: string,
): (property: string, value: string | undefined, index?: number) => void {
  return (property, value, index) => {
    if (!value) return;
    const locator = `${key}#${property}${index === undefined ? '' : `[${index}]`}`;
    rb.observe(capture, { type, key }, property, value, locator);
  };
}

export interface HandleTarget {
  handle: string;
  method: AccountDiscoveryMethod;
  foundIn?: Id;
}

/**
 * The account a handle-addressed collector should read: a recognised profile URL, a nick to probe, an account of
 * the platform or an identifier given for the platform (`normalise` returns undefined for invalid handles).
 */
export function handleTarget(
  input: CollectorInput,
  platform: string,
  normalise: (handle: string) => string | undefined,
  mapping?: FixtureMapping,
): HandleTarget | undefined {
  for (const value of input.values ?? []) {
    if (value.kind === 'url') {
      const account = recogniseAccountUrl(value.value, mapping);
      const handle = account?.platform === platform && account.handle ? normalise(account.handle) : undefined;
      if (handle)
        return {
          handle,
          method: value.method ?? 'cross_link',
          ...(value.captureId ? { foundIn: value.captureId } : {}),
        };
    } else if (value.kind === 'username') {
      const handle = normalise(value.value);
      if (handle) return { handle, method: value.method ?? 'enumeration' };
    }
  }
  for (const account of input.accounts) {
    const handle = account.platform === platform ? normalise(account.handle) : undefined;
    if (handle) return { handle, method: account.discoveredVia.method };
  }
  for (const identifier of input.identifiers) {
    if (identifier.platform !== platform || !HANDLE_KINDS.includes(identifier.kind)) continue;
    const linked = recogniseAccountUrl(identifier.value.trim(), mapping);
    const raw = linked?.platform === platform && linked.handle ? linked.handle : identifier.value;
    const handle = normalise(raw.trim().replace(/^@+/, ''));
    if (handle) return { handle, method: 'input' };
  }
  return undefined;
}
