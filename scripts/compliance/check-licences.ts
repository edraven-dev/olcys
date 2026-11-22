/**
 * Evaluates every npm package of the lockfile (including platform-specific optional ones that license-checker cannot
 * see) and every Python package against config/licenses.json. Exits 1 and names each component that is denied or
 * needs a review.
 *
 *   node scripts/compliance/check-licences.ts
 */
import { loadContext } from './context.ts';
import { decideComponent } from './policy.ts';

const ctx = await loadContext();
const all = [...ctx.npm, ...ctx.python];
const problems = all.flatMap((c) => {
  const decision = decideComponent(c, ctx.policy, ctx.exceptions);
  return decision.verdict === 'allow'
    ? []
    : [
        `${decision.verdict.toUpperCase()}: ${c.ecosystem} ${c.name}@${c.version} licence=${c.licence ?? 'none'} (${decision.rule})`,
      ];
});
if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`${problems.length} of ${all.length} components violate the licence policy`);
  process.exit(1);
}
console.log(`licence policy: ${all.length} components (npm ${ctx.npm.length}, Python ${ctx.python.length}) allowed`);
