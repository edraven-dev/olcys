import { describe, expect, it } from 'vitest';
import { parseEsmaCasps, parsePlRegister, recordValidAt, validNip, type PositionedText } from '../src/index.ts';
import { fixture } from './importers-helpers.ts';

describe('ESMA CASPS', () => {
  const { records } = parseEsmaCasps(fixture('casps.synthetic.csv'));

  it('cleans BOM, trailing dot, spaces and mojibake and reads the service codes', () => {
    const bramka = records.find((r) => r.name.startsWith('Bramka'));
    expect(bramka).toMatchObject({
      key: 'SYNTHBRAMKA000000T01',
      name: 'Bramka Testowa GmbH (SYNTHETIC)',
      services: ['a', 'c'],
      fiatCapable: true,
      mayServePL: true,
      validFrom: '2026-01-10',
      homeState: 'DE',
    });
    expect(records.map((r) => r.name)).toContain('Giełdziec Syntetyczny UAB (SYNTHETIC)');
  });

  it('keeps an ended authorisation with validTo', () => {
    const ended = records.find((r) => r.key === 'SYNTHGIELDA000000T02')!;
    expect(ended.validTo).toBe('2026-09-30');
    expect(recordValidAt(ended, '2026-09-01')).toBe(true);
    expect(recordValidAt(ended, '2026-10-15')).toBe(false);
  });
});

describe('Polish register', () => {
  const items = JSON.parse(fixture('pl-register.synthetic.json')) as PositionedText[];

  it('keeps legal entities only, joins wrapped cells and records the end date', () => {
    const { records, warnings } = parsePlRegister(items);
    expect(records.map((r) => r.key)).toEqual(['RDWW-9001', 'RDWW-9002', 'RDWW-9004']);
    expect(records[0]).toMatchObject({
      name: 'Giełda Testowa sp. z o.o. (SYNTHETIC)',
      fiatCapable: true,
      validFrom: '2025-03-01',
    });
    expect(records[1]?.fiatCapable).toBe(false);
    expect(records[2]?.validTo).toBe('2026-02-15');
    expect(records.some((r) => r.name.includes('Jan Przykładowy'))).toBe(false);
    expect(warnings.filter((w) => w.includes('NIP'))).toEqual(['PL register: RDWW-9002 has an invalid NIP checksum']);
  });

  it('checks the NIP checksum', () => {
    expect(validNip('5260000005')).toBe(true);
    expect(validNip('5260000000')).toBe(false);
  });
});
