/**
 * Extraction benchmark (offline): runs the extractor and the SpiderFoot baseline over `fixtures/corpus`.
 *
 *   node scripts/bench.ts                  writes data/bench/<extractorVersion>/report.{json,md}
 *   --corpus <dir>  --out <dir>            other corpus / output directory
 *
 * Exits with 1 when a threshold is not met (the report is written anyway). Secrets exist only in memory; the
 * report is checked for secret fragments before anything is written.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderReportMarkdown } from '../bench/report.ts';
import { runBenchmark } from '../bench/run.ts';
import { countLeaks } from '../bench/secrets.ts';
import { parseDenyList } from '../src/deny-list.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, out: { type: 'string' } } });
  const denyList = parseDenyList(await readFile(join(REPO, 'config', 'rules', 'deny-list.v1.yaml'), 'utf8'));
  const { report, secretFragments } = await runBenchmark({
    denyList,
    ...(values.corpus ? { corpusDir: resolve(values.corpus) } : {}),
    log: (line) => console.info(line),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderReportMarkdown(report);
  if (countLeaks(json, secretFragments) + countLeaks(markdown, secretFragments) > 0) {
    throw new Error('secret fragment in the benchmark report — nothing was written');
  }
  const dir = values.out ? resolve(values.out) : join(REPO, 'data', 'bench', report.extractorVersion);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'report.json'), json);
  await writeFile(join(dir, 'report.md'), markdown);
  const failed = report.gates.filter((g) => !g.passed);
  console.info(
    `bench: precision ${report.overall.precision.toFixed(4)}, recall ${report.overall.recall.toFixed(4)}, ` +
      `secrets ${report.secrets.redacted}/${report.secrets.total} (leaks ${report.secrets.leaks}); report in ${dir}`,
  );
  if (failed.length > 0) {
    console.error(`bench: ${failed.length} threshold(s) not met: ${failed.map((g) => g.id).join(', ')}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
