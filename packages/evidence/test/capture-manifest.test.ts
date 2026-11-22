import { CaptureManifestSchema, canonicalJson } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { ArtifactIntegrityError, InMemoryBlobStore, requiredArtifacts, sha256Hex } from '../src/index.ts';
import { fullDraft, makeContext, makeRecorder } from './helpers.ts';

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

describe('capture recorder', () => {
  it('stores the manifest as a blob whose digest is the capture manifestSha256', async () => {
    const { ctx, blobs } = makeContext();
    const capture = await makeRecorder().record(fullDraft(), ctx);
    const bytes = await blobs.get(capture.manifestSha256);
    const manifest = decode(bytes);
    expect(new TextDecoder().decode(bytes)).toBe(canonicalJson(manifest));
    expect(capture.manifestSha256).toBe(sha256Hex(canonicalJson(manifest)));
    for (const artifact of manifest.artifacts) {
      // oxlint-disable-next-line no-await-in-loop
      expect(sha256Hex(await blobs.get(artifact.sha256))).toBe(artifact.sha256);
    }
    expect(CaptureManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.collector).toMatchObject({
      name: 'analityk-testowy',
      virtualIdentity: null,
      ipSource: 'configured',
    });
    expect(manifest.tools.map((t: { name: string }) => t.name)).toContain('olcys');
    expect(manifest.completeness).toEqual({ required: ['html', 'screenshot'], missing: [] });
    const t = manifest.time;
    expect(t.startedAt <= t.collectedAt && t.collectedAt <= t.endedAt).toBe(true);
    expect(t.startedAt.endsWith('Z')).toBe(true);
    expect(capture).toMatchObject({ collector: 'analityk-testowy', collectorIp: '192.0.2.10', clockSynced: true });
    expect(capture.artifacts.map((a) => a.kind).toSorted()).toEqual(
      ['headers', 'html', 'rendered_html', 'screenshot', 'text'].toSorted(),
    );
  });

  it('is deterministic for the same draft, ids and clock, and sensitive to one changed byte', async () => {
    const a = await makeRecorder().record(fullDraft(), makeContext().ctx);
    const b = await makeRecorder().record(fullDraft(), makeContext().ctx);
    expect(a.manifestSha256).toBe(b.manifestSha256);
    const changed = fullDraft();
    const html = changed.artifacts[0]!;
    if ('bytes' in html) html.bytes = new TextEncoder().encode('<html>profiL</html>');
    const c = await makeRecorder().record(changed, makeContext().ctx);
    expect(c.manifestSha256).not.toBe(a.manifestSha256);
  });

  it('keeps a web page without a screenshot, marks it missing and warns once per run', async () => {
    const { ctx, logger } = makeContext();
    const recorder = makeRecorder({
      ids: ['0190a000-0000-7000-8000-0000000000b1', '0190a000-0000-7000-8000-0000000000b2'],
    });
    const draft = fullDraft({
      artifacts: fullDraft().artifacts.filter((x) => x.kind === 'html' || x.kind === 'headers'),
    });
    const first = await recorder.record(draft, ctx);
    await recorder.record(draft, ctx);
    const manifest = decode(await ctx.blobs.get(first.manifestSha256));
    expect(manifest.completeness.missing).toEqual(['screenshot']);
    expect(logger.warnings).toHaveLength(1);
  });

  it('keeps a blocked capture with the block page', async () => {
    const { ctx } = makeContext();
    const capture = await makeRecorder().record(fullDraft({ status: 'blocked', httpStatus: 403 }), ctx);
    expect(decode(await ctx.blobs.get(capture.manifestSha256)).target.status).toBe('blocked');
  });

  it('re-hashes blobs stored elsewhere and refuses missing or altered ones without writing a manifest', async () => {
    const { ctx, blobs } = makeContext();
    const stored = await blobs.put(new TextEncoder().encode('<html>zapisane</html>'), 'text/html');
    const ok = await makeRecorder().record(
      fullDraft({ artifacts: [{ kind: 'html', blob: stored, description: 'body' }] }),
      ctx,
    );
    expect(ok.artifacts[0]?.blob).toEqual(stored);

    const missing = { ...stored, sha256: 'f'.repeat(64) };
    const empty = makeContext(new InMemoryBlobStore());
    await expect(
      makeRecorder().record(
        fullDraft({ artifacts: [{ kind: 'html', blob: missing, description: 'body' }] }),
        empty.ctx,
      ),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    // A store that returns other bytes than the digest names.
    const lying = {
      put: blobs.put.bind(blobs),
      has: async () => true,
      get: async () => new TextEncoder().encode('inne bajty'),
    };
    const liar = makeContext();
    liar.ctx.blobs = lying;
    await expect(
      makeRecorder().record(fullDraft({ artifacts: [{ kind: 'html', blob: stored, description: 'body' }] }), liar.ctx),
    ).rejects.toMatchObject({ name: 'ArtifactIntegrityError', sha256: stored.sha256 });
  });

  it('defines required artifacts per profile', () => {
    expect(requiredArtifacts('web_page')).toEqual(['html', 'screenshot']);
    expect(requiredArtifacts('archive_snapshot')).toEqual(['html']);
  });

  it('merges technical software and transformations into the manifest without duplicates', async () => {
    const { ctx } = makeContext();
    const capture = await makeRecorder().record(
      fullDraft({
        transformations: ['a', 'b'],
        technical: {
          method: 'http',
          startedAt: '2026-11-21T11:59:58.000Z',
          redirects: [],
          software: [
            { name: 'olcys', version: '0.0.0-test' },
            { name: 'parser:x', version: '1' },
          ],
          transformations: ['b', 'c'],
          notes: [],
        },
      }),
      ctx,
    );
    const manifest = decode(await ctx.blobs.get(capture.manifestSha256));
    expect(manifest.transformations).toEqual(['a', 'b', 'c']);
    expect(manifest.tools.filter((t: { name: string }) => t.name === 'olcys')).toHaveLength(1);
    expect(manifest.technical).not.toHaveProperty('software');
  });
});
