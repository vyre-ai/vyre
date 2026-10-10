// @ts-check
// vault.agent.fill and the person's view of what a # tag has lent (ADR 0028, decision 3; R031-93). The filler itself is core/vault/agent-fill.js.
// No tool here returns a value or a username: the fill returns the names of the fields it set, the origin and whether the page moved on.

import { callerKind, agentClaim } from "../../modules/index.js";
import { agentFill } from "../agent-fill.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault, said: import("../said.js").SaidIntents,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ ctx, vault, said, tool }) {
  tool("vault.agent.fill", ["mcp", "harness", "module"], "Sign in on your own computer with a login lent to you; you never see it. Answers which fields were filled and the origin.",
    obj({ item: str, origin: str, agent: str, thread: str, lineage: { type: "array", items: str } }, ["item"]), async (input, meta = {}) => {
      const kind = callerKind(meta.caller);
      let agent, thread, lineage;
      if (kind === "module") {
        // Only Vyre Computer signs an agent in for it, and it names the agent and conversation the registry vouched for on the model's own call.
        if (String(meta.caller) !== "module:computer") throw Object.assign(new Error("only Vyre Computer signs an agent in for it"), { code: "denied" });
        agent = String(input.agent || ""); thread = input.thread; lineage = input.lineage;
      } else {
        agent = agentClaim(String(meta.caller || ""));
        thread = /** @type {any} */ (meta).thread; lineage = /** @type {any} */ (meta).lineage;
      }
      if (!agent || agent === "(unnamed)") throw Object.assign(new Error("a session that names no agent has no computer to sign in on"), { code: "denied" });
      return agentFill({ vault, said, call: (n, i) => ctx.call(n, i), log: ctx.log }, { agent, item: input.item, origin: input.origin, thread, lineage });
    });

  // The person sees where a tag has lent a login, and takes it back at once. Names and hosts only.
  tool("vault.tagged", ["cli", "local", "deck", "capsule", "tailnet", "device"], "Conversations a # tag has lent a login to: { tags: [{ id, item, thread, hosts, since, lastUsed }] }. Never a value.",
    obj({ item: str }), ({ item }) => ({ tags: said.rows().map(r => ({ id: r.id, kind: r.kind, item: JSON.parse(r.recipients || "[]")[0] || null, thread: r.thread, hosts: (JSON.parse(r.limits || "null") || {}).hosts || [], since: Number(r.at), lastUsed: r.used ? Number(r.used) : null }))
      .filter(t => t.kind === "use" && (!item || t.item === item)).map(({ kind, ...t }) => t) }));

  tool("vault.untag", ["cli", "local", "deck", "capsule", "tailnet", "device"], "Take a login back from a conversation a # tag lent it to. Needs no proof: taking access away is always allowed.",
    obj({ id: str }, ["id"]), ({ id }, { caller }) => said.revoke({ id }, String(caller)));
}
