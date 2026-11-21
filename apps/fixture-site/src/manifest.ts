/**
 * `fixtures/persona/manifest.json` — what the synthetic persona fixtures contain and what the analysis is expected to
 * conclude. Plain types (no `@olcys/core` import) so the fixture site stays dependency-free.
 */
import type { Variant } from './resolve.ts';

export type FixtureChain = 'bitcoin' | 'evm:1' | 'tron';

export interface ManifestAddress {
  chain: FixtureChain;
  address: string;
  /** `p2wpkh`, `eip55`, `tron_base58`, `tx_hash`, `bech32_homoglyph`, `bip173_vector`. */
  format: string;
  role: string;
  /** For homoglyph decoys: the slot whose address the tampered string folds to. */
  foldsTo?: string;
  note?: string;
}

export interface ManifestPage {
  /** Path and query on the fixture site, e.g. `/bitcointalk/index.php?action=profile;u=900001`. */
  path: string;
  /** Rendered file relative to `apps/fixture-site/public/<variant|shared>/`. */
  file: string;
  platform: string;
  sourceId: string;
  variants: Variant[];
  slots: string[];
}

export interface ManifestAccount {
  platform: string;
  handle: string;
  uid?: string;
  path: string;
  role: 'persona' | 'unrelated_same_nick' | 'third_party';
  linksTo?: string;
  note?: string;
}

export interface PersonaManifest {
  schema: 'olcys.persona-fixtures.v1';
  synthetic: true;
  /** Seed for every non-key random value (tx ids, block hashes), so `--render-only` reproduces the site. */
  seed: string;
  generatedAt: string;
  persona: {
    fullName: string;
    nick: string;
    email: string;
    bitcointalkUid: string;
    githubLogin: string;
  };
  syntheticIdentifiers: string[];
  /** Real-world host (or API base) → fixture path prefix, for offline source adapters. */
  hostPrefixes: Record<string, string>;
  addresses: Record<string, ManifestAddress>;
  listing: { line: number; slot: string; text: string }[];
  signedMessages: {
    id: string;
    slot: string;
    address: string;
    message: string;
    signature: string;
    header: number;
    scheme: string;
    locator: string;
  }[];
  decoys: { id: string; slot: string; kind: string; locator: string; expected: string }[];
  pages: ManifestPage[];
  accounts: ManifestAccount[];
  expected: Record<string, unknown>;
  chain: {
    now: string;
    usdtContract: string;
    contractCode: Record<string, string>;
  };
  /** sha256 of every rendered file under `public/`, keyed by `<shared|v1|v2>/<path>`. */
  files: Record<string, string>;
}
