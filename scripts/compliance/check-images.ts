/**
 * Container-image licence check: every compose.yml `image:` and Dockerfile `FROM` must be listed in
 * config/compliance/components.yaml with an allowed licence (copyleft only with `separateService: true`).
 *
 *   node scripts/compliance/check-images.ts
 */
import { checkImages, findImageUses, loadImageSpecs } from './images.ts';
import { loadPolicy, REPO_ROOT } from './policy.ts';

const findings = checkImages(
  await findImageUses(REPO_ROOT),
  await loadImageSpecs(REPO_ROOT),
  await loadPolicy(REPO_ROOT),
);
const problems = findings.filter((f) => f.decision.verdict !== 'allow');
for (const f of problems) {
  console.error(`${f.decision.verdict.toUpperCase()}: image ${f.ref} (${f.file}: ${f.where}) — ${f.decision.rule}`);
}
if (problems.length > 0) {
  console.error(`${problems.length} of ${findings.length} images violate the licence policy`);
  process.exit(1);
}
console.log(`images: ${findings.length} image references allowed`);
