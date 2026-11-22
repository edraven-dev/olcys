import { describe, expect, it } from 'vitest';
import { hasStopped } from './start.ts';

describe('hasStopped', () => {
  it('counts a child that exited normally or was killed by a signal as stopped', () => {
    expect(hasStopped({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasStopped({ exitCode: null, signalCode: 'SIGTERM' })).toBe(true);
    expect(hasStopped({ exitCode: null, signalCode: null })).toBe(false);
  });
});
