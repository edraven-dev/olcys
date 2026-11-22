/**
 * ENS adapter. A primary name counts only when it is forward-verified (the name resolves back to the address); text
 * records and other-chain addresses are statements of whoever manages the name (anyone can point a name at any
 * address) and are recorded as such. The collector reads through a JSON-RPC endpoint configured by the deployment
 * (`ENS_RPC_URL`, host in `OLCYS_SOURCE_HOSTS_ENS`); offline it reads the fixture site's synthetic node.
 *
 * Observations: `ens.verified_address` (account `ens:<name>`, only after forward verification: the E1 candidate),
 * `ens.primary_name` and `computed.ens.forward_verified` (address subject), `profile.ens_address` /
 * `profile.<symbol>_address` and `ens.text.<key>` (manager statements, E2), `account.link` for social handles.
 * Text records are attacker-controlled strings: control characters stripped, 2 KB cap, never fetched or followed
 * as instructions.
 */
import type { AddressRef, Capture, CaptureStatus, CollectorInput, RunContext, SourceCollector } from '@olcys/core';
import { canonicalJson, nowIso } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { COLLECTORS_VERSION } from '../framework/config.ts';
import { SourceConfigError } from '../framework/errors.ts';
import { createSourceHttp, type SourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { noteCode } from '../framework/status.ts';
import { fromHex, namehash, toHex } from './ens-abi.ts';
import { cleanRecord, decodeCoinAddress, ENS_COIN_TYPES, normaliseEnsName } from './ens-names.ts';
import { CcipReadDisabledError, createRpcEnsReader, EnsRpcFailure, type EnsReader, type RpcTrace } from './ens-rpc.ts';

export const ENS_PARSER_VERSION = 'ens.v1';
export const ENS_SOURCE_ID = 'ens';
/** Synthetic JSON-RPC endpoint and resolver the fixture site answers for (offline and replay only). */
export const ENS_FIXTURE_RPC_URL = 'https://ens-rpc.example/';
export const ENS_FIXTURE_RESOLVER = '0x0000000000000000000000000000000000000e45';
/** Text-record keys read for a name. */
export const ENS_TEXT_KEYS: readonly string[] = [
  'avatar',
  'description',
  'display',
  'email',
  'url',
  'location',
  'com.github',
  'com.twitter',
  'com.discord',
  'org.telegram',
  'com.reddit',
  'xyz.farcaster',
  'io.keybase',
];
export { ENS_COIN_TYPES };
const MAX_SUBJECTS = 10;
const SOCIAL_HANDLE = /^[A-Za-z0-9_.-]{1,64}$/;
const SOCIAL_LINKS: Readonly<Record<string, (handle: string) => string>> = {
  'com.github': (h) => `https://github.com/${h}`,
  'com.twitter': (h) => `https://x.com/${h}`,
  'org.telegram': (h) => `https://t.me/${h}`,
  'io.keybase': (h) => `https://keybase.io/${h}`,
};
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface EnsOptions {
  /** Live JSON-RPC endpoint (`ENS_RPC_URL`); ignored offline, where the fixture site answers. */
  rpcUrl?: string;
  /** Universal Resolver of the deployment (`ENS_UNIVERSAL_RESOLVER`). */
  universalResolver?: string;
  textKeys?: readonly string[];
  /** A reader replacing the RPC one (tests). */
  reader?: EnsReader;
}

interface Subjects {
  addresses: string[];
  names: string[];
}

function evmAddresses(input: CollectorInput): string[] {
  const out = new Set<string>();
  const add = (ref: Pick<AddressRef, 'chain' | 'address'>): void => {
    if (ref.chain.startsWith('evm') && EVM_ADDRESS.test(ref.address.trim())) out.add(ref.address.trim().toLowerCase());
  };
  for (const ref of input.addresses) add(ref);
  for (const identifier of input.identifiers) {
    if (identifier.kind === 'crypto_address' && identifier.chain)
      add({ chain: identifier.chain, address: identifier.value });
  }
  return [...out];
}

/** Whether a value names an ENS domain by its suffix or because it is given for the `ens` platform. */
export function looksLikeEnsName(value: string): boolean {
  return /\.eth$/i.test(value.trim());
}

function subjectsOf(input: CollectorInput): Subjects {
  const names = new Set<string>();
  const add = (value: string): void => {
    if (looksLikeEnsName(value)) names.add(value.trim());
  };
  for (const value of input.values ?? []) if (value.kind === 'username') add(value.value);
  for (const account of input.accounts) if (account.platform === 'ens') names.add(account.handle.trim());
  for (const identifier of input.identifiers) {
    // Never an e-mail address, a person's name or an arbitrary domain: only `.eth` names.
    if (identifier.kind === 'email' || identifier.kind === 'full_name' || identifier.kind === 'crypto_address')
      continue;
    add(identifier.value);
  }
  return { addresses: evmAddresses(input), names: [...names] };
}

const ensProfileUrl = (name: string): string => `https://app.ens.domains/${name}`;

export function createEnsCollector(options: EnsOptions = {}): CollectorFactory {
  const textKeys = options.textKeys ?? ENS_TEXT_KEYS;
  return {
    sourceId: ENS_SOURCE_ID,
    platform: 'ens',
    addressFamilies: ['evm'],
    nameSuffixes: ['.eth'],
    accountsAreReferences: true,
    create(descriptor, deps): SourceCollector {
      const offline = deps.mode !== 'live';
      const rpcUrl = offline ? ENS_FIXTURE_RPC_URL : (options.rpcUrl?.trim() ?? '');
      const universalResolver = offline ? ENS_FIXTURE_RESOLVER : (options.universalResolver?.trim() ?? '');
      if (!options.reader && !offline) {
        const problems: string[] = [];
        if (!rpcUrl) problems.push('ENS_RPC_URL is not set');
        else {
          let host = '';
          try {
            host = new URL(rpcUrl).hostname.toLowerCase();
          } catch {
            problems.push('ENS_RPC_URL is not a URL');
          }
          if (host && !descriptor.allowedHosts.some((h) => h === host)) {
            problems.push(`the RPC host ${host} is not in the allow-list of source ens (set OLCYS_SOURCE_HOSTS_ENS)`);
          }
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(universalResolver)) problems.push('ENS_UNIVERSAL_RESOLVER is not an address');
        if (problems.length) throw new SourceConfigError(problems.map((p) => `sources.ens: ${p}`));
      }
      return {
        descriptor,
        supports: (input) => {
          const s = subjectsOf(input);
          return s.addresses.length + s.names.length > 0;
        },
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const subjects = subjectsOf(input);
          if (!subjects.addresses.length && !subjects.names.length) {
            rb.note('unsupported_input', 'no EVM address or .eth name');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const env: Env = {
            http,
            ctx,
            rb,
            rpcUrl,
            universalResolver,
            textKeys,
            reader: options.reader,
            redaction: { secrets: 0, kinds: new Set() },
          };
          const queue = [
            ...subjects.addresses.map((value) => ({ kind: 'address' as const, value })),
            ...subjects.names.map((value) => ({ kind: 'name' as const, value })),
          ];
          for (const [index, subject] of queue.entries()) {
            if (index >= MAX_SUBJECTS) {
              rb.note('truncated', `${MAX_SUBJECTS} of ${queue.length} ENS subjects looked up`);
              break;
            }
            if (http.stopped()) break;
            // Sequential on purpose: one request at a time per source.
            // oxlint-disable-next-line no-await-in-loop
            await (subject.kind === 'address'
              ? lookupAddress(env, subject.value)
              : lookupName(env, subject.value, 'input'));
          }
          return rb.build();
        },
      };
    },
  };
}

interface Env {
  http: SourceHttp;
  ctx: RunContext;
  rb: ResultBuilder;
  rpcUrl: string;
  universalResolver: string;
  textKeys: readonly string[];
  reader: EnsReader | undefined;
  /** Secrets masked in the current subject's decoded strings (reset per subject). */
  redaction: { secrets: number; kinds: Set<string> };
}

/** What one subject's reads found; `emit` turns it into observations once the capture exists. */
interface Reads {
  found: boolean;
  summary: Record<string, unknown>;
  emit: (capture: Capture) => void;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Runs the reads of one subject, records one capture of everything read, then emits the observations. */
async function withSubject(
  env: Env,
  resource: string,
  work: (reader: EnsReader, block: { number: bigint; hash: string }) => Promise<Reads>,
): Promise<void> {
  const { http, ctx, rb } = env;
  const startedAt = nowIso(ctx.clock);
  env.redaction = { secrets: 0, kinds: new Set() };
  const { reader, trace } = env.reader
    ? { reader: env.reader, trace: { calls: [] } as RpcTrace }
    : createRpcEnsReader({ http, rpcUrl: env.rpcUrl, universalResolver: env.universalResolver });
  let status: CaptureStatus = 'ok';
  let reads: Reads | undefined;
  let block: { number: bigint; hash: string } | undefined;
  const notes: string[] = [];
  try {
    block = await reader.block();
    reads = await work(reader, block);
    if (!reads.found) status = 'not_found';
  } catch (error) {
    if (error instanceof EnsRpcFailure) {
      status = error.status;
      notes.push(...error.notes);
    } else if (error instanceof CcipReadDisabledError) {
      status = 'error';
      rb.note('unsupported_input', 'ccip-read disabled');
    } else throw error;
  }
  for (const text of notes)
    rb.note(noteCode(text) as Parameters<ResultBuilder['note']>[0], text.slice(text.indexOf(':') + 2));
  if (!ctx.evidence) throw new Error('RunContext.evidence (the capture recorder) is not configured');
  // Nothing was sent (a source that was already stopped): no capture, only the status.
  if (!trace.calls.length && !env.reader) {
    rb.addStatus(status);
    return;
  }
  const last = trace.last;
  const now = nowIso(ctx.clock);
  const received = last?.provenance.receivedAt ?? now;
  const summary = {
    rpcHost: safeHost(env.rpcUrl),
    block: block ? { number: block.number.toString(), hash: block.hash } : null,
    calls: trace.calls,
    results: reads?.summary ?? {},
  };
  const capture = await ctx.evidence.record(
    {
      sourceId: http.descriptor.id,
      profile: 'api_response',
      userAgent: last?.provenance.userAgent ?? 'olcys',
      fetchIds: trace.calls.map((c) => c.fetchId),
      url: `ens:${resource}`,
      finalUrl: `ens:${resource}`,
      startedAt,
      collectedAt: received,
      endedAt: now > received ? now : received,
      httpStatus: last?.status ?? 200,
      status,
      ...(last?.provenance.remoteAddress ? { serverIp: last.provenance.remoteAddress } : {}),
      ...(last ? { responseHeaders: last.headers } : {}),
      artifacts: [
        {
          kind: 'json',
          bytes: utf8(canonicalJson(summary)),
          mediaType: 'application/json',
          description: 'Canonical JSON summary of the JSON-RPC reads (block, calls, decoded results)',
        },
      ],
      transformations: [
        'ABI-decoded results of eth_call reads pinned to one block; raw JSON-RPC answers are in the fetch provenance',
        'text records stripped of control characters and capped at 2 KB',
        ...(env.redaction.secrets
          ? [
              `${env.redaction.secrets} secret(s) redacted in memory (${[...env.redaction.kinds].toSorted().join(', ')})`,
            ]
          : []),
      ],
      technical: {
        method: 'http',
        startedAt,
        redirects: [],
        ...(env.redaction.secrets
          ? {
              redaction: {
                secrets: env.redaction.secrets,
                kinds: [...env.redaction.kinds].toSorted(),
                originalSha256: last?.provenance.body.sha256 ?? '',
              },
            }
          : {}),
        software: [
          { name: '@olcys/collectors', version: COLLECTORS_VERSION },
          { name: 'parser:ens', version: ENS_PARSER_VERSION },
        ],
        transformations: ['JSON-RPC calls through the egress client; no CCIP-Read, no indexer'],
        notes,
      },
    },
    ctx,
  );
  rb.addPage({ status, capture, notes: [] });
  if (status === 'ok') reads?.emit(capture);
  else if (status === 'not_found') rb.affirmNotFound(`ens ${resource}`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Control characters out, 2 KB cap, then secrets (seed phrase, private key) masked in memory before any use. */
function clip(env: Env, value: string): string {
  const result = env.http.deps.redactor.redact(cleanRecord(value));
  env.redaction.secrets += result.findings.length;
  for (const finding of result.findings) env.redaction.kinds.add(finding.kind);
  return result.text;
}

/** Reads the manager statements of a name; observations are added by the returned emitter. */
async function readName(env: Env, reader: EnsReader, name: string, block: bigint) {
  const summary: Record<string, unknown> = {};
  const forward = await reader.address(name, 60, block);
  summary['addr.60'] = forward;
  const coins: { symbol: string; coinType: number; address: string }[] = [];
  for (const coin of ENS_COIN_TYPES) {
    // Sequential on purpose: one request at a time per source.
    // oxlint-disable-next-line no-await-in-loop
    const raw = await reader.address(name, coin.coinType, block);
    if (!raw) continue;
    const decoded = decodeCoinAddress(coin.coinType, fromHex(raw));
    summary[`addr.${coin.coinType}`] = decoded ?? null;
    if (decoded) coins.push({ symbol: coin.symbol, coinType: coin.coinType, address: decoded });
    else env.rb.note('unsupported_input', `coin type ${coin.coinType}: record is not a plain address`);
  }
  const texts: { key: string; value: string }[] = [];
  for (const key of env.textKeys) {
    // oxlint-disable-next-line no-await-in-loop
    const value = await reader.text(name, key, block);
    summary[`text.${key}`] = value === null ? null : clip(env, value);
    if (value) texts.push({ key, value: clip(env, value) });
  }
  return { forward, coins, texts, summary };
}

async function lookupName(env: Env, raw: string, via: 'input' | 'protocol_lookup'): Promise<void> {
  const normalised = normaliseEnsName(raw);
  if (!normalised.ok) {
    env.rb.note('unsupported_input', `ens name refused: ${normalised.reason}`);
    return;
  }
  const name = normalised.name;
  await withSubject(env, `name/${name}`, async (reader, block) => {
    const read = await readName(env, reader, name, block.number);
    // Reverse check: only an address whose primary name is this name makes the binding verifiable.
    let verified = false;
    if (read.forward) {
      const primary = await reader.primaryName(read.forward, block.number);
      read.summary['reverse.60'] = primary === null ? null : clip(env, primary);
      verified =
        primary !== null &&
        normaliseEnsName(primary).ok &&
        (normaliseEnsName(primary) as { name: string }).name === name;
    }
    return {
      found: Boolean(read.forward || read.coins.length || read.texts.length),
      summary: read.summary,
      emit: (capture) => emitName(env, capture, name, read, verified, via),
    };
  });
}

function emitName(
  env: Env,
  capture: Capture,
  name: string,
  read: Awaited<ReturnType<typeof readName>>,
  verified: boolean,
  via: 'input' | 'protocol_lookup',
): void {
  const { rb } = env;
  const key = `ens:${name}`;
  const subject = { type: 'account' as const, key };
  rb.account({
    platform: 'ens',
    handle: name,
    platformUserId: toHex(namehash(name)),
    // A reference, never fetched.
    profileUrl: ensProfileUrl(name),
    profileCaptureId: capture.id,
    discoveredVia: { sourceId: ENS_SOURCE_ID, method: via, captureId: capture.id },
  });
  if (read.forward) {
    rb.observe(capture, subject, 'profile.ens_address', read.forward, `${key}#addr.60`);
    if (verified) {
      const owner = { type: 'address' as const, key: `evm:1:${read.forward.toLowerCase()}` };
      rb.observe(capture, subject, 'ens.verified_address', read.forward, `${key}#verified.60`);
      rb.observe(capture, owner, 'ens.primary_name', name, `ens:addr=${read.forward.toLowerCase()}#reverse.60`);
      rb.observe(
        capture,
        owner,
        'computed.ens.forward_verified',
        'true',
        `ens:addr=${read.forward.toLowerCase()}#reverse.60`,
      );
    }
  }
  for (const coin of read.coins) {
    rb.observe(capture, subject, `profile.ens_${coin.symbol}_address`, coin.address, `${key}#addr.${coin.coinType}`);
  }
  for (const text of read.texts) {
    rb.observe(capture, subject, `ens.text.${text.key}`, text.value, `${key}#text.${text.key}`);
    const link = SOCIAL_LINKS[text.key];
    const handle = text.value.replace(/^@/, '');
    if (link && SOCIAL_HANDLE.test(handle))
      rb.observe(capture, subject, 'account.link', link(handle), `${key}#text.${text.key}`);
    else if (text.key === 'url' && /^https?:\/\/[^\s]+$/i.test(text.value)) {
      rb.observe(capture, subject, 'account.link', text.value, `${key}#text.${text.key}`);
    }
  }
}

async function lookupAddress(env: Env, address: string): Promise<void> {
  await withSubject(env, `address/${address}`, async (reader, block) => {
    const owner = { type: 'address' as const, key: `evm:1:${address}` };
    const rawName = await reader.primaryName(address, block.number);
    const summary: Record<string, unknown> = { 'reverse.60': rawName === null ? null : clip(env, rawName) };
    if (!rawName) return { found: false, summary, emit: () => undefined };
    const normalised = normaliseEnsName(rawName);
    const locator = `ens:addr=${address}#reverse.60`;
    if (!normalised.ok) {
      return {
        found: true,
        summary,
        emit: (capture) => {
          env.rb.observe(capture, owner, 'ens.primary_name', clip(env, rawName), locator);
          env.rb.observe(capture, owner, 'computed.ens.forward_verified', 'false', locator);
          env.rb.note('unsupported_input', `ens primary name not resolvable here: ${normalised.reason}`);
        },
      };
    }
    const name = normalised.name;
    const forward = await reader.address(name, 60, block.number);
    summary['addr.60'] = forward;
    const verified = forward !== null && forward.toLowerCase() === address;
    if (!verified) {
      return {
        found: true,
        summary,
        emit: (capture) => {
          env.rb.observe(capture, owner, 'ens.primary_name', name, locator);
          env.rb.observe(capture, owner, 'computed.ens.forward_verified', 'false', locator);
          env.rb.note('unsupported_input', `ens primary name ${name} is not forward-verified: no account created`);
        },
      };
    }
    const read = await readName(env, reader, name, block.number);
    return {
      found: true,
      summary: { ...summary, ...read.summary },
      // The forward address is the queried one, so emitName's reverse observations describe it.
      emit: (capture) => emitName(env, capture, name, read, true, 'protocol_lookup'),
    };
  });
}
