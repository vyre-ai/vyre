// @ts-check
// Storage grants are kernel grants made through core/wink/grants.js (source wink:W3, action storage.hold). What lets a storage device hold chunks is still the pool's own credential, not this grant.
// This file keeps only the migration of the old table, which a release that dropped it would break: `moveLocalGrants` empties it and a later release drops it.

export const GRANT_MIGRATIONS = [
  `CREATE TABLE wink_storage_grants (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL)`,
];
