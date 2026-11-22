/** Readers of the Snapchain HTTP API answers (Hubble-compatible); every field is read defensively. */
import { asArray, asObject, asText, type Json } from '../registries/common.ts';
import { decodeHubBytes, farcasterTimeToIso, solanaAddress, verifyEthClaim } from './claim.ts';

export type ClaimCheck = 'valid' | 'invalid' | 'unverifiable_contract' | 'unverifiable_solana';

export interface FarcasterVerification {
  chain: 'evm:1' | 'solana';
  /** Lower-case 0x hex (EVM) or base58 (Solana). */
  address: string;
  addedAt?: string;
  messageHash?: string;
  check: ClaimCheck;
}

export interface FarcasterUserData {
  type: string;
  value: string;
}

const USER_DATA_NAMES: Readonly<Record<string, string>> = {
  '1': 'pfp',
  '2': 'display_name',
  '3': 'bio',
  '5': 'url',
  '6': 'username',
  '7': 'location',
  '8': 'twitter',
  '9': 'github',
  '11': 'primary_eth_address',
  '12': 'primary_sol_address',
  USER_DATA_TYPE_PFP: 'pfp',
  USER_DATA_TYPE_DISPLAY: 'display_name',
  USER_DATA_TYPE_BIO: 'bio',
  USER_DATA_TYPE_URL: 'url',
  USER_DATA_TYPE_USERNAME: 'username',
  USER_DATA_TYPE_LOCATION: 'location',
  USER_DATA_TYPE_TWITTER: 'twitter',
  USER_DATA_TYPE_GITHUB: 'github',
  USER_DATA_PRIMARY_ADDRESS_ETHEREUM: 'primary_eth_address',
  USER_DATA_PRIMARY_ADDRESS_SOLANA: 'primary_sol_address',
};

export function parseUserNameProof(json: unknown): { fid: string; name?: string; owner?: string } | undefined {
  const root = asObject(json);
  const fid = asText(root?.['fid']);
  if (!root || !fid || !/^\d+$/.test(fid)) return undefined;
  const name = asText(root['name']);
  const ownerRaw = asText(root['owner']);
  let owner: string | undefined;
  try {
    owner = ownerRaw
      ? `0x${[...decodeHubBytes(ownerRaw)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
      : undefined;
  } catch {
    owner = undefined;
  }
  return { fid, ...(name ? { name } : {}), ...(owner && owner.length === 42 ? { owner } : {}) };
}

export function parseUserData(json: unknown): FarcasterUserData[] {
  const out: FarcasterUserData[] = [];
  for (const message of asArray(asObject(json)?.['messages'])) {
    const body = asObject(asObject(asObject(message)?.['data'])?.['userDataBody']);
    const type = USER_DATA_NAMES[asText(body?.['type']) ?? ''];
    const value = asText(body?.['value']);
    if (type && value) out.push({ type, value });
  }
  return out;
}

const bytes = (value: unknown): Uint8Array | undefined => {
  const text = asText(value);
  if (!text) return undefined;
  try {
    return decodeHubBytes(text);
  } catch {
    return undefined;
  }
};

const hexOf = (data: Uint8Array): string => [...data].map((b) => b.toString(16).padStart(2, '0')).join('');

export function parseVerifications(json: unknown): { items: FarcasterVerification[]; nextPageToken?: string } {
  const root = asObject(json);
  const items: FarcasterVerification[] = [];
  for (const message of asArray(root?.['messages'])) {
    const m = asObject(message);
    const data: Json | undefined = asObject(m?.['data']);
    const body = asObject(data?.['verificationAddAddressBody']) ?? asObject(data?.['verificationAddEthAddressBody']);
    if (!m || !data || !body) continue;
    const address = bytes(body['address']);
    if (!address) continue;
    const protocol = asText(body['protocol']);
    const timestamp = typeof data['timestamp'] === 'number' ? data['timestamp'] : undefined;
    const common = {
      ...(timestamp === undefined ? {} : { addedAt: farcasterTimeToIso(timestamp) }),
      ...(asText(m['hash']) ? { messageHash: asText(m['hash']) as string } : {}),
    };
    if (protocol === 'PROTOCOL_SOLANA' || protocol === '1' || address.length === 32) {
      items.push({ chain: 'solana', address: solanaAddress(address), check: 'unverifiable_solana', ...common });
      continue;
    }
    if (address.length !== 20) continue;
    const verificationType = asText(body['verificationType']) ?? asText(body['type']);
    const chainId = asText(body['chainId']);
    const contract =
      verificationType === '1' || verificationType === 'VERIFICATION_TYPE_CONTRACT' || (!!chainId && chainId !== '0');
    const blockHash = bytes(body['blockHash']);
    const signature = bytes(body['claimSignature']);
    const fid = asText(data['fid']);
    let check: ClaimCheck = 'invalid';
    if (contract) check = 'unverifiable_contract';
    else if (blockHash && signature && fid && /^\d+$/.test(fid)) {
      const network = asText(data['network']);
      const networkNumber = network === 'FARCASTER_NETWORK_MAINNET' || network === undefined ? 1 : Number(network);
      check = verifyEthClaim({ fid: BigInt(fid), address, blockHash, network: networkNumber }, signature)
        ? 'valid'
        : 'invalid';
    }
    items.push({ chain: 'evm:1', address: `0x${hexOf(address)}`, check, ...common });
  }
  const next = asText(root?.['nextPageToken']);
  return { items, ...(next ? { nextPageToken: next } : {}) };
}
