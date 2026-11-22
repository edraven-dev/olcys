/**
 * Synthetic answers of the identity lookups (BitList, Keybase, a JSON-RPC node for ENS) in their real shapes.
 * The demo persona has no entry there: every lookup answers "not found" for it, so the persona's outcome stays as it
 * is. A second synthetic identity (`olcys_test_ewa`) is "found" and exists for the adapters' own tests. Addresses of
 * that identity are derived from the manifest seed (random bytes in a valid format, no keys), so `--render-only`
 * reproduces them.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bech32, hex } from '@scure/base';
import { derive, SYNTHETIC_MARK, type FixtureRouteOut, type GeneratedFile } from './chain.ts';
import { toChecksumAddress } from './crypto.ts';

export const TEST_IDENTITY = {
  nick: 'olcys_test_ewa',
  fullName: 'Ewa Fikcyjna (SYNTHETIC)',
  bitcointalkUid: 900201,
  ensName: 'olcys-test-ewa.eth',
  github: 'olcys-test-ewa',
} as const;

/** Resolver address the synthetic node accepts (the ENS adapter's offline default). */
export const FIXTURE_RESOLVER = '0x0000000000000000000000000000000000000e45';
const FIXTURE_BLOCK = 19_830_000n;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const mark = <T extends object>(value: T): T & { _synthetic: string } => ({ _synthetic: SYNTHETIC_MARK, ...value });
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

export interface IdentityAddresses {
  /** Bech32 P2WPKH address of the test identity (BitList, Keybase, ENS coin type 0). */
  btc: string;
  /** EVM address the test name resolves to. */
  eth: string;
  /** EVM address whose primary name claims the test name without the name pointing back (forward check fails). */
  ethImpostor: string;
  /** P2WPKH scriptPubKey of `btc` (ENSIP-9 raw bytes), hex. */
  btcScript: string;
}

export function identityAddresses(seed: string): IdentityAddresses {
  const program = derive(seed, 'adapters:btc').slice(0, 40);
  const bytes = hex.decode(program);
  return {
    btc: bech32.encode('bc', [0, ...bech32.toWords(bytes)]),
    eth: toChecksumAddress(derive(seed, 'adapters:eth').slice(0, 40)),
    ethImpostor: toChecksumAddress(derive(seed, 'adapters:eth-impostor').slice(0, 40)),
    btcScript: `0014${program}`,
  };
}

// --- minimal ABI encoding of the node's answers --------------------------------------------------------------------

type Value = { t: 'bytes'; v: Uint8Array } | { t: 'string'; v: string } | { t: 'address'; v: string };
const word = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let rest = n;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
function encode(values: Value[]): Uint8Array {
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let tailSize = 0;
  for (const v of values) {
    if (v.t === 'address') {
      head.push(concat([new Uint8Array(12), hex.decode(v.v.replace(/^0x/, '').toLowerCase())]));
      continue;
    }
    const bytes = v.t === 'string' ? utf8(v.v) : v.v;
    head.push(word(BigInt(values.length * 32 + tailSize)));
    const padded = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
    padded.set(bytes);
    const part = concat([word(BigInt(bytes.length)), padded]);
    tail.push(part);
    tailSize += part.length;
  }
  return concat([...head, ...tail]);
}
const selector = (signature: string): string => hex.encode(keccak_256(utf8(signature)).subarray(0, 4));
function namehash(name: string): string {
  let node: Uint8Array = new Uint8Array(32);
  for (const label of name.split('.').toReversed()) node = keccak_256(concat([node, keccak_256(utf8(label))]));
  return hex.encode(node);
}
const rpc = (result: unknown) => ({ jsonrpc: '2.0', id: 1, result });
const hexOf = (bytes: Uint8Array): string => `0x${hex.encode(bytes)}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const RESOLVER = '0x0000000000000000000000000000000000000e46';

const addresses = (items: unknown[]) => ({
  result: 'success',
  message: null,
  data: { total_results: items.length, addresses: items },
});
const bare = (address: string): string => address.replace(/^0x/, '').toLowerCase();
const coinWord = (n: number): string => hex.encode(word(BigInt(n)));

const SEL = {
  reverse: selector('reverse(bytes,uint256)'),
  addr: selector('addr(bytes32)'),
  addrCoin: selector('addr(bytes32,uint256)'),
  text: selector('text(bytes32,string)'),
};

export function identityFixtures(seed: string): { files: GeneratedFile[]; routes: FixtureRouteOut[] } {
  const a = identityAddresses(seed);
  const files: GeneratedFile[] = [];
  const routes: FixtureRouteOut[] = [];
  const file = (path: string, value: unknown): string => {
    files.push({ path, content: json(mark(value as object)) });
    return path;
  };
  const nick = TEST_IDENTITY.nick;
  const uid = TEST_IDENTITY.bitcointalkUid;

  // --- BitList (api.ninjastic.space → /bitlist-api) --------------------------------------------------------------
  const hit = (address: string, coin: string, postId: number, title: string, date: string) => ({
    address,
    coin,
    post_id: postId,
    topic_id: 5_500_201,
    author: nick,
    author_uid: uid,
    title,
    date,
    board_id: 142,
    board_name: 'Polski',
  });
  const hits = [
    hit(a.btc, 'BTC', 65_000_201, 'Test: adres do darowizn (SYNTHETIC)', '2026-03-02T10:15:00.000Z'),
    hit(a.eth, 'ETH', 65_000_202, 'Test: adres ETH (SYNTHETIC)', '2026-03-05T18:40:00.000Z'),
  ];
  const post = (h: ReturnType<typeof hit>, text: string) => ({
    post_id: h.post_id,
    topic_id: h.topic_id,
    author: nick,
    author_uid: uid,
    title: h.title,
    content: text,
    date: h.date,
    board_id: 142,
    board_name: 'Polski',
    updated_at: null,
  });
  const bl = '/bitlist-api';
  routes.push(
    {
      path: `${bl}/addresses`,
      params: { author: nick },
      headers: JSON_TYPE,
      file: file('bitlist-api/addresses-author-olcys_test_ewa.json', addresses(hits)),
    },
    {
      path: `${bl}/addresses`,
      params: { address: a.btc },
      headers: JSON_TYPE,
      file: file('bitlist-api/addresses-address-btc.json', addresses([hits[0]])),
    },
    {
      path: `${bl}/addresses`,
      params: { address: a.eth },
      headers: JSON_TYPE,
      file: file('bitlist-api/addresses-address-eth.json', addresses([hits[1]])),
    },
    {
      path: `${bl}/posts`,
      params: { author: nick },
      headers: JSON_TYPE,
      file: file('bitlist-api/posts-author-olcys_test_ewa.json', {
        result: 'success',
        message: null,
        data: {
          total_results: 2,
          posts: [
            post(hits[0] as ReturnType<typeof hit>, `Moj adres testowy: ${a.btc}<br />SYNTHETIC TEST DATA`),
            post(hits[1] as ReturnType<typeof hit>, `Adres ETH: ${a.eth}<br />SYNTHETIC TEST DATA`),
          ],
        },
      }),
    },
    // Everyone else, the demo persona included, is unknown to the synthetic archive.
    {
      path: `${bl}/addresses`,
      headers: JSON_TYPE,
      file: file('bitlist-api/addresses-none.json', addresses([])),
    },
    {
      path: `${bl}/posts`,
      headers: JSON_TYPE,
      file: file('bitlist-api/posts-none.json', {
        result: 'success',
        message: null,
        data: { total_results: 0, posts: [] },
      }),
    },
  );

  // --- Keybase (keybase.io → /keybase) ---------------------------------------------------------------------------
  const keybaseId = `${derive(seed, 'adapters:keybase').slice(0, 30)}19`;
  const sig = (label: string): string => `0120${derive(seed, `adapters:sig:${label}`)}0a`;
  const lookup = '/keybase/_/api/1.0/user/lookup.json';
  routes.push(
    {
      path: lookup,
      params: { usernames: nick },
      headers: JSON_TYPE,
      file: file('keybase/lookup-olcys_test_ewa.json', {
        status: { code: 0, name: 'OK' },
        them: [
          {
            id: keybaseId,
            basics: { username: nick, ctime: 1_388_534_400, mtime: 1_577_836_800 },
            profile: {
              full_name: TEST_IDENTITY.fullName,
              location: 'Testowo',
              bio: 'Syntetyczne konto testowe OŁCyŚ.',
            },
            proofs_summary: {
              all: [
                {
                  proof_type: 'github',
                  nametag: TEST_IDENTITY.github,
                  state: 1,
                  sig_id: sig('github'),
                  service_url: `https://github.com/${TEST_IDENTITY.github}`,
                  proof_url: `https://gist.github.com/${TEST_IDENTITY.github}/0000000000000000000000000000test1`,
                },
                {
                  proof_type: 'twitter',
                  nametag: nick,
                  state: 2,
                  sig_id: sig('twitter'),
                  service_url: `https://x.com/${nick}`,
                  proof_url: `https://x.com/${nick}/status/1000000000000000001`,
                },
              ],
            },
            cryptocurrency_addresses: {
              bitcoin: [{ address: a.btc, sig_id: sig('bitcoin') }],
              zcash: [{ address: 't1SYNTHETICzcashTESTaddr0000000000', sig_id: sig('zcash') }],
            },
          },
        ],
      }),
    },
    // Unknown user names (the demo persona included) answer `null`, as Keybase does.
    {
      path: lookup,
      headers: JSON_TYPE,
      file: file('keybase/lookup-none.json', { status: { code: 0, name: 'OK' }, them: [null] }),
    },
  );

  // --- ENS node (ens-rpc.example → /ens-rpc): JSON-RPC over POST -------------------------------------------------
  const path = '/ens-rpc/';
  const answer = (label: string, result: unknown): string => {
    const name = `ens-rpc/${label}.json`;
    files.push({ path: name, content: json(mark(rpc(result))) });
    return name;
  };
  const answerPost = (bodyIncludes: string[], label: string, result: unknown): void => {
    routes.push({ path, method: 'POST', bodyIncludes, headers: JSON_TYPE, file: answer(label, result) });
  };
  const resolveResult = (inner: Uint8Array): string =>
    hexOf(
      encode([
        { t: 'bytes', v: inner },
        { t: 'address', v: RESOLVER },
      ]),
    );
  const reverseResult = (name: string): string =>
    hexOf(
      encode([
        { t: 'string', v: name },
        { t: 'address', v: RESOLVER },
        { t: 'address', v: RESOLVER },
      ]),
    );
  const node = namehash(TEST_IDENTITY.ensName);

  answerPost(['"eth_blockNumber"'], 'block-number', `0x${FIXTURE_BLOCK.toString(16)}`);
  answerPost(['"eth_getBlockByNumber"'], 'block', {
    number: `0x${FIXTURE_BLOCK.toString(16)}`,
    hash: `0x${derive(seed, 'adapters:block')}`,
  });
  // Primary names: the test address and the impostor both claim the test name; only the first one is pointed back at.
  answerPost([SEL.reverse, bare(a.eth)], 'reverse-eth', reverseResult(TEST_IDENTITY.ensName));
  answerPost([SEL.reverse, bare(a.ethImpostor)], 'reverse-impostor', reverseResult(TEST_IDENTITY.ensName));
  answerPost([SEL.reverse], 'reverse-none', reverseResult(''));
  answerPost([`${SEL.addr}${node}`], 'addr-60', resolveResult(encode([{ t: 'address', v: a.eth }])));
  answerPost(
    [`${SEL.addrCoin}${node}${coinWord(0)}`],
    'addr-0',
    resolveResult(encode([{ t: 'bytes', v: hex.decode(a.btcScript) }])),
  );
  const texts: [string, string][] = [
    ['com.github', TEST_IDENTITY.github],
    ['io.keybase', nick],
    ['display', TEST_IDENTITY.fullName],
    ['description', 'Syntetyczna tożsamość testowa OŁCyŚ.'],
  ];
  for (const [key, value] of texts) {
    answerPost(
      [`${SEL.text}${node}`, hex.encode(utf8(key))],
      `text-${key}`,
      resolveResult(encode([{ t: 'string', v: value }])),
    );
  }
  // Everything else is unset.
  answerPost([SEL.text], 'text-none', resolveResult(encode([{ t: 'string', v: '' }])));
  answerPost([SEL.addrCoin], 'addr-coin-none', resolveResult(encode([{ t: 'bytes', v: new Uint8Array() }])));
  answerPost([SEL.addr], 'addr-none', resolveResult(encode([{ t: 'address', v: ZERO }])));
  return { files, routes };
}
