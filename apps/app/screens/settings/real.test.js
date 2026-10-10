// @ts-check
// Settings on the real box (updates, notifications) against a fake box shaped like the dev box's answers.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const STATUS = { current: "0.2.2", available: null, channel: "stable", notes: [], checkedAt: 1_000_000, auto: "notify", error: null, how: "command", command: "vyre update", canApply: false, pending: false };
const PUSH = { quiet: null, kinds: { ask: true, draft: true, watch: true, lesson: false, planner: true, goal: true, proactive: true, notice: true }, planner_label: false, quiet_now: false };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return o[tool];
    if (tool === "update.status" || tool === "update.check") return { data: STATUS };
    if (tool === "push.settings") return { data: input.kinds ? { ...PUSH, kinds: { ...PUSH.kinds, ...input.kinds } } : input.quiet !== undefined ? { ...PUSH, quiet: input.quiet } : PUSH };
    if (tool === "push.devices") return { data: [] };
    return { data: {} };
  };
  return { call, seen };
}

test("updates say where things stand in words, and never a time that was not given", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const b = box();
  const s = await settingsSource(b.call).updateStatus();
  assert.equal(m.updateLine(s), "You are up to date.");
  assert.equal(m.updateLine({ ...s, available: "0.3.0" }), "Vyre 0.3.0 is out. You are on 0.2.2.");
  assert.equal(m.updateLine({ ...s, error: "offline" }), "The last look failed: offline");
  assert.equal(m.checkedLine(null, 5), "Not checked yet.");
  assert.equal(m.checkedLine(1_000_000, 1_000_000 + 3 * 60_000), "Checked 3 minutes ago.");
  assert.equal(m.howLine(s), "To update, run vyre update on your home.");
  assert.equal(m.howLine({ ...s, canApply: true }), "");
  assert.match(m.autoLine("notify"), /never installs one by itself/);
});

test("check and apply are one call each", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const b = box({ "update.apply": { data: { requested: true } } });
  const s = settingsSource(b.call);
  await s.updateCheck(); await s.updateApply();
  assert.deepEqual(b.seen.map((x) => x.tool), ["update.check", "update.apply"]);
});

test("a notification kind or quiet hours is one push.settings call that changes only what is given", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const { quietLine, QUIET_DEFAULT, KIND_ROWS } = await import("./real-model.ts");
  const b = box();
  const s = settingsSource(b.call);
  const after = await s.pushSet({ kinds: { lesson: true } });
  await s.pushSet({ quiet: QUIET_DEFAULT });
  await s.pushSet({ quiet: null });
  assert.equal(after.kinds.lesson, true);
  assert.deepEqual(b.seen.map((x) => x.input), [{ kinds: { lesson: true } }, { quiet: { start: "22:00", end: "07:00" } }, { quiet: null }]);
  assert.deepEqual([quietLine(null), quietLine(QUIET_DEFAULT), quietLine({ start: "06:30", end: "21:00", timezone: "Europe/Lisbon" })], ["No quiet hours.", "10 pm to 7 am", "6:30 am to 9 pm, Europe/Lisbon"]);
  assert.ok(!KIND_ROWS.some(([k]) => k === "notice"), "notice is never a switch");
  assert.ok(KIND_ROWS.every(([k]) => k in PUSH.kinds));
});

test("a box error keeps its code", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const s = settingsSource(async () => ({ error: { code: "unavailable", message: "this server does not take update requests from here: run vyre update" } }));
  await assert.rejects(s.updateApply(), (/** @type {any} */ e) => e.code === "unavailable" && /vyre update/.test(e.message));
});

const AGENTS = [
  { name: "juno", kind: "assistant", projects: "*", model: "sonnet", effort: null, computer: false, auth: "subscription", status: "idle", doing: "idle", thread: "t1" },
  { name: "kit", kind: "agent", projects: ["juniper", "site"], model: null, auth: "api-key", status: "stopped", doing: "stopped", thread: "t2" },
  { name: "new", kind: "agent", projects: [], status: "new", doing: "not started", thread: null },
];
const USAGE = [{ agent: "juno", kind: "assistant", turns: 4, threads: 1, cost_usd: 1.5, api_cost_usd: 0, budget_usd: null, spent_usd: 1.5, left_usd: null, auth: "subscription" }, { agent: "kit", kind: "agent", turns: 9, threads: 2, cost_usd: 12, api_cost_usd: 12, budget_usd: 50, spent_usd: 50, left_usd: 0, auth: "api-key" }];
const PROVIDERS = [
  { id: "codex", label: "Codex", accounts: [], models: [] },
  { id: "claude", label: "Claude", accounts: [{ id: "default", label: "Default", kind: "login", plan: "Max plan", signed_in: true, default: true }], models: [{ id: "opus", label: "Opus" }] },
];

test("assistants: the list as lines, pause is agents.stop and resume is agents.resume", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const m = await import("./agents-model.ts");
  const b = box({ "agents.list": { data: AGENTS }, "agents.stop": { data: { stopped: ["t1"] } }, "agents.resume": { data: {} } });
  const s = settingsSource(b.call);
  const list = await s.agentsList();
  assert.deepEqual(list.map((a) => [m.roleOf(a), m.isStopped(a), m.worksLine(a.projects)]), [["Your assistant", false, "Every project"], ["Agent", true, "Works on juniper and site"], ["Agent", false, "No projects yet"]]);
  assert.equal(m.agentLine(list[0]), "idle, sonnet, uses your subscription, Every project");
  await s.agentStop("juno"); await s.agentResume("kit");
  assert.deepEqual(b.seen.slice(1), [{ tool: "agents.stop", input: { agent: "juno" } }, { tool: "agents.resume", input: { agent: "kit" } }]);
});

test("AI accounts: connected providers first with their plan, spend and budget in words", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const m = await import("./agents-model.ts");
  const b = box({ "providers.list": { data: PROVIDERS }, "agents.usage": { data: USAGE } });
  const s = settingsSource(b.call);
  const rows = m.providerRows(await s.providers());
  assert.deepEqual(rows.map((r) => [r.name, r.on, r.line]), [["Claude", true, "Default, Max plan"], ["Codex", false, "Not connected"]]);
  const us = await s.agentsUsage();
  assert.equal(m.budgetLine(us[0]), "$1.50 spent. No budget set.");
  assert.equal(m.budgetLine(us[1]), "$50 of $50. At the limit: the agent stops and asks you.");
  assert.deepEqual([m.usedShare(us[0]), m.usedShare(us[1]), m.totalSpent(us)], [0, 1, 51.5]);
});

const ENTRIES = [
  { eid: "d1", kind: "device", label: null, since: 1_790_000_000_000, self: true, newcomer: false },
  { eid: "d2", kind: "device", label: "Alex's Mac", since: 1_790_100_000_000, self: false, newcomer: true },
  { eid: "c1", kind: "code", label: null, since: 1_790_000_000_000, self: false, newcomer: false },
  { eid: "k1", kind: "contact", label: "Chris Park", since: 1_790_000_000_000, self: false, newcomer: false },
];

test("account: the list splits into devices, the code and contacts; the device you are on cannot be removed", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const m = await import("./account-model.ts");
  const b = box({ "spaces.identity.entries": { data: { id: "per_a", entries: ENTRIES } }, "spaces.identity.status": { data: { exists: true, name: "devbox.vyre.run", label: "devbox", pending: false } }, "spaces.identity.entry.remove": { data: {} } });
  const s = settingsSource(b.call);
  const es = await s.entries();
  assert.deepEqual([m.devices(es).map((e) => e.eid), m.contacts(es).map((e) => e.eid), m.hasCode(es)], [["d1", "d2"], ["k1"], true]);
  assert.deepEqual(es.map(m.removable), [false, true, false, true]);
  assert.deepEqual([m.entryTitle(es[0]), m.entryTitle(es[1]), m.entryTitle(es[2])], ["This device", "Alex's Mac", "Recovery code"]);
  assert.match(m.entryLine(es[1]), /^Device\. Added .*New sign-in, under 24 hours old$/);
  assert.equal(m.identityLine(await s.identity()), "devbox.vyre.run");
  await s.removeEntry("d2");
  assert.deepEqual(b.seen.at(-1), { tool: "spaces.identity.entry.remove", input: { eid: "d2" } });
});

test("a new recovery code is one call, shown from the reply only, and never stored", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const { codeOf } = await import("./account-model.ts");
  const b = box({ "spaces.identity.code.replace": { data: { code: "R7K4-Q2MX", passwordSet: false } } });
  const r = await settingsSource(b.call).replaceCode();
  assert.deepEqual(b.seen, [{ tool: "spaces.identity.code.replace", input: {} }]);
  assert.equal(codeOf(r), "R7K4-Q2MX");
  assert.equal(codeOf({ passwordSet: true }), null);
});

test("privacy lists the sealed fields from the record types, and nothing else", { skip: !strip }, async () => {
  const { settingsSource } = await import("./real-source.ts");
  const { sealedFields } = await import("./account-model.ts");
  const b = box({ "records.types": { data: { types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text" }, { name: "ssn", label: "SSN", kind: "sealed" }, { name: "acct", label: "Account", kind: "text", seal: { class: "bank" } }] }, { name: "trip", fields: [{ name: "where", kind: "text" }] }] } } });
  const ts = await settingsSource(b.call).types();
  assert.deepEqual(sealedFields(ts).map((x) => [x.typeLabel, x.label]), [["Contact", "SSN"], ["Contact", "Account"]]);
});

test("assistants list: each assistant is a list row with its face, a Paused chip, and Pause or Resume only when it has a thread", { skip: !strip }, async () => {
  const { assistantRows } = await import("./agents-model.ts");
  const a = (/** @type {any} */ o) => ({ name: "Kit", kind: "agent", projects: [], model: "claude-sonnet", status: "running", thread: "t1", ...o });
  const rows = assistantRows([a({}), a({ name: "Vyre Assistant", kind: "assistant", status: "stopped" }), a({ name: "Scout", thread: null })]);
  assert.deepEqual(rows[0].faces, [{ kind: "teammate", name: "Kit" }]);
  assert.deepEqual(rows[0].actions, [{ id: "flip", title: "Pause" }]);
  assert.equal(rows[0].accessories, undefined);
  assert.deepEqual(rows[1].faces, [{ kind: "assistant", name: "Vyre Assistant" }]);
  assert.deepEqual([rows[1].actions[0].title, rows[1].accessories], ["Resume", [{ label: "Paused", tone: "warn" }]]);
  assert.equal(rows[2].actions, undefined, "no thread, nothing to pause");
  assert.match(rows[0].subtitle, /^Agent\. /);
});
