import { describe, expect, it } from 'vitest';
import { createSecretRedactor } from '../src/index.ts';
import { fragments, gen } from './helpers.ts';

describe('createSecretRedactor', () => {
  const redactor = createSecretRedactor();

  it('replaces private keys and seed phrases and reports kinds and spans only', () => {
    const wif = gen.wif('redactor-wif');
    const seed = gen.mnemonic12('redactor-seed');
    const address = gen.p2wpkh('redactor-address');
    const text = `<p>klucz: ${wif}</p><p>seed: ${seed}</p><p>adres: ${address}</p>`;
    const result = redactor.redact(text);
    for (const fragment of [...fragments(wif), ...fragments(seed)]) expect(result.text).not.toContain(fragment);
    expect(result.text).toContain(address);
    expect(result.findings.map((f) => f.kind).toSorted()).toEqual(['seed_phrase', 'wif']);
    expect(JSON.stringify(result.findings)).not.toContain(wif.slice(0, 12));
  });

  it('finds a seed phrase split across HTML elements and redacts it in the original body', () => {
    const seed = gen.mnemonic12('redactor-split-seed');
    const html = `<html><body><p>Moje słowa: ${seed
      .split(' ')
      .map((w) => `<span class="w">${w}</span>`)
      .join(' ')}</p></body></html>`;
    const result = redactor.redact(html);
    expect(result.findings.map((f) => f.kind)).toContain('seed_phrase');
    for (const word of seed.split(' ').slice(1, -1)) expect(result.text).not.toContain(`>${word}<`);
    expect(result.text).toContain('<p>Moje słowa: ');
  });

  it('finds a key inside a JSON document', () => {
    const wif = gen.wif('redactor-json-wif');
    const result = redactor.redact(JSON.stringify({ note: 'klucz', key: wif }));
    for (const fragment of fragments(wif)) expect(result.text).not.toContain(fragment);
  });

  it('returns text without secrets unchanged', () => {
    const text = 'Zwykły wpis bez sekretów.';
    expect(redactor.redact(text)).toEqual({ text, findings: [] });
  });
});
