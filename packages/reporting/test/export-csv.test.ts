import { describe, expect, it } from 'vitest';
import { buildExports, csvCell, CSV_EXPORTS, toCsv } from '../src/index.ts';
import { A, exportData } from './export-fixtures.ts';
import { MALICIOUS_SNIPPET, MALICIOUS_VALUE } from './fixtures.ts';

const rows = (csv: string) => csv.slice(1).split('\r\n').slice(0, -1);

describe('CSV exports', () => {
  const links = toCsv('csv_links', { data: exportData() });

  it('writes links with BOM, exact header, CRLF and score order', () => {
    expect(links.startsWith('\uFEFF')).toBe(true);
    expect(links.endsWith('\r\n')).toBe(true);
    expect(links).not.toMatch(/[^\r]\n/);
    const [header, ...data] = rows(links);
    expect(header).toBe(
      'case_id,run_id,identity,chain,address,relation,tier,score,icd203_pl,analytic_confidence,algorithm_version,weights_version,weights_sha256,evidence_capture_ids,evidence_urls',
    );
    expect(data).toHaveLength(3);
    expect(data.map((r) => r.split(',')[7])).toEqual(['99', '66', '24']);
    expect(data[0]).toContain(`bitcoin,${A.BTC1},SELF_DECLARED,E1,99,niemal pewne,High`);
    expect(data[0]).toContain(',cap-1;cap-2,');
  });

  it('guards formulas in text cells and keeps numbers verbatim', () => {
    expect(csvCell('=HYPERLINK("http://x")', { text: true })).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1', { text: true })).toBe("'+1");
    expect(csvCell('@a', { text: true })).toBe("'@a");
    expect(csvCell('-5', { text: false })).toBe('-5');
    expect(csvCell('a,b', { text: true })).toBe('"a,b"');
    const data = exportData();
    data.case.identifiers[0]!.value = '=HYPERLINK("http://x")';
    const csv = toCsv('csv_links', { data });
    expect(rows(csv)[1]).toContain(`,"'=HYPERLINK(""http://x"")",bitcoin,`);
    expect(rows(csv)[1]).toContain(',99,');
  });

  it('writes cash-out amounts and PLN values exactly as stored', () => {
    const [header, ...data] = rows(toCsv('csv_cash_out', { data: exportData() }));
    expect(header).toBe(
      'event_id,rule_id,strength,occurred_at,address,counterparty_entity,tx_hashes,amount,asset,pln,nbp_table,nbp_effective_date,nbp_rate,pln_synthetic',
    );
    const b1 = data.find((r) => r.startsWith('co-1,'))!;
    expect(b1).toBe(
      `co-1,B1,strong,2026-10-14T09:30:00.000Z,evm:1:${A.ETH1},Giełda Testowa (SYNTHETIC),0xsweep01,0.0099,ETH,1520.37,224/A/NBP/2026,2026-10-13,3.6512,false`,
    );
  });

  it('flags PLN values built on synthetic rates, also through components', () => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const flag = (csv: string, id: string) =>
      rows(csv)
        .find((r) => r.startsWith(`${id},`))
        ?.split(',')
        .at(-1);
    expect(flag(toCsv('csv_cash_out', { data: exportData() }), 'co-1')).toBe('false');
    const data = exportData();
    const b1 = data.cashOuts.find((e) => e.id === 'co-1')!;
    b1.valuation = { ...b1.valuation!, nbp: { ...b1.valuation!.nbp, synthetic: true } };
    const b5 = data.cashOuts.find((e) => e.components?.length)!;
    const leg = b5.components![1]!;
    leg.valuation = { ...leg.valuation!, nbp: { ...leg.valuation!.nbp, synthetic: true } };
    const csv = toCsv('csv_cash_out', { data });
    expect(flag(csv, 'co-1')).toBe('true');
    expect(flag(csv, b5.id)).toBe('true');
    delete b1.valuation;
    expect(flag(toCsv('csv_cash_out', { data }), 'co-1')).toBe('');
  });

  it('lists changes with both capture ids and scores', () => {
    const [header, ...data] = rows(toCsv('csv_changes', { data: exportData() }));
    expect(header).toBe(
      'kind,platform,locator,property,before,after,before_capture_id,after_capture_id,score_before,score_after,cause',
    );
    expect(data[0]).toBe(
      `VALUE_CHANGED,bitcointalk,bitcointalk:u=900001#profile.bitcoin_address,profile.bitcoin_address,${A.BTC2},${A.BTC1},cap-0,cap-1,,,`,
    );
    expect(data[1]).toContain(',50,66,data');
  });

  it('lists every capture with its integrity data', () => {
    const [header, ...data] = rows(toCsv('csv_evidence', { data: exportData() }));
    expect(header).toBe(
      'capture_id,source_id,url,final_url,status,collected_at,collector,manifest_sha256,tsa_gen_time,tsa_url',
    );
    expect(data.length).toBeGreaterThanOrEqual(7);
  });

  it('carries no scraped inference text in any export', () => {
    const data = exportData();
    for (const a of buildExports({ data }, { producerName: 'x', tlp: 'amber' })) {
      expect(a.content).not.toContain(MALICIOUS_SNIPPET);
      expect(a.content).not.toContain(MALICIOUS_VALUE);
      expect(a.content).not.toContain('forwards to labelled hot wallet');
    }
    expect(CSV_EXPORTS).toHaveLength(4);
  });
});
