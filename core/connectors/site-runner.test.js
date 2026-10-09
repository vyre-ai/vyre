// @ts-check
// The site runner's ladder: the cheapest rung that works answers, and the event says which. A public operation (no login) is fetched from here with no browser; an operation that needs the login
// goes to a signed-in browser; a rung with nothing to offer hands on to the next; a box has no "page" rung of its own.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSiteRunner, lightFor } from "./site.js";
import { siteDeclaration } from "../../records/connectors/site.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const pub = () => learnOperation({ name: "publicSearch", exchanges: F.pagePublic("alpha corp"), exchanges2: F.pagePublic("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const priv = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const entries = [{ name: "publicSearch", kind: "read", op: pub() }, { name: "searchPeople", kind: "read", op: priv() }];
const decl = siteDeclaration({ id: "linkedin", label: "LinkedIn", origin: ORIGIN, entries });

function rig(/** @type {any} */ o = {}) {
  /** @type {any[]} */ const calls = [], events = [], lights = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    calls.push([tool, input]);
    if (tool === "vault.fetch.public") return o.public ? o.public(input) : { data: { status: 200, type: "application/json", body: JSON.stringify({ total: 1, results: [{ id: "p-1", name: "public one", profileUrl: "u", headline: "h", meta: { score: 1, tags: [] } }] }) } };
    if (tool === "chrome.op.run") return o.page ? o.page(input) : { data: { ok: true, class: "ok", data: [{ name: "page one" }] } };
    return { error: { code: "no_such_tool", message: tool } };
  };
  const made = { row: (/** @type {string} */ id) => (id === "linkedin" ? { id, declaration: JSON.stringify(decl), ...(o.agent ? { form: JSON.stringify({ site: ORIGIN, agent: o.agent }) } : {}) } : null), touch: (/** @type {string} */ id, /** @type {string} */ l, /** @type {string} */ w) => lights.push([id, l, w]) };
  const runner = createSiteRunner({ call, made, emit: (type, p) => events.push([type, p]), entries: async (_o, names) => entries.filter(e => !names || names.includes(e.name)), role: o.role || "local" });
  return { runner, calls, events, lights };
}
const q = (/** @type {string} */ op, extra = {}) => ({ credential: "conn-linkedin", method: "GET", path: `/ops/${op}`, query: { query: "gamma labs" }, ...extra });

test("a public operation is fetched from here: no browser is asked, the answer is extracted, and the event names the rung", async () => {
  const r = rig();
  const out = await r.runner.run(q("public_search"));
  assert.equal(out.status, 200);
  assert.equal(/** @type {any} */ (out.data)[0].name, "public one");
  assert.deepEqual(r.calls.map(c => c[0]), ["vault.fetch.public"]);
  assert.match(r.calls[0][1].url, /^https:\/\/app\.example\.com\/api\/public\/search\?q=gamma(%20|\+)labs&limit=10$/);
  assert.equal(r.calls[0][1].raw, true);
  assert.deepEqual(r.events.find(e => e[0] === "connectors.site-ran")[1], { id: "linkedin", op: "publicSearch", rung: "public", class: "ok" });
});

test("a refused public fetch hands on to a signed-in browser; an operation that needs the login never goes the public way", async () => {
  const r = rig({ public: () => ({ data: { status: 403, type: "text/html", body: "<html>Please sign in to continue</html>" } }) });
  const out = await r.runner.run(q("public_search"));
  assert.equal(out.status, 200);
  assert.deepEqual(r.calls.map(c => c[0]), ["vault.fetch.public", "chrome.op.run"]);
  assert.equal(r.events.find(e => e[0] === "connectors.site-ran")[1].rung, "page");
  const priv = rig();
  await priv.runner.run(q("search_people"));
  assert.deepEqual(priv.calls.map(c => c[0]), ["chrome.op.run"], "a login is the browser's alone");
});

test("a box has no page rung of its own; with no rung able to serve, the answer is a plain 503 and the light says what to do", async () => {
  const r = rig({ role: "box", page: () => ({ error: { code: "no_such_tool", message: "no tool chrome.op.run" } }) });
  const out = await r.runner.run(q("search_people"));
  assert.equal(r.calls.filter(c => c[0] === "chrome.op.run").length, 0, "a box does not ask a Chrome it does not have");
  assert.ok(out.status >= 400, JSON.stringify(out));
  assert.deepEqual(lightFor("auth", "app.example.com").light, "red");
  assert.match(lightFor("no_browser", "app.example.com").words, /signed-in browser/);
});

test("on a box the login lives in an agent's own Chrome: that rung runs it with the Mac off, and a login that ran out raises the card for that computer", async () => {
  const r = rig({ role: "box", agent: "ops" });
  const out = await r.runner.run(q("search_people"));
  assert.equal(out.status, 200);
  assert.deepEqual(r.calls.map(c => c[0]), ["chrome.op.run"]);
  assert.equal(r.calls[0][1].agent, "ops");
  assert.equal(r.events.find(e => e[0] === "connectors.site-ran")[1].rung, "box");
  const walled = rig({ role: "box", agent: "ops", page: () => ({ data: { ok: false, class: "auth", reason: "the browser is on a sign-in page (/login)" } }) });
  const bad = await walled.runner.run(q("search_people"));
  assert.equal(bad.status, 401);
  const card = walled.events.find(e => e[0] === "connectors.site-needs-signin")[1];
  assert.deepEqual([card.id, card.rung, card.agent], ["linkedin", "box", "ops"]);
  assert.match(walled.lights.at(-1)[2], /ops's computer: open its screen and sign in once/);
  const noAgent = rig({ role: "box" });
  assert.ok((await noAgent.runner.run(q("search_people"))).status >= 400);
  assert.equal(noAgent.calls.length, 0, "a box with no agent named for the login has no browser rung");
});
