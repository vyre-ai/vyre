// @ts-check
// An assistant's page and the New assistant form (the Deck's views/agents.js, ported) over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return typeof o[tool] === "function" ? o[tool](input) : o[tool];
    return { data: {} };
  };
  return { call, seen };
}

test("create: the form needs a lowercase name, a project and a real budget, and says which", { skip: !strip }, async () => {
  const m = await import("./agent-model.ts");
  const ok = { ...m.NEW_FORM, name: "rex", projects: ["harlow"], instructions: " Draft intake. " };
  const a = m.createInput(ok);
  assert.deepEqual("input" in a && a.input, { name: "rex", kind: "agent", projects: ["harlow"], instructions: "Draft intake.", auth: { vault: "claude-setup-token" }, computer: false });
  assert.match(/** @type {any} */ (m.createInput({ ...ok, name: "Rex Two" })).problem, /lowercase/);
  assert.match(/** @type {any} */ (m.createInput({ ...ok, projects: [] })).problem, /at least one project/);
  assert.equal("input" in m.createInput({ ...ok, projects: [], hasProjects: false }), true, "no projects on the box: nothing to pick");
  assert.match(/** @type {any} */ (m.createInput({ ...ok, runsOn: "key", budget: "0" })).problem, /above zero/);
  const k = m.createInput({ ...ok, runsOn: "key", budget: "25" });
  assert.deepEqual("input" in k && k.input.auth, { vault: "anthropic-api-key", budget_usd: 25 });
});

test("create: when the box drops the computer on create, the same update the page's button sends follows; a refusal is said, the agent stays", { skip: !strip }, async () => {
  const { agentSource } = await import("./agent-source.ts");
  const a = box({ "agents.create": { data: { name: "rex" } } });
  const r = await agentSource(a.call).create({ name: "rex", computer: true });
  assert.deepEqual(a.seen.map((x) => [x.tool, x.input.computer]), [["agents.create", true], ["agents.update", true]]);
  assert.equal(r.made.computer, true);
  const b = box({ "agents.create": { data: { name: "rex", computer: true } } });
  await agentSource(b.call).create({ name: "rex", computer: true });
  assert.deepEqual(b.seen.map((x) => x.tool), ["agents.create"], "made with one: no second call");
  const c = box({ "agents.create": { data: { name: "rex" } }, "agents.update": { error: { code: "refused", message: "no pool" } } });
  const x = await agentSource(c.call).create({ name: "rex", computer: true });
  assert.equal(x.computerError, "no pool");
  assert.equal(x.made.computer, false);
  const d = box({ "agents.create": { error: { code: "bad", message: "there is already an agent rex" } } });
  await assert.rejects(agentSource(d.call).create({ name: "rex" }), /already an agent/);
});

test("page: job and model go through agents.update by name, talk through agents.ask", { skip: !strip }, async () => {
  const { agentSource } = await import("./agent-source.ts");
  const b = box({ "agents.ask": { data: { thread: "t1" } } });
  const s = agentSource(b.call);
  await s.setJob("kit", "  Research.  ");
  await s.setModel("kit", "claude-sonnet-5", "high");
  const t = await s.talk("kit", " hello ");
  assert.equal(t.thread, "t1");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [
    ["agents.update", { name: "kit", instructions: "Research." }],
    ["agents.update", { name: "kit", model: "claude-sonnet-5", effort: "high" }],
    ["agents.ask", { agent: "kit", text: "hello" }],
  ]);
});

test("watchers: the ones that name this agent or nobody, switch on is resume and off is pause", { skip: !strip }, async () => {
  const m = await import("./agent-model.ts");
  const { agentSource } = await import("./agent-source.ts");
  const list = { watchers: [{ name: "w1", source: "gmail", trigger: "mail labelled Ads", agent: "kit" }, { name: "w2", source: "slack", trigger: "a mention" }, { name: "w3", source: "github", agent: "juno" }, { nope: 1 }] };
  const b = box({ "watchers.list": { data: list } });
  const s = agentSource(b.call);
  assert.deepEqual((await s.wakes("kit")).map((w) => w.name), ["w1", "w2"]);
  await s.wake("w1", false);
  await s.wake("w1", true);
  assert.deepEqual(b.seen.slice(1).map((x) => [x.tool, x.input]), [["watchers.pause", { name: "w1" }], ["watchers.resume", { name: "w1" }]]);
  assert.deepEqual(m.watcherLine({ name: "w1", source: "gmail", trigger: "mail labelled Ads" }, new Map()), { title: "Gmail: mail labelled Ads", sub: "Any project" });
  assert.deepEqual(m.watcherLine({ name: "w", source: "files", files: ["a", "b"] }, new Map([["a", "Alpha"]])), { title: "Files: w", sub: "Alpha, b" });
});

test("usage: money only on an API key, turns otherwise, a limit says when it resets", { skip: !strip }, async () => {
  const m = await import("./agent-model.ts");
  assert.deepEqual(m.usageView(undefined, "kit"), { empty: "kit has not run yet." });
  const sub = m.usageView({ agent: "kit", auth: "subscription", turns: 12, threads: 3, duration_ms: 125000, last_at: 1000 }, "kit", 3 * 3600_000 + 1000);
  assert.deepEqual(sub, { top: "12 turns over 3 threads", sub: "2 min of work, last used 3 hours ago", warn: "" });
  const key = /** @type {any} */ (m.usageView({ agent: "kit", auth: "api-key", turns: 1, spent_usd: 4, budget_usd: 10, left_usd: 6, tokens: { input: 1000, output: 500 } }, "kit"));
  assert.equal(key.top, "$4.00 of $10.00, $6.00 left");
  assert.match(key.sub, /1,500 tokens/);
  const near = /** @type {any} */ (m.usageView({ agent: "kit", turns: 1, limit: { status: "allowed_warning", kind: "5h", utilization: 0.91, resets_at: 4_000_000_000 } }, "kit"));
  assert.match(near.warn, /^Near a limit \(5h\), 91% used\. Resets around /);
  const out = /** @type {any} */ (m.usageView({ agent: "kit", turns: 1, limit: { status: "rejected", resets_at: 4_000_000_000 } }, "kit"));
  assert.match(out.warn, /^Stopped by a limit\./);
});

test("computer: the live line follows the state, limits are whole numbers in range and say so", { skip: !strip }, async () => {
  const m = await import("./agent-model.ts");
  const { agentSource } = await import("./agent-source.ts");
  assert.match(m.computerView({ state: "running", screen: 2, screens: 4 }, "kit").live, /^Live\. Screen 2 of 4/);
  assert.match(m.computerView({ state: "running", takeover: "the Deck" }, "kit").live, /^Taken over from the Deck/);
  assert.match(m.computerView({ state: "frozen" }, "kit").live, /^Resting/);
  assert.match(m.computerView({}, "kit").live, /^Not made yet/);
  const v = m.computerView({ state: "running", cpus: 1, memory_gb: 3, size: { w: 1280, h: 800 }, viewers: 2, paused: true }, "kit");
  assert.deepEqual(v.specs, [["Processor", "1 core"], ["Memory", "3 GB"], ["Screen", "1280 by 800"], ["Name", "kit's computer"], ["Watching", "2 screens"], ["Hands", "kit's hands are paused."]]);
  const b = box();
  const s = agentSource(b.call);
  await s.setLimits("kit", "4", "8");
  await assert.rejects(s.setLimits("kit", "0", "8"), /1 to 16/);
  await assert.rejects(s.setLimits("kit", "2", "2.5"), /1 to 64/);
  await s.restart("kit");
  await s.rename("kit", "Desk");
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["computers.limits", { agent: "kit", cpus: 4, memory_gb: 8 }], ["computers.restart", { agent: "kit" }], ["computers.rename", { computer: "kit", name: "Desk" }]]);
});
