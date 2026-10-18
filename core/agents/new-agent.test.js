// @ts-check
// agents: a NEW agent by proposal. The Engineer proposes flows.propose { what: "agent.new", input }; the agents module keeps the whole agents.create input as a draft, and an owner's or an admin's yes makes
// the agent through the same path as agents.create, as the one who said yes. Only the draft's id and hash travel on the card. Temp home only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

async function boot(/** @type {any} */ t, kernel = false) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {}, ...(kernel ? { kernel: true } : {}) });
  t.after(() => d.stop());
  return { d, c: (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {string} */ as = "local") => d.registry.call(tool, input, as) };
}
const NEW = { name: "scout", instructions: "Find three photographers.", projects: [], skills: ["research"], effort: "high", look: "s2~c4~e1~m2~t3~b1~h5", auth: { vault: "claude-setup-token", fallback: "anthropic-api-key", budget_usd: 20 } };

test("a draft keeps the whole input, answers its id, hash and title, and the same input is the same draft", async t => {
  const { c } = await boot(t);
  const a = await c("agents.new.draft", { input: NEW, proposer: "per_a" }, "module:vyred");
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.match(a.data.id, /^new_/);
  assert.equal(a.data.name, "scout");
  assert.equal(a.data.title, "Make the agent scout?");
  const b = await c("agents.new.draft", { input: { ...NEW }, proposer: "per_a" }, "module:vyred");
  assert.equal(b.data.id, a.data.id, "asked again while it waits: the same draft");
  const got = await c("agents.draft.get", { id: a.data.id });
  assert.deepEqual(got.data.input, NEW);
  assert.equal((await c("agents.new.title", { id: a.data.id, hash: a.data.hash }, "module:vyred")).data, "Make the agent scout?");
  assert.equal((await c("agents.new.title", { id: a.data.id, hash: "0".repeat(24) }, "module:vyred")).data, null, "a wrong hash names nothing");
});

test("only what agents.create takes, in range, is stored; the assistant, a taken name and anything else are refused", async t => {
  const { c } = await boot(t);
  await c("agents.create", { name: "kit", kind: "agent", projects: [] });
  const bad = [
    [{ ...NEW, owner: "per_x" }, /not part of a new agent/],
    [{ ...NEW, kind: "assistant" }, /ordinary agents/],
    [{ ...NEW, name: "Scout!" }, /lowercase/],
    [{ ...NEW, name: "assistant" }, /name of your assistant/],
    [{ ...NEW, name: "kit" }, /already an agent/],
    [{ ...NEW, look: "s9~c1" }, /look/],
    [{ ...NEW, effort: "extreme" }, /effort/],
    [{ ...NEW, skills: "research" }, /skills/],
    [{ ...NEW, auth: { vault: 3 } }, /auth/],
    [{ ...NEW, auth: { budget_usd: -1 } }, /auth/],
    [{ ...NEW, auth: { secret: "x" } }, /auth/],
    [{ ...NEW, computer: "yes" }, /computer/],
    [null, /a new agent is/],
  ];
  for (const [input, why] of bad) { const r = await c("agents.new.draft", { input, proposer: "per_a" }, "module:vyred"); assert.match(String(r.error?.message), /** @type {RegExp} */ (why), JSON.stringify(input)); }
});

test("the yes makes the agent through the create path, as the one who said yes, once; a person's surface cannot call the module's tools", async t => {
  const { c } = await boot(t);
  const d = (await c("agents.new.draft", { input: NEW, proposer: "per_a" }, "module:vyred")).data;
  for (const tool of ["agents.new.draft", "agents.new.title", "agents.new.apply"]) assert.ok((await c(tool, { id: d.id, hash: d.hash, approver: "per_o", input: NEW, proposer: "per_a" }, "local")).error, `${tool} is the module's, not a person's`);
  assert.equal((await c("agents.new.apply", { id: d.id, hash: "f".repeat(24), approver: "per_o" }, "module:vyred")).error?.code, "not_found", "the wrong hash applies nothing");
  const made = await c("agents.new.apply", { id: d.id, hash: d.hash, approver: "per_o" }, "module:vyred");
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.equal(made.data.agent, "scout");
  const row = (await c("agents.list")).data.find((/** @type {any} */ r) => r.name === "scout");
  assert.equal(row.look, NEW.look);
  assert.equal(row.effort, "high");
  const full = (await c("agents.list", { full: true })).data.find((/** @type {any} */ r) => r.name === "scout");
  assert.equal(full.owner, "per_o", "it belongs to the person who said yes");
  assert.equal((await c("agents.new.apply", { id: d.id, hash: d.hash, approver: "per_o" }, "module:vyred")).error?.code, "not_found", "once");
  assert.equal((await c("agents.new.title", { id: d.id, hash: d.hash }, "module:vyred")).data, null, "a settled draft has no title");
});

test("a draft whose name was taken meanwhile does not apply", async t => {
  const { c } = await boot(t);
  const d = (await c("agents.new.draft", { input: NEW, proposer: "per_a" }, "module:vyred")).data;
  await c("agents.create", { name: "scout", kind: "agent", projects: [] });
  assert.equal((await c("agents.new.title", { id: d.id, hash: d.hash }, "module:vyred")).data, null);
  assert.match(String((await c("agents.new.apply", { id: d.id, hash: d.hash, approver: "per_o" }, "module:vyred")).error?.message), /already an agent/);
});

test("only the Flows host (vyred) stores, titles or applies a draft: any other module is refused and nothing is made", async t => {
  const { c } = await boot(t);
  const d = (await c("agents.new.draft", { input: NEW, proposer: "per_a" }, "module:vyred")).data;
  for (const who of ["module:mail", "module:flows", "module:agents", "module:added"]) {
    assert.equal((await c("agents.new.draft", { input: { ...NEW, name: "other" }, proposer: "per_o" }, who)).error?.code, "denied", `${who} draft`);
    assert.equal((await c("agents.new.title", { id: d.id, hash: d.hash }, who)).error?.code, "denied", `${who} title`);
    assert.equal((await c("agents.new.apply", { id: d.id, hash: d.hash, approver: "per_o" }, who)).error?.code, "denied", `${who} apply`);
  }
  const names = (await c("agents.list")).data.map((/** @type {any} */ r) => r.name);
  assert.ok(!names.includes("scout") && !names.includes("other"), "no agent was made");
  assert.equal((await c("agents.new.title", { id: d.id, hash: d.hash }, "module:vyred")).data, "Make the agent scout?", "the draft is still waiting, untouched");
});

test("the one who says yes must be the owner or an admin: another person is refused, and nothing is made", async t => {
  const { c, d: daemon } = await boot(t, true);
  const owner = daemon.kernel.id.owner;
  const draft = (await c("agents.new.draft", { input: NEW, proposer: owner }, "module:vyred")).data;
  const stranger = "per_" + "z".repeat(26);
  assert.equal((await c("agents.new.apply", { id: draft.id, hash: draft.hash, approver: stranger }, "module:vyred")).error?.code, "denied");
  assert.equal((await c("agents.new.draft", { input: { ...NEW, name: "other" }, proposer: stranger }, "module:vyred")).error?.code, "denied", "a stranger cannot propose either");
  assert.ok(!(await c("agents.list")).data.some((/** @type {any} */ r) => r.name === "scout"));
  const made = await c("agents.new.apply", { id: draft.id, hash: draft.hash, approver: owner }, "module:vyred");
  assert.equal(made.error, undefined, JSON.stringify(made.error));
});
