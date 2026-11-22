/** `prompts.lock.json` maps `<task>@<version>` to the prompt's SHA-256; entries are only ever added. */
import type { PromptDefinition } from './registry.ts';
import { promptKey } from './registry.ts';

export type PromptLock = Record<string, string>;

/** One line per prompt that is changed without a version bump (empty = consistent). Unlocked prompts are fine. */
export function lockProblems(prompts: readonly PromptDefinition<unknown>[], lock: PromptLock): string[] {
  const problems: string[] = [];
  for (const p of prompts) {
    const key = promptKey(p.task, p.version);
    const locked = lock[key];
    if (locked !== undefined && locked !== p.sha256) problems.push(`prompt changed without version bump: ${key}`);
  }
  return problems;
}

/** The lock extended with the new prompts; an existing entry is never rewritten (a mismatch is a problem). */
export function extendLock(
  prompts: readonly PromptDefinition<unknown>[],
  lock: PromptLock,
): { lock: PromptLock; added: string[]; problems: string[] } {
  const problems = lockProblems(prompts, lock);
  const next: PromptLock = { ...lock };
  const added: string[] = [];
  for (const p of prompts) {
    const key = promptKey(p.task, p.version);
    if (next[key] === undefined) {
      next[key] = p.sha256;
      added.push(key);
    }
  }
  const sorted = Object.fromEntries(Object.entries(next).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { lock: sorted, added, problems };
}
