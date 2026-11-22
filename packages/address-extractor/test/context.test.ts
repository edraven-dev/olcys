import type { RoleCue } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { detectRoleCues } from '../src/context/cues.ts';
import { ROLE_LEXICON } from '../src/context/lexicon.ts';
import { createDenyList } from '../src/deny-list.ts';
import { extractCapture } from '../src/extract.ts';
import { fragments, gen, htmlCapture } from './helpers.ts';

const denyList = createDenyList({ version: 'test', entries: [] });

async function candidatesOf(html: string) {
  return (await extractCapture(htmlCapture(html), { denyList })).candidates;
}

function cuesFor(sentence: string, placeholder = '<A>'): RoleCue[] {
  const address = gen.evm('cue');
  const text = sentence.replace(placeholder, address);
  return detectRoleCues(text, text.indexOf(address), {
    quoted: false,
    containerAddresses: 1,
    pageAddresses: 1,
    candidateLength: address.length,
  });
}

describe('role cues (persona sentences)', () => {
  it('Wykop entry: first person owner, with the label before the address', async () => {
    const tron = gen.tron('ctx-tron1');
    const [c] = await candidatesOf(
      `<article id="wpis-71000001"><p>Przeszedłem na stablecoiny. mój portfel USDT TRC20: ${tron}</p></article>`,
    );
    expect(c?.context.roleCues).toEqual(['first_person_owner']);
    expect(c?.context.label).toBe('mój portfel USDT TRC20');
    expect(c?.context.anchor).toBe('wpis-71000001');
    expect(c?.address).toEqual({ chain: 'tron', address: tron });
  });

  it('forum deposit post: exchange deposit first; the tx hash stays in the snippet', async () => {
    const eth = gen.evm('ctx-eth1');
    const tx = gen.txHash('ctx-tx');
    const [c] = await candidatesOf(
      `<div class="post">Wczoraj wpłaciłem na giełdę: ${eth} (tx ${tx}). Ile trwa zaksięgowanie?</div>`,
    );
    expect(c?.context.roleCues[0]).toBe('exchange_deposit');
    expect(c?.context.snippet).toContain(tx);
    expect(c?.context.snippet).toContain(eth);
  });

  it('channel warning: scam report and warning, payment request negated', () => {
    expect(cuesFor('Uwaga! Oszust podaje adres <A> — podpisuje się jako fikcyjny_kacper. Nie wpłacajcie!')).toEqual([
      'scam_report',
      'warning',
    ]);
  });

  it('documentation example in a code block: inCode, listing, label without colon', async () => {
    const address = gen.p2wpkh('ctx-doc');
    const [c] = await candidatesOf(
      `<div class="post">Przykład formatu adresu z dokumentacji BIP-173:<div class="codeheader">Code:</div><div class="code">${address}</div></div>`,
    );
    expect(c?.view).toBe('code');
    expect(c?.context.inCode).toBe(true);
    expect(c?.context.roleCues).toContain('listing');
    expect(c?.context.label).toBe('Przykład formatu adresu z dokumentacji BIP-173');
  });

  it('a post with 55 addresses is a listing; another post on the same page is not', async () => {
    const listing = Array.from({ length: 55 }, (_, i) => gen.evm(`listing-${i}`));
    const lines = listing.map((a, i) => `Giełda Testowa ${String(i + 1).padStart(2, '0')} — portfel: ${a}`);
    const single = gen.evm('ctx-single');
    const candidates = await candidatesOf(
      `<div class="post">${lines.join('<br>')}</div><div class="post">Moje konto: ${single}</div><div class="post">Drugi: ${gen.evm('ctx-other')}</div>`,
    );
    expect(candidates).toHaveLength(57);
    const inListing = new Set(listing.map((a) => a.toLowerCase()));
    const listed = candidates.filter((c) => inListing.has(c.address.address));
    expect(listed).toHaveLength(55);
    for (const c of listed) expect(c.context.roleCues).toContain('listing');
    const lone = candidates.find((c) => c.address.address === single.toLowerCase());
    expect(lone?.context.pageAddressDensity).toBe(57);
    expect(lone?.context.roleCues).not.toContain('listing');
  });

  it('negation suppresses ownership', () => {
    expect(cuesFor('to nie jest mój portfel: <A>')).toEqual(['unclear']);
  });

  it('quoted text comes first and the quote header is found', async () => {
    const address = gen.p2wpkh('ctx-quote');
    const [c] = await candidatesOf(
      `<div class="post"><div class="quoteheader"><a href="#">Quote from: fikcyjny_kacper on November 01, 2026</a></div><div class="quote">Mój portfel: ${address}</div>Podpis zweryfikowany.</div>`,
    );
    expect(c?.context.roleCues[0]).toBe('quote');
    expect(c?.context.snippet).toContain('Quote from: fikcyjny_kacper');
  });

  it('redacts a nearby seed phrase and never shows the synthetic banner from another container', async () => {
    const address = gen.p2wpkh('ctx-seed');
    const words = gen.mnemonic12('ctx-seed-words');
    const [c] = await candidatesOf(
      `<div class="olcys-synthetic" role="note">DANE SYNTETYCZNE — SYNTHETIC TEST DATA</div><div class="post">Mój portfel: ${address}. Fraza: ${words}</div>`,
    );
    expect(c?.context.snippet).toContain('[REDACTED:seed_phrase]');
    for (const piece of fragments(words)) expect(c?.context.snippet).not.toContain(piece);
    expect(c?.context.snippet).not.toContain('SYNTHETIC');
    expect(c?.context.roleCues[0]).toBe('first_person_owner');
  });

  it('profile table row: label from the first cell, anchor from the preceding a[name]', async () => {
    const address = gen.p2wpkh('ctx-profile');
    const [c] = await candidatesOf(
      `<a name="msg65000001"></a><table><tr><td><b>Bitcoin address: </b></td><td>${address}</td></tr></table>`,
    );
    expect(c?.context.label).toBe('Bitcoin address');
    expect(c?.context.anchor).toBe('msg65000001');
    expect(c?.chainAttribution.method).toBe('format_unique');
  });

  it('page headings are recorded', async () => {
    const address = gen.p2wpkh('ctx-heading');
    const [c] = await candidatesOf(`<h1>Profil</h1><h2>Wsparcie projektu</h2><p>Wesprzyj nas: ${address}</p>`);
    expect(c?.context.heading).toBe('Wsparcie projektu');
    expect(c?.context.roleCues).toEqual(['donation']);
  });
});

describe('lexicon', () => {
  const positives: [RoleCue, string][] = [
    ['first_person_owner', 'mój portfel: <A>'],
    ['first_person_owner', 'Wpłaty na mój adres <A>'],
    ['first_person_owner', 'here is my <A>'],
    ['payment_request', 'Sprzedam USDT, przelej na <A>'],
    ['payment_request', 'pay to <A>'],
    ['donation', 'Wesprzyj projekt: <A>'],
    ['donation', 'tips: <A>'],
    ['scam_report', 'Zgłaszam oszusta <A>'],
    ['scam_report', 'reported scam <A>'],
    ['warning', 'Ostrzegam przed <A>'],
    ['warning', 'do not send to <A>'],
    ['exchange_deposit', 'adres depozytowy giełdy <A>'],
    ['exchange_deposit', 'deposit address <A>'],
    ['quote', 'fikcyjny_kacper napisał: <A>'],
    ['quote', 'someone wrote: <A>'],
    ['listing', 'lista adresów: <A>'],
    ['listing', 'example <A>'],
  ];

  it.each(positives)('%s fires on „%s”', (cue, sentence) => {
    expect(cuesFor(sentence)).toContain(cue);
  });

  const negated: [RoleCue, string][] = [
    ['first_person_owner', 'to nie mój portfel: <A>'],
    ['first_person_owner', 'this is not my wallet <A>'],
    ['payment_request', 'nie przelewaj na <A>'],
    ['payment_request', 'never send to <A>'],
    ['donation', 'nie wspieraj, to nie darowizna <A>'],
    ['scam_report', 'to nie oszust <A>'],
    ['scam_report', 'not a scam <A>'],
    ['exchange_deposit', 'to nie adres depozytowy <A>'],
    ['listing', 'to nie przykład: <A>'],
  ];

  it.each(negated)('%s is suppressed by a negation in „%s”', (cue, sentence) => {
    expect(cuesFor(sentence)).not.toContain(cue);
  });

  it('does not treat bare „test” as a listing cue', () => {
    expect(cuesFor('SYNTHETIC TEST DATA test <A>')).toEqual(['unclear']);
  });

  it('every lexicon entry is a global regex on folded text', () => {
    for (const entry of ROLE_LEXICON) {
      expect(entry.pattern.flags).toContain('g');
      expect(entry.pattern.source).toBe(entry.pattern.source.toLowerCase());
    }
  });
});
