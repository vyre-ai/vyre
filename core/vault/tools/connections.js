// @ts-check
// connections tools (ADR 0028, decision 9b): list, get, grant, revoke, update and sync for
// people's surfaces; register, unregister and allowed for modules. The work is in
// ../connections.js.
//
// Who may call, and why: giving a surface access (grant) and changing what a connection says it
// can do (update) need a person; taking access away (revoke) never does. Claude (mcp) may list
// and read what its own surface may use, never change it. Only a module registers, and only rows
// of its own source; only a module asks allowed, for the caller it acts for. No tool returns a
// value or the name of a field that holds one.

import { Connections } from "../connections.js";
import { presence } from "./presence.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const strs = { type: "array", items: str };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ ctx, vault, tool }) {
  const c = new Connections(vault, {
    call: ctx.call ? (name, input) => ctx.call(name, input) : undefined,
    modules: () => (ctx.modules && typeof ctx.modules.list === "function" ? ctx.modules.list() : []),
    log: m => ctx.log(m),
  });

  tool("vault.connections.list", [...PEOPLE, "mobile", "mcp", "tailnet", "module"], "Connections the caller's surface may use: {surface, connections: [{id, source, ref, provider, account, auth, label, capabilities, state, needs?, uses, use?}]}. `uses` maps each capability to the {tool, input} that acts on it; with `capability`, `use` is that one. A person sees every row with its surfaces and may pass `surface` to see one surface's view; a module must pass `surface` or `caller` (the caller it acts for). Never a value.",
    obj({ capability: str, surface: str, caller: str }), (input, { caller }) => c.list(input, caller));

  tool("vault.connections.get", [...PEOPLE, "mobile", "mcp", "tailnet", "module"], "One connection, as vault.connections.list shows it, if the caller's surface may use it.",
    obj({ id: str }, ["id"]), (input, { caller }) => c.get(input, caller));

  tool("vault.connections.grant", PEOPLE, "Let a surface (capsule, chat, agents or phone) use a connection.",
    obj({ id: str, surface: str }, ["id", "surface"]), (input, { caller }) => c.grant(input, caller),
    presence("Let a surface use a connection", input => c.summary(input)));

  tool("vault.connections.revoke", [...PEOPLE, "mcp"], "Take a surface's use of a connection away. Needs no one: taking access away is always allowed.",
    obj({ id: str, surface: str }, ["id", "surface"]), (input, { caller }) => c.revoke(input, caller));

  tool("vault.connections.update", PEOPLE, "Rename a connection or set its capabilities. The change survives every resync.",
    obj({ id: str, label: str, capabilities: strs }, ["id"]), (input, { caller }) => c.update(input, caller),
    presence("Change a connection", input => c.summary({ id: input.id })));

  tool("vault.connections.sync", PEOPLE, "Resync now: the vault's own items with a catalog provider, google.accounts, and mcp.servers with their cached tools. It happens on its own on each source's events.",
    obj({}), () => c.resync());

  tool("vault.connections.register", ["module"], "A module registers one of its connections, or refreshes it: {ref, provider, account, auth, label?, capabilities? or tools?, items?, use?}. The source is the module's own name. Returns {id}, stable across calls.",
    obj({ ref: str, provider: str, account: str, auth: str, label: str, capabilities: strs, tools: strs, items: strs, use: { type: "object" } }, ["ref", "provider", "account", "auth"]),
    (input, { caller }) => c.register(input, caller));

  tool("vault.connections.unregister", ["module"], "A module removes one of its own connections.",
    obj({ ref: str }, ["ref"]), (input, { caller }) => c.unregister(input, caller));

  tool("vault.connections.allowed", ["module"], "May `caller` use this connection ({id}, or {source, ref})? {allowed, surface, reason?}. People are always allowed. Ask before acting on a connection.",
    obj({ id: str, source: str, ref: str, caller: str }, ["caller"]), input => c.allowed(input));

  // Each synced source follows its own events; nothing polls. A google or mcp row can claim a
  // vault item, so the vault's rows follow those too.
  const on = (types, sources) => types.map(type => ctx.events.on(type, () => { c.resync(sources).catch(() => {}); }));
  const offs = [
    ...on(["vault.connected", "vault.item-added", "vault.item-changed", "vault.item-deleted"], ["vault"]),
    ...on(["google.added", "google.removed", "google.connected"], ["google", "vault"]),
    ...on(["mcp.added", "mcp.updated", "mcp.removed", "mcp.refreshed"], ["mcp", "vault"]),
  ];
  return { connections: c, stop: () => { for (const off of offs) off(); return c.chain; } };
}
