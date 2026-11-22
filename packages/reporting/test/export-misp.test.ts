import { describe, expect, it } from 'vitest';
import { ICD203_SCALE, likelihoodValue, toMispEvent } from '../src/index.ts';
import definition from '../src/export/misp/coin-address.definition.json' with { type: 'json' };
import estimative from '../src/export/misp/estimative-language.json' with { type: 'json' };
import { A, exportData } from './export-fixtures.ts';

type Obj = Record<string, any>;
const event = (JSON.parse(toMispEvent({ data: exportData() }, { tlp: 'amber' }).json) as { Event: Obj }).Event;

const tagsOf = (value: string) =>
  (event.Object as Obj[])
    .flatMap((o) => o.Attribute as Obj[])
    .find((a) => a.value === value)!
    .Tag.map((t: Obj) => t.name);

describe('MISP export', () => {
  it('is a never-published, unshared event tagged TLP:AMBER', () => {
    expect(event).toMatchObject({ distribution: '0', published: false, threat_level_id: '4', analysis: '1' });
    expect(event.Tag).toEqual([{ name: 'tlp:amber' }]);
    expect(event.date).toBe('2026-11-21');
    expect(event.info).toBe('OŁCyŚ: Kacper Fikcyjny (dane syntetyczne) — przebieg run-0002');
  });

  it('has one coin-address object per accepted link from the vendored template', () => {
    const objects = event.Object as Obj[];
    expect(objects).toHaveLength(3);
    expect(definition.uuid).toBe('d0e6997e-78da-4815-a6a1-cfc1c1cb8a46');
    expect(definition.version).toBe(7);
    for (const o of objects) {
      expect(o).toMatchObject({
        name: 'coin-address',
        template_uuid: definition.uuid,
        template_version: String(definition.version),
      });
      for (const a of o.Attribute) expect(Object.keys(definition.attributes)).toContain(a.object_relation);
    }
    const byAddress = (value: string) => objects.find((o) => o.Attribute.some((a: Obj) => a.value === value))!;
    const btc = byAddress(A.BTC1).Attribute.find((a: Obj) => a.object_relation === 'address');
    expect(btc.type).toBe('btc');
    const eth = byAddress(A.ETH2).Attribute.find((a: Obj) => a.value === A.ETH2);
    expect(eth).toMatchObject({ type: 'text', object_relation: 'address-crypto' });
  });

  it('tags address attributes with Admiralty and estimative-language values of the vendored taxonomy', () => {
    expect(tagsOf(A.BTC1)).toEqual(
      expect.arrayContaining([
        'estimative-language:likelihood-probability="almost-certain"',
        'estimative-language:confidence-in-analytic-judgment="high"',
      ]),
    );
    expect(tagsOf(A.TRON1)).toContain('estimative-language:likelihood-probability="likely"');
    expect(tagsOf(A.ETH2)).toContain('estimative-language:likelihood-probability="unlikely"');
    expect(tagsOf(A.BTC1).some((t: string) => /^admiralty-scale:source-reliability="[a-f]"$/.test(t))).toBe(true);
  });

  it('maps every ICD 203 term to a taxonomy value', () => {
    const values = estimative.values
      .find((v) => v.predicate === 'likelihood-probability')!
      .entry.map((e) => [e.value, e.numerical_value]);
    expect(values).toEqual([
      ['almost-no-chance', 0],
      ['very-unlikely', 5],
      ['unlikely', 20],
      ['roughly-even-chance', 45],
      ['likely', 55],
      ['very-likely', 80],
      ['almost-certain', 95],
    ]);
    for (const { term } of ICD203_SCALE) expect(values.map(([v]) => v)).toContain(likelihoodValue(term));
    expect(likelihoodValue('not assessed')).toBeUndefined();
  });

  it('adds one link attribute per evidence URL with the manifest hash', () => {
    const links = (event.Attribute as Obj[]).filter((a) => a.type === 'link');
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links.map((a) => a.value)).size).toBe(links.length);
    for (const a of links) {
      expect(a).toMatchObject({ category: 'External analysis', to_ids: false });
      expect(a.comment).toMatch(/^[0-9a-f]{64}(;[0-9a-f]{64})*$/);
    }
  });

  it('is byte-identical on re-export', () => {
    expect(toMispEvent({ data: exportData() }, { tlp: 'amber' }).json).toBe(
      toMispEvent({ data: exportData() }, { tlp: 'amber' }).json,
    );
  });
});
