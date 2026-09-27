// @ts-check
// cdpmux against an in-memory fake Chrome (testing/fake-chrome.js) over two PassThrough streams:
// a browser session per client, ids, session ownership, native per-client auto-attach and
// discovery, kinds, refusals, and what happens when a client or Chrome goes away mid-call. No
// process, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { CdpMux } from "./cdpmux.js";
import { FakeChrome } from "./testing/fake-chrome.js";

function world() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const fake = new FakeChrome();
  fake.wire(toChrome, fromChrome);
  /** @type {string[]} */
  const logs = [];
  const mux = new CdpMux({ log: line => logs.push(line) });
  mux.attach(toChrome, fromChrome);
  return { mux, fake, logs, toChrome, fromChrome };
}

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/** @param {CdpMux} mux @param {string} [kind] */
function client(mux, kind = "agent") {
  /** @type {any[]} */
  const inbox = [];
  /** @type {Array<() => void>} */
  let waiters = [];
  const state = { closed: false, sentAfterClose: 0 };
  const h = mux.addClient(kind, {
    send: text => {
      if (state.closed) state.sentAfterClose++;
      inbox.push(JSON.parse(text));
      const w = waiters; waiters = []; for (const f of w) f();
    },
    close: () => { state.closed = true; },
  });
  let seq = 0;
  /** @param {(m: any) => boolean} pred @param {number} [ms] */
  const waitFor = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
    const check = () => {
      const hit = inbox.find(pred);
      if (hit) { clearTimeout(timer); resolve(hit); } else waiters.push(check);
    };
    check();
  });
  return {
    h, inbox, state,
    /** @param {string} method @param {any} [params] @param {string} [sessionId] @param {number} [id] */
    send(method, params = {}, sessionId, id = ++seq) {
      h.receive(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return id;
    },
    /** @param {string} method @param {any} [params] @param {string} [sessionId] @param {number} [id] */
    async call(method, params = {}, sessionId, id) {
      const sent = this.send(method, params, sessionId, id);
      return waitFor(m => m.id === sent && !("method" in m));
    },
    waitFor,
    /** @param {string} method */
    events: method => inbox.filter(m => m.method === method),
  };
}

/** The browser session Chrome saw a client's session-less call on, found by a marker call. */
async function browserSidOf(fake, c, marker) {
  await c.call("Test.echo", { n: marker });
  const hit = fake.seen.find(s => s.method === "Test.echo" && s.params.n === marker);
  return hit && hit.sessionId;
}

test("cdpmux: every client gets its own browser session; session-less calls go there, never to the root", async () => {
  const { mux, fake } = world();
  const a = client(mux), b = client(mux);
  const r = await a.call("Test.echo", { n: "a" });
  assert.equal(r.sessionId, undefined, "the answer comes back without the browser session's id");
  const aSid = await browserSidOf(fake, a, "mark-a");
  const bSid = await browserSidOf(fake, b, "mark-b");
  assert.ok(aSid && bSid && aSid !== bSid, "two clients, two browser sessions");
  assert.ok(fake.sessions.get(aSid).browser && fake.sessions.get(bSid).browser);
  assert.equal(fake.seen.filter(s => !s.sessionId && s.method !== "Target.attachToBrowserTarget" && s.method !== "Target.detachFromTarget").length, 0,
    "nothing a client sent reached the root session");
  assert.ok(a.events("Test.echoed").every(e => e.sessionId === undefined), "its browser session's events arrive without the id");
  assert.equal(b.events("Test.echoed").filter(e => e.params.n === "a" || e.params.n === "mark-a").length, 0, "and only to it");

  // It cannot name its own browser session, or anyone else's.
  assert.equal((await a.call("Test.echo", {}, aSid)).error.code, -32001);
  assert.equal((await a.call("Test.echo", {}, bSid)).error.code, -32001);
  assert.equal((await a.call("Target.detachFromTarget", { sessionId: aSid })).error.code, -32001);
  // Root events reach nobody.
  await a.call("Test.rootEvent");
  await tick(20);
  assert.equal(a.events("Test.rooted").length + b.events("Test.rooted").length, 0);
});

test("cdpmux: a client's browser-level Fetch.enable lives on its own browser session, and dies with it on closeKind", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent"), fill = client(mux, "fill");
  const aSid = await browserSidOf(fake, agent, "agent-mark");
  const fSid = await browserSidOf(fake, fill, "fill-mark");
  assert.deepEqual((await agent.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] })).result, {});
  const seen = fake.seen.find(s => s.method === "Fetch.enable");
  assert.equal(seen && seen.sessionId, aSid, "Fetch.enable went out on the agent's browser session");
  assert.deepEqual(fake.sessions.get(aSid).fetch, { patterns: [{ urlPattern: "*" }] });
  assert.equal(fake.sessions.get("").fetch, null, "the root session was never touched");
  const child = (await agent.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;

  assert.equal(mux.closeKind("agent"), 1);
  assert.equal(agent.state.closed, true);
  await tick(20);
  assert.ok(!fake.sessions.has(aSid), "the agent's browser session is detached, and its Fetch with it");
  assert.ok(!fake.sessions.has(child), "and its child session");
  assert.ok(fake.seen.some(s => s.method === "Target.detachFromTarget" && s.params.sessionId === aSid && !s.sessionId), "detached on the root");
  assert.ok(fake.sessions.has(fSid), "the fill client's session is untouched");
  assert.ok((await fill.call("Test.echo", {})).result);
  assert.equal(agent.state.sentAfterClose, 0);
});

test("cdpmux: two clients using the same ids each get their own answer back", async () => {
  const { mux, fake } = world();
  const a = client(mux), b = client(mux);
  const [ra, rb] = await Promise.all([a.call("Test.echo", { n: "a" }, undefined, 1), b.call("Test.echo", { n: "b" }, undefined, 1)]);
  assert.equal(ra.id, 1);
  assert.equal(rb.id, 1);
  assert.deepEqual(ra.result.echo, { n: "a" });
  assert.deepEqual(rb.result.echo, { n: "b" });
  const ids = fake.seen.filter(s => s.method === "Test.echo").map(s => s.id);
  assert.equal(new Set(ids).size, 2, "Chrome saw both calls under distinct ids");
  assert.equal(a.inbox.filter(m => m.id === 1).length, 1);
  assert.equal(b.inbox.filter(m => m.id === 1).length, 1);
});

test("cdpmux: a child session belongs to the client that attached it, and no one else may use it", async () => {
  const { mux, fake } = world();
  const a = client(mux), b = client(mux);
  const { result: { targetInfos } } = await a.call("Target.getTargets");
  const r = await a.call("Target.attachToTarget", { targetId: targetInfos[0].targetId, flatten: true });
  const sid = r.result.sessionId;
  assert.ok(sid);
  assert.equal(a.events("Target.attachedToTarget").length, 1, "the attach is announced to its owner");
  assert.equal(b.events("Target.attachedToTarget").length, 0, "and to nobody else");

  const echo = await a.call("Test.echo", { n: 1 }, sid);
  assert.equal(echo.sessionId, sid);
  assert.ok(a.events("Test.echoed").some(e => e.sessionId === sid), "child session events reach the owner, keyed by the child");

  const stolen = await b.call("Test.echo", { n: 2 }, sid);
  assert.deepEqual(stolen.error, { code: -32001, message: "No session with given id" });
  assert.equal((await b.call("Target.detachFromTarget", { sessionId: sid })).error.code, -32001);
  assert.equal(b.events("Test.echoed").filter(e => e.sessionId === sid).length, 0, "no session event leaks to another client");
  assert.equal(fake.seen.filter(s => s.sessionId === sid).length, 1, "the refused call never reached Chrome");
  assert.ok(fake.sessions.has(sid));

  assert.equal((await a.call("Target.attachToTarget", { targetId: targetInfos[0].targetId })).error.code, -32602, "only flattened sessions");
  assert.ok((await a.call("Target.sendMessageToTarget", { sessionId: sid, message: "{}" })).error, "the unflattened channel is refused");

  assert.deepEqual((await a.call("Target.detachFromTarget", { sessionId: sid })).result, {});
  await a.waitFor(m => m.method === "Target.detachedFromTarget" && m.params.sessionId === sid);
  assert.equal((await a.call("Test.echo", {}, sid)).error.code, -32001, "a detached session is forgotten");
});

test("cdpmux: auto-attach is native per client, on its own browser session", async () => {
  const { mux, fake } = world();
  const a = client(mux), b = client(mux);
  const aSid = await browserSidOf(fake, a, "a");
  assert.deepEqual((await a.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })).result, {});
  const set = fake.seen.find(s => s.method === "Target.setAutoAttach");
  assert.equal(set && set.sessionId, aSid, "set on A's browser session");
  assert.equal(fake.sessions.get("").autoAttach, false, "never on the root");
  const first = a.events("Target.attachedToTarget");
  assert.equal(first.length, 1, "the existing page is attached for A");
  assert.equal(first[0].sessionId, undefined);
  const sid1 = first[0].params.sessionId;

  const { result: { targetId } } = await b.call("Target.createTarget", { url: "about:blank#two" });
  const second = await a.waitFor(m => m.method === "Target.attachedToTarget" && m.params.targetInfo.targetId === targetId);
  await tick(20);
  assert.equal(b.events("Target.attachedToTarget").length, 0, "B never asked");
  assert.ok((await a.call("Test.echo", {}, sid1)).result, "A can use its auto-attached sessions");
  assert.ok((await a.call("Test.echo", {}, second.params.sessionId)).result);
  assert.equal((await b.call("Test.echo", {}, second.params.sessionId)).error.code, -32001);
  assert.equal((await b.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false })).error.code, -32602);

  await b.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { result: { targetId: t3 } } = await a.call("Target.createTarget", { url: "about:blank#three" });
  const ea = await a.waitFor(m => m.method === "Target.attachedToTarget" && m.params.targetInfo.targetId === t3);
  const eb = await b.waitFor(m => m.method === "Target.attachedToTarget" && m.params.targetInfo.targetId === t3);
  assert.notEqual(ea.params.sessionId, eb.params.sessionId, "each gets a session of its own");
});

test("cdpmux: discovery is native per client: only the client that turned it on hears about targets", async () => {
  const { mux } = world();
  const a = client(mux), b = client(mux);
  await a.call("Target.setDiscoverTargets", { discover: true });
  assert.equal(a.events("Target.targetCreated").length, 1, "existing targets are announced");
  const { result: { targetId } } = await b.call("Target.createTarget", { url: "about:blank#new" });
  await a.waitFor(m => m.method === "Target.targetCreated" && m.params.targetInfo.targetId === targetId);
  await b.call("Target.closeTarget", { targetId });
  await a.waitFor(m => m.method === "Target.targetDestroyed" && m.params.targetId === targetId);
  assert.equal(b.events("Target.targetCreated").length + b.events("Target.targetDestroyed").length, 0);
  assert.ok(a.events("Target.targetCreated").every(e => e.sessionId === undefined));

  await a.call("Target.setDiscoverTargets", { discover: false });
  const before = a.events("Target.targetCreated").length;
  await b.call("Target.createTarget", { url: "about:blank#quiet" });
  await tick(20);
  assert.equal(a.events("Target.targetCreated").length, before, "off means off");
});

test("cdpmux: closeKind drops only that kind", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent"), fill = client(mux, "fill");
  await agent.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const agentSid = agent.events("Target.attachedToTarget")[0].params.sessionId;
  const fillSid = (await fill.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;

  assert.equal(mux.closeKind("agent"), 1);
  assert.equal(fill.state.closed, false);
  await tick(20);
  assert.ok(!fake.sessions.has(agentSid), "the agent's auto-attached session is gone");
  assert.ok(fake.sessions.has(fillSid));
  assert.ok((await fill.call("Test.echo", {}, fillSid)).result);
  await fill.call("Target.createTarget", { url: "about:blank#after" });
  await tick(20);
  assert.equal(agent.state.sentAfterClose, 0, "no auto-attach survives for a client that is gone");
  const late = client(mux, "agent");
  assert.equal((await late.call("Test.echo", {}, agentSid)).error.code, -32001, "an old session id is dead to a new client");
  assert.equal(mux.count("fill"), 1);
  assert.equal(mux.count("agent"), 1);
});

test("cdpmux: refusals, for everyone and for the agent alone, never reach Chrome", async () => {
  const { mux, fake, logs } = world();
  const agent = client(mux, "agent"), fill = client(mux, "fill");
  for (const method of ["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Target.exposeDevToolsProtocol", "Target.setRemoteLocations", "Target.attachToBrowserTarget"]) {
    assert.equal((await agent.call(method)).error.code, -32000, method);
    assert.equal((await fill.call(method)).error.code, -32000, method);
  }
  const sid = (await agent.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  assert.ok((await agent.call("Browser.close", {}, sid)).error, "not on a session either");
  for (const method of ["Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument"]) {
    assert.equal((await agent.call(method, {}, sid)).error.code, -32000, `${method} from the agent`);
    // The fill client may; the fake does not know these methods, so reaching it answers -32601.
    const fsid = (await fill.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
    assert.equal((await fill.call(method, {}, fsid)).error.code, -32601, `${method} from the fill client reaches Chrome`);
  }
  assert.ok(!fake.seen.some(s => s.method.startsWith("Browser.c") || s.method === "Target.setRemoteLocations" || s.method === "Target.exposeDevToolsProtocol"));
  assert.equal(fake.seen.filter(s => s.method === "Target.attachToBrowserTarget").length, 2, "only the mux's own, one per client");
  assert.equal(fake.seen.filter(s => s.method === "Runtime.addBinding").length, 1, "only the fill client's");
  assert.equal(fake.exited, false);
  assert.ok(logs.some(l => l.includes("refused Browser.close")));
});

test("cdpmux: a client leaving mid-call is never written to, and everything it attached is detached", async () => {
  const { mux, fake } = world();
  const a = client(mux), b = client(mux);
  await a.call("Test.echo");
  a.send("Test.delay", { ms: 30 });
  a.send("Target.attachToTarget", { targetId: "T1", flatten: true });
  a.h.leave();
  a.h.leave();
  const before = a.inbox.length;
  await tick(80);
  assert.equal(a.inbox.length, before, "nothing was sent to a client that left");
  assert.ok((await b.call("Test.echo", { n: 1 })).result, "everyone else carries on");
  const bSid = await browserSidOf(fake, b, "b");
  assert.deepEqual(fake.attached(), [bSid], "only B's browser session is left in Chrome");
  assert.equal(mux.count(), 1);
});

test("cdpmux: a client leaving before its browser session opens never keeps one", async () => {
  const { mux, fake } = world();
  const a = client(mux);
  a.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  a.h.leave();
  await tick(30);
  assert.deepEqual(fake.attached(), []);
  assert.ok(!fake.seen.some(s => s.method === "Fetch.enable"), "its queued call was never sent");
});

test("cdpmux: Chrome exiting fails every pending call, closes its clients, and a new pipe works", async () => {
  const w = world();
  const a = client(w.mux);
  const sid = (await a.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  const pendingId = a.send("Test.delay", { ms: 5000 }, sid);
  const pendingBrowser = a.send("Test.delay", { ms: 5000 });
  const internal = w.mux.call("Test.delay", { ms: 5000 });
  await tick(10);
  w.fake.exit();
  const failed = await a.waitFor(m => m.id === pendingId);
  assert.equal(failed.error.code, -32000);
  assert.match(failed.error.message, /Chrome/);
  assert.equal(failed.sessionId, sid);
  const failedBrowser = await a.waitFor(m => m.id === pendingBrowser);
  assert.equal(failedBrowser.sessionId, undefined);
  await assert.rejects(internal, /Chrome/);
  assert.equal(a.state.closed, true);
  assert.equal(w.mux.up, false);

  const b = client(w.mux);
  assert.equal(b.state.closed, true, "no client joins while Chrome is down");
  await assert.rejects(w.mux.call("Browser.getVersion"), /not running/);

  const toChrome = new PassThrough(), fromChrome = new PassThrough();
  const fake2 = new FakeChrome();
  fake2.wire(toChrome, fromChrome);
  w.mux.attach(toChrome, fromChrome);
  const c = client(w.mux);
  assert.equal((await c.call("Browser.getVersion")).result.product, "Chrome/140.0.0.0");
  assert.equal((await c.call("Test.echo", {}, sid)).error.code, -32001, "sessions from the dead Chrome are gone");
});

test("cdpmux: logs name methods and counts, never a message's contents", async () => {
  const { mux, logs } = world();
  const a = client(mux, "fill");
  const secret = "correct-horse-battery-staple-9f2c";
  const sid = (await a.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  await a.call("Test.echo", { value: secret }, sid);
  await a.call("Browser.close", { value: secret });
  a.h.receive("{not json " + secret);
  a.h.leave();
  await tick(10);
  assert.ok(logs.length > 0);
  assert.ok(!logs.join("\n").includes(secret));
});

test("cdpmux: messages split across chunks and several in one chunk are framed right", async () => {
  const toChrome = new PassThrough(), fromChrome = new PassThrough();
  const mux = new CdpMux();
  mux.attach(toChrome, fromChrome);
  /** @type {string} */
  let written = "";
  toChrome.on("data", d => { written += String(d); });
  const sent = () => written.split("\0").filter(Boolean).map(t => JSON.parse(t));
  const a = client(mux);
  a.send("Test.echo", {}, undefined, 7);
  await tick(5);
  const open = sent().find(m => m.method === "Target.attachToBrowserTarget");
  fromChrome.write(JSON.stringify({ id: open.id, result: { sessionId: "B-test" } }) + "\0");
  await tick(5);
  const echo = sent().find(m => m.method === "Test.echo");
  assert.equal(echo.sessionId, "B-test", "the queued call went out on the new browser session");
  const reply = JSON.stringify({ id: echo.id, result: { big: "x".repeat(70_000) }, sessionId: "B-test" }) + "\0" + JSON.stringify({ method: "Test.echoed", params: {}, sessionId: "B-test" }) + "\0";
  fromChrome.write(reply.slice(0, 1000));
  fromChrome.write(reply.slice(1000));
  const r = await a.waitFor(m => m.id === 7);
  assert.equal(r.result.big.length, 70_000);
  assert.equal(r.sessionId, undefined);
  await a.waitFor(m => m.method === "Test.echoed");
});

test("cdpmux: the agent may not dump cookies, open file:// or chrome:// pages, or send downloads elsewhere", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent"), fill = client(mux, "fill");
  const sid = (await agent.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  for (const method of ["Storage.getCookies", "Network.getAllCookies"]) assert.equal((await agent.call(method)).error.code, -32000, method);
  assert.equal((await agent.call("Network.getCookies", {}, sid)).error.code, -32000, "Network.getCookies on a page");
  for (const url of ["file:///var/lib/vyre/.vnc/passwd", "chrome://settings", "devtools://devtools/bundled/inspector.html",
    "chrome-extension://abc/x.html", "view-source:https://a.test", "FILE:///etc/passwd", " https://a.test", undefined]) {
    assert.equal((await agent.call("Page.navigate", { url }, sid)).error.code, -32000, `Page.navigate ${url}`);
    assert.equal((await agent.call("Target.createTarget", { url })).error.code, -32000, `Target.createTarget ${url}`);
  }
  for (const url of ["https://portal.northwind.test/login", "http://harlow.test", "about:blank", "data:text/html,hi"]) {
    assert.ok(!(await agent.call("Target.createTarget", { url })).error, `Target.createTarget ${url}`);
  }
  const dl = p => agent.call("Browser.setDownloadBehavior", p);
  assert.equal((await dl({ behavior: "allow", downloadPath: "/var/lib/vyre" })).error.code, -32000);
  assert.equal((await dl({ behavior: "allow" })).error.code, -32000, "allow must name the folder");
  assert.equal((await dl({ behavior: "deny", downloadPath: "/tmp" })).error.code, -32000);
  assert.equal((await agent.call("Page.setDownloadBehavior", { behavior: "allow", downloadPath: "/home/agent" }, sid)).error.code, -32000);
  assert.equal((await dl({ behavior: "allow", downloadPath: "/home/agent/Downloads" })).error.code, -32000, "not under /home/agent any more (MEDIUM 3)");
  for (const p of [{ behavior: "allow", downloadPath: "/var/lib/vyre/downloads" }, { behavior: "allowAndName", downloadPath: "/var/lib/vyre/downloads/" }, { behavior: "deny" }]) {
    const r = await dl(p);
    assert.notEqual(r.error && r.error.code, -32000, JSON.stringify(p));
  }
  assert.ok(!fake.seen.some(s => /Cookies$/.test(s.method)), "a cookie dump reached Chrome");
  assert.ok(!fake.seen.some(s => s.method === "Page.navigate"), "a refused navigation reached Chrome");
  // The Vault's fill client opens its own pages; only the agent is held to this.
  assert.ok(!(await fill.call("Target.createTarget", { url: "https://portal.northwind.test/login" })).error);
  const fsid = (await fill.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  assert.notEqual((await fill.call("Network.getCookies", {}, fsid)).error?.code, -32000, "the fill client is not refused");
});

test("cdpmux: the agent cannot attach a local file to a page -- setFileInputFiles is refused outright, and a drag is refused only when it carries files (e2e review, HIGH 1)", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent"), fill = client(mux, "fill");
  const sid = (await agent.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  for (const files of [["/var/lib/vyre/.boot"], ["/var/lib/vyre/chromium/Default/Cookies"], []]) {
    assert.equal((await agent.call("DOM.setFileInputFiles", { files, nodeId: 1 }, sid)).error.code, -32000, `setFileInputFiles ${JSON.stringify(files)}`);
  }
  assert.equal((await agent.call("Input.dispatchDragEvent", { type: "drop", x: 1, y: 1, data: { items: [], files: ["/var/lib/vyre/.boot"] } }, sid)).error.code, -32000,
    "a drop carrying files");
  assert.notEqual((await agent.call("Input.dispatchDragEvent", { type: "dragEnter", x: 1, y: 1, data: { items: [], files: [] } }, sid)).error?.code, -32000,
    "a drag with an empty files list (no attachment) is unaffected");
  assert.notEqual((await agent.call("Input.dispatchDragEvent", { type: "dragEnter", x: 1, y: 1, data: { items: [] } }, sid)).error?.code, -32000,
    "a drag with no files field at all -- reordering within a page -- is unaffected");
  assert.ok(!fake.seen.some(s => s.method === "DOM.setFileInputFiles"), "a file attachment reached Chrome");
  assert.ok(!fake.seen.some(s => s.method === "Input.dispatchDragEvent" && s.params?.data?.files?.length), "a file-carrying drag reached Chrome");
  // Neither is fenced for the vault's fill client (it opens its own pages, never the agent's).
  const fsid = (await fill.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  assert.notEqual((await fill.call("DOM.setFileInputFiles", { files: ["/var/lib/vyre/.boot"], nodeId: 1 }, fsid)).error?.code, -32000);
});

test("cdpmux: Cookie and Set-Cookie never reach the agent in a Network/Fetch event, whatever case Chrome sent them in; every other header does (e2e review, MEDIUM 4)", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent"), fill = client(mux, "fill");
  const asid = (await agent.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;
  const fsid = (await fill.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;

  fake.emit(asid, "Network.requestWillBeSentExtraInfo", { requestId: "r1", headers: { Cookie: "sid=abc", "User-Agent": "x" } });
  const reqInfo = (await agent.waitFor(m => m.method === "Network.requestWillBeSentExtraInfo")).params;
  assert.equal(reqInfo.headers.Cookie, undefined);
  assert.equal(reqInfo.headers["User-Agent"], "x", "a non-cookie header still arrives");

  fake.emit(asid, "Network.responseReceivedExtraInfo", { requestId: "r1", headers: { "set-cookie": "sid=abc; HttpOnly", "Content-Type": "text/html" } });
  const resInfo = (await agent.waitFor(m => m.method === "Network.responseReceivedExtraInfo")).params;
  assert.equal(resInfo.headers["set-cookie"], undefined);
  assert.equal(resInfo.headers["Content-Type"], "text/html");

  fake.emit(asid, "Fetch.requestPaused", { requestId: "f1", request: { url: "https://a.test", headers: { COOKIE: "sid=abc", Accept: "*/*" } },
    responseHeaders: [{ name: "Set-Cookie", value: "sid=abc" }, { name: "Content-Length", value: "3" }] });
  const paused = (await agent.waitFor(m => m.method === "Fetch.requestPaused")).params;
  assert.equal(paused.request.headers.COOKIE, undefined);
  assert.equal(paused.request.headers.Accept, "*/*");
  assert.deepEqual(paused.responseHeaders, [{ name: "Content-Length", value: "3" }]);

  // The vault's fill client is not held to this: it opens its own sign-in pages and needs to see
  // what it sent.
  fake.emit(fsid, "Network.requestWillBeSentExtraInfo", { requestId: "r2", headers: { Cookie: "sid=abc" } });
  const fillInfo = (await fill.waitFor(m => m.method === "Network.requestWillBeSentExtraInfo")).params;
  assert.equal(fillInfo.headers.Cookie, "sid=abc");
});
