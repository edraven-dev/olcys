import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeProblems,
  dockerfileProblems,
  envExampleProblems,
  envExampleSecretProblems,
  secretDefaultProblems,
  TELEMETRY_OFF_VALUES,
  workflowProblems,
} from './no-telemetry.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');

const expected = (where: string) => [
  `${where}: DO_NOT_TRACK is 0, expected 1`,
  `${where}: NPM_CONFIG_UPDATE_NOTIFIER is true, expected false`,
];

describe('telemetry opt-outs', () => {
  it('are in .env.example', () => {
    expect(envExampleProblems(read('.env.example'))).toEqual([]);
  });

  it('are set for every compose service (all profiles)', () => {
    expect(composeProblems(read('compose.yml'))).toEqual([]);
  });

  it('are set in every Dockerfile', () => {
    const files = tracked().filter((f) => /(^|\/)Dockerfile(\.[\w-]+)?$/.test(f));
    expect(files).toContain('services/osint-py/Dockerfile');
    expect(files.flatMap((f) => dockerfileProblems(f, read(f)))).toEqual([]);
  });

  it('are set in every CI workflow', () => {
    const files = tracked().filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => workflowProblems(f, read(f)))).toEqual([]);
  });

  it('fail a compose service without DO_NOT_TRACK', () => {
    const env = Object.fromEntries(Object.entries(TELEMETRY_OFF_VALUES).filter(([k]) => k !== 'DO_NOT_TRACK'));
    const source = `services:\n  temp:\n    image: x\n    environment: ${JSON.stringify(env)}\n`;
    expect(composeProblems(source)).toEqual(['compose service temp: missing DO_NOT_TRACK']);
    expect(composeProblems('services:\n  bare:\n    image: x\n')).toHaveLength(9);
  });

  it('fail a variable set to the wrong value in every kind of file', () => {
    const wrong = { ...TELEMETRY_OFF_VALUES, DO_NOT_TRACK: '0', NPM_CONFIG_UPDATE_NOTIFIER: 'true' };
    const lines = (sep: string) => Object.entries(wrong).map(([k, v]) => `${k}${sep}${v}`);
    const compose = `services:\n  temp:\n    image: x\n    environment: ${JSON.stringify(wrong)}\n`;
    expect(composeProblems(compose)).toEqual(expected('compose service temp'));
    expect(dockerfileProblems('Dockerfile', `FROM x\nENV ${lines('=').join(' \\\n    ')}\n`)).toEqual(
      expected('Dockerfile'),
    );
    expect(
      workflowProblems(
        'ci.yml',
        `env:\n${lines(': ')
          .map((l) => `  ${l}`)
          .join('\n')}\n`,
      ),
    ).toEqual(expected('ci.yml'));
    expect(envExampleProblems(lines('=').join('\n'))).toEqual(expected('.env.example'));
  });

  it('fail a Dockerfile and a workflow that lack them', () => {
    expect(dockerfileProblems('Dockerfile', 'FROM x\nENV DO_NOT_TRACK=1\n')).toHaveLength(8);
    expect(workflowProblems('ci.yml', "env:\n  DO_NOT_TRACK: '1'\n")).toHaveLength(8);
  });
});

describe('secrets only via the environment', () => {
  it('compose defaults of secrets are the .env.example placeholders', () => {
    expect(secretDefaultProblems(read('compose.yml'), read('.env.example'))).toEqual([]);
  });

  it('flags a compose default that differs from the placeholder', () => {
    expect(secretDefaultProblems('x: ${DB_PASSWORD:-hunter2}', 'DB_PASSWORD=other')).toHaveLength(1);
  });

  it('third-party credentials in .env.example are empty', () => {
    expect(envExampleSecretProblems(read('.env.example'))).toEqual([]);
    expect(envExampleSecretProblems('ETHERSCAN_API_KEY=abc')).toHaveLength(1);
  });

  it('no tracked file holds a private key or a GitHub token', () => {
    const pem = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
    const token = /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/;
    const offenders = tracked()
      // This file's own patterns and the extractor's synthetic test vectors are the only places such strings appear.
      .filter((f) => !/\.(png|jpg|pdf|woff2?|ico|gz)$/.test(f))
      .filter((f) => {
        const text = readFileSync(join(ROOT, f), 'utf8');
        return (pem.test(text) || token.test(text)) && !f.endsWith('no-telemetry.test.ts');
      });
    expect(offenders).toEqual([]);
  });
});
