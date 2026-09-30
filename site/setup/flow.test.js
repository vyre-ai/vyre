// @ts-check
// The setup page's flow and screen against the real relay client and the real Node relay server. The box's
// offer is the one thing faked (it needs a whole daemon; core/relay/setup.test.js covers that half).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as client from "../../relay/client/setup.js";
import { createRelay } from "../../relay/node/server.js";
import * as wire from "../../core/relay/wire.js";
import { createFlow, MESSAGES, MAX_LINES } from "./flow.js";
import { render, h } from "./ui.js";

/** A relay on a free port, and the install script's side of the mailbox (the same POSTs install-box.sh makes). */
async function world(t) {
  const relay = createRelay({});
  const base = await relay.listen();
  t.after(() => relay.close());
  const http = base.replace(/^ws/, "http");
  return {
    base,
    /** Post a line for a code, as the install script would (or as anyone who saw the code could). */
    async post(code, text, seq) {
      const c = wire.parseSetupCode(code);
      const loc = wire.setupDerive("loc", c.secret).toString("base64url");
      const body = { loc, fp: c.fp.toString("base64url"), wtok: wire.setupDerive("mbxw", c.secret).toString("base64url") };
      if (text !== null) body.line = wire.mbxSeal(c.secret, seq, text);
      const r = await fetch(`${http}/v1/setup/mbx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return r.status;
    },
  };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 15)); } throw new Error("timed out waiting"); };
const fastSleep = () => new Promise(r => setTimeout(r, 5));

/** The client with resolveSetup replaced: the box's offer appears after `after` tries (or is contested). */
const clientWith = (resolve) => ({ ...client, resolveSetup: resolve });
const offer = () => ({ offer: { relay: "ws://x", route: "r".repeat(26), box: crypto.randomBytes(32), secret: "s" }, name: "Harlow Legal server", fingerprint: "ab12 cd34", handle: null, identity: null });

test("flow: a code and its install line are made, the steps stream in as plain lines, and the box's offer means found", async t => {
  const w = await world(t);
  let tries = 0;
  const seen = [];
  const flow = createFlow({ client: clientWith(async () => { if (++tries < 3) throw Object.assign(new Error("gone"), { code: "ticket_gone" }); return offer(); }),
    relay: w.base, sleep: fastSleep, pollMs: 5, onChange: s => seen.push(s.stage) });
  await flow.begin();
  const s = flow.state;
  assert.equal(s.stage, "install");
  assert.match(s.installLine, /^curl -fsSL https:\/\/vyre\.run\/i \| VYRE_CODE=[A-Za-z0-9_-]{43} sh$/, "the variable is on sh, the reader of the script");
  assert.equal(s.code.length, 43);
  await w.post(s.code, "[1/5] Checking Docker", 0);
  await w.post(s.code, "done: Docker, Compose and the TUN device are there", 1);
  const found = await until(() => flow.state.stage === "found" && flow.state);
  assert.equal(found.box.name, "Harlow Legal server");
  assert.equal(found.box.words.length, 4);
  assert.ok(found.box.words.every(x => /^[a-z]+$/.test(x)));
  await until(() => flow.state.lines.length === 2);
  assert.deepEqual(flow.state.lines, ["[1/5] Checking Docker", "done: Docker, Compose and the TUN device are there"]);
  assert.ok(seen.indexOf("install") < seen.indexOf("found"));
  flow.stop();
});

test("flow: a forged 'Done, open https://...' line is shown as text and moves nothing", async t => {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("gone"), { code: "ticket_gone" }); }), relay: w.base, sleep: fastSleep, pollMs: 5 });
  await flow.begin();
  const code = flow.state.code;
  // Anyone who saw the code can post a well-formed line; this one says the install is over and points somewhere else.
  await w.post(code, "Done. Back to your browser. Open https://evil.example/claim?c=1 to finish", 0);
  await w.post(code, "<img src=x onerror=alert(1)><a href=\"https://evil.example\">Continue</a>", 1);
  await until(() => flow.state.lines.length === 2);
  assert.equal(flow.state.stage, "install", "no line changes where the flow is");
  assert.equal(flow.state.box, null);

  // The screen: text nodes only.
  const doc = new FakeDoc();
  const root = doc.createElement("main");
  render(flow.state, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions: { begin() {}, copy() {} } });
  const text = root.textContent;
  assert.ok(text.includes("Open https://evil.example/claim?c=1 to finish"), "shown as words");
  assert.ok(text.includes("<img src=x onerror=alert(1)><a href=\"https://evil.example\">Continue</a>"), "markup is shown, not made");
  assert.equal(root.all().filter(e => e.tag === "a" || e.tag === "img").length, 0, "no link or image was made from a line");
  assert.equal(doc.innerHtmlWrites, 0);
  assert.ok(!root.all().some(e => (e.attrs.href || "").includes("evil")), "no href points at a line's address");
  flow.stop();
});

test("flow: a contested code, a bad line, and an expired hour each stop the page with the plain message", async t => {
  // Contested: the relay says two servers used the code.
  const w = await world(t);
  const contested = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("x"), { code: "contested" }); }), relay: w.base, sleep: fastSleep, pollMs: 5 });
  await contested.begin();
  await until(() => contested.state.stage === "stopped");
  assert.equal(contested.state.error.message, "Two servers used this code. Start again.");

  // A line the page cannot verify (posted at the wrong position) stops it.
  const bad = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("gone"), { code: "ticket_gone" }); }), relay: w.base, sleep: fastSleep, pollMs: 5 });
  await bad.begin();
  await w.post(bad.state.code, "hello", 5);
  await until(() => bad.state.stage === "stopped");
  assert.equal(bad.state.error.code, "bad_line");
  assert.equal(bad.state.error.message, MESSAGES.bad_line);

  // Expired: the hour runs out.
  let clock = 1_000_000;
  const exp = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("gone"), { code: "ticket_gone" }); }), relay: w.base, now: () => clock,
    sleep: async ms => { clock += ms; await new Promise(r => setTimeout(r, 2)); }, pollMs: 5 });
  await exp.begin();
  await until(() => exp.state.stage === "stopped");
  assert.equal(exp.state.error.message, "This code has expired. Start again.");
  for (const f of [contested, bad, exp]) f.stop();
});

test("flow: starting again makes a new code and the old one's loops end", async t => {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("gone"), { code: "ticket_gone" }); }), relay: w.base, sleep: fastSleep, pollMs: 5 });
  await flow.begin();
  const first = flow.state.code;
  await w.post(first, "first run line", 0);
  await until(() => flow.state.lines.length === 1);
  await flow.begin();
  assert.notEqual(flow.state.code, first);
  assert.deepEqual(flow.state.lines, [], "the old run's lines are gone");
  await w.post(first, "a late line for the old code", 1);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(flow.state.lines, [], "nothing from the old code lands on the new run");
  flow.stop();
});

test("flow: the lines kept are capped, and each is cut to a sane length", async t => {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("gone"), { code: "ticket_gone" }); }), relay: w.base, sleep: fastSleep, pollMs: 5 });
  await flow.begin();
  const code = flow.state.code;
  for (let i = 0; i < 5; i++) await w.post(code, "x".repeat(900), i);
  await until(() => flow.state.lines.length === 5);
  assert.ok(flow.state.lines.every(l => l.length <= 400));
  assert.ok(MAX_LINES >= 100);
  flow.stop();
});

// ---- a DOM just big enough to check what the screen makes ----
class FakeEl {
  constructor(tag, doc) { this.tag = tag; this.doc = doc; this.attrs = {}; this.children = []; this.text = null; this.listeners = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; }
  addEventListener(n, f) { this.listeners[n] = f; }
  querySelector(sel) { return this.all().find(e => e.tag === sel) || null; }
  focus() {}
  all() { return this.children.flatMap(c => c instanceof FakeEl ? [c, ...c.all()] : []); }
  get textContent() { return this.children.map(c => (c instanceof FakeEl ? c.textContent : c.value)).join(" "); }
  set innerHTML(_) { this.doc.innerHtmlWrites++; }
}
class FakeDoc {
  constructor() { this.innerHtmlWrites = 0; }
  createElement(tag) { return new FakeEl(tag, this); }
  createTextNode(value) { return { value }; }
}
void h;

test("site: the relay client copied the way build-site.sh does it loads on its own, with no import from outside its folder", async t => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path"), url = await import("node:url");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-site-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "relay", "client");
  fs.mkdirSync(path.join(dir, "relay"));
  for (const f of fs.readdirSync(src)) if (f.endsWith(".js") && !f.endsWith(".test.js")) fs.copyFileSync(path.join(src, f), path.join(dir, "relay", f));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  const m = await import(url.pathToFileURL(path.join(dir, "relay", "setup.js")).href);
  for (const name of ["createSetupKey", "setupCode", "resolveSetup", "setupWords", "mailboxReader"]) assert.equal(typeof m[name], "function", name);
  // and the page's own files import nothing at all except the client (page.js) and each other
  const page = fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "page.js"), "utf8");
  assert.deepEqual([...page.matchAll(/^import .* from "([^"]+)"/gm)].map(x => x[1]).sort(), ["./flow.js", "./relay/setup.js", "./ui.js"]);
});
