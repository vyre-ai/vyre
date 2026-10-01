// @ts-check
// Settings > Connections > "Add a service": the connectors catalog and its connect steps. Sample world only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, { DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } }, dispatchEvent: () => true, CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } } });
const { drawCatalog, groupsOf, scopeLine } = await import("../views/connectors.js");

const CATALOG = { checked: 1, presets: [
  { id: "github", label: "GitHub", group: "Code", who: "GitHub", setup: "none", connected: [] },
  { id: "linear", label: "Linear", group: "Work", who: "Linear", setup: "none", connected: [{ name: "linear", mode: "read" }] },
  { id: "ghl", label: "GoHighLevel", group: "Work", who: "HighLevel", setup: "token", note: "A private integration token.", connected: [] },
  { id: "acme", label: "Acme", group: "Work", who: "Acme", setup: "app", connected: [] },
  { id: "gmail", label: "Gmail", group: "Google", who: "Google", setup: "via", via: "google", connected: [] },
] };
function world(answers = {}) {
  const calls = /** @type {any[]} */ ([]), subs = /** @type {any[]} */ ([]), opened = /** @type {string[]} */ ([]);
  const attempt = async (tool, input = {}) => {
    calls.push({ tool, input });
    const a = tool in answers ? (typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]) : {};
    return a && a.$error ? { error: a.$error } : { data: a };
  };
  const ctx = { alive: () => true, on: (t, fn) => subs.push([t, fn]), cleanup: () => {} };
  return { calls, subs, opened, attempt, ctx, of: t => calls.filter(c => c.tool === t) };
}
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));
async function mount(answers) {
  const w = world({ "connectors.catalog": CATALOG, ...answers });
  const el = doc.createElement("div");
  await drawCatalog(el, w.ctx, { attempt: w.attempt, open: u => w.opened.push(u) });
  return { ...w, el };
}
const row = (el, id) => $(el, `[data-preset=${id}]`);
/** Connect is now two taps: the row's Connect opens "Who can use it", and its Connect goes (the default: just me and the assistant). */
async function startConnect(m, id) { click($(row(m.el, id), "[data-act=connect]")); await settle(); click($(row(m.el, id), "[data-act=who-go]")); await settle(); }

test("groupsOf keeps the box's order and drops what is not a preset", () => {
  assert.deepEqual(groupsOf(CATALOG).map(g => [g.group, g.presets.map(p => p.id)]), [["Code", ["github"]], ["Work", ["linear", "ghl", "acme"]], ["Google", ["gmail"]]]);
  assert.deepEqual(groupsOf(null), []);
  assert.deepEqual(groupsOf({ presets: [{ id: "x" }, null, { label: "y" }] }), []);
});

test("the catalog draws by group with Connect, Add another and Disconnect; a via preset has no button", async () => {
  const m = await mount();
  assert.deepEqual($$(m.el, ".lbl").map(g => text(g)), ["Code", "Work", "Google"]);
  assert.equal(text($(row(m.el, "github"), "[data-act=connect]")), "Connect");
  assert.equal(text($(row(m.el, "linear"), "[data-act=connect]")), "Add another");
  assert.ok($(row(m.el, "linear"), "[data-act=disconnect]"));
  assert.equal($(row(m.el, "gmail"), "[data-act=connect]"), null);
  assert.match(text(row(m.el, "gmail")), /Comes through google/);
  assert.deepEqual(m.calls.map(c => c.tool), ["connectors.catalog"], "opening reads the catalog only");
});

test("an open step opens the https page, shows a paste box, and finish sends the pasted address", async () => {
  const m = await mount({ "connectors.connect": { step: "open", id: "f1", url: "https://linear.app/oauth?state=1", redirect: "http://127.0.0.1:9/cb", name: "linear" }, "connectors.connect.finish": {} });
  await startConnect(m, "github");
  assert.deepEqual(m.of("connectors.connect")[0].input, { preset: "github" });
  assert.deepEqual(m.opened, ["https://linear.app/oauth?state=1"]);
  const r = row(m.el, "github");
  click($(r, "[data-act=finish]")); await settle();
  assert.match(text(r), /Paste the address/);
  $(r, "input").value = " http://127.0.0.1:9/cb?code=abc ";
  click($(r, "[data-act=finish]")); await settle();
  assert.deepEqual(m.of("connectors.connect.finish")[0].input, { id: "f1", url: "http://127.0.0.1:9/cb?code=abc" });
});

test("a page that is not https is never opened; Cancel calls connectors.connect.cancel", async () => {
  const m = await mount({ "connectors.connect": { step: "open", id: "f2", url: "http://evil.example/x" } });
  await startConnect(m, "github");
  assert.deepEqual(m.opened, []);
  assert.equal($(row(m.el, "github"), "[data-act=open]"), null);
  click($(row(m.el, "github"), "[data-act=cancel]")); await settle();
  assert.deepEqual(m.of("connectors.connect.cancel")[0].input, { id: "f2" });
  assert.equal($(row(m.el, "github"), ".cn-flow"), null);
});

test("needs token: a hidden field and the extras, sent once, then the field is empty", async () => {
  let n = 0;
  const m = await mount({ "connectors.connect": () => (++n === 1 ? { step: "needs", needs: "token", label: "Private integration token", help: "Make one in HighLevel Settings.", extra: [{ name: "location", label: "Location ID", required: true }] } : { step: "connected", name: "ghl", tools: [1, 2, 3] }) });
  await startConnect(m, "ghl");
  const r = () => row(m.el, "ghl");
  assert.equal($(r(), "input[type=password]") != null, true, "the token field is hidden");
  fire($(r(), "form"), "submit"); await settle();
  assert.match(text(r()), /Paste the token first/);
  $(r(), "input[type=password]").value = "  pit-123 ";
  fire($(r(), "form"), "submit"); await settle();
  assert.match(text(r()), /Location ID is needed/);
  $(r(), "input[type=password]").value = "pit-123";
  $(r(), "[data-extra=location]").value = "loc9";
  fire($(r(), "form"), "submit"); await settle();
  assert.deepEqual(m.of("connectors.connect")[1].input, { preset: "ghl", token: "pit-123", extra: { location: "loc9" } });
  assert.match(text(m.el), /GoHighLevel is connected, 3 tools/);
});
const fire = (el, type) => el.dispatchEvent(new /** @type {any} */ (globalThis).Event(type));

test("needs client: the help and a vault item picker, read only then; Use it sends {client}", async () => {
  let n = 0;
  const m = await mount({ "connectors.connect": () => (++n === 1 ? { step: "needs", needs: "client", help: "Register an app and save its id in the vault.", redirect: "http://127.0.0.1:9/cb" } : { step: "connected", name: "acme" }),
    "vault.list": { items: [{ name: "acme-client" }, { name: "stripe" }] } });
  assert.equal(m.of("vault.list").length, 0);
  await startConnect(m, "acme");
  assert.equal(m.of("vault.list").length, 1);
  const r = () => row(m.el, "acme");
  assert.match(text(r()), /Register an app/);
  assert.deepEqual($$(r(), "option").map(o => text(o)), ["Choose an item", "acme-client", "stripe"]);
  click($(r(), "[data-act=client]")); await settle();
  assert.match(text(r()), /Choose the vault item first/);
  $(r(), "select").value = "acme-client";
  click($(r(), "[data-act=client]")); await settle();
  assert.deepEqual(m.of("connectors.connect")[1].input, { preset: "acme", client: "acme-client" });
});

test("a refused connect says so in plain words and the button comes back; disconnect calls connectors.disconnect", async () => {
  const m = await mount({ "connectors.connect": { $error: { code: "denied", message: "not yours" } }, "connectors.disconnect": {} });
  await startConnect(m, "github");
  assert.match(text($(row(m.el, "github"), "[role=alert]")), /not yours/);
  click($(row(m.el, "github"), "[data-act=cancel]")); await settle();
  click($(row(m.el, "linear"), "[data-act=disconnect]")); await settle();
  assert.deepEqual(m.of("connectors.disconnect")[0].input, { name: "linear" });
});

test("no connectors module on the box: one plain line, no error banner of raw text", async () => {
  const m = await mount({ "connectors.catalog": { $error: { code: "no_such_tool", message: "no such tool", missing: true, module: "connectors" } } });
  assert.match(text(m.el), /Connectors are not on this box yet/);
});

test("the events reload the catalog", async () => {
  const m = await mount();
  assert.deepEqual(m.subs.map(s => s[0]).sort(), ["connectors.connect-failed", "connectors.connected", "connectors.disconnected"]);
  m.subs.find(s => s[0] === "connectors.connected")[1]({ payload: {} });
  await settle();
  assert.equal(m.of("connectors.catalog").length, 2);
});

test("Connect asks who can use it first: the default sends no scope, All projects and chosen projects send one", async () => {
  const m = await mount({ "connectors.connect": { step: "connected", name: "github" }, "projects.list": { projects: [{ slug: "harlow-legal", name: "Harlow Legal" }, { slug: "northwind", name: "Northwind" }] } });
  click($(row(m.el, "github"), "[data-act=connect]")); await settle();
  assert.equal(m.of("connectors.connect").length, 0, "nothing is sent before the choice");
  const sel = $(row(m.el, "github"), "[data-who]");
  assert.equal(sel.value, "me", "the default is just me and the assistant");
  assert.deepEqual($$(row(m.el, "github"), "[data-who] option").map(o => text(o)), ["Just me and the assistant", "All projects, every agent", "Only these projects"]);
  click($(row(m.el, "github"), "[data-act=who-go]")); await settle();
  assert.deepEqual(m.of("connectors.connect")[0].input, { preset: "github" }, "the default writes nothing");
  // all projects
  click($(row(m.el, "github"), "[data-act=connect]")); await settle();
  const all = $(row(m.el, "github"), "[data-who]"); all.value = "all"; all.dispatchEvent(new /** @type {any} */ (globalThis).Event("change"));
  click($(row(m.el, "github"), "[data-act=who-go]")); await settle();
  assert.deepEqual(m.of("connectors.connect")[1].input, { preset: "github", scope: { projects: "*", agents: "*" } });
  // some projects: none chosen is refused, one chosen is sent
  click($(row(m.el, "github"), "[data-act=connect]")); await settle();
  const some = $(row(m.el, "github"), "[data-who]"); some.value = "some"; some.dispatchEvent(new /** @type {any} */ (globalThis).Event("change"));
  click($(row(m.el, "github"), "[data-act=who-go]")); await settle();
  assert.match(text(row(m.el, "github")), /Choose at least one project/);
  assert.equal(m.of("connectors.connect").length, 2);
  const box = $$(row(m.el, "github"), "[data-who-list] input")[1];
  box.checked = true; box.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("change"), { target: box }));
  click($(row(m.el, "github"), "[data-act=who-go]")); await settle();
  assert.deepEqual(m.of("connectors.connect")[2].input, { preset: "github", scope: { projects: ["northwind"], agents: "*" } });
});

test("the scope rides along to the next step: a token sent after the choice carries it", async () => {
  let n = 0;
  const m = await mount({ "connectors.connect": () => (++n === 1 ? { step: "needs", needs: "token", label: "Token", extra: [] } : { step: "connected", name: "ghl" }), "projects.list": { projects: [{ slug: "harlow-legal", name: "Harlow Legal" }] } });
  click($(row(m.el, "ghl"), "[data-act=connect]")); await settle();
  const sel = $(row(m.el, "ghl"), "[data-who]"); sel.value = "all"; sel.dispatchEvent(new /** @type {any} */ (globalThis).Event("change"));
  click($(row(m.el, "ghl"), "[data-act=who-go]")); await settle();
  $(row(m.el, "ghl"), "input[type=password]").value = "pit-secret-123";
  fire($(row(m.el, "ghl"), "form"), "submit"); await settle();
  assert.deepEqual(m.of("connectors.connect")[1].input, { preset: "ghl", scope: { projects: "*", agents: "*" }, token: "pit-secret-123" });
});

test("an existing connection's Who can use it: prefilled from its scope, saved through connectors.scope {name, scope}, the default as null", async () => {
  const cat = JSON.parse(JSON.stringify(CATALOG));
  cat.presets[1].connected = [{ name: "linear", mode: "read", scope: { projects: ["northwind"], agents: "*" } }];
  const m = await mount({ "connectors.catalog": cat, "connectors.scope": {}, "projects.list": { projects: [{ slug: "harlow-legal", name: "Harlow Legal" }, { slug: "northwind", name: "Northwind" }] } });
  click($(row(m.el, "linear"), "[data-act=who]")); await settle();
  assert.equal($(row(m.el, "linear"), "[data-who]").value, "some", "prefilled from what it carries");
  assert.equal($$(row(m.el, "linear"), "[data-who-list] input").filter(i => i.checked).map(i => i.value).join(), "northwind");
  const sel = $(row(m.el, "linear"), "[data-who]"); sel.value = "me"; sel.dispatchEvent(new /** @type {any} */ (globalThis).Event("change"));
  click($(row(m.el, "linear"), "[data-act=who-save]")); await settle();
  assert.deepEqual(m.of("connectors.scope")[0].input, { name: "linear", scope: null });
});

test("an error that echoes a typed token is shown with it hidden", async () => {
  const m = await mount({ "connectors.connect": i => (i.token ? { $error: { code: "bad_input", message: "token pit-secret-123 was refused" } } : { step: "needs", needs: "token", label: "Token", extra: [] }) });
  await startConnect(m, "ghl");
  $(row(m.el, "ghl"), "input[type=password]").value = "pit-secret-123";
  fire($(row(m.el, "ghl"), "form"), "submit"); await settle();
  assert.ok(!text(m.el).includes("pit-secret-123"));
  assert.match(text(m.el), /token \[hidden\] was refused/);
});

test("a connection's scope in words: the default, everything it granted before, named projects", async () => {
  assert.equal(scopeLine(null), "Just you and the assistant", "null is the box saying: the default");
  assert.equal(scopeLine(undefined), "Scope not recorded", "no scope key at all is unknown, never presented as the safe default");
  assert.equal(scopeLine({ projects: "*", agents: "*" }), "All projects, every agent");
  assert.equal(scopeLine({ projects: ["northwind", "harlow"], agents: "*" }), "northwind, harlow");
  assert.equal(scopeLine({ projects: "*", agents: ["kit"] }), "All projects, kit");
  const cat = JSON.parse(JSON.stringify(CATALOG));
  cat.presets[1].connected = [{ name: "linear", mode: "read", scope: { projects: "*", agents: "*" } }];
  const m = await mount({ "connectors.catalog": cat });
  assert.equal(text($(row(m.el, "linear"), "[data-scope-line=linear]")), "All projects, every agent");
});

test("a scope that is present but malformed (a string, an array) reads Scope not recorded, never the default", () => {
  const g = scope => groupsOf({ presets: [{ id: "x", label: "X", group: "G", setup: "none", connected: [{ name: "x", scope }] }] })[0].presets[0].connected[0].scope;
  assert.equal(g(null), null);
  assert.equal(g("all"), undefined);
  assert.equal(g(["a"]), undefined);
  assert.deepEqual(g({ projects: "*", agents: "*" }), { projects: "*", agents: "*" });
  assert.equal(scopeLine(g("all")), "Scope not recorded");
});
