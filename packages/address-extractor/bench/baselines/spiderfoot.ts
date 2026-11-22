/**
 * Baseline: the address detection of SpiderFoot's `sfp_bitcoin` and `sfp_ethereum` modules, re-implemented for the
 * benchmark only (never used by the pipeline). Same regular expressions, the same base58 check (`check_bc`: decode
 * to 25 bytes, compare the double-SHA-256 checksum, no version check; bech32 matches are accepted unvalidated,
 * Ethereum matches have no EIP-55 check and no right boundary) and the same input: the raw document text.
 *
 * SpiderFoot — https://github.com/smicallef/spiderfoot — is licensed under the MIT License:
 *
 *   Copyright (c) 2012-2022 Steve Micallef
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 *   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or substantial portions
 *   of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 *   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 *   IN THE SOFTWARE.
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const SPIDERFOOT_VERSION = 'spiderfoot-4.0-regex';

/** Python's Unicode `\s` (SpiderFoot runs `re.findall` on str); unlike JavaScript's `\s` it excludes U+FEFF. */
const PY_SPACE = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
/** `sfp_bitcoin`: `[\s:=\>](bc(0([ac-hj-np-z02-9]{39}|[ac-hj-np-z02-9]{59})|1[ac-hj-np-z02-9]{8,87})|[13][a-km-zA-HJ-NP-Z1-9]{25,35})` */
const BITCOIN = new RegExp(
  `[${PY_SPACE}:=>](bc(0([ac-hj-np-z02-9]{39}|[ac-hj-np-z02-9]{59})|1[ac-hj-np-z02-9]{8,87})|[13][a-km-zA-HJ-NP-Z1-9]{25,35})`,
  'g',
);
/** `sfp_ethereum`: `[\s:=\>](0x[a-fA-F0-9]{40})` */
const ETHEREUM = new RegExp(`[${PY_SPACE}:=>](0x[a-fA-F0-9]{40})`, 'g');
const DIGITS58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** `decode_base58(bc, 25)`: the number as big-endian bytes, left-padded to 25 bytes (longer values keep their length). */
function decodeBase58(value: string, length: number): Uint8Array {
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(DIGITS58.indexOf(char));
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  hex = hex.padStart(length * 2, '0');
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}

/** `check_bc`: the last four bytes equal the double-SHA-256 checksum of the rest. */
export function checkBc(value: string): boolean {
  const bytes = decodeBase58(value, 25);
  const checksum = sha256(sha256(bytes.subarray(0, bytes.length - 4)));
  return bytes.subarray(bytes.length - 4).every((b, i) => b === checksum[i]);
}

export interface BaselineMatch {
  chain: 'bitcoin' | 'evm:unknown';
  value: string;
  start: number;
  end: number;
}

/** Every match the two modules would emit, with its offset in the scanned text. */
export function spiderfootScan(content: string): BaselineMatch[] {
  const out: BaselineMatch[] = [];
  for (const m of content.matchAll(BITCOIN)) {
    const address = m[1] ?? '';
    const start = m.index + 1;
    if ((address.startsWith('1') || address.startsWith('3')) && !checkBc(address)) continue;
    out.push({ chain: 'bitcoin', value: address, start, end: start + address.length });
  }
  for (const m of content.matchAll(ETHEREUM)) {
    const address = m[1] ?? '';
    const start = m.index + 1;
    out.push({ chain: 'evm:unknown', value: address, start, end: start + address.length });
  }
  return out;
}
