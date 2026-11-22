/**
 * The small part of ABI encoding, DNS wire names and namehash that the ENS reader needs. Pure functions over bytes;
 * selectors are derived from the signatures with Keccak-256 (nothing is hard-coded).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hex } from '@scure/base';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const toHex = (bytes: Uint8Array): string => `0x${hex.encode(bytes)}`;
export function fromHex(value: string): Uint8Array {
  const clean = value.replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('invalid hex');
  return hex.decode(clean.toLowerCase());
}

export const selector = (signature: string): Uint8Array => keccak_256(utf8(signature)).subarray(0, 4);

/** ENSIP-1 namehash of an already normalised name. */
export function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32);
  if (name === '') return node;
  for (const label of name.split('.').toReversed()) {
    node = keccak_256(Uint8Array.of(...node, ...keccak_256(utf8(label))));
  }
  return node;
}

/** DNS wire format of a normalised name (labels of at most 255 bytes, terminating zero). */
export function dnsEncode(name: string): Uint8Array {
  const out: number[] = [];
  for (const label of name.split('.')) {
    const bytes = utf8(label);
    if (bytes.length === 0 || bytes.length > 255) throw new Error('invalid label length');
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return Uint8Array.from(out);
}

export type AbiValue =
  | { type: 'bytes'; value: Uint8Array }
  | { type: 'string'; value: string }
  | { type: 'uint'; value: bigint }
  | { type: 'bytes32'; value: Uint8Array }
  | { type: 'address'; value: Uint8Array };

const word = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};
const padRight = (bytes: Uint8Array): Uint8Array => {
  const length = Math.ceil(bytes.length / 32) * 32;
  const out = new Uint8Array(length);
  out.set(bytes);
  return out;
};
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** ABI-encodes a tuple of static (`uint`, `bytes32`, `address`) and dynamic (`bytes`, `string`) values. */
export function abiEncode(values: readonly AbiValue[]): Uint8Array {
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  const headSize = values.length * 32;
  let tailSize = 0;
  for (const v of values) {
    if (v.type === 'uint') head.push(word(v.value));
    else if (v.type === 'bytes32') head.push(v.value);
    else if (v.type === 'address') head.push(concat([new Uint8Array(12), v.value]));
    else {
      const bytes = v.type === 'string' ? utf8(v.value) : v.value;
      head.push(word(BigInt(headSize + tailSize)));
      const encoded = concat([word(BigInt(bytes.length)), padRight(bytes)]);
      tail.push(encoded);
      tailSize += encoded.length;
    }
  }
  return concat([...head, ...tail]);
}

export function calldata(signature: string, values: readonly AbiValue[]): string {
  return toHex(concat([selector(signature), abiEncode(values)]));
}

const slot = (data: Uint8Array, index: number): Uint8Array => {
  const start = index * 32;
  if (data.length < start + 32) throw new Error('ABI data too short');
  return data.subarray(start, start + 32);
};
const toBig = (bytes: Uint8Array): bigint => BigInt(`0x${hex.encode(bytes) || '0'}`);

function dynamicAt(data: Uint8Array, headIndex: number): Uint8Array {
  const offset = Number(toBig(slot(data, headIndex)));
  if (!Number.isSafeInteger(offset) || offset + 32 > data.length) throw new Error('ABI offset out of range');
  const length = Number(toBig(data.subarray(offset, offset + 32)));
  if (!Number.isSafeInteger(length) || offset + 32 + length > data.length) throw new Error('ABI length out of range');
  return data.subarray(offset + 32, offset + 32 + length);
}

/** Return data `(string, address, address)` of `reverse(bytes,uint256)`. */
export function decodeReverse(data: Uint8Array): { name: string } {
  return { name: new TextDecoder().decode(dynamicAt(data, 0)) };
}
/** Return data `(bytes, address)` of `resolve(bytes,bytes)`: the inner answer. */
export function decodeResolve(data: Uint8Array): Uint8Array {
  return dynamicAt(data, 0);
}
/** EIP-55 mixed-case form of a 20-byte address. */
export function checksumAddress(bytes: Uint8Array): string {
  const lower = hex.encode(bytes);
  const digest = hex.encode(keccak_256(utf8(lower)));
  return `0x${[...lower].map((ch, i) => (Number.parseInt(digest[i] ?? '0', 16) >= 8 ? ch.toUpperCase() : ch)).join('')}`;
}

/** Inner answer of `addr(bytes32)`: one 32-byte word holding the address. */
export function decodeAddressWord(data: Uint8Array): string | null {
  const bytes = slot(data, 0).subarray(12);
  return bytes.every((b) => b === 0) ? null : checksumAddress(bytes);
}
/** Inner answer of `addr(bytes32,uint256)`, `text(bytes32,string)`: one dynamic `bytes` / `string`. */
export function decodeDynamic(data: Uint8Array): Uint8Array {
  return dynamicAt(data, 0);
}
