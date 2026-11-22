import cytoscape from 'cytoscape';
import { useEffect, useRef } from 'react';
import { describeGraph, SUBJECT_ID, type GraphBuild } from './build-elements.ts';
import { graphStylesheet, paletteFor, prefersDark, toElements } from './graph-style.ts';

export type GraphLayout = 'layered' | 'force';

export interface CytoscapeGraphProps {
  build: GraphBuild;
  layout: GraphLayout;
  /** Incremented by the "fit" control. */
  fitSignal?: number;
  onSelectNode(id: string): void;
  onSelectEdge(id: string): void;
}

function layoutOptions(layout: GraphLayout): cytoscape.LayoutOptions {
  // Built-in layouts only (no extra assets); never animated, so the result is deterministic.
  if (layout === 'force') return { name: 'cose', animate: false, randomize: false, fit: true, padding: 30 };
  return {
    name: 'breadthfirst',
    directed: true,
    roots: [SUBJECT_ID],
    animate: false,
    fit: true,
    padding: 30,
    spacingFactor: 1.2,
  };
}

/**
 * Cytoscape.js used directly: the instance is created in an effect and destroyed on unmount (safe under React
 * StrictMode's double mount). Labels are canvas text; the accessible equivalent is the list view.
 */
export function CytoscapeGraph({ build, layout, fitSignal = 0, onSelectNode, onSelectEdge }: CytoscapeGraphProps) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<cytoscape.Core | null>(null);
  const handlers = useRef({ onSelectNode, onSelectEdge });
  useEffect(() => {
    handlers.current = { onSelectNode, onSelectEdge };
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const cy = cytoscape({
      container: element,
      elements: [],
      style: graphStylesheet(paletteFor(prefersDark())),
      minZoom: 0.2,
      maxZoom: 3,
      boxSelectionEnabled: false,
    });
    instance.current = cy;
    cy.on('tap', 'node', (event) => handlers.current.onSelectNode(String(event.target.id())));
    cy.on('tap', 'edge', (event) => handlers.current.onSelectEdge(String(event.target.id())));

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const restyle = () => cy.style(graphStylesheet(paletteFor(prefersDark())));
    media?.addEventListener('change', restyle);
    return () => {
      media?.removeEventListener('change', restyle);
      instance.current = null;
      cy.destroy();
    };
  }, []);

  useEffect(() => {
    const cy = instance.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(toElements(build));
    });
    cy.layout(layoutOptions(layout)).run();
  }, [build, layout]);

  useEffect(() => {
    if (fitSignal > 0) instance.current?.fit(undefined, 30);
  }, [fitSignal]);

  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- canvas host; the accessible equivalent is the list view
  return <div ref={container} className="graph-canvas" role="img" aria-label={describeGraph(build)} />;
}
