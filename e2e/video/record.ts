/**
 * `pnpm demo:video [--force]`: records the submission video. The same mandatory flow as the acceptance test, paced for a
 * viewer: Playwright `recordVideo` (1920x1080, headless, local Chromium, slowMo), Polish captions injected as an
 * overlay (the app is never changed), waiting for the analysis sped up in post. Converted with the system ffmpeg to an
 * H.264 MP4 at `olcys-demo.mp4` in the repository root; the run fails when the result is longer than 3:00.
 * Identifying data (persona identifiers, addresses, hashes, e-mails) is masked in the page unless `--no-mask`.
 * Loopback only; synthetic data only; nothing is downloaded.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Locator } from '@playwright/test';
import { pl } from '../../apps/web/src/i18n/pl.ts';
import { loadExpectations } from '../../scripts/demo/expectations.ts';
import { localRequest } from '../../scripts/demo/local-http.ts';
import { assertMasked, loadMaskSource, maskInitScript } from '../lib/mask.ts';
import { guardNetwork } from '../lib/network-guard.ts';
import { createCaseThroughForm, linkCard, openTab, selectActivityAddress, waitForRunFinished } from '../lib/ui.ts';
import { REPO_ROOT } from '../state.ts';
import { startStack } from '../stack/start.ts';
import { captions } from './captions.pl.ts';
import { OVERLAY_INIT_SCRIPT, mark, scrollToMiddle, unmark } from './overlay.ts';

const OUTPUT = join(REPO_ROOT, 'olcys-demo.mp4');
const RAW_DIR = join(REPO_ROOT, 'e2e', '.video');
const LIMIT_SECONDS = 180;
const FAST = 5;
const SLOW_MO_MS = 450;
const FFMPEG = process.env['FFMPEG'] ?? '/usr/bin/ffmpeg';
const FFPROBE = process.env['FFPROBE'] ?? '/usr/bin/ffprobe';
const executablePath =
  process.env['E2E_CHROMIUM'] ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const force = process.argv.includes('--force');
/** Published material is masked; `--no-mask` is for live rehearsal only. */
const mask = !process.argv.includes('--no-mask');
const maskSource = await loadMaskSource();
/** `--llm`: the local model (OVMS, see .env.example) suggests roles for one mention; default off. */
const llm = process.argv.includes('--llm');
if (llm) process.env['E2E_LLM'] = '1';
if (existsSync(OUTPUT) && !force) {
  console.error(`olcys-demo.mp4 already exists; not overwriting. Pass --force to record again.`);
  process.exit(2);
}

const expected = await loadExpectations();
const fmt = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);

rmSync(RAW_DIR, { recursive: true, force: true });
mkdirSync(RAW_DIR, { recursive: true });

const { state, stop } = await startStack();
let exitCode = 0;
try {
  exitCode = await record();
} finally {
  await stop();
}
process.exit(exitCode);

async function record(): Promise<number> {
  const browser = await chromium.launch({
    headless: true,
    slowMo: SLOW_MO_MS,
    ...(executablePath ? { executablePath } : {}),
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  const context = await browser.newContext({
    baseURL: state.baseURL,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: RAW_DIR, size: { width: 1920, height: 1080 } },
  });
  const guard = await guardNetwork(context);
  await context.addInitScript(OVERLAY_INIT_SCRIPT);
  if (mask) await context.addInitScript(maskInitScript(maskSource));
  const t0 = Date.now();
  const page = await context.newPage();
  const elapsed = () => (Date.now() - t0) / 1000;

  const caption = (patch: Record<string, unknown>) =>
    page.evaluate((p) => (globalThis as unknown as { __olcysCaption(p: unknown): void }).__olcysCaption(p), patch);
  const pause = (seconds: number) => page.waitForTimeout(seconds * 1000);
  /** Scrolls the element to the middle of the screen, outlines it for `seconds`, then removes the outline. */
  const show = async (target: Locator, seconds: number) => {
    // Fails (instead of highlighting nothing) when the target is not on screen.
    await target.first().waitFor({ state: 'visible', timeout: 10_000 });
    await target.first().evaluate(scrollToMiddle);
    await pause(1);
    await target.first().evaluate(mark);
    await pause(seconds);
    await target.first().evaluate(unmark);
  };

  const timings: { name: string; from: number; to: number }[] = [];
  const fastSegments: { from: number; to: number }[] = [];
  const step = async (name: string, c: { title: string; detail: string }, run: () => Promise<void>) => {
    const from = elapsed();
    await caption({ title: c.title, detail: c.detail, fast: '' });
    await run();
    await pause(1);
    if (mask) await assertMasked(page, maskSource);
    timings.push({ name: c.title, from, to: elapsed() });
  };
  /** Waiting for the analysis: shown sped up, and the caption says so. */
  const sped = async (run: () => Promise<void>) => {
    await caption({ fast: fmt(captions.fast, { factor: String(FAST) }) });
    const from = elapsed();
    await run();
    fastSegments.push({ from, to: elapsed() });
    await caption({ fast: '' });
  };

  await page.goto('/');
  await caption({ badge: captions.syntheticBadge });
  await caption({ card: captions.titleCard });
  await pause(4);
  await caption({ card: null });

  const c = captions.steps;
  const btc1 = expected.addressOf('BTC-1');
  const [l1, l2, l3] = expected.v1.links;
  const scores = expected.v1.links.map((l) => l.score).join(' / ');
  let caseId = '';

  await step('input', c.input, async () => {
    const created = await createCaseThroughForm(page, {
      beforeSubmit: async () => {
        await show(
          page.locator('fieldset', { has: page.getByText(pl.caseForm.sources, { exact: true }) }).first(),
          2.5,
        );
        await show(page.getByLabel(pl.caseForm.minimisationConfirm), 1.5);
      },
    });
    caseId = created.caseId;
  });

  await step('search', c.search, async () => {
    await pause(1);
    await sped(() => waitForRunFinished(page));
    await pause(2);
    await openTab(page, pl.tabs.sources);
    await show(page.locator('section[aria-labelledby="egress-title"]'), 4);
  });

  await step('detection', c.detection, async () => {
    await openTab(page, pl.tabs.links);
    const card = linkCard(page, btc1.address);
    await show(card.locator('.link-head'), 4);
    if (llm) {
      // The suggestion hangs on the evidence of the card that cites the classified mention: open the explanations.
      const badge = page.getByText(pl.suggestion.badge).first();
      let shown = false;
      for (const address of [btc1.address, ...expected.v1.links.slice(1).map((l) => l.address)]) {
        const summary = linkCard(page, address).locator('details.explain > summary');
        await summary.click();
        if (await badge.isVisible()) {
          await show(badge, 4);
          await summary.click(); // close the explanation again: the score step opens it on its own
          shown = true;
          break;
        }
        await summary.click();
      }
      if (!shown) console.warn('No AI suggestion card appeared; the video is recorded without it.');
    }
  });

  await step('score', { ...c.score, detail: fmt(c.score.detail, { scores }) }, async () => {
    for (const link of [l1, l2, l3]) {
      if (!link) continue;
      await show(linkCard(page, link.address).locator('.link-head'), 2);
    }
    const btc = linkCard(page, btc1.address);
    // Open the explanation unless it already is, then the formula must be visible.
    if ((await btc.locator('details.explain').getAttribute('open')) === null) {
      await btc.locator('details.explain > summary').click();
    }
    await show(btc.locator('.formula').first(), 4);
    await btc.locator('details.explain > summary').click();
  });

  await step(
    'rejected',
    { ...c.rejected, detail: fmt(c.rejected.detail, { rules: expected.v1.rejected.map((r) => r.rule).join(', ') }) },
    async () => {
      await openTab(page, pl.tabs.rejected);
      await pause(1);
      for (const rule of ['A1:', 'A2:', 'A4:']) await show(page.getByText(rule).first(), 2);
      await show(page.getByText('κ (dopasowanie przekazania depozytu)').first(), 2);
    },
  );

  await step('activity', c.activity, async () => {
    await openTab(page, pl.tabs.activity);
    await selectActivityAddress(page, expected.addressOf('ETH-1').address);
    const b1 = page.locator('li.cashout-card').filter({ has: page.getByRole('heading', { level: 4, name: /^B1:/ }) });
    await show(b1, 5);
    await show(b1.getByText(/kurs średni NBP/), 3);
    await selectActivityAddress(page, expected.addressOf('TRON-1').address);
    await show(page.locator('section[aria-labelledby="cashout-title"]'), 4);
  });

  await step(
    'rerun',
    {
      ...c.rerun,
      detail: fmt(c.rerun.detail, { from: expected.v2.changes[0]!.from.slot, to: expected.v2.changes[0]!.to.slot }),
    },
    async () => {
      const switched = await localRequest(`${state.fixtureUrl}/__fixture/variant`, {
        method: 'POST',
        body: 'v2',
        contentType: 'text/plain',
      });
      if (!('status' in switched) || switched.status !== 204) throw new Error('fixture variant switch is off');
      await page.goto(`/sprawy/${caseId}`);
      await pause(1);
      await page.getByRole('button', { name: pl.casePage.rerun }).click();
      await pause(1);
      await sped(() => waitForRunFinished(page));
      await pause(1);
      await openTab(page, pl.tabs.changes);
      const change = expected.v2.changes[0]!;
      await show(page.getByRole('heading', { name: pl.changes.alertTitle }), 3);
      await show(page.getByText(change.to.address).first(), 4);
      await show(page.getByRole('heading', { name: pl.pageTimeline.title }), 3.5);
      await openTab(page, pl.tabs.links);
      await show(linkCard(page, expected.v2.links[1]!.address).locator('.link-head'), 3);
    },
  );

  await step('report', c.report, async () => {
    await openTab(page, pl.tabs.sources);
    await show(page.locator('section[aria-labelledby="egress-title"]'), 2);
    await openTab(page, pl.tabs.report);
    const main = page.locator('main');
    await show(main.locator('section[aria-labelledby="report-repro"]'), 2.5);
    for (const name of [pl.report.sections.facts, pl.report.sections.computed, pl.report.sections.inferences]) {
      await show(main.getByRole('heading', { name }), 2);
    }
    await show(main.locator('section[aria-labelledby="report-downloads"]'), 3);
  });

  await caption({ title: '', detail: '', fast: '' });
  await caption({ card: captions.endCard });
  await pause(5);
  const rawSeconds = elapsed();

  await context.close();
  const videoPath = await page.video()?.path();
  await browser.close();
  if (!videoPath) throw new Error('Playwright did not record a video.');

  if (guard.violations.length > 0 || guard.pageErrors.length > 0) {
    console.error('Recording aborted: requests to non-local hosts or page errors:', guard.violations, guard.pageErrors);
    return 1;
  }

  convert(videoPath, fastSegments, rawSeconds);
  const total = probeSeconds(OUTPUT);
  const saved = fastSegments.reduce((sum, s) => sum + (s.to - s.from) * (1 - 1 / FAST), 0);
  const outTime = (t: number) =>
    t - fastSegments.reduce((sum, s) => sum + Math.max(0, Math.min(t, s.to) - s.from) * (1 - 1 / FAST), 0);
  console.info('\nStep durations in the final video:');
  for (const t of timings) console.info(`  ${t.name}: ${(outTime(t.to) - outTime(t.from)).toFixed(1)} s`);
  console.info(
    `Raw recording: ${rawSeconds.toFixed(1)} s, after speeding up the waits (-${saved.toFixed(1)} s): ${total.toFixed(1)} s`,
  );
  const size = statSync(OUTPUT).size / 1e6;
  console.info(`File: ${OUTPUT} (${size.toFixed(1)} MB)`);
  if (total > LIMIT_SECONDS) {
    rmSync(OUTPUT, { force: true });
    console.error(`The video is ${total.toFixed(1)} s long; the limit is ${LIMIT_SECONDS} s. File deleted.`);
    return 1;
  }
  return 0;
}

/** webm -> H.264 MP4 (30 fps, CRF 23, faststart) with the waiting segments sped up. */
function convert(webm: string, segments: { from: number; to: number }[], total: number): void {
  const cuts: { from: number; to: number; speed: number }[] = [];
  let at = 0;
  for (const s of segments) {
    if (s.from > at) cuts.push({ from: at, to: s.from, speed: 1 });
    cuts.push({ from: s.from, to: s.to, speed: FAST });
    at = s.to;
  }
  cuts.push({ from: at, to: total + 5, speed: 1 });
  const filters = cuts.map(
    (cut, i) =>
      `[0:v]trim=start=${cut.from.toFixed(3)}:end=${cut.to.toFixed(3)},setpts=(PTS-STARTPTS)/${cut.speed}[v${i}]`,
  );
  const chain = `${filters.join(';')};${cuts.map((_, i) => `[v${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0[out]`;
  if (existsSync(OUTPUT)) rmSync(OUTPUT);
  execFileSync(
    FFMPEG,
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      webm,
      '-filter_complex',
      chain,
      '-map',
      '[out]',
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-crf',
      '23',
      '-preset',
      'medium',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      OUTPUT,
    ],
    { stdio: 'inherit' },
  );
}

function probeSeconds(file: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
  });
  return Number(out.trim());
}
