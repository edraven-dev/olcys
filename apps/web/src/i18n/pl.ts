/**
 * Polish UI copy — the ONLY source of user-visible strings in the analyst console.
 * The console is Polish-only (end users: KAS analysts). Code identifiers stay English; never hard-code
 * Polish text in components, add a key here instead. Terminology follows the challenge brief
 * (Wskaźnik Pewności, wyjście do walut tradycyjnych / fiat cash-out, ślady OSINT).
 */
import type { IdentifierKind } from '@olcys/core';

export const pl = {
  app: {
    name: 'OŁCyŚ',
    fullName: 'Osintowy łapacz cyfrowych śladów',
    skeletonNotice: 'Szkielet konsoli analityka',
    contractsVersion: 'wersja kontraktów',
  },
  identifierKinds: {
    full_name: 'imię i nazwisko',
    nickname: 'nick używany na forum',
    messenger_id: 'identyfikator z komunikatora',
    social_login: 'login z portalu społecznościowego',
    email: 'adres e-mail',
    crypto_address: 'publiczny adres kryptowalutowy',
  } satisfies Record<IdentifierKind, string>,
  health: {
    label: 'Połączenie z API',
    checking: 'sprawdzanie…',
    ok: 'działa',
    unreachable: 'brak połączenia',
  },
  home: {
    supportedIdentifiers: 'Obsługiwane identyfikatory wejściowe',
  },
} as const;

export type Messages = typeof pl;
