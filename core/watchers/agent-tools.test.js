// @ts-check
// An agent sets up its own Watchers and Routines only from the person's own words, and manages only its own: watchers.write and watchers.routine.create are
// reach "asked" (no intent in the chat, not_asked), the owner is set by Vyre from the verified call, another agent can neither see nor manage it, a person's pause
// holds against the agent, and the watcher webhook door is retired. A real vyred in a temp home, with the real registry and vault; nothing is run in a sandbox here.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

const SPEC = { schedule: "*/15 * * * *", summary: { when: "Every 15 minutes", check: "Is it an invoice from Northwind?", do: "Tells you here" }, owner: { kind: "agent", agent: "kit" }, act: false };
const CODE = "export default async function watch({ emit }) { emit({ id: 'x', title: 'Invoice 42' }); }\n";

test("an agent's own Watcher and Routine: made only from the person's words, owned by the agent that made them, managed by it and the person only", { timeout: 120_000 }, async t => {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  daemon = await start({ root, presence: present, log: () => {} });
  const reg = daemon.registry;
  const as = (/** @type {string} */ agent, thread = "t-1") => (/** @type {string} */ tool, /** @type {any} */ input) => reg.call(tool, input, `mcp:agent:${agent}`, { thread, agent });
  const scout = as("scout"), kit = as("kit", "t-9");
  const said = (/** @type {string} */ tool, thread = "t-1") => reg.call("vault.said.record", { thread, said: `s-${Math.random()}`, kind: "act_out", channel: "watchers", to: [tool], what: "set up for itself" }, "module:sessions");

  // no words, no watcher
  assert.equal((await scout("watchers.write", { name: "northwind-invoices", spec: SPEC, code: CODE })).error?.code, "not_asked");
  assert.equal(fs.existsSync(path.join(root, "watchers", "northwind-invoices")), false);
  // the person's words in scout's chat: the agent in another chat cannot use them
  assert.ok((await said("watchers.write")).data, "recorded");
  assert.equal((await as("scout", "t-2")("watchers.write", { name: "northwind-invoices", spec: SPEC, code: CODE })).error?.code, "not_asked", "another chat");
  const made = await scout("watchers.write", { name: "northwind-invoices", spec: SPEC, code: CODE });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.deepEqual([made.data.state, made.data.waiting, made.data.problems], ["paused", true, undefined]);
  const json = JSON.parse(fs.readFileSync(path.join(root, "watchers", "northwind-invoices", "watcher.json"), "utf8"));
  assert.deepEqual([json.owner.kind, json.owner.agent, json.owner.thread], ["agent", "scout", "t-1"], "the owner is the calling agent and its chat, never what the agent wrote");
  assert.match(String(json.owner.person), /^per_/, "and the person the call is for (here the Space's owner, read from the call's chain)");
  assert.equal(json.act, undefined, "what only Vyre may say is dropped");
  assert.equal((await scout("watchers.write", { name: "another-one", spec: SPEC, code: CODE })).error?.code, "not_asked", "one ask, one watcher");

  // the agent sees its own, another agent does not, and cannot touch it
  const mine = (await scout("watchers.list", { agent: "scout" })).data.watchers.map((/** @type {any} */ w) => [w.name, w.agent, w.state, w.waiting]);
  assert.deepEqual(mine, [["northwind-invoices", "scout", "paused", true]]);
  assert.deepEqual((await kit("watchers.list", {})).data.watchers.map((/** @type {any} */ w) => w.name), []);
  for (const tool of ["watchers.own.delete", "watchers.own.run", "watchers.own.resume"]) assert.ok((await kit(tool, { name: "northwind-invoices" })).error, `${tool} for kit`);
  assert.equal((await kit("watchers.own.delete", { name: "northwind-invoices" })).error.code, "denied");
  assert.equal((await kit("watchers.revise", { name: "northwind-invoices", spec: SPEC, code: CODE })).error.code, "denied");
  assert.equal((await reg.call("watchers.own.delete", { name: "northwind-invoices" }, "cli")).error.code, "denied", "watchers.own.* is the agent's; a person uses watchers.delete");
  // still waiting for its test: its agent may fix it without a new ask, but not turn it on by hand
  assert.equal((await scout("watchers.revise", { name: "northwind-invoices", spec: SPEC, code: CODE + "// fixed\n" })).error, undefined);
  assert.match((await scout("watchers.own.resume", { name: "northwind-invoices" })).error.message, /turns on when watchers\.test passes/);
  // a person's pause holds against the agent
  assert.equal((await reg.call("watchers.pause", { name: "northwind-invoices" }, "cli")).error, undefined);
  assert.match((await scout("watchers.own.resume", { name: "northwind-invoices" })).error.message, /a person paused northwind-invoices; only they resume it/);
  // and the agent deletes its own
  assert.equal((await scout("watchers.own.delete", { name: "northwind-invoices" })).error, undefined);
  assert.equal(fs.existsSync(path.join(root, "watchers", "northwind-invoices")), false, "its folder goes with it");

  // a Routine: the same rule, Vyre's own code, on at once
  const routine = { name: "morning-inbox", when: "weekdays 09:00", instructions: "Check my inbox and tell me what needs me" };
  assert.equal((await scout("watchers.routine.create", routine)).error?.code, "not_asked");
  await said("watchers.routine.create");
  const r = await scout("watchers.routine.create", routine);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.state, "on"); assert.ok(r.data.next); assert.equal(r.data.card.kind, "routine");
  assert.equal(fs.readFileSync(path.join(root, "watchers", "morning-inbox", "watch.js"), "utf8").startsWith("// An agent's Routine."), true, "the code is Vyre's template");
  assert.equal((await kit("watchers.own.run", { name: "morning-inbox" })).error.code, "denied", "another agent cannot run it");
  assert.equal((await kit("watchers.pause", { name: "morning-inbox" })).error.code, "not_found", "nor even see it");
  assert.equal((await scout("watchers.pause", { name: "morning-inbox" })).error, undefined);
  assert.equal((await scout("watchers.own.resume", { name: "morning-inbox" })).error, undefined, "its own pause it may undo");
  assert.equal((await reg.call("watchers.list", { agent: "scout" }, "cli")).data.watchers[0].kind, "routine", "the person's list shows it");

  // the retired door
  const hook = await reg.call("watchers.hook", { name: "morning-inbox", token: "x", body: {} }, "hook");
  assert.match(hook.error.message, /watcher webhooks are retired: a webhook starts a Flow/);
});
