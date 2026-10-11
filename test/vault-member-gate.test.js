// @ts-check
// The vault is the owner's: a MEMBER, a member's assistant and a named agent of theirs are refused by every vault tool, in both presence modes; the owner's own calls are unchanged; every tool the vault
// registers is gated or on the allow-list. A real daemon with an owner and a member. (This was a measurement that found a member could read, overwrite, delete and lock the owner's vault.)
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { MEMBER_ALLOWED, MEMBER_REFUSAL, GATED } from "../core/vault/member-gate.js";
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
    // the calls a member must see refused AT the gate (their inputs are valid, so nothing but the gate can answer)
    const AT_GATE = new Set(["vault.list", "vault.search", "vault.items.names", "vault.item", "vault.reveal", "vault.history", "vault.put (new name)", "vault.put (owner's name: overwrite)", "vault.delete (owner's item)",
      "vault.grant (owner's item to a module)", "vault.pass.list", "vault.people", "vault.vaults.list", "vault.vaults.create", "vault.connections.list", "vault.agent.grants", "vault.audit", "vault.uses", "vault.state", "vault.devices", "vault.lock"]);
    for (const [who, caller, mk] of actors) {
      for (const [label, input0] of CALLS) {
        const { _t, ...input } = input0;
        const tool = _t || label;
        const r = await d.registry.call(tool, input, caller, await mk());
        const j = JSON.stringify(r.data || r.error || {});
        assert.ok(r.error, `${mode} ${who} ${label}: answered ${j.slice(0, 120)}`);
        assert.ok(!j.includes(SECRET), `${mode} ${who} ${label}: leaked the value`);
        // under the real Presence the registry's floor asks the owner's yes first for some tools; that asks, it never answers, and the gate stands behind it (the stub mode, where the yes is given, reaches the gate)
        if (mode === "real-presence" && r.error.code === "presence_required") continue;
        if (AT_GATE.has(label)) { assert.equal(r.error.code, "denied", `${mode} ${who} ${label}: ${j.slice(0, 120)}`); assert.equal(r.error.message.includes("owner's vault") || /not available to mcp callers/.test(r.error.message), true, `${mode} ${who} ${label}: ${r.error.message}`); }
        else assert.ok(!/owner-secret|owner-del|owner-over/.test(j), `${mode} ${who} ${label}: names the owner's items: ${j.slice(0, 120)}`);
      }
    }
    // nothing changed: the owner's three items are there, none of the member's was made, the owner can still use the vault
    const ownerTok = async () => ({ token: (await d.kernel.surfaces.open(chainOf(owner), {})).token });
    const names = ((await d.registry.call("vault.list", {}, "cli", await ownerTok())).data.items || []).map((/** @type {any} */ i) => i.name).sort();
    assert.deepEqual(names, ["owner-del", "owner-over", "owner-secret"], `${mode}: the owner's vault is as the owner left it`);
    assert.equal((await d.registry.call("vault.state", {}, "cli", await ownerTok())).data.locked, false, "and it is not locked");
    if (mode === "stub-presence") assert.equal((await d.registry.call("vault.reveal", { name: "owner-secret" }, "cli", await ownerTok())).data.value, SECRET, "the owner still reads their own secret");
    // the owner's own assistant and agent: today's behaviour (measured, not changed here)
    const oa = { kernelFacts: { kind: "agent_session", vouched: true, person: owner, agent: "assistant", session: "s-oa" }, agent: "assistant", agentKind: "assistant" };
    const ownerAssistant = await d.registry.call("vault.item", { name: "owner-secret" }, "mcp:agent:assistant", oa);
    assert.ok(!ownerAssistant.error, `${mode}: the owner's assistant keeps today's vault.item: ${JSON.stringify(ownerAssistant.error)}`);
    const ownerGrant = await d.registry.call("vault.grant", { name: "owner-secret", module: "threads" }, "mcp:agent:assistant", oa);
    console.log(`FINDING|${mode}|owner's assistant vault.grant of an owner item to a module: ${ownerGrant.error ? "REFUSED " + ownerGrant.error.code + ": " + ownerGrant.error.message : "ALLOWED " + JSON.stringify(ownerGrant.data).slice(0, 100)}`);
    // every tool the vault registers is gated or on the allow-list: a new one is refused for members by default
    const registered = [...d.registry.tools.entries()].filter(([, e]) => e.module === "vault");
    assert.ok(registered.length > 50, "the vault's tools were found");
    const loose = registered.filter(([n, e]) => !GATED.has(n) && !MEMBER_ALLOWED.has(n)).map(([n]) => n);
    assert.deepEqual(loose, [], "every vault tool is behind the owner gate or is on the allow-list by name");
    assert.ok(MEMBER_REFUSAL.length > 0);
  });
}
