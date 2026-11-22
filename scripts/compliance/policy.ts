/**
 * Licence policy (AGENTS.md rule 6): evaluates SPDX expressions against config/licenses.json.
 *
 * - `allowed`: the single allow-list for every ecosystem.
 * - `separateServiceOnly`: copyleft families that are acceptable only for container images / services that are
 *   flagged `separateService: true` (never inside the npm or Python dependency trees).
 * - `deny`: forbidden licences; they can never be waived by an exception.
 * - everything else (missing licence, NOASSERTION, `SEE LICENSE IN …`, unknown ids) is `review`: fails unless a
 *   `config/compliance/license-exceptions.yaml` entry exists.
 *
 * Patterns are matched case-insensitively; a trailing `*` is a prefix glob (`GPL-*`, `LicenseRef-RSAL*`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadForbiddenTools } from '../../packages/collectors/src/compliance/forbidden-tools.ts';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');

export type Verdict = 'allow' | 'deny' | 'review' | 'separate_service_only';
export type Ecosystem = 'npm' | 'pypi' | 'image';

export interface LicencePolicy {
  allowed: string[];
  separateServiceOnly: string[];
  deny: string[];
  /** Package names (npm / pypi) and image repositories that are forbidden regardless of licence. */
  forbidden?: { npm: string[]; pypi: string[]; images: string[] };
}

export interface ComponentLicence {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  licence: string | null;
  scope: 'runtime' | 'dev';
  direct: boolean;
  workspace?: string;
}

export interface LicenceException {
  package: string;
  licence: string;
  decision: 'allow';
  reason: string;
  approvedBy: string;
  date: string;
}

const RANK: Record<Verdict, number> = { allow: 0, separate_service_only: 1, review: 2, deny: 3 };

function matches(patterns: string[], id: string): string | undefined {
  const wanted = id.toLowerCase();
  return patterns.find((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith('*') ? wanted.startsWith(p.slice(0, -1)) : wanted === p;
  });
}

// --- SPDX expressions: ids, `+`, WITH, AND, OR, parentheses (AND binds tighter than OR) ---------------------------

type Node = { kind: 'id'; id: string } | { kind: 'and' | 'or'; left: Node; right: Node };

function tokenise(expr: string): string[] {
  return expr.match(/\(|\)|[^\s()]+/g) ?? [];
}

export function parseSpdx(expr: string): Node | undefined {
  const tokens = tokenise(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const upper = () => tokens[pos]?.toUpperCase();

  function primary(): Node | undefined {
    const token = peek();
    if (token === undefined) return undefined;
    if (token === '(') {
      pos++;
      const inner = or();
      if (!inner || peek() !== ')') return undefined;
      pos++;
      return inner;
    }
    if (token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) return undefined;
    pos++;
    if (upper() === 'WITH') {
      pos++;
      if (peek() === undefined || ['AND', 'OR', '(', ')'].includes(peek()?.toUpperCase() ?? '')) return undefined;
      pos++; // the exception id does not change the licence family
    }
    return { kind: 'id', id: token };
  }
  function and(): Node | undefined {
    let left = primary();
    while (left && upper() === 'AND') {
      pos++;
      const right = primary();
      if (!right) return undefined;
      left = { kind: 'and', left, right };
    }
    return left;
  }
  function or(): Node | undefined {
    let left = and();
    while (left && upper() === 'OR') {
      pos++;
      const right = and();
      if (!right) return undefined;
      left = { kind: 'or', left, right };
    }
    return left;
  }
  const result = or();
  return result && pos === tokens.length ? result : undefined;
}

function evaluateId(id: string, policy: LicencePolicy): { verdict: Verdict; rule: string } {
  const base = id.endsWith('+') ? id.slice(0, -1) : id;
  const denied = matches(policy.deny, id) ?? matches(policy.deny, base);
  if (denied) return { verdict: 'deny', rule: `deny:${denied}` };
  const separate = matches(policy.separateServiceOnly, id) ?? matches(policy.separateServiceOnly, base);
  if (separate) return { verdict: 'separate_service_only', rule: `separate_service_only:${separate}` };
  const allowed = matches(policy.allowed, id) ?? matches(policy.allowed, base);
  if (allowed) return { verdict: 'allow', rule: `allowed:${allowed}` };
  return { verdict: 'review', rule: `unknown:${id}` };
}

function evaluateNode(node: Node, policy: LicencePolicy): { verdict: Verdict; rule: string } {
  if (node.kind === 'id') return evaluateId(node.id, policy);
  const left = evaluateNode(node.left, policy);
  const right = evaluateNode(node.right, policy);
  // OR: the licensee picks the best branch; AND: every branch applies, so the worst one decides.
  const pickBest = node.kind === 'or';
  const leftWins = pickBest ? RANK[left.verdict] <= RANK[right.verdict] : RANK[left.verdict] >= RANK[right.verdict];
  return leftWins ? left : right;
}

/** Verdict for one licence expression. `null`/empty is a missing licence (`review`). */
export function evaluateLicence(expr: string | null, policy: LicencePolicy): { verdict: Verdict; rule: string } {
  const text = expr?.trim();
  if (!text) return { verdict: 'review', rule: 'missing' };
  if (/^UNLICENSED$/i.test(text)) return { verdict: 'deny', rule: 'deny:UNLICENSED' };
  if (/^NOASSERTION$/i.test(text) || /^SEE LICENSE IN\b/i.test(text))
    return { verdict: 'review', rule: `unresolved:${text}` };
  const node = parseSpdx(text);
  if (!node) return { verdict: 'review', rule: `unparsable:${text}` };
  return evaluateNode(node, policy);
}

// --- Components -------------------------------------------------------------------------------------------------

const normalisePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

function forbiddenMatch(component: Pick<ComponentLicence, 'ecosystem' | 'name'>, policy: LicencePolicy): boolean {
  const lists = policy.forbidden;
  if (!lists) return false;
  if (component.ecosystem === 'npm') {
    return lists.npm.some((p) => (p.endsWith('/*') ? component.name.startsWith(p.slice(0, -1)) : p === component.name));
  }
  if (component.ecosystem === 'pypi') return lists.pypi.some((p) => normalisePypi(p) === normalisePypi(component.name));
  return lists.images.some((p) => p.replace(/>=\d+$/, '').toLowerCase() === component.name.toLowerCase());
}

export interface ComponentDecision {
  verdict: 'allow' | 'deny' | 'review';
  rule: string;
}

/**
 * Final decision for a component. `separate_service_only` licences pass only for images flagged `separateService`;
 * forbidden tools are denied regardless of licence; an exception turns `review` (never `deny`) into `allow`.
 */
export function decideComponent(
  component: ComponentLicence & { separateService?: boolean },
  policy: LicencePolicy,
  exceptions: LicenceException[] = [],
): ComponentDecision {
  if (forbiddenMatch(component, policy)) return { verdict: 'deny', rule: 'forbidden-tool' };
  const { verdict, rule } = evaluateLicence(component.licence, policy);
  if (verdict === 'allow' || verdict === 'deny') return { verdict, rule };
  if (verdict === 'separate_service_only') {
    return component.ecosystem === 'image' && component.separateService === true
      ? { verdict: 'allow', rule: `${rule}:separate-service` }
      : { verdict: 'deny', rule: `${rule}:not-a-separate-service` };
  }
  const exception = exceptions.find((e) => e.package === `${component.name}@${component.version}`);
  return exception ? { verdict: 'allow', rule: `exception:${exception.package}` } : { verdict: 'review', rule };
}

// --- Loading ----------------------------------------------------------------------------------------------------

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function loadPolicy(root: string = REPO_ROOT, withForbidden = true): Promise<LicencePolicy> {
  const raw = JSON.parse(await readFile(join(root, 'config', 'licenses.json'), 'utf8')) as Record<string, unknown>;
  const policy: LicencePolicy = {
    allowed: strings(raw['allowed']),
    separateServiceOnly: strings(raw['separateServiceOnly']),
    deny: strings(raw['deny']),
  };
  if (withForbidden) {
    const tools = await loadForbiddenTools(join(root, 'config', 'forbidden-tools.yaml'));
    policy.forbidden = {
      npm: tools.tools.flatMap((t) => t.packages.npm),
      pypi: tools.tools.flatMap((t) => t.packages.pypi),
      images: tools.tools.flatMap((t) => t.packages.images),
    };
  }
  return policy;
}

export async function loadExceptions(root: string = REPO_ROOT): Promise<LicenceException[]> {
  let text: string;
  try {
    text = await readFile(join(root, 'config', 'compliance', 'license-exceptions.yaml'), 'utf8');
  } catch {
    return [];
  }
  const doc = parse(text) as { exceptions?: Array<Record<string, unknown>> } | null;
  return (doc?.exceptions ?? []).map((e) => {
    for (const key of ['package', 'licence', 'decision', 'reason', 'approvedBy', 'date']) {
      if (typeof e[key] !== 'string' || !e[key]) throw new Error(`license-exceptions.yaml: entry is missing "${key}"`);
    }
    if (e['decision'] !== 'allow')
      throw new Error(`license-exceptions.yaml: ${String(e['package'])}: decision must be "allow"`);
    return e as unknown as LicenceException;
  });
}
