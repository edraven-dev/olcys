/** Cytoscape stylesheet and element conversion. Colours follow the console palette in both themes. */
import type cytoscape from 'cytoscape';
import type { GraphBuild } from './build-elements.ts';

export interface GraphPalette {
  ink: string;
  muted: string;
  surface: string;
  subject: string;
  subjectInk: string;
  identifier: string;
  identifierBorder: string;
  account: string;
  accountBorder: string;
  address: string;
  addressBorder: string;
  entity: string;
  entityBorder: string;
  rejected: string;
  rejectedBorder: string;
  hop: string;
  critical: string;
  flow: string;
  focus: string;
  tiers: Record<'E1' | 'E2' | 'E3' | 'E4', string>;
}

export const LIGHT_PALETTE: GraphPalette = {
  ink: '#141414',
  muted: '#64625d',
  surface: '#ffffff',
  subject: '#26262a',
  subjectInk: '#ffffff',
  identifier: '#e4edfa',
  identifierBorder: '#1d5bb8',
  account: '#f0efec',
  accountBorder: '#64625d',
  address: '#ffffff',
  addressBorder: '#1d5bb8',
  entity: '#fbf0d4',
  entityBorder: '#7a4f00',
  rejected: '#e3e2dd',
  rejectedBorder: '#898781',
  hop: '#4a4945',
  critical: '#b42318',
  flow: '#0a6e0a',
  focus: '#1d5bb8',
  tiers: { E1: '#1f5fbf', E2: '#3a8fd9', E3: '#7b5ea7', E4: '#8a8a8a' },
};

export const DARK_PALETTE: GraphPalette = {
  ink: '#f0efec',
  muted: '#a3a29b',
  surface: '#1a1a19',
  subject: '#f0efec',
  subjectInk: '#141414',
  identifier: '#15263d',
  identifierBorder: '#8cb8f5',
  account: '#232322',
  accountBorder: '#a3a29b',
  address: '#1a1a19',
  addressBorder: '#8cb8f5',
  entity: '#352a10',
  entityBorder: '#f3c25c',
  rejected: '#2c2c2a',
  rejectedBorder: '#898781',
  hop: '#c3c2b7',
  critical: '#f19893',
  flow: '#7fd17f',
  focus: '#8cb8f5',
  tiers: { E1: '#6ea6f0', E2: '#7db8ea', E3: '#b9a6f2', E4: '#a3a29b' },
};

export const prefersDark = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;

export const paletteFor = (dark: boolean): GraphPalette => (dark ? DARK_PALETTE : LIGHT_PALETTE);

/** Width of a hop edge: 1 + 5·P pixels. */
const HOP_WIDTH = 'mapData(probability, 0, 1, 1, 6)';

const nodeStyle = (kind: string, shape: string, bg: string, border: string): cytoscape.StylesheetJsonBlock => ({
  selector: `node.${kind}`,
  style: { shape: shape as 'rectangle', 'background-color': bg, 'border-color': border },
});

export function graphStylesheet(p: GraphPalette): cytoscape.StylesheetJson {
  const tier = (name: keyof GraphPalette['tiers']): cytoscape.StylesheetJsonBlock => ({
    selector: `edge.address_hop[tier = "${name}"]`,
    style: { 'line-color': p.tiers[name], 'target-arrow-color': p.tiers[name] },
  });
  return [
    {
      selector: 'node',
      style: {
        label: 'data(display)',
        color: p.ink,
        'font-size': 11,
        'text-wrap': 'wrap',
        'text-max-width': '140px',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-background-color': p.surface,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
        width: 34,
        height: 34,
        'border-width': 2,
        'overlay-opacity': 0,
      },
    },
    nodeStyle('subject', 'round-rectangle', p.subject, p.subject),
    nodeStyle('identifier', 'rectangle', p.identifier, p.identifierBorder),
    nodeStyle('account', 'ellipse', p.account, p.accountBorder),
    nodeStyle('address', 'diamond', p.address, p.addressBorder),
    nodeStyle('entity', 'barrel', p.entity, p.entityBorder),
    {
      selector: 'node.rejected',
      style: { 'background-color': p.rejected, 'border-color': p.rejectedBorder, 'border-style': 'dashed' },
    },
    {
      selector: 'edge',
      style: {
        label: 'data(label)',
        color: p.ink,
        'font-size': 9,
        'text-rotation': 'autorotate',
        'text-background-color': p.surface,
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'line-color': p.hop,
        'target-arrow-color': p.hop,
        width: 1.5,
        'overlay-opacity': 0,
      },
    },
    { selector: 'edge.identity_hop', style: { width: HOP_WIDTH } },
    { selector: 'edge.address_hop', style: { width: HOP_WIDTH } },
    tier('E1'),
    tier('E2'),
    tier('E3'),
    tier('E4'),
    {
      selector: 'edge.published',
      style: {
        'line-style': 'dashed',
        'line-color': p.rejectedBorder,
        'target-arrow-color': p.rejectedBorder,
        width: 1.5,
      },
    },
    {
      selector: 'edge.third_party',
      style: {
        'line-style': 'dotted',
        'line-color': p.rejectedBorder,
        'target-arrow-color': p.rejectedBorder,
        width: 2,
      },
    },
    {
      selector: 'edge.exclusion',
      style: { 'line-style': 'dashed', 'line-color': p.critical, 'target-arrow-color': p.critical, width: 2 },
    },
    {
      selector: 'edge.flow',
      style: { 'line-color': p.flow, 'target-arrow-color': p.flow, width: 2.5 },
    },
    { selector: 'edge.input', style: { 'line-color': p.muted, 'target-arrow-color': p.muted, width: 1 } },
    {
      selector: ':selected',
      style: { 'border-width': 4, 'border-color': p.focus, 'overlay-color': p.focus, 'overlay-opacity': 0.12 },
    },
    { selector: 'edge:selected', style: { 'line-color': p.focus, 'target-arrow-color': p.focus } },
  ];
}

/** Cytoscape element definitions; the node `display` adds the sub-label on a second line. */
export function toElements(build: GraphBuild): cytoscape.ElementDefinition[] {
  return [
    ...build.nodes.map((node) => ({
      group: 'nodes' as const,
      data: { ...node, display: node.sublabel ? `${node.label}\n${node.sublabel}` : node.label },
      classes: node.rejected ? `${node.kind} rejected` : node.kind,
    })),
    ...build.edges.map((edge) => ({ group: 'edges' as const, data: { ...edge }, classes: edge.kind })),
  ];
}
