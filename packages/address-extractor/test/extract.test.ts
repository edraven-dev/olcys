import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';
import { createDenyList, parseDenyList } from '../src/deny-list.ts';
import { LEXICON_VERSION } from '../src/context/lexicon.ts';
import { EXTRACTOR_VERSION, extractCapture } from '../src/extract.ts';
import { buildViews } from '../src/views/build.ts';
import type { CaptureContent } from '../src/pipeline-types.ts';
import { bytes, fragments, gen, homoglyphOf, htmlCapture, jsonCapture, textCapture } from './helpers.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const denyList = parseDenyList(readFileSync(join(repoRoot, 'config/rules/deny-list.v1.yaml'), 'utf8'));
const BIP173_EXAMPLE = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function sequentialIds(): () => string {
  let n = 0;
  return () => `00000000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`;
}

const BANNER =
  '<div class="olcys-synthetic" role="note">DANE SYNTETYCZNE — SYNTHETIC TEST DATA. Fikcyjna persona testowa OŁCyŚ; żadna prawdziwa osoba nie jest tu opisana.</div>';

describe('extractCapture on persona-like pages', () => {
  const btc1 = gen.p2wpkh('persona-btc1');
  const eth1 = gen.evm('persona-eth1');
  const hot1 = gen.evm('persona-hot1');
  const tron1 = gen.tron('persona-tron1');
  const tx = gen.txHash('persona-tx');
  const decoy = homoglyphOf('persona-hg');
  const signature = base64.encode(bytes('persona-sig', 65));

  const profile = `<html><head><title>View the profile of fikcyjny_kacper</title></head><body>${BANNER}
    <table class="bordercolor"><tr class="titlebg"><td>Summary - fikcyjny_kacper</td></tr><tr><td class="windowbg">
      <table><tr><td><b>Name: </b></td><td>fikcyjny_kacper</td></tr>
      <tr><td><b>Website: </b></td><td><a href="https://example.org/" target="_blank">example.org</a></td></tr>
      <tr><td><b>Bitcoin address: </b></td><td>${btc1}</td></tr>
      <tr><td><b>Other contact info: </b></td><td>Matrix: @fikcyjny_kacper:example.org</td></tr></table>
    </td></tr></table></body></html>`;

  const listing = Array.from({ length: 55 }, (_, i) =>
    i === 23
      ? `Giełda Testowa (SYNTHETIC) — portfel gorący: ${hot1}`
      : `Giełda Testowa ${String(i + 1).padStart(2, '0')} (SYNTHETIC) — portfel: ${gen.evm(`persona-listing-${i}`)}`,
  );
  const topic = `<html><body>${BANNER}
    <a name="msg65000001"></a><table><tr><td class="td_headerandpost"><div class="post">Staking:
      <div class="codeheader">Code:</div><div class="code">-----BEGIN BITCOIN SIGNED MESSAGE-----<br />I am fikcyjny_kacper (uid 900001) and I control ${btc1}. Date: 2026-11-01. SYNTHETIC TEST DATA - OLCYS fixture.<br />-----BEGIN SIGNATURE-----<br />${btc1}<br />${signature}<br />-----END BITCOIN SIGNED MESSAGE-----</div></div></td></tr></table>
    <a name="msg65000101"></a><table><tr><td class="td_headerandpost"><div class="post">Wczoraj wpłaciłem na giełdę 0,01 ETH: ${eth1} (tx ${tx}). Ile trwa zaksięgowanie?</div></td></tr></table>
    <a name="msg65000102"></a><table><tr><td class="td_headerandpost"><div class="post">${listing.join('<br />')}</div></td></tr></table>
    <a name="msg65000103"></a><table><tr><td class="td_headerandpost"><div class="post">Przykład formatu adresu z dokumentacji BIP-173:<div class="codeheader">Code:</div><div class="code">${BIP173_EXAMPLE}</div></div></td></tr></table>
    </body></html>`;

  const wykop = `<html><body>${BANNER}<main data-olcys-account="wykop" data-olcys-handle="fikcyjny_kacper">
    <article id="wpis-71000001"><p>Przeszedłem na stablecoiny. mój portfel USDT TRC20: ${tron1}</p></article></main></body></html>`;

  const channel = `<html><body>${BANNER}
    <div class="tgme_widget_message" data-post="olcys_test_ostrzezenia/102"><div class="tgme_widget_message_text">Uważajcie na podróbkę: ${decoy.tampered}</div></div>
    </body></html>`;

  it('profile: one bitcoin p2wpkh candidate with its label', async () => {
    const result = await extractCapture(htmlCapture(profile), { denyList, newId: sequentialIds() });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      address: { chain: 'bitcoin', address: btc1 },
      format: 'p2wpkh',
      chainAttribution: { method: 'format_unique' },
      view: 'visible_text',
      reviewRequired: false,
      context: { label: 'Bitcoin address', roleCues: ['unclear'], inCode: false, pageAddressDensity: 1 },
    });
    expect(result.candidates[0]?.context.snippet).not.toContain('SYNTHETIC');
    expect(result.rejected).toEqual([]);
    expect(result.extractorVersion).toBe(EXTRACTOR_VERSION);
  });

  it('topic: deposit, listing, tx hash and documentation example; no noise from the signature', async () => {
    const result = await extractCapture(htmlCapture(topic), { denyList, newId: sequentialIds() });
    const deposit = result.candidates.find((c) => c.address.address === eth1.toLowerCase());
    expect(deposit).toMatchObject({
      address: { chain: 'evm:1' },
      chainAttribution: { method: 'keyword', detail: 'ETH' },
      context: { anchor: 'msg65000101', label: 'Wczoraj wpłaciłem na giełdę 0,01 ETH' },
    });
    expect(deposit?.context.roleCues[0]).toBe('exchange_deposit');

    const hot = result.candidates.find((c) => c.address.address === hot1.toLowerCase());
    expect(hot?.context.roleCues).toContain('listing');
    expect(hot?.address.chain).toBe('evm:unknown');

    const signed = result.candidates.filter((c) => c.address.address === btc1);
    expect(signed).toHaveLength(2);
    expect(signed.every((c) => c.view === 'code' && c.context.inCode)).toBe(true);
    expect(signed[0]?.context.occurrencesInCapture).toBe(2);

    expect(result.rejected).toContainEqual(expect.objectContaining({ raw: tx, reason: 'tx_hash_like' }));
    expect(result.rejected).toContainEqual(
      expect.objectContaining({
        raw: BIP173_EXAMPLE,
        reason: 'documentation_example: BIP-173 example P2WPKH address',
        view: 'code',
      }),
    );
    expect(
      result.rejected.filter((r) => r.reason !== 'tx_hash_like' && !r.reason.startsWith('documentation_example')),
    ).toEqual([]);
    expect(result.candidates.some((c) => c.address.address === BIP173_EXAMPLE)).toBe(false);
    expect(result.candidates).toHaveLength(1 + 55 + 2);
  });

  it('Wykop-like entry: TRON with first-person ownership', async () => {
    const result = await extractCapture(htmlCapture(wykop), { denyList });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      address: { chain: 'tron', address: tron1 },
      context: { roleCues: ['first_person_owner'], label: 'mój portfel USDT TRC20', anchor: 'wpis-71000001' },
    });
  });

  it('channel: the homoglyph decoy is rejected, never a candidate', async () => {
    const result = await extractCapture(htmlCapture(channel), { denyList });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ raw: decoy.tampered, reason: `homoglyph_detected: folds to ${decoy.clean}` }),
    ]);
  });

  it('is deterministic (byte-identical with a fixed id sequence)', async () => {
    const a = await extractCapture(htmlCapture(topic), { denyList, newId: sequentialIds() });
    const b = await extractCapture(htmlCapture(topic), { denyList, newId: sequentialIds() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('extractor version', () => {
  it('is stored with the result and carries the lexicon version, so a lexicon change changes it', async () => {
    const result = await extractCapture(htmlCapture(`<p>${gen.p2wpkh('version')}</p>`), { denyList });
    expect(result.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(EXTRACTOR_VERSION).toContain(LEXICON_VERSION);
  });
});

describe('occurrences across views', () => {
  it('counts href and link text separately but one text node once', async () => {
    const address = gen.evm('dedup');
    const html = `<p><a href="https://etherscan.io/address/${address}">${address}</a></p><p>Ten sam: <span>${address}</span></p>`;
    const result = await extractCapture(htmlCapture(html), { denyList });
    expect(result.candidates.map((c) => c.view)).toEqual(['visible_text', 'visible_text', 'attribute']);
    expect(result.candidates.every((c) => c.context.occurrencesInCapture === 3)).toBe(true);
    expect(result.candidates.every((c) => c.address.chain === 'evm:1')).toBe(true);
    expect(result.candidates[1]?.chainAttribution).toEqual({ method: 'page_chain', detail: 'same_address' });
  });

  it('reports href and link text as two occurrences and the shared text node once (visible_text wins)', async () => {
    const address = gen.evm('ac2');
    const html = `<p><a href="https://etherscan.io/address/${address}">${address}</a></p>`;
    const result = await extractCapture(htmlCapture(html), { denyList });
    expect(result.candidates.map((c) => c.view)).toEqual(['visible_text', 'attribute']);
    expect(result.candidates.every((c) => c.context.occurrencesInCapture === 2)).toBe(true);
  });

  it('does not turn one link seen by two views into a page prior', async () => {
    const linked = gen.evm('prior-linked');
    const other = gen.evm('prior-other');
    const html = `<p><a href="https://bscscan.com/address/${linked}">${linked}</a></p><p>Inny: ${other}</p>`;
    const result = await extractCapture(htmlCapture(html), { denyList });
    const unrelated = result.candidates.find((c) => c.address.address === other.toLowerCase());
    expect(unrelated?.address.chain).toBe('evm:unknown');
  });

  it('prefers the unsplit inline_joined reading over a gap-joined one', async () => {
    const address = gen.p2wpkh('inline');
    const html = `<p>Adres: <span>${address.slice(0, 12)}</span><span>${address.slice(12)}</span></p>`;
    const result = await extractCapture(htmlCapture(html), { denyList });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ view: 'inline_joined', reviewRequired: false, raw: address });
  });

  it('keeps occurrences from different artifacts of one capture', async () => {
    const address = gen.evm('artifacts');
    const capture: CaptureContent = {
      ...htmlCapture(`<p>${address}</p>`),
      artifacts: [...htmlCapture(`<p>${address}</p>`).artifacts, ...jsonCapture(JSON.stringify({ address })).artifacts],
    };
    const result = await extractCapture(capture, { denyList });
    expect(result.candidates.map((c) => c.view)).toEqual(['visible_text', 'json_ld']);
  });
});

describe('secrets (hard rule)', () => {
  it('reports four findings and leaks no secret fragment anywhere in the result', async () => {
    const wif = gen.wif('x-wif');
    const xprv = gen.xprv('x-xprv');
    const words = gen.mnemonic24('x-m24');
    const key = gen.hex64('x-hex');
    const address = gen.p2wpkh('x-addr');
    // Every secret overlaps the ±200-character snippet window of the address.
    const html = `<div class="post">WIF: ${wif}<br>klucz prywatny: ${key}<br>Mój portfel: ${address}<br>xprv: <span>${xprv}</span><br>Seed: ${words}</div>
      <p data-note="${key}">Kopia klucza w atrybucie</p>`;
    const result = await extractCapture(htmlCapture(html), { denyList, newId: sequentialIds() });
    expect(result.secrets.map((s) => s.kind).toSorted()).toEqual(
      ['hex64_private_key_context', 'seed_phrase', 'wif', 'xprv'].toSorted(),
    );
    expect(result.candidates.map((c) => c.address.address)).toEqual([address]);
    const serialised = JSON.stringify(result);
    for (const secret of [wif, xprv, words, key]) {
      for (const piece of fragments(secret)) expect(serialised).not.toContain(piece);
    }
    const snippet = result.candidates[0]?.context.snippet ?? '';
    for (const kind of ['wif', 'xprv', 'seed_phrase', 'hex64_private_key_context']) {
      expect(snippet).toContain(`[REDACTED:${kind}]`);
    }
    expect(result.rejected.some((r) => r.reason === 'tx_hash_like')).toBe(false);
  });

  it('treats a key under a JSON private-key field as a secret', async () => {
    const key = gen.hex64('json-key');
    const result = await extractCapture(jsonCapture(JSON.stringify({ wallet: { privateKey: key } })), { denyList });
    expect(result.secrets.map((s) => s.kind)).toEqual(['hex64_private_key_context']);
    expect(JSON.stringify(result)).not.toContain(key.slice(0, 12));
  });
});

describe('offline and robustness', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never touches the network', async () => {
    const fetchSpy = vi.fn<() => never>(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const result = await extractCapture(htmlCapture(`<p>${gen.p2wpkh('offline')}</p>`), { denyList });
    expect(result.candidates).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('has no network code in its sources', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect({
        file,
        network: /\bfetch\(|node:(?:http|https|net|tls|dgram)|@olcys\/http|from 'node:fs'/.test(source),
      }).toEqual({
        file,
        network: false,
      });
    }
  });

  it('produces no rejections from base64 blobs, digits or prose', async () => {
    const blobs = Array.from({ length: 200 }, (_, i) => base64.encode(bytes(`blob-${i}`, 65))).join(' ');
    const digits = Array.from({ length: 50 }, (_, i) => `1${String(i).padStart(2, '1')}${'123456789'.repeat(3)}`).join(
      ' ',
    );
    const html = `<p>${blobs}</p><p>${digits}</p><p>To jest zwykły tekst bez adresów, tylko słowa i liczby 123 456.</p>`;
    const result = await extractCapture(htmlCapture(html), { denyList: createDenyList({ version: 't', entries: [] }) });
    expect(result.candidates).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('caps the rejected list', async () => {
    const hashes = Array.from({ length: 30 }, (_, i) => gen.txHash(`cap-${i}`)).join(' ');
    const result = await extractCapture(htmlCapture(`<p>${hashes}</p>`), { denyList, maxRejected: 10 });
    expect(result.rejected).toHaveLength(10);
    expect(result.warnings).toContain('rejected_truncated:20');
  });

  it('scans a 1 MB page with 2,000 addresses quickly (soft benchmark)', async () => {
    const lorem =
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ';
    const paragraphs: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const address = [gen.p2wpkh, gen.evm, gen.tron, gen.p2pkh][i % 4]?.(`bench-${i}`) ?? '';
      paragraphs.push(`<p>Wpis ${i}: ${lorem}${lorem}Adres: ${address}</p>`);
    }
    const html = paragraphs.join('\n');
    expect(html.length).toBeGreaterThan(1_000_000);
    const started = performance.now();
    const result = await extractCapture(htmlCapture(html), { denyList });
    const ms = performance.now() - started;
    console.info(`extraction of ${(html.length / 1e6).toFixed(2)} MB with 2,000 addresses: ${ms.toFixed(0)} ms`);
    expect(result.candidates).toHaveLength(2000);
    expect(ms).toBeLessThan(15_000);
  });
});

/** A synthetic text file with `count` address lines. */
function addressFile(n: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `Adres ${i}: ${gen.p2wpkh(`file-${n}-${i}`)}`).join('\n');
}

describe('review regressions', () => {
  it('redacts secrets in context fields that no view contains (JSON keys, anchors) and in headings', async () => {
    const wif = gen.wif('ctx-field-wif');
    const words = gen.mnemonic12('ctx-field-words');
    const address = gen.p2wpkh('ctx-field-addr');
    const fromKey = await extractCapture(jsonCapture(JSON.stringify({ [wif]: address })), { denyList });
    expect(fromKey.candidates[0]?.context.label).toBe('[REDACTED:wif]');
    expect(fromKey.warnings).toContain('context_secret_redacted:wif');
    const fromAnchor = await extractCapture(htmlCapture(`<a name="${wif}"></a><p>Adres: ${address}</p>`), { denyList });
    expect(fromAnchor.candidates[0]?.context.anchor).toBe('[REDACTED:wif]');
    const fromHeading = await extractCapture(htmlCapture(`<h2>Seed: ${words}</h2><p>Adres: ${address}</p>`), {
      denyList,
    });
    expect(fromHeading.candidates[0]?.context.heading).toBe('Seed: [REDACTED:seed_phrase]');
    for (const result of [fromKey, fromAnchor, fromHeading]) {
      const serialised = JSON.stringify(result);
      for (const piece of [...fragments(wif), ...fragments(words)]) expect(serialised).not.toContain(piece);
    }
  });

  it('keeps two mentions of one address in one text node apart', async () => {
    const address = gen.evm('two-mentions');
    const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(5);
    const html = `<p>Oszust podaje adres ${address}. ${filler} Mój portfel: ${address}</p>`;
    const result = await extractCapture(htmlCapture(html), { denyList });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.context.occurrencesInCapture)).toEqual([2, 2]);
    expect(result.candidates.map((c) => c.context.roleCues[0])).toEqual(['scam_report', 'first_person_owner']);
  });

  it('maps escaped JSON strings to their own source and keeps them apart from a secret elsewhere', async () => {
    const address = gen.evm('escaped-json').toLowerCase();
    const key = gen.hex64('escaped-json-key');
    const escaped = `\\u0030${address.slice(1)}`;
    const json = `{"note":"klucz prywatny: ${key}","wallet":{"address":"${escaped}"}}`;
    const result = await extractCapture(jsonCapture(json), { denyList });
    expect(result.secrets.map((s) => s.kind)).toEqual(['hex64_private_key_context']);
    expect(result.candidates.map((c) => c.address.address)).toEqual([address]);
    const [view] = buildViews(jsonCapture(json));
    const segment = view?.segments.find((s) => s.jsonPointer === '/wallet/address');
    expect(json.slice(segment?.source?.start, segment?.source?.end)).toBe(escaped);
    for (const piece of fragments(key)) expect(JSON.stringify(result)).not.toContain(piece);
  });

  it('rejects a percent-encoded EIP-681 token contract shown as link text', async () => {
    const contract = gen.evm('e2e-contract');
    const payee = gen.evm('e2e-payee');
    const html = `<p><a href="ethereum:${contract}%401/transfer?address=${payee}">${contract}</a></p>`;
    const result = await extractCapture(htmlCapture(html), { denyList });
    expect(result.candidates.map((c) => c.address.address)).toEqual([payee.toLowerCase()]);
    expect(result.candidates[0]?.address.chain).toBe('evm:1');
    expect(result.rejected.map((r) => [r.view, r.reason])).toEqual([
      ['visible_text', 'uri_token_contract: transfer'],
      ['attribute', 'uri_token_contract: transfer'],
    ]);
  });

  it('counts listing density per artifact, not across files', async () => {
    const twoFiles = {
      ...textCapture(addressFile(0, 5)),
      artifacts: [addressFile(1, 5), addressFile(2, 5)].flatMap((t) => textCapture(t).artifacts),
    };
    const separate = await extractCapture(twoFiles, { denyList });
    expect(separate.candidates).toHaveLength(10);
    expect(separate.candidates.some((c) => c.context.roleCues.includes('listing'))).toBe(false);
    const oneFile = await extractCapture(textCapture(addressFile(3, 10)), { denyList });
    expect(oneFile.candidates.every((c) => c.context.roleCues.includes('listing'))).toBe(true);
  });
});

describe('secret propagation cost', () => {
  it('handles a page with thousands of secrets without per-secret rescans', async () => {
    const keys = Array.from({ length: 2000 }, (_unused, i) => gen.wif(`perf-secret-${i}`));
    const payee = gen.p2wpkh('perf-payee');
    const html = `<html><body>${keys.map((k) => `<p>klucz: ${k}</p>`).join('')}<p>Adres: ${payee}</p></body></html>`;
    const started = performance.now();
    const result = await extractCapture(htmlCapture(html), { denyList });
    const elapsed = performance.now() - started;
    expect(result.candidates.map((c) => c.address.address)).toContain(payee);
    expect(JSON.stringify(result)).not.toContain(keys[0]);
    expect(elapsed).toBeLessThan(5000);
  });
});
