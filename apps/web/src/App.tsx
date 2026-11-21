import { CORE_CONTRACTS_VERSION, IDENTIFIER_KINDS } from '@olcys/core';
import { useEffect, useState } from 'react';
import { pl } from './i18n/pl.ts';

type Health = { status: string; service: string } | { error: string };

/** Skeleton screen; the real shell (routing, API client, layout) is not implemented yet. UI copy is Polish (src/i18n/pl.ts). */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setHealth({ error: String(e) }));
  }, []);

  const healthText = health === null ? pl.health.checking : 'error' in health ? pl.health.unreachable : pl.health.ok;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720 }}>
      <h1>
        {pl.app.name} — {pl.app.fullName}
      </h1>
      <p>
        {pl.app.skeletonNotice} ({pl.app.contractsVersion} {CORE_CONTRACTS_VERSION}).
      </p>
      <h2>{pl.home.supportedIdentifiers}</h2>
      <ul>
        {IDENTIFIER_KINDS.map((kind) => (
          <li key={kind}>{pl.identifierKinds[kind]}</li>
        ))}
      </ul>
      <p>
        {pl.health.label}: {healthText}
      </p>
    </main>
  );
}
