/**
 * MISP event of a report: one `coin-address` object per exported link, tagged with the Admiralty source reliability and
 * the estimative-language terms (ICD 203), and one `link` attribute per evidence URL. Never published, distribution 0.
 */
import { icdTerm } from '../view.ts';
import definition from './misp/coin-address.definition.json' with { type: 'json' };
import taxonomies from './misp/taxonomies.json' with { type: 'json' };
import { exportId } from './ids.ts';
import { bestReliability, isoMs, selectLinks, type ExportInput } from './select.ts';
import type { TlpLevel } from './stix.ts';
import { KNOWN_CHAINS, chainFamily } from '@olcys/core';
import { pl } from '../i18n/pl.ts';

/** ICD 203 term (as stored in `LinkAssessment.icd203`) → value of the estimative-language `likelihood-probability`. */
export function likelihoodValue(icd203: string): string | undefined {
  const value = icd203.replaceAll(' ', '-');
  return (taxonomies['estimative-language'].predicates['likelihood-probability'] as string[]).includes(value)
    ? value
    : undefined;
}

const tag = (namespace: string, predicate: string, value: string) => `${namespace}:${predicate}="${value}"`;

export function toMispEvent(input: ExportInput, o: { tlp: TlpLevel; includeRejected?: boolean }): { json: string } {
  const { data } = input;
  const { links } = selectLinks(input, o.includeRejected ?? false);
  const rid = data.reportId;
  const timestamp = String(Math.floor(Date.parse(data.generatedAt) / 1000));
  const tlpName = (taxonomies.tlp.values as string[]).includes(o.tlp) ? o.tlp : 'amber';
  const attribute = (key: string, fields: Record<string, unknown>) => ({
    uuid: exportId(rid, key),
    distribution: '5',
    timestamp,
    ...fields,
  });

  const objects = links.map(({ link, rejected, captures }) => {
    const family = chainFamily(link.address.chain);
    const info = KNOWN_CHAINS.find((c) => c.id === link.address.chain);
    const symbol = info?.nativeAsset ?? link.address.chain;
    const [relation, type] =
      family === 'bitcoin'
        ? ['address', 'btc']
        : family === 'monero'
          ? ['address-xmr', 'xmr']
          : ['address-other', 'text'];
    const tags: string[] = [];
    const grade = bestReliability(link);
    if (grade) tags.push(tag('admiralty-scale', 'source-reliability', grade.toLowerCase()));
    const likelihood = likelihoodValue(link.icd203);
    if (likelihood) tags.push(tag('estimative-language', 'likelihood-probability', likelihood));
    tags.push(tag('estimative-language', 'confidence-in-analytic-judgment', link.analyticConfidence.toLowerCase()));
    const seen = captures.map((c) => isoMs(c.collectedAt)).toSorted();
    const id = `coin:${link.id}`;
    return {
      uuid: exportId(rid, id),
      name: definition.name,
      'meta-category': definition['meta-category'],
      description: definition.description,
      template_uuid: definition.uuid,
      template_version: String(definition.version),
      distribution: '5',
      timestamp,
      comment: rejected !== undefined ? `rejected: ${rejected}` : '',
      Attribute: [
        attribute(`${id}:address`, {
          type,
          category: 'Financial fraud',
          object_relation: relation,
          value: link.address.address,
          to_ids: false,
          comment: link.address.chain,
          Tag: tags.map((name) => ({ name })),
        }),
        attribute(`${id}:symbol`, {
          type: 'text',
          category: 'Other',
          object_relation: 'symbol',
          value: symbol,
          to_ids: false,
        }),
        ...(seen[0]
          ? [
              attribute(`${id}:first-seen`, {
                type: 'datetime',
                category: 'Other',
                object_relation: 'first-seen',
                value: seen[0],
                to_ids: false,
              }),
              attribute(`${id}:last-seen`, {
                type: 'datetime',
                category: 'Other',
                object_relation: 'last-seen',
                value: seen[seen.length - 1],
                to_ids: false,
              }),
            ]
          : []),
        attribute(`${id}:text`, {
          type: 'text',
          category: 'Other',
          object_relation: 'text',
          value: pl.exports.mispObject.replace('{score}', String(link.score)).replace('{icd}', icdTerm(link)),
          to_ids: false,
        }),
      ],
    };
  });

  // One `link` attribute per evidence URL; the comment carries the manifest SHA-256 of each capture of that URL.
  const byUrl = new Map<string, Set<string>>();
  for (const { captures } of links) {
    for (const c of captures) {
      const url = c.finalUrl || c.url;
      byUrl.set(url, (byUrl.get(url) ?? new Set()).add(c.manifestSha256));
    }
  }
  const evidence = [...byUrl.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([url, hashes]) =>
      attribute(`evidence:${url}`, {
        type: 'link',
        category: 'External analysis',
        value: url,
        to_ids: false,
        comment: [...hashes].toSorted().join(';'),
      }),
    );

  const event = {
    Event: {
      uuid: exportId(rid, 'event'),
      info: pl.exports.mispInfo.replace('{title}', data.case.title).replace('{runId}', data.run.id),
      date: isoMs(data.generatedAt).slice(0, 10),
      threat_level_id: '4',
      analysis: '1',
      distribution: '0',
      published: false,
      timestamp,
      Tag: [{ name: `tlp:${tlpName}` }],
      Attribute: evidence,
      Object: objects,
    },
  };
  return { json: `${JSON.stringify(event, null, 2)}\n` };
}
