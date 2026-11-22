/**
 * Renders corpus templates into documents and their labelled occurrences. Slot values come from shared pools so
 * every positive and hard negative is placed exactly once; obfuscations are spread evenly over eligible slots.
 */
import type { ChainId } from '@olcys/core';
import type { Prng } from '../../../bench/prng.ts';
import type {
  AddressRecord,
  AddressSubtype,
  Channel,
  NegativeKind,
  NegativeRecord,
  Obfuscation,
  TruthRow,
} from '../../../bench/types.ts';
import { ADDRESS_SUBTYPES, CHECKSUMMED_SUBTYPES } from '../../../bench/types.ts';
import { chainSetOf, isBech32Subtype, SUBTYPE_FAMILY } from './addresses.ts';
import { eip55, toHex } from './codecs.ts';
import { defangUrl, ELIGIBLE, obfuscate, SPLITTING, type Rendered } from './obfuscate.ts';
import type { AddrSlot, BodyNode, Ctx, NegSlot, Placeholder, PoolName, TemplateDef } from './template.ts';

const POOL_SUBTYPES: Readonly<Record<PoolName, readonly AddressSubtype[]>> = {
  any: ADDRESS_SUBTYPES,
  bitcoin: ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr'],
  'bitcoin.base58': ['p2pkh', 'p2sh'],
  'bitcoin.p2pkh': ['p2pkh'],
  'bitcoin.p2sh': ['p2sh'],
  'bitcoin.bech32': ['p2wpkh', 'p2wsh', 'p2tr'],
  evm: ['evm_eip55', 'evm_lower', 'evm_upper'],
  'evm.eip55': ['evm_eip55'],
  'evm.unchecksummed': ['evm_lower', 'evm_upper'],
  tron: ['tron_base58'],
};

/** Probability that an `auto` slot occurrence is obfuscated, per context. */
const OBFUSCATION_RATE: Readonly<Partial<Record<Ctx, number>>> = {
  text: 0.4,
  pre: 0.5,
  td: 0.6,
  attr: 0.4,
  plain: 0.5,
};
const URI_PERCENT_RATE = 0.4;
const EXPLORER_DEFANG_RATE = 0.5;

const BANNER_HTML =
  '<div class="olcys-synthetic" role="note">DANE SYNTETYCZNE — SYNTHETIC TEST DATA. Fikcyjne dane testowe OŁCyŚ; żadna prawdziwa osoba nie jest tu opisana.</div>';
const BANNER_TEXT = 'DANE SYNTETYCZNE — SYNTHETIC TEST DATA. Fikcyjne dane testowe OŁCyŚ.';
const NAMES = ['kacper', 'ola', 'marek', 'zosia', 'tomek', 'ewa', 'piotr', 'anka', 'jan', 'iga', 'bartek', 'kasia'];

type Weighted<T> = readonly (readonly [T, number])[];

/** Network keywords near an address and the chain they imply (Polish and English templates). */
const NET_EVM: Readonly<Record<'pl' | 'en', Weighted<readonly [string, ChainId]>>> = {
  pl: [
    [['ETH (ERC20)', 'evm:1'], 25],
    [['Ethereum', 'evm:1'], 12],
    [['BEP20 (BSC)', 'evm:56'], 12],
    [['BNB Smart Chain', 'evm:56'], 6],
    [['Polygon', 'evm:137'], 12],
    [['Arbitrum', 'evm:42161'], 10],
    [['Optimism', 'evm:10'], 7],
    [['sieci Base', 'evm:8453'], 6],
    [['Gnosis', 'evm:100'], 5],
    [['Linea', 'evm:59144'], 5],
  ],
  en: [
    [['ETH (ERC20)', 'evm:1'], 25],
    [['Ethereum', 'evm:1'], 12],
    [['BEP20 (BSC)', 'evm:56'], 12],
    [['BNB Smart Chain', 'evm:56'], 6],
    [['Polygon', 'evm:137'], 12],
    [['Arbitrum', 'evm:42161'], 10],
    [['Optimism', 'evm:10'], 7],
    [['Base network', 'evm:8453'], 6],
    [['Gnosis', 'evm:100'], 5],
    [['Linea', 'evm:59144'], 5],
  ],
};
const NET_UTXO: Readonly<Partial<Record<AddressSubtype, Weighted<readonly [string, ChainId]>>>> = {
  p2pkh: [
    [['BTC', 'bitcoin'], 8],
    [['Bitcoin Cash (BCH)', 'bitcoincash'], 2],
  ],
  p2sh: [
    [['BTC', 'bitcoin'], 7],
    [['LTC', 'litecoin'], 2],
    [['BCH', 'bitcoincash'], 1],
  ],
};
const NET_TRON: Weighted<readonly [string, ChainId]> = [
  [['USDT TRC20', 'tron'], 3],
  [['TRX', 'tron'], 1],
];

interface ExplorerHost {
  host: string;
  prefix: string;
  chain: ChainId;
}
const BTC_EXPLORERS: Weighted<ExplorerHost> = [
  [{ host: 'mempool.space', prefix: '/address/', chain: 'bitcoin' }, 5],
  [{ host: 'blockstream.info', prefix: '/address/', chain: 'bitcoin' }, 3],
  [{ host: 'blockchair.com', prefix: '/bitcoin/address/', chain: 'bitcoin' }, 2],
];
const EXPLORERS: Readonly<Record<'bech32' | 'p2pkh' | 'p2sh' | 'evm' | 'tron', Weighted<ExplorerHost>>> = {
  bech32: BTC_EXPLORERS,
  p2pkh: [...BTC_EXPLORERS, [{ host: 'blockchair.com', prefix: '/bitcoin-cash/address/', chain: 'bitcoincash' }, 3]],
  p2sh: [
    ...BTC_EXPLORERS,
    [{ host: 'blockchair.com', prefix: '/litecoin/address/', chain: 'litecoin' }, 2],
    [{ host: 'litecoinspace.org', prefix: '/address/', chain: 'litecoin' }, 2],
  ],
  evm: [
    [{ host: 'etherscan.io', prefix: '/address/', chain: 'evm:1' }, 8],
    [{ host: 'bscscan.com', prefix: '/address/', chain: 'evm:56' }, 4],
    [{ host: 'polygonscan.com', prefix: '/address/', chain: 'evm:137' }, 3],
    [{ host: 'arbiscan.io', prefix: '/address/', chain: 'evm:42161' }, 2],
    [{ host: 'basescan.org', prefix: '/address/', chain: 'evm:8453' }, 2],
    [{ host: 'optimistic.etherscan.io', prefix: '/address/', chain: 'evm:10' }, 1],
    [{ host: 'gnosisscan.io', prefix: '/address/', chain: 'evm:100' }, 1],
    [{ host: 'lineascan.build', prefix: '/address/', chain: 'evm:59144' }, 1],
    [{ host: 'eth.blockscout.com', prefix: '/address/', chain: 'evm:1' }, 1],
    [{ host: 'blockchair.com', prefix: '/ethereum/address/', chain: 'evm:1' }, 1],
  ],
  tron: [
    [{ host: 'tronscan.org', prefix: '/#/address/', chain: 'tron' }, 4],
    [{ host: 'blockchair.com', prefix: '/tron/address/', chain: 'tron' }, 1],
  ],
};
const EIP681_CHAINS: Weighted<number> = [
  [1, 40],
  [56, 15],
  [137, 15],
  [42161, 10],
  [10, 8],
  [8453, 8],
  [100, 2],
  [59144, 2],
];

// --- pools -------------------------------------------------------------------------------------------------------

export class Pools {
  readonly addresses = new Map<AddressSubtype, AddressRecord[]>();
  readonly negatives = new Map<NegativeKind, NegativeRecord[]>();
  /** EIP-681 token contracts, created when a transfer URI is rendered. */
  readonly tokenContracts: NegativeRecord[] = [];
  readonly obfuscationCounts = new Map<Obfuscation, number>();
  readonly #prng: Prng;

  constructor(prng: Prng, addresses: readonly AddressRecord[], negatives: readonly NegativeRecord[]) {
    this.#prng = prng;
    for (const subtype of ADDRESS_SUBTYPES) {
      this.addresses.set(subtype, prng.fork(`pool/${subtype}`).shuffle(addresses.filter((a) => a.subtype === subtype)));
    }
    for (const n of negatives) {
      this.negatives.set(n.kind, [...(this.negatives.get(n.kind) ?? []), n]);
    }
    for (const [kind, list] of this.negatives) this.negatives.set(kind, prng.fork(`pool/${kind}`).shuffle(list));
  }

  counts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [k, v] of this.addresses) out.set(k, v.length);
    for (const [k, v] of this.negatives) out.set(k, v.length);
    return out;
  }

  newTokenContract(): NegativeRecord {
    const record: NegativeRecord = {
      id: `neg-uri-token-contract-${String(this.tokenContracts.length + 1).padStart(4, '0')}`,
      kind: 'uri_token_contract',
      value: eip55(`0x${toHex(this.#prng.bytes(20))}`),
      expected: 'reject',
      rejectCode: 'uri_token_contract',
    };
    this.tokenContracts.push(record);
    return record;
  }

  /** Least-used obfuscation among `options` (ties: list order). */
  balanced(options: readonly Obfuscation[]): Obfuscation | undefined {
    let best: Obfuscation | undefined;
    for (const o of options) {
      if (best === undefined || (this.obfuscationCounts.get(o) ?? 0) < (this.obfuscationCounts.get(best) ?? 0))
        best = o;
    }
    if (best !== undefined) this.obfuscationCounts.set(best, (this.obfuscationCounts.get(best) ?? 0) + 1);
    return best;
  }
}

/** Subtype (or negative kind) with the most remaining items among `keys`; undefined when all are exhausted. */
function fullest(counts: Map<string, number>, keys: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    const n = counts.get(key) ?? 0;
    if (n > 0 && (best === undefined || n > (counts.get(best) ?? 0))) best = key;
  }
  return best;
}

function slotKeys(def: AddrSlot | NegSlot): readonly string[] {
  return def.type === 'addr' ? POOL_SUBTYPES[def.pool] : def.kinds;
}

/** Plans the draws of one render on a copy of the pool counts; returns the number of rows, or -1 if impossible. */
function planRows(
  t: TemplateDef,
  pools: Pools,
  topSlots: readonly string[],
  rows?: { min: number; max: number },
): number {
  const counts = pools.counts();
  const take = (slot: string): boolean => {
    const def = t.slots[slot];
    if (!def) return false;
    const key = fullest(counts, slotKeys(def));
    if (key === undefined) return false;
    counts.set(key, (counts.get(key) ?? 0) - 1);
    return true;
  };
  for (const slot of topSlots) if (!take(slot)) return -1;
  if (!rows) return 0;
  let n = 0;
  while (n < rows.max && [...t.rowSlots].every((slot) => take(slot))) n += 1;
  return n >= rows.min ? n : -1;
}

type SlotValue = { type: 'addr'; record: AddressRecord } | { type: 'neg'; record: NegativeRecord };

function draw(t: TemplateDef, pools: Pools, slot: string): SlotValue {
  const def = t.slots[slot];
  if (!def) throw new Error(`undeclared slot ${slot}`);
  const counts = pools.counts();
  const key = fullest(counts, slotKeys(def));
  if (def.type === 'addr') {
    const record = key ? pools.addresses.get(key as AddressSubtype)?.shift() : undefined;
    if (!record) throw new Error(`pool exhausted for slot ${slot}`);
    return { type: 'addr', record };
  }
  const record = key ? pools.negatives.get(key as NegativeKind)?.shift() : undefined;
  if (!record) throw new Error(`pool exhausted for slot ${slot}`);
  return { type: 'neg', record };
}

// --- markers (URI, explorer, network keyword) --------------------------------------------------------------------

interface UriSpec {
  /** Text before and after the address (`html`: escape `&` as `&amp;`). */
  build: (html: boolean) => { prefix: string; suffix: string };
  chain?: ChainId;
  contract?: NegativeRecord;
}

function explorerKey(subtype: AddressSubtype): keyof typeof EXPLORERS {
  if (isBech32Subtype(subtype)) return 'bech32';
  if (subtype === 'p2pkh' || subtype === 'p2sh') return subtype;
  return SUBTYPE_FAMILY[subtype] === 'tron' ? 'tron' : 'evm';
}

/** Query separator: escaped inside HTML. */
const amp = (html: boolean): string => (html ? '&amp;' : '&');

function uriSpec(record: AddressRecord, pools: Pools, prng: Prng): UriSpec {
  if (record.chain === 'bitcoin') {
    const scheme =
      record.subtype === 'p2sh'
        ? prng.weighted<string>([
            ['bitcoin', 7],
            ['litecoin', 3],
          ])
        : record.subtype === 'p2pkh'
          ? prng.weighted<string>([
              ['bitcoin', 8],
              ['bitcoincash', 2],
            ])
          : 'bitcoin';
    const amount = `0.${String(prng.range(1, 99999)).padStart(5, '0')}`;
    const label = prng.pick(['Darowizna', 'Fundacja%20Testowa', 'Zamowienie-1042', 'Wsparcie%20projektu']);
    const variant = prng.int(4);
    const chain: ChainId = scheme === 'litecoin' ? 'litecoin' : scheme === 'bitcoincash' ? 'bitcoincash' : 'bitcoin';
    return {
      chain,
      build: (html) => ({
        prefix: `${scheme}:`,
        suffix: [
          `?amount=${amount}`,
          `?amount=${amount}${amp(html)}label=${label}`,
          `?label=${label}${amp(html)}message=Platnosc`,
          '',
        ][variant] as string,
      }),
    };
  }
  if (record.chain !== 'evm') throw new Error(`no payment URI scheme for ${record.subtype}`);
  const chainId = prng.weighted(EIP681_CHAINS);
  const form = prng.weighted<string>([
    ['plain', 50],
    ['pay', 10],
    ['nochain', 15],
    ['transfer', 25],
  ]);
  const value = `${prng.range(1, 999)}e15`;
  if (form === 'transfer') {
    const contract = pools.newTokenContract();
    const units = `${prng.range(1, 900)}e6`;
    return {
      chain: `evm:${chainId}`,
      contract,
      build: (html) => ({
        prefix: `ethereum:${contract.value}@${chainId}/transfer?address=`,
        suffix: `${amp(html)}uint256=${units}`,
      }),
    };
  }
  if (form === 'nochain') return { build: () => ({ prefix: 'ethereum:', suffix: `?value=${value}` }) };
  return {
    chain: `evm:${chainId}`,
    build: () => ({ prefix: form === 'pay' ? 'ethereum:pay-' : 'ethereum:', suffix: `@${chainId}?value=${value}` }),
  };
}

function netKeyword(record: AddressRecord, lang: 'pl' | 'en', prng: Prng): readonly [string, ChainId] {
  if (record.chain === 'evm') return prng.weighted(NET_EVM[lang]);
  if (record.chain === 'tron') return prng.weighted(NET_TRON);
  const table = NET_UTXO[record.subtype];
  return table ? prng.weighted(table) : ['BTC', 'bitcoin'];
}

function defaultChain(record: AddressRecord): ChainId {
  if (record.chain === 'evm') return 'evm:unknown';
  return record.chain === 'tron' ? 'tron' : 'bitcoin';
}

// --- rendering ---------------------------------------------------------------------------------------------------

interface Occurrence {
  start: number;
  end: number;
  channel: Channel;
  obfuscation: Obfuscation[];
  /** Slot instance key (`slot` or `slot#row`), for the attribute-only / JSON-LD-only tags. */
  instance?: string;
  kind: 'addr' | 'neg' | 'secret';
  role?: AddrSlot['role'];
  address?: AddressRecord;
  negative?: NegativeRecord;
  chain?: ChainId;
  secret?: { kind: TruthRow['secretKind']; index: number };
}

export interface RenderedDoc {
  docId: string;
  template: TemplateDef;
  text: string;
  truth: TruthRow[];
}

function channelOf(ctx: Ctx): Channel {
  if (ctx === 'attr' || ctx === 'href') return 'attr';
  if (ctx === 'jsonld' || ctx === 'json') return 'json_ld';
  return 'text';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function filler(name: string, t: TemplateDef, prng: Prng, row: number): string {
  switch (name) {
    case 'BANNER':
      return t.type === 'html' ? BANNER_HTML : BANNER_TEXT;
    case 'NICK':
      return `fikcyjny_${prng.pick(NAMES)}_${prng.range(10, 99)}`;
    case 'DATE':
      return `2026-${pad2(prng.range(1, 11))}-${pad2(prng.range(1, 28))}`;
    case 'TIME':
      return `${pad2(prng.range(0, 23))}:${pad2(prng.range(0, 59))}`;
    case 'AMOUNT':
      return `${prng.range(0, 9)}.${String(prng.range(1, 9999)).padStart(4, '0')}`;
    case 'KWOTA':
      return `${prng.range(0, 9)},${String(prng.range(1, 9999)).padStart(4, '0')}`;
    case 'PLN':
      return String(prng.range(20, 9000));
    case 'NUM':
      return String(prng.range(100000, 999999));
    case 'N':
      return String(row + 1);
    default:
      throw new Error(`unknown filler ${name}`);
  }
}

interface Instance {
  key: string;
  value: SlotValue;
  def: AddrSlot | NegSlot;
  uri?: UriSpec;
  explorer?: ExplorerHost;
  net?: readonly [string, ChainId];
  chain?: ChainId;
}

function usesOf(nodes: readonly BodyNode[], slot: string, kind: Placeholder['kind']): boolean {
  return nodes.some((n) =>
    n.kind === 'rows'
      ? usesOf(n.children, slot, kind)
      : n.kind === 'ph' && n.ph.kind === kind && 'slot' in n.ph && n.ph.slot === slot,
  );
}

function prepare(t: TemplateDef, key: string, slot: string, value: SlotValue, pools: Pools, prng: Prng): Instance {
  const def = t.slots[slot];
  if (!def) throw new Error(`undeclared slot ${slot}`);
  const inst: Instance = { key, value, def };
  if (value.type !== 'addr' || def.type !== 'addr') return inst;
  const record = value.record;
  if (usesOf(t.nodes, slot, 'uri')) inst.uri = uriSpec(record, pools, prng);
  if (usesOf(t.nodes, slot, 'explorer')) inst.explorer = prng.weighted(EXPLORERS[explorerKey(record.subtype)]);
  if (usesOf(t.nodes, slot, 'net')) inst.net = netKeyword(record, t.lang, prng);
  inst.chain =
    inst.uri?.chain ??
    inst.explorer?.chain ??
    inst.net?.[1] ??
    (def.chain && def.chain !== 'net' ? def.chain : undefined) ??
    defaultChain(record);
  return inst;
}

function chooseObfuscation(
  def: AddrSlot,
  record: AddressRecord,
  ctx: Ctx,
  pools: Pools,
  prng: Prng,
): Obfuscation | undefined {
  const mode = def.obf ?? 'auto';
  if (mode === 'none') return undefined;
  const checksummed = CHECKSUMMED_SUBTYPES.includes(record.subtype);
  const allowed = (list: readonly Obfuscation[]): Obfuscation[] =>
    list.filter((o) => ELIGIBLE[ctx].includes(o) && (checksummed || !SPLITTING.has(o)));
  if (mode === 'auto') {
    const options = allowed(ELIGIBLE[ctx]);
    if (options.length === 0 || !prng.chance(OBFUSCATION_RATE[ctx] ?? 0)) return undefined;
    return pools.balanced(options);
  }
  return pools.balanced(allowed(mode));
}

/** Renders one document; `undefined` when the pools cannot fill the template any more. */
export function renderDocument(t: TemplateDef, docId: string, pools: Pools, prng: Prng): RenderedDoc | undefined {
  const rowsNode = t.nodes.find((n): n is Extract<BodyNode, { kind: 'rows' }> => n.kind === 'rows');
  const topSlots = Object.keys(t.slots).filter((s) => !t.rowSlots.has(s));
  const rows = planRows(t, pools, topSlots, rowsNode);
  if (rows < 0) return undefined;

  const top = new Map<string, Instance>();
  for (const slot of topSlots) top.set(slot, prepare(t, slot, slot, draw(t, pools, slot), pools, prng));
  const rowInstances: Map<string, Instance>[] = [];
  for (let r = 0; r < rows; r += 1) {
    const map = new Map<string, Instance>();
    for (const slot of t.rowSlots) map.set(slot, prepare(t, `${slot}#${r}`, slot, draw(t, pools, slot), pools, prng));
    rowInstances.push(map);
  }

  let text = '';
  const occurrences: Occurrence[] = [];
  const secretCounts = new Map<string, number>();
  const html = t.type === 'html';

  const emitAddress = (inst: Instance, rendered: Rendered, channel: Channel, obfs: Obfuscation[]): void => {
    if (inst.value.type !== 'addr' || inst.def.type !== 'addr') return;
    occurrences.push({
      start: text.length + rendered.start,
      end: text.length + rendered.end,
      channel,
      obfuscation: obfs,
      instance: inst.key,
      kind: 'addr',
      role: inst.def.role,
      address: inst.value.record,
      ...(inst.chain ? { chain: inst.chain } : {}),
    });
  };

  const renderPlaceholder = (ph: Placeholder, values: Map<string, Instance>, row: number): void => {
    if (ph.kind === 'filler') {
      text += filler(ph.name, t, prng, row);
      return;
    }
    if (ph.kind === 'secret') {
      const index = (secretCounts.get(ph.secret) ?? 0) + 1;
      secretCounts.set(ph.secret, index);
      const placeholder = `{{SECRET:${ph.secret}:${index}}}`;
      occurrences.push({
        start: text.length,
        end: text.length + placeholder.length,
        channel: channelOf(ph.ctx),
        obfuscation: [],
        kind: 'secret',
        secret: { kind: ph.secret, index },
      });
      text += placeholder;
      return;
    }
    const inst = values.get(ph.slot) ?? top.get(ph.slot);
    if (!inst) throw new Error(`no value for slot ${ph.slot}`);
    if (ph.kind === 'net') {
      text += inst.net?.[0] ?? '';
      return;
    }
    if (ph.kind === 'neg') {
      if (inst.value.type !== 'neg') throw new Error(`slot ${ph.slot} is not a negative slot`);
      const record = inst.value.record;
      let obf: Obfuscation | undefined;
      if (record.kind === 'split_unchecksummed') {
        obf =
          ph.ctx === 'pre' || ph.ctx === 'plain'
            ? 'newline'
            : ph.ctx === 'td'
              ? 'spaces4'
              : prng.pick(['spaces4', 'br_split'] as const);
      }
      const rendered = obfuscate(record.value, obf, prng);
      occurrences.push({
        start: text.length + rendered.start,
        end: text.length + rendered.end,
        channel: channelOf(ph.ctx),
        obfuscation: record.kind === 'homoglyph' ? ['homoglyph'] : obf ? [obf] : [],
        kind: 'neg',
        negative: record,
      });
      text += rendered.text;
      return;
    }
    if (inst.value.type !== 'addr' || inst.def.type !== 'addr')
      throw new Error(`slot ${ph.slot} is not an address slot`);
    const record = inst.value.record;
    if (ph.kind === 'addr') {
      const obf = chooseObfuscation(inst.def, record, ph.ctx, pools, prng);
      const rendered = obfuscate(record.display, obf, prng);
      emitAddress(inst, rendered, channelOf(ph.ctx), obf ? [obf] : []);
      text += rendered.text;
      return;
    }
    const textual = ph.ctx === 'text' || ph.ctx === 'plain' || ph.ctx === 'pre' || ph.ctx === 'td';
    if (ph.kind === 'uri') {
      const spec = inst.uri;
      if (!spec) throw new Error(`no URI for slot ${ph.slot}`);
      const escape = html && ph.ctx !== 'jsonld';
      const { prefix, suffix } = spec.build(escape);
      const percent =
        (textual || ph.ctx === 'href') && prng.chance(URI_PERCENT_RATE) ? pools.balanced(['percent']) : undefined;
      const rendered = obfuscate(record.display, percent, prng);
      if (spec.contract) {
        const at = prefix.indexOf(spec.contract.value);
        occurrences.push({
          start: text.length + at,
          end: text.length + at + spec.contract.value.length,
          channel: 'uri',
          obfuscation: [],
          kind: 'neg',
          negative: spec.contract,
        });
      }
      text += prefix;
      emitAddress(inst, rendered, 'uri', percent ? [percent] : []);
      text += rendered.text + suffix;
      return;
    }
    const explorer = inst.explorer;
    if (!explorer) throw new Error(`no explorer for slot ${ph.slot}`);
    const url = `https://${explorer.host}${explorer.prefix}`;
    const defang = textual && prng.chance(EXPLORER_DEFANG_RATE) ? pools.balanced(['defang']) : undefined;
    text += defang ? defangUrl(url) : url;
    emitAddress(
      inst,
      { text: record.display, start: 0, end: record.display.length },
      'explorer',
      defang ? [defang] : [],
    );
    text += record.display;
  };

  const walk = (nodes: readonly BodyNode[], values: Map<string, Instance>, row: number): void => {
    for (const node of nodes) {
      if (node.kind === 'text') text += node.value;
      else if (node.kind === 'ph') renderPlaceholder(node.ph, values, row);
      else rowInstances.forEach((map, r) => walk(node.children, map, r));
    }
  };
  walk(t.nodes, new Map(), -1);

  // Attribute-only / JSON-LD-only: every occurrence of the address instance sits in that channel.
  const byInstance = new Map<string, Occurrence[]>();
  for (const o of occurrences) if (o.instance) byInstance.set(o.instance, [...(byInstance.get(o.instance) ?? []), o]);
  for (const list of byInstance.values()) {
    for (const [channel, tag] of [
      ['attr', 'attr_only'],
      ['json_ld', 'json_ld_only'],
    ] as const) {
      if (list.every((o) => o.channel === channel)) for (const o of list) o.obfuscation.push(tag);
    }
  }

  occurrences.sort((a, b) => a.start - b.start || a.end - b.end);
  const truth = occurrences.map((o, occurrence): TruthRow => toTruth(docId, occurrence, o));
  return { docId, template: t, text, truth };
}

function toTruth(docId: string, occurrence: number, o: Occurrence): TruthRow {
  const base = { docId, occurrence, channel: o.channel, source: { start: o.start, end: o.end } };
  if (o.kind === 'secret') {
    return {
      ...base,
      chainSet: [],
      isValid: false,
      hasChecksum: false,
      obfuscation: [],
      role: 'none',
      isSecret: true,
      ...(o.secret?.kind ? { secretKind: o.secret.kind } : {}),
      expected: 'secret',
      ...(o.secret ? { secretIndex: o.secret.index } : {}),
    };
  }
  if (o.kind === 'addr' && o.address) {
    const a = o.address;
    return {
      ...base,
      canonical: a.canonical,
      chainSet: chainSetOf(a.subtype),
      subtype: a.subtype,
      isValid: true,
      hasChecksum: a.hasChecksum,
      obfuscation: o.obfuscation,
      role: o.role ?? 'none',
      isSecret: false,
      expected: 'positive',
      ...(o.chain ? { chain: o.chain } : {}),
      ref: a.id,
    };
  }
  const n = o.negative;
  if (!n) throw new Error('occurrence without value');
  const valid = n.expected === 'example' || n.expected === 'unverifiable' || n.kind === 'uri_token_contract';
  return {
    ...base,
    ...(valid ? { canonical: /^0x|^bc1/i.test(n.value) ? n.value.toLowerCase() : n.value } : {}),
    chainSet: valid ? chainSetFor(n.value) : [],
    isValid: valid,
    hasChecksum: negativeHasChecksum(n),
    obfuscation: o.obfuscation,
    role: 'none',
    isSecret: false,
    negativeKind: n.kind,
    expected: n.expected,
    ref: n.id,
    ...(n.rejectCode ? { rejectCode: n.rejectCode } : {}),
  };
}

const CHECKSUMMED_NEGATIVES: ReadonlySet<NegativeKind> = new Set([
  'corrupt1',
  'corrupt2',
  'transpose',
  'truncate',
  'eip55_case_flip',
  'bech32_mixed_case',
  'v1_in_bech32',
  'v0_in_bech32m',
  'testnet_bech32',
  'testnet_base58',
  'uri_token_contract',
]);

/** Whether the format the value imitates carries a checksum. */
function negativeHasChecksum(n: NegativeRecord): boolean {
  if (CHECKSUMMED_NEGATIVES.has(n.kind)) return true;
  if (n.kind !== 'example' && n.kind !== 'homoglyph') return false;
  if (/^0x/i.test(n.value)) {
    const hex = n.value.slice(2);
    return hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  }
  return true;
}

function chainSetFor(value: string): ChainId[] {
  if (/^0x/i.test(value)) return chainSetOf('evm_lower');
  if (/^bc1/i.test(value)) return chainSetOf('p2wpkh');
  if (value.startsWith('3')) return chainSetOf('p2sh');
  if (value.startsWith('1')) return chainSetOf('p2pkh');
  return [];
}
