const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids are UUIDs in canonical lowercase form; anything else cannot exist and must not reach the database. Both stores
 * then see the same spelling (PostgreSQL's uuid type ignores case, the in-memory store does not).
 */
export const idOf = (value: string): string | undefined => (UUID.test(value) ? value.toLowerCase() : undefined);
