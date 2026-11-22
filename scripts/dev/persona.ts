/** The synthetic demo persona's case (ROADMAP "Demo persona"). Synthetic data only: `example.org`, invented names. */
import type { CreateCaseInput } from '../../packages/core/src/index.ts';

export const PERSONA_TITLE = 'Kacper Fikcyjny (demonstracja)';

const JUSTIFICATION = 'Sprawa demonstracyjna: dane syntetyczne persony';

export const personaCase: CreateCaseInput = {
  title: PERSONA_TITLE,
  purpose: 'Demonstracja na danych syntetycznych',
  legalBasis: 'demonstracja',
  identifiers: [
    { kind: 'nickname', value: 'fikcyjny_kacper', platform: 'bitcointalk', isAnchor: true },
    { kind: 'full_name', value: 'Kacper Fikcyjny', isAnchor: false },
    { kind: 'email', value: 'kacper.fikcyjny@example.org', isAnchor: false },
  ],
  scope: {
    enabledSources: [
      'bitcointalk',
      'wykop',
      'github',
      'telegram_preview',
      // Official Polish registries (GREEN).
      'ceidg',
      'vat_whitelist',
      'krs',
      'mock_search',
      // Chain data providers (AMBER) and the NBP exchange-rate API (GREEN).
      'mempool_space',
      'etherscan_v2',
      'trongrid',
      'nbp_api',
    ],
    amberJustifications: {
      bitcointalk: JUSTIFICATION,
      wykop: JUSTIFICATION,
      github: JUSTIFICATION,
      telegram_preview: JUSTIFICATION,
      etherscan_v2: JUSTIFICATION,
      trongrid: JUSTIFICATION,
    },
    chains: [],
    maxPivotDepth: 2,
  },
};
