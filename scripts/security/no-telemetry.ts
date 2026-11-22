/**
 * Static checks of the telemetry opt-outs: every compose service, Dockerfile and CI workflow sets the variables of
 * the telemetry block of `.env.example`, and secrets only ever have the local-development placeholder as default.
 */
import { parse } from 'yaml';

/** Opt-outs every container and CI configuration must set, with the value that switches telemetry off. */
export const TELEMETRY_OFF_VALUES = {
  DO_NOT_TRACK: '1',
  HF_HUB_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  VLLM_NO_USAGE_STATS: '1',
  OLLAMA_NO_CLOUD: '1',
  NEXT_TELEMETRY_DISABLED: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
} as const;
export const TELEMETRY_OFF = Object.keys(TELEMETRY_OFF_VALUES) as (keyof typeof TELEMETRY_OFF_VALUES)[];

type Env = Record<string, unknown> | string[] | undefined;

/** Variable -> value (as text) of a compose or workflow `environment`/`env` block. */
function envValues(env: Env): Map<string, string> {
  const out = new Map<string, string>();
  if (!env) return out;
  if (Array.isArray(env)) {
    for (const e of env) {
      const [k = '', ...rest] = e.split('=');
      out.set(k, rest.join('='));
    }
  } else {
    for (const [k, v] of Object.entries(env)) out.set(k, v === null || v === undefined ? '' : String(v));
  }
  return out;
}

/** One problem per opt-out that is missing or set to anything but its opt-out value. */
function problemsOf(where: string, values: Map<string, string>): string[] {
  return TELEMETRY_OFF.flatMap((k) => {
    const value = values.get(k);
    if (value === undefined) return [`${where}: missing ${k}`];
    return value === TELEMETRY_OFF_VALUES[k] ? [] : [`${where}: ${k} is ${value}, expected ${TELEMETRY_OFF_VALUES[k]}`];
  });
}

/** Problems of a compose file, per service. YAML merge keys (`<<`) are resolved. */
export function composeProblems(source: string): string[] {
  const doc = parse(source, { merge: true }) as { services?: Record<string, { environment?: Env }> };
  return Object.entries(doc.services ?? {}).flatMap(([name, service]) =>
    problemsOf(`compose service ${name}`, envValues(service.environment)),
  );
}

/** A Dockerfile sets the opt-outs through `ENV` (`KEY=value` or `KEY value`, line continuations joined). */
export function dockerfileProblems(name: string, source: string): string[] {
  const joined = source.replace(/\\\r?\n/g, ' ');
  const values = new Map<string, string>();
  for (const m of joined.matchAll(/^\s*ENV\s+(.+)$/gm)) {
    for (const k of (m[1] ?? '').matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)) {
      values.set(k[1] ?? '', (k[2] ?? '').replace(/^(["'])(.*)\1$/, '$2'));
    }
  }
  return problemsOf(name, values);
}

/** A workflow sets them in its top-level `env`. */
export function workflowProblems(name: string, source: string): string[] {
  return problemsOf(name, envValues((parse(source) as { env?: Env }).env));
}

/** `.env.example` lists them with the value that switches telemetry off. */
export function envExampleProblems(source: string): string[] {
  const values = new Map<string, string>();
  for (const line of source.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) values.set(m[1] ?? '', m[2] ?? '');
  }
  return problemsOf('.env.example', values);
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
