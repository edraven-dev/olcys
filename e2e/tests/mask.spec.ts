/** The mask must already hide persona values while they are typed (the video would otherwise capture them). */
import type { DomNode } from '../lib/dom.ts';
import { loadMaskSource, maskInitScript } from '../lib/mask.ts';
import { expect, test } from '../lib/test.ts';
import { pl } from '../../apps/web/src/i18n/pl.ts';

test('case form inputs are blurred from the first paint and at every keystroke', async ({ page, context }) => {
  await context.addInitScript(maskInitScript(await loadMaskSource()));
  await page.goto('/sprawy/nowa');
  const form = page.locator('form.case-form');
  const title = form.getByLabel(pl.caseForm.caseTitle, { exact: true });
  const value = form.locator('fieldset.identifier-row').first().getByLabel(pl.caseForm.value, { exact: true });
  const blurred = (field: typeof title) =>
    field.evaluate((el: DomNode) =>
      (globalThis as unknown as { getComputedStyle(e: DomNode): { filter: string } })
        .getComputedStyle(el)
        .filter.includes('blur'),
    );
  // Blurred while still empty, i.e. before anything sensitive is typed.
  expect(await blurred(title)).toBe(true);
  expect(await blurred(value)).toBe(true);
  for (const ch of 'fikcyjny_kacper@example.org') {
    await value.pressSequentially(ch);
    expect(await blurred(value), `after typing "${ch}"`).toBe(true);
  }
});
