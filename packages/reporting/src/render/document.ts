/** The report document: head (CSP, inline print CSS), title block, table of contents, legend and chapters 1–9. */
import { formatUtc } from '../format.ts';
import { join, markup, SafeHtml, t } from '../html.ts';
import { pl } from '../i18n/pl.ts';
import type { ReportData } from '../types.ts';
import { buildView } from '../view.ts';
import { changesSection, evidenceSection, methodologySection } from './annex.ts';
import { STATEMENT_CLASSES, STATEMENT_IDS } from './blocks.ts';
import { activitySection, flowSection } from './chain.ts';
import { metadataSection, summarySection } from './header.ts';
import { linksSection, rejectedSection } from './links.ts';

/** Content-Security-Policy of the document (the API serves the same policy as a header). */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

// Local fonts only; borders differ by statement class in style (solid / double / dashed) so print in greyscale works.
const CSS = `@page{size:A4;margin:18mm 16mm 20mm}
:root{--ink:#1b1f24;--muted:#5b6470;--line:#d0d5dc;--facts:#1f5fbf;--computed:#2e7d32;--inferences:#b45309;--alert:#b42318}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0 auto;max-width:200mm;padding:10mm 8mm;font-family:"DejaVu Sans","Liberation Sans","Noto Sans",Arial,sans-serif;font-size:10pt;line-height:1.45;color:var(--ink);background:#fff}
h1{font-size:18pt;margin:2pt 0 6pt}
h2{font-size:14pt;margin:20pt 0 8pt;padding-bottom:3pt;border-bottom:2px solid var(--ink);break-after:avoid}
h3{font-size:11.5pt;margin:12pt 0 6pt;break-after:avoid}
h4{font-size:10pt;margin:8pt 0 4pt;break-after:avoid}
p{margin:4pt 0}
ul,ol{margin:3pt 0;padding-left:16pt}
li{margin:2pt 0}
code,.hash,.addr,.url{font-family:"DejaVu Sans Mono","Liberation Mono","Noto Sans Mono",monospace;font-size:8.5pt;overflow-wrap:anywhere;word-break:break-all}
.url{color:var(--muted)}
.muted{color:var(--muted);font-size:8.5pt}
.tool{margin:0;color:var(--muted);font-size:9pt;letter-spacing:.02em}
.caveat{border:1px solid var(--line);background:#f6f7f9;padding:6pt 8pt;font-size:9pt}
.blk{margin:6pt 0;padding:4pt 8pt 4pt 10pt;background:#fbfbfc}
.blk-fakty{border-left:4px solid var(--facts)}
.blk-obliczenia{border-left:6px double var(--computed)}
.blk-wnioski{border-left:4px dashed var(--inferences);background:#fffaf3}
.blk-label,.st-label{margin:0 0 3pt;font-size:7.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.05em}
.blk-fakty>.blk-label,.st-fakty>.st-label{color:var(--facts)}
.blk-obliczenia>.blk-label,.st-obliczenia>.st-label{color:var(--computed)}
.blk-wnioski>.blk-label,.st-wnioski>.st-label{color:var(--inferences)}
.st{margin:2pt 0;padding-left:6pt}
.st-fakty{border-left:3px solid var(--facts)}
.st-obliczenia{border-left:4px double var(--computed)}
.st-wnioski{border-left:3px dashed var(--inferences)}
.card{border:1px solid var(--line);border-radius:4px;padding:6pt 10pt;margin:10pt 0}
.card h3{margin-top:2pt}
.card-sub{margin:0 0 4pt;color:var(--muted)}
.card-rejected{border-color:#e4b4ae}
.card-alert{border:2px solid var(--alert)}
.card-alert>h3{color:var(--alert)}
.score-line{margin:2pt 0 4pt}
.score-line .score{font-size:16pt;font-weight:bold;margin-right:4pt}
.term{font-style:italic}
.band{display:inline-block;padding:1pt 6pt;border-radius:3px;font-weight:bold;font-size:8.5pt;color:#fff;white-space:nowrap}
.band-very_high{background:#1b5e20}.band-probable{background:#2e7d32}.band-medium{background:#a16207}.band-low{background:#6b7280}.band-excluded{background:#b42318}
.table-wrap{overflow-x:auto}
table.grid{width:100%;border-collapse:collapse;margin:4pt 0;font-size:9pt}
table.grid th,table.grid td{border:1px solid var(--line);padding:2pt 4pt;vertical-align:top;text-align:left}
table.grid th{background:#eef1f4}
table.compact{font-size:8pt}
tr{break-inside:avoid}
dl.kv{display:grid;grid-template-columns:36% 64%;margin:4pt 0}
dl.kv dt{font-weight:bold;padding:2pt 6pt 2pt 0}
dl.kv dd{margin:0;padding:2pt 0;overflow-wrap:anywhere}
blockquote{margin:3pt 0 3pt 6pt;padding:2pt 6pt;border-left:2px solid var(--line);font-style:italic}
.warning{color:var(--alert)}
.alert-box{border:2px solid var(--alert);background:#fdf2f1;padding:6pt 8pt;margin:8pt 0;font-weight:bold}
.technical{font-size:7.5pt;color:var(--muted);margin:2pt 0}
.technical-label{font-weight:bold}
.formula{font-family:"DejaVu Sans Mono","Liberation Mono",monospace;font-size:8.5pt;background:#f6f7f9;padding:4pt 6pt}
ol.flow{padding-left:18pt}
.flow-step{margin:7pt 0;break-inside:avoid}
.flow-time{margin:0;font-weight:bold}
.role{color:var(--muted)}
.empty{color:var(--muted);font-style:italic}
.toc ol{columns:2;column-gap:16pt}
a.ref,.toc a{color:var(--facts);text-decoration:none}
.legend-item{margin:4pt 0}
#rejestr,#metodyka{break-before:page}
.doc-footer{margin-top:24pt;padding-top:4pt;border-top:1px solid var(--line)}
@media screen{body{padding:16px 20px}}`;

const SECTIONS = [
  ['metryka', pl.sections.metadata],
  ['podsumowanie', pl.sections.summary],
  ['powiazania', pl.sections.links],
  ['odrzucone', pl.sections.rejected],
  ['aktywnosc', pl.sections.activity],
  ['przeplywy', pl.sections.flow],
  ['zmiany', pl.sections.changes],
  ['rejestr', pl.sections.evidence],
  ['metodyka', pl.sections.methodology],
] as const;

function legend(): SafeHtml {
  return markup`<section class="legend" id="legenda"><h2>${pl.legend.title}</h2>${STATEMENT_CLASSES.map(
    (kind) =>
      markup`<div class="blk blk-${STATEMENT_IDS[kind]} legend-item"><p class="blk-label">${pl.classes[kind]}</p><p>${pl.legend[kind]}</p></div>`,
  )}</section>`;
}

/** Renders the self-contained Polish HTML report. Pure: the same data always gives the same bytes. */
export function renderReport(data: ReportData): string {
  const view = buildView(data);
  const title = t(pl.doc.title, { title: data.case.title });
  const body = join([
    markup`<header class="doc-header"><p class="tool">${t(pl.doc.tool, { version: data.run.config.toolVersion })}</p><h1>${title}</h1><p class="caveat">${pl.doc.caveat}</p></header>`,
    markup`<nav class="toc"><h2>${pl.doc.toc}</h2><ol>${SECTIONS.map(([id, name]) => markup`<li><a href="#${id}">${name}</a></li>`)}</ol></nav>`,
    legend(),
    metadataSection(view),
    summarySection(view),
    linksSection(view),
    rejectedSection(view),
    activitySection(view),
    flowSection(view),
    changesSection(view),
    evidenceSection(view),
    methodologySection(view),
    markup`<footer class="doc-footer muted">${t(pl.doc.footer, {
      reportId: data.reportId,
      at: formatUtc(data.generatedAt),
      template: data.templateVersion,
    })}</footer>`,
  ]);
  const head = markup`<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${new SafeHtml(REPORT_CSP)}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${new SafeHtml(CSS)}</style></head>`;
  return `<!doctype html>\n<html lang="pl">${head.value}<body>${body.value}</body></html>\n`;
}
