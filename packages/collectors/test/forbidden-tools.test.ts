import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeForbiddenDependency,
  loadForbiddenTools,
  parseForbiddenTools,
  scanForbiddenDependencies,
  SourceConfigError,
} from '../src/index.ts';
import { REPO } from './helpers.ts';

async function scanTemp(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'olcys-forbidden-'));
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    }),
  );
  return scanForbiddenDependencies(await loadForbiddenTools(), dir);
}

const compose = (image: string): string => `services:\n  cache:\n    image: ${image}\n`;

describe('forbidden tools list', () => {
  it('loads with Polish and English reasons for every tool', async () => {
    const { tools, featureRules } = await loadForbiddenTools();
    expect(tools.length).toBeGreaterThan(40);
    expect(tools.filter((t) => !t.reason.pl.trim() || !t.reason.en.trim()).map((t) => t.id)).toEqual([]);
    const ids = new Set(tools.map((t) => t.id));
    expect(['holehe', 'ghunt', 'react_cytoscapejs', 'litellm', 'redis_server'].filter((id) => !ids.has(id))).toEqual(
      [],
    );
    expect(featureRules.map((r) => r.tool)).toContain('maigret');
  });

  it('rejects an entry without reasons or with an unknown category', () => {
    expect(() =>
      parseForbiddenTools(
        'version: v\ntools:\n  x:\n    category: nope\n    reason: { pl: "a" }\n    url: https://x.test\n',
      ),
    ).toThrow(SourceConfigError);
  });
});

describe('forbidden dependency scan', () => {
  it('passes on the repository', async () => {
    const hits = await scanForbiddenDependencies(await loadForbiddenTools(), REPO);
    expect(hits.map(describeForbiddenDependency)).toEqual([]);
  });

  it('names the package and the reason for react-cytoscapejs in a package.json', async () => {
    const hits = await scanTemp({
      'apps/x/package.json': JSON.stringify({ dependencies: { 'react-cytoscapejs': '2.0.0' } }),
    });
    expect(hits).toHaveLength(1);
    expect(describeForbiddenDependency(hits[0]!)).toMatch(/react-cytoscapejs.*forbidden.*Stale wrapper/s);
  });

  it('matches scoped patterns such as @neo4j-nvl/*', async () => {
    const hits = await scanTemp({
      'package.json': JSON.stringify({ devDependencies: { '@neo4j-nvl/base': '1.0.0' } }),
    });
    expect(hits.map((h) => h.dependency)).toEqual(['@neo4j-nvl/base']);
  });

  it('finds holehe in a pyproject.toml and in a uv.lock', async () => {
    const hits = await scanTemp({
      'services/osint-py/pyproject.toml':
        '[project]\nname = "osint-py"\ndependencies = [\n  "maigret==0.5.0",\n  "Holehe>=1.0",\n]\n',
      'services/osint-py/uv.lock': '[[package]]\nname = "holehe"\nversion = "1.0"\n',
    });
    expect(hits.map((h) => [h.ecosystem, h.dependency, h.file])).toEqual([
      ['pypi', 'holehe', 'services/osint-py/pyproject.toml'],
      ['pypi', 'holehe', 'services/osint-py/uv.lock'],
    ]);
  });

  it('finds redis 8 in a compose file but not redis 7 or a similarly named image', async () => {
    expect((await scanTemp({ 'compose.yml': compose('redis:8.2') })).map((h) => h.dependency)).toEqual(['redis:8.2']);
    expect((await scanTemp({ 'compose.yml': compose('docker.io/library/redis:8-alpine') })).length).toBe(1);
    expect(await scanTemp({ 'compose.yml': compose('redis:7.4') })).toEqual([]);
    expect(await scanTemp({ 'compose.yml': compose('redis-exporter:8') })).toEqual([]);
  });

  it('finds a forbidden base image in a Dockerfile', async () => {
    const hits = await scanTemp({ 'services/x/Dockerfile': 'FROM --platform=linux/amd64 memgraph/memgraph:2.0\n' });
    expect(hits.map((h) => h.toolId)).toEqual(['memgraph']);
  });
});
