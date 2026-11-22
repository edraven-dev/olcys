/**
 * Synthetic answers of three more lookups in their real shapes: a Farcaster/Snapchain node (verified addresses), a
 * NIP-05 domain (Nostr) and a Solana JSON-RPC node. Like the other identity lookups they know a synthetic test
 * identity only; the demo persona is unknown to all three, so its outcome stays as it is. Keys are derived from the
 * manifest seed (synthetic, no value), so `--render-only` reproduces every byte.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { base58, base64, hex } from '@scure/base';
import { derive, SYNTHETIC_MARK, type FixtureRouteOut, type GeneratedFile } from './chain.ts';

export const MORE_IDENTITY = {
  fname: 'olcys-test-marek',
  fid: 999_999_998,
  nip05: 'olcys_test_nostr@nostr.example.org',
  nip05Name: 'olcys_test_nostr',
  relay: 'wss://relay.example.org',
  github: 'olcys-test-marek',
} as const;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const mark = <T extends object>(value: T): T & { _synthetic: string } => ({ _synthetic: SYNTHETIC_MARK, ...value });
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const word = (n: bigint): Uint8Array => hex.decode(n.toString(16).padStart(64, '0'));

/** EIP-712 digest of a Farcaster `VerificationClaim` (domain "Farcaster Verify Ethereum Address" 2.0.0). */
function claimDigest(fid: bigint, address: Uint8Array, blockHash: Uint8Array): Uint8Array {
  const domain = keccak_256(
    concat(
      keccak_256(utf8('EIP712Domain(string name,string version,bytes32 salt)')),
      keccak_256(utf8('Farcaster Verify Ethereum Address')),
      keccak_256(utf8('2.0.0')),
      hex.decode('f2d857f4a3edcb9b78b4d503bfe733db1e3f6cdc2b7971ee739626c97e86a558'),
    ),
  );
  const struct = keccak_256(
    concat(
      keccak_256(utf8('VerificationClaim(uint256 fid,address address,bytes32 blockHash,uint8 network)')),
      word(fid),
      concat(new Uint8Array(12), address),
      blockHash,
      word(1n),
    ),
  );
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), domain, struct));
}

const bytesOf = (seed: string, label: string, length: number): Uint8Array =>
  hex.decode(derive(seed, `adapters2:${label}`)).subarray(0, length);

export interface MoreIdentity {
  /** Lower-case 0x address of the Farcaster-verified Ethereum key. */
  eth: string;
  /** Solana address (base58) verified on Farcaster. */
  farcasterSol: string;
  nostrPubkey: string;
  /** Solana addresses of the RPC story. */
  sol: { subject: string; counterparty: string; tokenSubject: string; tokenCounterparty: string };
}

export function moreIdentity(seed: string): MoreIdentity {
  const key = bytesOf(seed, 'farcaster-key', 32);
  const eth = hex.encode(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(-20));
  return {
    eth: `0x${eth}`,
    farcasterSol: base58.encode(bytesOf(seed, 'farcaster-sol', 32)),
    nostrPubkey: hex.encode(bytesOf(seed, 'nostr-key', 32)),
    sol: {
      subject: base58.encode(bytesOf(seed, 'sol-subject', 32)),
      counterparty: base58.encode(bytesOf(seed, 'sol-counterparty', 32)),
      tokenSubject: base58.encode(bytesOf(seed, 'sol-token-subject', 32)),
      tokenCounterparty: base58.encode(bytesOf(seed, 'sol-token-counterparty', 32)),
    },
  };
}

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const nf = (what: string) => ({ errCode: 'not_found', presentable: `${what} not found`, name: 'not_found' });
const rpc = (result: unknown) => ({ jsonrpc: '2.0', id: 1, result });
const rpcError = (code: number, text: string) => ({ jsonrpc: '2.0', id: 1, error: { code, message: text } });
const system = (source: string, destination: string, lamports: number) => ({
  program: 'system',
  programId: '11111111111111111111111111111111',
  parsed: { type: 'transfer', info: { source, destination, lamports } },
});
const splChecked = (source: string, destination: string, authority: string, amount: string) => ({
  program: 'spl-token',
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  parsed: {
    type: 'transferChecked',
    info: {
      source,
      destination,
      authority,
      mint: USDC_MINT,
      tokenAmount: { amount, decimals: 6 },
    },
  },
});

export function moreIdentityFixtures(seed: string): { files: GeneratedFile[]; routes: FixtureRouteOut[] } {
  const a = moreIdentity(seed);
  const files: GeneratedFile[] = [];
  const routes: FixtureRouteOut[] = [];
  const file = (path: string, value: unknown): string => {
    files.push({ path, content: json(mark(value as object)) });
    return path;
  };
  const { fname, fid } = MORE_IDENTITY;

  // --- Farcaster (haatz.quilibrium.com → /farcaster-hub) ----------------------------------------------------------
  const hub = '/farcaster-hub/v1';
  const key = bytesOf(seed, 'farcaster-key', 32);
  const blockHash = bytesOf(seed, 'farcaster-block', 32);
  const ethBytes = hex.decode(a.eth.slice(2));
  const signed = secp256k1.sign(claimDigest(BigInt(fid), ethBytes, blockHash), key, {
    prehash: false,
    format: 'recovered',
  });
  const claimSignature = concat(signed.subarray(1), Uint8Array.of(27 + (signed[0] ?? 0)));
  const message = (body: Record<string, unknown>, label: string) => ({
    data: {
      type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS',
      fid,
      timestamp: 131_000_000,
      network: 'FARCASTER_NETWORK_MAINNET',
      ...body,
    },
    hash: `0x${derive(seed, `adapters2:hash:${label}`).slice(0, 40)}`,
    hashScheme: 'HASH_SCHEME_BLAKE3',
    signature: base64.encode(bytesOf(seed, `sig:${label}`, 64)),
    signatureScheme: 'SIGNATURE_SCHEME_ED25519',
    signer: `0x${derive(seed, 'adapters2:signer')}`,
  });
  const userData = (type: string, value: string) => ({
    data: { type: 'MESSAGE_TYPE_USER_DATA_ADD', fid, timestamp: 130_000_000, userDataBody: { type, value } },
  });
  routes.push(
    {
      path: `${hub}/userNameProofByName`,
      params: { name: fname },
      headers: JSON_TYPE,
      file: file('farcaster-hub/username-proof.json', {
        timestamp: 130_000_000,
        name: fname,
        owner: `0x${bytesOf(seed, 'farcaster-custody', 20).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}`,
        signature: base64.encode(bytesOf(seed, 'sig:proof', 65)),
        fid,
        type: 'USERNAME_TYPE_FNAME',
      }),
    },
    {
      path: `${hub}/userNameProofByName`,
      queryPrefix: 'name=',
      status: 404,
      headers: JSON_TYPE,
      file: file('farcaster-hub/not-found-name.json', nf('username proof')),
    },
    {
      path: `${hub}/userDataByFid`,
      params: { fid: String(fid) },
      headers: JSON_TYPE,
      file: file('farcaster-hub/user-data.json', {
        messages: [
          userData('USER_DATA_TYPE_USERNAME', fname),
          userData('USER_DATA_TYPE_DISPLAY', 'Marek Fikcyjny (SYNTHETIC)'),
          userData('USER_DATA_TYPE_BIO', 'Syntetyczne konto testowe OŁCyŚ. SYNTHETIC TEST DATA'),
          userData('USER_DATA_TYPE_GITHUB', MORE_IDENTITY.github),
        ],
        nextPageToken: '',
      }),
    },
    {
      path: `${hub}/userDataByFid`,
      queryPrefix: 'fid=',
      status: 404,
      headers: JSON_TYPE,
      file: file('farcaster-hub/not-found-fid.json', nf('user data')),
    },
    {
      path: `${hub}/verificationsByFid`,
      params: { fid: String(fid) },
      headers: JSON_TYPE,
      file: file('farcaster-hub/verifications.json', {
        messages: [
          message(
            {
              verificationAddAddressBody: {
                address: a.eth,
                claimSignature: `0x${hex.encode(claimSignature)}`,
                blockHash: `0x${hex.encode(blockHash)}`,
                verificationType: 0,
                chainId: 0,
                protocol: 'PROTOCOL_ETHEREUM',
              },
            },
            'eth',
          ),
          // The node's read API answers bytes as base64 as well as hex.
          message(
            {
              verificationAddAddressBody: {
                address: base64.encode(base58.decode(a.farcasterSol)),
                claimSignature: base64.encode(bytesOf(seed, 'sig:sol-claim', 64)),
                blockHash: base64.encode(bytesOf(seed, 'sol-block', 32)),
                verificationType: 0,
                chainId: 0,
                protocol: 'PROTOCOL_SOLANA',
              },
            },
            'sol',
          ),
        ],
        nextPageToken: '',
      }),
    },
    {
      path: `${hub}/verificationsByFid`,
      queryPrefix: 'fid=',
      status: 404,
      headers: JSON_TYPE,
      file: file('farcaster-hub/not-found-verifications.json', nf('verifications')),
    },
  );

  // --- Nostr NIP-05 (nostr.example.org → /nostr) ----------------------------------------------------------------------
  const well = '/nostr/.well-known/nostr.json';
  routes.push(
    {
      path: well,
      params: { name: MORE_IDENTITY.nip05Name },
      headers: { ...JSON_TYPE, 'access-control-allow-origin': '*' },
      file: file('nostr/nip05-olcys_test_nostr.json', {
        names: { [MORE_IDENTITY.nip05Name]: a.nostrPubkey },
        relays: { [a.nostrPubkey]: [MORE_IDENTITY.relay] },
      }),
    },
    { path: well, headers: JSON_TYPE, file: file('nostr/nip05-none.json', { names: {} }) },
  );

  // --- Solana JSON-RPC (api.mainnet-beta.solana.com → /chain/solana-rpc) -------------------------------------------
  const rpcPath = '/chain/solana-rpc';
  const post = (name: string, bodyIncludes: string[], value: unknown): void => {
    routes.push({
      path: rpcPath,
      method: 'POST',
      bodyIncludes,
      headers: JSON_TYPE,
      file: file(`chain/solana-rpc/${name}.json`, value),
    });
  };
  const slot = 380_000_000;
  const sig = (label: string): string => base58.encode(bytesOf(seed, `sol-sig:${label}`, 64));
  const sigs = { sol: sig('sol'), usdc: sig('usdc'), cpi: sig('cpi'), failed: sig('failed') };
  const t0 = Date.parse('2026-10-20T12:00:00Z') / 1000;
  const { subject, counterparty, tokenSubject, tokenCounterparty } = a.sol;
  const tx = (label: string, instructions: unknown[], inner: unknown[] = []) => ({
    slot,
    blockTime: t0,
    transaction: {
      signatures: [sigs[label as keyof typeof sigs]],
      message: {
        accountKeys: [subject, counterparty, tokenSubject, tokenCounterparty].map((pubkey) => ({
          pubkey,
          signer: false,
          writable: true,
        })),
        instructions,
      },
    },
    meta: {
      err: null,
      innerInstructions: inner,
      preTokenBalances: [
        { accountIndex: 2, mint: USDC_MINT, owner: subject, uiTokenAmount: { amount: '9000000', decimals: 6 } },
        { accountIndex: 3, mint: USDC_MINT, owner: counterparty, uiTokenAmount: { amount: '0', decimals: 6 } },
      ],
      postTokenBalances: [],
    },
  });
  post('get-slot', ['"getSlot"'], rpc(slot));
  post(
    'get-block-skipped',
    [`"getBlock","params":[${slot},`],
    rpcError(-32007, 'Slot was skipped, or missing due to ledger jump to recent snapshot'),
  );
  post(
    'get-block',
    [`"getBlock","params":[${slot - 1},`],
    rpc({ blockhash: base58.encode(bytesOf(seed, 'sol-blockhash', 32)), blockHeight: slot - 100, blockTime: t0 }),
  );
  post('balance-subject', ['"getBalance"', subject], rpc({ context: { slot }, value: 2_500_000_000 }));
  post('balance-none', ['"getBalance"'], rpc({ context: { slot }, value: 0 }));
  const entry = (signature: string, offset: number, err: unknown = null) => ({
    signature,
    slot: slot - offset,
    err,
    memo: null,
    blockTime: t0 + offset,
    confirmationStatus: 'finalized',
  });
  post(
    'signatures-subject',
    ['"getSignaturesForAddress"', subject],
    rpc([
      entry(sigs.cpi, 3),
      entry(sigs.failed, 2, { InstructionError: [0, 'Custom'] }),
      entry(sigs.usdc, 1),
      entry(sigs.sol, 0),
    ]),
  );
  post('signatures-none', ['"getSignaturesForAddress"'], rpc([]));
  post(
    'tx-sol',
    [`"getTransaction","params":["${sigs.sol}"`],
    rpc(tx('sol', [system(subject, counterparty, 1_500_000_000)])),
  );
  post(
    'tx-usdc',
    [`"getTransaction","params":["${sigs.usdc}"`],
    rpc(tx('usdc', [splChecked(tokenSubject, tokenCounterparty, subject, '2500000')])),
  );
  post(
    'tx-cpi',
    [`"getTransaction","params":["${sigs.cpi}"`],
    rpc(
      tx(
        'cpi',
        [
          system(counterparty, counterparty, 1),
          system(counterparty, counterparty, 1),
          { program: 'unknown', programId: 'Prog' },
        ],
        [{ index: 2, instructions: [system(counterparty, subject, 250_000_000)] }],
      ),
    ),
  );
  post('tx-none', ['"getTransaction"'], rpc(null));
  return { files, routes };
}
