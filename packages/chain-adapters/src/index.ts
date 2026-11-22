/**
 * @olcys/chain-adapters — blockchain data providers behind the `ChainProvider` port (Esplora, Etherscan V2,
 * TronGrid): the same code serves public APIs, self-hosted nodes and the synthetic fixture site; only the base URL
 * differs. Every request goes through the run's egress client (`ctx.http`).
 *
 * Contracts (types and ports) come from @olcys/core.
 */
export {
  apiKeyOf,
  CHAIN_PROVIDER_KINDS,
  loadChainProviderConfig,
  withFixtureSite,
  type ChainProviderConfig,
  type ChainProviderKind,
  type ProviderDeps,
} from './config.ts';
export { CHAIN_ERROR_KINDS, ChainProviderError, isChainProviderError, type ChainErrorKind } from './errors.ts';
export {
  createEsploraProvider,
  deriveTransfers,
  ESPLORA_PAGE_SIZE,
  mapEsploraTx,
  type EsploraTx,
  type EsploraVin,
  type EsploraVout,
} from './esplora.ts';
export {
  classifyEthCall,
  classifyEtherscan,
  createEtherscanProvider,
  ETHERSCAN_ATTRIBUTION,
  mapEtherscanRows,
  type EtherscanCursor,
} from './etherscan.ts';
export { parseJsonExact } from './json.ts';
export { ChainProviderRegistry, createChainProvider, createChainProviderRegistry } from './registry.ts';
export {
  CircuitBreaker,
  requestJson,
  requestText,
  statusKind,
  type ChainRequest,
  type RequestOptions,
} from './request.ts';
export {
  compareTransfers,
  runChainFetch,
  TipCache,
  transferKey,
  type ChainFetchOptions,
  type ChainFetchOutcome,
  type ChainFetchPlanItem,
  type ChainFetchResult,
  type ChainFetchStatus,
} from './runner.ts';
export { createTronGridProvider, mapTrc20Items, USDT_TRC20, type TronCursor } from './trongrid.ts';
export {
  baseUnitsToDecimal,
  decodeCursor,
  encodeCursor,
  MAX_DECIMALS,
  rowAmount,
  supportedDecimals,
  type SkipReason,
} from './units.ts';
