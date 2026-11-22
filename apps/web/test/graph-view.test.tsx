// @vitest-environment happy-dom
import type { CaseWithIdentifiers, RunWithProgress } from '@olcys/core';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cy = vi.hoisted(() => {
  const state = {
    created: 0,
    destroyed: 0,
    handlers: new Map<string, (event: unknown) => void>(),
    added: [] as unknown[],
  };
  const instance = () => ({
    on: (name: string, ...rest: unknown[]) => {
      const selector = rest.length > 1 ? String(rest[0]) : '';
      state.handlers.set(`${name} ${selector}`.trim(), rest.at(-1) as (event: unknown) => void);
    },
    batch: (fn: () => void) => fn(),
    elements: () => ({ remove: () => undefined }),
    add: (elements: unknown) => state.added.push(elements),
    layout: () => ({ run: () => undefined }),
    style: () => undefined,
    fit: () => undefined,
    destroy: () => {
      state.destroyed += 1;
    },
  });
  return {
    state,
    factory: () => {
      state.created += 1;
      return instance();
    },
  };
});

vi.mock('cytoscape', () => ({ default: cy.factory }));

import { CytoscapeGraph } from '../src/features/graph/CytoscapeGraph.tsx';
import { GraphTab } from '../src/features/graph/GraphTab.tsx';
import { buildGraph, DEFAULT_GRAPH_OPTIONS } from '../src/features/graph/build-elements.ts';
import type { RunScope } from '../src/features/run/RunPage.tsx';
import { setFetch } from '../src/lib/api.ts';
import { accounts, activity, exclusion, graphInput, identifiers, links } from './fixtures/graph.ts';
import { ETH_1, RUN_ID } from './fixtures/persona.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  cy.state.created = 0;
  cy.state.destroyed = 0;
  cy.state.added.length = 0;
  cy.state.handlers.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const noop = () => undefined;
const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('CytoscapeGraph lifecycle', () => {
  const build = buildGraph(graphInput, DEFAULT_GRAPH_OPTIONS);

  it('creates and destroys the instance equally often across StrictMode mounts', () => {
    act(() =>
      root.render(
        <StrictMode>
          <CytoscapeGraph build={build} layout="layered" onSelectNode={noop} onSelectEdge={noop} />
        </StrictMode>,
      ),
    );
    act(() => root.unmount());
    root = createRoot(host);
    act(() =>
      root.render(
        <StrictMode>
          <CytoscapeGraph build={build} layout="force" onSelectNode={noop} onSelectEdge={noop} />
        </StrictMode>,
      ),
    );
    act(() => root.unmount());
    expect(cy.state.created).toBeGreaterThanOrEqual(2);
    expect(cy.state.destroyed).toBe(cy.state.created);
    root = createRoot(host);
  });

  it('replaces the elements when the build changes and forwards taps', () => {
    const onNode = vi.fn<(id: string) => void>();
    const onEdge = vi.fn<(id: string) => void>();
    const render = (value: typeof build) =>
      act(() =>
        root.render(<CytoscapeGraph build={value} layout="layered" onSelectNode={onNode} onSelectEdge={onEdge} />),
      );
    render(build);
    const before = cy.state.added.length;
    render(buildGraph(graphInput, { ...DEFAULT_GRAPH_OPTIONS, showRejected: false }));
    expect(cy.state.created).toBe(1);
    expect(cy.state.added.length).toBe(before + 1);
    cy.state.handlers.get('tap node')?.({ target: { id: () => 'subject' } });
    cy.state.handlers.get('tap edge')?.({ target: { id: () => 'e1' } });
    expect(onNode).toHaveBeenCalledWith('subject');
    expect(onEdge).toHaveBeenCalledWith('e1');
  });

  it('exposes the plural-correct description as the accessible name', () => {
    act(() => root.render(<CytoscapeGraph build={build} layout="layered" onSelectNode={noop} onSelectEdge={noop} />));
    const img = host.querySelector('[role="img"]');
    expect(img?.getAttribute('aria-label')).toBe(
      `Graf powiązań: ${build.nodes.length} węzłów i ${build.edges.length} krawędzi. Pełna treść jest dostępna w widoku listy.`,
    );
  });
});

describe('GraphTab', () => {
  const scope = {
    run: { id: RUN_ID, caseId: 'case-1', mode: 'offline', status: 'succeeded' } as unknown as RunWithProgress,
    kase: { id: 'case-1', title: 'Sprawa testowa', identifiers } as unknown as CaseWithIdentifiers,
    version: 'v',
  } satisfies RunScope;

  const requested: string[] = [];

  beforeEach(() => {
    requested.length = 0;
    const bodies: Record<string, unknown> = {
      links,
      exclusions: [exclusion],
      accounts,
      activity: [activity],
    };
    setFetch((url) => {
      requested.push(url);
      const name = url.split('/').pop() ?? '';
      return Promise.resolve(new Response(JSON.stringify({ items: bodies[name] ?? [] }), { status: 200 }));
    });
  });

  it('renders the legend and the Polish controls', async () => {
    act(() => root.render(<GraphTab scope={scope} />));
    await flush();
    const text = host.textContent ?? '';
    for (const expected of [
      'Graf powiązań',
      'Legenda',
      'Pokaż odrzucone',
      'Pokaż przepływy środków',
      'Minimalny Wskaźnik Pewności',
      'Pokaż jako listę',
      'Grubość krawędzi odpowiada prawdopodobieństwu etapu.',
    ]) {
      expect(text).toContain(expected);
    }
    expect(requested.some((u) => u.endsWith('/activity'))).toBe(false);
    expect(host.querySelector('[role="img"]')).not.toBeNull();
  });

  it('loads the activity only when flows are switched on', async () => {
    act(() => root.render(<GraphTab scope={scope} />));
    await flush();
    const flows = [...host.querySelectorAll('input[type="checkbox"]')][1] as HTMLInputElement;
    act(() => flows.click());
    await flush();
    expect(requested.some((u) => u.endsWith('/activity'))).toBe(true);
  });

  it('switches to the list view, which shows every node and edge and opens the details', async () => {
    act(() => root.render(<GraphTab scope={scope} />));
    await flush();
    act(() => button('Pokaż jako listę').click());
    const tables = host.querySelectorAll('table');
    expect(tables).toHaveLength(2);
    expect(host.querySelector('[role="img"]')).toBeNull();
    const rows = (index: number) => tables[index]?.querySelectorAll('tbody tr').length;
    expect(rows(0)).toBeGreaterThan(10);
    expect(rows(1)).toBeGreaterThan(10);
    expect(host.textContent).toContain('reguła A4');
    expect(host.textContent).toContain('P = 0,9900 (kotwica)');

    const select = [...host.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.includes('odrzucony'),
    );
    expect(select).toBeDefined();
    act(() => (select as HTMLButtonElement).click());
    const activityLink = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Pokaż aktywność on-chain');
    expect(activityLink?.getAttribute('href')).toContain(`/aktywnosc?adres=${encodeURIComponent(`evm:1:${ETH_1}`)}`);
    expect(host.textContent).toContain('Reguła odrzucenia: A4');
  });

  it('links an edge to the evidence of its link', async () => {
    act(() => root.render(<GraphTab scope={scope} />));
    await flush();
    act(() => button('Pokaż jako listę').click());
    const edge = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.includes('· E2'));
    act(() => (edge as HTMLButtonElement).click());
    const evidence = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Pokaż dowody');
    expect(evidence?.getAttribute('href')).toBe(`/sprawy/case-1/przebiegi/${RUN_ID}/powiazania#link-link-eth2`);
  });

  it('removes rejected addresses from the list when "Pokaż odrzucone" is off', async () => {
    act(() => root.render(<GraphTab scope={scope} />));
    await flush();
    act(() => button('Pokaż jako listę').click());
    const rejected = [...host.querySelectorAll('input[type="checkbox"]')][0] as HTMLInputElement;
    act(() => rejected.click());
    expect(host.textContent).not.toContain('reguła A4');
  });
});
