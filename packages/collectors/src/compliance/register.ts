/**
 * The source register as a read-only value: the parsed `config/sources.yaml` keyed by source id, with its version and
 * SHA-256. It is the single source of truth for scope validation, the egress allow-list, the collector guard and the
 * generated compliance document.
 */
import type { SourceDescriptor, SourceId } from '@olcys/core';
import { sha256Hex } from '../framework/capture.ts';
import { SourceConfigError } from '../framework/errors.ts';
import { DEFAULT_SOURCES_PATH, loadSourceRegistry, type SourceRegistry } from '../framework/source-registry.ts';

export interface SourceRegister {
  version: string;
  sha256: string;
  entries: ReadonlyMap<SourceId, SourceDescriptor>;
}

/** Register over descriptors (the API and tests hold descriptors, not the file); ids must be unique. */
export function createSourceRegister(
  descriptors: readonly SourceDescriptor[],
  meta: { version?: string; sha256?: string } = {},
): SourceRegister {
  const entries = new Map<SourceId, SourceDescriptor>();
  for (const d of descriptors) {
    if (entries.has(d.id)) throw new SourceConfigError([`sources.${d.id}: duplicate id`]);
    entries.set(d.id, d);
  }
  return {
    version: meta.version ?? 'sources.v1',
    sha256: meta.sha256 ?? sha256Hex(JSON.stringify([...entries.values()])),
    entries,
  };
}

export function registerOf(registry: SourceRegistry): SourceRegister {
  return createSourceRegister(registry.list(), {
    version: registry.version,
    ...(registry.configSha256 ? { sha256: registry.configSha256 } : {}),
  });
}

/** Loads and validates `config/sources.yaml` (or another register file). */
export async function loadSourceRegister(path: string = DEFAULT_SOURCES_PATH): Promise<SourceRegister> {
  return registerOf(await loadSourceRegistry(path));
}

/** Hosts of every RED source, lower-case and sorted: never contacted, whatever else allows them. */
export function redBlockedHosts(entries: Iterable<SourceDescriptor>): string[] {
  const hosts = new Set<string>();
  for (const d of entries) {
    if (d.compliance !== 'RED') continue;
    for (const host of d.blockedHosts ?? []) hosts.add(host.trim().toLowerCase().replace(/\.$/, ''));
  }
  return [...hosts].toSorted();
}
