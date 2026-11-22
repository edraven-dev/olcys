import type { SourceCollector, SourceDescriptor } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertCollectorAllowed,
  CollectorRegistry,
  loadSourceRegistry,
  registerOf,
  SourceDescriptorMismatchError,
  SourceForbiddenError,
  type CollectorDeps,
  type SourceRegister,
  type SourceRegistry,
} from '../src/index.ts';

let registry: SourceRegistry;
let register: SourceRegister;
beforeAll(async () => {
  registry = await loadSourceRegistry();
  register = registerOf(registry);
});

const factory = (create: (d: SourceDescriptor) => SourceDescriptor) => ({
  sourceId: 'keybase',
  platform: 'keybase',
  create: (descriptor: SourceDescriptor) => ({ descriptor: create(descriptor) }) as unknown as SourceCollector,
});

describe('assertCollectorAllowed', () => {
  it('accepts the register entry itself', () => {
    expect(() => assertCollectorAllowed(registry.require('bitcointalk'), register)).not.toThrow();
  });

  it('throws SourceForbiddenError for a RED descriptor', () => {
    expect(() => assertCollectorAllowed(registry.require('x_twitter'), register)).toThrow(SourceForbiddenError);
    // A descriptor claiming GREEN for a RED register entry is refused too.
    const disguised: SourceDescriptor = { ...registry.require('x_twitter'), compliance: 'GREEN' };
    expect(() => assertCollectorAllowed(disguised, register)).toThrow(SourceForbiddenError);
  });

  it('throws SourceDescriptorMismatchError when a field differs, naming it', () => {
    const changed: SourceDescriptor = { ...registry.require('keybase'), rateLimit: { requests: 99, perSeconds: 1 } };
    const thrown = (() => {
      try {
        assertCollectorAllowed(changed, register);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(SourceDescriptorMismatchError);
    expect((thrown as SourceDescriptorMismatchError).fields).toEqual(['rateLimit']);
  });

  it('throws SourceDescriptorMismatchError for a source that is not in the register', () => {
    expect(() => assertCollectorAllowed({ ...registry.require('keybase'), id: 'ghost' }, register)).toThrow(
      SourceDescriptorMismatchError,
    );
  });

  it('is applied when the collector registry builds the collectors of a scope', () => {
    const deps = {} as CollectorDeps;
    const scope = registry.resolveScope({ enabledSources: ['keybase'], amberJustifications: {} }, 'live');
    const good = new CollectorRegistry().register(factory((d) => d)).forScope(scope, registry, deps);
    expect(good.has('keybase')).toBe(true);
    const handCopied = new CollectorRegistry().register(factory((d) => ({ ...d, allowedHosts: ['keybase.example'] })));
    expect(() => handCopied.forScope(scope, registry, deps)).toThrow(SourceDescriptorMismatchError);
  });
});
