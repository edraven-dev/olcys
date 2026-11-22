/** Polish strings of the demo script (the script's own catalogue; the web app keeps its strings in apps/web). */

export const pl = {
  title: 'OŁCyŚ: demonstracja na danych syntetycznych',
  refuseNonLoopback: (what: string) => `Odmowa: ${what} musi wskazywać adres lokalny (127.0.0.1, localhost lub [::1]).`,
  apiDown: (url: string, cause?: string) =>
    `API nie odpowiada pod ${url}${cause ? ` (${cause})` : ''}. Uruchom usługi i aplikację: \`pnpm dev:deps\`, a potem \`pnpm dev\` (albo ustaw API_URL).`,
  fixtureDown: (url: string, cause?: string) =>
    `Strona testowa nie odpowiada pod ${url}${cause ? ` (${cause})` : ''}. Uruchom \`pnpm dev:deps\` (albo \`pnpm dev:fixture\`, albo ustaw FIXTURE_SITE_URL).`,
  variantSwitchOff: () =>
    'Strona testowa odrzuciła przełączenie wariantu. Ustaw FIXTURE_ALLOW_VARIANT_SWITCH=1 w .env (dane są syntetyczne, tylko pętla zwrotna) i uruchom ponownie `pnpm dev:deps`.',
  health: (api: string, fixture: string) => `Sprawdzam usługi: API ${api}, strona testowa ${fixture}`,
  step: {
    variant: (v: string) => `Wariant strony testowej: ${v}`,
    case: (id: string) => `Utworzono sprawę ${id}`,
    run: (n: number, id: string) => `Uruchomienie ${n}: ${id}`,
    progress: (status: string, step?: string) => `  stan: ${status}${step ? ` (${step})` : ''}`,
    done: (n: number, status: string) => `Uruchomienie ${n} zakończone: ${status}`,
    failed: (n: number, status: string, error?: string) =>
      `Uruchomienie ${n} nie powiodło się (${status})${error ? `: ${error}` : ''}`,
    timeout: (n: number) => `Przekroczono czas oczekiwania na uruchomienie ${n}.`,
    http: (what: string, status: number | string, body: string) =>
      `Żądanie ${what} nie powiodło się (${status}): ${body.slice(0, 300)}`,
  },
  summary: {
    case: 'Sprawa',
    ui: 'Widok w interfejsie',
    report: 'Raport (uruchomienie 1)',
    reportV2: 'Raport (uruchomienie 2)',
    links: 'Powiązania tożsamość ↔ adres (uruchomienie 1)',
    rejected: 'Odrzucone adresy i powód',
    cashOut: 'Przesłanki wyjścia do fiat',
    alert: 'Alert zmiany (uruchomienie 2)',
    alertText: (from: string, to: string) => `adres portfela w profilu zmienił się: ${from} → ${to}`,
    linksV2: 'Powiązania po zmianie (uruchomienie 2)',
    none: '(brak)',
    selfCheckOk: (n: number) => `Samokontrola: ${n} sprawdzeń zgodnych z fixtures/demo/manifest.json`,
    selfCheckFail: (n: number) => `Samokontrola: ${n} niezgodności z fixtures/demo/manifest.json`,
    notice: 'Dane syntetyczne: persona, adresy i kursy są wymyślone; nic nie wyszło do sieci publicznej.',
  },
  band: {
    BARDZO_WYSOKIE: 'BARDZO WYSOKIE',
    PRAWDOPODOBNE: 'PRAWDOPODOBNE',
    SREDNIE: 'ŚREDNIE',
    NISKIE: 'NISKIE / SZUM',
    WYKLUCZENIE: 'WYKLUCZENIE',
  } as Record<string, string>,
  exclusionRules: {
    A1: 'adres oznaczony jako usługa (portfel gorący giełdy)',
    A2: 'smart kontrakt, nie konto osoby',
    A4: 'adres depozytowy giełdy (trop KYC, nie majątek)',
    A8: 'przykład z dokumentacji (wektor testowy)',
  } as Record<string, string>,
  cashOutRules: {
    B1: 'wpłata na giełdę',
    B4: 'zamiana na stablecoin, potem wyjście',
    B5: 'wymiana P2P (okrągłe kwoty)',
  } as Record<string, string>,
  mismatch: {
    header: 'Niezgodności (oczekiwano / otrzymano):',
    line: (check: string, expected: string, actual: string) =>
      `  - ${check}\n      oczekiwano: ${expected}\n      otrzymano:  ${actual}`,
  },
  checks: {
    link: (run: number, slot: string) => `uruchomienie ${run}: wynik powiązania ${slot}`,
    zero: (run: number, slot: string) => `uruchomienie ${run}: ${slot} bez dodatniego wyniku`,
    rejected: (run: number, slot: string, rule: string) => `uruchomienie ${run}: ${slot} odrzucony regułą ${rule}`,
    cashOut: (run: number, slot: string, rule: string) => `uruchomienie ${run}: przesłanka ${rule} dla ${slot}`,
    change: (run: number, property: string) => `uruchomienie ${run}: zmiana ${property}`,
    report: (run: number, slot: string) => `uruchomienie ${run}: raport zawiera adres ${slot}`,
    status: (run: number) => `uruchomienie ${run}: stan końcowy`,
  },
} as const;
