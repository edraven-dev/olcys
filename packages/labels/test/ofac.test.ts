import { describe, expect, it } from 'vitest';
import { diffOfacVersions, MemoryLabelLookup, parseOfacList } from '../src/index.ts';
import { ctxFor, fixture } from './importers-helpers.ts';

const A = 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const B = 'bc1qppppppppppppppppppppppppppppppppppppp';

describe('OFAC lists', () => {
  it('diffs versions: carries activeFrom and ends delisted addresses the day before the snapshot', () => {
    const v1 = diffOfacVersions(
      undefined,
      parseOfacList('XBT', fixture('ofac-v1.synthetic.json'), ctxFor('ofac-0xb10c', '2026-10-01')).rows,
      '2026-10-01',
    );
    expect(v1.map((l) => l.attributes.activeFrom)).toEqual(['2026-10-01', '2026-10-01']);
    const v2 = diffOfacVersions(
      v1,
      parseOfacList('XBT', fixture('ofac-v2.synthetic.json'), ctxFor('ofac-0xb10c', '2026-11-20')).rows,
      '2026-11-20',
    );
    const byAddress = Object.fromEntries(v2.map((l) => [l.address.address, l]));
    expect(byAddress[A]?.attributes).toMatchObject({ sanctioned: true, activeFrom: '2026-10-01' });
    expect(byAddress[A]?.attributes.activeTo).toBeUndefined();
    expect(byAddress[B]?.attributes).toMatchObject({ activeFrom: '2026-10-01', activeTo: '2026-11-19' });
    expect(byAddress[B]?.provenance).toMatchObject({
      license: 'LicenseRef-US-Gov-Public-Domain',
      version: '2026-11-20',
    });
  });

  it('is time-aware in the label lookup', async () => {
    const v1 = diffOfacVersions(
      undefined,
      parseOfacList('XBT', fixture('ofac-v1.synthetic.json'), ctxFor('ofac-0xb10c', '2026-10-01')).rows,
      '2026-10-01',
    );
    const v2 = diffOfacVersions(
      v1,
      parseOfacList('XBT', fixture('ofac-v2.synthetic.json'), ctxFor('ofac-0xb10c', '2026-11-20')).rows,
      '2026-11-20',
    );
    const lookup = new MemoryLabelLookup(v2);
    expect(await lookup.labelsFor({ chain: 'bitcoin', address: B }, '2026-10-15T00:00:00Z')).toHaveLength(1);
    expect(await lookup.labelsFor({ chain: 'bitcoin', address: B }, '2026-11-21T00:00:00Z')).toHaveLength(0);
  });

  it('assigns token addresses to chains by format', () => {
    const { rows, warnings } = parseOfacList(
      'USDT',
      fixture('ofac-usdt.synthetic.json'),
      ctxFor('ofac-0xb10c', '2026-11-20'),
    );
    expect(rows.map((r) => r.address.chain)).toEqual(['tron', 'evm:1']);
    expect(rows[0]).toMatchObject({ entity: 'OFAC SDN list', category: 'sanctioned_entity', confidence: 100 });
    expect(warnings).toHaveLength(1);
  });
});
