// @ts-check
// Tools for the Vault MCP (core/vault/passmcp.js): make a pass for an outside agent, see the passes, end one. Making one needs the person present; ending one needs no one. No tool returns a stored
// token (it is shown once, when the pass is made), a key or a value.

import { presence } from "./presence.js";
import { mcpLines } from "../passmcp.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** @param {{ vault: import("../vault.js").Vault, tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o */
export function register({ vault, tool }) {
  const people = ["cli", "local", "deck", "capsule"];
  tool("vault.mcp.pass.create", [...people, "mobile"], "Share chosen api credentials with an outside agent (Claude Code, Codex) through the Vault MCP: it can have calls made with them and never sees them. Returns the token once, and the line to give the outsider. { name, items, days?, expires?, rate?, budget?, hosts?, reveal? }.",
    obj({ name: str, items: { type: "array", items: str }, days: { type: "number" }, expires: { type: "number" }, rate: { type: "number" }, budget: { type: "number" }, hosts: { type: "array", items: str }, reveal: { type: "boolean" } }, ["name", "items"]),
    async (input, { caller }) => {
      const p = await vault.mcp.create(input, String(caller));
      return { ...p, lines: mcpLines({ url: p.url, token: p.token, name: `vyre-vault-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "pass"}` }) };
    },
    presence("Share credentials with an outside agent", ({ name, items }) => `Let ${String(name).slice(0, 60)}'s agent use ${(Array.isArray(items) ? items : []).slice(0, 6).map(i => String(i).slice(0, 40)).join(", ")} through the Vault, without ever seeing them`));
  tool("vault.mcp.pass.list", [...people, "mobile", "tailnet", "device"], "The passes made for outside agents: who, which credentials, until when, how often they were used. Never a token.", obj({}), () => ({ passes: vault.mcp.list(), reveals: vault.mcp.reveals() }));
  tool("vault.mcp.pass.revoke", null, "End a pass for an outside agent: its token opens nothing from now on. Needs no one.", obj({ id: str }, ["id"]), (input, { caller }) => vault.mcp.revoke(input.id, String(caller)));
  tool("vault.mcp.reveal.clear", [...people, "mobile"], "Turn down an outside agent's ask to see a value (it was never sent).", obj({ id: str }, ["id"]), ({ id }) => ({ cleared: vault.mcp.clearReveal(id) }));
}
