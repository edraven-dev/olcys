import type { SourceDescriptor } from '@olcys/core';
import { SourceDescriptorMismatchError, SourceForbiddenError } from './errors.ts';
import type { SourceRegister } from './register.ts';

/** Stable text of a value: object keys sorted, undefined dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Collectors take their descriptor from the register. Throws `SourceForbiddenError` for a RED source and
 * `SourceDescriptorMismatchError` when the source is unknown or any descriptor field differs from the register entry.
 */
export function assertCollectorAllowed(descriptor: SourceDescriptor, register: SourceRegister): void {
  if (descriptor.compliance === 'RED') throw new SourceForbiddenError(descriptor.id);
  const entry = register.entries.get(descriptor.id);
  if (!entry) throw new SourceDescriptorMismatchError(descriptor.id, ['*']);
  if (entry.compliance === 'RED') throw new SourceForbiddenError(descriptor.id);
  const fields = new Set([...Object.keys(descriptor), ...Object.keys(entry)]);
  const differing = [...fields]
    .filter(
      (f) =>
        canonical((descriptor as unknown as Record<string, unknown>)[f]) !==
        canonical((entry as unknown as Record<string, unknown>)[f]),
    )
    .toSorted();
  if (differing.length) throw new SourceDescriptorMismatchError(descriptor.id, differing);
}
