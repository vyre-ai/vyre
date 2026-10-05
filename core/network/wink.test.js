// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWinkNetwork } from "./wink.js";

/** The network module's context with a fake Wink module behind ctx.call; `asked` records what reached it and as whom. */
function setup(answers = {}) {
  const tools = new Map(), asked = /** @type {any[]} */ ([]);
  const ctx = { tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    call: async (/** @type {string} */ name, /** @type {any} */ input) => { asked.push([name, input]); const a = /** @type {any} */ (answers)[name]; if (!a) return { error: { code: "no_such_tool", message: `no tool ${name}` } }; return { data: typeof a === "function" ? a(input) : a }; } };
  registerWinkNetwork(ctx);
  return { tools, asked, run: (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta) => Promise.resolve().then(() => tools.get(n).run(i, meta)) };
}

test("network.wink: the four public names, each passing to the Wink module's internal tool", async () => {
  const w = setup({ "wink.network.status": { spaces: [] }, "wink.network.whois": i => ({ eid: i.eid }), "wink.network.join": i => ({ joined: true, space: i.space }), "wink.network.leave": i => ({ left: true, space: i.space }) });
  assert.deepEqual([...w.tools.keys()], ["network.wink.status", "network.wink.whois", "network.wink.join", "network.wink.leave"]);
  assert.deepEqual(await w.run("network.wink.status", {}, { caller: "cli" }), { spaces: [] });
  assert.deepEqual(await w.run("network.wink.whois", { eid: "p1" }, { caller: "module:link" }), { eid: "p1" });
  assert.deepEqual(await w.run("network.wink.join", { space: "work" }, { caller: "capsule" }), { joined: true, space: "work" });
  assert.deepEqual(await w.run("network.wink.leave", { space: "work" }, { caller: "deck" }), { left: true, space: "work" });
  assert.deepEqual(w.asked.map(a => a[0]), ["wink.network.status", "wink.network.whois", "wink.network.join", "wink.network.leave"]);
  assert.match(await w.tools.get("network.wink.join").presence.summary({ space: "Work" }), /Work/);
});

test("network.wink: a guest and an anonymous caller read nothing; an agent, a hook and a guest change nothing", async () => {
  const w = setup({ "wink.network.status": {}, "wink.network.join": {} });
  for (const bad of ["guest:a@b.c", "anonymous", ""]) await assert.rejects(w.run("network.wink.status", {}, { caller: bad }), { code: "denied" }, bad);
  for (const bad of ["agent:kit", "cli:agent:kit", "hook", "guest:a@b.c"]) await assert.rejects(w.run("network.wink.join", { space: "x" }, { caller: bad }), { code: "denied" }, bad);
  await assert.rejects(w.run("network.wink.leave", { space: "x" }, { caller: "cli", agent: true }), { code: "denied" });
  assert.equal(w.asked.length, 0, "nothing reached the Wink module");
});

test("network.wink: a box without the Wink module says so plainly, and no description names another product", async () => {
  const w = setup({});
  await assert.rejects(w.run("network.wink.status", {}, { caller: "cli" }), { code: "no_such_tool" });
  for (const d of w.tools.values()) assert.ok(!/tailscale|tailnet/i.test(d.description));
});
