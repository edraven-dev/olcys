import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExportLinks } from '../src/features/report/ReportTab.tsx';
import { pl } from '../src/i18n/pl.ts';

describe('report export links', () => {
  it('shows only the exports the API lists', () => {
    const html = renderToStaticMarkup(<ExportLinks runId="run-1" available={['stix', 'csv_links']} />);
    expect(html).toContain('/api/runs/run-1/exports/stix');
    expect(html).toContain('/api/runs/run-1/exports/csv_links');
    expect(html).not.toContain('/exports/misp');
    expect(html).not.toContain(pl.report.exports.none);
  });

  it('explains how to create exports when a report has none', () => {
    const html = renderToStaticMarkup(<ExportLinks runId="run-1" available={[]} />);
    expect(html).not.toContain('/exports/');
    expect(html).toContain('Wygeneruj raport ponownie');
  });
});
