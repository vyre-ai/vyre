// @ts-check
// A model (an assistant, a named agent, a thread or agent session) learns of an owner's vault item only if it holds a grant on it: vault.item answers the same "no item named" for an ungranted name as for
// one that does not exist, and a granted item still answers. A person's own call is unchanged. A model's grant requests are capped. A real daemon in both presence modes; the owner is the Space owner.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const SECRET = "S3cr3t-owner-value-Zq81vXr2";

for (const mode of ["stub-presence", "real-presence"]) {
  test(`vault.item for a model (${mode})`, { timeout: 200_000 }, async t => {
    const root = fs.realpathSync(tempHome(t));
    fs.writeFileSync(root + "/config.json", JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
    const d = await start({ root, ...(mode === "stub-presence" ? { presence: present } : {}), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
    t.after(() => d.stop());
    const owner = d.kernel.id.owner, space = d.kernel.id.space;
    const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
    const ownerTok = async () => ({ token: (await d.kernel.surfaces.open(chainOf(owner), {})).token });
    for (const n of ["owner-secret", "granted-one"]) assert.ok(!(await d.registry.call("vault.put", { name: n, kind: "secret", fields: { value: SECRET } }, "cli", await ownerTok())).error, n);
    const agent = (/** @type {string} */ name) => ({ kernelFacts: { kind: "agent_session", vouched: true, person: owner, agent: name, session: "s-" + name }, agent: name, agentKind: name === "assistant" ? "assistant" : "agent" });
    const missing = (await d.registry.call("vault.item", { name: "no-such-item" }, "mcp:agent:kit", agent("kit"))).error;
    assert.ok(missing, "a name that does not exist is an error");
    for (const [who, caller] of [["the owner's assistant", "mcp:agent:assistant"], ["a named agent", "mcp:agent:kit"], ["a thread's session", "mcp:thread:t1"], ["a harness-labelled named agent", "harness:agent:kit"], ["a harness-labelled thread (the session's own vyre CLI)", "harness:thread:t1"], ["a plain mcp session", "mcp"], ["an agent label on a person surface", "cli:agent:kit"]]) {
      const name = caller.endsWith("assistant") ? "assistant" : "kit";
      const r = await d.registry.call("vault.item", { name: "owner-secret" }, caller, agent(name));
      assert.ok(r.error, `${who}: an ungranted name answers an error, not metadata: ${JSON.stringify(r.data)}`);
      assert.equal(r.error.message.replace("owner-secret", "X"), missing.message.replace("no-such-item", "X"), `${who}: the same words as for a name that does not exist`);
      assert.ok(!JSON.stringify(r).includes("hosts") && !JSON.stringify(r).includes("fields"), `${who}: nothing about the item`);
      // vault.list agrees: the same caller sees none of the owner's ungranted items
      const l = await d.registry.call("vault.list", {}, caller, agent(name));
      assert.ok(!JSON.stringify(l.data || l.error).includes("owner-secret"), `${who}: vault.list names no ungranted item`);
    }
    // the person's own call is unchanged
    const p = await d.registry.call("vault.item", { name: "owner-secret" }, "cli", await ownerTok());
    assert.ok(!p.error && p.data.item.name === "owner-secret", "the owner still reads their own item's metadata");
    // a granted item still answers: the kernel grant a person made (vault.read on the item's address)
    const vid = await /** @type {any} */ (d.kernel).grants.personalVault();
    const uid = String((await d.registry.call("agents.uid", { name: "kit" }, "module:projects")).data?.uid || "");
    if (uid) {
      await d.kernel.gateway.grants.addActor(chainOf(owner), { kind: "agent", id: uid, space }, { presence: { method: "stand-in" } }).catch(() => {});
      await d.kernel.gateway.grants.create(chainOf(owner), { subject: { kind: "actor", actor: { kind: "agent", id: uid, space } }, actions: ["vault.read", "vault.call"], resource: { prefix: `vyre://${space}/vault/${vid}/item/granted-one` }, conditions: {}, source: "vault:share" }, { presence: { method: "stand-in" } });
      const g = await d.registry.call("vault.item", { name: "granted-one" }, "mcp:agent:kit", agent("kit"));
      assert.ok(!g.error && g.data.item.name === "granted-one", `a granted item still answers: ${JSON.stringify(g.error || g.data)}`);
      assert.ok((await d.registry.call("vault.item", { name: "owner-secret" }, "mcp:agent:kit", agent("kit"))).error, "and the ungranted one still does not");
    }
    // grant requests: a model files a few, then no more
    // counted per agent identity: kit's requests from an mcp label and an agent label on a person surface are one agent's, so five in all, not five per label or per thread
    let last;
    const askers = ["mcp:agent:kit", "mcp:agent:kit", "cli:agent:kit", "mcp:agent:kit", "cli:agent:kit", "cli:agent:kit"];
    for (let i = 0; i < askers.length; i++) last = await d.registry.call("vault.grant", { name: `owner-secret`, module: `mod${i}` }, askers[i], agent("kit"));
    assert.ok(last.error, "the sixth request from one agent, across labels, is refused");
    const other = await d.registry.call("vault.grant", { name: "owner-secret", module: "modother" }, "mcp:agent:juno", agent("juno"));
    assert.ok(!other.error, "another agent's requests are counted on their own");
    assert.match(last.error.message, /owner has not answered.*5 are waiting.*vault\.pending/);
    const waiting = (await d.registry.call("vault.pending", {}, "cli", await ownerTok())).data.grants || [];
    assert.equal(waiting.filter(g => /kit$/.test(String(g.by))).length, 5, "five of kit's wait for the owner");
    // the card the owner sees says who asked, in words
    const { fromVault } = await import("../core/approvals/items.js");
    const card = fromVault({ grants: waiting })[0];
    assert.match(card.title, /^Let mod\d use "owner-secret"$/);
    assert.ok(waiting.some(g => g.by === "cli:agent:kit") && waiting.some(g => g.by === "mcp:agent:kit"), "both labels of one agent are among the five");
    assert.match(card.detail, /asked by the agent kit, not by you/);
  });
}
