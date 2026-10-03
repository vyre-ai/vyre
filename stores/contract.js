// @ts-check
// The store interface (spec 3.2). A store keeps business records behind the gateway. It speaks
// only Vyre's types: ids are ours, definitions are ours, values are the language's value kinds.
// This file is the local copy of the contract until kernel/contracts lands; the shapes are the
// ones the conformance suite (stores/twenty/conformance/suite.js) tests.

export const SEALED_PLACEHOLDER = "[sealed]";

/**
 * @typedef {{ id: string, type: string, fields: Record<string, any>, version: string, hash: string,
 *   createdAt: string, updatedAt: string, deletedAt: string | null }} StoredRecord
 * @typedef {{ field: string, dir?: "asc" | "desc" }} Sort
 * @typedef {{ limit?: number, after?: string | null }} Page
 * @typedef {Record<string, any>} Filter  field: value, field: { eq, ne, gt, gte, lt, lte, in, contains, isNull }, and: [], or: []
 * @typedef {{ rows: StoredRecord[], next: string | null, total?: number }} QueryResult
 * @typedef {{ seq: number, at: string, source: string, kind: "created" | "updated" | "deleted" | "restored" | "destroyed", type: string,
 *   id: string, before: Record<string, any> | null, after: Record<string, any> | null, changed: string[], version: string | null, by: string | null }} Change
 * @typedef {{ define: Function, get: Function, query: Function, aggregate: Function, create: Function, update: Function,
 *   remove: Function, restore: Function, search: Function, changes: Function, health: Function, version: Function,
 *   export: Function, features: Function }} Store
 */

export const STORE_METHODS = ["define", "get", "query", "aggregate", "create", "update", "remove", "restore", "search", "changes", "health", "version", "export", "features"];

export class StoreError extends Error {
  /**
   * @param {"not_found" | "conflict" | "invalid" | "sealed_value" | "unknown_type" | "unknown_field" | "unavailable" | "name_reserved" | "unsupported" | "rate_limited" | "tampered" | "id_exists"} code
   * @param {string} message
   * @param {Record<string, any>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.detail = detail;
  }
}

/** @param {any} store @returns {asserts store is Store} */
export function assertStore(store) {
  for (const m of STORE_METHODS) if (typeof store?.[m] !== "function") throw new TypeError(`not a store: missing ${m}()`);
}
