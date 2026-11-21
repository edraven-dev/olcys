/**
 * Explicit chain markers in the text: payment URIs (BIP-21, EIP-681), CAIP-10, EIP-3770 prefixes and block-explorer
 * links. Purely lexical: no DNS, no explorer calls.
 */
import { KNOWN_CHAINS, type ChainId } from '@olcys/core';
import type { NormalisedText, PaymentContext, ViewText } from '../pipeline-types.ts';

export const URI_RULES_VERSION = 'uri.v1';

const BIP21 =
  /(?<![A-Za-z0-9+.-])(bitcoin|litecoin|dogecoin|bitcoincash):(?:\/\/)?([A-Za-z0-9]{8,120})(\?[^\s"'<>]*)?/gi;
const BIP21_CHAINS: Record<string, ChainId> = {
  bitcoin: 'bitcoin',
  litecoin: 'litecoin',
  dogecoin: 'dogecoin',
  bitcoincash: 'bitcoincash',
};
const EIP681 =
  /(?<![A-Za-z0-9+.-])ethereum:(pay-)?(0x[0-9a-fA-F]{40}|[^\s@/?#"'<>]+)(?:@(\d{1,20}))?(?:\/([A-Za-z_]\w*))?(\?[^\s"'<>]*)?/gi;
const CAIP10_EIP155 = /(?<![A-Za-z0-9:])eip155:([1-9]\d{0,19}):(0x[0-9a-fA-F]{40})(?![0-9A-Za-z])/g;
const CAIP10_BIP122 = /(?<![A-Za-z0-9:])bip122:([0-9a-f]{32}):([A-Za-z0-9]{14,90})(?![0-9A-Za-z])/g;
const EIP3770 = /(?<![A-Za-z0-9:_-])(eth|oeth|bnb|gno|matic|pol|base|arb1|linea):(0x[0-9a-fA-F]{40})(?![0-9A-Za-z])/g;
const EIP3770_CHAINS: Record<string, ChainId> = {
  eth: 'evm:1',
  oeth: 'evm:10',
  bnb: 'evm:56',
  gno: 'evm:100',
  matic: 'evm:137',
  pol: 'evm:137',
  base: 'evm:8453',
  arb1: 'evm:42161',
  linea: 'evm:59144',
};

interface ExplorerRule {
  host: string;
  /** Path (with fragment) prefix that precedes the address. */
  prefix: string;
  chain: ChainId;
}

/** Explorer address pages → chain (subdomains are exact). Transaction pages (`/tx/`) annotate nothing. */
export const EXPLORERS: readonly ExplorerRule[] = [
  { host: 'etherscan.io', prefix: '/address/', chain: 'evm:1' },
  { host: 'optimistic.etherscan.io', prefix: '/address/', chain: 'evm:10' },
  { host: 'bscscan.com', prefix: '/address/', chain: 'evm:56' },
  { host: 'gnosisscan.io', prefix: '/address/', chain: 'evm:100' },
  { host: 'polygonscan.com', prefix: '/address/', chain: 'evm:137' },
  { host: 'basescan.org', prefix: '/address/', chain: 'evm:8453' },
  { host: 'arbiscan.io', prefix: '/address/', chain: 'evm:42161' },
  { host: 'lineascan.build', prefix: '/address/', chain: 'evm:59144' },
  { host: 'eth.blockscout.com', prefix: '/address/', chain: 'evm:1' },
  { host: 'optimism.blockscout.com', prefix: '/address/', chain: 'evm:10' },
  { host: 'gnosis.blockscout.com', prefix: '/address/', chain: 'evm:100' },
  { host: 'polygon.blockscout.com', prefix: '/address/', chain: 'evm:137' },
  { host: 'base.blockscout.com', prefix: '/address/', chain: 'evm:8453' },
  { host: 'arbitrum.blockscout.com', prefix: '/address/', chain: 'evm:42161' },
  { host: 'mempool.space', prefix: '/address/', chain: 'bitcoin' },
  { host: 'blockstream.info', prefix: '/address/', chain: 'bitcoin' },
  { host: 'blockchair.com', prefix: '/bitcoin/address/', chain: 'bitcoin' },
  { host: 'blockchair.com', prefix: '/bitcoin-cash/address/', chain: 'bitcoincash' },
  { host: 'blockchair.com', prefix: '/litecoin/address/', chain: 'litecoin' },
  { host: 'blockchair.com', prefix: '/dogecoin/address/', chain: 'dogecoin' },
  { host: 'blockchair.com', prefix: '/ethereum/address/', chain: 'evm:1' },
  { host: 'blockchair.com', prefix: '/tron/address/', chain: 'tron' },
  { host: 'blockchair.com', prefix: '/cardano/address/', chain: 'cardano' },
  { host: 'blockchair.com', prefix: '/ripple/account/', chain: 'xrp' },
  { host: 'tronscan.org', prefix: '/#/address/', chain: 'tron' },
  { host: 'solscan.io', prefix: '/account/', chain: 'solana' },
  { host: 'explorer.solana.com', prefix: '/address/', chain: 'solana' },
  { host: 'xrpscan.com', prefix: '/account/', chain: 'xrp' },
  { host: 'livenet.xrpl.org', prefix: '/accounts/', chain: 'xrp' },
  { host: 'tonviewer.com', prefix: '/', chain: 'ton' },
  { host: 'tonscan.org', prefix: '/address/', chain: 'ton' },
  { host: 'cardanoscan.io', prefix: '/address/', chain: 'cardano' },
  { host: 'litecoinspace.org', prefix: '/address/', chain: 'litecoin' },
  { host: 'dogechain.info', prefix: '/address/', chain: 'dogecoin' },
];
const EXPLORER_HOSTS = [...new Set(EXPLORERS.map((e) => e.host))].toSorted((a, b) => b.length - a.length);
const EXPLORER_URL = new RegExp(
  `(?<![A-Za-z0-9.@-])(?:https?://)?(?:www\\.)?(${EXPLORER_HOSTS.map((h) => h.replaceAll('.', '\\.')).join('|')})(/[^\\s"'<>]*)`,
  'gi',
);
const ADDRESS_TOKEN = /^[A-Za-z0-9_-]+/;

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return value;
  }
}

/** Parses `?a=1&b=2`; returns the decoded values and the offsets of the raw values relative to the query start. */
function parseQuery(query: string | undefined): { params: Record<string, string>; offsets: Record<string, number> } {
  const params: Record<string, string> = {};
  const offsets: Record<string, number> = {};
  if (!query) return { params, offsets };
  let position = 1;
  for (const part of query.slice(1).split('&')) {
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    if (key && !(key in params)) {
      params[key] = decodeParam(eq < 0 ? '' : part.slice(eq + 1));
      offsets[key] = position + (eq < 0 ? part.length : eq + 1);
    }
    position += part.length + 1;
  }
  return { params, offsets };
}

function bip122Chain(genesis: string): ChainId | undefined {
  return KNOWN_CHAINS.find((c) => c.caip2 === `bip122:${genesis.toLowerCase()}`)?.id;
}

/** Finds payment contexts in a text (normalised coordinates). */
export function findContextsInText(text: string): PaymentContext[] {
  const contexts: PaymentContext[] = [];

  for (const m of text.matchAll(BIP21)) {
    const scheme = (m[1] ?? '').toLowerCase();
    const target = m[2] ?? '';
    const targetStart = m.index + m[0].indexOf(target, scheme.length + 1);
    const chainId = BIP21_CHAINS[scheme];
    contexts.push({
      kind: 'uri',
      scheme,
      ...(chainId ? { chainId } : {}),
      role: 'recipient',
      params: parseQuery(m[3]).params,
      range: { nStart: m.index, nEnd: m.index + m[0].length },
      target: { nStart: targetStart, nEnd: targetStart + target.length },
    });
  }

  for (const m of text.matchAll(EIP681)) {
    const target = m[2] ?? '';
    const targetStart = m.index + 'ethereum:'.length + (m[1]?.length ?? 0);
    const chainIdText = m[3];
    const chainId: ChainId | undefined = chainIdText ? `evm:${Number(chainIdText)}` : undefined;
    const fn = m[4]?.toLowerCase();
    const query = m[5];
    const { params, offsets } = parseQuery(query);
    const range = { nStart: m.index, nEnd: m.index + m[0].length };
    const base = { kind: 'uri' as const, scheme: 'ethereum', ...(chainId ? { chainId } : {}), params, range };
    if (fn === 'transfer') {
      contexts.push({
        ...base,
        role: 'token_contract',
        target: { nStart: targetStart, nEnd: targetStart + target.length },
      });
      const recipient = params['address'];
      const offset = offsets['address'];
      if (recipient && offset !== undefined && query) {
        const queryStart = m.index + m[0].length - query.length;
        const rawValue = /^[^&#]*/.exec(query.slice(offset))?.[0] ?? '';
        contexts.push({
          ...base,
          role: 'recipient',
          target: { nStart: queryStart + offset, nEnd: queryStart + offset + rawValue.length },
        });
      }
    } else {
      contexts.push({ ...base, role: 'recipient', target: { nStart: targetStart, nEnd: targetStart + target.length } });
    }
  }

  for (const m of text.matchAll(CAIP10_EIP155)) {
    const address = m[2] ?? '';
    const nEnd = m.index + m[0].length;
    contexts.push({
      kind: 'caip10',
      scheme: 'eip155',
      chainId: `evm:${Number(m[1])}`,
      role: 'account',
      params: {},
      range: { nStart: m.index, nEnd },
      target: { nStart: nEnd - address.length, nEnd },
    });
  }

  for (const m of text.matchAll(CAIP10_BIP122)) {
    const chainId = bip122Chain(m[1] ?? '');
    const address = m[2] ?? '';
    const nEnd = m.index + m[0].length;
    contexts.push({
      kind: 'caip10',
      scheme: 'bip122',
      ...(chainId ? { chainId } : {}),
      role: 'account',
      params: {},
      range: { nStart: m.index, nEnd },
      target: { nStart: nEnd - address.length, nEnd },
    });
  }

  for (const m of text.matchAll(EIP3770)) {
    const address = m[2] ?? '';
    const nEnd = m.index + m[0].length;
    const chainId = EIP3770_CHAINS[m[1] ?? ''];
    contexts.push({
      kind: 'eip3770',
      scheme: m[1] ?? '',
      ...(chainId ? { chainId } : {}),
      role: 'account',
      params: {},
      range: { nStart: m.index, nEnd },
      target: { nStart: nEnd - address.length, nEnd },
    });
  }

  for (const m of text.matchAll(EXPLORER_URL)) {
    const host = (m[1] ?? '').toLowerCase();
    const path = m[2] ?? '';
    const pathStart = m.index + m[0].length - path.length;
    for (const rule of EXPLORERS) {
      if (rule.host !== host || !path.startsWith(rule.prefix)) continue;
      const address = ADDRESS_TOKEN.exec(path.slice(rule.prefix.length))?.[0];
      if (!address) continue;
      const targetStart = pathStart + rule.prefix.length;
      contexts.push({
        kind: 'explorer',
        host,
        chainId: rule.chain,
        role: 'account',
        params: {},
        range: { nStart: m.index, nEnd: m.index + m[0].length },
        target: { nStart: targetStart, nEnd: targetStart + address.length },
      });
      break;
    }
  }

  return contexts.toSorted((a, b) => a.range.nStart - b.range.nStart);
}

/** Payment URIs, CAIP-10 / EIP-3770 prefixes and explorer links of one normalised view. */
export function findPaymentContexts(_view: ViewText, norm: NormalisedText): PaymentContext[] {
  return findContextsInText(norm.text);
}
