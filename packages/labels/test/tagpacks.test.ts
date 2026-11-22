import { describe, expect, it } from 'vitest';
import { parseActorPack, parseConfidenceCsv, parseTagPack } from '../src/index.ts';
import { ctxFor, fixture } from './importers-helpers.ts';

const confidence = parseConfidenceCsv(fixture('confidence.synthetic.csv'));
const ctx = ctxFor('graphsense-tagpacks', 'abc1234');

describe('GraphSense TagPacks', () => {
  it('maps header defaults and tag overrides, skips unsupported currencies with a warning', () => {
    const { rows, warnings } = parseTagPack(fixture('tagpack.synthetic.yaml'), ctx, { actors: new Map(), confidence });
    expect(rows.map((r) => [r.address.chain, r.category, r.confidence, r.provenance.url])).toEqual([
      ['bitcoin', 'exchange', 100, 'https://tagpacks.example/synthetic/1'],
      ['evm:1', 'defi_dex', 20, 'https://tagpacks.example/synthetic/2'],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ZEC');
    expect(rows[0]?.provenance).toMatchObject({
      license: 'MIT',
      deciding: true,
      sourceType: 'graphsense_tagpack',
      version: 'abc1234',
    });
    expect(rows[1]?.provenance.lastmod).toBe('2026-11-12T00:00:00.000Z');
  });

  it('ends an actor at end_activity, maps p2p actors and skips non-public packs', () => {
    const actors = parseActorPack(fixture('actorpack.synthetic.yaml'));
    const { rows } = parseTagPack(fixture('tagpack-actor.synthetic.yaml'), ctx, { actors, confidence });
    expect(rows[0]).toMatchObject({ entity: 'Wygasła Giełda (SYNTHETIC)', category: 'exchange' });
    expect(rows[0]?.attributes.activeTo).toBe('2026-08-27');
    expect(rows[1]).toMatchObject({ category: 'p2p_exchange' });
    expect(rows[1]?.attributes.activeTo).toBeUndefined();
    const priv = parseTagPack(fixture('tagpack-private.synthetic.yaml'), ctx, { actors, confidence });
    expect(priv.rows).toEqual([]);
  });

  it('uses 10 with a warning for an unknown confidence id', () => {
    const yaml = `title: t\ncurrency: BTC\ncategory: exchange\nconfidence: mystery\ntags:\n  - {address: bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq, label: X, source: https://x.example}\n`;
    const { rows, warnings } = parseTagPack(yaml, ctx, { actors: new Map(), confidence });
    expect(rows[0]?.confidence).toBe(10);
    expect(warnings.join()).toContain('mystery');
  });

  it('falls back to the header label and source', () => {
    const yaml = `title: t\ncurrency: BTC\ncategory: exchange\nconfidence: ownership\nlabel: Header Label (SYNTHETIC)\nsource: https://header.example/pack\ntags:\n  - {address: bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq}\n`;
    const { rows } = parseTagPack(yaml, ctx, { actors: new Map(), confidence });
    expect(rows[0]).toMatchObject({ entity: 'Header Label (SYNTHETIC)' });
    expect(rows[0]?.provenance.url).toBe('https://header.example/pack');
    const noSource = parseTagPack(yaml.replace(/source: .*\n/, ''), ctx, { actors: new Map(), confidence });
    expect(noSource.rows[0]?.provenance.url).toBe(ctx.url);
  });

  it('keeps tags without a known category non-deciding', () => {
    const yaml = `title: t\ncurrency: BTC\nconfidence: ownership\ntags:\n  - {address: bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq, label: A (SYNTHETIC), source: https://x.example}\n  - {address: bc1qppppppppppppppppppppppppppppppppppppp, label: B (SYNTHETIC), category: brand_new, source: https://x.example}\n  - {address: bc1qzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz, label: C (SYNTHETIC), category: exchange, source: https://x.example}\n`;
    const { rows, warnings } = parseTagPack(yaml, ctx, { actors: new Map(), confidence });
    expect(rows.map((r) => [r.category, r.provenance.deciding])).toEqual([
      ['unknown_service', false],
      ['unknown_service', false],
      ['exchange', true],
    ]);
    expect(warnings).toHaveLength(2);
  });
});
