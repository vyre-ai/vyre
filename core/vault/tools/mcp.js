// @ts-check
// Tools for the Vault MCP (core/vault/passmcp.js): make a pass for an outside agent, see the passes, end one. Making one needs the person present; ending one needs no one. No tool returns a stored
// token (it is shown once, when the pass is made), a key or a value.

import { presence } from "./presence.js";
import { mcpLines } from "../passmcp.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** @param {{ internal: (name: string, description: string, input: any, run: Function) => void, vault: import("../vault.js").Vault, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o */
export function register({ vault, tool, internal }) {
  const people = ["cli", "local", "deck", "capsule"];
  tool("vault.mcp.pass.create", [...people, "mobile"], "Share chosen api credentials with an outside agent (Claude Code, Codex) through the Vault MCP: it can have calls made with them and never sees them. Returns the token once, and the line to give the outsider. { name, items, days?, expires?, rate?, budget?, hosts?, reveal? }.",
    obj({ name: str, items: { type: "array", items: str }, days: { type: "number" }, expires: { type: "number" }, rate: { type: "number" }, budget: { type: "number" }, hosts: { type: "array", items: str }, reveal: { type: "boolean" } }, ["name", "items"]),
    async (input, { caller }) => {
      const p = await vault.mcp.create(input, String(caller));
      return { ...p, lines: mcpLines({ url: p.url, token: p.token, name: `vyre-vault-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "pass"}` }) };
    },
    presence("Share credentials with an outside agent", ({ name, items }) => `Let ${String(name).slice(0, 60)}'s agent use ${(Array.isArray(items) ? items : []).slice(0, 6).map(i => String(i).slice(0, 40)).join(", ")} through the Vault, without ever seeing them`));
  tool("vault.mcp.pass.list", [...people, "mobile", "tailnet", "device"], "The passes made for outside agents: who, which credentials, until when, how often they were used. Never a token.", obj({}), () => ({ passes: vault.mcp.list(), reveals: vault.mcp.reveals() }));
  tool("vault.mcp.items", [...people, "mobile"], "The api credentials a pass can share, with the hosts each is pinned to: { items: [{ name, hosts }] }. Names and hosts, never a key.", obj({}), async () => {
    const out = [];
    for (const name of await vault.apiCredentialNames()) out.push({ name, hosts: await vault.apiCredential(name).then(c => c.config.hosts, () => []) });
    return { items: out };
  });
  tool("vault.mcp.pass.revoke", null, "End a pass for an outside agent: its token opens nothing from now on. Needs no one.", obj({ id: str }, ["id"]), (input, { caller }) => vault.mcp.revoke(input.id, String(caller)));
  tool("vault.mcp.reveal.allow", [...people, "mobile"], "Let an outside agent see one value, once: your fresh yes, then its next poll for that ask returns the value a single time and it is gone. Logged as vault.revealed-to-pass, never with the value.",
    obj({ id: str }, ["id"]), ({ id }, { caller }) => vault.mcp.allowReveal(id, String(caller)),
    presence("Show a value to an outside agent, once", ({ id }) => { const r = vault.mcp.reveals().find(x => x.id === id); return r ? `Show ${String(r.item).slice(0, 60)} to ${String(r.pass).slice(0, 60)}'s agent, once` : "Show a value to an outside agent, once"; }));
  tool("vault.mcp.reveal.clear", [...people, "mobile"], "Decline an outside agent's ask to see a value (it was never sent).", obj({ id: str }, ["id"]), ({ id }) => ({ cleared: vault.mcp.clearReveal(id) }));
  // The task credential lease (core/vault/access.js lend): only the flows module, after the person's yes at the Kit install, lends; ending needs the same caller.
  const flowsOnly = (/** @type {string} */ caller, /** @type {string} */ what) => { if (caller !== "module:flows") throw Object.assign(new Error(`only the flows module ${what}`), { code: "denied" }); };
  internal("vault.connections.lend", "A task's doer may use named Connections for that task: { task, agent, connections: [ids], until }. Only the flows module asks, and only for credentials the task's approved Kit version names. Use only; anything outward is still held. Idempotent per task, agent and Connection. { lent, already }.",
    obj({ task: str, agent: str, connections: { type: "array", items: str }, until: { type: "number" } }, ["task", "agent", "connections", "until"]),
    (input, { caller }) => { flowsOnly(String(caller), "lends a Connection to a task"); return vault.access.leaseTask(input); });
  internal("vault.connections.end", "A task is over: take back every Connection lent for it: { task, reason? }. Only the flows module asks. { ended }.",
    obj({ task: str, reason: str }, ["task"]),
    (input, { caller }) => { flowsOnly(String(caller), "ends a task's leases"); return vault.access.leaseEnd(input); });
  // What the public gate (core/wink) asks: is the endpoint listening, and where it is reachable from outside once the gate has an address.
  internal("vault.mcp.status", "Whether the Vault MCP endpoint is listening on loopback, and its port: { listening, port }. Only the wink module (the public gate) asks.", obj({}), (_i, { caller }) => {
    if (caller !== "module:wink") throw Object.assign(new Error("only the public gate asks where the Vault MCP listens"), { code: "denied" });
    return vault.mcp.listening();
  });
  internal("vault.mcp.base", "The public address the gate serves this box on, or null: { base }. Only the wink module sets it; passes made afterwards name it.", obj({ base: { type: ["string", "null"] } }), ({ base }, { caller }) => {
    if (caller !== "module:wink") throw Object.assign(new Error("only the public gate sets the public address"), { code: "denied" });
    vault.mcp.publicBase = typeof base === "string" && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) ? base : null;
    return { ok: true };
  });
}
