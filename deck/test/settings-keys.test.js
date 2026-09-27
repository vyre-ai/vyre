// @ts-check
// Settings, the registry's keys (deck/views/settings-keys.js) rendered into a fake DOM
// (fake-dom.js) against a fake settings module: a small schema of module-prefixed keys, one of
// each type, and an in-memory store with the module's precedence (project, then account, then
// the default) and its rules (preview writes nothing; a confirm key needs confirm: true; a
// loosening key needs a presence proof). Checks every key gets its control, a change shows before
// the box answers and goes back when it refuses, the confirm line, the presence path, the
// Saved/Reset/Undo slot, the restart banner, the Level switch, search, advanced keys, J and K,
// and settings.changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = install();
// The fake's focus() does nothing; here it moves document.activeElement, for J, K and /.
Element.prototype.focus = function () { /** @type {any} */ (doc).activeElement = this; };
const { drawKeys, APPLY, needsConfirm } = await import("../views/settings-keys.js");

const SCHEMA = {
  groups: [{ id: "models", label: "Models and thinking" }, { id: "permissions", label: "Permissions" }, { id: "sessions", label: "Sessions" },
    { id: "vault", label: "Vault" }, { id: "tools", label: "Tools" }, { id: "notifications", label: "Notifications" }, { id: "empty", label: "Nothing here" }],
  keys: [
    { key: "sessions.model", module: "sessions", group: "models", label: "Model for chat", type: "model", levels: ["account"], apply: "session", owner: "V", default: "opus" },
    { key: "sessions.model_fallback", module: "sessions", group: "models", label: "Fallback model", type: "model", levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "sessions.effort", module: "sessions", group: "models", label: "Thinking effort", help: "How hard Claude thinks.", type: "enum", enum: ["low", "medium", "high", "xhigh", "max"],
      levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "chat.thinking", module: "chat", group: "models", label: "Show thinking", type: "enum", enum: ["folded", "open", "hidden"], default: "folded", levels: ["account"], apply: "live", owner: "V" },
    { key: "sessions.fast", module: "sessions", group: "models", label: "Fast mode", type: "bool", default: false, levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "sessions.mode", module: "sessions", group: "permissions", label: "Permission mode new sessions start in", type: "enum",
      enum: ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"], default: "default", levels: ["account", "project"], apply: "session", owner: "V",
      confirm: { values: ["bypassPermissions", "dontAsk", "auto"] }, loosens: "New sessions will run tools without asking you first." },
    { key: "sessions.allow", module: "sessions", group: "permissions", label: "Always allow", type: "list", levels: ["account", "project"], apply: "live", owner: "C",
      confirm: true, loosens: "Claude will run these without asking, here and in the terminal." },
    { key: "sessions.deny", module: "sessions", group: "permissions", label: "Always deny", type: "list", levels: ["account", "project"], apply: "live", owner: "C" },
    { key: "sessions.max_turns", module: "sessions", group: "sessions", label: "Max turns per message", type: "int", min: 1, max: 1000, levels: ["account", "project"], apply: "session", owner: "V" },
    { key: "sessions.idle_minutes", module: "sessions", group: "sessions", label: "Close an idle session after (minutes)", type: "int", min: 1, max: 1440, default: 10,
      levels: ["account"], apply: "restart", owner: "V" },
    { key: "sessions.terminals", module: "sessions", group: "sessions", label: "Terminals open at once", type: "int", choices: [1, 2, 4, 8], default: 4,
      levels: ["account"], apply: "restart", owner: "V" },
    { key: "sessions.output_style", module: "sessions", group: "sessions", label: "Output style", type: "string", levels: ["account", "project"], apply: "session", owner: "C" },
    { key: "sessions.auth", module: "sessions", group: "sessions", label: "How sessions sign in", type: "enum", enum: ["login", "setup-token", "api-key"], levels: ["account"],
      apply: "session", owner: "V", advanced: true },
    { key: "glass.handback_minutes", module: "glass", group: "sessions", label: "Hand a computer back after", type: "int", choices: [0, 2, 5, 15], default: 5, levels: ["account"], apply: "live", owner: "V" },
    { key: "vault.lock_idle", module: "vault", group: "vault", label: "Lock after idle", help: "Like 10m or 1h.", type: "string", default: "10m", levels: ["account"], apply: "restart",
      owner: "V", security: "loosens", loosens: "Your vault stays unlocked for longer." },
    { key: "vault.lock_on_sleep", module: "vault", group: "vault", label: "Lock when the Mac sleeps", type: "bool", default: true, levels: ["account"], apply: "restart",
      owner: "V", security: "loosens", loosens: "Your vault stays unlocked for longer." },
    { key: "sessions.env", module: "sessions", group: "tools", label: "Environment for sessions", type: "object", levels: ["account", "project"], apply: "session", owner: "C", advanced: true },
    { key: "push.watch", module: "push", group: "notifications", label: "Notify for ask", type: "bool", default: true, levels: ["account"], apply: "live", owner: "V" },
  ],
};
const BY = new Map(SCHEMA.keys.map(k => [k.key, k]));

/**
 * A fake settings module. `hold` makes set/reset wait until release(); `refuse` makes the next
 * write fail with that message; `off` lists keys whose module is off; `problems` gives a key a
 * problem; `noProof` makes the presence proof fail as a cancelled passkey would. Every call's
 * options are kept, so a test can see which went through the presence path.
 * @param {{ account?: Record<string, any>, project?: Record<string, Record<string, any>>, off?: string[], problems?: Record<string, string>, missing?: string[], noProof?: boolean }} [o]
 */
function fakeSettings(o = {}) {
  const account = { ...(o.account || {}) };
  const project = structuredClone(o.project || {});
  const calls = /** @type {{ tool: string, input: any, opts: any }[]} */ ([]);
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
  const attempt = async (tool, input = {}, opts = {}) => {
    calls.push({ tool, input: structuredClone(input), opts: structuredClone(opts) });
    if ((o.missing || []).includes(tool)) return { error: { code: "no_such_tool", message: `no tool ${tool}`, module: tool.split(".")[0], missing: true } };
    if (tool === "settings.schema") return { data: structuredClone(SCHEMA) };
    if (tool === "projects.list") return { data: { projects: [{ slug: "harlow-legal", name: "Harlow Legal" }, { slug: "northwind-bakery", name: "Northwind Bakery" }] } };
    if (tool === "settings.get") {
      if (input.key) return { data: row(input.key, input.project) };
      return { data: { project: input.project || null, settings: SCHEMA.keys.map(k => row(k.key, input.project)) } };
    }
    if (tool === "settings.set" || tool === "settings.reset") {
      const d = BY.get(input.key);
      const level = input.level || "account";
      const bag = level === "project" ? (project[input.project] ||= {}) : account;
      const value = tool === "settings.set" ? input.value : undefined;
      if (input.preview) {
        return { data: { key: d.key, level, ...(input.project ? { project: input.project } : {}),
          where: d.owner === "C" ? `/home/alex/${input.project || ".claude"}/settings.local.json permissions.allow` : "vyre",
          before: bag[d.key], after: value, ...(needsConfirm(d, value) ? { confirm: d.loosens } : {}) } };
      }
      if (d.security === "loosens" && !opts.presence) return { error: { code: "presence_required", message: `${d.key} needs a person`, methods: ["passkey"] } };
      if (d.security === "loosens" && o.noProof) return { error: { code: "cancelled", message: "The passkey was cancelled or timed out." } };
      if (value !== undefined && needsConfirm(d, value) && input.confirm !== true) return { error: { code: "confirm_required", message: `${d.loosens} Show the person and send confirm: true.` } };
      if (hold) await new Promise(r => waiting.push(() => r(undefined)));
      if (refuse) { const m = refuse; refuse = ""; return { error: { code: "bad_input", message: m } }; }
      if (tool === "settings.set") bag[input.key] = input.value; else delete bag[input.key];
      return { data: row(input.key, input.project) };
    }
    return { error: { code: "no_such_tool", message: `no tool ${tool}`, module: tool.split(".")[0], missing: true } };
  };
  return {
    attempt, calls, account, project,
    of: t => calls.filter(c => c.tool === t),
    writes: t => calls.filter(c => c.tool === t && !c.input.preview),
    hold: on => { hold = on; },
    refuse: m => { refuse = m; },
    release: () => { const w = waiting; waiting = []; for (const f of w) f(); },
  };
}

/** @param {ReturnType<typeof fakeSettings>} api @param {Record<string, string>} [query] */
async function render(api = fakeSettings(), query = {}) {
  const el = document.createElement("div");
  const keys = document.createElement("div"); // stands in for the document, where J, K and / are heard
  const subs = /** @type {[string, Function][]} */ ([]);
  const cleanups = /** @type {Function[]} */ ([]);
  const ctx = { on: (t, fn) => subs.push([t, fn]), cleanup: fn => cleanups.push(fn), alive: () => true, query: new URLSearchParams(query) };
  const out = await drawKeys(/** @type {any} */ (el), ctx, { attempt: /** @type {any} */ (api.attempt), delay: 0, saved: 40, undo: 60,
    taken: new Set(["notifications", "devices"]), css: false, keys: /** @type {any} */ (keys) });
  const emit = (type, payload) => Promise.all(subs.filter(s => s[0] === type).map(([, fn]) => fn({ type, payload })));
  const press = (key, target = /** @type {any} */ (doc).activeElement || el, mods = {}) => keys.dispatchEvent(Object.assign(new Event("keydown"), { key, target, ...mods }));
  return { el, api, out, emit, subs, press, cleanups };
}

const rowOf = (el, key) => $(el, `[data-key="${key}"]`);
const tick = () => new Promise(r => setTimeout(r, 5));
const wait = ms => new Promise(r => setTimeout(r, ms));
const ev = (type, props = {}) => Object.assign(new Event(type), props);
const src = (el, key) => $(rowOf(el, key), ".sk-src")?.getAttribute("data-source") || "none";
const slot = (el, key) => text($(rowOf(el, key), ".sk-slot"));

test("settings keys: a section per group, a control per key by its type", async () => {
  const { el, out } = await render();
  assert.deepEqual(out.groups.map(g => g.id), ["models", "permissions", "sessions", "vault", "tools", "set-notifications"], "a group with no keys is left out; a taken id is prefixed");
  assert.ok($(el, "section#models"), "#models is a section");
  assert.ok($(el, "section#set-notifications"));
  // bool: a switch, labelled by the label
  const fast = $(rowOf(el, "sessions.fast"), "button.sw");
  assert.equal(fast.getAttribute("role"), "switch");
  assert.equal(fast.getAttribute("aria-checked"), "false");
  assert.equal($(rowOf(el, "sessions.fast"), "label").getAttribute("for"), fast.getAttribute("id"));
  // enum of 3: a segment; enum of 5: a select with "Not set"
  assert.equal($$(rowOf(el, "chat.thinking"), ".seg button").length, 3);
  assert.equal($(rowOf(el, "chat.thinking"), '.seg button[aria-pressed="true"]').textContent, "folded");
  const eff = $(rowOf(el, "sessions.effort"), "select");
  assert.ok(eff, "an enum of five is a select");
  assert.deepEqual(eff.options().map(x => x.value), ["", "low", "medium", "high", "xhigh", "max"]);
  // int: a number field with min and max; int with choices: a segment
  const turns = $(rowOf(el, "sessions.max_turns"), "input");
  assert.equal(turns.getAttribute("type"), "number");
  assert.equal(turns.getAttribute("min"), "1");
  assert.equal(turns.getAttribute("max"), "1000");
  assert.deepEqual($$(rowOf(el, "glass.handback_minutes"), ".seg button").map(b => b.textContent), ["0", "2", "5", "15"]);
  // model: opus, sonnet, haiku and Other
  const m = $(rowOf(el, "sessions.model"), "select");
  assert.deepEqual(m.options().map(x => x.value), ["", "opus", "sonnet", "haiku", "__other"]);
  assert.equal(m.value, "opus");
  // string: a text field; list: chips and an add field on a wide row; object: JSON behind Advanced
  assert.equal($(rowOf(el, "sessions.output_style"), "input").getAttribute("type"), "text");
  assert.ok($(rowOf(el, "sessions.deny"), "button.sk-add"));
  assert.ok(rowOf(el, "sessions.deny").classList.contains("sk-wide"));
  // the description line: help, then when it applies; nothing for a live key
  assert.match(text($(rowOf(el, "sessions.effort"), ".sk-desc")), /How hard Claude thinks\..*Next session/);
  assert.match(text(rowOf(el, "sessions.idle_minutes")), /After restart/);
  assert.equal($(rowOf(el, "chat.thinking"), ".sk-apply"), null, "live prints nothing");
  assert.deepEqual(APPLY, { live: "", session: "Next session", restart: "After restart" });
  // no chip for a default value, no Claude Code chip, and the key only while searching
  assert.equal(src(el, "chat.thinking"), "none");
  assert.doesNotMatch(text(rowOf(el, "chat.thinking")), /Default|Not set/);
  assert.doesNotMatch(text(el), /Claude Code file/);
  assert.equal($(rowOf(el, "sessions.effort"), ".sk-key").hidden, true);
  // every row has its slot, laid out even when empty, and can take focus
  for (const r of $$(el, ".sk-row")) {
    assert.ok($(r, ".sk-slot"), `${r.getAttribute("data-key")} has a slot`);
    assert.equal(r.getAttribute("tabindex"), "-1");
  }
});

test("settings keys: the source chip shows only off the default, names the file for Claude Code's keys", async () => {
  const api = fakeSettings({ account: { "sessions.deny": ["Bash(rm:*)"], "sessions.fast": true }, project: { "harlow-legal": { "sessions.deny": ["Edit"] } } });
  const { el, out } = await render(api);
  assert.equal(src(el, "sessions.fast"), "account");
  assert.equal(text($(rowOf(el, "sessions.fast"), ".sk-src")), "Account");
  assert.equal($(rowOf(el, "sessions.fast"), ".sk-src").getAttribute("title"), "Set for your account");
  assert.equal($(rowOf(el, "sessions.deny"), ".sk-src").getAttribute("title"), "~/.claude/settings.json");
  await out.setLevel("project", "harlow-legal");
  assert.equal(src(el, "sessions.deny"), "project");
  assert.equal(text($(rowOf(el, "sessions.deny"), ".sk-src")), "Project");
  assert.equal($(rowOf(el, "sessions.deny"), ".sk-src").getAttribute("title"), "Harlow Legal/.claude/settings.local.json");
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
  const disc = $(rowOf(el, "sessions.env"), "button.sk-disc");
  assert.equal($(rowOf(el, "sessions.env"), "textarea").hidden, true);
  await disc.click();
  assert.equal(disc.getAttribute("aria-expanded"), "true");
  assert.equal($(rowOf(el, "sessions.env"), "textarea").hidden, false);

  const find = $(el, "input.sk-find");
  find.value = "idle";
  find.dispatchEvent(new Event("input"));
  assert.equal(rowOf(el, "sessions.idle_minutes").hidden, false);
  assert.equal($(rowOf(el, "sessions.idle_minutes"), ".sk-key").hidden, false, "search shows the key");
  assert.equal(rowOf(el, "sessions.fast").hidden, true);
  assert.equal($(el, "section#models").hidden, true);
  find.value = "sessions.deny";
  find.dispatchEvent(new Event("input"));
  assert.equal(rowOf(el, "sessions.deny").hidden, false, "matches the key too");
  find.value = "zzz";
  find.dispatchEvent(new Event("input"));
  assert.match(text($(el, ".sk-none")), /No setting matches "zzz"\./);
});

test("settings keys: a switch saves at once, shows before the box answers, then Saved in its slot for a moment", async () => {
  const api = fakeSettings();
  const { el } = await render(api);
  api.hold(true);
  const sw = $(rowOf(el, "sessions.fast"), "button.sw");
  const slotEl = $(rowOf(el, "sessions.fast"), ".sk-slot");
  const done = sw.click();
  await tick();
  assert.equal(sw.getAttribute("aria-checked"), "true", "optimistic: on before the box answers");
  assert.deepEqual(api.of("settings.set")[0].input, { key: "sessions.fast", level: "account", value: true });
  assert.equal(api.of("settings.set")[0].opts.presence, undefined, "a plain key needs no proof");
  api.hold(false);
  api.release();
  await done; await tick();
  assert.equal(api.account["sessions.fast"], true);
  assert.equal(slot(el, "sessions.fast"), "Saved");
  assert.equal($(rowOf(el, "sessions.fast"), ".sk-slot"), slotEl, "the same slot, so nothing shifts");
  assert.equal(slotEl.getAttribute("aria-live"), "polite");
  assert.equal(src(el, "sessions.fast"), "account");
  await wait(60);
  assert.equal(slot(el, "sessions.fast"), "Reset to default", "Saved gives way to the reset ghost");
});

test("settings keys: a refused change goes back and says Not saved and why on its row", async () => {
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
  assert.equal(src(el, "sessions.max_turns"), "none");
  assert.match(text(rowOf(el, "sessions.max_turns")), /Not saved\s+sessions\.max_turns: at most 1000/);
  assert.equal($(rowOf(el, "sessions.max_turns"), ".sk-err").getAttribute("role"), "alert");
  assert.equal($(rowOf(el, "sessions.max_turns"), ".set-warn"), null, "no violet warning class");
  assert.equal(api.account["sessions.max_turns"], undefined);
  assert.equal(slot(el, "sessions.max_turns"), "", "no Saved for a refusal");

  // a switch too
  api.hold(false);
  api.refuse("the push module said no");
  const sw = $(rowOf(el, "push.watch"), "button.sw");
  assert.equal(sw.getAttribute("aria-checked"), "true");
  await sw.click(); await tick();
  assert.equal(sw.getAttribute("aria-checked"), "true", "back to on");
  assert.match(text(rowOf(el, "push.watch")), /the push module said no/);
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
  const api = fakeSettings({ account: { "sessions.deny": ["Edit"] } });
  const { el } = await render(api);
  // model: an alias saves at once; Other takes a typed id
  const m = $(rowOf(el, "sessions.model_fallback"), "select");
  m.value = "sonnet"; m.dispatchEvent(new Event("change")); await tick();
  assert.equal(api.account["sessions.model_fallback"], "sonnet");
  m.value = "__other"; m.dispatchEvent(new Event("change"));
  const other = $(rowOf(el, "sessions.model_fallback"), "input.sk-other");
  assert.equal(other.hidden, false);
  other.value = "claude-opus-4-1"; other.dispatchEvent(new Event("input")); other.dispatchEvent(new Event("blur"));
  await tick(); await tick();
  assert.equal(api.account["sessions.model_fallback"], "claude-opus-4-1");
  assert.equal(m.value, "__other");
  // list: add by Enter, remove by its button
  const row = rowOf(el, "sessions.deny");
  const add = $(row, "input.sk-input");
  add.value = "Bash(rm:*)"; add.dispatchEvent(new Event("input")); add.dispatchEvent(ev("keydown", { key: "Enter" }));
  await tick();
  assert.deepEqual(api.account["sessions.deny"], ["Edit", "Bash(rm:*)"]);
  assert.equal($$(row, ".sk-chip").length, 2);
  await $(row, 'button[aria-label="Remove Edit"]').click(); await tick();
  assert.deepEqual(api.account["sessions.deny"], ["Bash(rm:*)"]);
  // object: bad JSON stays here; good JSON is sent
  await $(el, "button.sk-adv").click();
  const ta = $(rowOf(el, "sessions.env"), "textarea");
  ta.value = "{nope"; ta.dispatchEvent(new Event("input")); ta.dispatchEvent(new Event("blur")); await tick();
  assert.equal(api.of("settings.set").filter(c => c.input.key === "sessions.env").length, 0);
  assert.match(text(rowOf(el, "sessions.env")), /Not valid JSON/);
  ta.value = '{"NODE_ENV":"test"}'; ta.dispatchEvent(new Event("input")); ta.dispatchEvent(new Event("blur")); await tick(); await tick();
  assert.deepEqual(api.account["sessions.env"], { NODE_ENV: "test" });
});

test("settings keys: needsConfirm follows the contract", () => {
  const mode = BY.get("sessions.mode");
  assert.equal(needsConfirm(mode, "plan"), false);
  assert.equal(needsConfirm(mode, "bypassPermissions"), true);
  assert.equal(needsConfirm(BY.get("sessions.allow"), ["Edit"]), true);
  assert.equal(needsConfirm(BY.get("vault.lock_idle"), "1h"), true);
  assert.equal(needsConfirm(BY.get("sessions.fast"), true), false);
});

test("settings keys: a confirm value previews, asks on its row, and Confirm sends confirm: true", async () => {
  const api = fakeSettings();
  const { el } = await render(api);
  const row = rowOf(el, "sessions.mode");
  const sel = $(row, "select");
  // a plain value saves with no question
  sel.value = "plan"; sel.dispatchEvent(new Event("change")); await tick();
  assert.equal(api.account["sessions.mode"], "plan");
  assert.equal($(row, ".sk-ask").hidden, true);
  // a widening one previews first and writes nothing yet
  sel.value = "bypassPermissions"; sel.dispatchEvent(new Event("change")); await tick();
  assert.deepEqual(api.of("settings.set").at(-1).input, { key: "sessions.mode", level: "account", value: "bypassPermissions", preview: true });
  assert.equal(api.account["sessions.mode"], "plan", "nothing written by the preview");
  const ask = $(row, ".sk-ask");
  assert.equal(ask.hidden, false);
  assert.match(text(ask), /New sessions will run tools without asking you first\./);
  assert.equal(text($(ask, ".sk-where")), "vyre", "where it lands, in mono");
  assert.equal(sel.value, "bypassPermissions", "the control shows what is being asked about");
  assert.equal(slot(el, "sessions.mode"), "", "the slot keeps quiet while asking");
  await $(ask, "button.sk-yes").click(); await tick();
  const w = api.writes("settings.set").at(-1);
  assert.deepEqual(w.input, { key: "sessions.mode", level: "account", value: "bypassPermissions", confirm: true });
  assert.equal(w.opts.presence, undefined, "a confirm key is not a loosening one: no proof");
  assert.equal(api.account["sessions.mode"], "bypassPermissions");
  assert.equal(ask.hidden, true);
  assert.equal(slot(el, "sessions.mode"), "Saved");
});

test("settings keys: Cancel puts the control back and writes nothing", async () => {
  const api = fakeSettings({ account: { "sessions.allow": ["Edit"] } });
  const { el } = await render(api);
  const row = rowOf(el, "sessions.allow");
  const add = $(row, "input.sk-input");
  add.value = "Bash(npm test:*)"; add.dispatchEvent(new Event("input")); add.dispatchEvent(ev("keydown", { key: "Enter" }));
  await tick();
  assert.equal($(row, ".sk-ask").hidden, false, "a confirm: true list asks for every change");
  assert.match(text($(row, ".sk-ask")), /Claude will run these without asking, here and in the terminal\./);
  assert.match(text($(row, ".sk-where")), /settings\.local\.json permissions\.allow/);
  assert.equal($$(row, ".sk-chip").length, 2, "shown while asking");
  await $(row, "button.sk-no").click(); await tick();
  assert.equal($(row, ".sk-ask").hidden, true);
  assert.equal($$(row, ".sk-chip").length, 1, "back to the one rule");
  assert.deepEqual(api.account["sessions.allow"], ["Edit"]);
  assert.equal(api.writes("settings.set").length, 0);

  // a select goes back too
  const sel = $(rowOf(el, "sessions.mode"), "select");
  sel.value = "dontAsk"; sel.dispatchEvent(new Event("change")); await tick();
  await $(rowOf(el, "sessions.mode"), "button.sk-no").click(); await tick();
  assert.equal(sel.value, "default");
});

test("settings keys: a loosening key goes through the presence path", async () => {
  const api = fakeSettings();
  const { el } = await render(api);
  const row = rowOf(el, "vault.lock_idle");
  const inp = $(row, "input");
  inp.value = "4h"; inp.dispatchEvent(new Event("input")); inp.dispatchEvent(new Event("blur"));
  await tick(); await tick();
  const pre = api.of("settings.set").at(-1);
  assert.equal(pre.input.preview, true);
  assert.equal(pre.opts.presence, undefined, "a preview needs no proof");
  assert.match(text($(row, ".sk-ask")), /Your vault stays unlocked for longer\./);
  await $(row, "button.sk-yes").click(); await tick();
  const w = api.writes("settings.set").at(-1);
  assert.deepEqual(w.input, { key: "vault.lock_idle", level: "account", value: "4h", confirm: true });
  assert.equal(w.opts.presence, true, "sent through api.js's presence proof");
  assert.equal(api.account["vault.lock_idle"], "4h");

  // a cancelled passkey puts it back and says so
  const sw = $(rowOf(el, "vault.lock_on_sleep"), "button.sw");
  const api2 = fakeSettings({ noProof: true });
  const { el: el2 } = await render(api2);
  const sw2 = $(rowOf(el2, "vault.lock_on_sleep"), "button.sw");
  await sw2.click(); await tick();
  await $(rowOf(el2, "vault.lock_on_sleep"), "button.sk-yes").click(); await tick();
  assert.equal(api2.writes("settings.set").at(-1).opts.presence, true);
  assert.equal(sw2.getAttribute("aria-checked"), "true", "back to on");
  assert.match(text(rowOf(el2, "vault.lock_on_sleep")), /Not saved\s+The passkey was cancelled/);
  assert.equal(sw.getAttribute("aria-checked"), "true");

  // resetting a loosening key also asks, and proves presence
  await wait(60);
  await $(row, "button.sk-reset").click(); await tick();
  assert.equal(api.of("settings.reset").at(-1).input.preview, true);
  assert.match(text($(row, ".sk-ask")), /Reset to default needs your passkey\./);
  await $(row, "button.sk-yes").click(); await tick();
  const r = api.writes("settings.reset").at(-1);
  assert.deepEqual(r.input, { key: "vault.lock_idle", level: "account" });
  assert.equal(r.opts.presence, true);
  assert.equal(api.account["vault.lock_idle"], undefined);
});

test("settings keys: a key the box asks about that the schema did not mark still asks on the row", async () => {
  const api = fakeSettings();
  // This page's copy of the schema lost the confirm; the box still has it.
  const orig = api.attempt;
  const attempt = async (tool, input, opts) => {
    const x = await orig(tool, input, opts);
    if (tool === "settings.schema") for (const k of x.data.keys) if (k.key === "sessions.mode") delete k.confirm;
    return x;
  };
  const { el } = await render({ ...api, attempt });
  const sel = $(rowOf(el, "sessions.mode"), "select");
  sel.value = "auto"; sel.dispatchEvent(new Event("change")); await tick(); await tick();
  assert.equal($(rowOf(el, "sessions.mode"), ".sk-ask").hidden, false, "confirm_required opens the line");
  assert.equal(sel.value, "auto");
  await $(rowOf(el, "sessions.mode"), "button.sk-yes").click(); await tick();
  assert.equal(api.account["sessions.mode"], "auto");
});

test("settings keys: reset names where it goes, Undo stays 4 s and sets the old value again", async () => {
  const api = fakeSettings({ account: { "chat.thinking": "open" } });
  const { el } = await render(api);
  assert.equal(src(el, "chat.thinking"), "account");
  const btn = $(rowOf(el, "chat.thinking"), "button.sk-reset");
  assert.equal(text(btn), "Reset to default", "never a bare Reset");
  await btn.click(); await tick();
  assert.deepEqual(api.of("settings.reset")[0].input, { key: "chat.thinking", level: "account" });
  assert.equal(src(el, "chat.thinking"), "none");
  assert.equal($(rowOf(el, "chat.thinking"), '.seg button[aria-pressed="true"]').textContent, "folded");
  assert.match(slot(el, "chat.thinking"), /^Reset to default\s*Undo$/);
  await $(rowOf(el, "chat.thinking"), "button.sk-undo").click(); await tick();
  assert.deepEqual(api.of("settings.set").at(-1).input, { key: "chat.thinking", level: "account", value: "open" });
  assert.equal(api.account["chat.thinking"], "open");
  assert.equal(slot(el, "chat.thinking"), "Saved");
  // Saved holds the slot for a moment, then the reset ghost is back; Undo goes away on its own
  assert.equal($(rowOf(el, "chat.thinking"), "button.sk-reset"), null);
  await wait(60);
  await $(rowOf(el, "chat.thinking"), "button.sk-reset").click(); await tick();
  assert.ok($(rowOf(el, "chat.thinking"), "button.sk-undo"));
  await wait(90);
  assert.equal($(rowOf(el, "chat.thinking"), "button.sk-undo"), null);
  assert.equal(slot(el, "chat.thinking"), "", "nothing left to reset");
});

test("settings keys: the restart banner counts this visit's restart changes", async () => {
  const api = fakeSettings();
  const { el } = await render(api);
  const banner = $(el, ".sk-banner");
  assert.equal(banner.hidden, true);
  // a session key is not counted
  await $(rowOf(el, "sessions.fast"), "button.sw").click(); await tick();
  assert.equal(banner.hidden, true);
  const idle = $(rowOf(el, "sessions.idle_minutes"), "input");
  idle.value = "20"; idle.dispatchEvent(new Event("input")); idle.dispatchEvent(new Event("blur"));
  await tick(); await tick();
  assert.equal(banner.hidden, false);
  assert.match(text(banner), /^1 change applies after restart Close an idle session after \(minutes\)$/);
  await $(rowOf(el, "sessions.terminals"), 'button[data-value="8"]').click(); await tick();
  assert.match(text(banner), /^2 changes apply after restart Close an idle session after \(minutes\), Terminals open at once$/);
  // the same key again is still one change; putting it back takes it off
  await $(rowOf(el, "sessions.terminals"), 'button[data-value="2"]').click(); await tick();
  assert.match(text(banner), /^2 changes/);
  await wait(60);
  await $(rowOf(el, "sessions.terminals"), "button.sk-reset").click(); await tick();
  assert.match(text(banner), /^1 change applies after restart/);
  // a refused write is not a change
  api.refuse("no");
  await $(rowOf(el, "sessions.terminals"), 'button[data-value="1"]').click(); await tick();
  assert.match(text(banner), /^1 change applies/);
});

test("settings keys: Project scope hides account-only keys, says so, and links back to Account", async () => {
  const api = fakeSettings({ account: { "sessions.effort": "high" }, project: { "harlow-legal": { "sessions.fast": true } } });
  const { el } = await render(api);
  const line = $(el, ".sk-acct-only");
  assert.equal(line.hidden, true, "not in Account scope");
  const proj = $(el, 'button[data-level="project"]');
  assert.equal(proj.disabled, false);
  await proj.click(); await tick();
  assert.deepEqual(api.of("settings.get").at(-1).input, { project: "harlow-legal" });
  const sel = $(el, "select.sk-proj");
  assert.equal(sel.hidden, false);
  assert.deepEqual(sel.options().map(o => o.textContent), ["Harlow Legal", "Northwind Bakery"]);
  // account-only: hidden, and one line says so
  assert.equal(rowOf(el, "sessions.model").hidden, true);
  assert.equal(rowOf(el, "chat.thinking").hidden, true);
  assert.equal($(el, "section#vault").hidden, true, "a group of account-only keys goes too");
  assert.equal($(el, "section#set-notifications").hidden, true);
  assert.equal(line.hidden, false);
  assert.match(text(line), /Some settings are set for your account only/);
  // a project value, and an inherited account value
  assert.equal(src(el, "sessions.fast"), "project");
  assert.equal(src(el, "sessions.effort"), "account");
  assert.equal($(rowOf(el, "sessions.effort"), "button.sk-reset"), null, "set at account, not here");
  const eff = $(rowOf(el, "sessions.effort"), "select");
  eff.value = "low"; eff.dispatchEvent(new Event("change")); await tick();
  assert.deepEqual(api.of("settings.set").at(-1).input, { key: "sessions.effort", level: "project", project: "harlow-legal", value: "low" });
  assert.equal(api.project["harlow-legal"]["sessions.effort"], "low");
  assert.equal(api.account["sessions.effort"], "high");
  // reset in the project falls back to the account's value, and says so
  await wait(60);
  const rb = $(rowOf(el, "sessions.effort"), "button.sk-reset");
  assert.equal(text(rb), "Reset to Account");
  await rb.click(); await tick();
  assert.equal(src(el, "sessions.effort"), "account");
  assert.equal(eff.value, "high");
  assert.match(slot(el, "sessions.effort"), /^Reset to Account/);
  // another project
  sel.value = "northwind-bakery"; sel.dispatchEvent(new Event("change")); await tick();
  assert.equal(src(el, "sessions.fast"), "none");
  // the link goes back to Account
  await $(line, "button.sk-link").click(); await tick();
  assert.equal($(el, 'button[data-level="account"]').getAttribute("aria-pressed"), "true");
  assert.equal(rowOf(el, "sessions.model").hidden, false);
  assert.equal(line.hidden, true);
  assert.deepEqual(api.of("settings.get").at(-1).input, {});
});

test("settings keys: J and K move between visible rows, / focuses search, and text fields keep their letters", async () => {
  const { el, press } = await render();
  /** @type {any} */ (doc).activeElement = null;
  press("j");
  assert.equal(/** @type {any} */ (doc).activeElement, rowOf(el, "sessions.model"), "J starts at the first row");
  press("j");
  assert.equal(/** @type {any} */ (doc).activeElement, rowOf(el, "sessions.model_fallback"));
  press("k"); press("k");
  assert.equal(/** @type {any} */ (doc).activeElement, rowOf(el, "sessions.model"), "K stops at the top");
  // hidden rows (advanced) are skipped: from Output style, J goes past How sessions sign in
  rowOf(el, "sessions.output_style").focus();
  press("j");
  assert.equal(/** @type {any} */ (doc).activeElement, rowOf(el, "glass.handback_minutes"));
  // from a control inside a row, J goes to the next row
  $(rowOf(el, "sessions.fast"), "button.sw").focus();
  press("J");
  assert.equal(/** @type {any} */ (doc).activeElement, rowOf(el, "sessions.mode"));
  // in a text field, J is a letter
  const out = $(rowOf(el, "sessions.output_style"), "input");
  out.focus();
  press("j", out);
  assert.equal(/** @type {any} */ (doc).activeElement, out);
  press("/", out);
  assert.equal(/** @type {any} */ (doc).activeElement, out, "and so is /");
  // / from anywhere else focuses Find a setting
  rowOf(el, "sessions.fast").focus();
  press("/");
  assert.equal(/** @type {any} */ (doc).activeElement, $(el, "input.sk-find"));
  // modifiers are someone else's shortcut
  rowOf(el, "sessions.fast").focus();
  press("k", rowOf(el, "sessions.fast"), { metaKey: true });
  assert.equal(/** @type {any} */ (doc).activeElement, rowOf(el, "sessions.fast"));
});

test("settings keys: a module that is off, and a problem, show on the row", async () => {
  const api = fakeSettings({ off: ["push.watch"], problems: { "sessions.deny": "~/.claude/settings.json is not valid JSON" } });
  const { el } = await render(api);
  const ask = rowOf(el, "push.watch");
  assert.ok(ask.classList.contains("sk-dim"));
  assert.match(text(ask), /Its module is off/);
  assert.equal($(ask, "button.sw").disabled, true);
  assert.match(text(rowOf(el, "sessions.deny")), /is not valid JSON/);
});

test("settings keys: settings.changed refreshes only the row it names", async () => {
  const api = fakeSettings();
  const { el, emit } = await render(api);
  const other = rowOf(el, "sessions.effort");
  api.account["sessions.fast"] = true; // another device changed it
  const gets = api.of("settings.get").length;
  await emit("settings.changed", { key: "sessions.fast", level: "account", apply: "session" }); await tick();
  assert.deepEqual(api.of("settings.get").slice(gets).map(c => c.input), [{ key: "sessions.fast" }], "one row asked for, not the list");
  assert.equal($(rowOf(el, "sessions.fast"), "button.sw").getAttribute("aria-checked"), "true");
  assert.equal(rowOf(el, "sessions.effort"), other);
  // a project's change while showing the account is not ours
  await emit("settings.changed", { key: "sessions.fast", level: "project", project: "harlow-legal", apply: "session" }); await tick();
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
  assert.equal(out.reveal("sessions.env"), true);
  assert.equal(rowOf(el, "sessions.env").hidden, false, "advanced opened for it");
  assert.ok(rowOf(el, "sessions.env").classList.contains("sk-hi"));
  assert.equal(out.reveal("nope"), false);
});

test("settings keys: the keydown listener goes when the view does", async () => {
  const { cleanups, press, el } = await render();
  for (const fn of cleanups) fn();
  /** @type {any} */ (doc).activeElement = null;
  press("j");
  assert.equal(/** @type {any} */ (doc).activeElement, null);
  assert.ok(el);
});

test("settings keys: without the settings module, one section says so", async () => {
  const { el, out } = await render(fakeSettings({ missing: ["settings.schema"] }));
  assert.deepEqual(out.groups, []);
  assert.match(text(el), /These settings are kept by the settings module\..*The settings module is not running/);
});
