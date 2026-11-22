/** Helpers that drive the Polish console. Every label comes from the app's own catalogue. */
import { expect, type Locator, type Page } from '@playwright/test';
import type { DomNode } from './dom.ts';
import { pl } from '../../apps/web/src/i18n/pl.ts';
import { t } from '../../apps/web/src/i18n/t.ts';
import { demoCase } from '../../scripts/demo/run.ts';

export const TERMINAL_TEXT = (status: string) => t(pl.run.live.finished, { status });

/** Fills „Nowa sprawa” with the demo persona's case (manifest scope) and submits it; resolves at the run page. */
export async function createCaseThroughForm(
  page: Page,
  options: { beforeSubmit?: () => Promise<void> } = {},
): Promise<{
  caseId: string;
  runId: string;
}> {
  await page.goto('/sprawy/nowa');
  await expect(page.getByRole('heading', { level: 1, name: pl.caseForm.title })).toBeVisible();
  const form = page.locator('form.case-form');
  await expect(form.locator('input[id$="-src-bitcointalk"]')).toBeVisible();

  await form.getByLabel(pl.caseForm.caseTitle, { exact: true }).fill(demoCase.title);
  await form.getByLabel(pl.caseForm.purpose, { exact: true }).fill(demoCase.purpose);
  await form.getByLabel(pl.caseForm.legalBasis, { exact: true }).fill(demoCase.legalBasis);

  // The form starts with one row; the persona has three identifiers.
  for (let i = 1; i < demoCase.identifiers.length; i++) {
    await form.getByRole('button', { name: pl.caseForm.addIdentifier }).click();
  }
  const rows = form.locator('fieldset.identifier-row');
  await expect(rows).toHaveCount(demoCase.identifiers.length);
  for (const [index, identifier] of demoCase.identifiers.entries()) {
    const row = rows.nth(index);
    await row
      .getByLabel(pl.caseForm.kind, { exact: true })
      .selectOption({ label: pl.identifierKinds[identifier.kind] });
    await row.getByLabel(pl.caseForm.value, { exact: true }).fill(identifier.value);
    if (identifier.platform) await row.getByLabel(pl.caseForm.platform).fill(identifier.platform);
    if (identifier.isAnchor) await row.getByLabel(pl.caseForm.anchor).check();
  }

  // Scope: exactly the manifest's sources (everything else stays off), AMBER ones with a justification.
  const wanted = new Set(demoCase.scope.enabledSources);
  const states = await form.evaluate((f: DomNode) =>
    [...f.querySelectorAll('input[type="checkbox"][id*="-src-"]:not([id$="-why"])')].map(
      (e) => [e.id, e.checked, e.disabled] as [string, boolean, boolean],
    ),
  );
  for (const [domId, checked, disabled] of states) {
    const id = domId.replace(/^.*-src-/, '');
    if (disabled || checked === wanted.has(id)) continue;
    await form.locator(`[id="${domId}"]`).setChecked(wanted.has(id));
  }
  for (const [source, text] of Object.entries(demoCase.scope.amberJustifications ?? {})) {
    await form.locator(`textarea[id$="-src-${source}-why"]`).fill(text);
  }
  await form.getByLabel(pl.caseForm.minimisationConfirm).check();
  await options.beforeSubmit?.();

  await form.getByRole('button', { name: pl.caseForm.submitAndRun }).click();
  await page.waitForURL(/\/sprawy\/[^/]+\/przebiegi\/[^/]+\/przeglad$/);
  const [, , caseId, , runId] = new URL(page.url()).pathname.split('/');
  return { caseId: caseId!, runId: runId! };
}

/** Waits until the run page reports the terminal state. */
export async function waitForRunFinished(page: Page, timeoutMs = 240_000): Promise<void> {
  await expect(page.getByText(/Analiza zakończona — status:/)).toBeVisible({ timeout: timeoutMs });
}

export const tabLink = (page: Page, name: string): Locator =>
  page.getByRole('navigation', { name: pl.tabs.label }).getByRole('link', { name });

export async function openTab(page: Page, name: string): Promise<void> {
  await tabLink(page, name).click();
}

/** The link card of an address (the console shows EVM addresses in lower case). */
export const linkCard = (page: Page, address: string): Locator =>
  page.locator('li.link-card').filter({ hasText: new RegExp(address, 'i') });

export const shortAddress = (address: string): string => address.slice(0, 10).toLowerCase();

export async function selectActivityAddress(page: Page, address: string): Promise<void> {
  const select = page.getByLabel(pl.activity.address);
  const option = select.locator('option').filter({ hasText: shortAddress(address) });
  await select.selectOption({ value: (await option.first().getAttribute('value'))! });
}
