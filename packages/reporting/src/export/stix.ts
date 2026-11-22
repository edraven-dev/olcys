/**
 * STIX 2.1 bundle of a report: the subject and the producer as identities, one `cryptocurrency-wallet` observable per
 * exported address (OpenCTI's custom observable, not a core STIX type), `related-to` relationships whose `confidence`
 * is the Wskaźnik Pewności, analyst judgements as `opinion` objects and one `report`. Deterministic: the same report
 * always yields the same bytes.
 */
import { canonicalJson } from '@olcys/core';
import { pl } from '../i18n/pl.ts';
import { icdTerm } from '../view.ts';
import { exportId, STIX_NAMESPACE, uuidv5 } from './ids.ts';
import { isoMs, selectLinks, subjectName, type ExportInput } from './select.ts';

export const TLP_LEVELS = ['white', 'green', 'amber', 'red'] as const;
export type TlpLevel = (typeof TLP_LEVELS)[number];

export interface StixOptions {
  producerName: string;
  tlp: TlpLevel;
  includeRejected?: boolean;
}

/** Predefined TLP marking definitions of STIX 2.1 (specification section 7.2.1.4). */
export const TLP_MARKINGS: Readonly<Record<TlpLevel, { id: string; name: string }>> = {
  white: { id: 'marking-definition--613f2e26-407d-48c7-9eca-b8e91df99dc9', name: 'TLP:WHITE' },
  green: { id: 'marking-definition--34098fce-860f-48ae-8e50-ebd3cc5e41da', name: 'TLP:GREEN' },
  amber: { id: 'marking-definition--f88d31f6-486f-44da-b317-01333bde0b82', name: 'TLP:AMBER' },
  red: { id: 'marking-definition--5e57c739-391a-4eb3-b6be-7d15ca92d5ed', name: 'TLP:RED' },
};

const TLP_CREATED = '2017-01-20T00:00:00.000Z';
const OPINIONS = { same: 'agree', not_same: 'disagree', unsure: 'neutral' } as const;

/** Deterministic SCO identifier (STIX 2.1 section 2.9): UUIDv5 over the canonical JSON of the contributing properties. */
export function stixScoId(type: 'cryptocurrency-wallet', contributing: Record<string, string>): string {
  return `${type}--${uuidv5(STIX_NAMESPACE, canonicalJson(contributing))}`;
}

type StixObject = Record<string, unknown> & { id: string };

export function toStixBundle(input: ExportInput, o: StixOptions): { json: string; objectCount: number } {
  const { data } = input;
  const { links } = selectLinks(input, o.includeRejected ?? false);
  const at = isoMs(data.generatedAt);
  const marking = TLP_MARKINGS[o.tlp];
  const rid = data.reportId;
  const common = (type: string, id: string) => ({
    type,
    spec_version: '2.1',
    id,
    created: at,
    modified: at,
  });

  const producerId = `identity--${exportId(rid, 'producer')}`;
  const subjectId = `identity--${exportId(rid, `subject:${data.case.id}`)}`;
  const producer: StixObject = {
    ...common('identity', producerId),
    name: o.producerName,
    identity_class: 'system',
    object_marking_refs: [marking.id],
  };
  const subject: StixObject = {
    ...common('identity', subjectId),
    created_by_ref: producerId,
    name: subjectName(data),
    identity_class: 'individual',
    x_olcys_case_id: data.case.id,
    object_marking_refs: [marking.id],
  };

  const wallets = new Map<string, StixObject & { x_olcys_chains: string[] }>();
  const relationships: StixObject[] = [];
  const opinions: StixObject[] = [];
  for (const { link, rejected, captures, judgements } of links) {
    const walletId = stixScoId('cryptocurrency-wallet', { value: link.address.address });
    const wallet = wallets.get(walletId);
    if (wallet) {
      if (!wallet.x_olcys_chains.includes(link.address.chain)) wallet.x_olcys_chains.push(link.address.chain);
    } else {
      wallets.set(walletId, {
        type: 'cryptocurrency-wallet',
        spec_version: '2.1',
        id: walletId,
        value: link.address.address,
        x_olcys_chain: link.address.chain,
        x_olcys_chains: [link.address.chain],
        object_marking_refs: [marking.id],
      });
    }
    const relId = `relationship--${exportId(rid, `link:${link.id}`)}`;
    relationships.push({
      ...common('relationship', relId),
      created_by_ref: producerId,
      relationship_type: 'related-to',
      source_ref: subjectId,
      target_ref: walletId,
      confidence: link.score,
      description: pl.exports.relationship
        .replace('{score}', String(link.score))
        .replace('{icd}', icdTerm(link))
        .replace('{relation}', pl.relations[link.relation]),
      x_olcys_relation: link.relation,
      x_olcys_tier: link.tier,
      x_olcys_link_assessment_id: link.id,
      x_olcys_algorithm_version: link.algorithmVersion,
      x_olcys_weights_sha256: link.weightsSha256,
      ...(rejected !== undefined ? { x_olcys_rejected: true, x_olcys_rejection_reason: rejected } : {}),
      ...(captures.length
        ? {
            external_references: captures.map((c) => ({
              source_name: 'olcys-capture',
              external_id: c.id,
              url: c.finalUrl || c.url,
              hashes: { 'SHA-256': c.manifestSha256 },
            })),
          }
        : {}),
      object_marking_refs: [marking.id],
    });
    for (const j of judgements) {
      opinions.push({
        ...common('opinion', `opinion--${exportId(rid, `judgement:${j.id}`)}`),
        created: isoMs(j.at),
        modified: isoMs(j.at),
        created_by_ref: producerId,
        opinion: OPINIONS[j.judgement],
        explanation: j.justification,
        authors: [j.analyst],
        object_refs: [relId],
        object_marking_refs: [marking.id],
      });
    }
  }

  const walletObjects = [...wallets.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const w of walletObjects) {
    if (w.x_olcys_chains.length < 2) delete (w as { x_olcys_chains?: string[] }).x_olcys_chains;
  }
  const body = [subject, ...walletObjects, ...relationships, ...opinions];
  const report: StixObject = {
    ...common('report', `report--${exportId(rid, 'report')}`),
    created_by_ref: producerId,
    name: pl.exports.reportName.replace('{title}', data.case.title),
    published: at,
    report_types: ['identity', 'observed-data'],
    object_refs: [producerId, ...body.map((x) => x.id)],
    object_marking_refs: [marking.id],
  };
  const markingDefinition = {
    type: 'marking-definition',
    spec_version: '2.1',
    id: marking.id,
    created: TLP_CREATED,
    definition_type: 'tlp',
    name: marking.name,
    definition: { tlp: o.tlp },
  };
  const objects = [markingDefinition, producer, ...body, report];
  const bundle = { type: 'bundle', id: `bundle--${exportId(rid, 'bundle')}`, objects };
  return { json: `${JSON.stringify(bundle, null, 2)}\n`, objectCount: objects.length };
}
