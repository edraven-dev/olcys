import { beforeAll, describe, expect, it } from 'vitest';
import { calibrate, generateClaims, oracleScenarios, reliabilitySvg, type CalibrationReport } from '../src/index.ts';
import { v2 } from './fixtures/helpers.ts';

let report: CalibrationReport;
beforeAll(async () => {
  const w = await v2();
  report = calibrate(generateClaims(oracleScenarios(w), 3000, 9), w, { seed: 9, bootstrap: 20 });
});

describe('reliability diagram', () => {
  it('is a self-contained, accessible SVG with Polish labels', () => {
    const svg = reliabilitySvg(report);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="t d"');
    expect(svg).toContain('<title id="t">Diagram niezawodności — weights.v2</title>');
    expect(svg).toContain('Przewidywane prawdopodobieństwo (wynik / 100)');
    expect(svg).toContain('Zaobserwowana częstość prawdziwych powiązań');
    expect(svg).toMatch(/Brier \d,\d{3} · ECE \d,\d{3} · n = 3000 · dane syntetyczne/);
    expect(svg).toContain('prefers-color-scheme:dark');
  });

  it('loads nothing remote: no scripts, links, images, fonts or external references', () => {
    const svg = reliabilitySvg(report);
    expect(svg).not.toMatch(/<script|<image|<foreignObject|@import|url\(|href=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });

  it('draws one labelled point per non-empty bin', () => {
    const svg = reliabilitySvg(report);
    expect(svg.match(/<circle /g)).toHaveLength(report.bins.filter((b) => b.count > 0).length);
  });
});
