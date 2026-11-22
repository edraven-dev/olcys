import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pl } from '../src/i18n/pl.ts';
import { parseRoute, routePath, RUN_TABS } from '../src/lib/router.tsx';

describe('graph route', () => {
  it('registers the tab right after the links tab', () => {
    expect(RUN_TABS.indexOf('graph')).toBe(RUN_TABS.indexOf('links') + 1);
    expect(pl.tabs.graph).toBe('Graf powiązań');
  });

  it('maps /graf to the graph tab and back', () => {
    const route = { name: 'run', caseId: 'c1', runId: 'r1', tab: 'graph' } as const;
    expect(routePath(route)).toBe('/sprawy/c1/przebiegi/r1/graf');
    expect(parseRoute('/sprawy/c1/przebiegi/r1/graf')).toEqual(route);
  });
});

describe('dependencies', () => {
  it('does not use a Cytoscape React wrapper or Neo4j NVL', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const manifests = ['package.json', 'apps/web/package.json'].map((f) => readFileSync(`${root}/${f}`, 'utf8'));
    for (const manifest of manifests) expect(manifest).not.toMatch(/react-cytoscapejs|@neo4j-nvl/);
  });
});
