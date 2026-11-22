import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkImportPolicy, importContext, loadDatasetRegistry, type DatasetRegistryEntry } from '../src/index.ts';

export const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/datasets/${name}`, import.meta.url)), 'utf8');

export const registry: DatasetRegistryEntry[] = loadDatasetRegistry(
  readFileSync(fileURLToPath(new URL('../../../config/labels/datasets.v1.yaml', import.meta.url)), 'utf8'),
);

export function ctxFor(datasetId: string, version: string, justification?: string) {
  const policy = checkImportPolicy(registry, datasetId, justification ? { justification } : {});
  if (!policy.ok) throw new Error(policy.message);
  return importContext(policy.entry, { version, retrievedAt: '2026-11-22T08:00:00.000Z' });
}
