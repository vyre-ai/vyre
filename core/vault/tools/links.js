// @ts-check
// Tools for credentials linked to records (R031-71; core/vault/links.js does the work). Names and addresses only: a link grants nothing and no answer here holds a value.

const PEOPLE = ["cli", "local", "deck", "capsule", "device"];
const str = { type: "string" };
const obj = (/** @type {any} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });

/**
 * @param {{ vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ vault, tool }) {
  tool("vault.link", PEOPLE, "Link a vault item to a client, matter or project by its address, so its uses show on that record. Grants nothing; no value moves.",
    obj({ item: str, to: str }, ["item", "to"]), (input, meta) => vault.links.link(input, meta));
  tool("vault.unlink", PEOPLE, "Take a vault item's link to a record away. The item and the record stay.",
    obj({ item: str, to: str }, ["item", "to"]), (input, meta) => vault.links.unlink(input, meta));
  tool("vault.links", PEOPLE, "The records a vault item is linked to, or the items linked to a record: names and addresses, never a value.",
    obj({ item: str, to: str }), (input, meta) => vault.links.list(input, meta));
  tool("vault.used-by", PEOPLE, "Everything that uses one credential: modules, Connections, agents, sites, apps, Flows and linked records, each with what a new value does to it. Names, never a value.",
    obj({ item: str }, ["item"]), (input, meta) => vault.usedBy ? vault.usedBy.list(input, meta) : Promise.reject(Object.assign(new Error("the Vault is not ready: wait a moment and ask again"), { code: "unavailable" })));
  tool("vault.uses.for", ["module"], "The recent uses of the items linked to one record, newest first, in plain words: which item, when, by whom. Never a value.",
    obj({ urn: str, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["urn"]), (input, meta) => vault.links.usesFor(input, meta));
}
