/**
 * Keybase public lookup API (`user/lookup`, keyless): the signed `cryptocurrency_addresses` of a user name and the
 * verified proofs that link the account to other services. The `sig_id` proves that the account's own sigchain key
 * made the claim, not that the address's key did; the claim still only counts through the normal scoring.
 * One user name per request, minimal `fields`, no login. The service is in maintenance mode: an answer that is not
 * the documented JSON is an error, never "not found".
 */
import type { Capture, CollectorInput, OnlineAccount, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { KEYBASE_USERNAME, recogniseAccountUrl } from '../framework/urls.ts';
import { HANDLE_KINDS, namesPages } from '../platforms/common.ts';
import { asArray, asObject, asText, registryFetch } from '../registries/common.ts';

export { KEYBASE_USERNAME };
export const KEYBASE_PARSER_VERSION = 'keybase.v1';
const SOFTWARE = [{ name: 'parser:keybase', version: KEYBASE_PARSER_VERSION }];
export const KEYBASE_FIELDS = 'basics,profile,proofs_summary,cryptocurrency_addresses';
/** Keybase's proof-state enum: 1 = OK (the proof was found and verified). */
export const KEYBASE_PROOF_OK = 1;

export interface KeybaseLookupUser {
  id: string;
  username: string;
  fullName?: string;
  location?: string;
  bio?: string;
  createdAt?: string;
  updatedAt?: string;
  addresses: { coin: string; address: string; sigId: string }[];
  proofs: {
    proofType: string;
    nametag: string;
    state: number;
    sigId: string;
    serviceUrl?: string;
    proofUrl?: string;
  }[];
}

export interface KeybaseLookup {
  status: 'ok' | 'not_found' | 'error';
  statusName: string;
  user?: KeybaseLookupUser;
}

const isoFromSeconds = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : undefined;

/** Pure reader of a `user/lookup` answer for one user name. */
export function parseKeybaseLookup(json: unknown): KeybaseLookup {
  const root = asObject(json);
  const status = asObject(root?.['status']);
  const code = status?.['code'];
  const statusName = asText(status?.['name']) ?? 'UNKNOWN';
  if (!root || !status || typeof code !== 'number') return { status: 'error', statusName: 'MALFORMED' };
  if (statusName === 'NOT_FOUND') return { status: 'not_found', statusName };
  if (code !== 0) return { status: 'error', statusName };
  const them = root['them'];
  if (!Array.isArray(them)) return { status: 'error', statusName: 'MALFORMED' };
  const entry = them[0];
  if (entry === null || entry === undefined) return { status: 'not_found', statusName };
  const me = asObject(entry);
  const basics = asObject(me?.['basics']);
  const id = asText(me?.['id']);
  const username = asText(basics?.['username']);
  if (!me || !id || !username) return { status: 'error', statusName: 'MALFORMED' };
  const profile = asObject(me['profile']);
  const addresses: KeybaseLookupUser['addresses'] = [];
  for (const [coin, list] of Object.entries(asObject(me['cryptocurrency_addresses']) ?? {})) {
    for (const item of asArray(list)) {
      const entryObject = asObject(item);
      const address = asText(entryObject?.['address']);
      const sigId = asText(entryObject?.['sig_id']);
      if (address && sigId) addresses.push({ coin: coin.toLowerCase(), address, sigId });
    }
  }
  const proofs: KeybaseLookupUser['proofs'] = [];
  for (const item of asArray(asObject(me['proofs_summary'])?.['all'])) {
    const proof = asObject(item);
    const proofType = asText(proof?.['proof_type']);
    const nametag = asText(proof?.['nametag']);
    const sigId = asText(proof?.['sig_id']);
    const state = proof?.['state'];
    if (!proof || !proofType || !nametag || !sigId || typeof state !== 'number') continue;
    const serviceUrl = asText(proof['service_url']);
    const proofUrl = asText(proof['proof_url']);
    proofs.push({
      proofType,
      nametag,
      state,
      sigId,
      ...(serviceUrl ? { serviceUrl } : {}),
      ...(proofUrl ? { proofUrl } : {}),
    });
  }
  const fullName = asText(profile?.['full_name']);
  const location = asText(profile?.['location']);
  const bio = asText(profile?.['bio']);
  const createdAt = isoFromSeconds(basics?.['ctime']);
  const updatedAt = isoFromSeconds(basics?.['mtime']);
  return {
    status: 'ok',
    statusName,
    user: {
      id,
      username,
      ...(fullName ? { fullName } : {}),
      ...(location ? { location } : {}),
      ...(bio ? { bio } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      addresses,
      proofs,
    },
  };
}

export function keybaseLookupUrl(username: string): string {
  return `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(username)}&fields=${KEYBASE_FIELDS}`;
}

/** The user name to look up for a nick on another platform, or undefined when Keybase cannot have it. */
export function keybaseProbeHandle(nick: string): string | undefined {
  const name = nick.trim().replace(/^@+/, '').toLowerCase();
  return KEYBASE_USERNAME.test(name) ? name : undefined;
}

/** Logical profile URL of a proven account, by Keybase proof type (never a URL taken from the answer). */
export function proofProfileUrl(proofType: string, nametag: string): string | undefined {
  const name = nametag.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return undefined;
  switch (proofType) {
    case 'github':
      return `https://github.com/${name}`;
    case 'twitter':
      return `https://x.com/${name}`;
    case 'reddit':
      return `https://www.reddit.com/user/${name}`;
    case 'hackernews':
      return `https://news.ycombinator.com/user?id=${name}`;
    case 'generic_web_site':
    case 'dns':
      return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(name) ? `https://${name.toLowerCase()}` : undefined;
    default:
      return undefined;
  }
}

interface Candidate {
  name: string;
  valid: boolean;
}

function candidates(input: CollectorInput): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const add = (raw: string): void => {
    const name = raw.trim().replace(/^@+/, '').toLowerCase();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, valid: KEYBASE_USERNAME.test(name) });
  };
  for (const value of input.values ?? []) {
    if (value.kind === 'username') add(value.value);
    else if (value.kind === 'url') {
      const account = recogniseAccountUrl(value.value);
      if (account?.platform === 'keybase' && account.handle) add(account.handle);
    }
  }
  if (namesPages(input)) return out;
  for (const account of input.accounts) if (account.platform === 'keybase') add(account.handle);
  for (const identifier of input.identifiers) {
    if (identifier.platform === 'keybase' || (HANDLE_KINDS.includes(identifier.kind) && !identifier.platform)) {
      if (HANDLE_KINDS.includes(identifier.kind)) add(identifier.value);
    }
  }
  return out;
}

export function createKeybaseCollector(): CollectorFactory {
  return {
    sourceId: 'keybase',
    platform: 'keybase',
    probeHandle: keybaseProbeHandle,
    accountsAreReferences: true,
    create(descriptor, deps): SourceCollector {
      return {
        descriptor,
        supports: (input) => candidates(input).length > 0,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const targets = candidates(input);
          if (!targets.length) {
            rb.note('unsupported_input', 'no Keybase user name');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          for (const target of targets) {
            if (!target.valid) {
              rb.note('unsupported_input', `not a Keybase user name: ${target.name}`);
              continue;
            }
            if (http.stopped()) break;
            // Sequential on purpose: one request at a time per source.
            // oxlint-disable-next-line no-await-in-loop
            const answer = await registryFetch(http, {
              url: keybaseLookupUrl(target.name),
              purpose: 'keybase user lookup',
              software: SOFTWARE,
              notJsonNote: { code: 'fetch_error', detail: 'the Keybase answer is not JSON (maintenance page?)' },
              classify: (json, httpStatus) => {
                if (httpStatus >= 300) return undefined;
                const parsed = parseKeybaseLookup(json);
                if (parsed.status === 'not_found') {
                  return { status: 'not_found', reason: `no Keybase user ${target.name}` };
                }
                if (parsed.status === 'error') {
                  return { status: 'error', reason: `Keybase answered ${parsed.statusName}`, code: 'fetch_error' };
                }
                return undefined;
              },
            });
            rb.addPage({
              status: answer.status,
              ...(answer.capture ? { capture: answer.capture } : {}),
              notes: answer.notes,
            });
            if (answer.status === 'not_found') rb.affirmNotFound(`keybase user ${target.name}`);
            const parsed = answer.status === 'ok' ? parseKeybaseLookup(answer.json) : undefined;
            if (parsed?.user && answer.capture)
              observeUser(rb, answer.capture, parsed.user, descriptor.id, deps.config.fixture);
          }
          return rb.build();
        },
      };
    },
  };
}

function observeUser(
  rb: ResultBuilder,
  capture: Capture,
  user: KeybaseLookupUser,
  sourceId: string,
  mapping: Parameters<typeof recogniseAccountUrl>[1],
): void {
  const handle = user.username;
  const key = `keybase:${handle.toLowerCase()}`;
  const subject = { type: 'account' as const, key };
  const account: OnlineAccount = rb.account({
    platform: 'keybase',
    handle,
    platformUserId: user.id,
    profileUrl: `https://keybase.io/${handle}`,
    profileCaptureId: capture.id,
    ...(user.fullName ? { displayName: user.fullName } : {}),
    discoveredVia: { sourceId, method: 'input', captureId: capture.id },
  });
  const fact = (property: string, value: string | undefined, path: string): void => {
    if (value) rb.observe(capture, subject, property, value, `${key}#${path}`);
  };
  fact('profile.full_name', user.fullName, 'profile.full_name');
  fact('profile.location', user.location, 'profile.location');
  fact('profile.bio', user.bio, 'profile.bio');
  fact('profile.created_at', user.createdAt, 'basics.ctime');
  fact('profile.updated_at', user.updatedAt, 'basics.mtime');
  const perCoin = new Map<string, number>();
  for (const entry of user.addresses) {
    const index = perCoin.get(entry.coin) ?? 0;
    perCoin.set(entry.coin, index + 1);
    const locator = `${key}#cryptocurrency_addresses.${entry.coin}[${index}]`;
    rb.observe(capture, subject, `verification.${entry.coin}_address`, entry.address, locator);
    rb.observe(capture, subject, `verification.${entry.coin}_sig_id`, entry.sigId, locator);
    // Core has no Zcash chain family yet: the signed address is kept as a fact but cannot be analysed on-chain.
    if (entry.coin === 'zcash') rb.note('unsupported_input', 'zcash: no chain family; recorded as a fact only');
  }
  for (const proof of user.proofs) {
    const locator = `${key}#proof[${proof.sigId}]`;
    rb.observe(capture, subject, 'account.proof', `${proof.proofType}:${proof.nametag}`, locator);
    rb.observe(capture, subject, 'verification.proof_state', String(proof.state), locator);
    rb.observe(capture, subject, 'verification.proof_sig_id', proof.sigId, locator);
    if (proof.state !== KEYBASE_PROOF_OK) continue;
    const url = proofProfileUrl(proof.proofType, proof.nametag);
    if (!url) continue;
    rb.observe(capture, subject, 'account.link', url, locator);
    const recognised = recogniseAccountUrl(url, mapping);
    rb.account({
      platform: recognised?.platform ?? proof.proofType,
      handle: recognised?.handle ?? proof.nametag,
      profileUrl: recognised?.logicalUrl ?? url,
      discoveredVia: { sourceId, method: 'cross_link', captureId: capture.id, fromAccountId: account.id },
    });
  }
}
