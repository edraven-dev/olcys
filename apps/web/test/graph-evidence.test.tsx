// @vitest-environment happy-dom
import type { CaseWithIdentifiers, RunWithProgress } from '@olcys/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evidencePath } from '../src/features/graph/evidence-target.ts';
import { RejectedTab } from '../src/features/rejected/RejectedTab.tsx';
import type { RunScope } from '../src/features/run/RunPage.tsx';
import { setFetch } from '../src/lib/api.ts';
import { navigate } from '../src/lib/router.tsx';
import { identifiers, exclusion } from './fixtures/graph.ts';
import { btcLink, ETH_1, RUN_ID } from './fixtures/persona.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = { caseId: 'case-1', id: RUN_ID };
const counterparty = {
  ...btcLink,
  id: 'link-cp',
  address: { chain: 'bitcoin' as const, address: 'bc1qcounterparty' },
  relation: 'TX_COUNTERPARTY' as const,
  score: 0,
  gates: [{ gate: 'relation', passed: false }],
};
const kept = {
  ...exclusion,
  id: 'excl-kept',
  address: { chain: 'evm:1' as const, address: '0xkeptaddress' },
  outcome: 'kept' as const,
};

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

describe('evidencePath', () => {
  const base = `/sprawy/case-1/przebiegi/${RUN_ID}`;

  it('sends main-table links to the links tab', () => {
    expect(evidencePath(run, { linkId: 'l1', address: btcLink.address, rejected: false }, [exclusion])).toBe(
      `${base}/powiazania#link-l1`,
    );
  });

  it('sends a rejected address with a decision to its exclusion card', () => {
    expect(evidencePath(run, { linkId: 'l2', address: exclusion.address, rejected: true }, [exclusion])).toBe(
      `${base}/odrzucone#exclusion-${exclusion.id}`,
    );
  });

  it('sends other rejected links to their card among the relations without ownership', () => {
    expect(evidencePath(run, { linkId: 'link-cp', address: counterparty.address, rejected: true }, [exclusion])).toBe(
      `${base}/odrzucone#link-link-cp`,
    );
  });
});

describe('rejected tab anchors', () => {
  let host: HTMLElement;
  let root: Root;
  const scope = {
    run: { id: RUN_ID, caseId: 'case-1', mode: 'offline', status: 'succeeded' } as unknown as RunWithProgress,
    kase: { id: 'case-1', title: 'Sprawa', identifiers } as unknown as CaseWithIdentifiers,
    version: 'v',
  } satisfies RunScope;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    HTMLElement.prototype.scrollIntoView = () => undefined;
    const bodies: Record<string, unknown> = { exclusions: [exclusion, kept], links: [counterparty] };
    setFetch((url) =>
      Promise.resolve(new Response(JSON.stringify({ items: bodies[url.split('/').pop() ?? ''] ?? [] }))),
    );
    navigate('/');
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('gives the exclusion and relation cards addressable ids', async () => {
    act(() => root.render(<RejectedTab scope={scope} />));
    await flush();
    expect(host.querySelector(`#exclusion-${exclusion.id}`)).not.toBeNull();
    expect(host.querySelector('#link-link-cp')).not.toBeNull();
    expect(ETH_1).toBeTruthy();
  });

  it('opens the collapsed kept section for a hash that points into it', async () => {
    act(() => root.render(<RejectedTab scope={scope} />));
    await flush();
    const details = host.querySelector(`#exclusion-${kept.id}`)?.closest('details');
    expect(details?.open).toBe(false);
    act(() => navigate(`/sprawy/case-1/przebiegi/${RUN_ID}/odrzucone#exclusion-${kept.id}`));
    await flush();
    expect(host.querySelector(`#exclusion-${kept.id}`)?.closest('details')?.open).toBe(true);
  });
});
