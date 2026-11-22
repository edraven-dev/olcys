/** Opaque identifier (UUIDv7 string; PostgreSQL 18+ generates them with `uuidv7()`). */
export type Id = string;

/** UTC timestamp in ISO 8601 format, e.g. `2026-11-21T13:41:00.000Z`. */
export type IsoDateTime = string;

/** Calendar date in ISO 8601 format, e.g. `2026-11-20`. */
export type IsoDate = string;

/** Lower-case hex SHA-256 digest (64 characters). */
export type Sha256Hex = string;

/**
 * Exact decimal number serialised as a string (e.g. `"0.00012345"`, `"1520.37"`).
 * Never use JS floating point for amounts or PLN values; use exact decimal arithmetic.
 */
export type DecimalString = string;

/** Version of the contracts in this package. Bump on any breaking change (see AGENTS.md). */
export const CORE_CONTRACTS_VERSION = '0.3.0';
