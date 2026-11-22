/**
 * AC7: live sandbox node (compose profile "sandbox", Anvil with the Otterscan API). Skipped with a message when
 * SANDBOX_EVM_RPC_URL is unset or the node is not reachable. Only loopback/compose hosts are ever contacted; the
 * probe and the provider both go through a pass-through egress double restricted to such hosts.
 * The storyline (deposit and sweep, a test token) is deployed by the sandbox seed (OLC-124); without it the live
 * node still has to answer the API-level, tip and code reads.
 */
import { describe, expect, it } from 'vitest';
import { createOtterscanEvmProvider } from '../src/index.ts';
import { FakeEgressClient, testContext } from './helpers/fake-egress.ts';

const url = process.env['SANDBOX_EVM_RPC_URL']?.trim();
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', 'anvil']);

async function reachable(target: string | undefined): Promise<boolean> {
  if (!target || !LOCAL_HOSTS.has(new URL(target).hostname)) return false;
  try {
    // Test-only probe of the local sandbox node (tests are exempt from the network guard).
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ots_getApiLevel', params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const live = await reachable(url);
if (!live) {
  console.info('otterscan integration test skipped: SANDBOX_EVM_RPC_URL is unset or the sandbox node is not reachable');
}

describe.skipIf(!live)('Otterscan provider against the live sandbox node', () => {
  const egress = new FakeEgressClient(async (request) => {
    if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) throw new Error(`test egress refuses ${request.url}`);
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    return { status: response.status, body: await response.text() };
  });
  const provider = createOtterscanEvmProvider({
    chains: ['evm:1'],
    rpcUrl: url ?? '',
    sourceId: 'sandbox_anvil',
  });
  const ctx = testContext(egress);
  const address = { chain: 'evm:1' as const, address: '0x00000000000000000000000000000000000000a1' };

  it('serves the tip, code and an address history through the provider', async () => {
    const tip = await provider.getTip('evm:1', ctx);
    expect(tip.height).toBeGreaterThanOrEqual(0);
    expect((await provider.getCode!(address, ctx)).code).toMatch(/^0x[0-9a-f]*$/);
    const page = await provider.listTransfers(address, { toBlock: tip.height }, ctx);
    expect(Array.isArray(page.items)).toBe(true);
  });
});
