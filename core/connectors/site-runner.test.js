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
  const made = { row: (/** @type {string} */ id) => (id === "linkedin" ? { id, declaration: JSON.stringify(decl), ...(o.agent ? { form: JSON.stringify({ site: ORIGIN, agent: o.agent }) } : {}) } : null), touch: (/** @type {string} */ id, /** @type {string} */ l, /** @type {string} */ w, /** @type {string} */ cls) => lights.push([id, l, w, cls]) };
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
  assert.equal(walled.lights.at(-1)[3], "auth", "the class is kept with the light, so Needs you can say what to do");
  assert.equal(r.lights.at(-1)[3], "ok");
  const noAgent = rig({ role: "box" });
  assert.ok((await noAgent.runner.run(q("search_people"))).status >= 400);
  assert.equal(noAgent.calls.filter(c => c[0] === "chrome.op.run").length, 0, "a box with no agent named for the login has no box-browser rung");
  assert.deepEqual(noAgent.calls.map(c => c[0]), ["link.macs.call"], "it asks the person's Mac instead");
});

// ---- the governor, wired into the runner ----
import { createGovernor } from "./governor.js";
const LI = "https://www.linkedin.com";
const liDecl = siteDeclaration({ id: "linkedin", label: "LinkedIn", origin: LI, entries });

function governed(/** @type {any} */ o = {}) {
  /** @type {any[]} */ const calls = [], events = [], sleeps = [];
  let active = 0, peak = 0;
  const clock = { t: Date.parse("2026-10-12T10:00:00Z") };
  const rows = new Map();
  const store = { get: (/** @type {string} */ id) => rows.get(id) ?? null, put: (/** @type {string} */ id, /** @type {any} */ s) => void rows.set(id, { ...s }) };
  const governor = createGovernor({ store, now: () => clock.t, random: () => 0.5 });
  const form = { site: LI, governor: { tz: "UTC", ...(o.limits || {}) } };
  const made = { row: (/** @type {string} */ id) => (id === "linkedin" ? { id, declaration: JSON.stringify(liDecl), form: JSON.stringify(form) } : null), touch: () => {} };
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    calls.push([tool, input]);
    if (tool !== "chrome.op.run") return { error: { code: "no_such_tool", message: tool } };
    active++; peak = Math.max(peak, active);
    await new Promise(r => setImmediate(r));
    active--;
    return { data: o.page ? o.page(input) : { ok: true, class: "ok", data: [{ name: "page one" }] } };
  };
  const runner = createSiteRunner({ call, made, emit: (type, p) => events.push([type, p]), entries: async (_o, names) => entries.filter(e => !names || names.includes(e.name)), governor, sleep: async ms => { sleeps.push(ms); clock.t += ms; } });
  return { runner, calls, events, sleeps, clock, governor, peak: () => peak };
}
const lq = (/** @type {string} */ op = "search_people") => ({ credential: "conn-linkedin", method: "GET", path: `/ops/${op}`, query: { query: "gamma labs" } });

test("a watched account is used at a person's pace: the second call waits its turn, one at a time, and the wait is the governor's", async () => {
  const g = governed({ limits: { quiet: null } });
  const [a, b, c] = await Promise.all([g.runner.run(lq()), g.runner.run(lq()), g.runner.run(lq())]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(g.peak(), 1, "never two at once on one account");
  assert.equal(g.sleeps.length, 2, "the first call went at once, the next two waited");
  assert.ok(g.sleeps.every(ms => ms >= 39_000 && ms <= 41_000), `a person's 20-60 s, here 40: ${g.sleeps}`);
});

test("the daily cap and the quiet hours refuse before the account is touched, and say why", async () => {
  const g = governed({ limits: { reads_per_day: 2, gap_read_s: [0, 0], quiet: null } });
  assert.equal((await g.runner.run(lq())).status, 200); assert.equal((await g.runner.run(lq())).status, 200);
  const third = await g.runner.run(lq());
  assert.equal(third.status, 429);
  assert.match(/** @type {any} */ (third.data).error.reason, /daily limit of 2 reads/);
  assert.equal(g.calls.filter(c => c[0] === "chrome.op.run").length, 2, "the third never reached the browser");
  const night = governed({});
  night.clock.t = Date.parse("2026-10-12T02:00:00Z");
  const q = await night.runner.run(lq());
  assert.equal(q.status, 429); assert.match(/** @type {any} */ (q.data).error.reason, /quiet hours: no calls until 07:00/);
  assert.equal(night.calls.length, 0);
});

test("the first challenge stops the account for good: nothing more is sent, no other rung is tried, and only a person resumes it", async () => {
  const g = governed({ limits: { gap_read_s: [0, 0], quiet: null }, page: () => ({ ok: false, class: "blocked", reason: "Checkpoint challenge page (HTTP 200)" }) });
  const hit = await g.runner.run(lq());
  assert.equal(hit.status, 403);
  assert.deepEqual(g.events.find(e => e[0] === "connectors.site-stopped")[1].id, "linkedin");
  const calls = g.calls.length;
  const again = await g.runner.run(lq());
  assert.equal(again.status, 403);
  assert.match(/** @type {any} */ (again.data).error.reason, /stopped after a challenge/);
  assert.equal(g.calls.length, calls, "stopped: nothing reached the browser");
  g.clock.t += 7 * 86_400_000;
  assert.equal((await g.runner.run(lq())).status, 403, "a week later it is still stopped");
  assert.equal(g.governor.resume("linkedin"), true);
  assert.equal(g.governor.admit({ id: "linkedin", kind: "read", settings: /** @type {any} */ ({ tz: "UTC", reads_per_day: 5, writes_per_day: 5, gap_read_s: [0, 0], gap_write_s: [0, 0], quiet: null, cooldown_min: 1 }) }).ok, true);
});

test("a site nobody watches is not slowed, and a public fetch never counts against an account", async () => {
  const r = rig();
  const out = await r.runner.run(q("search_people"));
  assert.equal(out.status, 200);
  const g = governed({ limits: { gap_read_s: [0, 0], reads_per_day: 1, quiet: null } });
  // the public operation (no login) is outside the account's day
  assert.equal(g.governor.usage("linkedin", /** @type {any} */ ({ tz: "UTC" })).reads, 0);
});
