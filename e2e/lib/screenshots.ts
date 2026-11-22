import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { assertMasked, loadMaskSource, maskEnabled, maskInitScript, type MaskSource } from './mask.ts';
import { REPO_ROOT } from '../state.ts';

export const SCREENSHOT_DIR = join(REPO_ROOT, 'docs', 'assets', 'screenshots');
export const screenshotsEnabled = (): boolean => process.env['E2E_SCREENSHOTS'] === '1';

let maskSource: MaskSource | undefined;
/** Screenshot mode: identifying data is masked in the page unless `--no-mask` (live rehearsal). */
export async function prepareContext(context: BrowserContext): Promise<void> {
  if (!screenshotsEnabled() || !maskEnabled()) return;
  maskSource ??= await loadMaskSource();
  await context.addInitScript(maskInitScript(maskSource));
}

/** Writes `<name>.png` (1440 px wide viewport) when screenshots were requested; synthetic data only. */
export async function shot(page: Page, name: string, focus?: Locator): Promise<void> {
  if (!screenshotsEnabled()) return;
  // Bring the key content into the 1440 px frame (centred when it is below the fold).
  if (focus) await focus.scrollIntoViewIfNeeded();
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  // Let layout, charts and web fonts settle (no remote fonts are used).
  await page.waitForTimeout(600);
  // Fails the run when persona text or an address is visible without a mask.
  if (maskSource && maskEnabled()) await assertMasked(page, maskSource);
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}
