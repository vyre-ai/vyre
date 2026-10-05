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
import { Events } from "../../kernel/bus.js";
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

test("module: the manifest is valid and every tool it declares is registered", async t => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")), { firstParty: true }), []);
  const { reg, connect } = await rig(t);
  assert.equal(reg.status().find((/** @type {any} */ m) => m.name === "chrome")?.state, "running");
  const declared = JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")).does.tools.map((/** @type {any} */ n) => (typeof n === "string" ? n : n.name)).filter((/** @type {string} */ n) => n !== "chrome.release" && n !== "chrome.plan.check");
  const listed = reg.listTools().map((/** @type {any} */ x) => x.name);
  for (const name of declared) assert.ok(listed.includes(name), name);
  assert.ok(!listed.includes("chrome.release"), "release is internal: only the Gate calls it");
  assert.ok(!listed.includes("chrome.plan.check"), "plan.check is internal: other modules ask it before showing an agent the screen");
});

test("module: it offers chrome:mac to the Gate for acts, again before the first card if the Gate started late", async t => {
  const { reg, gate, connect } = await rig(t);
  await connect({ "page.act": () => ({ ok: false, held: true, control: { role: "button", name: "Send" }, fields: [], sig: "s0", url: "https://harlow.example/x" }) });
  await reg.call("chrome.act", { selector: { role: "button", name: "Send" }, kind: "click" }, "cli");
  const o = gate().offers.find((/** @type {any} */ x) => x.name === "chrome:mac");
  assert.deepEqual([o.tool, o.kinds], ["chrome.release", ["act"]]);
  assert.equal(o.recipients, "to", "the Gate matches an asked send or a standing permission on the site origin, which is `to`");
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
  assert.equal(x.ops("page.act")[0].trust.asked, false, "an agent's own act was not asked for by the person");

  // Only the Gate releases.
  assert.equal((await reg.call("chrome.release", { id: "held-1", content: req.content }, "cli")).error.code, "no_such_tool");
  const rel = await reg.call("chrome.release", { id: "held-1", content: req.content }, "module:gate");
  assert.equal(rel.error, undefined, JSON.stringify(rel));
  assert.equal(rel.data.ok, true);
  const sentFrame = x.ops("page.act")[1];
  const sent = sentFrame.args;
  assert.equal(sentFrame.trust.release.sig, "sig-1", "the approval rides in trust");
  assert.equal(sent.release, undefined, "and never in args");
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
  assert.equal(x.ops("page.act")[1].trust.release.sig, "sig-9", "release replayed what was held, found by its ref");
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
  assert.equal(x.ops("page.eval").at(-1).trust.asked, true);
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

test("module: chrome.open on a site that did not load says so (the tab and why), not a bare blind refusal", async t => {
  const { reg, connect } = await rig(t);
  await connect({ "tabs.use": () => ({ id: 7, windowId: 1, url: "chrome-error://chromewebdata/", title: "app.harlow.example", opened: true, loaded: false, failed: "the page did not load: Chrome is showing its own error page." }) });
  const r = await reg.call("chrome.open", { url: "https://app.harlow.example/" }, "cli");
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual([r.data.blind, r.data.tab, r.data.loaded], [true, 7, false]);
  assert.match(r.data.failed, /did not load/);
  assert.match(r.data.why, /did not load/);
});

// ---- why there is no extension, and the one fix (the user's first install: nothing said what was wrong)
const HOST_OK = { status: () => ({ installed: [{ browser: "chrome" }], launcherExists: true, launcherExecutable: true }), install: () => ({}) };

test("diagnose: nothing has ever connected: says Chrome never started the connector, and the fix (load and enable the extension, then quit and reopen Chrome)", async t => {
  const { reg } = await rig(t, { nativeHost: HOST_OK });
  const st = (await reg.call("chrome.status", {}, "cli")).data;
  assert.equal(st.connected, false);
  assert.equal(st.stage, "host_never_started");
  assert.match(st.problem, /no connector process has ever connected/);
  assert.match(st.fix, /chrome:\/\/extensions.*quit and reopen Chrome/);
  const r = await reg.call("chrome.snapshot", {}, "cli");
  assert.equal(r.error.code, "no_extension");
  assert.match(r.error.message, /Chrome has not started the connector/);
  assert.match(r.error.message, /quit and reopen Chrome/);
});

test("diagnose: a connector that is not registered says to run install", async t => {
  const { reg } = await rig(t, { nativeHost: { status: () => ({ installed: [], launcherExists: true }), install: () => ({}) } });
  const st = (await reg.call("chrome.status", {}, "cli")).data;
  assert.equal(st.stage, "host_not_registered");
  assert.match(st.fix, /vyre-chrome install/);
});

test("diagnose: a host that connected but never said hello, and one that was connected and dropped, are told apart", async t => {
  const { reg, sockPath } = await rig(t, { nativeHost: HOST_OK });
  const silent = await fakeExtension(sockPath, { hello: false });
  await until(async () => (await reg.call("chrome.status", {}, "cli")).data.socket.connections >= 1);
  assert.equal((await reg.call("chrome.status", {}, "cli")).data.stage, "host_no_hello");
  await silent.close();
  const good = await fakeExtension(sockPath);
  await until(async () => (await reg.call("chrome.status", {}, "cli")).data.connected);
  assert.equal((await reg.call("chrome.status", {}, "cli")).data.problem, undefined, "no problem while connected");
  await good.close();
  await until(async () => !(await reg.call("chrome.status", {}, "cli")).data.connected);
  const st = (await reg.call("chrome.status", {}, "cli")).data;
  assert.equal(st.stage, "extension_dropped");
  assert.match(st.problem, /connected and then disconnected/);
});

test("diagnose: a host launched for a different extension id is refused and says so", async t => {
  const key = JSON.parse(fs.readFileSync(path.join(HERE, "extension", "manifest.json"), "utf8")).key;
  const { extensionIdFromKey } = await import("./native-host/install.js");
  const right = `chrome-extension://${extensionIdFromKey(key)}/`;
  const { reg, sockPath } = await rig(t, { nativeHost: HOST_OK, origin: right });
  const wrong = await fakeExtension(sockPath, { hello: false });
  await wrong.send({ event: "host", origin: "chrome-extension://" + "a".repeat(32) + "/" });
  await wrong.hello();
  await until(async () => (await reg.call("chrome.status", {}, "cli")).data.stage === "host_refused");
  const st = (await reg.call("chrome.status", {}, "cli")).data;
  assert.match(st.problem, /different extension id/);
  assert.match(st.fix, /vyre-chrome install/);
});

test("module: an approved plan covers that many creates; a kind it does not list, a publish, and a stopped run still ask", async t => {
  const { reg, gate, connect } = await rig(t);
  const heldWrite = (/** @type {string} */ kind, /** @type {string} */ method) => ({ ok: false, held: true, write: true, kind, method, why: "a change with the person's login", control: { role: "request", name: `${method} https://api.example/x` }, fields: [], sig: "s", url: "https://app.example/w" });
  const x = await connect({ "api.call": (/** @type {any} */ a) => (a.writeOk || a.asked)
    ? { ok: true, status: 200, method: a.entry === "del" ? "DELETE" : "POST" }
    : a.entry === "pub" ? { ok: false, held: true, control: { role: "request", name: "POST https://api.example/publish" }, fields: [], sig: "p", url: "https://app.example/w" }
    : a.entry === "del" ? heldWrite("delete", "DELETE") : heldWrite("create", "POST") });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  const call = (/** @type {string} */ entry) => reg.call("chrome.api", { action: "call", entry, tab: 1 }, KIT);
  // no plan: a write is held for the person
  assert.equal((await call("c1")).data.held, true);
  // the plan: the person approves it once, through the same release path as a send
  const p = await reg.call("chrome.approve", { title: "Two drafts", items: [{ kind: "create", what: "draft workflow", count: 2 }, { kind: "publish", what: "nothing yet" }], tab: 1 }, KIT);
  assert.equal(p.error, undefined, JSON.stringify(p));
  assert.equal(p.data.held, true);
  const card = gate().requests[gate().requests.length - 1];
  assert.equal(card.content.kind, "plan");
  assert.match(card.content.control, /Two drafts/);
  assert.deepEqual(card.content.fields.map((/** @type {any} */ f) => f.value), ["draft workflow", "nothing yet"]);
  const rel = await reg.call("chrome.release", { id: p.data.id, content: card.content }, "module:gate");
  assert.equal(rel.data.approved, true);
  assert.equal(rel.data.total, 3, "counts the publish too, which it lists but never covers");
  const before = x.ops("api.call").length;
  assert.equal((await call("c1")).data.ok, true, "the first create goes through");
  assert.equal((await call("c2")).data.ok, true, "and the second");
  assert.equal(x.ops("api.call").filter((/** @type {any} */ o) => (o.trust || {}).writeOk === true).length, 2);
  assert.equal(x.ops("api.call").length - before, 4, "each covered write was tried, held, then sent once with writeOk");
  assert.equal((await call("c3")).data.held, true, "a third create is not in the plan");
  assert.equal((await call("del")).data.held, true, "a delete is not in the plan");
  assert.equal((await call("pub")).data.held, true, "a publish is never covered");
  assert.equal(x.ops("api.call").filter((/** @type {any} */ o) => (o.trust || {}).writeOk === true).length, 2, "nothing else was sent");
});

test("module: stopping Vyre ends the plan, and a plan needs real items", async t => {
  const { reg, gate, connect } = await rig(t);
  const x = await connect({ "api.call": (/** @type {any} */ a) => (a.writeOk || a.asked) ? { ok: true, status: 200, method: "POST" } : { ok: false, held: true, write: true, kind: "create", method: "POST", control: { role: "request", name: "POST https://api.example/x" }, fields: [], sig: "s", url: "https://app.example/w" } });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  assert.equal((await reg.call("chrome.approve", { title: "x", items: [] }, KIT)).error.code, "bad_request");
  assert.equal((await reg.call("chrome.approve", { title: "x", items: [{ kind: "rm-rf", what: "all" }] }, KIT)).error.code, "bad_input");
  const p = await reg.call("chrome.approve", { title: "One", items: [{ kind: "create", what: "a draft" }], tab: 1 }, KIT);
  await reg.call("chrome.release", { id: p.data.id, content: gate().requests[gate().requests.length - 1].content }, "module:gate");
  await reg.call("chrome.stop", { by: "esc" }, "capsule");
  await reg.call("chrome.resume", { answer: "ok" }, "capsule");
  const r = await reg.call("chrome.api", { action: "call", entry: "c1", tab: 1 }, KIT);
  assert.equal(r.data.held, true, "the plan did not survive the stop");
  assert.equal(x.ops("api.call").filter((/** @type {any} */ o) => (o.trust || {}).writeOk === true).length, 0);
});

test("module: the summary says what a plan's writes changed, what can be undone, and what still waits; it clears for the next job", async t => {
  const { reg, gate, connect } = await rig(t);
  let n = 0;
  await connect({ "api.call": (/** @type {any} */ a) => (a.writeOk || a.asked)
    ? { ok: true, status: 201, method: "POST", url: "https://api.example/workflow/abc", responseBody: JSON.stringify({ data: { id: `wf_${++n}` } }) }
    : { ok: false, held: true, write: true, kind: "create", method: "POST", control: { role: "request", name: "POST https://api.example/workflow/abc" }, fields: [], sig: "s", url: "https://app.example/w" } });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  const empty = await reg.call("chrome.summary", {}, KIT);
  assert.match(empty.data.lines[0], /Nothing was changed/);
  const p = await reg.call("chrome.approve", { title: "Two drafts", items: [{ kind: "create", what: "draft", count: 2 }], tab: 1 }, KIT);
  await reg.call("chrome.release", { id: p.data.id, content: gate().requests[gate().requests.length - 1].content }, "module:gate");
  await reg.call("chrome.api", { action: "call", entry: "a", tab: 1 }, KIT);
  await reg.call("chrome.api", { action: "call", entry: "a", tab: 1 }, KIT);
  await reg.call("chrome.api", { action: "call", entry: "a", tab: 1 }, KIT); // a third: held, and it is pending
  const s = await reg.call("chrome.summary", {}, KIT);
  assert.equal(s.error, undefined, JSON.stringify(s));
  assert.deepEqual(s.data.counts, { create: 2, edit: 0, delete: 0 });
  assert.deepEqual(s.data.changes.map((/** @type {any} */ c) => c.id), ["wf_1", "wf_2"]);
  assert.match(s.data.changes[0].undo, /^delete wf_1$/);
  assert.match(s.data.lines[0], /2 changes made: 2 created/);
  assert.ok(s.data.lines.some((/** @type {string} */ l) => /1 action is still waiting/.test(l)));
  assert.ok(s.data.lines.some((/** @type {string} */ l) => /2 of 2 used/.test(l)));
  const again = await reg.call("chrome.summary", {}, KIT);
  assert.equal(again.data.changes.length, 0, "cleared for the next job");
});

test("module: a publish is covered only when the plan says the person's own words asked for it; a delete never is", async t => {
  const { reg, gate, connect } = await rig(t);
  const pubHeld = { ok: false, held: true, kind: "publish", method: "POST", control: { role: "request", name: "POST https://api.example/workflow/w1/publish" }, fields: [], sig: "p", url: "https://app.example/w" };
  const delHeld = { ok: false, held: true, write: true, kind: "delete", method: "DELETE", control: { role: "request", name: "DELETE https://api.example/workflow/w1" }, fields: [], sig: "d", url: "https://app.example/w" };
  const x = await connect({ "api.call": (/** @type {any} */ a) => (a.asked || a.writeOk) ? { ok: true, status: 200, method: a.entry === "del" ? "DELETE" : "POST", url: "https://api.example/workflow/w1/publish" } : a.entry === "del" ? delHeld : pubHeld });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  const approve = async (/** @type {any} */ items) => { const p = await reg.call("chrome.approve", { title: "Build", items, tab: 1 }, KIT); const card = gate().requests[gate().requests.length - 1]; await reg.call("chrome.release", { id: p.data.id, content: card.content }, "module:gate"); return card; };
  // not asked for: the plan lists the publish, but it still asks
  await approve([{ kind: "publish", what: "the intake workflow" }, { kind: "delete", what: "old draft" }]);
  assert.equal((await reg.call("chrome.api", { action: "call", entry: "pub", tab: 1 }, KIT)).data.held, true);
  assert.equal((await reg.call("chrome.api", { action: "call", entry: "del", tab: 1 }, KIT)).data.held, true, "a delete always asks");
  // asked for ("build and publish these"): the card says so, and the publish goes through once
  const card = await approve([{ kind: "publish", what: "the intake workflow", asked: true }]);
  assert.deepEqual(card.content.fields.map((/** @type {any} */ f) => f.name), ["and publish x1"]);
  assert.equal((await reg.call("chrome.api", { action: "call", entry: "pub", tab: 1 }, KIT)).data.ok, true);
  assert.equal((await reg.call("chrome.api", { action: "call", entry: "pub", tab: 1 }, KIT)).data.held, true, "only as many as the plan said");
  assert.equal(x.ops("api.call").filter((/** @type {any} */ o) => o.trust.asked === true).length, 1);
});

test("module: the finish card and summary link each created item to its own builder page on the person's own host", async t => {
  const { reg, gate, connect } = await rig(t);
  let n = 0;
  await connect({
    "tabs.list": () => ({ tabs: [{ id: 1, title: "Workflows", url: "https://crm.harlowlaw.example/v2/location/LOC1234/automation/workflows", active: true }] }),
    "api.call": (/** @type {any} */ a) => (a.writeOk || a.asked)
      ? { ok: true, status: 201, method: "POST", url: "https://backend.example.com/workflow/LOC1234", responseBody: JSON.stringify({ id: `wfid${++n}abc` }) }
      : { ok: false, held: true, write: true, kind: "create", method: "POST", control: { role: "request", name: "POST https://backend.example.com/workflow/LOC1234" }, fields: [], sig: "s", url: "https://crm.harlowlaw.example/x" } });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  await reg.call("chrome.tabs", { action: "list" }, KIT);
  const p = await reg.call("chrome.approve", { title: "Two", items: [{ kind: "create", what: "workflow", count: 2 }], tab: 1 }, KIT);
  await reg.call("chrome.release", { id: p.data.id, content: gate().requests[gate().requests.length - 1].content }, "module:gate");
  await reg.call("chrome.api", { action: "call", entry: "a", tab: 1 }, KIT);
  const s = await reg.call("chrome.summary", {}, KIT);
  assert.equal(s.data.changes[0].open, "https://crm.harlowlaw.example/v2/location/LOC1234/automation/workflows/wfid1abc", JSON.stringify(s.data));
  assert.match(s.data.lines.join("\n"), /open: https:\/\/crm\.harlowlaw\.example\/v2\/location\/LOC1234\/automation\/workflows\/wfid1abc/);
});

test("module: a model cannot approve its own write by passing writeOk (or asked); both are stripped before anything reaches Chrome", async t => {
  const { reg, connect } = await rig(t);
  const x = await connect({ "api.call": (/** @type {any} */ a) => (a.writeOk || a.asked) ? { ok: true, status: 200, method: "POST" } : { ok: false, held: true, write: true, kind: "create", method: "POST", control: { role: "request", name: "POST https://api.example/x" }, fields: [], sig: "s", url: "https://app.example/w" } });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  const r = await reg.call("chrome.api", { action: "call", entry: "a", tab: 1, writeOk: true, asked: true }, KIT);
  // The registry refuses keys the schema does not list from a client before the module strips them (group D); either way the claim counts for nothing.
  assert.ok((r.error && r.error.code === "bad_input") || (r.data && r.data.held === true), "refused or still held: no plan covers it and the model's own claim counts for nothing");
  assert.ok(x.ops("api.call").every((/** @type {any} */ o) => (o.trust || {}).writeOk !== true), "writeOk never reached the extension");
});

test("module: a plan is for one site: other tabs and other API origins are still asked", async t => {
  const { reg, gate, connect } = await rig(t);
  const write = (/** @type {string} */ origin) => ({ ok: false, held: true, write: true, kind: "create", method: "POST", origin, control: { role: "request", name: `POST ${origin}/x` }, fields: [], sig: "s", url: "https://app.example/w" });
  let next = "https://api.one.example";
  const x = await connect({
    "tabs.list": () => ({ tabs: [{ id: 1, title: "A", url: "https://app.one.example/v2/location/L1/automation/workflows" }, { id: 2, title: "B", url: "https://app.two.example/" }] }),
    "api.call": (/** @type {any} */ a) => (a.writeOk || a.asked) ? { ok: true, status: 201, method: "POST" } : write(next) });
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  await reg.call("chrome.tabs", { action: "list" }, KIT);
  const p = await reg.call("chrome.approve", { title: "Some", items: [{ kind: "create", what: "drafts", count: 5 }], tab: 1 }, KIT);
  await reg.call("chrome.release", { id: p.data.id, content: gate().requests[gate().requests.length - 1].content }, "module:gate");
  const call = (/** @type {number} */ tab) => reg.call("chrome.api", { action: "call", entry: "a", tab }, KIT);
  assert.equal((await call(1)).data.ok, true, "the approved tab");
  assert.equal((await call(2)).data.held, true, "another tab");
  next = "https://api.other.example";
  assert.equal((await call(1)).data.held, true, "another API origin");
  next = "https://api.one.example";
  assert.equal((await call(1)).data.ok, true, "the pinned origin still goes through");
  assert.equal(x.ops("api.call").filter((/** @type {any} */ o) => (o.trust || {}).writeOk === true).length, 2);
});

test("module: a batch or recipe may make the writes an approved plan covers without stopping at each; the budget is the module's alone", async t => {
  const { reg, gate, connect } = await rig(t);
  /** @type {any[]} */ const seen = [];
  const x = await connect({
    "tabs.list": () => ({ tabs: [{ id: 1, title: "A", url: "https://app.one.example/w" }] }),
    "batch.run": (/** @type {any} */ a) => {
      seen.push(a);
      const b = a.writeBudget ? { ...a.writeBudget } : null;
      const covered = [];
      let created = 0;
      for (let i = 0; i < 3; i++) { if (b && b.create > 0) { b.create--; covered.push({ kind: "create", res: { ok: true, status: 201, method: "POST", url: "https://api.one.example/x", origin: "https://api.one.example", responseBody: JSON.stringify({ id: `id${i}abcd` }) } }); created++; } }
      return { ok: created === 3, done: created, results: [], ...(covered.length ? { covered } : {}) };
    } });
  void x;
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  await reg.call("chrome.tabs", { action: "list" }, KIT);
  // no plan: no budget, and a model's own budget is stripped
  const stripped = await reg.call("chrome.batch", { tab: 1, steps: [{ op: "page.act", args: {} }], writeBudget: { create: 99 } }, KIT);
  assert.equal(stripped.error && stripped.error.code, "bad_input", "a model's own budget is refused by the schema before the module could strip it");
  await reg.call("chrome.batch", { tab: 1, steps: [{ op: "page.act", args: {} }] }, KIT);
  assert.equal(seen[0].writeBudget, undefined);
  const p = await reg.call("chrome.approve", { title: "Two", items: [{ kind: "create", what: "drafts", count: 2 }], tab: 1 }, KIT);
  await reg.call("chrome.release", { id: p.data.id, content: gate().requests[gate().requests.length - 1].content }, "module:gate");
  await reg.call("chrome.batch", { tab: 1, steps: [{ op: "page.act", args: {} }] }, KIT);
  assert.deepEqual(seen[1].writeBudget, { create: 2, edit: 0, tab: 1, tabOrigin: "https://app.one.example" }, "the plan's remaining count bound to its tab and site, not the model's");
  const s = await reg.call("chrome.summary", {}, KIT);
  assert.equal(s.data.counts.create, 2, "what the batch covered is counted and listed");
  // the budget is spent: the next batch gets none
  await reg.call("chrome.batch", { tab: 1, steps: [{ op: "page.act", args: {} }] }, KIT);
  assert.equal(seen[2].writeBudget, undefined);
});


test("module: the write budget is reserved when handed out: parallel batches cannot double it, unused writes come back, a lost reply counts as spent", async t => {
  const { reg, gate, connect } = await rig(t);
  /** @type {any[]} */ const seen = [];
  /** @type {Function[]} */ const release = [];
  const x = await connect({
    "tabs.list": () => ({ tabs: [{ id: 1, title: "A", url: "https://app.one.example/w" }, { id: 2, title: "B", url: "https://app.two.example/" }] }),
    "batch.run": (/** @type {any} */ a) => {
      seen.push(a);
      const covered = [];
      const b = a.writeBudget ? { ...a.writeBudget } : { create: 0 };
      // this batch only manages to make ONE write however much it was given
      if (b.create > 0) covered.push({ kind: "create", res: { ok: true, status: 201, method: "POST", url: "https://api.one.example/x", origin: "https://api.one.example" } });
      if (a.steps[0].op === "hang") return new Promise(() => {});
      if (a.steps[0].op === "gate") return new Promise(r => release.push(() => r({ ok: true, done: 1, results: [], ...(covered.length ? { covered } : {}) })));
      return { ok: true, done: covered.length, results: [], ...(covered.length ? { covered } : {}) };
    } });
  void x;
  await reg.call("hands.grant.add", { agent: "kit" }, "cli");
  await reg.call("chrome.plan", PLAN, KIT);
  await reg.call("chrome.tabs", { action: "list" }, KIT);
  const p = await reg.call("chrome.approve", { title: "Eight", items: [{ kind: "create", what: "drafts", count: 8 }], tab: 1 }, KIT);
  await reg.call("chrome.release", { id: p.data.id, content: gate().requests[gate().requests.length - 1].content }, "module:gate");
  // two batches at once: the first reserves all 8, the second gets nothing
  const first = reg.call("chrome.batch", { tab: 1, steps: [{ op: "gate", args: {} }] }, KIT);
  await until(() => seen.length >= 1);
  const second = await reg.call("chrome.batch", { tab: 1, steps: [{ op: "page.act", args: {} }] }, KIT);
  void second;
  assert.equal(seen[0].writeBudget.create, 8);
  assert.equal(seen[1].writeBudget, undefined, "the second batch cannot get the same writes again");
  release.forEach(f => f());
  await first;
  // it made one write: the other 7 come back
  await reg.call("chrome.batch", { tab: 1, steps: [{ op: "page.act", args: {} }] }, KIT);
  assert.equal(seen[2].writeBudget.create, 7, "unused writes are returned, the used one is not");
  // another tab gets no budget at all
  await reg.call("chrome.batch", { tab: 2, steps: [{ op: "page.act", args: {} }] }, KIT);
  assert.equal(seen[3].writeBudget, undefined, "a batch on another tab gets zero");
  // a reply that never comes: the reservation is spent, not handed out again
  const lost = reg.call("chrome.batch", { tab: 1, timeoutMs: 80, steps: [{ op: "hang", args: {} }] }, KIT);
  await lost;
  await reg.call("chrome.batch", { tab: 1, steps: [{ op: "page.act", args: {} }] }, KIT);
  assert.equal(seen[seen.length - 1].writeBudget, undefined, "what a lost batch held is counted as spent");
});

test("chrome.fill: an agent caller (mcp, a vouched \"cli agent:\" spelling, a harness caller) cannot call it unprompted: it needs the person's grant, then a posted plan, and what reaches Chrome carries asked false", async t => {
  const { reg, sockPath, connect } = await rig(t);
  /** @type {any[]} */ const seen = [];
  const x = await connect({ "page.fill": (/** @type {any} */ a) => { seen.push(a); return { ok: true, filled: 1 }; } });
  const fill = { fields: [{ label: "Email", value: "a@b.example" }] };
  for (const caller of [KIT, "cli agent:kit", "harness"]) {
    const r = await reg.call("chrome.fill", fill, caller);
    assert.equal(r.error && r.error.code, "denied", `${caller}: refused without a grant`);
    assert.match(r.error.message, /not granted/);
  }
  assert.equal(x.ops("page.fill").length, 0, "nothing reached Chrome");
  // The person's grant (hands.grant.add is the person's own tool, never an agent's):
  assert.equal((await reg.call("hands.grant.add", { agent: "kit" }, KIT)).error ? "refused" : "allowed", "refused", "an agent cannot grant itself");
  assert.ok((await reg.call("hands.grant.add", { agent: "kit" }, "cli")).data.granted);
  const noPlan = await reg.call("chrome.fill", fill, KIT);
  assert.ok(noPlan.error, "granted but no plan posted yet");
  assert.equal(x.ops("page.fill").length, 0);
  assert.ok(!(await reg.call("chrome.plan", PLAN, KIT)).error);
  const ok = await reg.call("chrome.fill", fill, KIT);
  assert.equal(ok.error, undefined);
  assert.equal(x.ops("page.fill").length, 1);
  assert.notEqual(seen[0] && seen[0].asked, true, "the agent's call never carries the person's approval");
});
