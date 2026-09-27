// @ts-check
// Settings, the registry's keys (deck/views/settings-keys.js) rendered into a fake DOM
// (fake-dom.js) against a fake settings module: a small schema with one key of each type, and an
// in-memory store with the module's precedence (project, then account, then the default). Checks
// that every key gets its control, that a change shows before the box answers and goes back when
// it refuses, reset, the Level switch, search, advanced keys and settings.changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

install();
const { drawKeys, APPLY } = await import("../views/settings-keys.js");

const SCHEMA = {
  groups: [{ id: "models", label: "Models and thinking" }, { id: "permissions", label: "Permissions" }, { id: "sessions", label: "Sessions" },
    { id: "tools", label: "Tools" }, { id: "notifications", label: "Notifications" }, { id: "empty", label: "Nothing here" }],
  keys: [
    { key: "model.chat", group: "models", label: "Model for chat", type: "model", levels: ["account"], apply: "session", owner: "V", default: "opus" },
    { key: "model.fallback", group: "models", label: "Fallback model", type: "model", levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "effort", group: "models", label: "Thinking effort", help: "How hard Claude thinks.", type: "enum", enum: ["low", "medium", "high", "xhigh", "max"],
      levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "thinking.show", group: "models", label: "Show thinking", type: "enum", enum: ["folded", "open", "hidden"], default: "folded", levels: ["account"], apply: "live", owner: "V" },
    { key: "fast", group: "models", label: "Fast mode", type: "bool", default: false, levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "permissions.allow", group: "permissions", label: "Always allow", type: "list", levels: ["account", "project"], apply: "live", owner: "C" },
    { key: "sessions.max_turns", group: "sessions", label: "Max turns per message", type: "int", min: 1, max: 1000, levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "sessions.idle_minutes", group: "sessions", label: "Close an idle session after (minutes)", type: "int", min: 1, max: 1440, default: 10,
      levels: ["account"], apply: "restart", owner: "V" },
    { key: "sessions.output_style", group: "sessions", label: "Output style", type: "string", levels: ["account", "project"], apply: "session", owner: "C" },
    { key: "sessions.auth", group: "sessions", label: "How sessions sign in", type: "enum", enum: ["login", "setup-token", "api-key"], levels: ["account"],
      apply: "session", owner: "V", advanced: true },
    { key: "glass.handback_minutes", group: "sessions", label: "Hand a computer back after", type: "int", choices: [0, 2, 5, 15], default: 5, levels: ["account"], apply: "live", owner: "V" },
    { key: "tools.env", group: "tools", label: "Environment for sessions", type: "object", levels: ["account", "project"], apply: "session", owner: "C", advanced: true },
    { key: "notifications.ask", group: "notifications", label: "Notify for ask", type: "bool", default: true, levels: ["account"], apply: "live", owner: "V" },
  ],
};
const BY = new Map(SCHEMA.keys.map(k => [k.key, k]));

/**
 * A fake settings module. `hold` makes set/reset wait until release(); `refuse` makes the next
 * write fail with that message; `off` lists keys whose module is off; `problems` gives a key a problem.
 * @param {{ account?: Record<string, any>, project?: Record<string, Record<string, any>>, off?: string[], problems?: Record<string, string>, missing?: string[] }} [o]
 */
function fakeSettings(o = {}) {
  const account = { ...(o.account || {}) };
  const project = structuredClone(o.project || {});
  const calls = /** @type {{ tool: string, input: any }[]} */ ([]);
  let hold = false, refuse = "";
  /** @type {(() => void)[]} */ let waiting = [];
  const row = (key, p) => {
    const k = BY.get(key);
    const pv = p && k.levels.includes("project") ? project[p]?.[key] : undefined;
    const av = k.levels.includes("account") ? account[key] : undefined;
    const value = pv !== undefined ? pv : av !== undefined ? av : k.default;
    const source = pv !== undefined ? "project" : av !== undefined ? "account" : k.default !== undefined ? "default" : "unset";
    return { ...k, value, source, ...(av !== undefined ? { account: av } : {}), ...(pv !== undefined ? { project: pv } : {}),
      available: !(o.off || []).includes(key), ...(o.problems?.[key] ? { problem: o.problems[key] } : {}) };
  };
  const attempt = async (tool, input = {}) => {
    calls.push({ tool, input: structuredClone(input) });
    if ((o.missing || []).includes(tool)) return { error: { code: "no_such_tool", message: `no tool ${tool}`, module: tool.split(".")[0], missing: true } };
    if (tool === "settings.schema") return { data: structuredClone(SCHEMA) };
    if (tool === "projects.list") return { data: { projects: [{ slug: "harlow-legal", name: "Harlow Legal" }, { slug: "northwind-bakery", name: "Northwind Bakery" }] } };
    if (tool === "settings.get") {
      if (input.key) return { data: row(input.key, input.project) };
      return { data: { project: input.project || null, settings: SCHEMA.keys.map(k => row(k.key, input.project)) } };
    }
    if (tool === "settings.set" || tool === "settings.reset") {
      if (hold) await new Promise(r => waiting.push(() => r(undefined)));
      if (refuse) { const m = refuse; refuse = ""; return { error: { code: "bad_input", message: m } }; }
      const level = input.level || "account";
      const bag = level === "project" ? (project[input.project] ||= {}) : account;
      if (tool === "settings.set") bag[input.key] = input.value; else delete bag[input.key];
      return { data: row(input.key, input.project) };
    }
    return { error: { code: "no_such_tool", message: `no tool ${tool}`, module: tool.split(".")[0], missing: true } };
  };
  return {
    attempt, calls, account, project,
    of: t => calls.filter(c => c.tool === t),
    hold: on => { hold = on; },
    refuse: m => { refuse = m; },
    release: () => { const w = waiting; waiting = []; for (const f of w) f(); },
  };
}

/** @param {ReturnType<typeof fakeSettings>} api @param {Record<string, string>} [query] */
async function render(api = fakeSettings(), query = {}) {
  const el = document.createElement("div");
  const subs = /** @type {[string, Function][]} */ ([]);
  const cleanups = /** @type {Function[]} */ ([]);
  const ctx = { on: (t, fn) => subs.push([t, fn]), cleanup: fn => cleanups.push(fn), alive: () => true, query: new URLSearchParams(query) };
  const out = await drawKeys(/** @type {any} */ (el), ctx, { attempt: /** @type {any} */ (api.attempt), delay: 0, taken: new Set(["notifications", "devices"]), css: false });
  const emit = (type, payload) => Promise.all(subs.filter(s => s[0] === type).map(([, fn]) => fn({ type, payload })));
  return { el, api, out, emit, subs };
}

const rowOf = (el, key) => $(el, `[data-key="${key}"]`);
const tick = () => new Promise(r => setTimeout(r, 5));
const ev = (type, props = {}) => Object.assign(new Event(type), props);
const src = (el, key) => $(rowOf(el, key), ".sk-src")?.getAttribute("data-source");

test("settings keys: a section per group, a control per key by its type", async () => {
  const { el, out } = await render();
  assert.deepEqual(out.groups.map(g => g.id), ["models", "permissions", "sessions", "tools", "set-notifications"], "a group with no keys is left out; a taken id is prefixed");
  assert.ok($(el, "section#models"), "#models is a section");
  assert.ok($(el, "section#set-notifications"));
  // bool: a switch, labelled by the label
  const fast = $(rowOf(el, "fast"), "button.sw");
  assert.equal(fast.getAttribute("role"), "switch");
  assert.equal(fast.getAttribute("aria-checked"), "false");
  assert.equal($(rowOf(el, "fast"), "label").getAttribute("for"), fast.getAttribute("id"));
  // enum of 3: a segment; enum of 5: a select with "Not set"
  assert.equal($$(rowOf(el, "thinking.show"), ".seg button").length, 3);
  assert.equal($(rowOf(el, "thinking.show"), '.seg button[aria-pressed="true"]').textContent, "folded");
  const eff = $(rowOf(el, "effort"), "select");
  assert.ok(eff, "an enum of five is a select");
  assert.deepEqual(eff.options().map(x => x.value), ["", "low", "medium", "high", "xhigh", "max"]);
  // int: a number field with min and max; int with choices: a segment
  const turns = $(rowOf(el, "sessions.max_turns"), "input");
  assert.equal(turns.getAttribute("type"), "number");
  assert.equal(turns.getAttribute("min"), "1");
  assert.equal(turns.getAttribute("max"), "1000");
  assert.deepEqual($$(rowOf(el, "glass.handback_minutes"), ".seg button").map(b => b.textContent), ["0", "2", "5", "15"]);
  // model: opus, sonnet, haiku and Other
  const m = $(rowOf(el, "model.chat"), "select");
  assert.deepEqual(m.options().map(x => x.value), ["", "opus", "sonnet", "haiku", "__other"]);
  assert.equal(m.value, "opus");
  // string: a text field; list: chips and an add field; object: JSON behind Advanced
  assert.equal($(rowOf(el, "sessions.output_style"), "input").getAttribute("type"), "text");
  assert.ok($(rowOf(el, "permissions.allow"), "button.sk-add"));
  // help, the key, the source chip and the Claude Code chip
  assert.match(text(rowOf(el, "effort")), /How hard Claude thinks\./);
  assert.equal(src(el, "thinking.show"), "default");
  assert.match(text(rowOf(el, "thinking.show")), /Default/);
  assert.match(text(rowOf(el, "permissions.allow")), /Claude Code file/);
  assert.doesNotMatch(text(rowOf(el, "fast")), /Claude Code file/);
});

test("settings keys: advanced keys wait for Show advanced; search filters by label or key", async () => {
  const { el } = await render();
  assert.equal(rowOf(el, "sessions.auth").hidden, true);
  // tools has only an advanced key in this schema, so its section hides too
  const tools = $(el, "section#tools");
  assert.equal(tools.hidden, true);
  await $(el, "button.sk-adv").click();
  assert.equal(rowOf(el, "sessions.auth").hidden, false);
  assert.equal(tools.hidden, false);
  // the object control opens its JSON
  const disc = $(rowOf(el, "tools.env"), "button.sk-disc");
  assert.equal($(rowOf(el, "tools.env"), "textarea").hidden, true);
  await disc.click();
  assert.equal(disc.getAttribute("aria-expanded"), "true");
  assert.equal($(rowOf(el, "tools.env"), "textarea").hidden, false);

  const find = $(el, "input.sk-find");
  find.value = "idle";
  find.dispatchEvent(new Event("input"));
  assert.equal(rowOf(el, "sessions.idle_minutes").hidden, false);
  assert.equal(rowOf(el, "fast").hidden, true);
  assert.equal($(el, "section#models").hidden, true);
  find.value = "permissions.allow";
  find.dispatchEvent(new Event("input"));
  assert.equal(rowOf(el, "permissions.allow").hidden, false, "matches the key too");
  find.value = "zzz";
  find.dispatchEvent(new Event("input"));
  assert.match(text($(el, ".sk-none")), /No setting matches "zzz"\./);
});

test("settings keys: a switch saves at once, shows before the box answers, and says when it applies", async () => {
  const api = fakeSettings();
  const { el } = await render(api);
  api.hold(true);
  const sw = $(rowOf(el, "fast"), "button.sw");
  const done = sw.click();
  await tick();
  assert.equal(sw.getAttribute("aria-checked"), "true", "optimistic: on before the box answers");
  assert.deepEqual(api.of("settings.set")[0].input, { key: "fast", level: "account", value: true });
  api.hold(false);
  api.release();
  await done; await tick();
  assert.equal(api.account.fast, true);
  assert.match(text(rowOf(el, "fast")), new RegExp(APPLY.session));
  assert.equal(src(el, "fast"), "account");
  assert.ok($(rowOf(el, "fast"), "button.sk-reset"), "set at this level, so it can be reset");
  // live and restart hints
  await $(rowOf(el, "thinking.show"), 'button[data-value="open"]').click(); await tick();
  assert.match(text(rowOf(el, "thinking.show")), /Applied/);
  const idle = $(rowOf(el, "sessions.idle_minutes"), "input");
  idle.value = "20"; idle.dispatchEvent(new Event("input")); idle.dispatchEvent(new Event("blur"));
  await tick(); await tick();
  assert.equal(api.account["sessions.idle_minutes"], 20);
  assert.match(text(rowOf(el, "sessions.idle_minutes")), /Restart vyred to apply/);
});

test("settings keys: a refused change goes back and says why on its row", async () => {
  const api = fakeSettings();
  const { el } = await render(api);
  api.hold(true);
  api.refuse("sessions.max_turns: at most 1000");
  const inp = $(rowOf(el, "sessions.max_turns"), "input");
  inp.value = "5000";
  inp.dispatchEvent(new Event("input"));
  inp.dispatchEvent(ev("keydown", { key: "Enter" }));
  await tick();
  assert.equal(inp.value, "5000", "shown while the box decides");
  assert.equal(src(el, "sessions.max_turns"), "account");
  api.release();
  await tick(); await tick();
  assert.equal(inp.value, "", "rolled back to no value");
  assert.equal(src(el, "sessions.max_turns"), "unset");
  assert.match(text(rowOf(el, "sessions.max_turns")), /at most 1000/);
  assert.equal($(rowOf(el, "sessions.max_turns"), ".sk-err").getAttribute("role"), "alert");
  assert.equal(api.account["sessions.max_turns"], undefined);

  // a switch too
  api.hold(false);
  api.refuse("the push module said no");
  const sw = $(rowOf(el, "notifications.ask"), "button.sw");
  assert.equal(sw.getAttribute("aria-checked"), "true");
  await sw.click(); await tick();
  assert.equal(sw.getAttribute("aria-checked"), "true", "back to on");
  assert.match(text(rowOf(el, "notifications.ask")), /the push module said no/);
});

test("settings keys: text saves on blur or Enter once, after the delay; typing never redraws", async () => {
  const api = fakeSettings();
  const { el } = await render(api);
  const inp = $(rowOf(el, "sessions.output_style"), "input");
  const before = rowOf(el, "sessions.output_style");
  inp.value = "Expl"; inp.dispatchEvent(new Event("input"));
  inp.value = "Explanatory"; inp.dispatchEvent(new Event("input"));
  assert.equal(api.of("settings.set").length, 0, "no write while typing");
  inp.dispatchEvent(ev("keydown", { key: "Enter" }));
  inp.dispatchEvent(new Event("blur"));
  await tick(); await tick();
  assert.equal(api.of("settings.set").length, 1, "Enter then blur is one write");
  assert.equal(api.account["sessions.output_style"], "Explanatory");
  assert.equal(rowOf(el, "sessions.output_style"), before, "the row is the same element");
  assert.equal($(rowOf(el, "sessions.output_style"), "input"), inp, "and so is the field");
  // blur with nothing changed writes nothing
  inp.dispatchEvent(new Event("blur")); await tick();
  assert.equal(api.of("settings.set").length, 1);
});

test("settings keys: model Other, list add and remove, JSON checked before it is sent", async () => {
  const api = fakeSettings({ account: { "permissions.allow": ["Edit"] } });
  const { el } = await render(api);
  // model: an alias saves at once; Other takes a typed id
  const m = $(rowOf(el, "model.fallback"), "select");
  m.value = "sonnet"; m.dispatchEvent(new Event("change")); await tick();
  assert.equal(api.account["model.fallback"], "sonnet");
  m.value = "__other"; m.dispatchEvent(new Event("change"));
  const other = $(rowOf(el, "model.fallback"), "input.sk-other");
  assert.equal(other.hidden, false);
  other.value = "claude-opus-4-1"; other.dispatchEvent(new Event("input")); other.dispatchEvent(new Event("blur"));
  await tick(); await tick();
  assert.equal(api.account["model.fallback"], "claude-opus-4-1");
  assert.equal(m.value, "__other");
  // list: add by Enter, remove by its button
  const row = rowOf(el, "permissions.allow");
  const add = $(row, "input.sk-input");
  add.value = "Bash(npm test:*)"; add.dispatchEvent(new Event("input")); add.dispatchEvent(ev("keydown", { key: "Enter" }));
  await tick();
  assert.deepEqual(api.account["permissions.allow"], ["Edit", "Bash(npm test:*)"]);
  assert.equal($$(row, ".sk-chip").length, 2);
  await $(row, 'button[aria-label="Remove Edit"]').click(); await tick();
  assert.deepEqual(api.account["permissions.allow"], ["Bash(npm test:*)"]);
  // object: bad JSON stays here; good JSON is sent
  await $(el, "button.sk-adv").click();
  const ta = $(rowOf(el, "tools.env"), "textarea");
  ta.value = "{nope"; ta.dispatchEvent(new Event("input")); ta.dispatchEvent(new Event("blur")); await tick();
  assert.equal(api.of("settings.set").filter(c => c.input.key === "tools.env").length, 0);
  assert.match(text(rowOf(el, "tools.env")), /Not valid JSON/);
  ta.value = '{"NODE_ENV":"test"}'; ta.dispatchEvent(new Event("input")); ta.dispatchEvent(new Event("blur")); await tick(); await tick();
  assert.deepEqual(api.account["tools.env"], { NODE_ENV: "test" });
});

test("settings keys: reset removes the value at this level", async () => {
  const api = fakeSettings({ account: { "thinking.show": "open" } });
  const { el } = await render(api);
  assert.equal(src(el, "thinking.show"), "account");
  await $(rowOf(el, "thinking.show"), "button.sk-reset").click(); await tick();
  assert.deepEqual(api.of("settings.reset")[0].input, { key: "thinking.show", level: "account" });
  assert.equal(src(el, "thinking.show"), "default");
  assert.equal($(rowOf(el, "thinking.show"), '.seg button[aria-pressed="true"]').textContent, "folded");
  assert.equal($(rowOf(el, "thinking.show"), "button.sk-reset"), null, "nothing left to reset");
});

test("settings keys: Project mode writes to the project and dims account-only keys", async () => {
  const api = fakeSettings({ account: { effort: "high" }, project: { "harlow-legal": { fast: true } } });
  const { el } = await render(api);
  const proj = $(el, 'button[data-level="project"]');
  assert.equal(proj.disabled, false);
  await proj.click(); await tick();
  assert.deepEqual(api.of("settings.get").at(-1).input, { project: "harlow-legal" });
  const sel = $(el, "select.sk-proj");
  assert.equal(sel.hidden, false);
  assert.deepEqual(sel.options().map(o => o.textContent), ["Harlow Legal", "Northwind Bakery"]);
  // account-only: dimmed, said, and not changeable
  const chat = rowOf(el, "model.chat");
  assert.ok(chat.classList.contains("sk-dim"));
  assert.match(text(chat), /Set for your account only/);
  assert.equal($(chat, "select").disabled, true);
  // a project value, and an inherited account value
  assert.equal(src(el, "fast"), "project");
  assert.equal(src(el, "effort"), "account");
  assert.equal($(rowOf(el, "effort"), "button.sk-reset"), null, "set at account, not here");
  const eff = $(rowOf(el, "effort"), "select");
  eff.value = "low"; eff.dispatchEvent(new Event("change")); await tick();
  assert.deepEqual(api.of("settings.set").at(-1).input, { key: "effort", level: "project", project: "harlow-legal", value: "low" });
  assert.equal(api.project["harlow-legal"].effort, "low");
  assert.equal(api.account.effort, "high");
  // reset in the project falls back to the account's value
  await $(rowOf(el, "effort"), "button.sk-reset").click(); await tick();
  assert.equal(src(el, "effort"), "account");
  assert.equal(eff.value, "high");
  // another project
  sel.value = "northwind-bakery"; sel.dispatchEvent(new Event("change")); await tick();
  assert.equal(src(el, "fast"), "default");
});

test("settings keys: a module that is off, and a problem, show on the row", async () => {
  const api = fakeSettings({ off: ["notifications.ask"], problems: { "permissions.allow": "~/.claude/settings.json is not valid JSON" } });
  const { el } = await render(api);
  const ask = rowOf(el, "notifications.ask");
  assert.ok(ask.classList.contains("sk-dim"));
  assert.match(text(ask), /Its module is off/);
  assert.equal($(ask, "button.sw").disabled, true);
  assert.match(text(rowOf(el, "permissions.allow")), /is not valid JSON/);
});

test("settings keys: settings.changed refreshes only the row it names", async () => {
  const api = fakeSettings();
  const { el, emit } = await render(api);
  const other = rowOf(el, "effort");
  api.account.fast = true; // another device changed it
  const gets = api.of("settings.get").length;
  await emit("settings.changed", { key: "fast", level: "account", apply: "session" }); await tick();
  assert.deepEqual(api.of("settings.get").slice(gets).map(c => c.input), [{ key: "fast" }], "one row asked for, not the list");
  assert.equal($(rowOf(el, "fast"), "button.sw").getAttribute("aria-checked"), "true");
  assert.equal(rowOf(el, "effort"), other);
  // a project's change while showing the account is not ours
  await emit("settings.changed", { key: "fast", level: "project", project: "harlow-legal", apply: "session" }); await tick();
  assert.equal(api.of("settings.get").length, gets + 1);
  // an unknown key is ignored
  await emit("settings.changed", { key: "nope", level: "account", apply: "live" });
  assert.equal(api.of("settings.get").length, gets + 1);
});

test("settings keys: a field being typed in keeps its text when its row refreshes", async () => {
  const api = fakeSettings();
  const { el, emit } = await render(api);
  const inp = $(rowOf(el, "sessions.output_style"), "input");
  inp.value = "Learn"; inp.dispatchEvent(new Event("input"));
  api.account["sessions.output_style"] = "Explanatory";
  await emit("settings.changed", { key: "sessions.output_style", level: "account", apply: "session" }); await tick();
  assert.equal(inp.value, "Learn");
  assert.equal(src(el, "sessions.output_style"), "account", "the chip still updates");
});

test("settings keys: ?project= opens in Project mode; reveal finds an advanced key", async () => {
  const { el, out, api } = await render(fakeSettings(), { project: "northwind-bakery" });
  assert.deepEqual(api.of("settings.get")[0].input, { project: "northwind-bakery" });
  assert.equal($(el, 'button[data-level="project"]').getAttribute("aria-pressed"), "true");
  assert.equal(out.reveal("tools.env"), true);
  assert.equal(rowOf(el, "tools.env").hidden, false, "advanced opened for it");
  assert.ok(rowOf(el, "tools.env").classList.contains("sk-hi"));
  assert.equal(out.reveal("nope"), false);
});

test("settings keys: without the settings module, one section says so", async () => {
  const { el, out } = await render(fakeSettings({ missing: ["settings.schema"] }));
  assert.deepEqual(out.groups, []);
  assert.match(text(el), /These settings are kept by the settings module\..*The settings module is not running/);
});
