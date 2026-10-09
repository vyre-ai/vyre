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
const people = (/** @type {string} */ t) => ({ total: 1, results: [{ id: "p-1", name: `${t} one`, profileUrl: "u", headline: "h", meta: { score: 1, tags: [] } }] });

/** Stand-ins for the modules the box module leans on: the computers (an endpoint, may-act) and the site record (get, report). */
const STUBS = `export default { async start(ctx) {
  const g = globalThis.__rig = globalThis.__rig || { reports: [], mayAct: { ok: true } };
  const t = (n, run) => ctx.tool(n, { effect: "read", description: "x", input: { type: "object" }, run });
  t("computers.endpoint", async () => ({ helper: { url: "http://computerd.invalid", token: "t" } }));
  t("computers.may-act", async () => g.mayAct);
  t("memory.site.get", async i => ({ origin: g.record, rev: 1 }));
  t("memory.site.report", async i => { g.reports.push(i); return { conf: 0.6 }; });
  return {};
} };`;

/** A fake page and the Cdp-shaped connection to it. */
function fakePool() {
  const st = { url: `${ORIGIN}/feed`, fetches: /** @type {any[]} */ ([]) };
  /** @type {Array<(m: any) => void>} */ const listeners = [];
  const cdp = {
    on: (/** @type {(m: any) => void} */ fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    waitFor: (/** @type {(m: any) => boolean} */ pred, ms = 1000) => new Promise(resolve => { const off = cdp.on(m => { if (pred(m)) { off(); resolve(m); } }); setTimeout(() => { off(); resolve(null); }, ms); }),
    async send(/** @type {string} */ method, /** @type {any} */ params) {
      if (method === "Runtime.evaluate") {
        const e = String(params.expression);
        if (e.includes("localStorage")) return { result: { value: { origin: ORIGIN, url: st.url, cookie: { sid: F.SECRET_COOKIE }, local: { csrf: F.CSRF }, session: {} } } };
        if (e.includes("fetch(P.url")) {
          const P = JSON.parse(e.match(/\}\)\((\{.*\})\)$/s)?.[1] || "{}");
          st.fetches.push(P);
          return { result: { value: { status: 200, mime: "application/json", headers: { "content-type": "application/json" }, body: JSON.stringify(people(new URL(P.url).searchParams.get("q") || "")) } } };
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
  const dir = path.join(home, "mods", "stubs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify({ name: "stubs", version: "0.0.1", roles: ["box"], does: { tools: ["computers.endpoint", "computers.may-act", "memory.site.get", "memory.site.report"] } }));
  fs.writeFileSync(path.join(dir, "index.js"), STUBS);
  const page = fakePool();
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "box", handsChrome: { pool: page.pool } } });
  const firstParty = reg.isFirstParty.bind(reg);
  reg.isFirstParty = (/** @type {string} */ d) => d.startsWith(path.join(home, "mods")) || firstParty(d);
  await reg.start([...discover([path.dirname(HERE)]).filter(m => m.dir === HERE), ...discover([path.join(home, "mods")])], { role: "box" });
  t.after(() => reg.stop && reg.stop());
  const st = reg.status().find((/** @type {any} */ m) => m.name === "stubs");
  assert.equal(st && st.state, "running", JSON.stringify(st));
  const rigState = /** @type {any} */ (globalThis).__rig;
  rigState.record = { ops: [{ name: "searchPeople", kind: "read", version: 1, op: read() }] };
  rigState.reports = []; rigState.mayAct = { ok: true };
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
