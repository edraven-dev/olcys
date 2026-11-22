/**
 * Synthetic JSON-RPC node that speaks the Otterscan API (`ots_*`) over canned chain data: the transport double of
 * the sandbox (Anvil) and of an on-prem Erigon node. Synthetic addresses and values only; no network.
 */
import type { EgressRequest } from '@olcys/core';
import type { CannedResponse } from './fake-egress.ts';

export const hex = (n: number | bigint): string => `0x${n.toString(16)}`;
export const hash = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
export const word = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;

export interface NodeTx {
  hash: string;
  block: number;
  from: string;
  to: string | null;
  wei: bigint;
  input?: string;
  status?: 0 | 1;
  /** Inner value movements of the transaction (what `ots_getInternalOperations` lists). */
  internal?: { from: string; to: string; wei: bigint }[];
}
export interface NodeLog {
  contract: string;
  from: string;
  to: string;
  amount: bigint;
  block: number;
  tx: string;
  logIndex: number;
}
export interface NodeToken {
  symbol: string;
  decimals: number;
  /** Raw return of `symbol()`; default is the ABI-encoded dynamic string. */
  symbolReturn?: string;
}
export interface FakeNodeState {
  apiLevel: number | 'missing';
  /** `eth_chainId` answer (default 1, like the sandbox). */
  chainId?: number;
  /** Lists the top-level call as the first internal operation (some nodes do). */
  includeTopLevelCall?: boolean;
  tip: number;
  txs: NodeTx[];
  logs: NodeLog[];
  tokens: Record<string, NodeToken>;
  code: Record<string, string>;
  balances: Record<string, bigint>;
  nonces: Record<string, number>;
  /** Block timestamps by number (seconds); blocks default to `1_800_000_000 + n * 12`. */
  timestamps?: Record<number, number>;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const blockSeconds = (state: FakeNodeState, n: number): number =>
  state.timestamps?.[n] ?? 1_800_000_000 + n * 12;

export function abiString(text: string): string {
  const data = Buffer.from(text, 'utf8').toString('hex');
  return `0x${word(32n).slice(2)}${word(BigInt(text.length)).slice(2)}${data.padEnd(64, '0')}`;
}

type Params = unknown[];
const involves = (tx: NodeTx, a: string): boolean =>
  tx.from === a || tx.to === a || (tx.internal ?? []).some((op) => op.from === a || op.to === a);

const topicAddress = (a: string): string => `0x${'0'.repeat(24)}${a.slice(2)}`;

export function fakeOtterscanNode(state: FakeNodeState): (request: EgressRequest) => CannedResponse {
  return (request) => {
    const { id, method, params } = JSON.parse(bodyText(request)) as { id: number; method: string; params: Params };
    const ok = (result: unknown): CannedResponse => ({ body: { jsonrpc: '2.0', id, result } });
    const fail = (code: number, message: string): CannedResponse => ({
      body: { jsonrpc: '2.0', id, error: { code, message } },
    });
    switch (method) {
      case 'ots_getApiLevel':
        return state.apiLevel === 'missing'
          ? fail(-32601, 'the method ots_getApiLevel does not exist')
          : ok(state.apiLevel);
      case 'eth_chainId':
        return ok(hex(state.chainId ?? 1));
      case 'eth_blockNumber':
        return ok(hex(state.tip));
      case 'eth_getBlockByNumber': {
        const n = Number.parseInt(String((params as string[])[0]), 16);
        return ok({ number: hex(n), hash: hash(0xb10c0000 + n), timestamp: hex(blockSeconds(state, n)) });
      }
      case 'ots_searchTransactionsBefore': {
        const [address, before, pageSize] = params as [string, number, number];
        const all = state.txs
          .filter((tx) => involves(tx, address) && (before === 0 || tx.block < before))
          .toSorted((a, b) => b.block - a.block);
        // Pages never split a block.
        let end = Math.min(pageSize, all.length);
        while (end < all.length && all[end]?.block === all[end - 1]?.block) end += 1;
        const page = all.slice(0, end);
        return ok({
          txs: page.map((tx) => ({
            hash: tx.hash,
            blockNumber: hex(tx.block),
            from: tx.from,
            to: tx.to,
            value: hex(tx.wei),
            input: tx.input ?? '0x',
          })),
          receipts: page.map((tx) => ({
            transactionHash: tx.hash,
            status: hex(tx.status ?? 1),
            contractAddress: null,
            timestamp: hex(blockSeconds(state, tx.block)),
          })),
          firstPage: before === 0,
          lastPage: end >= all.length,
        });
      }
      case 'ots_getInternalOperations': {
        const tx = state.txs.find((t) => t.hash === (params as string[])[0]);
        const ops = [
          ...(tx && state.includeTopLevelCall && tx.to ? [{ from: tx.from, to: tx.to, wei: tx.wei }] : []),
          ...(tx?.internal ?? []),
        ];
        return ok(ops.map((op) => ({ type: 0, from: op.from, to: op.to, value: hex(op.wei) })));
      }
      case 'eth_getLogs': {
        const filter = (params as [{ fromBlock: string; toBlock: string; topics: (string | null)[] }])[0];
        const lo = Number.parseInt(filter.fromBlock, 16);
        const hi = Number.parseInt(filter.toBlock, 16);
        const [topic0, sender, recipient] = filter.topics;
        const rows = state.logs.filter(
          (l) =>
            topic0 === TRANSFER_TOPIC &&
            l.block >= lo &&
            l.block <= hi &&
            (sender == null || topicAddress(l.from) === sender) &&
            (recipient == null || topicAddress(l.to) === recipient),
        );
        return ok(
          rows.map((l) => ({
            address: l.contract,
            topics: [TRANSFER_TOPIC, topicAddress(l.from), topicAddress(l.to)],
            data: word(l.amount),
            blockNumber: hex(l.block),
            blockHash: hash(0xb10c0000 + l.block),
            transactionHash: l.tx,
            logIndex: hex(l.logIndex),
          })),
        );
      }
      case 'eth_call': {
        const call = (params as [{ to: string; data: string }])[0];
        const token = state.tokens[call.to];
        if (!token) return fail(3, 'execution reverted');
        if (call.data === '0x313ce567') return ok(word(BigInt(token.decimals)));
        if (call.data === '0x95d89b41') return ok(token.symbolReturn ?? abiString(token.symbol));
        return fail(3, 'execution reverted');
      }
      case 'eth_getCode':
        return ok(state.code[(params as string[])[0] ?? ''] ?? '0x');
      case 'eth_getStorageAt':
        return ok(word(0n));
      case 'eth_getBalance':
        return ok(hex(state.balances[(params as string[])[0] ?? ''] ?? 0n));
      case 'eth_getTransactionCount':
        return ok(hex(state.nonces[(params as string[])[0] ?? ''] ?? 0));
      default:
        return fail(-32601, `the method ${method} does not exist`);
    }
  };
}

export const methodsOf = (requests: readonly EgressRequest[]): string[] =>
  requests.map((r) => (JSON.parse(bodyText(r)) as { method: string }).method);

/** Request body as text (the egress port allows bytes; these providers always send a JSON string). */
export const bodyText = (request: EgressRequest): string =>
  typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body);
