/**
 * Static checks of the telemetry opt-outs: every compose service, Dockerfile and CI workflow sets the variables of
 * the telemetry block of `.env.example`, and secrets only ever have the local-development placeholder as default.
 */
import { parse } from 'yaml';

/** Opt-outs every container and CI configuration must set (the telemetry block of `.env.example`). */
export const TELEMETRY_OFF = [
  'DO_NOT_TRACK',
  'HF_HUB_OFFLINE',
  'HF_HUB_DISABLE_TELEMETRY',
  'VLLM_NO_USAGE_STATS',
  'OLLAMA_NO_CLOUD',
  'NEXT_TELEMETRY_DISABLED',
  'TURBO_TELEMETRY_DISABLED',
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'NPM_CONFIG_UPDATE_NOTIFIER',
] as const;

type Env = Record<string, unknown> | string[] | undefined;

function envKeys(env: Env): Set<string> {
  if (!env) return new Set();
  if (Array.isArray(env)) return new Set(env.map((e) => e.split('=')[0] ?? ''));
  return new Set(Object.keys(env));
}

const missingFrom = (present: Set<string>): string[] => TELEMETRY_OFF.filter((k) => !present.has(k));

/** Problems of a compose file: one per service lacking opt-outs. YAML merge keys (`<<`) are resolved. */
export function composeProblems(source: string): string[] {
  const doc = parse(source, { merge: true }) as { services?: Record<string, { environment?: Env }> };
  return Object.entries(doc.services ?? {}).flatMap(([name, service]) => {
    const missing = missingFrom(envKeys(service.environment));
    return missing.length ? [`compose service ${name}: missing ${missing.join(', ')}`] : [];
  });
}

/** A Dockerfile sets the opt-outs through `ENV` (`KEY=value` or `KEY value`, line continuations joined). */
export function dockerfileProblems(name: string, source: string): string[] {
  const joined = source.replace(/\\\r?\n/g, ' ');
  const present = new Set<string>();
  for (const m of joined.matchAll(/^\s*ENV\s+(.+)$/gm)) {
    for (const k of (m[1] ?? '').matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/g)) present.add(k[1] ?? '');
  }
  const missing = missingFrom(present);
  return missing.length ? [`${name}: missing ${missing.join(', ')}`] : [];
}

/** A workflow sets them in its top-level `env`. */
export function workflowProblems(name: string, source: string): string[] {
  const doc = parse(source) as { env?: Env };
  const missing = missingFrom(envKeys(doc.env));
  return missing.length ? [`${name}: missing ${missing.join(', ')}`] : [];
}

/** `.env.example` lists them with the value that switches telemetry off. */
export function envExampleProblems(source: string): string[] {
  const values = new Map<string, string>();
  for (const line of source.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) values.set(m[1] ?? '', m[2] ?? '');
  }
  return TELEMETRY_OFF.filter((k) => !values.has(k)).map((k) => `.env.example: missing ${k}`);
}

const SECRET_NAME = /(PASSWORD|TOKEN|SECRET|API_KEY|PRIVATE_KEY)/;

/**
 * Compose defaults of secret-like variables (`${NAME:-default}`) must equal the placeholder in `.env.example`
 * (the local-development value); everything else comes from the environment.
 */
export function secretDefaultProblems(compose: string, envExample: string): string[] {
  const example = new Map<string, string>();
  for (const line of envExample.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) example.set(m[1] ?? '', m[2] ?? '');
  }
  return [...compose.matchAll(/\$\{([A-Z0-9_]+):-([^}]*)\}/g)].flatMap((m) => {
    const [, name = '', value = ''] = m;
    if (!SECRET_NAME.test(name) || value === '') return [];
    return example.get(name) === value ? [] : [`compose default of ${name} is not the .env.example placeholder`];
  });
}

/** Secret-like keys of `.env.example` that are third-party credentials must be empty. */
export function envExampleSecretProblems(envExample: string): string[] {
  return envExample.split('\n').flatMap((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=(.+)$/.exec(line);
    return m && /(API_KEY|_TOKEN|GITHUB_TOKEN)$/.test(m[1] ?? '') ? [`.env.example: ${m[1]} must be empty`] : [];
  });
}
