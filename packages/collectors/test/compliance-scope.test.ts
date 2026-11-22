import type { CaseScope } from '@olcys/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSourceRegister, validateCaseScope, type SourceRegister } from '../src/index.ts';

let register: SourceRegister;
beforeAll(async () => {
  register = await loadSourceRegister();
});

const scope = (patch: Partial<CaseScope>): CaseScope => ({
  enabledSources: ['fixture_site'],
  amberJustifications: {},
  chains: [],
  maxPivotDepth: 2,
  ...patch,
});
const JUSTIFICATION = 'Sprawa testowa: strony forum widoczne dla gości';

describe('validateCaseScope', () => {
  it('accepts the persona scope with GREEN sources only', () => {
    expect(
      validateCaseScope(
        scope({ enabledSources: ['fixture_site', 'keybase', 'mempool_space', 'krs'], chains: ['bitcoin', 'evm:1'] }),
        register,
      ),
    ).toEqual([]);
  });

  it('accepts a justified AMBER source', () => {
    expect(
      validateCaseScope(
        scope({ enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: `  ${JUSTIFICATION}  ` } }),
        register,
      ),
    ).toEqual([]);
  });

  it('refuses a RED source', () => {
    expect(validateCaseScope(scope({ enabledSources: ['x_twitter'] }), register)).toEqual([
      { code: 'source_forbidden', sourceId: 'x_twitter' },
    ]);
  });

  it('requires a justification for AMBER, of at least 20 trimmed characters', () => {
    expect(validateCaseScope(scope({ enabledSources: ['bitcointalk'] }), register)).toEqual([
      { code: 'amber_justification_required', sourceId: 'bitcointalk' },
    ]);
    expect(
      validateCaseScope(
        scope({ enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: '   ' } }),
        register,
      ),
    ).toEqual([{ code: 'amber_justification_required', sourceId: 'bitcointalk' }]);
    expect(
      validateCaseScope(
        scope({ enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: 'demo' } }),
        register,
      ),
    ).toEqual([{ code: 'justification_too_short', sourceId: 'bitcointalk', minLength: 20 }]);
    expect(
      validateCaseScope(
        scope({ enabledSources: ['bitcointalk'], amberJustifications: { bitcointalk: `${'x'.repeat(19)}   ` } }),
        register,
      ),
    ).toEqual([{ code: 'justification_too_short', sourceId: 'bitcointalk', minLength: 20 }]);
  });

  it('refuses unknown sources', () => {
    expect(validateCaseScope(scope({ enabledSources: ['nope'] }), register)).toEqual([
      { code: 'unknown_source', sourceId: 'nope' },
    ]);
  });

  it('flags justifications for GREEN, not enabled and unknown sources as orphans', () => {
    expect(
      validateCaseScope(
        scope({
          enabledSources: ['keybase'],
          amberJustifications: { keybase: JUSTIFICATION, bitcointalk: JUSTIFICATION },
        }),
        register,
      ),
    ).toEqual([
      { code: 'orphan_justification', sourceId: 'keybase' },
      { code: 'orphan_justification', sourceId: 'bitcointalk' },
    ]);
    expect(validateCaseScope(scope({ amberJustifications: { nope: JUSTIFICATION } }), register)).toEqual([
      { code: 'orphan_justification', sourceId: 'nope' },
    ]);
  });

  it('checks the pivot depth range 0-3', () => {
    for (const maxPivotDepth of [-1, 4, 1.5]) {
      expect(validateCaseScope(scope({ maxPivotDepth }), register)).toEqual([
        { code: 'pivot_depth_out_of_range', min: 0, max: 3 },
      ]);
    }
    for (const maxPivotDepth of [0, 3]) expect(validateCaseScope(scope({ maxPivotDepth }), register)).toEqual([]);
  });

  it('checks chain ids', () => {
    expect(validateCaseScope(scope({ chains: ['bitcoin', 'dogecoin?' as never] }), register)).toEqual([
      { code: 'unknown_chain', chain: 'dogecoin?' },
    ]);
  });
});
