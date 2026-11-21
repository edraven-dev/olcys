/**
 * Loads the versioned configuration (source register, scoring weights, rules) and the run config snapshot that is
 * stored with every run, so a run can be reproduced and diffed against later ones.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RunConfigSnapshot, SourceDescriptor } from '@olcys/core';
import { parse, SourcesConfigSchema } from '@olcys/core';
import { parse as parseYaml } from 'yaml';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const TOOL_VERSION = '0.1.0';

export interface LoadedConfig {
  /** Sources and providers from `config/sources.yaml`, as descriptors. */
  sources: SourceDescriptor[];
  snapshot: RunConfigSnapshot;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function loadConfig(root: string = REPO_ROOT): Promise<LoadedConfig> {
  const sourcesText = await readFile(join(root, 'config', 'sources.yaml'), 'utf8');
  const weightsText = await readFile(join(root, 'config', 'scoring', 'weights.v1.yaml'), 'utf8');
  const config = parse(SourcesConfigSchema, parseYaml(sourcesText));
  const sources = [...Object.entries(config.sources), ...Object.entries(config.providers)].map(
    ([id, entry]) => Object.assign({ id }, entry) as SourceDescriptor,
  );
  return {
    sources,
    snapshot: {
      toolVersion: TOOL_VERSION,
      sourcesConfigSha256: sha256(sourcesText),
      weightsVersion: 'weights.v1',
      weightsSha256: sha256(weightsText),
      rulesVersions: { exclusion: 'exclusion.v1', cashout: 'cashout.v1' },
    },
  };
}
