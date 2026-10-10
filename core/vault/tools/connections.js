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
import { personCall } from "../person.js";
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
  const isPerson = personCall(ctx);
  // A device over the tailnet or relay is the person's surface for connections only when the kernel's chain says person AND the call carries a signed-in person session (as before: a device with no session is no surface).
  const isSignedInPerson = async meta => Boolean(meta && meta.person) && await isPerson(meta);
  const c = new Connections(vault, {
    call: ctx.call ? (name, input) => ctx.call(name, input) : undefined,
    modules: () => (ctx.modules && typeof ctx.modules.status === "function" ? ctx.modules.status() : []),
    log: m => ctx.log(m),
    kernel: ctx.kernel,
  });

  tool("vault.connections.list", [...PEOPLE, "mobile", "mcp", "tailnet", "device", "space", "agent", "module"], "Connections the caller's surface may use, each with the {tool, input} that acts on a capability. Never a value.",
    obj({ capability: { type: "string", description: "narrow to one capability; use is then that one, and suggest_default is true the first time it has two or more ready connections and no default" }, surface: { type: "string", description: "a person may pass one to see that surface's view; a module must pass surface or caller" }, caller: { type: "string", description: "the caller a module acts for" } }), async (input, meta) => c.list(input, meta.caller, await isSignedInPerson(meta)));

  tool("vault.connections.get", ["module"], "One connection's metadata, for the module that acts on it: a row of its own source, or one whose uses name one of its tools. Anything else is not_found. Never a value.",
    obj({ id: str }, ["id"]), (input, { caller }) => c.get(input, caller));

  tool("vault.connections.grant", PEOPLE, "Let a surface (capsule, chat, agents or phone) use a connection. Granting agents asks for presence (Touch ID or a passkey): it hands a credential to an autonomous session. Capsule, chat and phone are one tap.",
    obj({ id: str, surface: str }, ["id", "surface"]), (input, meta) => c.grant(input, meta.caller, meta),
    presence("Let a surface use a connection", input => c.summary(input), { when: input => input.surface === "agents" }));

  tool("vault.connections.revoke", [...PEOPLE, "mcp"], "Take a surface's use of a connection away. Needs no one: taking access away is always allowed, but only of the caller's own surface.",
    obj({ id: str, surface: str }, ["id", "surface"]), async (input, meta) => c.revoke(input, meta.caller, await isSignedInPerson(meta), meta));

  tool("vault.connections.update", PEOPLE, "Rename a connection or set its capabilities (both survive every resync), or make it the default for some capabilities (`default_for`; one default per capability, so this clears it elsewhere). A default changes no access and needs no proof of presence.",
    obj({ id: str, label: str, capabilities: strs, default_for: strs }, ["id"]), (input, { caller }) => c.update(input, caller),
    presence("Change a connection", input => c.summary({ id: input.id }), { when: input => input.label !== undefined || input.capabilities !== undefined }));

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
