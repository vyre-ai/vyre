// @ts-check
// vault.connection.may: the first gate for a person's connection in the MCP hub. The hub asks whether the verified caller of this very turn holds the connection's item, at read (see it, run its read tools)
// or call (run an outward tool, still held at the Gate). The kernel decides: the caller's own chain, never one the input names, authorized on the item's address. The answer is allow or not, nothing else.

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** @param {{ vault: import("../vault.js").Vault, internal: (name: string, description: string, input: any, run: Function) => void }} d */
export function register({ vault, internal }) {
  internal("vault.connection.may", "Whether the caller of this turn holds a person's connection at a level: { owner?, connection, level: read | call, as? } answers { allow }; with `as` it asks about that person (the requester of a held item), not the caller. Only the MCP hub asks, and the caller is read from the kernel, never from the input.",
    obj({ owner: str, connection: str, level: { type: "string", enum: ["read", "call", "own"] }, as: str }, ["connection", "level"]),
    async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (String(meta && meta.caller) !== "module:mcp") throw Object.assign(new Error("only the MCP hub asks whether a connection may be used"), { code: "denied" });
      return { allow: await /** @type {any} */ (vault).access.mayUseConnection(input, meta) };
    });
}
