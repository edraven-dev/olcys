/**
 * Which search collectors a run registers (`OLCYS_SEARCH_MODE`): `off` none, `mock` (default) only the mock search
 * over the fixture site, `external` also Brave and Mojeek — only in `live` and `replay` runs and only with their API
 * key set. There is no fallback from the mock to an external provider. Each source still has to be enabled for the
 * case (Brave and Mojeek are AMBER: with a justification).
 */
import type { FetchMode } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import type { Env } from '../framework/config.ts';
import { createBraveSearchCollector, createMockSearchCollector, createMojeekSearchCollector } from './collector.ts';
import { MOJEEK_PLANS, type MojeekPlan } from './mojeek.ts';

export const SEARCH_MODES = ['off', 'mock', 'external'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

function choice<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = value?.trim().toLowerCase();
  if (!v) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${value}")`);
}

/** `OLCYS_SEARCH_MODE`, default `mock`; an unknown value is a configuration error. */
export function searchModeFromEnv(env: Env): SearchMode {
  return choice('OLCYS_SEARCH_MODE', env['OLCYS_SEARCH_MODE'], SEARCH_MODES, 'mock');
}

/** `BRAVE_SEARCH_STORAGE_RIGHTS` (`true` / `false`, default `false`): whether the Brave plan allows storing results. */
export function braveStorageRightsFromEnv(env: Env): boolean {
  return (
    choice('BRAVE_SEARCH_STORAGE_RIGHTS', env['BRAVE_SEARCH_STORAGE_RIGHTS'], ['true', 'false'], 'false') === 'true'
  );
}

/** `MOJEEK_PLAN`, default `startup` (the plan decides whether results may be stored). */
export function mojeekPlanFromEnv(env: Env): MojeekPlan {
  return choice('MOJEEK_PLAN', env['MOJEEK_PLAN'], MOJEEK_PLANS, 'startup');
}

/** The search collectors to register for a run in `mode` (keys are read from the environment only). */
export function searchCollectorFactories(options: { mode: FetchMode; env?: Env }): CollectorFactory[] {
  const env = options.env ?? {};
  const search = searchModeFromEnv(env);
  if (search === 'off') return [];
  const factories = [createMockSearchCollector()];
  if (search !== 'external' || (options.mode !== 'live' && options.mode !== 'replay')) return factories;
  const braveKey = env['BRAVE_SEARCH_API_KEY']?.trim();
  if (braveKey) {
    factories.push(createBraveSearchCollector({ apiKey: braveKey, storageRights: braveStorageRightsFromEnv(env) }));
  }
  const mojeekKey = env['MOJEEK_API_KEY']?.trim();
  if (mojeekKey) factories.push(createMojeekSearchCollector({ apiKey: mojeekKey, plan: mojeekPlanFromEnv(env) }));
  return factories;
}
