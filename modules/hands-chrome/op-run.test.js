// @ts-check
// chrome.op.run on the box, through the real Registry: only the connectors module may call it; the operation is found in the site record; the agent's hands must be allowed to act; it runs in the
// agent's own Chrome (a fake page here) and reports its outcome to the store. The login is the profile's, so nothing here depends on the Mac.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome } from "../../test/helpers.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://app.example.com";
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const people = (/** @type {string} */ t, key = "results") => ({ total: 1, [key]: [{ id: "p-1", name: `${t} one`, profileUrl: "u", headline: "h", meta: { score: 1, tags: [] } }] });

/** Stand-ins for the modules the box module leans on: the computers (an endpoint, may-act) and the site record (get, report). A module's tools carry its own name, so there are two. */
const stub = (/** @type {string} */ name, /** @type {Record<string, string>} */ tools) => `export default { async start(ctx) {
  const g = globalThis.__rig = globalThis.__rig || { reports: [], puts: [], mayAct: { ok: true } };
  const t = (n, run) => ctx.tool(n, { effect: "read", description: "x", input: { type: "object" }, run });
  ${Object.entries(tools).map(([n, body]) => `t("${name}.${n}", ${body});`).join("\n  ")}
  return {};
} };`;
const COMPUTERS = stub("computers", { endpoint: `async () => ({ helper: { url: "http://computerd.invalid", token: "t" } })`, "may-act": `async () => g.mayAct` });
const MEMORY = stub("memory", { "site.get": `async () => ({ origin: g.record, rev: 1 })`, "site.report": `async i => { g.reports.push(i); return { conf: 0.6 }; }`, "site.put": `async i => { g.puts.push(i); return { accepted: true }; }` });

/** A fake page and the Cdp-shaped connection to it. */
function fakePool() {
  const st = { url: `${ORIGIN}/feed`, fetches: /** @type {any[]} */ ([]), navigations: /** @type {string[]} */ ([]), listKey: "results", brokenAfterTrigger: false };
  /** @type {Array<(m: any) => void>} */ const listeners = [];
  const cdp = {
    page: async () => "s1",
    on: (/** @type {(m: any) => void} */ fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    waitFor: (/** @type {(m: any) => boolean} */ pred, ms = 1000) => new Promise(resolve => { const off = cdp.on(m => { if (pred(m)) { off(); resolve(m); } }); setTimeout(() => { off(); resolve(null); }, ms); }),
    async send(/** @type {string} */ method, /** @type {any} */ params) {
      if (method === "Page.navigate") {
        st.navigations.push(params.url);
        st.url = params.url;
        const q = new URL(params.url).searchParams.get("q") || "";
        // the page makes its own request as it loads, and the site answers it
        setImmediate(() => {
          const rid = "t" + st.navigations.length, emit = (/** @type {any} */ m) => { for (const l of [...listeners]) l({ sessionId: "s1", ...m }); };
          emit({ method: "Network.requestWillBeSent", params: { requestId: rid, type: "XHR", request: { method: "GET", url: `${ORIGIN}/api/v2/search?q=${encodeURIComponent(q)}&limit=20&_=1700000000000`, headers: { "x-csrf-token": F.CSRF, accept: "application/json" } } } });
          emit({ method: "Network.responseReceived", params: { requestId: rid, type: "XHR", response: { status: 200, headers: { "content-type": "application/json" }, mimeType: "application/json" } } });
          emit({ method: "Network.loadingFinished", params: { requestId: rid } });
          emit({ method: "Page.loadEventFired", params: {} });
        });
        return {};
      }
      if (method === "Network.getResponseBody") return { body: JSON.stringify(people(new URL(st.url).searchParams.get("q") || "", st.listKey)), base64Encoded: false };
      if (method === "Runtime.evaluate") {
        const e = String(params.expression);
        if (e.includes("localStorage")) return { result: { value: { origin: ORIGIN, url: st.url, cookie: { sid: F.SECRET_COOKIE }, local: { csrf: F.CSRF }, session: {} } } };
        if (e.includes("fetch(P.url")) {
          const P = JSON.parse(e.match(/\}\)\((\{.*\})\)$/s)?.[1] || "{}");
          st.fetches.push(P);
          if (st.brokenAfterTrigger && st.navigations.length) return { result: { value: { status: 500, mime: "application/json", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "nope" }) } } };
          return { result: { value: { status: 200, mime: "application/json", headers: { "content-type": "application/json" }, body: JSON.stringify(people(new URL(P.url).searchParams.get("q") || "", st.listKey)) } } };
        }
      }
      return {};
    },
  };
  return { st, pool: { get: async () => cdp, drop: async () => {}, closeAll: async () => {} }, cdp };
}

async function rig(/** @type {any} */ t) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  for (const [name, src, tools] of /** @type {[string, string, string[]][]} */ ([["computers", COMPUTERS, ["computers.endpoint", "computers.may-act"]], ["memory", MEMORY, ["memory.site.get", "memory.site.report", "memory.site.put"]]])) {
    const dir = path.join(home, "mods", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name, version: "0.0.1", roles: ["box"], does: { tools } }));
    fs.writeFileSync(path.join(dir, "index.js"), src);
  }
  const page = fakePool();
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "box", handsChrome: { pool: page.pool } } });
  const firstParty = reg.isFirstParty.bind(reg);
  reg.isFirstParty = (/** @type {string} */ d) => d.startsWith(path.join(home, "mods")) || firstParty(d);
  await reg.start([...discover([path.dirname(HERE)]).filter(m => m.dir === HERE), ...discover([path.join(home, "mods")])], { role: "box" });
  t.after(() => reg.stop && reg.stop());
  for (const n of ["computers", "memory", "chrome"]) { const st = reg.status().find((/** @type {any} */ m) => m.name === n); assert.equal(st && st.state, "running", JSON.stringify(st)); }
  const rigState = /** @type {any} */ (globalThis).__rig;
  rigState.record = { ops: [{ name: "searchPeople", kind: "read", version: 1, op: read() }] };
  rigState.reports = []; rigState.puts = []; rigState.mayAct = { ok: true };
  return { reg, page, state: rigState };
}
const call = (/** @type {any} */ r, /** @type {any} */ input, caller = "module:connectors") => r.reg.call("chrome.op.run", { agent: "ops", site: ORIGIN, name: "searchPeople", inputs: { query: "gamma labs" }, ...input }, caller);

test("the connectors module runs a kept operation in an agent's own Chrome: found in the site record, run by the page's own fetch, the outcome reported", async t => {
  const r = await rig(t);
  const out = await call(r);
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.data.ok, true, JSON.stringify(out.data));
  assert.equal(out.data.data[0].name, "gamma labs one");
  assert.equal(out.data.version, 1);
  assert.equal(r.page.st.fetches.length, 1);
  assert.equal(r.page.st.fetches[0].init.headers["x-csrf-token"], F.CSRF, "the reference came from the page's storage");
  assert.deepEqual(r.state.reports, [{ origin: ORIGIN, part: "ops", id: "searchPeople", outcome: "ok" }]);
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!JSON.stringify(out).includes(raw), `leaked ${raw}`);
});

test("nobody else may run it, a paused or taken-over computer does not, and an operation that is not kept is named", async t => {
  const r = await rig(t);
  for (const caller of ["cli", "mcp", "mcp:agent:ops", "module:gate", "module:flows"]) assert.ok((await call(r, {}, caller)).error, `${caller} ran it`);
  assert.equal(r.page.st.fetches.length, 0);
  r.state.mayAct = { ok: false, why: "a person has taken over this computer" };
  const paused = await call(r);
  assert.match(String(paused.error && paused.error.message), /taken over/);
  assert.equal(r.page.st.fetches.length, 0, "no request while a person holds the computer");
  r.state.mayAct = { ok: true };
  const none = await call(r, { name: "nothingHere" });
  assert.match(String(none.error && none.error.message), /no operation nothingHere is kept/);
  const bad = await call(r, { agent: "Not An Agent" });
  assert.match(String(bad.error && bad.error.message), /not an agent name/);
});

test("a read that drifted is repaired in the same Chrome: relearned from what the page sent, kept as a new version only after a replay answers, and the call returns the answer", async t => {
  const r = await rig(t);
  r.page.st.listKey = "items"; // the site moved its list from results to items
  const out = await call(r);
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.data.ok, true, JSON.stringify(out.data));
  assert.equal(out.data.healed, true);
  assert.equal(out.data.data[0].name, "gamma labs one");
  assert.equal(r.state.puts.length, 1, "the repair is kept once");
  const kept = r.state.puts[0].patch.ops[0];
  assert.deepEqual([r.state.puts[0].origin, kept.name, kept.kind, kept.op.response.extract], [ORIGIN, "searchPeople", "read", "items"]);
  assert.equal(r.page.st.navigations.length, 1, "the trigger ran once, on the operation's own site");
  assert.match(r.page.st.navigations[0], /^https:\/\/app\.example\.com\/search\?q=gamma%20labs$/);
  assert.deepEqual(r.state.reports.map((/** @type {any} */ x) => x.outcome), ["ok"], "the repaired call counts as a success, not a miss");
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!JSON.stringify([out, r.state.puts]).includes(raw), `leaked ${raw}`);
  // asked again within ten minutes: the stored (now repaired) version answers without another trigger
  r.state.record = { ops: [{ name: "searchPeople", kind: "read", version: 2, op: kept.op }] };
  const again = await call(r);
  assert.equal(again.data.ok, true);
  assert.equal(r.page.st.navigations.length, 1);
});

test("a repair that does not answer is not kept; the failure is reported honestly and the operation counts a miss; heal:false and a write never try", async t => {
  const r = await rig(t);
  r.page.st.listKey = "items";
  r.page.st.brokenAfterTrigger = true; // even the relearned request is refused
  const out = await call(r);
  assert.equal(out.data.ok, false);
  assert.equal(out.data.class, "drift", JSON.stringify(out.data));
  assert.equal(out.data.heal && out.data.heal.outcome, "failed");
  assert.match(String(out.data.next), /teach it again/);
  assert.equal(r.state.puts.length, 0, "nothing is kept");
  assert.deepEqual(r.state.reports.map((/** @type {any} */ x) => x.outcome), ["miss"]);
  const r2 = await rig(t);
  r2.page.st.listKey = "items";
  const off = await call(r2, { heal: false });
  assert.equal(off.data.class, "drift");
  assert.equal(r2.page.st.navigations.length, 0, "heal:false never runs the trigger");
  assert.equal(r2.state.puts.length, 0);
});
