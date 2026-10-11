// @ts-check
// Measurement: what an owner's vault answers to a MEMBER, a member's assistant and a named agent, for every kind of vault call. A real daemon with an owner and a member. Prints one ROW per call.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import fs from "node:fs";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const BOB = "per_" + "b".repeat(26);
const SECRET = "S3cr3t-owner-value-Zq81vXr2";
const PASS = "tangerine-orbit-7Q-harbor";

for (const mode of ["stub-presence", "real-presence"]) {
  test(`vault matrix (${mode})`, { timeout: 280_000 }, async t => {
    const root = fs.realpathSync(tempHome(t));
    fs.writeFileSync(root + "/config.json", JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
    const d = await start({ root, ...(mode === "stub-presence" ? { presence: present } : {}), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
    t.after(() => d.stop());
    const owner = d.kernel.id.owner;
    const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
    await d.kernel.gateway.grants.setRole(chainOf(owner), { person: BOB, role: "member" }, { presence: { method: "stand-in" } });
    // the owner's secrets, put directly in the vault (the owner's way)
    const vault = /** @type {any} */ (d.registry.deps).vault || null;
    const put = async (/** @type {string} */ name) => d.registry.call("vault.put", { name, kind: "secret", fields: { value: SECRET } }, "cli", { token: (await d.kernel.surfaces.open(chainOf(owner), {})).token });
    const ownerPut = await put("owner-secret"); await put("owner-del"); await put("owner-over");
    console.log("SETUP owner put via module:", JSON.stringify(ownerPut.error || ownerPut.data));
    const tok = async (/** @type {string} */ person, /** @type {string} */ agent) => {
      const facts = agent ? { kind: "agent_session", vouched: true, person, agent, session: "s-" + agent } : null;
      if (facts) return { kernelFacts: facts, ...(agent ? { agent, agentKind: agent === "assistant" ? "assistant" : "agent" } : {}) };
      return { token: (await d.kernel.surfaces.open(chainOf(person), {})).token };
    };
    const actors = /** @type {[string, string, () => Promise<any>][]} */ ([
      ["member", "cli", () => tok(BOB, "")],
      ["member's assistant", "mcp:agent:assistant", () => tok(BOB, "assistant")],
      ["named agent", "mcp:agent:kit", () => tok(BOB, "kit")],
    ]);
    const CALLS = /** @type {[string, any][]} */ ([
      ["vault.list", {}], ["vault.search", { q: "owner" }], ["vault.items.names", {}], ["vault.item", { name: "owner-secret" }], ["vault.reveal", { name: "owner-secret" }], ["vault.copy", { name: "owner-secret" }],
      ["vault.inject", { name: "owner-secret", env: "X" }], ["vault.resolve", { text: "{{vault:owner-secret}}" }], ["vault.render", { text: "{{vault:owner-secret}}" }], ["vault.history", { name: "owner-secret" }],
      ["vault.put (new name)", { _t: "vault.put", name: "member-new", kind: "secret", fields: { value: "member-value-123456" } }],
      ["vault.put (owner's name: overwrite)", { _t: "vault.put", name: "owner-over", kind: "secret", fields: { value: "overwritten-by-member" } }],
      ["vault.delete (owner's item)", { _t: "vault.delete", name: "owner-del" }],
      ["vault.grant (owner's item to a module)", { _t: "vault.grant", name: "owner-secret", module: "threads" }],
      ["vault.pass.create (share owner's item)", { _t: "vault.pass.create", items: ["owner-secret"], mode: "use" }], ["vault.pass.list", {}], ["vault.people", {}],
      ["vault.vaults.list", {}], ["vault.vaults.create", { name: "bobs" }], ["vault.connections.list", {}], ["vault.agent.grants", {}], ["vault.audit", {}], ["vault.uses", {}], ["vault.state", {}], ["vault.devices", {}],
      ["vault.import", { text: "IMPORTED=import-value-1234567", format: "env" }], ["vault.backup", { passphrase: PASS }], ["vault.lock", {}],
    ]);
    for (const [who, caller, mk] of actors) {
      for (const [label, input0] of CALLS) {
        const { _t, ...input } = input0;
        const tool = _t || label;
        let out;
        try { const r = await d.registry.call(tool, input, caller, await mk()); out = r.error ? `REFUSED ${r.error.code}: ${String(r.error.message).slice(0, 110)}` : `ALLOWED ${JSON.stringify(r.data).slice(0, 90)}`; const j = JSON.stringify(r.data || r.error || {}); if (j.includes(SECRET)) out += "  <<VALUE LEAKED>>"; else if (/owner-secret|owner-del|owner-over/.test(j)) out += "  <<names seen>>"; }
        catch (e) { out = `THREW ${String(/** @type {Error} */ (e).message).slice(0, 100)}`; }
        console.log(`ROW|${mode}|${who}|${label}|${out}`);
      }
    }
    // what is left of the owner's items
    const left = await d.registry.call("vault.list", {}, "module:vyred", {});
    console.log("AFTER owner vault.list:", JSON.stringify((left.data && left.data.items || []).map((/** @type {any} */ i) => i.name)));
  });
}
