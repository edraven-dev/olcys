/**
 * Generates (--write) or verifies (--check) the tables in docs/compliance/sources.md from config/sources.yaml and
 * config/forbidden-tools.yaml. Only the block between the generated markers changes.
 *
 *   node packages/collectors/scripts/sources-doc.ts --check
 *   node packages/collectors/scripts/sources-doc.ts --write [--lang pl|en] [--out <file>]
 */
import { parseArgs } from 'node:util';
import { checkSourcesDoc, writeSourcesDoc, type DocLang } from '../src/compliance/doc.ts';

const { values } = parseArgs({
  options: {
    write: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    lang: { type: 'string', default: 'pl' },
    out: { type: 'string' },
  },
  strict: true,
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

if (values.write === values.check) fail('usage: sources-doc.ts --write | --check [--lang pl|en] [--out <file>]');
if (values.lang !== 'pl' && values.lang !== 'en') fail('--lang must be pl or en');
if (values.lang === 'en' && !values.out) fail('--lang en needs --out <file> (the committed document is Polish)');
const options = { lang: values.lang as DocLang, ...(values.out ? { out: values.out } : {}) };

if (values.check) {
  const { path, upToDate } = await checkSourcesDoc(options);
  if (!upToDate) {
    console.error(`${path} is out of date: run "node packages/collectors/scripts/sources-doc.ts --write"`);
    process.exit(1);
  }
  console.log(`${path} is up to date`);
} else {
  const changed = await writeSourcesDoc(options);
  console.log(changed ? 'document regenerated' : 'document already up to date');
}
