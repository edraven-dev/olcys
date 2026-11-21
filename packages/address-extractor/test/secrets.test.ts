import { describe, expect, it } from 'vitest';
import { normaliseView } from '../src/normalise/normalise.ts';
import { redactionMarker, redactText } from '../src/patterns/redact.ts';
import { scanView } from '../src/patterns/scan.ts';
import { detectSecrets } from '../src/patterns/secrets.ts';
import { fragments, gen, plainView } from './helpers.ts';

function secretsOf(text: string) {
  const view = plainView(text);
  return detectSecrets(view, normaliseView(view));
}

describe('secret detection', () => {
  const wif = gen.wif('s-wif');
  const xprv = gen.xprv('s-xprv');
  const words12 = gen.mnemonic12('s-m12');
  const words24 = gen.mnemonic24('s-m24');
  const key = gen.hex64('s-hex');

  it('finds WIF, xprv, 12/24-word mnemonics and a hex key after „klucz prywatny”', () => {
    const parts = [
      `Mój klucz WIF: ${wif}`,
      `Rozszerzony: ${xprv}`,
      `Fraza: ${words12}`,
      `Druga fraza: ${words24}`,
      `klucz prywatny: ${key}`,
    ];
    const text = parts.join('\n');
    const found = secretsOf(text);
    expect(found.map((s) => s.kind).toSorted()).toEqual(
      ['hex64_private_key_context', 'seed_phrase', 'seed_phrase', 'wif', 'xprv'].toSorted(),
    );
    const spanText = (kind: string) =>
      found.filter((s) => s.kind === kind).map((s) => text.slice(s.span.start, s.span.end));
    expect(spanText('wif')).toEqual([wif]);
    expect(spanText('xprv')).toEqual([xprv]);
    expect(spanText('seed_phrase').toSorted()).toEqual([words12, words24].toSorted());
    expect(spanText('hex64_private_key_context')).toEqual([key]);
  });

  it('treats the same hex after „tx:” as a hash, not a secret', () => {
    const view = plainView(`tx: ${key}`);
    const result = scanView(view, normaliseView(view));
    expect(result.secrets).toEqual([]);
    expect(result.hashes.map((h) => h.value)).toEqual([key]);
  });

  it('accepts numbered and comma-separated mnemonics, case- and diacritic-insensitive', () => {
    const words = words12.split(' ');
    const numbered = words.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join(' ');
    expect(secretsOf(numbered).map((s) => s.kind)).toEqual(['seed_phrase']);
    expect(secretsOf(words.join(', ')).map((s) => s.kind)).toEqual(['seed_phrase']);
    expect(secretsOf(words.slice(0, 11).join(' '))).toEqual([]);
  });

  it('does not flag ordinary prose', () => {
    expect(secretsOf('The quick brown fox jumps over the lazy dog and then walks back home again today.')).toEqual([]);
    expect(secretsOf('Przeszedłem na stablecoiny. mój portfel USDT TRC20 jest bezpieczny.')).toEqual([]);
  });

  it('uses JSON keys as private-key context', () => {
    const view = { ...plainView(key) };
    view.segments = view.segments.map((s) => Object.assign(s, { jsonPointer: '/wallet/privateKey' }));
    expect(detectSecrets(view, normaliseView(view)).map((s) => s.kind)).toEqual(['hex64_private_key_context']);
  });
});

describe('redaction (hard rule)', () => {
  const wif = gen.wif('r-wif');
  const words = gen.mnemonic24('r-m24');
  const address = gen.p2wpkh('r-addr');

  it('never leaves a secret or any 12-character fragment of it in redacted text or candidates', () => {
    const text = `Portfel: ${address}\nKlucz: ${wif}\nSeed: ${words}\nKoniec.`;
    const view = plainView(text);
    const result = scanView(view, normaliseView(view));
    const redacted = redactText(text, result.secrets);
    expect(redacted).toContain(redactionMarker('wif'));
    expect(redacted).toContain('[REDACTED:seed_phrase]');
    expect(redacted).toContain(address);
    for (const secret of [wif, words]) {
      for (const piece of fragments(secret)) {
        expect(redacted).not.toContain(piece);
        for (const c of result.candidates) expect(c.raw).not.toContain(piece);
      }
    }
    expect(result.candidates.map((c) => c.value)).toContain(address);
  });

  it('redacts slices with an offset and clips partial secrets', () => {
    const text = `abc SECRETSECRET xyz`;
    const span = { start: 4, end: 16 };
    expect(redactText(text, [span])).toBe('abc [REDACTED:secret] xyz');
    expect(redactText(text.slice(8), [span], 8)).toBe('[REDACTED:secret] xyz');
    expect(redactText(text, [{ kind: 'wif', view: 'visible_text', span }])).toBe('abc [REDACTED:wif] xyz');
    expect(redactText(text, [span, { start: 10, end: 18 }])).toBe('abc [REDACTED:secret]yz');
  });
});
