/**
 * Nostr NIP-05 lookup: `GET https://<domain>/.well-known/nostr.json?name=<name>` (redirects are never followed, as
 * NIP-05 requires) identifies the public key behind `name@domain`. NIP-05 only identifies a key, it does not prove the
 * holder is the subject, and the domain's operator sees the queried name. Relays are not contacted (they speak
 * WebSocket only and the egress client has no such exchange), so the key's own profile (kind 0) is not read here;
 * relay hints from the answer are recorded as facts and never contacted. The domain is dynamic: it must be allowed by
 * the deployment (`OLCYS_SOURCE_HOSTS_NOSTR`); the plain e-mail of a case is never turned into a NIP-05 query.
 */
import type { CollectorInput, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { HANDLE_KINDS, namesPages } from '../platforms/common.ts';
import { asArray, asObject, asText, registryFetch } from '../registries/common.ts';
import { npubEncode, parseNip05, type Nip05 } from './nip05.ts';

export const NOSTR_PARSER_VERSION = 'nostr.v1';
const SOFTWARE = [{ name: 'parser:nostr', version: NOSTR_PARSER_VERSION }];
const RELAY = /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i;

export function nip05Url(id: Nip05): string {
  return `https://${id.domain}/.well-known/nostr.json?name=${encodeURIComponent(id.name)}`;
}

/** Key and relay hints of a NIP-05 answer for `name`; undefined when the name is absent or its key malformed. */
export function parseNip05Answer(json: unknown, name: string): { pubkey: string; relays: string[] } | undefined {
  const root = asObject(json);
  const pubkey = asText(asObject(root?.['names'])?.[name]);
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return undefined;
  const relays = asArray(asObject(root?.['relays'])?.[pubkey])
    .map((r) => asText(r))
    .filter((r): r is string => !!r && RELAY.test(r));
  return { pubkey, relays: [...new Set(relays)] };
}

function targets(input: CollectorInput): Nip05[] {
  if (namesPages(input)) return [];
  const out: Nip05[] = [];
  const add = (raw: string): void => {
    const id = parseNip05(raw.replace(/^nostr:/i, ''));
    if (id && !out.some((o) => o.name === id.name && o.domain === id.domain)) out.push(id);
  };
  for (const account of input.accounts) if (account.platform === 'nostr') add(account.handle);
  // Only an identifier the case ties to Nostr: an e-mail address is never turned into a query.
  for (const identifier of input.identifiers) {
    if (identifier.platform === 'nostr' && HANDLE_KINDS.includes(identifier.kind)) add(identifier.value);
  }
  return out;
}

export function createNostrCollector(): CollectorFactory {
  return {
    sourceId: 'nostr',
    platform: 'nostr',
    create(descriptor, deps): SourceCollector {
      return {
        descriptor,
        supports: (input) => targets(input).length > 0,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const wanted = targets(input);
          if (!wanted.length) {
            rb.note('unsupported_input', 'no NIP-05 identifier (name@domain)');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          for (const id of wanted) {
            if (http.stopped()) break;
            const label = `${id.name}@${id.domain}`;
            // Sequential on purpose: one request at a time per source.
            // oxlint-disable-next-line no-await-in-loop
            const answer = await registryFetch(http, {
              url: nip05Url(id),
              purpose: 'nostr nip-05 lookup',
              software: SOFTWARE,
              notJsonNote: { code: 'fetch_error', detail: 'the NIP-05 answer is not JSON' },
              classify: (json, httpStatus) => {
                if (httpStatus >= 300) return undefined;
                return parseNip05Answer(json, id.name)
                  ? undefined
                  : { status: 'not_found', reason: `no NIP-05 name ${label}` };
              },
            });
            if (answer.httpStatus !== undefined && answer.httpStatus >= 300 && answer.httpStatus < 400) {
              // NIP-05 requires ignoring redirects: the answer is not followed and says nothing about the name.
              answer.status = 'not_found';
              answer.notes.push(`not_found: NIP-05 redirect ignored (HTTP ${answer.httpStatus})`);
            }
            rb.addPage({
              status: answer.status,
              ...(answer.capture ? { capture: answer.capture } : {}),
              notes: answer.notes,
            });
            if (answer.status === 'not_found') rb.affirmNotFound(`nostr ${label}`);
            const found = answer.status === 'ok' && answer.capture ? parseNip05Answer(answer.json, id.name) : undefined;
            if (!found || !answer.capture) continue;
            const key = `nostr:${found.pubkey}`;
            const subject = { type: 'account' as const, key };
            const npub = npubEncode(found.pubkey);
            rb.account({
              platform: 'nostr',
              handle: label,
              platformUserId: found.pubkey,
              profileUrl: `nostr:${npub}`,
              profileCaptureId: answer.capture.id,
              discoveredVia: { sourceId: descriptor.id, method: 'input', captureId: answer.capture.id },
            });
            const fact = (property: string, value: string, path: string): void =>
              rb.observe(answer.capture!, subject, property, value, `${key}#${path}`);
            fact('nostr.pubkey', found.pubkey, 'nostr.pubkey');
            fact('nostr.npub', npub, 'nostr.npub');
            fact('nostr.nip05', label, 'nostr.nip05');
            // Relay hints are facts only: a relay that the deployment did not configure is never contacted.
            found.relays.forEach((relay, i) => fact('nostr.relay_hint', relay, `nostr.relay_hint[${i}]`));
          }
          return rb.build();
        },
      };
    },
  };
}
