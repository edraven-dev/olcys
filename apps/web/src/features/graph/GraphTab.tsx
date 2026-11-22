import type { ActivityIndicators, OnlineAccount } from '@olcys/core';
import { useId, useMemo, useState } from 'react';
import { AddressText, ErrorState, LoadingState, ResourceNotices } from '../../components/ui.tsx';
import { pl } from '../../i18n/pl.ts';
import { lookup, plural, t } from '../../i18n/t.ts';
import { apiPaths } from '../../lib/api.ts';
import { chainName } from '../../lib/chains.ts';
import { keyOf, type ExclusionView, type LinkView } from '../../lib/domain.ts';
import { Link, routePath } from '../../lib/router.tsx';
import { useList } from '../../lib/use-api.ts';
import { ADDRESS_PARAM } from '../activity/ActivityTab.tsx';
import type { RunScope } from '../run/RunPage.tsx';
import {
  buildGraph,
  DEFAULT_GRAPH_OPTIONS,
  describeGraph,
  type GraphBuild,
  type GraphEdgeData,
  type GraphNodeData,
  type GraphOptions,
} from './build-elements.ts';
import { evidencePath } from './evidence-target.ts';
import { CytoscapeGraph, type GraphLayout } from './CytoscapeGraph.tsx';

type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

export function GraphTab({ scope }: { scope: RunScope }) {
  const { run, version } = scope;
  const [showRejected, setShowRejected] = useState(DEFAULT_GRAPH_OPTIONS.showRejected);
  const [showFlows, setShowFlows] = useState(DEFAULT_GRAPH_OPTIONS.showFlows);
  const [minScore, setMinScore] = useState(DEFAULT_GRAPH_OPTIONS.minScore);
  const [layout, setLayout] = useState<GraphLayout>('layered');
  const [listView, setListView] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);

  const links = useList<LinkView>(apiPaths.runList(run.id, 'links'), { version });
  const exclusions = useList<ExclusionView>(apiPaths.runList(run.id, 'exclusions'), { version });
  const accounts = useList<OnlineAccount>(apiPaths.runList(run.id, 'accounts'), { version });
  const activity = useList<ActivityIndicators>(showFlows ? apiPaths.runList(run.id, 'activity') : null, { version });

  const options: GraphOptions = { ...DEFAULT_GRAPH_OPTIONS, showRejected, showFlows, minScore };
  const identifiers = scope.kase?.identifiers;
  const build = useMemo(
    () =>
      links.data
        ? buildGraph(
            {
              caseTitle: scope.kase?.title ?? pl.graph.panel.subject,
              identifiers: identifiers ?? [],
              accounts: accounts.data ?? [],
              links: links.data,
              exclusions: exclusions.data ?? [],
              ...(activity.data ? { activity: activity.data } : {}),
            },
            options,
          )
        : undefined,
    // `options` is rebuilt every render from the three primitives below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      links.data,
      exclusions.data,
      accounts.data,
      activity.data,
      identifiers,
      scope.kase?.title,
      showRejected,
      showFlows,
      minScore,
    ],
  );

  if (!links.data || !build) {
    if (links.error) return <ErrorState title={pl.graph.loadError} error={links.error} onRetry={links.reload} />;
    return <LoadingState />;
  }

  const selectedNode = selection?.type === 'node' ? build.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge = selection?.type === 'edge' ? build.edges.find((e) => e.id === selection.id) : undefined;

  return (
    <section aria-labelledby="graph-title" className="stack">
      <div>
        <h2 id="graph-title">{pl.graph.title}</h2>
        <p>{pl.graph.intro}</p>
      </div>
      <ResourceNotices resources={[links, exclusions, accounts, activity]} />
      <Controls
        minScore={minScore}
        onMinScore={setMinScore}
        showRejected={showRejected}
        onShowRejected={setShowRejected}
        showFlows={showFlows}
        onShowFlows={setShowFlows}
        layout={layout}
        onLayout={setLayout}
        listView={listView}
        onListView={setListView}
        onFit={() => setFitSignal((n) => n + 1)}
      />
      {build.truncated ? (
        <output className="notice">
          {t(pl.graph.truncated, {
            total: plural(build.total, pl.graph.elements),
            max: options.maxElements,
          })}
        </output>
      ) : null}
      <Legend />
      {build.nodes.length <= 1 && build.edges.length === 0 ? <p className="muted">{pl.graph.empty}</p> : null}
      <div className="graph-layout">
        {listView ? (
          <GraphList build={build} onSelect={setSelection} />
        ) : (
          <div className="graph-frame">
            <CytoscapeGraph
              build={build}
              layout={layout}
              fitSignal={fitSignal}
              onSelectNode={(id) => setSelection({ type: 'node', id })}
              onSelectEdge={(id) => setSelection({ type: 'edge', id })}
            />
          </div>
        )}
        <SelectionPanel
          node={selectedNode}
          edge={selectedEdge}
          build={build}
          scope={scope}
          accounts={accounts.data ?? []}
          links={links.data}
          exclusions={exclusions.data ?? []}
          onClose={() => setSelection(null)}
        />
      </div>
    </section>
  );
}

interface ControlsProps {
  minScore: number;
  onMinScore(value: number): void;
  showRejected: boolean;
  onShowRejected(value: boolean): void;
  showFlows: boolean;
  onShowFlows(value: boolean): void;
  layout: GraphLayout;
  onLayout(value: GraphLayout): void;
  listView: boolean;
  onListView(value: boolean): void;
  onFit(): void;
}

function Controls(props: ControlsProps) {
  const id = useId();
  return (
    <form className="graph-controls card" aria-label={pl.graph.controls.label} onSubmit={(e) => e.preventDefault()}>
      <label className="checkbox">
        <input type="checkbox" checked={props.showRejected} onChange={(e) => props.onShowRejected(e.target.checked)} />
        {pl.graph.controls.showRejected}
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={props.showFlows} onChange={(e) => props.onShowFlows(e.target.checked)} />
        {pl.graph.controls.showFlows}
      </label>
      <div className="field">
        <label htmlFor={`${id}-min`}>
          {pl.graph.controls.minScore}: <output>{props.minScore}</output>
        </label>
        <input
          id={`${id}-min`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={props.minScore}
          onChange={(e) => props.onMinScore(Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-layout`}>{pl.graph.controls.layout}</label>
        <select
          id={`${id}-layout`}
          value={props.layout}
          onChange={(e) => props.onLayout(e.target.value === 'force' ? 'force' : 'layered')}
        >
          <option value="layered">{pl.graph.controls.layered}</option>
          <option value="force">{pl.graph.controls.force}</option>
        </select>
      </div>
      <button type="button" className="button" onClick={props.onFit} disabled={props.listView}>
        {pl.graph.controls.fit}
      </button>
      <button
        type="button"
        className="button"
        aria-pressed={props.listView}
        onClick={() => props.onListView(!props.listView)}
      >
        {props.listView ? pl.graph.controls.graph : pl.graph.controls.list}
      </button>
    </form>
  );
}

// --- legend -----------------------------------------------------------------------------------------------------

const NODE_SHAPES = {
  subject: <rect x="3" y="5" width="18" height="14" rx="4" />,
  identifier: <rect x="3" y="5" width="18" height="14" />,
  account: <ellipse cx="12" cy="12" rx="9" ry="7" />,
  address: <polygon points="12,3 21,12 12,21 3,12" />,
  entity: <path d="M4 7c0-3 16-3 16 0v10c0 3-16 3-16 0z" />,
} as const;

function Legend() {
  const { legend } = pl.graph;
  const nodes = [
    ['subject', legend.subject],
    ['identifier', legend.identifier],
    ['account', legend.account],
    ['address', legend.address],
    ['entity', legend.entity],
  ] as const;
  const edges = [
    ['legend-input', legend.input],
    ['legend-identity', legend.identityHop],
    ['legend-address', legend.addressHop],
    ['legend-published', legend.published],
    ['legend-third', legend.thirdParty],
    ['legend-other', legend.otherRelation],
    ['legend-exclusion', legend.exclusion],
    ['legend-flow', legend.flow],
  ] as const;
  return (
    <details className="graph-legend card" open>
      <summary>{legend.title}</summary>
      <ul className="plain-list graph-legend-list">
        {nodes.map(([kind, text]) => (
          <li key={kind}>
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              aria-hidden="true"
              className={`legend-shape legend-${kind}`}
            >
              {NODE_SHAPES[kind]}
            </svg>
            {text}
          </li>
        ))}
        <li>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className="legend-shape legend-rejected">
            {NODE_SHAPES.address}
          </svg>
          {legend.rejected}
        </li>
        {edges.map(([cls, text]) => (
          <li key={cls}>
            <svg viewBox="0 0 36 8" width="36" height="8" aria-hidden="true" className={`legend-line ${cls}`}>
              <line x1="1" y1="4" x2="35" y2="4" />
            </svg>
            {text}
          </li>
        ))}
      </ul>
      <p className="muted small">{legend.width}</p>
    </details>
  );
}

// --- list view (the accessible equivalent of the canvas) --------------------------------------------------------

function GraphList({ build, onSelect }: { build: GraphBuild; onSelect(selection: Selection): void }) {
  const labels = new Map(build.nodes.map((n) => [n.id, n.label]));
  const { listColumns, kinds } = pl.graph;
  return (
    <div className="graph-list stack">
      <h3>{pl.graph.listTitle}</h3>
      <p className="muted">{describeGraph(build)}</p>
      <div className="table-wrap">
        <table>
          <caption>{pl.graph.listNodes}</caption>
          <thead>
            <tr>
              <th scope="col">{listColumns.kind}</th>
              <th scope="col">{listColumns.label}</th>
              <th scope="col">{listColumns.select}</th>
            </tr>
          </thead>
          <tbody>
            {build.nodes.map((node) => (
              <tr key={node.id}>
                <td>{kinds[node.kind]}</td>
                <td>
                  {node.label}
                  {node.sublabel ? <span className="muted"> — {node.sublabel}</span> : null}
                </td>
                <td>
                  <button
                    type="button"
                    className="button"
                    aria-label={t(pl.graph.select, { label: node.label })}
                    onClick={() => onSelect({ type: 'node', id: node.id })}
                  >
                    {listColumns.select}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table>
          <caption>{pl.graph.listEdges}</caption>
          <thead>
            <tr>
              <th scope="col">{listColumns.kind}</th>
              <th scope="col">{listColumns.from}</th>
              <th scope="col">{listColumns.to}</th>
              <th scope="col">{listColumns.label}</th>
              <th scope="col">{listColumns.select}</th>
            </tr>
          </thead>
          <tbody>
            {build.edges.map((edge) => (
              <tr key={edge.id}>
                <td>{kinds[edge.kind]}</td>
                <td>{labels.get(edge.source)}</td>
                <td>{labels.get(edge.target)}</td>
                <td>{edge.label}</td>
                <td>
                  <button
                    type="button"
                    className="button"
                    aria-label={t(pl.graph.select, { label: edge.label })}
                    onClick={() => onSelect({ type: 'edge', id: edge.id })}
                  >
                    {listColumns.select}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- side panel -------------------------------------------------------------------------------------------------

interface PanelProps {
  node: GraphNodeData | undefined;
  edge: GraphEdgeData | undefined;
  build: GraphBuild;
  scope: RunScope;
  accounts: readonly OnlineAccount[];
  links: readonly LinkView[];
  exclusions: readonly ExclusionView[];
  onClose(): void;
}

function SelectionPanel({ node, edge, build, scope, accounts, links, exclusions, onClose }: PanelProps) {
  const { run } = scope;
  const titleId = useId();
  const runTab = (tab: 'activity') => routePath({ name: 'run', caseId: run.caseId, runId: run.id, tab });
  let body = <p className="muted">{pl.graph.panel.none}</p>;
  let title: string = pl.graph.panel.title;

  if (node) {
    title = pl.graph.panel[node.kind === 'subject' ? 'subject' : node.kind];
    const account = node.kind === 'account' ? accounts.find((a) => `account:${a.id}` === node.id) : undefined;
    const nodeLinks = (node.linkIds ?? []).flatMap((id) => links.find((l) => l.id === id) ?? []);
    body = (
      <div className="stack">
        <p>
          <strong>{node.label}</strong>
          {node.sublabel ? <span className="muted"> — {node.sublabel}</span> : null}
        </p>
        {account ? (
          <p>
            {t(pl.graph.panel.discoveredVia, {
              source: account.discoveredVia.sourceId,
              method: lookup(pl.graph.discovery, account.discoveredVia.method) ?? account.discoveredVia.method,
            })}
          </p>
        ) : null}
        {node.address ? (
          <>
            <AddressText value={node.address.address} />
            <p className="muted">{chainName(node.address.chain)}</p>
          </>
        ) : null}
        {node.rejected ? <p>{pl.graph.panel.rejected}</p> : null}
        {node.ruleId ? <p>{t(pl.graph.panel.rule, { rule: node.ruleId })}</p> : null}
        {node.category ? (
          <p>{t(pl.graph.panel.category, { category: lookup(pl.categories, node.category) ?? node.category })}</p>
        ) : null}
        {nodeLinks.length > 0 ? (
          <div>
            <h4>{pl.graph.panel.links}</h4>
            <ul className="plain-list">
              {nodeLinks.map((link) => (
                <li key={link.id}>
                  {t(pl.graph.panel.linkLine, {
                    relation: lookup(pl.relations, link.relation) ?? link.relation,
                    score: link.score,
                  })}{' '}
                  <Link
                    to={evidencePath(
                      run,
                      { linkId: link.id, address: node.address, rejected: node.rejected === true },
                      exclusions,
                    )}
                  >
                    {pl.graph.panel.openEvidence}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {node.address ? (
          <p>
            <Link to={`${runTab('activity')}?${ADDRESS_PARAM}=${encodeURIComponent(keyOf(node.address))}`}>
              {pl.graph.panel.openActivity}
            </Link>
          </p>
        ) : null}
      </div>
    );
  } else if (edge) {
    title = pl.graph.panel.edge;
    const labelOf = (id: string) => build.nodes.find((n) => n.id === id)?.label ?? id;
    body = (
      <div className="stack">
        <p>
          <strong>{edge.label}</strong> <span className="muted">({pl.graph.kinds[edge.kind]})</span>
        </p>
        <p>
          {pl.graph.panel.from}: {labelOf(edge.source)}
          <br />
          {pl.graph.panel.to}: {labelOf(edge.target)}
        </p>
        {edge.linkId ? (
          <Link
            to={evidencePath(
              run,
              {
                linkId: edge.linkId,
                address: build.nodes.find((n) => n.id === edge.target)?.address,
                rejected: edge.kind !== 'address_hop',
              },
              exclusions,
            )}
          >
            {pl.graph.panel.openEvidence}
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <aside className="graph-panel card" aria-labelledby={titleId}>
      <div className="page-head">
        <h3 id={titleId}>{title}</h3>
        {node || edge ? (
          <button type="button" className="button" onClick={onClose}>
            {pl.graph.panel.close}
          </button>
        ) : null}
      </div>
      {body}
    </aside>
  );
}
