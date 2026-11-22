/**
 * Minimal Ethereum JSON-RPC reader for ENS on top of `SourceHttp` (every call is an `EgressClient` POST: allow-listed,
 * rate-limited, logged with `containsIdentifier`, provenance recorded). It talks to the Universal Resolver of the
 * deployment (`ENS_UNIVERSAL_RESOLVER`); no hosted indexer, no CCIP-Read gateways (an `OffchainLookup` revert is
 * reported, never followed) and no avatar fetching. All state reads are pinned to one block.
 */
import type { CaptureStatus, EgressResponse, Id } from '@olcys/core';
import type { SourceHttp } from '../framework/http.ts';
import { NoFixtureError } from '../framework/errors.ts';
import { note, statusFromHttp, type NoteCode } from '../framework/status.ts';
import {
  calldata,
  decodeAddressWord,
  decodeDynamic,
  decodeResolve,
  decodeReverse,
  dnsEncode,
  fromHex,
  namehash,
  toHex,
} from './ens-abi.ts';

export interface EnsBlock {
  number: bigint;
  hash: string;
}

/** Port over the RPC, so the collector logic is testable without a node. */
export interface EnsReader {
  block(): Promise<EnsBlock>;
  primaryName(address: string, blockNumber: bigint): Promise<string | null>;
  /** Coin type 60: the `0x` address; other coin types: the raw bytes as `0x` hex. */
  address(name: string, coinType: number, blockNumber: bigint): Promise<string | null>;
  text(name: string, key: string, blockNumber: bigint): Promise<string | null>;
}

/** An expected transport outcome (blocked, refused, replay miss): the subject ends with this status and notes. */
export class EnsRpcFailure extends Error {
  readonly status: CaptureStatus;
  readonly notes: string[];
  constructor(status: CaptureStatus, notes: string[]) {
    super(notes.join('; '));
    this.name = 'EnsRpcFailure';
    this.status = status;
    this.notes = notes;
  }
}

/** The name or key needs CCIP-Read (EIP-3668) which is disabled. */
export class CcipReadDisabledError extends Error {
  constructor() {
    super('ccip-read disabled');
    this.name = 'CcipReadDisabledError';
  }
}

export interface RpcCall {
  method: string;
  fetchId: Id;
  result: string | null;
}
export interface RpcTrace {
  calls: RpcCall[];
  last?: EgressResponse;
}

const OFFCHAIN_LOOKUP = '0x556f1830';
const RESOLVE_SIGNATURE = 'resolve(bytes,bytes)';
const REVERSE_SIGNATURE = 'reverse(bytes,uint256)';
export const ENS_SELECTORS = {
  reverse: REVERSE_SIGNATURE,
  resolve: RESOLVE_SIGNATURE,
  addr: 'addr(bytes32)',
  addrCoin: 'addr(bytes32,uint256)',
  text: 'text(bytes32,string)',
} as const;

function failure(error: unknown, url: string): EnsRpcFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const fail = (code: NoteCode, detail: string) => new EnsRpcFailure('error', [note(code, detail)]);
  if (error.name === 'EgressDeniedError')
    return new EnsRpcFailure('blocked', [note('allow_list_denied', error.message)]);
  if (error.name === 'ReplayMissError') return fail('replay_miss', error.message);
  if (error.name === 'SyntheticIdentifierError') return fail('synthetic_identifier_refused', url);
  if (error instanceof NoFixtureError) return fail('no_fixture_for_host', error.host);
  if (['TimeoutError', 'AbortError', 'TypeError'].includes(error.name))
    return fail('fetch_error', `${url}: ${error.message}`);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|exceeds \d+ bytes/.test(error.message)) {
    return fail('fetch_error', `${url}: ${error.message}`);
  }
  return undefined;
}

const blockTag = (blockNumber: bigint): string => `0x${blockNumber.toString(16)}`;

export function createRpcEnsReader(args: {
  http: SourceHttp;
  /** Live URL of the JSON-RPC endpoint (mapped to the fixture site offline). */
  rpcUrl: string;
  universalResolver: string;
}): { reader: EnsReader; trace: RpcTrace } {
  const { http, rpcUrl, universalResolver } = args;
  const trace: RpcTrace = { calls: [] };

  async function request(method: string, params: unknown[]): Promise<unknown> {
    const stop = http.stopped();
    if (stop) throw new EnsRpcFailure(stop.status, [note('source_stopped', `${stop.status}: ${stop.reason}`)]);
    let url: string;
    try {
      url = http.requestUrl(rpcUrl);
    } catch (error) {
      const known = failure(error, rpcUrl);
      if (known) throw known;
      throw error;
    }
    if (!http.hostAllowed(url)) {
      throw new EnsRpcFailure('blocked', [
        note('allow_list_denied', `${new URL(url).hostname} is not allowed for ${http.descriptor.id}`),
      ]);
    }
    let response: EgressResponse;
    try {
      response = await http.fetch({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        purpose: `ens ${method}`,
        // The calldata carries the queried address or the DNS-encoded name, which the identifier net cannot see.
        containsIdentifier: true,
        redirect: 'manual',
      });
    } catch (error) {
      const known = failure(error, http.logicalUrl(url));
      if (known) throw known;
      throw error;
    }
    trace.last = response;
    const status = statusFromHttp(response.status);
    if (status !== 'ok') {
      trace.calls.push({ method, fetchId: response.provenance.fetchId, result: null });
      const notes = [note('fetch_error', `${http.logicalUrl(url)}: HTTP ${response.status}`)];
      if (status === 'blocked' || status === 'login_wall') {
        http.stop(status, `HTTP ${response.status}`);
        notes.push(note(status === 'blocked' ? 'barrier_blocked' : 'barrier_login_wall', `HTTP ${response.status}`));
        if (response.status === 429)
          notes.push(note('rate_limited', `retry-after ${response.headers['retry-after'] ?? '?'}`));
        throw new EnsRpcFailure(status, notes);
      }
      throw new EnsRpcFailure('error', notes);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      trace.calls.push({ method, fetchId: response.provenance.fetchId, result: null });
      throw new EnsRpcFailure('error', [note('unrecognised_markup', 'the RPC answer is not JSON')]);
    }
    const object = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const error = object['error'] as { code?: number; message?: string; data?: unknown } | undefined;
    if (error) {
      trace.calls.push({ method, fetchId: response.provenance.fetchId, result: null });
      const data = typeof error.data === 'string' ? error.data.toLowerCase() : '';
      if (data.startsWith(OFFCHAIN_LOOKUP)) throw new CcipReadDisabledError();
      // A revert of the resolver (no resolver, no record) is an answer: the name or record does not exist.
      if (/revert/i.test(error.message ?? '') || error.code === 3) return null;
      throw new EnsRpcFailure('error', [
        note('fetch_error', `RPC error ${error.code ?? '?'}: ${(error.message ?? '').slice(0, 200)}`),
      ]);
    }
    const result = object['result'];
    trace.calls.push({
      method,
      fetchId: response.provenance.fetchId,
      result: typeof result === 'string' ? result : null,
    });
    return result;
  }

  async function call(data: string, blockNumber: bigint): Promise<Uint8Array | null> {
    const result = await request('eth_call', [{ to: universalResolver, data }, blockTag(blockNumber)]);
    if (typeof result !== 'string' || result === '0x') return null;
    try {
      return fromHex(result);
    } catch {
      throw new EnsRpcFailure('error', [note('unrecognised_markup', 'eth_call returned malformed hex')]);
    }
  }
  const resolve = async (name: string, inner: string, blockNumber: bigint): Promise<Uint8Array | null> => {
    const outer = calldata(RESOLVE_SIGNATURE, [
      { type: 'bytes', value: dnsEncode(name) },
      { type: 'bytes', value: fromHex(inner) },
    ]);
    const raw = await call(outer, blockNumber);
    if (!raw) return null;
    try {
      return decodeResolve(raw);
    } catch {
      throw new EnsRpcFailure('error', [note('unrecognised_markup', 'malformed Universal Resolver answer')]);
    }
  };

  const reader: EnsReader = {
    async block() {
      const number = await request('eth_blockNumber', []);
      if (typeof number !== 'string' || !/^0x[0-9a-f]+$/i.test(number)) {
        throw new EnsRpcFailure('error', [note('unrecognised_markup', 'eth_blockNumber returned no block number')]);
      }
      const block = await request('eth_getBlockByNumber', [number, false]);
      const hash = (block as { hash?: unknown } | null)?.hash;
      if (typeof hash !== 'string')
        throw new EnsRpcFailure('error', [note('unrecognised_markup', 'block has no hash')]);
      return { number: BigInt(number), hash };
    },
    async primaryName(address, blockNumber) {
      const raw = await call(
        calldata(REVERSE_SIGNATURE, [
          { type: 'bytes', value: fromHex(address) },
          { type: 'uint', value: 60n },
        ]),
        blockNumber,
      );
      if (!raw) return null;
      try {
        return decodeReverse(raw).name || null;
      } catch {
        throw new EnsRpcFailure('error', [note('unrecognised_markup', 'malformed reverse-resolution answer')]);
      }
    },
    async address(name, coinType, blockNumber) {
      const node = namehash(name);
      const inner =
        coinType === 60
          ? calldata(ENS_SELECTORS.addr, [{ type: 'bytes32', value: node }])
          : calldata(ENS_SELECTORS.addrCoin, [
              { type: 'bytes32', value: node },
              { type: 'uint', value: BigInt(coinType) },
            ]);
      const answer = await resolve(name, inner, blockNumber);
      if (!answer) return null;
      try {
        if (coinType === 60) return decodeAddressWord(answer);
        const bytes = decodeDynamic(answer);
        return bytes.length ? toHex(bytes) : null;
      } catch {
        throw new EnsRpcFailure('error', [note('unrecognised_markup', 'malformed address record')]);
      }
    },
    async text(name, key, blockNumber) {
      const inner = calldata(ENS_SELECTORS.text, [
        { type: 'bytes32', value: namehash(name) },
        { type: 'string', value: key },
      ]);
      const answer = await resolve(name, inner, blockNumber);
      if (!answer) return null;
      try {
        const text = new TextDecoder().decode(decodeDynamic(answer));
        return text || null;
      } catch {
        throw new EnsRpcFailure('error', [note('unrecognised_markup', 'malformed text record')]);
      }
    },
  };
  return { reader, trace };
}
