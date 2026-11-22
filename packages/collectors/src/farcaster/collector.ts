/**
 * Farcaster (Network State Protocol) verified addresses, read from a Snapchain node's HTTP API (keyless, AMBER: the
 * node sees every queried fname or FID, so a self-hosted node is recommended). The Ethereum claim signature is
 * re-checked locally: `computed.claim_signature_check` is OŁCyŚ's own computation, `verification.*` are the node's
 * facts. Only identity data and verifications are read (no casts, follows or reactions).
 */
import type { AccountDiscoveryMethod, Capture, CollectorInput, SourceCollector } from '@olcys/core';
import type { CollectorFactory } from '../framework/collector-registry.ts';
import { createSourceHttp } from '../framework/http.ts';
import { ResultBuilder } from '../framework/result.ts';
import { recogniseAccountUrl } from '../framework/urls.ts';
import { HANDLE_KINDS, namesPages } from '../platforms/common.ts';
import { registryFetch } from '../registries/common.ts';
import {
  parseUserData,
  parseUserNameProof,
  parseVerifications,
  type FarcasterUserData,
  type FarcasterVerification,
} from './parse.ts';

export const FARCASTER_PARSER_VERSION = 'farcaster.v1';
export const FARCASTER_DEFAULT_HUB = 'https://haatz.quilibrium.com';
const SOFTWARE = [{ name: 'parser:farcaster', version: FARCASTER_PARSER_VERSION }];
const FNAME = /^[a-z0-9][a-z0-9-]{0,15}$|^[a-z0-9-]+\.eth$/;

export interface FarcasterOptions {
  /** Snapchain node (default the public node; self-hosted: `http://<host>:3381` plus `OLCYS_SOURCE_HOSTS_FARCASTER`). */
  hubUrl?: string;
  /** Pages of verifications (100 each) read at most (default 5). */
  maxVerificationPages?: number;
}

interface Target {
  kind: 'fid' | 'fname';
  value: string;
  method: AccountDiscoveryMethod;
}

function targets(input: CollectorInput): Target[] {
  if (namesPages(input)) return [];
  const out: Target[] = [];
  const add = (raw: string, method: AccountDiscoveryMethod): void => {
    const text = raw.trim().replace(/^@+/, '').replace(/^fid:/i, '');
    const lower = text.toLowerCase();
    const target: Target | undefined = /^\d{1,12}$/.test(text)
      ? { kind: 'fid', value: text, method }
      : FNAME.test(lower)
        ? { kind: 'fname', value: lower, method }
        : undefined;
    if (target && !out.some((t) => t.value === target.value)) out.push(target);
  };
  for (const account of input.accounts) {
    if (account.platform !== 'farcaster') continue;
    if (account.platformUserId && /^\d+$/.test(account.platformUserId))
      add(account.platformUserId, account.discoveredVia.method);
    else add(account.handle, account.discoveredVia.method);
  }
  for (const identifier of input.identifiers) {
    if (identifier.platform !== 'farcaster' || !HANDLE_KINDS.includes(identifier.kind)) continue;
    const url = recogniseAccountUrl(identifier.value.trim());
    add(url?.platform === 'farcaster' && url.handle ? url.handle : identifier.value, 'input');
  }
  return out;
}

export function createFarcasterCollector(options: FarcasterOptions = {}): CollectorFactory {
  const hub = (options.hubUrl ?? FARCASTER_DEFAULT_HUB).replace(/\/+$/, '');
  const maxPages = Math.max(1, options.maxVerificationPages ?? 5);
  return {
    sourceId: 'farcaster',
    platform: 'farcaster',
    create(descriptor, deps): SourceCollector {
      return {
        descriptor,
        supports: (input) => targets(input).length > 0,
        async collect(input, ctx) {
          const rb = new ResultBuilder(ctx, descriptor.id, deps.redactor);
          const wanted = targets(input);
          if (!wanted.length) {
            rb.note('unsupported_input', 'no Farcaster fname or FID');
            return rb.build();
          }
          const http = createSourceHttp({ descriptor, ctx, deps, input });
          const get = async (path: string, purpose: string, notFound: string) => {
            const answer = await registryFetch(http, {
              url: `${hub}${path}`,
              purpose,
              software: SOFTWARE,
              notJsonNote: { code: 'fetch_error', detail: 'the Farcaster node answer is not JSON' },
              classify: (json, httpStatus) => {
                const code = (json as { errCode?: unknown } | null)?.['errCode'];
                return code === 'not_found' || httpStatus === 404
                  ? { status: 'not_found', reason: notFound }
                  : undefined;
              },
            });
            rb.addPage({
              status: answer.status,
              ...(answer.capture ? { capture: answer.capture } : {}),
              notes: answer.notes,
            });
            return answer;
          };
          for (const target of wanted) {
            if (http.stopped()) break;
            let fid = target.kind === 'fid' ? target.value : undefined;
            let fname = target.kind === 'fname' ? target.value : undefined;
            let owner: string | undefined;
            let proofCapture: Capture | undefined;
            if (!fid) {
              // Sequential on purpose: one request at a time per source.
              // oxlint-disable-next-line no-await-in-loop
              const proofAnswer = await get(
                `/v1/userNameProofByName?name=${encodeURIComponent(target.value)}`,
                'farcaster fname lookup',
                `no Farcaster fname ${target.value}`,
              );
              if (proofAnswer.status === 'not_found') rb.affirmNotFound(`farcaster fname ${target.value}`);
              const proof = proofAnswer.status === 'ok' ? parseUserNameProof(proofAnswer.json) : undefined;
              if (!proof) continue;
              fid = proof.fid;
              owner = proof.owner;
              proofCapture = proofAnswer.capture;
            }
            // oxlint-disable-next-line no-await-in-loop
            const dataAnswer = await get(
              `/v1/userDataByFid?fid=${fid}`,
              'farcaster profile data',
              `no Farcaster fid ${fid}`,
            );
            if (dataAnswer.status === 'not_found') rb.affirmNotFound(`farcaster fid ${fid}`);
            const profile = dataAnswer.status === 'ok' ? parseUserData(dataAnswer.json) : [];
            fname ??= profile.find((d) => d.type === 'username')?.value;
            const verifications: FarcasterVerification[] = [];
            let verificationCapture: Capture | undefined;
            let pageToken: string | undefined;
            for (let page = 0; page < maxPages; page += 1) {
              if (http.stopped()) break;
              // oxlint-disable-next-line no-await-in-loop
              const answer = await get(
                `/v1/verificationsByFid?fid=${fid}&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
                'farcaster verifications',
                `no verifications for Farcaster fid ${fid}`,
              );
              if (answer.status !== 'ok') break;
              verificationCapture ??= answer.capture;
              const parsed = parseVerifications(answer.json);
              verifications.push(...parsed.items);
              pageToken = parsed.nextPageToken;
              if (!pageToken) break;
              if (page === maxPages - 1) {
                rb.note('truncated', `Farcaster verifications of fid ${fid} cut off after ${maxPages} page(s)`);
                rb.addStatus('error');
              }
            }
            const capture = verificationCapture ?? dataAnswer.capture ?? proofCapture;
            if (capture && (dataAnswer.status === 'ok' || verifications.length || proofCapture))
              observe(
                rb,
                capture,
                descriptor.id,
                { fid, ...(fname ? { fname } : {}), owner, profile, verifications },
                target.method,
              );
          }
          return rb.build();
        },
      };
    },
  };
}

interface Found {
  fid: string;
  fname?: string;
  owner?: string;
  profile: FarcasterUserData[];
  verifications: FarcasterVerification[];
}

function observe(
  rb: ResultBuilder,
  capture: Capture,
  sourceId: string,
  found: Found,
  method: AccountDiscoveryMethod,
): void {
  const key = `farcaster:${found.fid}`;
  const subject = { type: 'account' as const, key };
  const display = found.profile.find((d) => d.type === 'display_name')?.value;
  rb.account({
    platform: 'farcaster',
    handle: found.fname ?? `fid:${found.fid}`,
    platformUserId: found.fid,
    profileUrl: found.fname ? `https://farcaster.xyz/${found.fname}` : `https://farcaster.xyz/~/profiles/${found.fid}`,
    profileCaptureId: capture.id,
    ...(display ? { displayName: display } : {}),
    discoveredVia: { sourceId, method: method === 'input' ? 'input' : 'protocol_lookup', captureId: capture.id },
  });
  const fact = (property: string, value: string | undefined, path: string): void => {
    if (value) rb.observe(capture, subject, property, value, `farcaster:fid=${found.fid}#${path}`);
  };
  fact('profile.username', found.fname, 'profile.username');
  fact('account.custody_address', found.owner, 'account.custody_address');
  for (const entry of found.profile) {
    if (entry.type === 'username' || entry.type === 'pfp') continue;
    fact(`profile.${entry.type}`, entry.value, `profile.${entry.type}`);
  }
  const github = found.profile.find((d) => d.type === 'github')?.value;
  if (github && /^[A-Za-z0-9-]{1,39}$/.test(github)) {
    rb.observe(
      capture,
      subject,
      'account.link',
      `https://github.com/${github}`,
      `farcaster:fid=${found.fid}#link.github`,
    );
  }
  for (const v of found.verifications) {
    const prefix = v.chain === 'solana' ? 'sol' : 'eth';
    const at = `farcaster:fid=${found.fid}#`;
    const loc = (property: string): string => `${at}${property}[${v.address}]`;
    rb.observe(capture, subject, `verification.${prefix}_address`, v.address, loc(`verification.${prefix}_address`));
    if (v.addedAt) rb.observe(capture, subject, 'verification.added_at', v.addedAt, loc('verification.added_at'));
    if (v.messageHash)
      rb.observe(capture, subject, 'verification.message_hash', v.messageHash, loc('verification.message_hash'));
    rb.observe(capture, subject, 'computed.claim_signature_check', v.check, loc('computed.claim_signature_check'));
  }
}
