import { describe, expect, it } from 'vitest';
import { stixScoId, toCsv, toMispEvent, toStixBundle, TLP_MARKINGS } from '../src/index.ts';
import { A, exportData, referenceUuidV5 } from './export-fixtures.ts';

type Obj = Record<string, any>;
const opts = { producerName: 'OŁCyŚ (test)', tlp: 'amber' as const };
const parse = (json: string): { id: string; objects: Obj[] } => JSON.parse(json);
const ofType = (objects: Obj[], type: string) => objects.filter((o) => o.type === type);
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const STIX_ID = /^[a-z0-9-]+--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('STIX 2.1 export', () => {
  const { json, objectCount } = toStixBundle({ data: exportData() }, opts);
  const bundle = parse(json);

  it('holds the accepted links only: producer, subject, wallets, relationships, report, marking', () => {
    const o = bundle.objects;
    expect(objectCount).toBe(o.length);
    const identities = ofType(o, 'identity');
    expect(identities.map((i) => i.identity_class).toSorted()).toEqual(['individual', 'system']);
    expect(identities.find((i) => i.identity_class === 'system')?.name).toBe('OŁCyŚ (test)');
    expect(identities.find((i) => i.identity_class === 'individual')?.name).toBe('fikcyjny_kacper');
    expect(ofType(o, 'cryptocurrency-wallet').map((w) => w.value)).toEqual(
      expect.arrayContaining([A.BTC1, A.TRON1, A.ETH2]),
    );
    expect(ofType(o, 'cryptocurrency-wallet')).toHaveLength(3);
    expect(ofType(o, 'relationship').map((r) => r.confidence)).toEqual([99, 66, 24]);
    expect(ofType(o, 'relationship').every((r) => r.relationship_type === 'related-to')).toBe(true);
    expect(ofType(o, 'report')).toHaveLength(1);
    expect(ofType(o, 'marking-definition')).toEqual([expect.objectContaining({ id: TLP_MARKINGS.amber.id })]);
    expect(TLP_MARKINGS.amber.id).toBe('marking-definition--f88d31f6-486f-44da-b317-01333bde0b82');
    const values = JSON.stringify(o);
    expect(values).not.toContain(A.ETH1);
    expect(values).not.toContain(A.TRON2);
  });

  it('adds rejected links on request, flagged as rejected', () => {
    const all = parse(toStixBundle({ data: exportData() }, { ...opts, includeRejected: true }).json);
    expect(ofType(all.objects, 'cryptocurrency-wallet')).toHaveLength(5);
    const rejected = ofType(all.objects, 'relationship').filter((r) => r.x_olcys_rejected === true);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => typeof r.x_olcys_rejection_reason === 'string' && r.confidence === 0)).toBe(true);
  });

  it('derives SCO ids per STIX section 2.9 and is byte-identical on re-export', () => {
    const ns = '00abedb4-aa42-466c-9c01-fed23315a9b7';
    expect(stixScoId('cryptocurrency-wallet', { value: A.BTC1 })).toBe(
      `cryptocurrency-wallet--${referenceUuidV5(ns, `{"value":"${A.BTC1}"}`)}`,
    );
    const wallet = ofType(bundle.objects, 'cryptocurrency-wallet').find((w) => w.value === A.BTC1);
    expect(wallet?.id).toBe(stixScoId('cryptocurrency-wallet', { value: A.BTC1 }));
    expect(toStixBundle({ data: exportData() }, opts).json).toBe(json);
  });

  it('is structurally valid: ids, millisecond timestamps, required properties, evidence hashes', () => {
    expect(bundle.id).toMatch(STIX_ID);
    const ids = new Set(bundle.objects.map((o) => o.id));
    for (const o of bundle.objects) {
      expect(o.id).toMatch(STIX_ID);
      expect(o.id.startsWith(`${o.type}--`)).toBe(true);
      expect(o.type === 'cryptocurrency-wallet' ? '2017-01-20T00:00:00.000Z' : o.created).toMatch(TS);
      expect(o.type === 'cryptocurrency-wallet' ? '2017-01-20T00:00:00.000Z' : (o.modified ?? o.created)).toMatch(TS);
      expect(o.spec_version).toBe('2.1');
    }
    for (const r of ofType(bundle.objects, 'relationship')) {
      expect(ids.has(r.source_ref) && ids.has(r.target_ref)).toBe(true);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
      expect(r.object_marking_refs).toEqual([TLP_MARKINGS.amber.id]);
      expect(r.external_references.length).toBeGreaterThan(0);
      for (const ref of r.external_references) expect(ref.hashes['SHA-256']).toMatch(/^[0-9a-f]{64}$/);
    }
    const report = ofType(bundle.objects, 'report')[0]!;
    expect(report.published).toMatch(TS);
    expect(report.name).toBe('Raport OŁCyŚ: Kacper Fikcyjny (dane syntetyczne)');
    for (const ref of report.object_refs) expect(ids.has(ref)).toBe(true);
    const marking = ofType(bundle.objects, 'marking-definition')[0]!;
    expect(marking).toMatchObject({ definition_type: 'tlp', name: 'TLP:AMBER', definition: { tlp: 'amber' } });
    expect(marking.created).toMatch(TS);
  });

  it('records an analyst judgement as an opinion on its relationship', () => {
    const opinions = ofType(bundle.objects, 'opinion');
    expect(opinions).toHaveLength(1);
    const rel = ofType(bundle.objects, 'relationship').find((r) => r.x_olcys_link_assessment_id === 'link-btc1')!;
    expect(opinions[0]).toMatchObject({ opinion: 'agree', object_refs: [rel.id], authors: ['analityk-testowy'] });
    expect(opinions[0]!.created).toMatch(TS);
    expect(rel.target_ref).toBe(stixScoId('cryptocurrency-wallet', { value: A.BTC1 }));
  });

  it('maps not_same and unsure judgements', () => {
    const data = exportData();
    data.judgements = [
      { ...data.judgements![0]!, id: 'j2', judgement: 'not_same' },
      { ...data.judgements![0]!, id: 'j3', judgement: 'unsure', linkAssessmentId: 'link-eth2' },
    ];
    const opinions = ofType(parse(toStixBundle({ data }, opts).json).objects, 'opinion');
    expect(opinions.map((o) => o.opinion).toSorted()).toEqual(['disagree', 'neutral']);
  });

  it('honours the TLP level', () => {
    const red = parse(toStixBundle({ data: exportData() }, { ...opts, tlp: 'red' }).json);
    expect(ofType(red.objects, 'marking-definition')[0]!.id).toBe(TLP_MARKINGS.red.id);
  });

  it('never exports a cluster association as ownership', () => {
    const data = exportData();
    const base = data.links.find((l) => l.id === 'link-btc1')!;
    const clustered = '1ClusterLeadOnlyAddress000000000000000';
    data.links.push({
      ...base,
      id: 'link-cluster',
      address: { chain: 'bitcoin', address: clustered },
      relation: 'CLUSTER_ASSOCIATED',
    });
    const plain = toStixBundle({ data }, opts).json;
    expect(plain).not.toContain(clustered);
    expect(toMispEvent({ data }, { tlp: 'amber' }).json).not.toContain(clustered);
    expect(toCsv('csv_links', { data })).not.toContain(clustered);
    const withRejected = parse(toStixBundle({ data }, { ...opts, includeRejected: true }).json);
    const rel = ofType(withRejected.objects, 'relationship').find((r) => r.x_olcys_relation === 'CLUSTER_ASSOCIATED');
    expect(rel).toMatchObject({ x_olcys_rejected: true, x_olcys_rejection_reason: 'CLUSTER_ASSOCIATED' });
  });
});
