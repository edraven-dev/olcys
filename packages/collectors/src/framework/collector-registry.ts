import type {
  CollectorInput,
  CollectorResult,
  IdentifierKind,
  RunContext,
  SourceCollector,
  SourceDescriptor,
  SourceId,
} from '@olcys/core';
import { assertCollectorAllowed } from '../compliance/guard.ts';
import { registerOf } from '../compliance/register.ts';
import { SourceRefusedError } from './errors.ts';
import type { CollectorDeps } from './http.ts';
import type { ResolvedScope, SourceRegistry } from './source-registry.ts';
import { note } from './status.ts';

/** Builds the collector of one source and tells the pivot planner what the platform supports. */
export interface CollectorFactory {
  readonly sourceId: SourceId;
  /** Platform of the accounts it collects (`bitcointalk`, `wykop`, `github`, `telegram`, `tablica`). */
  readonly platform: string;
  /** Same-nick pivot: the handle to look up for a nick, or undefined when the nick is not a valid handle there. */
  probeHandle?(nick: string): string | undefined;
  /** True when the platform's pages come from the watch list and must mention a case identifier to be kept. */
  readonly watchesPages?: boolean;
  /** False when discovered accounts are publishers about the subject, not the subject (e.g. warning channels). */
  readonly pivotOnAccounts?: boolean;
  /** True for web search: one query per input identifier (I5), and the result URLs it finds are followed (E3). */
  readonly webSearch?: boolean;
  /**
   * True for an archive lookup (Wayback): the planner gives it the profile URLs of the subject's own accounts and
   * the watch-list pages that matched, never third-party pages, and no collector pivots from its results.
   */
  readonly archiveHistory?: boolean;
  /** Identifier kinds the source looks up by themselves (registries: a full name), one task per identifier (I6). */
  readonly identifierKinds?: readonly IdentifierKind[];
  create(descriptor: SourceDescriptor, deps: CollectorDeps): SourceCollector;
}

export interface CollectorInstance {
  factory: CollectorFactory;
  collector: SourceCollector;
}

export class CollectorRegistry {
  readonly #factories = new Map<SourceId, CollectorFactory>();

  register(factory: CollectorFactory): this {
    if (this.#factories.has(factory.sourceId)) throw new Error(`collector for ${factory.sourceId} already registered`);
    this.#factories.set(factory.sourceId, factory);
    return this;
  }

  get(sourceId: SourceId): CollectorFactory | undefined {
    return this.#factories.get(sourceId);
  }

  list(): CollectorFactory[] {
    return [...this.#factories.values()];
  }

  forPlatform(platform: string): CollectorFactory | undefined {
    return this.list().find((f) => f.platform === platform);
  }

  /** Collectors of the sources enabled in the scope (RED and unjustified AMBER sources never get one). */
  forScope(scope: ResolvedScope, sources: SourceRegistry, deps: CollectorDeps): Map<SourceId, CollectorInstance> {
    const out = new Map<SourceId, CollectorInstance>();
    const register = registerOf(sources);
    for (const factory of this.list()) {
      const descriptor = sources.get(factory.sourceId);
      if (!descriptor || descriptor.compliance === 'RED' || !scope.isEnabled(factory.sourceId)) continue;
      const collector = factory.create(descriptor, deps);
      // Collectors take their descriptor from the register: throws for RED or a descriptor that differs from it.
      assertCollectorAllowed(collector.descriptor, register);
      out.set(factory.sourceId, { factory, collector });
    }
    return out;
  }
}

/**
 * Runs one collector inside the locked scope. A RED source or one outside the scope is a planner bug: it throws
 * `SourceRefusedError` before any request. A source stopped earlier in the run returns its stop status unread.
 */
export async function runCollector(
  collector: SourceCollector,
  input: CollectorInput,
  ctx: RunContext,
  scope: ResolvedScope,
  deps: Pick<CollectorDeps, 'breaker'>,
): Promise<CollectorResult> {
  const { id, compliance } = collector.descriptor;
  if (compliance === 'RED') throw new SourceRefusedError(id, 'red');
  if (!scope.isEnabled(id)) throw new SourceRefusedError(id, 'not_in_scope');
  const stop = deps.breaker.state(ctx.runId, id);
  if (stop) {
    return {
      status: stop.status,
      captures: [],
      accounts: [],
      observations: [],
      notes: [note('source_stopped', `${stop.status}: ${stop.reason}`)],
    };
  }
  try {
    return await collector.collect(input, ctx);
  } catch (error) {
    ctx.logger.error('collector failed', {
      sourceId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
