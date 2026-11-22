/**
 * Generates (--write) or verifies (--check) the tables between the `generated:licenses` markers of
 * docs/compliance/licenses.md. The hand-maintained sections stay untouched.
 *
 *   node scripts/compliance/licenses-doc.ts --check
 *   node scripts/compliance/licenses-doc.ts --write [--out <file>]
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContext } from './context.ts';
import { checkLicensesDoc, renderLicensesDoc, writeLicensesDoc } from './doc.ts';
import { checkImages, findImageUses, loadImageSpecs } from './images.ts';
import { REPO_ROOT } from './policy.ts';

const { values } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
  strict: true,
});
if (values.write === values.check) {
  console.error('usage: licenses-doc.ts --write | --check [--out <file>]');
  process.exit(2);
}

const ctx = await loadContext();
const images = checkImages(await findImageUses(REPO_ROOT), await loadImageSpecs(REPO_ROOT), ctx.policy, ctx.exceptions);
const generated = renderLicensesDoc({
  npm: ctx.npm,
  python: ctx.python,
  npmPurposes: ctx.components.npmPurposes,
  pythonPurposes: Object.fromEntries(Object.entries(ctx.components.python).map(([n, v]) => [n, v.purpose])),
  images,
  policy: ctx.policy,
  exceptions: ctx.exceptions,
  pythonHasLock: ctx.pythonInput.uvLock !== undefined,
});
const path = values.out ?? join(REPO_ROOT, 'docs', 'compliance', 'licenses.md');

if (values.check) {
  if (!(await checkLicensesDoc(path, generated))) {
    console.error(`${path} is out of date: run "pnpm licenses:docs --write"`);
    process.exit(1);
  }
  console.log(`${path} is up to date`);
} else {
  console.log((await writeLicensesDoc(path, generated)) ? 'document regenerated' : 'document already up to date');
}
