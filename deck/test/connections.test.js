// @ts-check
// Settings, Connections (deck/views/connections.js) rendered into a fake DOM (fake-dom.js) with a
// fake API answering from deck/fixtures/connections.json. Checks what it shows, the empty states,
// that each action calls the right tool with the right input, that Remove asks first, and that a
// value never reaches the page even when a reply carries one by mistake.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, text, everything, $, $$ } from "./fake-dom.js";

install();
const { drawConnections, pickServers, pickItems, itemsFor, toolModes, EVENTS } = await import("../views/connections.js");

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(DECK, "fixtures", "connections.json"), "utf8"));
const LEAK = "fixture-leak-7f3a9c";

const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
function fresh(v) {
  if (typeof v === "string") { const m = /^\$ago:(\d+)([smhd])$/.exec(v); return m ? Date.now() - Number(m[1]) * UNIT[m[2]] : v; }
  if (Array.isArray(v)) return v.map(fresh);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fresh(x)]));
  return v;
}

/**
 * A fake api.js attempt(): answers from the fixture (or `over`), records every call. A tool in
 * `missing` answers as a module that is not running.
 * @param {{ missing?: string[], over?: Record<string, any> }} [o]
 */
function fakeApi({ missing = [], over = {} } = {}) {
  const calls = /** @type {{ tool: string, input: any }[]} */ ([]);
  const attempt = async (tool, input = {}) => {
    calls.push({ tool, input: structuredClone(input) });
    if (missing.some(m => tool === m || tool.startsWith(m + "."))) {
      return { error: { code: "no_such_tool", message: `no tool ${tool}`, tool, module: tool.split(".")[0], missing: true } };
    }
    const src = tool in over ? over[tool] : FIXTURE[tool];
    if (src === undefined) return { error: { code: "no_such_tool", message: `no tool ${tool}`, tool, module: tool.split(".")[0], missing: true } };
    if (src && src.$error) return { error: src.$error };
    const entry = src && typeof src === "object" && "$by" in src ? (src.cases[input[src.$by]] ?? src.cases["*"]) : src;
    return { data: fresh(structuredClone(entry)) };
  };
  return { attempt, calls, of: t => calls.filter(c => c.tool === t) };
}

/** A presence stand-in: records each proof asked for; `fail` makes it refuse. */
function fakePresence({ fail = false } = {}) {
  const asked = /** @type {{ tool: string, input: any, o: any }[]} */ ([]);
  const presence = async (tool, input, o) => {
    asked.push({ tool, input, o });
    if (fail) throw Object.assign(new Error("No passkey is enrolled."), { state: "no_passkey" });
    return { grant: { status: "active" } };
  };
  return { presence, asked };
}

async function render(o = {}, p = fakePresence()) {
  const api = fakeApi(o);
  const el = document.createElement("div");
  const subs = /** @type {[string, Function][]} */ ([]);
  const cleanups = /** @type {Function[]} */ ([]);
  const ctx = { on: (t, fn) => subs.push([t, fn]), cleanup: fn => cleanups.push(fn), alive: () => true };
  await drawConnections(/** @type {any} */ (el), ctx, { attempt: /** @type {any} */ (api.attempt), presence: /** @type {any} */ (p.presence) });
  return { el, api, p, subs, cleanups };
}

const server = (el, name) => $(el, `[data-server=${name}]`);
const account = (el, name) => $(el, `[data-account=${name}]`);
const noLeak = el => assert.ok(!everything(el).includes(LEAK), "a value from a stray reply field reached the page");
const select = (sel, v) => { sel.value = v; sel.dispatchEvent(new Event("change")); };
const type = (input, v) => { input.value = v; };
const submit = form => Promise.all(form.dispatchEvent(new Event("submit")));

// ---- render ------------------------------------------------------------------------------------

test("renders every server and account with names only", async () => {
  const { el, api } = await render();
  assert.deepEqual(api.calls.map(c => c.tool).sort(), ["google.accounts", "mcp.servers"], "opening makes two calls, and never google.test");

  const t = text(server(el, "tracker"));
  assert.match(t, /tracker/);
  assert.match(t, /stdio/);
  assert.match(t, /running/);
  assert.match(t, /npx -y @northwind\/tracker-mcp/);
  assert.match(t, /TRACKER_TOKEN from tracker-token/);
  assert.match(t, /northwind-bakery · every agent/);
  assert.match(t, /2 h ago/);
  assert.match(text(server(el, "tracker")), /Tools\s*6/);

  const d = text(server(el, "docs"));
  assert.match(d, /http/);
  assert.match(d, /stopped/);
  assert.match(d, /Bearer token, from docs-api/);
  assert.match(d, /Every project · every agent/);
  assert.match(d, /Not listed yet/);
  assert.match(d, /Never/);

  const c = text(server(el, "crm"));
  assert.match(c, /failed/);
  assert.match(c, /the server answered 401 after a token refresh/);
  assert.match(c, /OAuth, from crm-oauth/);
  assert.match(c, /Every project · juno/);
  assert.equal($(server(el, "crm"), "[data-state=failed]").getAttribute("data-state"), "failed");

  const w = text(account(el, "work"));
  assert.match(w, /alex@harlowlegal\.com/);
  assert.match(w, /Service account acting as alex@harlowlegal\.com/);
  assert.match(w, /harlow-google-sa/);
  assert.match(w, /Not checked yet/);
  const b = text(account(el, "bakery"));
  assert.match(b, /OAuth/);
  assert.match(b, /northwind-google/);
  noLeak(el);
});

test("empty state when neither module runs, and each half on its own", async () => {
  const none = await render({ missing: ["mcp", "google"] });
  assert.match(text(none.el), /No connectors are running on this machine/);
  assert.equal($(none.el, "[data-act=add-mcp]"), null);

  const half = await render({ missing: ["mcp"] });
  assert.match(text(half.el), /The mcp module is not running on this machine/);
  assert.ok(account(half.el, "work"), "Google still lists its accounts");
  assert.equal($(half.el, "[data-act=add-mcp]"), null, "no add button without the module");

  const nothing = await render({ over: { "mcp.servers": [], "google.accounts": [] } });
  assert.match(text(nothing.el), /No MCP servers yet/);
  assert.match(text(nothing.el), /No Google account yet/);
});

test("a section that throws inside never escapes: bad replies still draw", async () => {
  const { el } = await render({ over: { "mcp.servers": { not: "a list" }, "google.accounts": [{ name: 7 }, null, { name: "x" }] } });
  assert.match(text(el), /No MCP servers yet/);
  assert.ok(account(el, "x"));
});

// ---- MCP actions -------------------------------------------------------------------------------

test("Test lists the tools, which are held, and sets a mode with mcp.update", async () => {
  const { el, api } = await render();
  await $(server(el, "tracker"), "button[data-act=test]").click();
  assert.deepEqual(api.of("mcp.test").map(c => c.input), [{ name: "tracker" }]);
  const panel = $(server(el, "tracker"), "[data-test=ok]");
  assert.ok(panel);
  assert.match(text(panel), /8 tools/);
  const pressed = tool => $(panel, `[data-tool=${tool}] button[aria-pressed=true]`).getAttribute("data-mode");
  assert.equal(pressed("create_issue"), "write", "set to write by the person");
  assert.equal(pressed("update_issue"), "write", "outward by the hub's reading: held");
  assert.equal(pressed("list_issues"), "read");
  assert.equal(pressed("archive_board"), "off", "an off tool the hub no longer lists is still shown");
  assert.equal($(panel, "[data-tool=comment_on_issue] button[data-mode=read]").disabled, true, "a tool that sends is never Read");
  assert.equal($(panel, "[data-tool=comment_on_issue] button[data-mode=off]").disabled, false);
  assert.equal($(panel, "[data-tool=list_issues] button[data-mode=read]").disabled, false);

  await $(panel, "[data-tool=delete_issue] button[data-mode=off]").click();
  assert.deepEqual(api.of("mcp.update").map(c => c.input), [{ name: "tracker",
    tools: { mode: { create_issue: "write", archive_board: "off", delete_issue: "off" } } }]);
  const again = $(server(el, "tracker"), "[data-test=ok]");
  assert.equal($(again, "[data-tool=delete_issue] button[aria-pressed=true]").getAttribute("data-mode"), "off");
  noLeak(el);
});

test("a failed test shows the scrubbed error and stderr; Restart calls mcp.restart", async () => {
  const { el, api } = await render();
  await $(server(el, "crm"), "button[data-act=test]").click();
  const f = $(server(el, "crm"), "[data-test=failed]");
  assert.match(text(f), /401 after a token refresh/);
  assert.match(text(f), /auth: token rejected/);
  await $(server(el, "crm"), "button[data-act=restart]").click();
  assert.deepEqual(api.of("mcp.restart").map(c => c.input), [{ name: "crm" }]);
});

test("Remove asks first; Cancel changes nothing; Remove then calls mcp.remove", async () => {
  const { el, api } = await render();
  await $(server(el, "docs"), "button[data-act=remove]").click();
  assert.equal(api.of("mcp.remove").length, 0, "nothing is removed on the first press");
  assert.match(text(server(el, "docs")), /Remove docs\? Its process stops/);
  await $(server(el, "docs"), "button[data-act=remove-no]").click();
  assert.equal($(server(el, "docs"), "button[data-act=remove-yes]"), null);
  assert.equal(api.of("mcp.remove").length, 0);

  await $(server(el, "docs"), "button[data-act=remove]").click();
  const before = api.of("mcp.servers").length;
  await $(server(el, "docs"), "button[data-act=remove-yes]").click();
  assert.deepEqual(api.of("mcp.remove").map(c => c.input), [{ name: "docs" }]);
  assert.equal(api.of("mcp.servers").length, before + 1, "the list is loaded again after a remove");
});

// ---- add MCP -----------------------------------------------------------------------------------

test("Add MCP server, stdio with env: mcp.add input, a presence grant, then a test", async () => {
  const { el, api, p } = await render();
  await $(el, "button[data-act=add-mcp]").click();
  assert.deepEqual(api.calls.slice(-3).map(c => c.tool).sort(), ["agents.list", "projects.list", "vault.list"]);
  const form = $(el, "form[data-form=mcp]");
  type($(form, "#cn-name"), "notes");
  type($(form, "#cn-command"), "npx");
  type($(form, "#cn-args"), "-y  @harlow/notes-mcp");
  select($(form, "#cn-auth"), "env");
  const row = $(form, ".cn-env-row");
  type($(row, ".cn-env-var"), "NOTES_TOKEN");
  // The env item picker lists api keys, secrets and env sets only, and nothing trashed.
  assert.deepEqual($$(row, "select.cn-item option").map(o => o.value).filter(Boolean),
    ["tracker-token", "docs-api", "crm-oauth", "launch-env", "northwind-google", "dana-google"]);
  select($(row, "select.cn-item"), "docs-api");
  await $(form, "input[data-scope-every=projects]").click();
  const hl = $$(form, "input[data-scope-one=projects]").find(b => b.value === "harlow-legal");
  assert.equal(hl.disabled, false, "unticking Every project enables the list");
  await hl.click();

  await submit(form);
  assert.deepEqual(api.of("mcp.add").map(c => c.input), [{ name: "notes", transport: "stdio", command: "npx", args: ["-y", "@harlow/notes-mcp"],
    env: { NOTES_TOKEN: "docs-api" }, auth: { type: "env" }, scope: { projects: ["harlow-legal"], agents: "*" } }]);
  assert.deepEqual(p.asked.map(a => [a.tool, a.input]), [["vault.grant", { name: "docs-api", module: "mcp" }]]);
  assert.equal(p.asked[0].o.command, "vyre vault grant docs-api mcp");
  assert.match(p.asked[0].o.summary, /Let mcp use .docs-api./);
  assert.deepEqual(api.of("mcp.test").map(c => c.input), [{ name: "notes" }], "tested again once the grant exists");
  assert.equal($(el, "form[data-form=mcp]"), null, "the form closes");
  noLeak(el);
});

test("Add MCP server, http with bearer: only fitting items; an item already granted asks nothing", async () => {
  const { el, api, p } = await render();
  await $(el, "button[data-act=add-mcp]").click();
  const form = $(el, "form[data-form=mcp]");
  await $(form, "button[data-transport=http]").click();
  type($(form, "#cn-name"), "tickets");
  type($(form, "#cn-url"), "https://tickets.example.com/mcp");
  assert.deepEqual($$(form, "#cn-auth option").map(o => o.value), ["none", "bearer", "oauth", "service-account"]);
  select($(form, "#cn-auth"), "bearer");
  assert.deepEqual($$(form, "#cn-item option").map(o => o.value).filter(Boolean), ["tracker-token", "docs-api"]);
  select($(form, "#cn-item"), "tracker-token");
  await submit(form);
  assert.deepEqual(api.of("mcp.add").map(c => c.input), [{ name: "tickets", transport: "http", url: "https://tickets.example.com/mcp",
    auth: { type: "bearer", item: "tracker-token" }, scope: { projects: "*", agents: "*" } }]);
  assert.equal(p.asked.length, 0, "tracker-token is already granted to mcp");
});

test("Add MCP server: a refused presence shows the exact grant command", async () => {
  const { el, api } = await render({}, fakePresence({ fail: true }));
  await $(el, "button[data-act=add-mcp]").click();
  const form = $(el, "form[data-form=mcp]");
  await $(form, "button[data-transport=sse]").click();
  type($(form, "#cn-name"), "wiki");
  type($(form, "#cn-url"), "https://wiki.example.com/sse");
  select($(form, "#cn-auth"), "oauth");
  assert.deepEqual($$(form, "#cn-item option").map(o => o.value).filter(Boolean), ["crm-oauth", "launch-env", "northwind-google", "dana-google"]);
  select($(form, "#cn-item"), "dana-google");
  await submit(form);
  assert.equal(api.of("mcp.add")[0].input.transport, "sse");
  assert.match(text($(el, "[data-grant=left]")), /vyre vault grant dana-google mcp/);
  assert.equal(api.of("mcp.test").length, 0, "no test while the grant is missing");
});

test("Add MCP server: missing fields are said, not sent", async () => {
  const { el, api } = await render();
  await $(el, "button[data-act=add-mcp]").click();
  const form = $(el, "form[data-form=mcp]");
  await $(form, "button[data-transport=http]").click();
  type($(form, "#cn-name"), "x");
  type($(form, "#cn-url"), "https://x.example.com/mcp");
  select($(form, "#cn-auth"), "bearer");
  await submit(form);
  assert.match(text(form), /Choose the vault item/);
  assert.equal(api.of("mcp.add").length, 0);
});

// ---- Google ------------------------------------------------------------------------------------

test("Google Test shows granted and refused scopes with the admin console hint", async () => {
  const { el, api } = await render();
  await $(account(el, "work"), "button[data-act=test]").click();
  assert.deepEqual(api.of("google.test").map(c => c.input), [{ name: "work" }]);
  const a = account(el, "work");
  assert.equal($(a, "[data-scope=gmail.send]").className.includes("refused"), true);
  assert.match(text($(a, "[data-scope=gmail.send]")), /refused/);
  assert.match(text($(a, "[data-scope=calendar.readonly]")), /granted/);
  assert.match(text($(a, "[data-hint=scopes]")), /Google Workspace admin console, under Security, API controls, Domain-wide delegation/);
  noLeak(el);
});

test("Add Google account, service account: google.add input, no grant needed, then google.test", async () => {
  const { el, api, p } = await render();
  await $(el, "button[data-act=add-google]").click();
  const form = $(el, "form[data-form=google]");
  type($(form, "#cg-name"), "harlow");
  type($(form, "#cg-email"), "dana@harlowlegal.com");
  await $(form, "button[data-auth=service-account]").click();
  assert.deepEqual($$(form, "#cg-item option").map(o => o.value).filter(Boolean), ["docs-api", "harlow-google-sa"], "notes and secrets only");
  select($(form, "#cg-item"), "harlow-google-sa");
  await submit(form);
  assert.deepEqual(api.of("google.add").map(c => c.input), [{ name: "harlow", email: "dana@harlowlegal.com", auth: { type: "service-account", item: "harlow-google-sa" } }]);
  assert.equal(p.asked.length, 0, "harlow-google-sa is already granted to google");
  assert.deepEqual(api.of("google.test").map(c => c.input), [{ name: "harlow" }]);
});

test("Add Google account, OAuth with a subject-free form: grants to google with presence", async () => {
  const { el, api, p } = await render();
  await $(el, "button[data-act=add-google]").click();
  const form = $(el, "form[data-form=google]");
  type($(form, "#cg-name"), "dana");
  type($(form, "#cg-email"), "dana@harlowlegal.com");
  assert.equal($(form, "#cg-subject"), null, "OAuth has no acts-as field");
  select($(form, "#cg-item"), "dana-google");
  await submit(form);
  assert.deepEqual(api.of("google.add")[0].input, { name: "dana", email: "dana@harlowlegal.com", auth: { type: "oauth", item: "dana-google" } });
  assert.deepEqual(p.asked.map(a => a.input), [{ name: "dana-google", module: "google" }]);
  assert.equal(p.asked[0].o.command, "vyre vault grant dana-google google");
});

test("Google Remove asks first, then calls google.remove", async () => {
  const { el, api } = await render();
  await $(account(el, "bakery"), "button[data-act=remove]").click();
  assert.equal(api.of("google.remove").length, 0);
  assert.match(text(account(el, "bakery")), /Disconnect bakery\?/);
  await $(account(el, "bakery"), "button[data-act=remove-yes]").click();
  assert.deepEqual(api.of("google.remove").map(c => c.input), [{ name: "bakery" }]);
});

// ---- lightness and events ----------------------------------------------------------------------

test("follows mcp.* and google.* events, with no timer of its own", async () => {
  const { subs, api, cleanups } = await render();
  assert.deepEqual(subs.map(s => s[0]).sort(), [...EVENTS].sort());
  const before = api.of("mcp.servers").length;
  for (const [, fn] of subs.slice(0, 3)) fn({});
  await new Promise(r => setTimeout(r, 460));
  assert.equal(api.of("mcp.servers").length, before + 1, "a burst of events is one reload");
  for (const f of cleanups) f();
  const src = fs.readFileSync(path.join(DECK, "views", "connections.js"), "utf8");
  assert.doesNotMatch(src, /setInterval|innerHTML/);
});

// ---- pickers -----------------------------------------------------------------------------------

test("pickers copy named fields only", () => {
  const s = pickServers([{ name: "a", transport: "http", auth: { type: "bearer", item: "k", value: LEAK }, env: { X: { item: "e", field: "F" } }, token: LEAK }]);
  assert.ok(!JSON.stringify(s).includes(LEAK));
  assert.deepEqual(s[0].env, [{ var: "X", item: "e", field: "F" }]);
  const items = pickItems({ items: [{ name: "k", kind: "api-key", value: LEAK, grants: [{ module: "mcp" }] }, { name: "t", kind: "note", trashed: true }] });
  assert.deepEqual(items, [{ name: "k", kind: "api-key", fields: [], grants: ["mcp"] }]);
  assert.deepEqual(itemsFor(items, "oauth"), []);
  assert.deepEqual(toolModes([{ tool: "b", outward: true }, { tool: "a", outward: false }], { c: "off", a: "write" }).map(t => [t.tool, t.mode]),
    [["a", "write"], ["b", "write"], ["c", "off"]]);
});
