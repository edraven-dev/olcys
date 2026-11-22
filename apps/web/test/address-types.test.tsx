/**
 * Address types on the rejected-attribution cards: the Polish label of every core type, the evidence it rests on, and
 * the match of a candidate without an attributed EVM network. Synthetic addresses.
 */
import type { AddressTypeClassification, RunWithProgress } from '@olcys/core';
import { ADDRESS_TYPE_PROBES, ADDRESS_TYPES } from '@olcys/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionCard } from '../src/features/rejected/RejectedTab.tsx';
import { addressTypeFor } from '../src/features/rejected/rejected-model.ts';
import type { RunScope } from '../src/features/run/RunPage.tsx';
import { pl } from '../src/i18n/pl.ts';
import type { ExclusionView } from '../src/lib/domain.ts';
import { RUN_ID } from './fixtures/persona.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const scope = {
  run: { id: RUN_ID, caseId: 'case-1' } as RunWithProgress,
  kase: undefined,
  version: '',
} satisfies RunScope;
const CONTRACT = `0x${'9a'.repeat(20)}`;
const DELEGATED = `0x${'7a'.repeat(20)}`;
const SWEEPER = '0x2b5712612396864a3b6db2fd30c5a0169ec1e34b';

const decision = (over: Partial<ExclusionView> & Pick<ExclusionView, 'address' | 'ruleId'>): ExclusionView => ({
  id: `ex-${over.ruleId}`,
  runId: RUN_ID,
  outcome: 'excluded',
  reason: `${over.ruleId}: test`,
  evidence: {},
  rulesVersion: 'exclusion.v1',
  ...over,
});

const card = (d: ExclusionView, addressType?: AddressTypeClassification) =>
  text(
    renderToStaticMarkup(
      <ul>
        <DecisionCard
          decision={d}
          addressType={addressType}
          labels={[]}
          mentions={[]}
          captures={new Map()}
          cashOuts={[]}
          scope={scope}
        />
      </ul>,
    ),
  );

describe('address types in the console', () => {
  it('labels every core address type and probe in Polish', () => {
    expect(Object.keys(pl.addressTypes).toSorted()).toEqual([...ADDRESS_TYPES].toSorted());
    expect(Object.keys(pl.addressType.probes)).toEqual([...ADDRESS_TYPE_PROBES]);
    expect(pl.addressTypes.delegated_eoa).toBe('EOA z delegacją EIP-7702');
  });

  it('shows the type behind A2 on the card', () => {
    const contract: AddressTypeClassification = {
      address: { chain: 'evm:1', address: CONTRACT },
      type: 'contract',
      codePrefix: '0x60806040',
      codeSize: 48,
      implementation: `0x${'1e'.repeat(20)}`,
      fetchIds: ['f1'],
    };
    const content = card(decision({ address: { chain: 'evm:1', address: CONTRACT }, ruleId: 'A2' }), contract);
    expect(content).toContain('Typ adresu kontrakt (stan na zapisany szczyt łańcucha)');
    expect(content).toContain(`Implementacja proxy ERC-1967: 0x${'1e'.repeat(20)}`);
  });

  it('names a registered sweeper delegate and a failed probe', () => {
    const delegated: AddressTypeClassification = {
      address: { chain: 'evm:1', address: DELEGATED },
      type: 'delegated_eoa',
      codePrefix: '0xef0100',
      codeSize: 23,
      delegate: SWEEPER,
      fetchIds: ['f1'],
    };
    const flagged = decision({
      address: { chain: 'evm:1', address: DELEGATED },
      ruleId: 'A3',
      outcome: 'flagged',
      evidence: {
        delegate: SWEEPER,
        delegateInfo: { kind: 'sweeper', name: 'SWEEPER-1 (SYNTHETIC)', source: 'synthetic demo entry' },
      },
    });
    const content = card(flagged, delegated);
    expect(content).toContain('EOA z delegacją EIP-7702');
    expect(content).toContain(`Delegat EIP-7702: ${SWEEPER}`);
    expect(content).toContain('znany „sweeper”');
    expect(content).toContain('SWEEPER-1 (SYNTHETIC)');

    const unknown: AddressTypeClassification = {
      address: { chain: 'evm:1', address: CONTRACT },
      type: 'unknown',
      failedProbe: { probe: 'safe', message: 'etherscan-v2: rate_limited' },
      fetchIds: ['f1'],
    };
    expect(card(decision({ address: { chain: 'evm:1', address: CONTRACT }, ruleId: 'A4' }), unknown)).toContain(
      'Sprawdzenie „konto Safe (slot 0)” nie powiodło się',
    );
    expect(card(decision({ address: { chain: 'evm:1', address: CONTRACT }, ruleId: 'A2' }))).not.toContain(
      'Typ adresu',
    );
  });

  it('matches a candidate without an attributed EVM network to the network it was fetched on', () => {
    const types: AddressTypeClassification[] = [
      { address: { chain: 'evm:1', address: CONTRACT }, type: 'contract', fetchIds: [] },
      { address: { chain: 'tron', address: 'TEF4fy9kB3AMsif7YutQWnLo4JZ5TnUVtu' }, type: 'eoa', fetchIds: [] },
    ];
    expect(
      addressTypeFor({ chain: 'evm:unknown', address: CONTRACT.toUpperCase().replace('0X', '0x') }, types)?.type,
    ).toBe('contract');
    expect(addressTypeFor({ chain: 'evm:137', address: CONTRACT }, types)).toBeUndefined();
    expect(addressTypeFor({ chain: 'tron', address: 'TEF4fy9kB3AMsif7YutQWnLo4JZ5TnUVtu' }, types)?.type).toBe('eoa');
    expect(addressTypeFor({ chain: 'tron', address: 'tef4fy9kb3amsif7yutqwnlo4jz5tnuvtu' }, types)).toBeUndefined();
  });
});
