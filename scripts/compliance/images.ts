/**
 * Container-image licence check. Every `image:` in compose.yml and every Dockerfile `FROM` must be listed in
 * config/compliance/components.yaml (`images:`, keyed by the repository path without tag) with a licence; copyleft
 * (separateServiceOnly) licences additionally need `separateService: true`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { cmp } from './cyclonedx.ts';
import { decideComponent, type ComponentDecision, type LicenceException, type LicencePolicy } from './policy.ts';

export interface ImageSpec {
  licence: string;
  purpose: string;
  separateService?: boolean;
}

export interface ImageUse {
  ref: string;
  /** Repository path without registry tag/digest, e.g. `gotenberg/gotenberg`. */
  repository: string;
  tag: string;
  file: string;
  /** compose service name, or `FROM` for Dockerfiles. */
  where: string;
}

export interface ImageFinding extends ImageUse {
  decision: ComponentDecision | { verdict: 'review'; rule: 'not-in-components.yaml' };
  spec?: ImageSpec;
}

export function splitImage(ref: string): { repository: string; tag: string } {
  const noDigest = ref.split('@')[0] ?? ref;
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.indexOf(':', slash + 1);
  return colon === -1
    ? { repository: noDigest, tag: 'latest' }
    : { repository: noDigest.slice(0, colon), tag: noDigest.slice(colon + 1) };
}

export function composeImages(text: string, file: string): ImageUse[] {
  const doc = parse(text) as { services?: Record<string, { image?: string }> } | null;
  return Object.entries(doc?.services ?? {}).flatMap(([service, def]) =>
    typeof def?.image === 'string' ? [{ ref: def.image, ...splitImage(def.image), file, where: service }] : [],
  );
}

export function dockerfileImages(text: string, file: string): ImageUse[] {
  const stages = new Set<string>();
  const uses: ImageUse[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!m?.[1]) continue;
    if (m[1] !== 'scratch' && !stages.has(m[1].toLowerCase()))
      uses.push({ ref: m[1], ...splitImage(m[1]), file, where: 'FROM' });
    if (m[2]) stages.add(m[2].toLowerCase());
  }
  return uses;
}

const SKIP = new Set(['node_modules', '.git', 'data', 'dist', 'build', '.venv', '__pycache__', 'coverage']);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return [join(dir, entry.name)];
      return SKIP.has(entry.name) ? [] : walk(join(dir, entry.name));
    }),
  );
  return nested.flat();
}

export async function findImageUses(root: string): Promise<ImageUse[]> {
  const files = (await walk(root)).filter((f) =>
    /(^|\/)(compose[^/]*\.ya?ml|docker-compose[^/]*\.ya?ml|Dockerfile[^/]*)$/.test(f),
  );
  const parsed = await Promise.all(
    files.toSorted(cmp).map(async (file) => {
      const rel = relative(root, file);
      const text = await readFile(file, 'utf8');
      return /Dockerfile/.test(rel) ? dockerfileImages(text, rel) : composeImages(text, rel);
    }),
  );
  return parsed.flat();
}

export async function loadImageSpecs(root: string): Promise<Record<string, ImageSpec>> {
  const doc = parse(await readFile(join(root, 'config', 'compliance', 'components.yaml'), 'utf8')) as {
    images?: Record<string, ImageSpec>;
  };
  return doc.images ?? {};
}

export function checkImages(
  uses: ImageUse[],
  specs: Record<string, ImageSpec>,
  policy: LicencePolicy,
  exceptions: LicenceException[] = [],
): ImageFinding[] {
  return uses.map((use) => {
    const spec = specs[use.repository];
    if (!spec) return { ...use, decision: { verdict: 'review', rule: 'not-in-components.yaml' } };
    const decision = decideComponent(
      {
        ecosystem: 'image',
        name: use.repository,
        version: use.tag,
        licence: spec.licence,
        scope: 'runtime',
        direct: true,
        separateService: spec.separateService === true,
      },
      policy,
      exceptions,
    );
    return { ...use, spec, decision };
  });
}
