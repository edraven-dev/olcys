/**
 * Chain identifiers.
 *
 * Internal ids are short and stable. EVM networks share one address format, so they are written as
 * `evm:<chainId>`; an EVM address whose network could not be attributed uses `evm:unknown`
 * (see the chain-attribution cascade in packages/address-extractor). `caip2` is filled in only where the
 * CAIP-2 id is well established.
 */
export const CHAIN_FAMILIES = [
  'bitcoin',
  'litecoin',
  'dogecoin',
  'bitcoincash',
  'evm',
  'tron',
  'solana',
  'xrp',
  'monero',
  'cardano',
  'ton',
  'lightning',
] as const;
export type ChainFamily = (typeof CHAIN_FAMILIES)[number];

export type EvmChainId = `evm:${number}` | 'evm:unknown';
export type ChainId = Exclude<ChainFamily, 'evm'> | EvmChainId;

export interface ChainInfo {
  id: ChainId;
  family: ChainFamily;
  name: string;
  nativeAsset: string;
  decimals: number;
  caip2?: string;
}

export const KNOWN_CHAINS: readonly ChainInfo[] = [
  {
    id: 'bitcoin',
    family: 'bitcoin',
    name: 'Bitcoin',
    nativeAsset: 'BTC',
    decimals: 8,
    caip2: 'bip122:000000000019d6689c085ae165831e93',
  },
  {
    id: 'litecoin',
    family: 'litecoin',
    name: 'Litecoin',
    nativeAsset: 'LTC',
    decimals: 8,
    caip2: 'bip122:12a765e31ffd4059bada1e25190f6e98',
  },
  {
    id: 'dogecoin',
    family: 'dogecoin',
    name: 'Dogecoin',
    nativeAsset: 'DOGE',
    decimals: 8,
    caip2: 'bip122:1a91e3dace36e2be3bf030a65679fe82',
  },
  {
    id: 'bitcoincash',
    family: 'bitcoincash',
    name: 'Bitcoin Cash',
    nativeAsset: 'BCH',
    decimals: 8,
    caip2: 'bip122:000000000000000000651ef99cb9fcbe',
  },
  { id: 'evm:1', family: 'evm', name: 'Ethereum', nativeAsset: 'ETH', decimals: 18, caip2: 'eip155:1' },
  { id: 'evm:10', family: 'evm', name: 'OP Mainnet', nativeAsset: 'ETH', decimals: 18, caip2: 'eip155:10' },
  { id: 'evm:56', family: 'evm', name: 'BNB Smart Chain', nativeAsset: 'BNB', decimals: 18, caip2: 'eip155:56' },
  { id: 'evm:100', family: 'evm', name: 'Gnosis', nativeAsset: 'xDAI', decimals: 18, caip2: 'eip155:100' },
  { id: 'evm:137', family: 'evm', name: 'Polygon PoS', nativeAsset: 'POL', decimals: 18, caip2: 'eip155:137' },
  { id: 'evm:8453', family: 'evm', name: 'Base', nativeAsset: 'ETH', decimals: 18, caip2: 'eip155:8453' },
  { id: 'evm:42161', family: 'evm', name: 'Arbitrum One', nativeAsset: 'ETH', decimals: 18, caip2: 'eip155:42161' },
  { id: 'evm:59144', family: 'evm', name: 'Linea', nativeAsset: 'ETH', decimals: 18, caip2: 'eip155:59144' },
  { id: 'evm:unknown', family: 'evm', name: 'EVM (network unknown)', nativeAsset: 'ETH', decimals: 18 },
  { id: 'tron', family: 'tron', name: 'TRON', nativeAsset: 'TRX', decimals: 6 },
  {
    id: 'solana',
    family: 'solana',
    name: 'Solana',
    nativeAsset: 'SOL',
    decimals: 9,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  },
  { id: 'xrp', family: 'xrp', name: 'XRP Ledger', nativeAsset: 'XRP', decimals: 6 },
  { id: 'monero', family: 'monero', name: 'Monero', nativeAsset: 'XMR', decimals: 12 },
  { id: 'cardano', family: 'cardano', name: 'Cardano', nativeAsset: 'ADA', decimals: 6 },
  { id: 'ton', family: 'ton', name: 'TON', nativeAsset: 'TON', decimals: 9 },
  { id: 'lightning', family: 'lightning', name: 'Lightning Network', nativeAsset: 'BTC', decimals: 11 },
];

export function chainFamily(chain: ChainId): ChainFamily {
  return chain.startsWith('evm:') ? 'evm' : (chain as ChainFamily);
}

/**
 * A blockchain address in canonical form: EVM lower-case hex (display with EIP-55), bech32/bech32m
 * lower-case, base58 and other encodings exactly as decoded. Canonicalisation is performed by the address extractor.
 */
export interface AddressRef {
  chain: ChainId;
  address: string;
}

/** Stable key for maps, joins and diffing: `<chain>:<address>`. */
export function addressKey(ref: AddressRef): string {
  return `${ref.chain}:${ref.address}`;
}
