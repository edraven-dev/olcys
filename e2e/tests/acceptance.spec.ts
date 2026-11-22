/**
 * Acceptance test of the mandatory demo scenario: the seven steps in the Polish console, then the re-run with the
 * wallet-swap alert. Expected values come from `fixtures/demo/manifest.json`; labels come from the app's catalogue.
 * The browser may only talk to loopback; anything else fails the test.
 */
import { expect, test } from '../lib/test.ts';
import { pl } from '../../apps/web/src/i18n/pl.ts';
import { loadExpectations, type Expectations } from '../../scripts/demo/expectations.ts';
import { guardNetwork, type NetworkGuard } from '../lib/network-guard.ts';
import { prepareContext, shot } from '../lib/screenshots.ts';
import { createCaseThroughForm, linkCard, openTab, selectActivityAddress, waitForRunFinished } from '../lib/ui.ts';
import { readState } from '../state.ts';
import { localRequest } from '../../scripts/demo/local-http.ts';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

const PLN = /\d[\d\s  ]*,\d{2}\s?zł/;

let expected: Expectations;
let guard: NetworkGuard;
let caseId = '';
let run1 = '';
let run2 = '';

test.beforeAll(async () => {
  expected = await loadExpectations();
});

test.beforeEach(async ({ context }) => {
  // One guard per test context; Playwright gives every test of the serial block a fresh context.
  guard = await guardNetwork(context);
  await prepareContext(context);
});

test.afterEach(() => {
  expect(guard.violations, 'non-local requests attempted by the browser').toEqual([]);
  expect(guard.pageErrors, 'page and console errors').toEqual([]);
});

/** The serial block shares one page through a persistent context, so the case survives between tests. */
test('step 1: input — the case is created through the form', async ({ page }) => {
  const created = await createCaseThroughForm(page, {
    beforeSubmit: () => shot(page, '02-nowa-sprawa', page.getByLabel(pl.caseForm.caseTitle, { exact: true })),
  });
  caseId = created.caseId;
  run1 = created.runId;
  await expect(page).toHaveURL(new RegExp(`/sprawy/${caseId}/przebiegi/${run1}/przeglad$`));
  // The case page shows the locked scope: the manifest's sources, X/Twitter-class sources off.
  await page.goto(`/sprawy/${caseId}`);
  await expect(page.getByRole('heading', { name: pl.casePage.sectionScope })).toBeVisible();
  const scope = page.locator('main');
  await expect(scope).toContainText('fikcyjny_kacper');
  await expect(scope).toContainText('bitcointalk');
  await expect(scope).not.toContainText('X / Twitter');
  await expect(scope).toContainText(pl.casePage.sectionIdentifiers);
});

test('step 2: OSINT search — the run finishes and every request is logged', async ({ page }) => {
  await page.goto(`/sprawy/${caseId}/przebiegi/${run1}/przeglad`);
  await waitForRunFinished(page);
  await expect(page.getByText(pl.modes.offline, { exact: false }).first()).toBeVisible();
  await shot(page, '03-przebieg');

  await openTab(page, pl.tabs.sources);
  await expect(page.getByRole('heading', { name: pl.sources.title })).toBeVisible();
  const log = page.locator('section[aria-labelledby="egress-title"]');
  await expect(log.getByRole('heading', { name: pl.egress.title })).toBeVisible();
  const rows = log.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
  // Every logged host is the local fixture site or a replayed provider: none is a public host.
  const hosts = await log.locator('tbody tr td:nth-child(3)').allTextContents();
  expect(hosts.length).toBeGreaterThan(0);
  for (const host of hosts) expect(host.trim()).toMatch(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
  // Identifier-disclosing requests are flagged.
  await expect(log.getByText(pl.egress.disclosed).first()).toBeVisible();
  // Captures: URL, time and SHA-256 manifest for the profile page.
  await expect(page.getByRole('heading', { name: pl.sources.capturesTitle })).toBeVisible();
  await expect(page.locator('main')).toContainText('index.php?action=profile;user=fikcyjny_kacper');
});

test('step 3: address detection — validated addresses and rejected candidates', async ({ page }) => {
  await page.goto(`/sprawy/${caseId}/przebiegi/${run1}/przeglad`);
  const counters = page.locator('main');
  await expect(counters).toContainText(pl.overview.resultTitle);
  const btc1 = expected.addressOf('BTC-1');
  await openTab(page, pl.tabs.links);
  const card = linkCard(page, btc1.address);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(btc1.address);
  await expect(card).toContainText('Bitcoin');
  await expect(card).toContainText('fikcyjny_kacper');
  // The rejected candidates of the detection stage are listed with a reason.
  await openTab(page, pl.tabs.rejected);
  await expect(page.getByText('przykład z dokumentacji lub wektor testowy').first()).toBeVisible();
  await expect(page.getByText(/skrót transakcji/).first()).toBeVisible();
  await expect(page.getByText(/homoglify/).first()).toBeVisible();
});

test('step 4: Confidence Score — manifest scores, bands, separate confidence', async ({ page }) => {
  await page.goto(`/sprawy/${caseId}/przebiegi/${run1}/powiazania`);
  await expect(page.getByText(pl.links.statementHint).first()).toBeAttached();
  await expect(page.getByText('Wynik wspiera ocenę analityka — nie zastępuje jej.')).toBeVisible();
  for (const link of expected.v1.links) {
    const card = linkCard(page, link.address);
    await expect(card, link.slot).toHaveCount(1);
    await expect(card.locator('.score-number'), link.slot).toHaveText(String(link.score));
    // The analytic confidence is shown separately from the probability.
    await expect(card.locator('.confidence-box'), link.slot).toContainText('Pewność analityczna');
  }
  // Order: the highest score first.
  const scores = (await page.locator('li.link-card .score-number').allTextContents()).map(Number);
  expect(scores.slice(0, expected.v1.links.length)).toEqual(expected.v1.links.map((l) => l.score));
  // Bands (ICD 203 wording) of the three manifest links.
  await expect(linkCard(page, expected.addressOf('BTC-1').address)).toContainText('niemal pewne');
  await expect(linkCard(page, expected.addressOf('TRON-1').address)).toContainText('prawdopodobne');
  await expect(linkCard(page, expected.addressOf('ETH-2').address)).toContainText('mało prawdopodobne');
  // The explanation opens and shows the formula for BTC-1.
  const btc = linkCard(page, expected.addressOf('BTC-1').address);
  await btc.locator('details.explain > summary').click();
  await expect(btc.locator('.formula').first()).toBeVisible();
  await btc.locator('details.explain > summary').click();
  // Addresses the manifest gives a zero score never appear as links.
  for (const zero of expected.v1.zeroScore) await expect(linkCard(page, zero.address)).toHaveCount(0);
  await shot(page, '04-powiazania', btc);
});

test('step 5: rejected misattributions — rules, labels and decoys', async ({ page }) => {
  await page.goto(`/sprawy/${caseId}/przebiegi/${run1}/odrzucone`);
  const main = page.locator('main');
  await expect(main).toContainText(pl.rejected.title);
  for (const rejection of expected.v1.rejected) {
    if (rejection.rule === 'A8') {
      // The BIP-173 documentation example is rejected at validation, before any rule runs.
      await expect(main).toContainText(rejection.address);
      await expect(main).toContainText('przykład z dokumentacji lub wektor testowy');
      continue;
    }
    const card = main
      .locator('li')
      .filter({ hasText: new RegExp(rejection.address, 'i') })
      .first();
    await expect(card, rejection.slot).toContainText(`${rejection.rule}:`);
  }
  // A4: the deposit address with its handover match κ.
  await expect(main).toContainText('κ (dopasowanie przekazania depozytu)');
  await expect(main).toContainText('0,96');
  // Third-party attribution and weak identity are separate sections; the hot wallet carries its label provenance.
  await expect(main).toContainText(pl.rejected.weakIntro);
  await expect(main).toContainText('Giełda Testowa (SYNTHETIC)');
  await expect(main).toContainText('demo-curated');
  await expect(main).toContainText('przypisany przez stronę trzecią');
  await expect(main).toContainText(/skrót transakcji/);
  await expect(main).toContainText(/homoglify/);
  await shot(page, '05-odrzucone', main.getByText('A4:').first());
});

test('step 6: on-chain activity — fiat cash-out with the NBP table', async ({ page }) => {
  await page.goto(`/sprawy/${caseId}/przebiegi/${run1}/aktywnosc`);
  const main = page.locator('main');
  await expect(main).toContainText(pl.activity.syntheticNote);
  await expect(main).toContainText('Przesłanka nie jest dowodem');
  for (const slot of ['ETH-1', 'TRON-1']) {
    await selectActivityAddress(page, expected.addressOf(slot).address);
    const section = page.locator('section[aria-labelledby="cashout-title"]');
    await expect(section).toBeVisible();
    for (const event of expected.v1.cashOut.filter((e) => e.slot === slot)) {
      const rule = pl.activity.cashOutRules[event.rule as keyof typeof pl.activity.cashOutRules];
      await expect(section, `${slot} ${event.rule}`).toContainText(`${event.rule}: ${rule}`);
    }
    if (slot === 'ETH-1') {
      // Exactly one B1 event, valued in PLN at the NBP average rate of the day before.
      const b1 = section
        .locator('li.cashout-card')
        .filter({ has: page.getByRole('heading', { level: 4, name: /^B1:/ }) });
      await expect(b1).toHaveCount(1);
      await expect(b1).toContainText(PLN);
      await expect(b1).toContainText(/tabela SYN\d+\/A\/NBP\/\d{4}/);
      await expect(b1).toContainText('kurs średni NBP');
      await shot(page, '06-aktywnosc', b1);
    }
  }
  // The graph is a second view of the same results.
  await page.goto(`/sprawy/${caseId}/przebiegi/${run1}/graf`);
  await expect(page.getByRole('heading', { name: pl.graph.title })).toBeVisible();
  await expect(page.locator('main canvas, main svg').first()).toBeVisible();
  await shot(page, '07-graf', page.locator('main canvas').first());
});

test('step 7a: re-run — the wallet swap raises an alert', async ({ page }) => {
  const stack = readState();
  const switched = await localRequest(`${stack.fixtureUrl}/__fixture/variant`, {
    method: 'POST',
    body: 'v2',
    contentType: 'text/plain',
  });
  expect('status' in switched ? switched.status : 0).toBe(204);

  await page.goto(`/sprawy/${caseId}`);
  await page.getByRole('button', { name: pl.casePage.rerun }).click();
  await expect(page).toHaveURL(/\/przebiegi\/[^/]+\/przeglad$/);
  run2 = new URL(page.url()).pathname.split('/')[4]!;
  expect(run2).not.toBe(run1);
  await waitForRunFinished(page);
  await expect(page.locator('a.alert-link')).toBeVisible();

  await openTab(page, pl.tabs.changes);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: pl.changes.alertTitle })).toBeVisible();
  const change = expected.v2.changes[0]!;
  expect(change.kind).toBe('VALUE_CHANGED');
  await expect(main).toContainText(pl.changes.properties[change.property as keyof typeof pl.changes.properties] ?? '');
  await expect(main).toContainText(`${pl.changes.before}`);
  await expect(main).toContainText(change.from.address);
  await expect(main).toContainText(change.to.address);
  await expect(main).toContainText(pl.changes.snapshotBefore);
  await expect(main).toContainText(pl.changes.snapshotAfter);
  await shot(page, '08-zmiany', main.getByRole('heading', { name: pl.changes.alertTitle }));
  const timeline = main.getByRole('heading', { name: pl.pageTimeline.title });
  await expect(timeline).toBeVisible();
  await shot(page, '08-zmiany-os-czasu', timeline);

  // The new address is scored as in the manifest.
  await openTab(page, pl.tabs.links);
  for (const link of expected.v2.links) {
    await expect(linkCard(page, link.address).locator('.score-number'), link.slot).toHaveText(String(link.score));
  }
});

test('step 7b: sources and the final report', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.locator('main')).toContainText('Kacper Fikcyjny (demonstracja)');
  await shot(page, '01-sprawy');

  await page.goto(`/sprawy/${caseId}/przebiegi/${run2}/raport`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: pl.report.sections.repro })).toBeVisible();
  // The three statement classes, in order, as headings of the native report tab.
  const classes = [pl.report.sections.facts, pl.report.sections.computed, pl.report.sections.inferences];
  const headings = await main.locator('h3').allTextContents();
  const positions = classes.map((name) => headings.findIndex((h) => h.includes(name)));
  expect(
    positions.every((p) => p >= 0),
    `A/B/C headings: ${positions}`,
  ).toBe(true);
  expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  // Reproducibility block: weights version and the digests of weights and sources.
  const repro = main.locator('section[aria-labelledby="report-repro"]');
  await expect(repro).toContainText('weights.v2');
  await expect(repro).toContainText(pl.report.repro.weightsSha);
  await expect(repro).toContainText(pl.report.repro.sourcesSha);
  await expect(main.locator('section[aria-labelledby="report-summary"]')).toContainText(
    expected.v2.links[0]!.address.slice(0, 12),
    { ignoreCase: true },
  );
  // Downloads: every available file lists its SHA-256 (64 hex characters).
  const downloads = main.locator('section[aria-labelledby="report-downloads"]');
  await expect(downloads.getByRole('heading', { name: pl.report.downloads.title })).toBeVisible();
  // Every available file row carries a 64-hex SHA-256; only rows explicitly marked unavailable (e.g. PDF without
  // Gotenberg) are excluded.
  const rows = downloads.locator('tbody tr');
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  let checked = 0;
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    if (await row.getByText(pl.report.downloads.unavailable, { exact: true }).count()) continue;
    await expect(row.locator('td:nth-child(3)'), `SHA-256 of row ${i}`).toHaveText(/[0-9a-f]{64}/i);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
  await shot(page, '09-raport', main.getByRole('heading', { name: pl.report.sections.facts }));

  // The read-only settings page.
  await page.goto('/ustawienia');
  await expect(page.getByRole('heading', { level: 1, name: pl.settings.title })).toBeVisible();
  await expect(page.locator('main')).toContainText(pl.settings.readOnly);
  await shot(page, '10-ustawienia');
});
