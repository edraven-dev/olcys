import { describe, expect, it } from 'vitest';
import { buildReportModel, renderReport } from '../src/index.ts';
import { A, emptyData, personaData } from './fixtures.ts';

const model = buildReportModel(personaData());

describe('report model', () => {
  it('keeps the three statement classes apart and states every inference as needing verification', () => {
    expect(model.facts.length).toBeGreaterThan(0);
    expect(model.computed.map((c) => c.kind)).toEqual(expect.arrayContaining(['score', 'exclusion', 'cash_out']));
    expect(model.inferences.length).toBeGreaterThan(0);
    expect(model.inferences.every((i) => i.requiresVerification)).toBe(true);
    const ids = [...model.facts, ...model.computed, ...model.inferences].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never puts a source fact among the computed results or the other way round', () => {
    const factTexts = new Set(model.facts.map((f) => f.statement));
    for (const c of model.computed) expect(factTexts.has(c.statement)).toBe(false);
    for (const i of model.inferences) expect(factTexts.has(i.statement)).toBe(false);
  });

  it('keeps the likelihood statements free of the analytic confidence level', () => {
    expect(model.summary.likelihoodStatements.length).toBeGreaterThan(0);
    for (const s of model.summary.likelihoodStatements) expect(s).not.toMatch(/pewność analityczna/i);
    expect(model.summary.analyticConfidence).toMatch(/^(High|Moderate|Low)$/);
  });

  it('uses only evidence that exists: computed items cite facts of this report', () => {
    const factIds = new Set(model.facts.map((f) => f.id));
    for (const c of model.computed) for (const id of c.basedOn) expect(factIds.has(id)).toBe(true);
    for (const f of model.facts) expect(f.captureId).toBeTruthy();
  });

  it('describes the run for reproduction and lists the evidence register and the flows', () => {
    expect(model.reproducibility).toMatchObject({ weightsVersion: expect.any(String), mode: expect.any(String) });
    expect(model.reproducibility.dataSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(model.evidenceRegister.length).toBeGreaterThan(0);
    expect(model.fundFlow.length).toBeGreaterThan(0);
    expect(model.fundFlow.map((s) => s.at)).toEqual(model.fundFlow.map((s) => s.at).toSorted());
    expect(model.changesSincePrevious).toHaveLength(personaData().changes.length);
  });

  it('is deterministic and agrees with the HTML renderer on the data digest', () => {
    expect(JSON.stringify(buildReportModel(personaData()))).toBe(JSON.stringify(model));
    expect(renderReport(personaData())).toContain(model.reproducibility.dataSha256 ?? 'missing');
  });

  it('handles a run without any findings', () => {
    const empty = buildReportModel(emptyData());
    expect(empty.facts).toEqual([]);
    expect(empty.summary.likelihoodStatements).toEqual([]);
    expect(empty.fundFlow).toEqual([]);
  });

  it('keeps addresses of the fixture as plain text', () => {
    expect(JSON.stringify(model)).toContain(A.BTC1);
  });
});
