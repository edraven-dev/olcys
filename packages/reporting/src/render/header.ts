/** Chapter 1 (metadata and reproducibility) and chapter 2 (summary for readers without IT background). */
import { dSum, isDecimalString } from '@olcys/core';
import { formatLongDate, formatPln, formatUtc, plural } from '../format.ts';
import { join, markup, t, type SafeHtml } from '../html.ts';
import { pl } from '../i18n/pl.ts';
import { cmp, icdTerm, lowestConfidence, scoreBand, type View } from '../view.ts';
import { isWalletSwap, changeWhere } from './annex.ts';
import { addr, bandBadge, block, chainName, hash, kv, list, para, section, table } from './blocks.ts';
import { counterpartyLabel } from './chain.ts';
import { isKycLead, uniqueRejected } from './links.ts';

export function metadataSection(view: View): SafeHtml {
  const { data } = view;
  const kase = data.case;
  const run = data.run;
  const cfg = run.config;
  const identifiers = kase.identifiers
    .toSorted((a, b) => cmp(a.kind, b.kind) || cmp(a.value, b.value))
    .map(
      (i) =>
        markup`${t(pl.meta.identifier, { kind: pl.identifierKinds[i.kind] ?? i.kind, value: i.value })}${
          i.platform ? t(pl.meta.platform, { platform: i.platform }) : ''
        }${i.isAnchor ? pl.meta.anchor : ''}`,
    );
  const enabled = (kase.scope?.enabledSources ?? []).toSorted(cmp).map((id) => {
    const source = data.sources.find((s) => s.id === id);
    const justification = kase.scope?.amberJustifications?.[id];
    return markup`${view.sourceName(id)}${source ? markup` — ${pl.compliance[source.compliance]}` : ''}${
      justification ? t(pl.meta.amber, { text: justification }) : ''
    }`;
  });
  const algorithms = [...new Set(data.links.map((l) => l.algorithmVersion))].toSorted(cmp);
  const rules = Object.entries(cfg.rulesVersions ?? {})
    .toSorted(([a], [b]) => cmp(a, b))
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  return section(
    'metryka',
    pl.sections.metadata,
    join([
      markup`<h3>${pl.meta.caseBlock}</h3>`,
      kv([
        [pl.meta.title, kase.title],
        [pl.meta.caseId, markup`<code>${kase.id}</code>`],
        [pl.meta.purpose, kase.purpose],
        [pl.meta.legalBasis, kase.legalBasis],
        [pl.meta.createdBy, kase.createdBy],
        [pl.meta.createdAt, formatUtc(kase.createdAt)],
        [pl.meta.identifiers, list(identifiers)],
        [pl.meta.enabledSources, enabled.length ? list(enabled) : pl.common.none],
      ]),
      markup`<h3>${pl.meta.runBlock}</h3>`,
      kv([
        [pl.meta.runId, markup`<code>${run.id}</code>`],
        [pl.meta.previousRunId, data.previousRun ? markup`<code>${data.previousRun.id}</code>` : pl.meta.noPrevious],
        [pl.meta.trigger, pl.triggers[run.trigger] ?? run.trigger],
        [pl.meta.mode, pl.modes[run.mode] ?? run.mode],
        [pl.meta.queuedAt, formatUtc(run.queuedAt)],
        [pl.meta.startedAt, run.startedAt ? formatUtc(run.startedAt) : pl.common.unknown],
      ]),
      markup`<h3>${pl.meta.versionsBlock}</h3>`,
      kv([
        [pl.meta.toolVersion, cfg.toolVersion],
        [pl.meta.gitCommit, cfg.gitCommit ? markup`<code>${cfg.gitCommit}</code>` : pl.common.unknown],
        [pl.meta.sourcesSha, hash(cfg.sourcesConfigSha256)],
        [pl.meta.weights, cfg.weightsVersion],
        [pl.meta.weightsSha, hash(cfg.weightsSha256)],
        [
          pl.meta.weightsStatus,
          data.weightsStatus ? (pl.weightsStatus[data.weightsStatus] ?? data.weightsStatus) : pl.common.unknown,
        ],
        [pl.meta.rules, rules || pl.common.none],
        [pl.meta.algorithm, algorithms.length ? algorithms.join(', ') : pl.common.none],
        [
          pl.meta.llm,
          cfg.llm ? t(pl.meta.llmUsed, { model: cfg.llm.model, baseUrl: cfg.llm.baseUrl }) : pl.meta.llmNone,
        ],
      ]),
      markup`<h3>${pl.meta.reportBlock}</h3>`,
      kv([
        [pl.meta.reportId, markup`<code>${data.reportId}</code>`],
        [pl.meta.generatedAt, formatUtc(data.generatedAt)],
        [pl.meta.template, data.templateVersion],
        [pl.meta.dataSha, markup`${hash(view.dataSha256)}<br><span class="muted">${pl.meta.dataShaHint}</span>`],
      ]),
    ]),
  );
}

export function summarySection(view: View): SafeHtml {
  const { data } = view;
  const sourcesUsed = new Set(data.captures.map((c) => c.sourceId));
  const unavailable = data.captures.filter((c) => ['blocked', 'login_wall', 'captcha'].includes(c.status));
  const distinctAddresses = new Set(data.candidates.map((c) => `${c.address.chain}:${c.address.address}`));

  const facts = list([
    t(pl.summary.captures, {
      pages: plural(data.captures.length, pl.counts.pages),
      services: plural(sourcesUsed.size, pl.counts.services),
    }),
    unavailable.length ? t(pl.summary.unavailable, { pages: plural(unavailable.length, pl.counts.pagesNom) }) : '',
    t(pl.summary.addresses, { addresses: plural(distinctAddresses.size, pl.counts.addresses) }),
    t(pl.summary.transfers, { transfers: plural(data.transfers.length, pl.counts.transfers) }),
    data.secretFindings > 0 ? t(pl.summary.secrets, { count: data.secretFindings }) : '',
  ]);

  const rows = view.linked.map((l) => [
    view.identityLabel(l.identityId),
    addr(l.address.address),
    chainName(l.address.chain),
    markup`<strong>${l.score}/100</strong>`,
    bandBadge(l.score),
    icdTerm(l),
  ]);
  const c = pl.summary.tableColumns;
  const confidence = lowestConfidence(view.linked.map((l) => l.analyticConfidence));
  const valued = data.cashOuts.map((e) => e.valuation?.pln).filter((v): v is string => !!v && isDecimalString(v));
  const swaps = data.changes.filter(isWalletSwap);
  const rejectedCount = view.removing.length + view.thirdParty.length + uniqueRejected(data).length;

  const computed = join([
    view.linked.length
      ? join([
          para(pl.summary.linksIntro),
          table([c.identity, c.address, c.chain, c.score, c.band, c.term], rows),
          confidence ? para(t(pl.summary.confidence, { level: pl.analyticConfidence[confidence] })) : '',
        ])
      : para(pl.summary.noLinks),
    list([
      t(pl.summary.rejected, { rejected: plural(rejectedCount, pl.counts.rejected) }),
      data.cashOuts.length
        ? t(pl.summary.cashOut, {
            cashOuts: plural(data.cashOuts.length, pl.counts.cashOuts),
            pln: formatPln(valued.length ? dSum(valued) : '0'),
          })
        : pl.summary.noCashOut,
      data.previousRun || data.changes.length
        ? t(pl.summary.changes, {
            changes: plural(data.changes.length, pl.counts.changes),
            swaps: plural(swaps.length, pl.counts.swaps),
          })
        : pl.summary.firstRun,
    ]),
  ]);

  const inferences = [
    ...view.linked
      .filter((l) => l.score >= 40)
      .map((l) =>
        t(pl.summary.inferenceLink, {
          address: addr(l.address.address),
          chain: chainName(l.address.chain),
          identity: view.identityLabel(l.identityId),
          term: icdTerm(l),
          score: l.score,
          band: pl.bands[scoreBand(l.score)].label,
        }),
      ),
    ...view.removing
      .filter((e) => isKycLead(view, e))
      .map((e) => t(pl.summary.inferenceKyc, { address: addr(e.address.address) })),
    ...data.cashOuts
      .toSorted((a, b) => cmp(a.occurredAt, b.occurredAt) || cmp(a.id, b.id))
      .map((e) =>
        t(pl.summary.inferenceCashOut, {
          date: formatLongDate(e.occurredAt),
          pln: e.valuation ? formatPln(e.valuation.pln) : pl.activity.noValuation,
          counterparty: counterpartyLabel(view, e),
        }),
      ),
    ...swaps.map((s) =>
      t(pl.summary.inferenceSwap, {
        where: changeWhere(s),
        before: addr(s.before ?? ''),
        after: addr(s.after ?? ''),
      }),
    ),
  ];

  return section(
    'podsumowanie',
    pl.sections.summary,
    join([
      para(t(pl.summary.lead, { identifiers: plural(data.case.identifiers.length, pl.counts.identifiers) })),
      block('facts', facts),
      block('computed', computed),
      block('inferences', inferences.length ? list(inferences) : para(pl.summary.noInferences)),
      para(pl.doc.caveat, 'caveat'),
    ]),
  );
}
