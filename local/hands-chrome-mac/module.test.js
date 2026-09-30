// @ts-check
// The chrome module through the real Registry, with a fake extension on a real socket, the hands
// module beside it for the grant table, and a stand-in Gate: the tools register, an ungranted
// agent is refused, an agent must post a plan, the floor and Esc apply, a held act becomes a Gate
// card and is released (or refused as changed), and results arrive redacted.

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
  ctx.tool("gate.offer", { description: "x", input: { type: "object" }, run: async i => { seen.offers.push(i); return { ok: true }; } });
  ctx.tool("gate.request", { description: "x", input: { type: "object" }, run: async i => {
    seen.requests.push(i);
    // A person's own words or a standing permission cover it: the real Gate releases at once, from inside gate.request, before any id is returned.
    if (globalThis.__gateSaid) { const r = await ctx.call("chrome.release", { id: "sent-1", to: [i.to], content: i.content }); return r.error ? { id: "sent-1", state: "held", error: r.error.message } : { id: "sent-1", state: "sent", result: r.data }; }
    return { id: "held-" + seen.requests.length };
  } });
  return {};
} };`;

async function rig(/** @type {any} */ t, { gate = true, nativeHost = /** @type {any} */ (null), floor = /** @type {any} */ (null) } = {}) {
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
    config: { role: "local", hands: { runner: f.run, sleep: async () => {} }, chrome: { extensionOrigin: null, sockPath, nativeHost, floor, home: sockDir, platform: "darwin", hostDir: sockDir } } });
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
  handler: (op, args) => {
    if (over[op]) return over[op](args);
    if (op === "tabs.list") return { tabs: [
      { id: 1, url: "https://harlow.example/intake?token=abcdefghijklmnop", title: "Intake", attached: true },
      { id: 2, url: "https://chase.com/accounts", title: "Chase" },
      { id: 3, url: "https://crm.example.com/deals", title: "CRM" },
    ] };
    if (op === "page.snapshot") return { title: "Intake", url: "https://harlow.example/intake", controls: [{ role: "textbox", name: "Email" }] };
    return { ok: true };
  },
});

test("module: the manifest is valid and every tool it declares is registered", async t => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"))), []);
  const { reg, connect } = await rig(t);
  assert.equal(reg.status().find((/** @type {any} */ m) => m.name === "chrome")?.state, "running");
  const declared = JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")).does.tools.filter((/** @type {string} */ n) => n !== "chrome.release");
  const listed = reg.listTools().map((/** @type {any} */ x) => x.name);
  for (const name of declared) assert.ok(listed.includes(name), name);
  assert.ok(!listed.includes("chrome.release"), "release is internal: only the Gate calls it");
});

test("module: it offers chrome:mac to the Gate for acts, again before the first card if the Gate started late", async t => {
  const { reg, gate, connect } = await rig(t);
  await connect({ "page.act": () => ({ ok: false, held: true, control: { role: "button", name: "Send" }, fields: [], sig: "s0", url: "https://harlow.example/x" }) });
  await reg.call("chrome.act", { selector: { role: "button", name: "Send" }, kind: "click" }, "cli");
  const o = gate().offers.find((/** @type {any} */ x) => x.name === "chrome:mac");
  assert.deepEqual([o.tool, o.kinds], ["chrome.release", ["act"]]);
});

test("module: with no extension connected, a call says so", async t => {
  const { reg, connect } = await rig(t);
  const r = await reg.call("chrome.snapshot", {}, "cli");
  assert.equal(r.error.code, "no_extension");
});

test("module: a person's direct call goes through; blind tabs are left out and counted; the URL in the result is redacted", async t => {
  const { reg, sockPath, connect } = await rig(t);
  const x = await connect();
  const r = await reg.call("chrome.tabs", { action: "list" }, "cli");
  assert.deepEqual(r.data.tabs.map((/** @type {any} */ t) => t.id), [1, 3]);
  assert.equal(r.data.hidden, 1);
  assert.ok(!JSON.stringify(r).includes("chase"));
  assert.ok(!JSON.stringify(r).includes("abcdefghijklmnop"), "a token-shaped query value is masked");
  assert.equal(x.ops("tabs.list").length >= 1, true);
});

test("module: an agent that has not been granted is refused before anything reaches Chrome", async t => {
  const { reg, sockPath, connect } = await rig(t);
  const x = await connect();
  const r = await reg.call("chrome.snapshot", {}, KIT);
  assert.equal(r.error.code, "denied");
  assert.match(r.error.message, /not granted/);
  const p = await reg.call("chrome.plan", PLAN, KIT);
  assert.equal(p.error.code, "denied");
  assert.equal(x.ops("page.snapshot").length, 0);
});

test("module: a granted agent must post its plan first, then acts; chrome.acted carries a scrubbed URL and the labels", async t => {
  const { reg, sockPath, events, connect } = await rig(t);
  await connect();
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  const early = await reg.call("chrome.snapshot", {}, KIT);
  assert.equal(early.error.code, "plan_first");

  assert.ok((await reg.call("chrome.plan", PLAN, KIT, { thread: "t-kit-1" })).data.ok);
  assert.equal(events("chrome.plan")[0].payload.agent, "kit");
  const r = await reg.call("chrome.tabs", { action: "use", url: "https://harlow.example/intake?token=abcdefghijklmnop&x=1", openIfMissing: true }, KIT, { thread: "t-kit-1", call: "toolu_9" });
  assert.equal(r.error, undefined, JSON.stringify(r));
  const e = events("chrome.acted").at(-1);
  assert.deepEqual([e.payload.agent, e.payload.ok, e.payload.app, e.payload.thread, e.payload.call], ["kit", true, "Chrome", "t-kit-1", "toolu_9"]);
  assert.ok(!JSON.stringify(e.payload).includes("token"), "the query never reaches an event");
  assert.equal(e.thread, "t-kit-1");
  const snap = await reg.call("chrome.snapshot", {}, KIT);
  assert.equal(snap.data.title, "Intake");
});

test("module: the floor refuses a blind page before it is sent, a read-only page can be read and not acted on", async t => {
  const { reg, sockPath, events, connect } = await rig(t, { floor: { readonly: ["crm.example.com"] } });
  const x = await connect();
  const nav = await reg.call("chrome.tabs", { action: "navigate", tab: 1, url: "https://chase.com/login" }, "cli");
  assert.equal(nav.error.code, "blocked");
  assert.equal(x.ops("tabs.navigate").length, 0);
  assert.equal(events("chrome.acted").at(-1).payload.ok, false);
  await reg.call("chrome.tabs", { action: "list" }, "cli"); // teaches the module which tab is on which page
  const act = await reg.call("chrome.act", { tab: 3, selector: { role: "button", name: "Save" }, kind: "click" }, "cli");
  assert.equal(act.error.code, "blocked");
  assert.match(act.error.message, /read, not acted on/);
  const snap = await reg.call("chrome.snapshot", { tab: 3 }, "cli");
  assert.equal(snap.error, undefined);
  assert.equal(x.ops("page.act").length, 0);
});

test("module: results are redacted a second time before they are returned", async t => {
  const { reg, sockPath, connect } = await rig(t);
  await connect({ "page.eval": () => ({ ok: true, value: { cookie: "sid=abc123", title: "Inbox", auth: "Bearer abcdefghijklmnopqrstuvwxyz0123" } }) });
  const r = await reg.call("chrome.eval", { expression: "document.cookie" }, "cli");
  const s = JSON.stringify(r);
  assert.ok(!s.includes("abc123") && !s.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(r.data.value.title, "Inbox");
});

test("module: stop refuses the next op at once and tells the extension; resume needs a person; an interjection arrives once", async t => {
  const { reg, sockPath, events, connect } = await rig(t);
  const x = await connect();
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  assert.equal((await reg.call("chrome.snapshot", {}, KIT)).error, undefined);

  await reg.call("chrome.interject", { text: "use the work email", from: "voice" }, "capsule");
  const withNote = await reg.call("chrome.snapshot", {}, KIT);
  assert.equal(withNote.data.interjection, "use the work email");
  assert.equal((await reg.call("chrome.snapshot", {}, KIT)).data.interjection, undefined, "once");
  assert.equal((await reg.call("chrome.interject", { text: "x" }, KIT)).error.code, "denied", "an agent does not interject for the person");

  const stop = await reg.call("chrome.stop", { by: "esc" }, "capsule");
  assert.equal(stop.data.stopped, true);
  const again = await reg.call("chrome.stop", { by: "esc" }, "capsule");
  assert.equal(again.data.already, true);
  assert.equal(events("chrome.stopped").length, 1);
  assert.equal((await reg.call("chrome.snapshot", {}, KIT)).error.code, "stopped");
  assert.equal((await reg.call("chrome.snapshot", {}, "cli")).error.code, "stopped");
  await until(() => x.events().some(e => e.event === "stop"));

  assert.equal((await reg.call("chrome.resume", {}, KIT)).error.code, "denied", "the agent cannot resume itself");
  assert.ok((await reg.call("chrome.resume", { answer: "carry on" }, "capsule")).data.ok);
  await until(() => x.events().some(e => e.event === "resume"));
  const after = await reg.call("chrome.snapshot", {}, KIT);
  assert.equal(after.data.interjection, "carry on");
  assert.equal((await reg.call("chrome.resume", {}, "capsule")).error.code, "not_stopped");
});

test("module: a stop from the extension's own side stops Vyre too", async t => {
  const { reg, sockPath, connect } = await rig(t);
  const x = await connect();
  await x.send({ event: "stop" });
  await until(async () => (await reg.call("chrome.snapshot", {}, "cli")).error?.code === "stopped");
});

test("module: a held outward act becomes a Gate card with the fields and origin, and the release re-sends with the signature", async t => {
  const { reg, sockPath, gate, events, connect } = await rig(t);
  const held = { ok: false, held: true, why: "a submit button sends its form", control: { role: "button", name: "Send inquiry" }, fields: [{ name: "Email", value: "alex@example.com" }], sig: "sig-1", url: "https://harlow.example/intake" };
  const x = await connect({ "page.act": (/** @type {any} */ a) => a.release ? { ok: true, did: "click" } : held });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  const r = await reg.call("chrome.act", { selector: { role: "button", name: "Send inquiry" }, kind: "click", tab: 1 }, KIT, { thread: "t1" });
  assert.equal(r.data.held, true);
  assert.equal(r.data.id, "held-1");
  assert.equal(r.data.origin, "https://harlow.example");
  const req = gate().requests[0];
  assert.deepEqual([req.kind, req.via, req.to, req.thread], ["act", "chrome:mac", "https://harlow.example", "t1"]);
  assert.equal(req.content.app, "Chrome");
  assert.deepEqual(req.content.fields, [{ name: "Email", value: "alex@example.com" }]);
  assert.equal(req.content.control, "button Send inquiry");
  assert.deepEqual([req.content.op, req.content.args, req.content.signature], [undefined, undefined, undefined], "what to replay never rides on the card");
  assert.equal(x.ops("page.act")[0].args.asked, false, "an agent's own act was not asked for by the person");

  // Only the Gate releases.
  assert.equal((await reg.call("chrome.release", { id: "held-1", content: req.content }, "cli")).error.code, "no_such_tool");
  const rel = await reg.call("chrome.release", { id: "held-1", content: req.content }, "module:gate");
  assert.equal(rel.error, undefined, JSON.stringify(rel));
  assert.equal(rel.data.ok, true);
  const sent = x.ops("page.act")[1].args;
  assert.equal(sent.release.sig, "sig-1");
  assert.equal(sent.selector.name, "Send inquiry");
  assert.ok(events("chrome.acted").some((/** @type {any} */ e) => /released/.test(e.payload.summary)));
});

test("module: a send the person's words or a standing permission cover is released by the Gate at once, and the call returns its result", async t => {
  const { reg, gate, connect } = await rig(t);
  t.after(() => { delete /** @type {any} */ (globalThis).__gateSaid; });
  const x = await connect({ "page.act": (/** @type {any} */ a) => a.release
    ? { ok: true, sent: true }
    : { ok: false, held: true, control: { role: "button", name: "Send inquiry" }, fields: [], sig: "sig-9", url: "https://harlow.example/intake" } });
  /** @type {any} */ (globalThis).__gateSaid = true;
  const r = await reg.call("chrome.act", { selector: { role: "button", name: "Send inquiry" }, kind: "click", tab: 1 }, "cli");
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.data.sent, true, "the act went out and its result came back");
  assert.equal(x.ops("page.act")[1].args.release.sig, "sig-9", "release replayed what was held, found by its ref");
  // The ref is single-use: replaying it later finds nothing.
  const again = await reg.call("chrome.release", { id: "sent-1", content: gate().requests.at(-1).content }, "module:gate");
  assert.equal(again.error.code, "denied");
});

test("module: a release the extension refuses as changed comes back as changed and nothing is sent", async t => {
  const { reg, sockPath, gate, connect } = await rig(t);
  await connect({ "page.act": (/** @type {any} */ a) => {
    if (a.release) throw Object.assign(new Error("the page changed since it was held, so nothing was done; look again and ask again"), { code: "error" });
    return { ok: false, held: true, control: { role: "button", name: "Pay" }, fields: [], sig: "s2", url: "https://northwind.example/checkout" };
  } });
  const r = await reg.call("chrome.act", { selector: { role: "button", name: "Pay" }, kind: "click", tab: 4 }, "cli");
  assert.equal(r.data.held, true, "the model's own call through a person's cli is still held unless asked");
  const rel = await reg.call("chrome.release", { id: "held-1", content: gate().requests.at(-1).content }, "module:gate");
  assert.equal(rel.error.code, "changed");
  assert.match(rel.error.message, /changed since it was held/);
});

test("module: with no Gate to ask, a held act is reported, not done", async t => {
  const { reg, sockPath, connect } = await rig(t, { gate: false });
  const x = await connect({ "page.act": () => ({ ok: false, held: true, control: { role: "button", name: "Send" }, fields: [], sig: "s3", url: "https://harlow.example/x" }) });
  const r = await reg.call("chrome.act", { selector: { role: "button", name: "Send" }, kind: "click" }, "cli");
  assert.deepEqual([r.data.held, r.data.gate], [true, false]);
  assert.equal(x.ops("page.act").length, 1);
});

test("module: a batch that stops at a held step becomes a card for that step", async t => {
  const { reg, sockPath, gate, connect } = await rig(t);
  await connect({ "batch.run": () => ({ ok: false, done: 1, results: [{ ok: true }, { ok: false, held: true }], failedAt: 1, why: "held",
    held: { ok: false, held: true, control: { role: "button", name: "Submit" }, fields: [{ name: "Name", value: "Alex" }], sig: "sb", url: "https://harlow.example/form" } }) });
  const steps = [{ op: "page.fill", args: { fields: [{ selector: { name: "Name" }, value: "Alex" }] } }, { op: "page.act", args: { selector: { name: "Submit" }, kind: "click" } }];
  const r = await reg.call("chrome.batch", { tab: 1, steps }, "cli");
  assert.equal(r.data.held, true);
  assert.equal(r.data.failedAt, 1);
  const c = gate().requests[0].content;
  assert.equal(c.control, "button Submit");
  assert.deepEqual([c.op, c.signature, c.args], [undefined, undefined, undefined]);
});

test("module: chrome.click, chrome.type and chrome.open take the box module's input shapes", async t => {
  const { reg, sockPath, connect } = await rig(t);
  const x = await connect({ "tabs.use": () => ({ tab: { id: 5, url: "https://harlow.example/intake", title: "Intake" } }) });
  await reg.call("chrome.click", { agent: "kit", selector: { role: "link", name: "Contact" } }, "cli");
  await reg.call("chrome.type", { selector: { role: "textbox", name: "Email" }, text: "alex@example.com" }, "cli");
  const open = await reg.call("chrome.open", { url: "https://harlow.example/intake" }, "cli");
  assert.deepEqual(open.data, { ok: true, title: "Intake", url: "https://harlow.example/intake" });
  const acts = x.ops("page.act").map(m => m.args);
  assert.deepEqual([acts[0].kind, acts[0].selector.name, acts[1].kind, acts[1].value], ["click", "Contact", "type", "alex@example.com"]);
  assert.equal(x.ops("tabs.use")[0].args.openIfMissing, true);
  assert.equal((await reg.call("chrome.open", { url: "javascript:alert(1)" }, "cli")).error.code, "bad_request");
  assert.equal((await reg.call("chrome.click", {}, "cli")).error.code, "bad_input");
});

test("module: chrome.status reports the extension, the host, the tab counts and the panel", async t => {
  const nativeHost = { status: () => ({ installed: [{ browser: "chrome" }], launcherExists: true, launcherExecutable: true }), install: () => ({}) };
  const { reg, sockPath, connect } = await rig(t, { nativeHost });
  const before = await reg.call("chrome.status", {}, "cli");
  assert.deepEqual([before.data.connected, before.data.hostInstalled, before.data.tabs], [false, true, null]);
  await connect();
  const s = await reg.call("chrome.status", {}, "cli");
  assert.deepEqual([s.data.connected, s.data.tabs, s.data.attached, s.data.oversight.state], [true, 3, 1, "idle"]);
  assert.equal(s.data.extension.version, "0.2.0");
});

test("module: chrome.install registers the host and returns the steps in plain words", async t => {
  /** @type {any[]} */ const calls = [];
  const nativeHost = { status: () => ({ installed: [], launcherExists: true }), install: (/** @type {any} */ o) => { calls.push(o); return { ok: true, extensionId: o.extensionId, launcher: "/x/run-host.sh", written: [{ browser: "chrome", file: "/x/m.json" }] }; } };
  const { reg, connect } = await rig(t, { nativeHost });
  const r = await reg.call("chrome.install", { extensionDir: "/Users/alex/vyre/extension" }, "cli");
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.match(calls[0].extensionId, /^[a-p]{32}$/);
  assert.match(r.data.steps, /Load unpacked/);
  assert.match(r.data.steps, /\/Users\/alex\/vyre\/extension/);
  assert.match(r.data.steps, /debugging/);
  assert.equal((await reg.call("chrome.install", {}, KIT)).error.code, "denied", "an agent cannot register a host with the person's browser");
});

test("module: bad input is refused by the Registry's schema check before anything runs", async t => {
  const { reg, sockPath, connect } = await rig(t);
  const x = await connect();
  const before = x.ops("tabs.list").length; // chrome.status looked once while connecting
  assert.equal((await reg.call("chrome.tabs", { action: "explode" }, "cli")).error.code, "bad_input");
  assert.equal((await reg.call("chrome.net", { action: "nope" }, "cli")).error.code, "bad_input");
  assert.equal(x.ops("tabs.list").length, before);
});

test("module: the hands' Escape stops Chrome control too, and an act raises the pill first", async t => {
  const { reg, connect } = await rig(t);
  await connect();
  // The hands module's fake overlay stands in for the pill; hands.indicator must answer.
  assert.equal((await reg.call("hands.indicator", { app: "Chrome" }, "cli")).data.ok, true);
  assert.equal((await reg.call("chrome.act", { selector: { name: "Email" }, kind: "click" }, "cli")).error, undefined);
  reg.deps.events.emit("hands", "hands.stopped", { by: "person" });
  const r = await reg.call("chrome.act", { selector: { name: "Email" }, kind: "click" }, "cli");
  assert.equal(r.error.code, "stopped");
});

test("module: an agent's own Gate card releases nothing, and a script or API call is hands-free unless it SENDS", async t => {
  const { reg, gate, connect } = await rig(t);
  const sendHeld = { ok: false, held: true, why: "This would POST /conversations/messages", control: { role: "request", name: "POST /conversations/messages" }, fields: [], sig: "s9", url: "https://app.example/x" };
  const x = await connect({ "page.eval": (/** @type {any} */ a) => a.asked ? { ok: true, value: 2 } : /send/.test(a.expression) ? sendHeld : { ok: true, value: 1 } });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  const forged = await reg.call("chrome.release", { id: "held-99", content: { op: "page.eval", args: { expression: "fetch('/send',{method:'POST'})" }, signature: "x" } }, "module:gate");
  assert.equal(forged.error.code, "denied");
  // A script that sends nothing runs for the agent with no card.
  const free = await reg.call("chrome.eval", { expression: "document.title", tab: 1 }, KIT);
  assert.equal(free.data.value, 1);
  assert.equal(gate().requests.length, 0);
  // One whose effect is a send is held by the extension and becomes a card.
  const held = await reg.call("chrome.eval", { expression: "send()", tab: 1 }, KIT);
  assert.equal(held.data.held, true);
  assert.equal(gate().requests.length, 1);
  // The person's own turn runs it with no card; approving the card runs the stored record once.
  assert.equal((await reg.call("chrome.eval", { expression: "send()", tab: 1 }, "cli")).data.value, 2);
  const rel = await reg.call("chrome.release", { id: held.data.id, content: {} }, "module:gate");
  assert.equal(rel.error, undefined, JSON.stringify(rel));
  assert.equal(x.ops("page.eval").at(-1).args.asked, true);
  assert.equal((await reg.call("chrome.release", { id: held.data.id, content: {} }, "module:gate")).error.code, "denied");
});

test("module: the panel's controls (pause, plan.edit, voice) are the person's, not an agent's, and each emits its event", async t => {
  const { reg, events, connect } = await rig(t);
  await connect();
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  await reg.call("chrome.plan", { steps: [{ id: "1", text: "Read the page" }, { id: "2", text: "Fill it in" }], title: "Intake" }, KIT);
  for (const tool of ["chrome.pause", "chrome.plan.edit", "chrome.voice"]) assert.equal((await reg.call(tool, { step: "2", text: "x", run: "kit" }, KIT)).error.code, "denied", tool);
  assert.equal((await reg.call("chrome.plan.edit", { run: "kit", step: "2", text: "Fill in only the name" }, "cli")).data.ok, true);
  assert.equal((await reg.call("chrome.voice", { run: "kit", text: "skip that", final: true }, "cli")).data.ok, true);
  assert.equal((await reg.call("chrome.pause", { run: "kit" }, "cli")).data.paused, true);
  assert.equal(events("chrome.paused").length, 1);
  assert.equal(events("chrome.voice").length, 1);
  assert.equal(events("chrome.plan").at(-1).payload.steps[1].text, "Fill in only the name");
  assert.equal(events("chrome.plan").at(-1).payload.run, "kit");
});
