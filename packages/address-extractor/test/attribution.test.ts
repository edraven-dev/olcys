import type { ChainId } from '@olcys/core';
import { describe, expect, it } from 'vitest';
import { applyPageChain, attributeChains, pageChainPrior } from '../src/attribution/cascade.ts';
import { findPaymentContexts } from '../src/attribution/contexts.ts';
import { normaliseView } from '../src/normalise/normalise.ts';
import { scanView } from '../src/patterns/scan.ts';
import type { AttributedCandidate, ViewText } from '../src/pipeline-types.ts';
import { resolveOverlaps, validateCandidate } from '../src/validate/validate.ts';
import { buildViews } from '../src/views/build.ts';
import { gen, jsonCapture, plainView, viewsOf } from './helpers.ts';

function attribute(view: ViewText, pageChain?: ChainId) {
  const norm = normaliseView(view);
  const scan = scanView(view, norm);
  const valid = scan.candidates.flatMap((c) => {
    const r = validateCandidate(c);
    return r.ok ? [r.value] : [];
  });
  const { valid: kept } = resolveOverlaps(valid, []);
  return attributeChains({
    candidates: kept,
    contexts: findPaymentContexts(view, norm),
    view,
    norm,
    ...(pageChain ? { pageChain } : {}),
  });
}

const byAddress = (list: AttributedCandidate[], address: string) =>
  list.find((c) => c.canonical === address.toLowerCase() || c.canonical === address);

describe('payment URIs', () => {
  it('EIP-681 transfer: the payee gets the chain, the token contract is rejected', () => {
    const token = gen.evm('token');
    const payee = gen.evm('payee');
    const result = attribute(plainView(`Zapłać: ethereum:${token}@56/transfer?address=${payee}&uint256=1e18`));
    expect(byAddress(result.attributed, payee)).toMatchObject({
      chain: 'evm:56',
      chainAttribution: { method: 'uri_chain_id' },
      payment: { role: 'recipient', params: { uint256: '1e18' } },
    });
    expect(byAddress(result.attributed, token)).toBeUndefined();
    expect(result.rejected).toMatchObject([{ reason: 'uri_token_contract: transfer', raw: token }]);
  });

  it('BIP-21: chain, params and QR-style upper case', () => {
    const address = gen.p2wpkh('bip21');
    const result = attribute(plainView(`bitcoin:${address}?amount=0.01&label=Wsparcie`));
    expect(byAddress(result.attributed, address)).toMatchObject({
      chain: 'bitcoin',
      chainAttribution: { method: 'format_unique' },
      payment: { scheme: 'bitcoin', params: { amount: '0.01', label: 'Wsparcie' } },
    });
    const upper = attribute(plainView(`BITCOIN:${address.toUpperCase()}`));
    expect(upper.attributed.map((c) => c.canonical)).toEqual([address]);
  });

  it('decodes percent-encoded URIs in links', () => {
    const payee = gen.evm('pct');
    const token = gen.evm('pct-token');
    const view = viewsOf(`<a href="ethereum:pay-${payee}%4056">zapłać</a>`).attribute;
    if (!view) throw new Error('no attribute view');
    expect(byAddress(attribute(view).attributed, payee)).toMatchObject({
      chain: 'evm:56',
      chainAttribution: { method: 'uri_chain_id' },
    });
    const encoded = `${payee.slice(0, 20)}%${payee.charCodeAt(20).toString(16)}${payee.slice(21)}`;
    const link = viewsOf(`<a href="ethereum:${token}/transfer?address%3D${encoded}">x</a>`).attribute;
    if (!link) throw new Error('no attribute view');
    const recipient = byAddress(attribute(link).attributed, payee);
    expect(recipient?.transforms).toEqual(['url_decode']);
    expect(recipient?.payment?.role).toBe('recipient');
  });
});

describe('EIP-681 function calls', () => {
  it('treats the target of any function call as a contract and its arguments as non-payees', () => {
    const contract = gen.evm('call-contract');
    const spender = gen.evm('call-spender');
    const result = attribute(plainView(`ethereum:${contract}@1/approve?address=${spender}&uint256=1`));
    expect(result.rejected).toMatchObject([{ reason: 'uri_token_contract: approve', raw: contract }]);
    const argument = byAddress(result.attributed, spender);
    expect(argument).toMatchObject({ chain: 'evm:1', chainAttribution: { method: 'uri_chain_id' } });
    expect(argument?.payment).toBeUndefined();
  });

  it('rejects a called contract even without a chain id; plain payments keep their recipient', () => {
    const contract = gen.evm('mint-contract');
    expect(attribute(plainView(`ethereum:${contract}/mint`)).rejected).toMatchObject([
      { reason: 'uri_token_contract: mint', raw: contract },
    ]);
    const payee = gen.evm('plain-payee');
    expect(byAddress(attribute(plainView(`ethereum:pay-${payee}@1?value=1e18`)).attributed, payee)?.payment?.role).toBe(
      'recipient',
    );
  });

  it('decodes link hrefs like the attribute view, so the token contract is rejected in link text too', () => {
    const contract = gen.evm('href-contract');
    const payee = gen.evm('href-payee');
    const view = viewsOf(
      `<p><a href="ethereum:${contract}%401/transfer?address=${payee}">${contract}</a></p>`,
    ).visible_text;
    if (!view) throw new Error('no view');
    const result = attribute(view);
    expect(byAddress(result.attributed, contract)).toBeUndefined();
    expect(result.rejected).toMatchObject([{ reason: 'uri_token_contract: transfer', raw: contract }]);
  });
});

describe('CAIP-10, EIP-3770 and explorers', () => {
  const a = gen.evm('caip');

  it('CAIP-10 and EIP-3770 set the chain; „Base: 0x…” is a label, not EIP-3770', () => {
    expect(byAddress(attribute(plainView(`eip155:137:${a}`)).attributed, a)).toMatchObject({
      chain: 'evm:137',
      chainAttribution: { method: 'caip10', detail: 'eip155:137' },
    });
    expect(byAddress(attribute(plainView(`matic:${a}`)).attributed, a)).toMatchObject({
      chain: 'evm:137',
      chainAttribution: { method: 'eip3770' },
    });
    expect(byAddress(attribute(plainView(`Base: ${a}`)).attributed, a)?.chainAttribution.method).toBe('keyword');
  });

  it('explorer links decide EVM chains; formats unique to one chain win over explorers', () => {
    expect(byAddress(attribute(plainView(`https://etherscan.io/address/${a}`)).attributed, a)).toMatchObject({
      chain: 'evm:1',
      chainAttribution: { method: 'explorer_domain', detail: 'etherscan.io' },
    });
    const tron = gen.tron('explorer');
    expect(byAddress(attribute(plainView(`https://tronscan.org/#/address/${tron}`)).attributed, tron)).toMatchObject({
      chain: 'tron',
      chainAttribution: { method: 'format_unique' },
    });
    expect(attribute(plainView(`https://mempool.space/testnet/address/tb1qexample`)).attributed).toEqual([]);
  });

  it('uses the href of the enclosing link', () => {
    const view = viewsOf(`<p><a href="https://bscscan.com/address/${a}">${a}</a></p>`).visible_text;
    if (!view) throw new Error('no view');
    expect(byAddress(attribute(view).attributed, a)).toMatchObject({
      chain: 'evm:56',
      chainAttribution: { method: 'explorer_domain', detail: 'bscscan.com' },
    });
  });

  it('notes markers that do not fit the format', () => {
    const tron = gen.tron('mismatch');
    expect(byAddress(attribute(plainView(`https://etherscan.io/address/${tron}`)).attributed, tron)).toMatchObject({
      chain: 'tron',
      chainAttribution: { method: 'format_unique', detail: 'marker_mismatch:etherscan.io' },
    });
  });
});

describe('keywords and page prior', () => {
  const a = gen.evm('kw-a');

  it('nearest keyword wins; without one the chain is unknown', () => {
    expect(byAddress(attribute(plainView(`Wpłaty USDT (BEP-20): ethereum:${a}`)).attributed, a)).toMatchObject({
      chain: 'evm:56',
      chainAttribution: { method: 'keyword' },
    });
    expect(byAddress(attribute(plainView(`Wczoraj wpłaciłem na giełdę 0,01 ETH: ${a}`)).attributed, a)).toMatchObject({
      chain: 'evm:1',
      chainAttribution: { method: 'keyword', detail: 'ETH' },
    });
    expect(byAddress(attribute(plainView(`ethereum:${a}`)).attributed, a)).toMatchObject({
      chain: 'evm:unknown',
      chainAttribution: { method: 'unknown' },
    });
  });

  it('reports equal-distance conflicts instead of guessing', () => {
    const result = byAddress(attribute(plainView(`polygon ${a} bsc`)).attributed, a);
    expect(result?.chain).toBe('evm:unknown');
    expect(result?.chainAttribution.detail).toMatch(/^keyword_conflict:/);
  });

  it('never lets non-EVM keywords set an EVM chain', () => {
    expect(byAddress(attribute(plainView(`USDT TRC20: ${a}`)).attributed, a)?.chain).toBe('evm:unknown');
  });

  it('applies the page prior from explicit attributions', () => {
    const b = gen.evm('kw-b');
    const c = gen.evm('kw-c');
    const page = attribute(plainView(`https://bscscan.com/address/${b}\nethereum:${c}@56\n\nInny wpis: ${a}`));
    const prior = pageChainPrior(page.attributed);
    expect(prior).toBe('evm:56');
    expect(byAddress(applyPageChain(page.attributed, prior), a)).toMatchObject({
      chain: 'evm:56',
      chainAttribution: { method: 'page_chain' },
    });
  });

  it('resolves ambiguous 3… addresses by keyword, else bitcoin with the alternatives listed', () => {
    const p2sh = gen.p2sh('kw-ltc');
    expect(byAddress(attribute(plainView(`Mój adres LTC: ${p2sh}`)).attributed, p2sh)).toMatchObject({
      chain: 'litecoin',
      chainAttribution: { method: 'keyword' },
    });
    expect(byAddress(attribute(plainView(`Adres: ${p2sh}`)).attributed, p2sh)).toMatchObject({
      chain: 'bitcoin',
      chainAttribution: { method: 'format_unique', detail: 'ambiguous: litecoin|bitcoincash' },
    });
  });

  it('reads chain keywords from JSON keys (FUNDING.json)', () => {
    const owner = gen.evm('funding');
    const [view] = buildViews(jsonCapture(JSON.stringify({ drips: { ethereum: { ownedBy: owner } } })));
    if (!view) throw new Error('no view');
    expect(byAddress(attribute(view).attributed, owner)).toMatchObject({
      chain: 'evm:1',
      chainAttribution: { method: 'keyword', detail: 'json key' },
    });
  });

  it('reads chain keywords from sibling JSON values', () => {
    const address = gen.evm('sibling');
    const json = JSON.stringify({ data: { addresses: [{ address, coin: 'ETH', post_id: 65000101 }] } });
    const [view] = buildViews(jsonCapture(json));
    if (!view) throw new Error('no view');
    expect(byAddress(attribute(view).attributed, address)?.chain).toBe('evm:1');
  });
});
