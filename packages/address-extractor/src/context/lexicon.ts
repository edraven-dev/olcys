/**
 * Deterministic Polish/English role-cue lexicon. Patterns run on folded text (lower case, Polish diacritics removed:
 * „mój portfel” → `moj portfel`). Extend only together with tests.
 */
import type { RoleCue } from '@olcys/core';

export const LEXICON_VERSION = 'lexicon.v1';

export interface LexiconEntry {
  cue: RoleCue;
  lang: 'pl' | 'en';
  pattern: RegExp;
}

const entry = (cue: RoleCue, lang: 'pl' | 'en', source: string): LexiconEntry => ({
  cue,
  lang,
  pattern: new RegExp(source, 'g'),
});

export const ROLE_LEXICON: readonly LexiconEntry[] = [
  // first_person_owner
  entry(
    'first_person_owner',
    'pl',
    String.raw`\bmo(?:j|ja|je|jego|im|jej)\s+(?:portfel\w*|adres\w*|kont\w*|btc|eth|usdt)`,
  ),
  entry('first_person_owner', 'pl', String.raw`\bna\s+moj\w*\s+(?:portfel|adres)`),
  entry('first_person_owner', 'pl', String.raw`\bnasz\w*\s+(?:portfel|adres)\w*`),
  entry('first_person_owner', 'pl', String.raw`\badres\s+(?:mojego\s+)?portfela\b`),
  entry('first_person_owner', 'pl', String.raw`\boto\s+moj`),
  entry('first_person_owner', 'en', String.raw`\bmy\s+(?:wallet|address|btc|eth)\b`),
  entry('first_person_owner', 'en', String.raw`\bour\s+wallet\b`),
  entry('first_person_owner', 'en', String.raw`\bhere\s+is\s+my\b`),
  // payment_request
  entry(
    'payment_request',
    'pl',
    String.raw`\bwplac\w*|\bwplat\w*\s+na\b|\bprzelej\w*|\bprzelew\w*|\bwyslij\w*|\bprzeslij\w*|\bzaplac\w*|\bplatnos\w*|\bplatne\s+w\b|\bprzyjmuje\b|\bakceptuje\b|\bsprzedam\b|\bcena\b`,
  ),
  entry('payment_request', 'en', String.raw`\bpay\s+to\b|\bsend\s+to\b|\bpayment\b|\bprice\b`),
  // donation
  entry('donation', 'pl', String.raw`\bdarowizn\w*|\bwesprzyj\w*|\bwsparci\w*|\bwspomoz\w*|\bnapiw\w*|\bzrzutk\w*`),
  entry('donation', 'en', String.raw`\bdonat\w*|\btips?\b|\bsupport\s+(?:me|us|the)\b`),
  // scam_report
  entry(
    'scam_report',
    'pl',
    String.raw`\boszus\w*|\boszukal\w*|\bnaciagacz\w*|\bwyludz\w*|\bzgloszon\w*|\bzglaszam\b|\bpodejrzan\w*|\bokup\w*`,
  ),
  entry('scam_report', 'en', String.raw`\bscam\w*|\bransomware\b|\bphishing\w*|\breported\b|\bblacklist\w*|\bfraud\w*`),
  // warning
  entry('warning', 'pl', String.raw`\buwaga\b|\bostrzeg\w*|\bnie\s+(?:wysylaj|wplacaj)\w*`),
  entry('warning', 'en', String.raw`\bdo\s+not\s+send\b|\bdon'?t\s+send\b|\bwarning\b|\bbeware\b`),
  // exchange_deposit
  entry('exchange_deposit', 'pl', String.raw`\bna\s+giel\w*|\bgield\w*|\badres\s+depozyt\w*|\btag\s+docelowy\b`),
  entry('exchange_deposit', 'en', String.raw`\bdeposit\s+address\b|\bdestination\s+tag\b|\bmemo\b`),
  // quote (headers; quoted segments and `>` lines are structural)
  entry('quote', 'pl', String.raw`\bcytat:|\bnapisal\(a\):|\bnapisal:`),
  entry('quote', 'en', String.raw`\bquote\s+from:|\bwrote:`),
  // listing
  entry('listing', 'pl', String.raw`\bprzyklad\w*|\bdokumentacj\w*|\blista\s+adresow\b`),
  entry(
    'listing',
    'en',
    String.raw`\bexample\b|\bsample\b|\btestnet\b|\bbip-?\d+|\beip-?\d+|\btop\s+holders\b|\brich\s+list\b`,
  ),
];

/** Negations that suppress a cue when one of the two preceding tokens („to nie jest mój portfel”). */
export const NEGATIONS: ReadonlySet<string> = new Set(['nie', 'not', 'never', 'nigdy']);
