/**
 * Runtime schemas (zod) for data entering the system: API input and configuration files. Browser-safe.
 */
import { z } from 'zod';
import { IDENTIFIER_KINDS } from './case.ts';
import { CHAIN_FAMILIES, type ChainId } from './chains.ts';
import { EVIDENCE_TIERS } from './scoring.ts';
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
  amberJustifications: z.record(z.string(), z.string().trim().min(20).max(1000)).default({}),
  chains: z.array(ChainIdSchema).max(32).default([]),
  maxPivotDepth: z.int().min(0).max(3).default(2),
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

// --- config/sources.yaml -----------------------------------------------------------------------------------------

export const SourceEntrySchema = z
  .strictObject({
    name: z.string().min(1),
    kind: z.enum(SOURCE_KINDS),
    compliance: z.enum(COMPLIANCE_STATUSES),
    complianceNote: z.string().min(1),
    tosUrl: z.string().url().nullable().optional(),
    enabledByDefault: z.boolean(),
    requiresApiKey: z.boolean(),
    sendsIdentifiersExternally: z.boolean(),
    reliability: AdmiraltySchema,
    rateLimit: z.strictObject({ requests: z.number().min(0), perSeconds: z.number().positive() }),
    allowedHosts: z.array(z.string()),
    namePl: z.string().optional(),
    complianceNotePl: z.string().optional(),
    llmAllowed: z.boolean().optional(),
    blockedHosts: z.array(z.string()).optional(),
    attribution: z.string().optional(),
  })
  .refine((s) => !(s.compliance === 'RED' && s.enabledByDefault), {
    message: 'RED sources must not be enabled by default',
    path: ['enabledByDefault'],
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
