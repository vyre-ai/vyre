// @ts-check
// The chrome module through the real Registry, with a fake extension on a real socket, the hands
// module beside it for the grant table, and a stand-in Gate: the tools register, an ungranted
// agent is refused, an agent must post a plan, the floor and Esc apply, a held act becomes a Gate
// card and is released (or refused as changed), and results arrive redacted.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry, validate } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome } from "../../test/helpers.js";
import { fakeApp } from "../hands-mac/fake.js";
import { fakeExtension, until } from "./fake-extension.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDS = path.join(path.dirname(HERE), "hands-mac");
const KIT = "mcp:agent:kit";
const PLAN = { steps: [{ id: "1", text: "Read the intake page" }, { id: "2", text: "Fill it in" }] };

/** A stand-in Gate: records gate.offer and gate.request, hands back an id. */
const GATE_JS = `export default { async start(ctx) {
  const seen = globalThis.__gate = { offers: [], requests: [] };
  ctx.tool("gate.offer", { effect: "read", description: "x", input: { type: "object" }, run: async i => { seen.offers.push(i); return { ok: true }; } });
  ctx.tool("gate.request", { effect: "read", description: "x", input: { type: "object" }, run: async i => {
    seen.requests.push(i);
    // A person's own words or a standing permission cover it: the real Gate releases at once, from inside gate.request, before any id is returned.
    if (globalThis.__gateSaid) { const r = await ctx.call("chrome.release", { id: "sent-1", to: [i.to], content: i.content }); return r.error ? { id: "sent-1", state: "held", error: r.error.message } : { id: "sent-1", state: "sent", result: r.data }; }
    return { id: "held-" + seen.requests.length };
  } });
  return {};
} };`;

async function rig(/** @type {any} */ t, { gate = true, nativeHost = /** @type {any} */ (null), floor = /** @type {any} */ (null), origin = /** @type {any} */ (null) } = {}) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-m-"));
  t.after(() => fs.rmSync(sockDir, { recursive: true, force: true }));
  const sockPath = path.join(sockDir, "chrome.sock");
  const gateDir = path.join(home, "mods", "gate");
  fs.mkdirSync(gateDir, { recursive: true });
  fs.writeFileSync(path.join(gateDir, "module.json"), JSON.stringify({ name: "gate", version: "0.0.1", roles: ["local"], does: { tools: ["gate.offer", "gate.request"] } }));
  fs.writeFileSync(path.join(gateDir, "index.js"), GATE_JS);
  const f = fakeApp({ elements: [] });
  const reg = new Registry({ db, events: new Events(db), log: () => {},
    config: { role: "local", hands: { runner: f.run, sleep: async () => {} }, chrome: { extensionOrigin: origin, sockPath, nativeHost, floor, home: sockDir, platform: "darwin", hostDir: sockDir } } });
  const found = [...discover([path.dirname(HERE)]).filter(m => m.dir === HERE || m.dir === HANDS), ...(gate ? discover([path.join(home, "mods")]) : [])];
  // The stand-in Gate stands for Vyre's own Gate module, which is first party; an added module could not call chrome.release.
  const firstParty = reg.isFirstParty.bind(reg);
  reg.isFirstParty = (/** @type {string} */ dir) => dir.startsWith(path.join(home, "mods")) || firstParty(dir);
  await reg.start(found, { role: "local" });
  t.after(() => reg.stop && reg.stop());
  const events = (/** @type {string} */ type) => reg.deps.events.since(0).filter((/** @type {any} */ e) => e.type === type);
  const online = () => until(async () => (await reg.call("chrome.status", {}, "cli")).data.connected);
  /** A fake extension, connected and known to the module. */
  const connect = async (/** @type {any} */ over) => { const x = await ext(sockPath, over); await online(); return x; };
  return { reg, sockPath, events, connect, gate: () => /** @type {any} */ (globalThis).__gate };
}

/** A fake extension with tabs and a snapshot, recording every op. */
const ext = (/** @type {string} */ sockPath, /** @type {any} */ over = {}) => fakeExtension(sockPath, {
  handler: (op, args, frame) => {
    // The fakes below read approvals the way the old wire carried them; they now arrive in frame.trust, so show them together.
    if (over[op]) return over[op]({ ...args, ...(frame && frame.trust ? frame.trust : {}) });
    if (op === "tabs.list") return { tabs: [
      { id: 1, url: "https://harlow.example/intake?token=abcdefghijklmnop", title: "Intake", attached: true },
      { id: 2, url: "https://chase.com/accounts", title: "Chase" },
      { id: 3, url: "https://crm.example.com/deals", title: "CRM" },
    ] };
    if (op === "page.snapshot") return { title: "Intake", url: "https://harlow.example/intake", controls: [{ role: "textbox", name: "Email" }] };
    return { ok: true };
  },
});


// ---- reviewer-2 probes on work/ancestry-real cb69aea6d: models admitted to chrome.* and hands.*; drop into local/hands-chrome-mac/ ----
test("RV2-MH1: a model with NO grant (unnamed mcp, mcp:thread, harness, hook, module) is refused in the body before Chrome and the Mac", async t => {
  const { reg, connect } = await rig(t);
  const x = await connect();
  const before = x.ops("page.snapshot").length + x.ops("tabs.list").length + x.ops("page.eval").length; // the module lists tabs once when the extension connects
  const out = {};
  for (const c of ["mcp", "mcp:thread:t1", "harness", "harness:thread:t1", "hook", "module:flows", "mcp:agent:kit", "anonymous"]) {
    for (const [tool, input] of [["chrome.snapshot", {}], ["chrome.tabs", { action: "list" }], ["chrome.eval", { expression: "1" }], ["hands.observe", {}], ["hands.act", { selector: { role: "button", title: "OK" }, kind: "press" }], ["hands.find", { role: "button" }]]) {
      const r = await reg.call(tool, input, c).catch(e => ({ error: { code: e.code } }));
      out[`${c} ${tool}`] = r.error ? r.error.code : "ALLOWED";
    }
  }
  console.log("MH1", JSON.stringify(out));
  const allowed = Object.entries(out).filter(([, v]) => v === "ALLOWED").map(([k]) => k);
  assert.deepEqual(allowed, [], "a model with no grant reached Chrome or the Mac: " + allowed.join(", "));
  assert.equal(x.ops("page.snapshot").length + x.ops("tabs.list").length + x.ops("page.eval").length, before, "no op reached the extension for a model with no grant");
});

test("RV2-MH2: a grant for one agent does not reach another or a different caller kind", async t => {
  const { reg, connect } = await rig(t);
  await connect();
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  const out = {};
  for (const c of ["mcp:agent:other", "harness:agent:other", "mcp:agent:kit2", "mcp:agent:kit", "harness:agent:kit"]) { const r = await reg.call("chrome.tabs", { action: "list" }, c).catch(e => ({ error: { code: e.code } })); out[c] = r.error ? r.error.code : "ok"; }
  console.log("MH2", JSON.stringify(out));
  assert.equal(out["mcp:agent:other"], "denied"); assert.equal(out["harness:agent:other"], "denied"); assert.equal(out["mcp:agent:kit2"], "denied");
});

test("RV2-MH3: person-only tools stay person-only for every model label", async t => {
  const { reg, connect } = await rig(t);
  await connect();
  const out = {};
  for (const c of ["mcp", "mcp:thread:t1", "harness", "mcp:agent:kit", "module:flows"]) for (const [tool, input] of [["hands.grant.add", { agent: "kit" }], ["hands.grant.remove", { agent: "kit" }], ["hands.pause", {}], ["hands.resume", {}], ["chrome.pause", {}], ["chrome.resume", { answer: "go" }], ["chrome.interject", { text: "x" }], ["chrome.voice", { text: "x" }], ["chrome.plan.edit", { step: "1", text: "x" }], ["chrome.install", {}]]) {
    const r = await reg.call(tool, input, c).catch(e => ({ error: { code: e.code } })); out[`${c} ${tool}`] = r.error ? r.error.code : "ALLOWED";
  }
  console.log("MH3", JSON.stringify(out));
  const allowed = Object.entries(out).filter(([, v]) => v === "ALLOWED").map(([k]) => k);
  assert.deepEqual(allowed, [], "person-only tool reached by a model: " + allowed.join(", "));
});

test("RV2-MH4: writeOk / asked / writeBudget from a model cannot ride a nested, renamed or cased key on chrome.api and chrome.batch", async t => {
  const { reg, connect } = await rig(t);
  const x = await connect({ "batch.run": a => ({ ok: true, seen: JSON.stringify(a).slice(0, 400) }), "api.call": a => ({ ok: true, seen: JSON.stringify(a).slice(0, 400) }) });
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  assert.ok((await reg.call("chrome.plan", PLAN, KIT, { thread: "t" })).data.ok);
  const forms = [{ writeOk: true }, { WriteOk: true }, { write_ok: true }, { "write-ok": true }, { asked: true }, { writeBudget: { create: 99, edit: 99 } }, { pointBudget: { click: 9 } }, { trust: { writeOk: true } }, { opts: { writeOk: true } }, { args: { writeOk: true } }, { "writeOk ": true }, { "writeOk​": true }, { ["__proto__"]: { writeOk: true } }];
  const out = [];
  for (const extra of forms) {
    for (const [tool, base] of [["chrome.api", { route: "x", hint: "contacts" }], ["chrome.batch", { steps: [{ op: "page.act", args: { selector: { role: "button" }, ...extra } }], ...extra }], ["chrome.batch", { steps: [{ op: "page.act", args: { selector: { role: "button" } } }], flow: { ...extra } }]]) {
      const r = await reg.call(tool, { ...base, ...extra }, KIT, { thread: "t" }).catch(e => ({ error: { code: e.code, message: e.message } }));
      const seen = r.data && r.data.seen || "";
      const leaked = /writeok|asked|writebudget|pointbudget/i.test(seen);
      out.push(`${tool} ${JSON.stringify(extra).slice(0, 40)} => ${r.error ? r.error.code : (leaked ? "REACHED-CHROME" : "ok-clean")}`);
    }
  }
  console.log("MH4\n" + out.join("\n"));
  assert.ok(!out.some(l => /REACHED-CHROME/.test(l)), out.filter(l => /REACHED/.test(l)).join("\n"));
});

test("RV2-MH5: which chrome.* and hands.* tools an unnamed mcp model can call with {} and no grant (reads and the non-dispatch tools)", async t => {
  const { reg, connect } = await rig(t);
  await connect();
  const names = reg.listTools("mcp").map(x => x.name).filter(n => /^(chrome|hands|apps|screen|sideview|voice|capsule)\./.test(n));
  const out = {};
  for (const n of names) { const r = await reg.call(n, {}, "mcp").catch(e => ({ error: { code: e.code } })); out[n] = r.error ? r.error.code : "ALLOWED"; }
  console.log("MH5", JSON.stringify(out));
  assert.ok(true);
});
