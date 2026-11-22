/** Adds the registered prompts that are not yet in `prompts.lock.json`; refuses to rewrite an existing entry. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extendLock, listPrompts, type PromptLock } from '../src/prompts/index.ts';

const path = fileURLToPath(new URL('../prompts.lock.json', import.meta.url));
const { lock, added, problems } = extendLock(listPrompts(), JSON.parse(readFileSync(path, 'utf8')) as PromptLock);
if (problems.length > 0) {
  console.error(
    `${problems.join('\n')}\nprompts.lock.json not changed: add a new version instead of editing a released one`,
  );
  process.exit(1);
}
writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
console.log(added.length > 0 ? `locked: ${added.join(', ')}` : 'nothing to lock');
