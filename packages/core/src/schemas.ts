/**
 * Runtime schemas (zod) for data entering the system: API input and configuration files. Browser-safe.
 */
import { z } from 'zod';
import { IDENTIFIER_KINDS } from './case.ts';
import { CHAIN_FAMILIES, type ChainId } from './chains.ts';
import {
  ACCOUNT_DISCOVERY_METHODS,
  ARTIFACT_KINDS,
  CAPTURE_MANIFEST_SCHEMA_ID,
  CAPTURE_PROFILES,
  CAPTURE_STATUSES,
  CLOCK_SYNC_METHODS,
  type CaptureManifest,
} from './evidence.ts';
import { FETCH_MODES } from './provenance.ts';
import { DENY_LIST_KINDS } from './labels.ts';
import { ANALYST_OVERRIDE_KINDS, EVIDENCE_TIERS, JUDGEMENT_VALUES } from './scoring.ts';
import { ADMIRALTY_RELIABILITY, COMPLIANCE_STATUSES, SOURCE_KINDS } from './sources.ts';

// --- errors & helpers ------------------------------------------------------------------------------------------

export interface ContractIssue {
  path: string;
  message: string;
}

export class ContractError extends Error {
  readonly issues: ContractIssue[];
  constructor(issues: ContractIssue[]) {
    super(`Contract violation: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

/** Validates `value`; throws `ContractError` listing every failing path. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ContractError(
    result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}

/** JSON Schema (draft 2020-12) for a schema — for LLM structured output and OpenAPI. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

// --- primitives --------------------------------------------------------------------------------------------------

const NON_EVM_FAMILIES = CHAIN_FAMILIES.filter((family) => family !== 'evm');
const CHAIN_ID = new RegExp(`^(?:${NON_EVM_FAMILIES.join('|')}|evm:(?:[1-9]\\d*|unknown))$`);

export function isChainId(value: unknown): value is ChainId {
  return typeof value === 'string' && CHAIN_ID.test(value);
}

/** Regex-based so it stays representable in JSON Schema; typed as `ChainId`. */
export const ChainIdSchema = z.string().regex(CHAIN_ID, 'invalid chain id') as unknown as z.ZodType<ChainId>;

export const AddressRefSchema = z.strictObject({
  chain: ChainIdSchema,
  address: z.string().min(1).max(256),
});

export const AdmiraltySchema = z.enum(ADMIRALTY_RELIABILITY);

// --- API input ---------------------------------------------------------------------------------------------------

export const IdentifierInputSchema = z.strictObject({
  kind: z.enum(IDENTIFIER_KINDS),
  value: z.string().trim().min(1).max(512),
  platform: z.string().trim().min(1).max(64).optional(),
  chain: ChainIdSchema.optional(),
  isAnchor: z.boolean().default(false),
});
export type IdentifierInput = z.infer<typeof IdentifierInputSchema>;

export const CaseScopeInputSchema = z.strictObject({
  enabledSources: z.array(z.string().min(1).max(64)).max(64).default([]),
  // Length rules live in validateCaseScope (code `justification_too_short`), so the API answers with that code.
  amberJustifications: z.record(z.string(), z.string().trim().max(1000)).default({}),
  // Chain ids are checked by validateCaseScope (code `unknown_chain`) before a case is stored, so the parsed type is
  // ChainId although the schema only bounds the strings.
  chains: z
    .array(z.string().max(64) as unknown as z.ZodType<ChainId>)
    .max(32)
    .default([]),
  // The range (0-3) is checked by validateCaseScope (code `pivot_depth_out_of_range`).
  maxPivotDepth: z.int().default(2),
});

export const CreateCaseSchema = z.strictObject({
  title: z.string().trim().min(3).max(200),
  purpose: z.string().trim().min(10).max(2000),
  legalBasis: z.string().trim().min(3).max(500),
  identifiers: z.array(IdentifierInputSchema).min(1).max(20),
  scope: CaseScopeInputSchema.default({ enabledSources: [], amberJustifications: {}, chains: [], maxPivotDepth: 2 }),
});
export type CreateCaseInput = z.infer<typeof CreateCaseSchema>;

export const StartRunSchema = z.strictObject({
  trigger: z.enum(['manual', 'rescore']).default('manual'),
  rescoreOfRunId: z.uuid().optional(),
});

// --- API input: analyst judgements and overrides -----------------------------------------------------------------

/**
 * Body of `POST /api/links/:linkId/judgements`. Not strict on purpose: the analyst is never taken from the request,
 * so a body field such as `analyst` is dropped. The API checks the trimmed justification against
 * `JUSTIFICATION_LENGTH` and answers with stable error codes.
 */
export const CreateJudgementSchema = z.object({
  judgement: z.enum(JUDGEMENT_VALUES),
  justification: z.string(),
});
export type CreateJudgementInput = z.infer<typeof CreateJudgementSchema>;

export const AnalystOverrideTargetSchema = z.strictObject({
  sourceId: z.string().trim().min(1).max(64).optional(),
  observationId: z.uuid().optional(),
  candidateId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  address: AddressRefSchema.optional(),
});

/**
 * Body of `POST /api/cases/:caseId/overrides` (not strict, like judgements). The API checks the value and the target
 * required by the kind, that the target belongs to a run of the case, and the justification's length.
 */
export const CreateOverrideSchema = z.object({
  kind: z.enum(ANALYST_OVERRIDE_KINDS),
  target: AnalystOverrideTargetSchema,
  value: z.string().trim().min(1).max(64),
  justification: z.string(),
});
export type CreateOverrideInput = z.infer<typeof CreateOverrideSchema>;

// --- config/sources.yaml -----------------------------------------------------------------------------------------

export const SourceEntrySchema = z
  .strictObject({
    name: z.string().min(1),
    kind: z.enum(SOURCE_KINDS),
    compliance: z.enum(COMPLIANCE_STATUSES),
    complianceNote: z.string().min(1),
    /** Mandatory key: `null` means the source publishes no terms. */
    tosUrl: z.string().url().nullable(),
    enabledByDefault: z.boolean(),
    requiresApiKey: z.boolean(),
    sendsIdentifiersExternally: z.boolean(),
    reliability: AdmiraltySchema,
    rateLimit: z.strictObject({ requests: z.number().min(0), perSeconds: z.number().positive() }),
    allowedHosts: z.array(z.string()),
    namePl: z.string().trim().min(1),
    complianceNotePl: z.string().trim().min(1),
    llmAllowed: z.boolean().optional(),
    blockedHosts: z.array(z.string()).optional(),
    attribution: z.string().optional(),
    sandbox: z.boolean().optional(),
  })
  .superRefine((s, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    if (s.compliance === 'AMBER' && s.enabledByDefault)
      fail('enabledByDefault', 'AMBER sources are enabled per case only');
    if (s.compliance !== 'RED') return;
    if (s.enabledByDefault) fail('enabledByDefault', 'RED sources must not be enabled by default');
    if (s.rateLimit.requests !== 0) fail('rateLimit', 'RED sources must have rateLimit.requests 0');
    if (s.allowedHosts.length > 0) fail('allowedHosts', 'RED sources must have no allowed hosts');
    if (!s.blockedHosts?.length) fail('blockedHosts', 'RED sources must list the hosts that are never contacted');
  });

export const SourcesConfigSchema = z.strictObject({
  version: z.string().min(1),
  sources: z.record(z.string(), SourceEntrySchema),
  providers: z.record(z.string(), SourceEntrySchema).default({}),
});
export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

// --- config/scoring/weights.v1.yaml --------------------------------------------------------------------------------

const FeatureWeightSchema = z.strictObject({
  bayesFactor: z.number().positive(),
  defaultGrade: AdmiraltySchema.optional(),
  tier: z.enum(EVIDENCE_TIERS).optional(),
  reviewRequired: z.boolean().optional(),
  note: z.string().optional(),
});

export const WeightsConfigSchema = z.strictObject({
  version: z.string().min(1),
  status: z.enum(['uncalibrated', 'calibrated']),
  reliability: z.strictObject({
    A: z.number().min(0).max(1),
    B: z.number().min(0).max(1),
    C: z.number().min(0).max(1),
    D: z.number().min(0).max(1),
    E: z.number().min(0).max(1),
    F: z.null(),
  }),
  identity: z.strictObject({
    anchorProbability: z.number().gt(0).lt(1),
    priorOdds: z.number().positive(),
    features: z.record(z.string(), FeatureWeightSchema),
  }),
  address: z.strictObject({
    priorOdds: z.number().positive(),
    features: z.record(z.string(), FeatureWeightSchema),
  }),
  scales: z.strictObject({
    icd203: z.array(z.strictObject({ max: z.number().min(0).max(1), term: z.string(), pl: z.string() })).min(1),
    enfsi: z
      .array(
        z.strictObject({
          // the last band is open-ended (`.inf` in YAML)
          maxLr: z.custom<number>((v) => typeof v === 'number' && v > 0, {
            message: 'expected a positive number or Infinity',
          }),
          term: z.string(),
        }),
      )
      .min(1),
  }),
});
export type WeightsConfig = z.infer<typeof WeightsConfigSchema>;

// --- config/rules/*.yaml -------------------------------------------------------------------------------------------

export const RuleSetSchema = z.object({
  version: z.string().min(1),
  rules: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export type RuleSet = z.infer<typeof RuleSetSchema>;

// --- config/rules/deny-list.v1.yaml --------------------------------------------------------------------------------

/** One deny-list address in canonical form (EVM and bech32 lower-case), with its public source. */
export const DenyListEntrySchema = z.strictObject({
  chain: ChainIdSchema,
  address: z.string().min(1).max(256),
  kind: z.enum(DENY_LIST_KINDS),
  name: z.string().min(1).max(200),
  source: z.url(),
});
export type DenyListEntry = z.infer<typeof DenyListEntrySchema>;

export const DenyListSchema = z.strictObject({
  version: z.string().min(1),
  entries: z.array(DenyListEntrySchema),
});
export type DenyListConfig = z.infer<typeof DenyListSchema>;

// --- capture manifest ----------------------------------------------------------------------------------------------

const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'expected an ISO 8601 UTC time');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lower-case SHA-256 hex digest');
const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
const NameVersion = z.strictObject({ name: z.string().min(1), version: z.string() });

/** Validates a stored capture manifest (`olcys.capture-manifest/1`). */
export const CaptureManifestSchema = z.strictObject({
  schema: z.literal(CAPTURE_MANIFEST_SCHEMA_ID),
  // UUIDs only: the capture id becomes a path segment of collection packages.
  captureId: z.uuid(),
  caseId: z.uuid(),
  runId: z.uuid(),
  sourceId: z.string().min(1),
  profile: z.enum(CAPTURE_PROFILES),
  mode: z.enum(FETCH_MODES),
  userAgent: z.string(),
  fetchIds: z.array(z.uuid()),
  collector: z.strictObject({
    name: z.string().min(1),
    host: z.string(),
    ip: z.string().optional(),
    ipSource: z.enum(['configured', 'local_interface', 'unknown']),
    virtualIdentity: z.null(),
  }),
  time: z.strictObject({
    startedAt: IsoUtc,
    collectedAt: IsoUtc,
    endedAt: IsoUtc,
    hashedAt: IsoUtc,
    clock: z.strictObject({
      synced: z.boolean(),
      method: z.enum(CLOCK_SYNC_METHODS),
      source: z.string().optional(),
      offsetMs: z.number().optional(),
      checkedAt: IsoUtc,
    }),
  }),
  target: z.strictObject({
    url: z.string(),
    finalUrl: z.string(),
    httpStatus: z.number().int(),
    status: z.enum(CAPTURE_STATUSES),
    serverIp: z.string().optional(),
    responseHeaders: z.record(z.string(), z.string()),
  }),
  tools: z.array(NameVersion),
  artifacts: z.array(
    z.strictObject({
      kind: ArtifactKindSchema,
      sha256: Sha256,
      bytes: z.number().int().nonnegative(),
      mediaType: z.string(),
      description: z.string(),
    }),
  ),
  completeness: z.strictObject({ required: z.array(ArtifactKindSchema), missing: z.array(ArtifactKindSchema) }),
  transformations: z.array(z.string()),
  discovery: z
    .strictObject({
      method: z.enum(ACCOUNT_DISCOVERY_METHODS),
      fromAccountId: z.string().optional(),
      searchProvider: z.string().optional(),
      query: z.string().optional(),
      rank: z.number().optional(),
    })
    .optional(),
  archive: z
    .strictObject({
      provider: z.literal('wayback'),
      snapshotTimestamp: z.string(),
      originalUrl: z.string(),
      replayUrl: z.string().optional(),
      cdxDigest: z.string().optional(),
    })
    .optional(),
  technical: z.looseObject({}).optional(),
}) as unknown as z.ZodType<CaptureManifest>;
