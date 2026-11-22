/** NIP-05 identifiers and the Nostr key encodings (`npub`, NIP-19); pure, no I/O. */
import { bech32, hex } from '@scure/base';

export interface Nip05 {
  name: string;
  domain: string;
}

const NAME = /^[a-z0-9._-]+$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `name@domain` (name lower-cased, `_@domain` is the root id); undefined for anything else, a plain e-mail included. */
export function parseNip05(identifier: string): Nip05 | undefined {
  const text = identifier.trim().toLowerCase();
  const at = text.indexOf('@');
  if (at < 1 || text.indexOf('@', at + 1) >= 0) return undefined;
  const name = text.slice(0, at);
  const domain = text.slice(at + 1);
  return NAME.test(name) && DOMAIN.test(domain) ? { name, domain } : undefined;
}

export function npubEncode(hexPubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(hexPubkey)) throw new Error('not a 64-character lower-case hex public key');
  return bech32.encode('npub', bech32.toWords(hex.decode(hexPubkey)), 1000);
}

/** Throws on a bad checksum, a wrong prefix or a wrong length. */
export function npubDecode(npub: string): string {
  const { prefix, words } = bech32.decode(npub.trim().toLowerCase() as `${string}1${string}`, 1000);
  const bytes = bech32.fromWords(words);
  if (prefix !== 'npub' || bytes.length !== 32) throw new Error('not an npub');
  return hex.encode(bytes);
}
