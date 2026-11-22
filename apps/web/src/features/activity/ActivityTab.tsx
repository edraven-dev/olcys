import type { ActivityIndicators, NormalizedTransfer } from '@olcys/core';
import { useEffect, useId } from 'react';
import {
  AddressText,
  DateTime,
  EmptyState,
  ErrorState,
  Icon,
  KindBlock,
  LoadingState,
  ResourceNotices,
  resourceIssue,
  StaleNotice,
  Verbatim,
} from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, plural, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import { chainName, nativeAsset } from '../../lib/chains.ts';
import { keyOf, type CashOutView, type ExclusionView, type LinkView } from '../../lib/domain.ts';
import { formatCrypto, formatInteger, formatPln } from '../../lib/format.ts';
import { navigate, useLocation } from '../../lib/router.tsx';
import { useList, type Resource } from '../../lib/use-api.ts';
import type { RunScope } from '../run/RunPage.tsx';
import { addressOptions, nbpLine, priceLine, transfersFor } from './activity-model.ts';

export const ADDRESS_PARAM = 'adres';

export function ActivityTab({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const selectId = useId();
  const location = useLocation();
  const activity = useList<ActivityIndicators>(apiPaths.runList(run.id, 'activity'), { version });
  const cashOuts = useList<CashOutView>(apiPaths.runList(run.id, 'cash-outs'), { version });
  const transfers = useList<NormalizedTransfer>(apiPaths.runList(run.id, 'transfers'), { version });
  const links = useList<LinkView>(apiPaths.runList(run.id, 'links'), { version });
  const exclusions = useList<ExclusionView>(apiPaths.runList(run.id, 'exclusions'), { version });

  const requested = new URLSearchParams(location.search).get(ADDRESS_PARAM);
  const options = addressOptions(activity.data ?? [], links.data ?? [], exclusions.data ?? []);
  const selected = options.find((o) => o.key === requested) ?? options[0];
  const indicators = activity.data?.find((i) => selected && keyOf(i.address) === selected.key);

  useEffect(() => {
    if (!location.hash || !indicators) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [location.hash, indicators]);

  if (!activity.data) {
    if (activity.error)
      return <ErrorState title={pl.activity.loadError} error={activity.error} onRetry={activity.reload} />;
    return <LoadingState />;
  }

  const listed = (cashOuts.data ?? []).filter((e) => selected && keyOf(e.address) === selected.key);
  const events: CashOutView[] = (listed.length > 0 ? listed : (indicators?.cashOut.events ?? [])).toSorted((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt),
  );

  return (
    <section aria-labelledby="activity-title" className="stack">
      <div>
        <h2 id="activity-title">{pl.activity.title}</h2>
        <p>{pl.activity.intro}</p>
        {run.mode === 'offline' ? (
          <p className="notice small">
            <Icon name="info" />
            {pl.activity.syntheticNote}
          </p>
        ) : null}
      </div>
      <KindBlock kind="inference" headingLevel={4}>
        <p>{pl.activity.caveat}</p>
      </KindBlock>
      <ResourceNotices resources={[activity, links, exclusions]} />
      {options.length === 0 || !selected ? (
        <EmptyState text={pl.activity.empty.none} />
      ) : (
        <>
          <div className="field">
            <label htmlFor={selectId}>{pl.activity.address}</label>
            <select
              id={selectId}
              value={selected.key}
              onChange={(e) =>
                navigate(`${location.pathname}?${ADDRESS_PARAM}=${encodeURIComponent(e.target.value)}`, {
                  replace: true,
                })
              }
            >
              {options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <AddressText value={selected.address.address} />
          </div>
          {indicators ? <Indicators indicators={indicators} /> : null}
          <CashOutSection events={events} chain={selected.address.chain} resource={cashOuts} />
          {indicators ? <Services indicators={indicators} /> : null}
          {indicators ? <Swaps indicators={indicators} /> : null}
          <Transfers resource={transfers} rows={transfersFor(selected.address, transfers.data ?? [])} />
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <li className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {detail ? <span className="tile-detail">{detail}</span> : null}
    </li>
  );
}

const plnOrNone = (value: string | undefined) => (value ? formatPln(value) : pl.activity.noValuation);

function Indicators({ indicators }: { indicators: ActivityIndicators }) {
  const asset = nativeAsset(indicators.address.chain) ?? '';
  return (
    <KindBlock kind="computed" title={chainName(indicators.address.chain)}>
      {indicators.window.from || indicators.window.to ? (
        <p className="muted small">
          {pl.activity.window}: <DateTime iso={indicators.window.from} /> – <DateTime iso={indicators.window.to} />
        </p>
      ) : null}
      <ul className="tiles">
        <Kpi label={pl.activity.kpi.txCount} value={formatInteger(indicators.txCount)} />
        <Kpi
          label={pl.activity.kpi.volumeIn}
          value={plnOrNone(indicators.volumeIn.pln)}
          detail={formatCrypto(indicators.volumeIn.native, asset)}
        />
        <Kpi
          label={pl.activity.kpi.volumeOut}
          value={plnOrNone(indicators.volumeOut.pln)}
          detail={formatCrypto(indicators.volumeOut.native, asset)}
        />
        <Kpi label={pl.activity.kpi.counterparties} value={formatInteger(indicators.counterpartyCount)} />
        <Kpi
          label={pl.activity.kpi.stablecoin}
          value={indicators.stablecoinConversionPln ? formatPln(indicators.stablecoinConversionPln) : pl.common.dash}
        />
        <li className="tile tile-separate">
          <span className="tile-label">{pl.activity.kpi.cashOutScore}</span>
          <span className="tile-value">{t(pl.activity.cashOutScore, { score: indicators.cashOut.score })}</span>
          <span className="tile-detail">{pl.activity.cashOutScoreHint}</span>
        </li>
      </ul>
    </KindBlock>
  );
}

function CashOutSection({
  events,
  chain,
  resource,
}: {
  events: CashOutView[];
  chain: string;
  /** The cash-out list: a failed read must not look like "no indicators". */
  resource: Resource<CashOutView[]>;
}) {
  return (
    <section aria-labelledby="cashout-title" className="stack">
      <h3 id="cashout-title">{pl.activity.sections.cashOut}</h3>
      {resourceIssue(resource) === 'stale' ? <StaleNotice resource={resource} /> : null}
      {events.length === 0 && resourceIssue(resource) === 'unavailable' ? (
        <ErrorState title={pl.common.unavailable} error={resource.error} onRetry={resource.reload} />
      ) : events.length === 0 ? (
        <EmptyState text={pl.activity.empty.cashOut} />
      ) : (
        <ol className="plain-list stack">
          {events.map((event) => {
            const pln = event.valuation?.pln ?? event.plnTotal;
            const flag = event.strength === 'flag';
            return (
              <li key={event.id} id={`cashout-${event.id}`} className={`card cashout-card${flag ? ' flag' : ''}`}>
                <KindBlock
                  kind="computed"
                  title={`${event.ruleId}: ${lookup(pl.activity.cashOutRules, event.ruleId) ?? event.ruleId}`}
                  headingLevel={4}
                >
                  <p>
                    <span
                      className={`badge tone-${flag ? 'warning' : event.strength === 'strong' ? 'critical' : 'info'}`}
                    >
                      <Icon name={flag ? 'warn' : 'info'} />
                      {lookup(pl.activity.strength, event.strength) ?? event.strength}
                    </span>
                  </p>
                  <dl className="facts compact">
                    <dt>{pl.activity.event.date}</dt>
                    <dd>
                      <DateTime iso={event.occurredAt} />
                    </dd>
                    <dt>{pl.activity.event.amount}</dt>
                    <dd>{formatCrypto(event.amount, event.asset || (nativeAsset(chain) ?? ''))}</dd>
                    <dt>{pl.activity.event.value}</dt>
                    <dd>
                      <strong>{pln ? formatPln(pln) : pl.activity.noValuation}</strong>
                      {event.valuation ? <span className="muted small"> ({nbpLine(event.valuation)})</span> : null}
                      {event.valuation && priceLine(event.valuation) ? (
                        <span className="muted small block">{priceLine(event.valuation)}</span>
                      ) : null}
                    </dd>
                    <dt>{pl.activity.event.counterparty}</dt>
                    <dd>
                      {event.counterparty.entity ? `${event.counterparty.entity} — ` : ''}
                      {event.counterparty.category
                        ? (lookup(pl.categories, event.counterparty.category) ?? event.counterparty.category)
                        : null}
                      <br />
                      <AddressText value={event.counterparty.address} truncate />
                    </dd>
                    <dt>{pl.activity.event.transactions}</dt>
                    <dd>
                      {event.hops === 0 ? pl.activity.event.direct : plural(event.hops, pl.activity.event.indirect)}
                      {event.hops > 0 ? <span className="muted small block">{pl.activity.event.decay}</span> : null}
                      <ul className="plain-list">
                        {event.txHashes.map((hash) => (
                          <li key={hash}>
                            <AddressText value={hash} truncate />
                          </li>
                        ))}
                      </ul>
                      {event.components && event.components.length > 0 ? (
                        <span className="muted small">
                          {t(pl.activity.event.legs, { count: event.components.length })}
                        </span>
                      ) : null}
                    </dd>
                  </dl>
                  <details>
                    <summary>{pl.common.technical}</summary>
                    <Verbatim>{event.explanation}</Verbatim>
                  </details>
                </KindBlock>
                <KindBlock kind="inference" headingLevel={4}>
                  <p>{pl.activity.event.inference}</p>
                </KindBlock>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Services({ indicators }: { indicators: ActivityIndicators }) {
  return (
    <section aria-labelledby="services-title" className="stack">
      <h3 id="services-title">{pl.activity.sections.services}</h3>
      {indicators.serviceInteractions.length === 0 ? (
        <EmptyState text={pl.activity.empty.services} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{pl.activity.servicesColumns.category}</th>
                <th scope="col">{pl.activity.servicesColumns.entity}</th>
                <th scope="col">{pl.activity.servicesColumns.direction}</th>
                <th scope="col">{pl.activity.servicesColumns.count}</th>
                <th scope="col">{pl.activity.servicesColumns.pln}</th>
              </tr>
            </thead>
            <tbody>
              {indicators.serviceInteractions.map((s) => (
                <tr key={`${s.entity}-${s.direction}-${s.category}`}>
                  <td>{lookup(pl.categories, s.category) ?? s.category}</td>
                  <td>{s.entity}</td>
                  <td>{pl.activity.direction[s.direction] ?? s.direction}</td>
                  <td>{formatInteger(s.count)}</td>
                  <td>{s.pln ? formatPln(s.pln) : pl.activity.noValuation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Swaps({ indicators }: { indicators: ActivityIndicators }) {
  return (
    <section aria-labelledby="swaps-title" className="stack">
      <h3 id="swaps-title">{pl.activity.sections.swaps}</h3>
      {indicators.swaps.length === 0 ? (
        <EmptyState text={pl.activity.empty.swaps} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{pl.activity.swapsColumns.at}</th>
                <th scope="col">{pl.activity.swapsColumns.venue}</th>
                <th scope="col">{pl.activity.swapsColumns.sold}</th>
                <th scope="col">{pl.activity.swapsColumns.bought}</th>
                <th scope="col">{pl.activity.swapsColumns.stable}</th>
                <th scope="col">{pl.activity.swapsColumns.pln}</th>
              </tr>
            </thead>
            <tbody>
              {indicators.swaps.map((swap) => (
                <tr key={swap.txHash}>
                  <td>
                    <DateTime iso={swap.at} />
                  </td>
                  <td>{swap.venue ?? pl.common.dash}</td>
                  <td>{formatCrypto(swap.sold.amount, swap.sold.asset)}</td>
                  <td>{formatCrypto(swap.bought.amount, swap.bought.asset)}</td>
                  <td>{swap.intoStablecoin ? pl.common.yes : pl.common.no}</td>
                  <td>{swap.valuation ? formatPln(swap.valuation.pln) : pl.activity.noValuation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Transfers({
  resource,
  rows,
}: {
  resource: Resource<NormalizedTransfer[]>;
  rows: ReturnType<typeof transfersFor>;
}) {
  return (
    <section className="stack">
      <KindBlock kind="fact" title={pl.activity.sections.transfers}>
        {resourceIssue(resource) === 'stale' ? <StaleNotice resource={resource} /> : null}
        {resourceIssue(resource) === 'unavailable' ? (
          <ErrorState title={pl.common.unavailable} error={resource.error} onRetry={resource.reload} />
        ) : resource.data === undefined ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState text={pl.activity.empty.transfers} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{pl.activity.transferColumns.at}</th>
                  <th scope="col">{pl.activity.transferColumns.direction}</th>
                  <th scope="col">{pl.activity.transferColumns.amount}</th>
                  <th scope="col">{pl.activity.transferColumns.counterparty}</th>
                  <th scope="col">{pl.activity.transferColumns.tx}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <DateTime iso={row.at} />
                    </td>
                    <td>{pl.activity.transferDirection[row.direction]}</td>
                    <td className="nowrap">{formatCrypto(row.amount, row.asset)}</td>
                    <td>
                      <AddressText value={row.counterparty} truncate />
                    </td>
                    <td>
                      <AddressText value={row.txHash} truncate />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </KindBlock>
    </section>
  );
}
