// @ts-check
// history tools: an item's versions (names of changed fields, never values) and reverting to
// one. Reading an old version's value is `version` on vault.reveal and vault.copy.

import { presence, quoted } from "./presence.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ vault, tool }) {
  tool("vault.history", null, "An item's last versions: when, by whom, and which fields changed. `field` narrows it (password history). Never a value.",
    obj({ name: str, field: str }, ["name"]), input => vault.history(input));

  tool("vault.revert", ["cli", "local", "deck", "capsule"], "Put an older version of an item back, as a new version.",
    obj({ name: str, version: { type: "integer" } }, ["name", "version"]),
    (input, { caller }) => vault.revert(input, caller),
    presence("Revert a vault item to an older version", ({ name, version }) => `Put version ${Number(version)} of ${quoted(name)} back`));
}
