import { newId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { buildCoSpendClusters, detectCoinJoin, MemoryLabelLookup } from '../src/index.ts';
import { addr, equalOutputs, rules, tx, txid } from './cospend-helpers.ts';

const runId = newId();
const cluster = async (seeds: string[], txs: ReturnType<typeof tx>[]) => {
  const prevTxs = new Map(txs.map((t) => [t.txid, t]));
  const [first] = await buildCoSpendClusters(seeds, txs, { labels: new MemoryLabelLookup([]), prevTxs, rules }, runId);
  return first;
};

describe('CoinJoin and collaborative guards', () => {
  it('AC2: skips a Wasabi-style transaction (12 equal outputs) and keeps the seed alone', async () => {
    const wasabi = tx('w', [addr('A'), addr('X')], { outputs: equalOutputs('w', 12, 10_000_000) });
    const c = await cluster([addr('A')], [wasabi]);
    expect(c?.members).toEqual([addr('A')]);
    expect(c?.skipped).toEqual([{ txid: txid('w'), reason: 'coinjoin_wasabi' }]);
  });

  it('AC3: skips a Whirlpool 5x5 mix whose input comes from a tx0', async () => {
    const tx0 = tx('tx0', [addr('owner')], {
      height: 90,
      inputSats: 5_000_000,
      outputs: [{ sats: 0, scriptType: 'op_return' }, ...equalOutputs('tx0', 3, 1_020_000)],
    });
    const owners = ['p1', 'p2', 'p3', 'p4', 'p5'].map(addr);
    const mix = tx('mix', owners, {
      height: 100,
      outputs: equalOutputs('mix', 5, 1_000_000),
      prev: { [owners[0] ?? '']: { txid: tx0.txid, vout: 1 } },
    });
    expect(detectCoinJoin(mix, { prevTxs: new Map([[tx0.txid, tx0]]), rules })).toBe('coinjoin_whirlpool');
    const c = await cluster([owners[0] ?? ''], [tx0, mix]);
    expect(c?.members).toEqual([owners[0]]);
    expect(c?.skipped).toEqual([{ txid: txid('mix'), reason: 'coinjoin_whirlpool' }]);
  });

  it('treats a pool-mix output spent again as a Whirlpool remix', () => {
    const owners = ['p1', 'p2', 'p3', 'p4', 'p5'].map(addr);
    const first = tx('mix1', owners, { height: 100, outputs: equalOutputs('mix1', 5, 1_000_000) });
    const remix = tx('mix2', ['q1', 'q2', 'q3', 'q4', 'q5'].map(addr), {
      height: 101,
      outputs: equalOutputs('mix2', 5, 1_000_000),
      prev: { [addr('q1')]: { txid: first.txid, vout: 2 } },
    });
    expect(detectCoinJoin(remix, { prevTxs: new Map([[first.txid, first]]), rules })).toBe('coinjoin_whirlpool');
  });

  it('falls back to the equal-output guard when a 5x5 transaction has no known tx0', () => {
    const mix = tx('mix', ['p1', 'p2', 'p3', 'p4', 'p5'].map(addr), { outputs: equalOutputs('mix', 5, 1_000_000) });
    expect(detectCoinJoin(mix, { prevTxs: new Map(), rules })).toBe('equal_outputs');
  });

  it('AC4: skips 4 equal outputs of 6 but merges 2 equal of 5', async () => {
    const skipped = tx('s', [addr('A'), addr('X')], {
      outputs: [
        ...equalOutputs('s', 4, 20_000),
        { address: addr('r1'), sats: 7_000 },
        { address: addr('r2'), sats: 9_000 },
      ],
    });
    const a = await cluster([addr('A')], [skipped]);
    expect(a?.skipped).toEqual([{ txid: txid('s'), reason: 'equal_outputs' }]);
    expect(a?.members).toEqual([addr('A')]);
    const merged = tx('m', [addr('A'), addr('X')], {
      outputs: [
        ...equalOutputs('m', 2, 20_000),
        { address: addr('r1'), sats: 7_000 },
        { address: addr('r2'), sats: 9_000 },
        { address: addr('r3'), sats: 11_000 },
      ],
    });
    const b = await cluster([addr('A')], [merged]);
    expect(b?.members).toEqual([addr('A'), addr('X')]);
    expect(b?.skipped).toEqual([]);
  });

  it('AC5: skips a transaction creating a P2WSH output from inputs of two addresses', async () => {
    const escrow = tx('e', [addr('A'), addr('B')], {
      outputs: [{ address: addr('escrow'), sats: 90_000, scriptType: 'v0_p2wsh' }],
    });
    const c = await cluster([addr('A')], [escrow]);
    expect(c?.skipped).toEqual([{ txid: txid('e'), reason: 'collaborative_escrow' }]);
    expect(c?.members).toEqual([addr('A')]);
  });

  it('skips a co-spend that reveals a multisig witness script together with other addresses', async () => {
    const multisig = tx('ms', [addr('A'), addr('B')], {
      witnessScriptAsm: { [addr('A')]: 'OP_2 OP_PUSHBYTES_33 aa OP_PUSHBYTES_33 bb OP_2 OP_CHECKMULTISIG' },
    });
    const c = await cluster([addr('A')], [multisig]);
    expect(c?.skipped).toEqual([{ txid: txid('ms'), reason: 'collaborative_escrow' }]);
  });

  it('does not flag a P2WSH output funded by a single address', async () => {
    const single = tx('one', [addr('A')], {
      outputs: [{ address: addr('escrow'), sats: 90_000, scriptType: 'v0_p2wsh' }],
    });
    expect(detectCoinJoin(single, { prevTxs: new Map(), rules })).toBeUndefined();
    const c = await cluster([addr('A')], [single]);
    expect(c?.skipped).toEqual([]);
  });

  it('lists a skipped transaction only with the clusters it spends from', async () => {
    const wasabi = tx('w', [addr('X'), addr('Y')], { outputs: equalOutputs('w', 12, 10_000_000) });
    const c = await cluster([addr('A')], [wasabi]);
    expect(c?.skipped).toEqual([]);
  });
});
