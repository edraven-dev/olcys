import { escapeXml, pl } from './format.ts';
import type { CalibrationReport } from './report.ts';

const W = 640;
const H = 600;
const LEFT = 70;
const RIGHT = 24;
const TOP = 92;
const BOTTOM = 84;
const PLOT_W = W - LEFT - RIGHT;
const PLOT_H = H - TOP - BOTTOM;

const y = (v: number): number => TOP + (1 - v) * PLOT_H;

/**
 * Self-contained reliability diagram (no scripts, fonts or remote assets): the diagonal is perfect calibration, a
 * point per non-empty bin is sized by its claim count and labelled with it, so colour is never the only carrier.
 * Light and dark palettes follow `prefers-color-scheme`.
 */
export function reliabilitySvg(r: CalibrationReport): string {
  const x = (v: number): number => LEFT + v * PLOT_W;
  const nonEmpty = r.bins.filter((b) => b.count > 0);
  const maxCount = Math.max(1, ...nonEmpty.map((b) => b.count));
  const title = `Diagram niezawodności — ${r.weightsVersion}`;
  const subtitle = `Brier ${pl(r.brier.value)} · ECE ${pl(r.ece.value)} · n = ${r.n} · dane syntetyczne`;
  const desc =
    `Zaobserwowana częstość prawdziwych powiązań względem przewidywanego prawdopodobieństwa, ${nonEmpty.length} niepustych przedziałów. ` +
    nonEmpty
      .map(
        (b) =>
          `[${pl(b.lower, 1)}; ${pl(b.upper, 1)}]: n = ${b.count}, przewidywane ${pl(b.meanPredicted)}, zaobserwowane ${pl(b.observedRate)}`,
      )
      .join('; ');
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const grid = ticks
    .map(
      (t) =>
        `<line class="grid" x1="${x(t)}" y1="${y(0)}" x2="${x(t)}" y2="${y(1)}"/>` +
        `<line class="grid" x1="${x(0)}" y1="${y(t)}" x2="${x(1)}" y2="${y(t)}"/>` +
        `<text class="tick" x="${x(t)}" y="${y(0) + 18}" text-anchor="middle">${pl(t, 1)}</text>` +
        `<text class="tick" x="${x(0) - 8}" y="${y(t) + 4}" text-anchor="end">${pl(t, 1)}</text>`,
    )
    .join('');
  const line = nonEmpty.map((b) => `${x(b.meanPredicted).toFixed(2)},${y(b.observedRate).toFixed(2)}`).join(' ');
  const points = nonEmpty
    .map((b) => {
      const radius = 4 + 12 * Math.sqrt(b.count / maxCount);
      const cx = x(b.meanPredicted);
      const cy = y(b.observedRate);
      return (
        `<circle class="pt" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}"><title>${escapeXml(
          `[${pl(b.lower, 1)}; ${pl(b.upper, 1)}]: n = ${b.count}, przewidywane ${pl(b.meanPredicted)}, zaobserwowane ${pl(b.observedRate)}`,
        )}</title></circle>` +
        `<text class="count" x="${(cx + radius + 3).toFixed(2)}" y="${(cy - radius).toFixed(2)}">${b.count}</text>`
      );
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="system-ui, sans-serif">
<title id="t">${escapeXml(title)}</title>
<desc id="d">${escapeXml(desc)}</desc>
<style>
.bg{fill:#ffffff}.fg{fill:#1f2933}.muted{fill:#52606d}.grid{stroke:#e4e7eb;stroke-width:1}.axis{stroke:#52606d;stroke-width:1.5}
.diag{stroke:#7b8794;stroke-width:1.5;stroke-dasharray:6 4;fill:none}.link{stroke:#1d4ed8;stroke-width:2;fill:none}
.pt{fill:#1d4ed8;fill-opacity:.55;stroke:#1d4ed8;stroke-width:1.5}.tick{font-size:12px;fill:#52606d}.count{font-size:11px;fill:#1f2933}
@media (prefers-color-scheme:dark){.bg{fill:#12181f}.fg{fill:#e4e7eb}.muted{fill:#9aa5b1}.grid{stroke:#2a3441}.axis{stroke:#9aa5b1}
.diag{stroke:#9aa5b1}.link{stroke:#7cb2ff}.pt{fill:#7cb2ff;stroke:#7cb2ff}.tick{fill:#9aa5b1}.count{fill:#e4e7eb}}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text class="fg" x="${LEFT}" y="30" font-size="18" font-weight="600">${escapeXml(title)}</text>
<text class="muted" x="${LEFT}" y="52" font-size="13">${escapeXml(subtitle)}</text>
<text class="muted" x="${LEFT}" y="72" font-size="12">Linia przerywana: idealna kalibracja · wielkość punktu i liczba obok: liczba roszczeń w przedziale</text>
${grid}
<line class="axis" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}"/><line class="axis" x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}"/>
<line class="diag" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>
<polyline class="link" points="${line}"/>
${points}
<text class="fg" x="${x(0.5)}" y="${H - 28}" font-size="13" text-anchor="middle">Przewidywane prawdopodobieństwo (wynik / 100)</text>
<text class="fg" font-size="13" text-anchor="middle" transform="translate(20 ${y(0.5)}) rotate(-90)">Zaobserwowana częstość prawdziwych powiązań</text>
</svg>
`;
}
