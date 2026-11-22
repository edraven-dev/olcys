import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCES_PATH, loadSourceRegister, SourceConfigError, parseSourceRegistry } from '../src/index.ts';

async function tempRegister(edit: (yaml: string) => string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'olcys-register-'));
  const path = join(dir, 'sources.yaml');
  await writeFile(path, edit(await readFile(DEFAULT_SOURCES_PATH, 'utf8')));
  return path;
}

async function problemsOf(path: string): Promise<string> {
  try {
    await loadSourceRegister(path);
  } catch (error) {
    if (error instanceof SourceConfigError) return error.problems.join('\n');
    throw error;
  }
  return '';
}

describe('source register', () => {
  it('loads the real file: every entry has a Polish name, a Polish note and a tosUrl key', async () => {
    const register = await loadSourceRegister();
    expect(register.version).toBe('sources.v1');
    expect(register.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(register.entries.size).toBeGreaterThan(30);
    const yaml = await readFile(DEFAULT_SOURCES_PATH, 'utf8');
    const entries = [...register.entries.values()];
    expect(entries.filter((d) => !d.namePl.trim()).map((d) => d.id)).toEqual([]);
    expect(entries.filter((d) => !d.complianceNotePl.trim()).map((d) => d.id)).toEqual([]);
    expect(entries.filter((d) => d.tosUrl !== null && !d.tosUrl.startsWith('https://')).map((d) => d.id)).toEqual([]);
    expect(entries.filter((d) => d.compliance === 'RED' && !d.blockedHosts?.length).map((d) => d.id)).toEqual([]);
    expect(yaml).not.toMatch(/OLC-\d+/);
  });

  it('keeps the terms links the register promises', async () => {
    const { entries } = await loadSourceRegister();
    expect(entries.get('bitlist')?.tosUrl).toBe('https://bitlist.co/terms');
    expect(entries.get('farcaster')?.tosUrl).toBeNull();
    expect(entries.get('nbp_api')?.tosUrl).toBe('https://api.nbp.pl/en.html');
  });

  it('lists the required RED hosts', async () => {
    const { entries } = await loadSourceRegister();
    const hosts = new Set([...entries.values()].flatMap((d) => (d.compliance === 'RED' ? (d.blockedHosts ?? []) : [])));
    const required = [
      'x.com',
      'twitter.com',
      'api.x.com',
      'api.twitter.com',
      'reddit.com',
      'www.reddit.com',
      'oauth.reddit.com',
      'discord.com',
      'discordapp.com',
      'youtube.com',
      'www.youtube.com',
      'youtube.googleapis.com',
      'facebook.com',
      'graph.facebook.com',
      'instagram.com',
      'linkedin.com',
      'api.linkedin.com',
      'linktr.ee',
      'allegro.pl',
      'api.allegro.pl',
      'allegrolokalnie.pl',
      'olx.pl',
      'gravatar.com',
      'api.gravatar.com',
    ];
    expect(required.filter((host) => !hosts.has(host))).toEqual([]);
  });

  it('rejects x_twitter enabled by default, naming the entry', async () => {
    const path = await tempRegister((y) => y.replace(/(  x_twitter:[\s\S]*?enabledByDefault: )false/, '$1true'));
    expect(await problemsOf(path)).toMatch(/sources\.x_twitter\.enabledByDefault/);
  });

  it('rejects a RED entry without blockedHosts', async () => {
    const path = await tempRegister((y) => y.replace(/(  linktree:[\s\S]*?)\n    blockedHosts: \[[^\]]*\]/, '$1'));
    expect(await problemsOf(path)).toMatch(/sources\.linktree\.blockedHosts/);
  });

  it('rejects a RED entry with a rate limit or allowed hosts', async () => {
    const rate = await tempRegister((y) => y.replace(/(  olx:[\s\S]*?rateLimit: \{ requests: )0/, '$11'));
    expect(await problemsOf(rate)).toMatch(/sources\.olx\.rateLimit/);
    const hosts = await tempRegister((y) => y.replace(/(  olx:[\s\S]*?allowedHosts: )\[\]/, '$1[olx.pl]'));
    expect(await problemsOf(hosts)).toMatch(/sources\.olx\.allowedHosts/);
  });

  it('rejects an AMBER entry that is enabled by default', async () => {
    const path = await tempRegister((y) => y.replace(/(  bitcointalk:[\s\S]*?enabledByDefault: )false/, '$1true'));
    expect(await problemsOf(path)).toMatch(/sources\.bitcointalk\.enabledByDefault/);
  });

  it('rejects an entry without namePl, complianceNotePl or the tosUrl key', async () => {
    const noName = await tempRegister((y) => y.replace(/(  keybase:[\s\S]*?)\n    namePl: [^\n]*/, '$1'));
    expect(await problemsOf(noName)).toMatch(/sources\.keybase\.namePl/);
    const noNote = await tempRegister((y) => y.replace(/(  keybase:[\s\S]*?)\n    complianceNotePl: [^\n]*/, '$1'));
    expect(await problemsOf(noNote)).toMatch(/sources\.keybase\.complianceNotePl/);
    const noTos = await tempRegister((y) => y.replace(/(  keybase:[\s\S]*?)\n    tosUrl: [^\n]*/, '$1'));
    expect(await problemsOf(noTos)).toMatch(/sources\.keybase\.tosUrl/);
  });

  it('rejects an id used in both sections', async () => {
    const path = await tempRegister((y) => {
      const block = /  keybase:\n(?:    .*\n)+/.exec(y)?.[0] ?? '';
      return `${y.trimEnd()}\n\n${block}`;
    });
    expect(await problemsOf(path)).toMatch(/keybase.*(already used|duplicate)/);
  });

  it('rejects the same id twice in one section', () => {
    expect(() => parseSourceRegistry('version: t\nsources:\n  a: {}\n  a: {}\n')).toThrow(SourceConfigError);
  });
});
