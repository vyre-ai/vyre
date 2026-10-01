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

/** @param {CdpMux} mux @param {string} [kind] @param {string} [agentId] @param {string} [agentName] */
function client(mux, kind = "agent", agentId, agentName) {
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
  }, agentId, agentName);
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
  for (const method of ["Storage.getCookies", "Network.getAllCookies", "Page.getCookies"]) assert.equal((await agent.call(method)).error.code, -32000, method);
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
  for (const p of [{ behavior: "allow", downloadPath: "/var/lib/vyre/browser/downloads" }, { behavior: "allowAndName", downloadPath: "/var/lib/vyre/browser/downloads/" }, { behavior: "deny" }]) {
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

test("cdpmux: a cookie's actual value never reaches the agent through associatedCookies, headersText, a WebSocket handshake, or an Audits issue (reviewer, 28 Sep)", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent");
  const asid = (await agent.call("Target.attachToTarget", { targetId: "T1", flatten: true })).result.sessionId;

  fake.emit(asid, "Network.requestWillBeSentExtraInfo", {
    requestId: "r1", headers: { "User-Agent": "x" },
    associatedCookies: [{ cookie: { name: "sid", value: "abc", domain: "a.test" }, blockedReasons: [] }],
  });
  const reqInfo = (await agent.waitFor(m => m.method === "Network.requestWillBeSentExtraInfo")).params;
  assert.equal(reqInfo.associatedCookies, undefined, "associatedCookies reached the agent");
  assert.equal(reqInfo.headers["User-Agent"], "x", "a non-cookie header still arrives");

  fake.emit(asid, "Network.responseReceivedExtraInfo", {
    requestId: "r1", headers: { "Content-Type": "text/html" }, headersText: "HTTP/1.1 200 OK\r\nSet-Cookie: sid=abc\r\n",
    blockedCookies: [{ blockedReasons: ["SecureOnly"], cookieLine: "sid=abc; Secure" }],
    exemptedCookies: [{ cookie: { name: "sid", value: "abc" }, exemptionReason: "UserSetting" }],
  });
  const resInfo = (await agent.waitFor(m => m.method === "Network.responseReceivedExtraInfo")).params;
  assert.equal(resInfo.headersText, undefined, "the raw header block reached the agent");
  assert.equal(resInfo.blockedCookies, undefined, "blockedCookies reached the agent");
  assert.equal(resInfo.exemptedCookies, undefined, "exemptedCookies reached the agent");
  assert.equal(resInfo.headers["Content-Type"], "text/html");

  fake.emit(asid, "Network.webSocketWillSendHandshakeRequest", {
    requestId: "w1", timestamp: 0, wallTime: 0, request: { headers: { Cookie: "sid=abc", Origin: "https://a.test" } },
  });
  const wsReq = (await agent.waitFor(m => m.method === "Network.webSocketWillSendHandshakeRequest")).params;
  assert.equal(wsReq.request.headers.Cookie, undefined, "the WebSocket handshake request carried Cookie");
  assert.equal(wsReq.request.headers.Origin, "https://a.test");

  fake.emit(asid, "Network.webSocketHandshakeResponseReceived", {
    requestId: "w1", timestamp: 0, response: { headers: { "Set-Cookie": "sid=abc" }, headersText: "raw", requestHeaders: { Cookie: "sid=abc" }, requestHeadersText: "raw" },
  });
  const wsRes = (await agent.waitFor(m => m.method === "Network.webSocketHandshakeResponseReceived")).params;
  assert.equal(wsRes.response.headers["Set-Cookie"], undefined);
  assert.equal(wsRes.response.headersText, undefined);
  assert.equal(wsRes.response.requestHeaders.Cookie, undefined, "requestHeaders (a headers map) carried Cookie to the agent");
  assert.equal(wsRes.response.requestHeadersText, undefined);

  fake.emit(asid, "Audits.issueAdded", {
    issue: { code: "CookieIssue", details: { cookieIssueDetails: { cookie: { name: "sid", domain: "a.test" }, rawCookieLine: "sid=abc; Secure", cookieWarningReasons: [] } } },
  });
  const audit = (await agent.waitFor(m => m.method === "Audits.issueAdded")).params;
  assert.equal(audit.issue.details.cookieIssueDetails.rawCookieLine, undefined, "Audits carried rawCookieLine to the agent");
  assert.equal(audit.issue.code, "CookieIssue", "the rest of the issue still arrives");

  assert.equal((await agent.call("Network.loadNetworkResource")).error.code, -32000, "the agent can read an arbitrary URL's bytes");
});

test("cdpmux: two agent clients joining with the same agentName share one browserContextId, made once", async () => {
  const { mux, fake } = world();
  const a1 = client(mux, "agent", "alice");
  const a2 = client(mux, "agent", "alice");
  const t1 = await a1.call("Target.createTarget", { url: "about:blank#1" });
  const t2 = await a2.call("Target.createTarget", { url: "about:blank#2" });
  const ctx1 = fake.targets.get(t1.result.targetId).browserContextId;
  const ctx2 = fake.targets.get(t2.result.targetId).browserContextId;
  assert.ok(ctx1, "alice got a browser context");
  assert.equal(ctx1, ctx2, "the same agent name reuses it, not a second one");
  assert.equal(fake.seen.filter(s => s.method === "Target.createBrowserContext").length, 1,
    "Target.createBrowserContext was called once, not once per client");
  assert.equal(mux.contextStore.get("alice"), ctx1, "and stored under the agent's name");
});

test("cdpmux: two agent clients with different agentNames get different browserContextIds", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  const b = client(mux, "agent", "bob");
  const ta = await a.call("Target.createTarget", { url: "about:blank#a" });
  const tb = await b.call("Target.createTarget", { url: "about:blank#b" });
  const ctxA = fake.targets.get(ta.result.targetId).browserContextId;
  const ctxB = fake.targets.get(tb.result.targetId).browserContextId;
  assert.ok(ctxA && ctxB);
  assert.notEqual(ctxA, ctxB);
  assert.equal(fake.seen.filter(s => s.method === "Target.createBrowserContext").length, 2, "one per agent name");
});

test("cdpmux: closeAgent drops the agent's own clients but leaves its browser context alone -- deletion is a separate, explicit action (reviewer + lead, 28 Sep, revising the first cut's auto-dispose)", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "id-alice", "alice");
  await a.call("Target.createTarget", { url: "about:blank#alice" });
  const ctx = mux.contextStore.get("id-alice");
  assert.ok(ctx, "alice never got a context to begin with");

  const n = mux.closeAgent("id-alice");
  assert.equal(n, 1, "closeAgent did not drop alice's own client");
  assert.ok(a.state.closed, "alice's client was not actually dropped");
  assert.equal(mux.contextStore.get("id-alice"), ctx, "closeAgent disposed the context -- that is disposeAgentContext's own job now, not revocation's");
  assert.ok(!fake.seen.some(s => s.method === "Target.disposeBrowserContext"), "closeAgent called disposeBrowserContext on its own");

  // Reconnecting with the SAME id (the same agent, just a fresh client) picks the same context
  // back up -- that is the point of leaving it alone on revoke.
  const a2 = client(mux, "agent", "id-alice", "alice");
  await a2.call("Target.getTargets");
  assert.equal(mux.contextStore.get("id-alice"), ctx, "the same agent id lost its own context across a reconnect");
});

test("cdpmux: closeAgent is keyed by agentId, never agentName -- a reused display name for a genuinely different (different-id) agent never touches the old agent's context, with no dispose needed at all", async () => {
  const { mux } = world();
  const a = client(mux, "agent", "id-1", "alice");
  await a.call("Target.createTarget", { url: "about:blank#1" });
  const firstCtx = mux.contextStore.get("id-1");
  mux.closeAgent("id-1"); // revoke the first "alice" (id-1); its context is untouched, per above

  // A genuinely different agent, given the SAME display name "alice" but a NEW id, never reaches
  // id-1's context -- contextStore is keyed by id, so this was already true before closeAgent was
  // even involved; closeAgent's own change (not disposing) does not create this gap, it just no
  // longer auto-closes it either -- disposal (below) is how a person actually reclaims it.
  const b = client(mux, "agent", "id-2", "alice");
  await b.call("Target.createTarget", { url: "about:blank#2" });
  const secondCtx = mux.contextStore.get("id-2");
  assert.ok(secondCtx, "the new agent (same display name, different id) got no context of its own");
  assert.notEqual(secondCtx, firstCtx, "the same display name reached the old agent's own context");
});

test("cdpmux: closeAgent on an id with no live clients and no context is a harmless no-op", async () => {
  const { mux } = world();
  assert.equal(mux.closeAgent("nobody-ever-heard-of"), 0);
});

test("cdpmux: disposeAgentContext deletes the context and disposes it in Chrome, is a no-op with none, and does not itself touch live clients (reviewer + lead, 28 Sep -- the explicit, owner-only deletion action)", async () => {
  const { mux, fake } = world();
  assert.equal(mux.disposeAgentContext("nobody-ever-heard-of"), false, "disposing a nonexistent context reported one existed");

  const a = client(mux, "agent", "id-alice", "alice");
  await a.call("Target.createTarget", { url: "about:blank#alice" });
  const ctx = mux.contextStore.get("id-alice");
  assert.ok(ctx);

  const disposed = mux.disposeAgentContext("id-alice");
  assert.equal(disposed, true, "disposeAgentContext reported no context to dispose");
  assert.equal(mux.contextStore.get("id-alice"), undefined, "the context is still in contextStore after disposal");
  await tick(20); // the mux's own disposeBrowserContext call, fire-and-forget, writes asynchronously
  assert.ok(fake.seen.some(s => s.method === "Target.disposeBrowserContext" && s.params.browserContextId === ctx),
    "Target.disposeBrowserContext was never called");
  // disposeAgentContext does not itself drop clients -- that is closeAgent's job, and the lead's
  // own note says callers should closeAgent first, not rely on this to do it.
  assert.ok(!a.state.closed, "disposeAgentContext dropped a still-live client on its own");

  // A later client for the SAME id now gets a genuinely fresh context, made once.
  const before = fake.seen.filter(s => s.method === "Target.createBrowserContext").length;
  const a2 = client(mux, "agent", "id-alice", "alice");
  await a2.call("Target.getTargets");
  const freshCtx = mux.contextStore.get("id-alice");
  assert.ok(freshCtx && freshCtx !== ctx, "the same id, after disposal, reused the old context instead of a fresh one");
  assert.equal(fake.seen.filter(s => s.method === "Target.createBrowserContext").length, before + 1, "a fresh context was not actually made");
});

test("cdpmux: an agent client's own Target.createTarget with no browserContextId gets its own injected before it reaches Chrome", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  await a.call("Target.createTarget", { url: "about:blank#x" });
  const ctxId = mux.contextStore.get("alice");
  assert.ok(ctxId);
  const seenCall = fake.seen.find(s => s.method === "Target.createTarget");
  assert.equal(seenCall.params.browserContextId, ctxId, "injected by the mux, not left for Chrome's own default");
});

test("cdpmux: an agent client's Target.createTarget naming a different browserContextId than its own is refused, never rewritten", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  const b = client(mux, "agent", "bob");
  // Settle both agents' own contexts first.
  await a.call("Target.createTarget", { url: "about:blank#a" });
  await b.call("Target.createTarget", { url: "about:blank#b" });
  const bobCtx = mux.contextStore.get("bob");
  const before = fake.seen.filter(s => s.method === "Target.createTarget").length;
  const r = await a.call("Target.createTarget", { url: "about:blank#c", browserContextId: bobCtx });
  assert.equal(r.error.code, -32000, "refused, not silently corrected to alice's own context");
  assert.equal(fake.seen.filter(s => s.method === "Target.createTarget").length, before, "the call never reached Chrome");
});

test("cdpmux: Target.getBrowserContexts is refused outright for every client (reviewer H1, 28 Sep)", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent", "alice"), unscoped = client(mux, "agent"), fill = client(mux, "fill");
  await agent.call("Test.echo"); // let alice's join settle
  for (const c of [agent, unscoped, fill]) assert.equal((await c.call("Target.getBrowserContexts")).error.code, -32000);
  assert.ok(!fake.seen.some(s => s.method === "Target.getBrowserContexts"), "never reached Chrome");
});

test("cdpmux: any call naming another agent's browserContextId is refused, not just Target.createTarget (reviewer H1, 28 Sep)", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  const b = client(mux, "agent", "bob");
  await a.call("Test.echo"); await b.call("Test.echo"); // settle both contexts
  const bobCtx = mux.contextStore.get("bob");
  for (const method of ["Storage.setCookies", "Storage.clearCookies", "Browser.grantPermissions", "Browser.resetPermissions",
    "Browser.setDownloadBehavior", "Page.setDownloadBehavior"]) {
    const before = fake.seen.filter(s => s.method === method).length;
    const r = await a.call(method, { browserContextId: bobCtx });
    assert.equal(r.error.code, -32000, `${method} naming bob's context reached Chrome or was not refused`);
    assert.equal(fake.seen.filter(s => s.method === method).length, before, `${method} reached Chrome`);
  }
  // Alice's own context on the same calls is not refused by this check (whatever else Chrome or
  // another refusal does with it is not this test's concern -- fake-chrome answers "not found"
  // for methods it doesn't implement, which is fine: what matters is it was not refused as a
  // wrong-context claim).
  const aliceCtx = mux.contextStore.get("alice");
  const r2 = await a.call("Storage.setCookies", { browserContextId: aliceCtx, cookies: [] });
  assert.notEqual(r2.error && r2.error.code, -32000, "alice's own context was refused as if it were another agent's");
});

test("cdpmux: an agent client cannot attach to, close, activate or read another agent's target by id (reviewer H2, 28 Sep)", async () => {
  const { mux } = world();
  const a = client(mux, "agent", "alice");
  const b = client(mux, "agent", "bob");
  const { result: { targetId: bTargetId } } = await b.call("Target.createTarget", { url: "about:blank#bob" });
  for (const [method, params] of [
    ["Target.attachToTarget", { targetId: bTargetId, flatten: true }],
    ["Target.closeTarget", { targetId: bTargetId }],
    ["Target.activateTarget", { targetId: bTargetId }],
    ["Target.getTargetInfo", { targetId: bTargetId }],
  ]) {
    const r = await a.call(method, params);
    assert.equal(r.error && r.error.code, -32000, `alice's own ${method} on bob's target was not refused`);
  }
  // Bob himself may still close his own target -- H2 is not a blanket refusal of these methods.
  const r = await b.call("Target.closeTarget", { targetId: bTargetId });
  assert.ok(!r.error, "bob could not close his own target");
});

test("cdpmux: an agent client naming a targetId targetContext has never learned is refused, not assumed safe (reviewer H2, 28 Sep)", async () => {
  const { mux } = world();
  const a = client(mux, "agent", "alice");
  await a.call("Test.echo"); // settle alice's own context first
  const r = await a.call("Target.closeTarget", { targetId: "no-such-target-anyone-ever-saw" });
  assert.equal(r.error.code, -32000, "an unknown targetId was not refused");
});

test("cdpmux: a scoped agent client's own Target.closeTarget on its own target works even when nobody ever turned discovery on for it (reviewer H2 follow-up, 28 Sep)", async () => {
  const { mux } = world();
  const a = client(mux, "agent", "alice");
  // Deliberately never calls Target.setDiscoverTargets or setAutoAttach: targetContext must still
  // learn alice's own target's context from the Target.createTarget response itself (_response),
  // not only from an event nobody is listening for.
  const { result: { targetId } } = await a.call("Target.createTarget", { url: "about:blank#no-discovery" });
  const r = await a.call("Target.closeTarget", { targetId });
  assert.ok(!r.error, `alice could not close her own target with no discovery ever on: ${JSON.stringify(r.error)}`);
});

test("cdpmux: Target.setAutoAttach with waitForDebuggerOnStart is refused for a context-scoped agent client (reviewer M2, 28 Sep)", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  const fill = client(mux, "fill"); // unaffected -- no context, no DoS risk this fix is about
  const before = fake.seen.filter(s => s.method === "Target.setAutoAttach").length;
  const r = await a.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.equal(r.error.code, -32602);
  assert.equal(fake.seen.filter(s => s.method === "Target.setAutoAttach").length, before, "reached Chrome despite being refused");
  const r2 = await a.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  assert.ok(!r2.error, "waitForDebuggerOnStart: false was wrongly refused too");
  const r3 = await fill.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.ok(!r3.error, "a fill client (no browser context) was wrongly refused");
});

test("cdpmux: an agent client omitting browserContextId on Storage.setCookies gets her own pinned in, not left to reach Chrome's default context (reviewer M3, 28 Sep)", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  await a.call("Test.echo"); // settle alice's own context first
  const aliceCtx = mux.contextStore.get("alice");
  const r = await a.call("Storage.setCookies", { cookies: [] });
  assert.notEqual(r.error && r.error.code, -32000, "leaving browserContextId out was wrongly refused for an OPTIONAL_CONTEXT_METHODS entry");
  const seen = fake.seen.find(s => s.method === "Storage.setCookies");
  assert.ok(seen, "Storage.setCookies never reached Chrome");
  assert.equal(seen.params.browserContextId, aliceCtx, "alice's own context was not pinned in when she left it out -- it would have hit Chrome's default context");
});

test("cdpmux: an agent client omitting browserContextId on a Browser/Storage call NOT in OPTIONAL_CONTEXT_METHODS is refused outright, not left to reach Chrome's default context (reviewer M3, 28 Sep)", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  const fill = client(mux, "fill"); // no context -- untouched by this check
  const before = fake.seen.filter(s => s.method === "Browser.setWindowBounds").length;
  const r = await a.call("Browser.setWindowBounds", { windowId: 1, bounds: {} });
  assert.equal(r.error && r.error.code, -32000, "a Browser call with no browserContextId, not in the optional set, was not refused");
  assert.equal(fake.seen.filter(s => s.method === "Browser.setWindowBounds").length, before, "reached Chrome despite being refused");
  const r2 = await fill.call("Browser.setWindowBounds", { windowId: 1, bounds: {} });
  assert.notEqual(r2.error && r2.error.code, -32000, "a fill client (no browser context) was wrongly refused by the M3 check");
  // Browser.getVersion, CONTEXT_READONLY_METHODS' own example, is untouched.
  const r3 = await a.call("Browser.getVersion");
  assert.ok(!r3.error, "Browser.getVersion was wrongly refused");
});

test("cdpmux: Target.autoAttachRelated targeting another agent's target is refused, and waitForDebuggerOnStart on it is refused too, even on her own target (reviewer M4, 28 Sep)", async () => {
  const { mux } = world();
  const a = client(mux, "agent", "alice");
  const b = client(mux, "agent", "bob");
  const { result: { targetId: bTargetId } } = await b.call("Target.createTarget", { url: "about:blank#bob" });
  const cross = await a.call("Target.autoAttachRelated", { targetId: bTargetId, waitForDebuggerOnStart: false });
  assert.equal(cross.error && cross.error.code, -32000, "alice's autoAttachRelated naming bob's target was not refused (H2/M4)");

  const { result: { targetId: aTargetId } } = await a.call("Target.createTarget", { url: "about:blank#alice" });
  const paused = await a.call("Target.autoAttachRelated", { targetId: aTargetId, waitForDebuggerOnStart: true });
  assert.equal(paused.error && paused.error.code, -32602, "waitForDebuggerOnStart on autoAttachRelated, even on alice's own target, was not refused");
  // fake-chrome does not implement autoAttachRelated (-32601, "not found"); what matters here is
  // that the mux itself let it through rather than refusing it (-32000/-32602) before Chrome ever saw it.
  const fine = await a.call("Target.autoAttachRelated", { targetId: aTargetId, waitForDebuggerOnStart: false });
  assert.notEqual(fine.error && fine.error.code, -32602, "autoAttachRelated with no waitForDebuggerOnStart was wrongly refused as if it carried one");
  assert.notEqual(fine.error && fine.error.code, -32000, "autoAttachRelated on alice's own target was wrongly refused as a foreign-target claim");
});

test("cdpmux: a context-scoped agent's browser-level session is an allowlist -- Tracing.start (browser-wide, records every context) is refused; Target.*, Browser.getVersion and the pinned OPTIONAL_CONTEXT_METHODS still work (reviewer M5, 28 Sep)", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  const fill = client(mux, "fill"); // no context -- M5 is about scoped clients only
  const unscoped = client(mux, "agent"); // an agent with no agentName: also unaffected, still dormant

  for (const method of ["Tracing.start", "Tracing.end", "IO.read", "Extensions.loadUnpacked"]) {
    const before = fake.seen.filter(s => s.method === method).length;
    const r = await a.call(method, {});
    assert.equal(r.error && r.error.code, -32000, `${method} on alice's browser-level session was not refused`);
    assert.equal(fake.seen.filter(s => s.method === method).length, before, `${method} reached Chrome despite being refused`);
  }
  // Allowed at the browser level for a scoped client: Target.* (already fenced individually),
  // Browser.getVersion, and an OPTIONAL_CONTEXT_METHODS entry (Storage.setCookies, pinned by M3).
  assert.ok(!(await a.call("Browser.getVersion")).error, "Browser.getVersion was wrongly refused");
  assert.ok(!(await a.call("Target.getTargets")).error, "Target.getTargets was wrongly refused");
  // fake-chrome does not implement Storage.setCookies (-32601, "not found"); what matters is that
  // the mux itself did not refuse it (-32000) as if it were outside the M5 allowlist.
  const setCookies = await a.call("Storage.setCookies", { cookies: [] });
  assert.notEqual(setCookies.error && setCookies.error.code, -32000, "a pinned OPTIONAL_CONTEXT_METHODS call was wrongly refused");

  // Unaffected: a fill client, and an agent with no agentName (still dormant -- unscoped).
  const fillTracing = await fill.call("Tracing.start", {});
  assert.notEqual(fillTracing.error && fillTracing.error.code, -32000, "a fill client's Tracing.start was refused by the M5 allowlist");
  const unscopedTracing = await unscoped.call("Tracing.start", {});
  assert.notEqual(unscopedTracing.error && unscopedTracing.error.code, -32000, "an unscoped agent's Tracing.start was refused by the M5 allowlist");

  // A child (page) session is unaffected: it is already bound to alice's own target.
  const { result: { targetId } } = await a.call("Target.createTarget", { url: "about:blank#alice" });
  const { result: { sessionId } } = await a.call("Target.attachToTarget", { targetId, flatten: true });
  const onPage = await a.call("Test.echo", { n: 1 }, sessionId);
  assert.ok(!onPage.error, "a call on alice's own child session was wrongly refused by the M5 allowlist");
});

test("cdpmux: the target-event fence drops an event with no browserContextId at all, not only a known mismatch (reviewer M1, 28 Sep)", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  await a.call("Target.setDiscoverTargets", { discover: true });
  // alice's own browser session, at the mux level (not a per-target child session): the same
  // session her own session-less calls resolve to and her own root-level events arrive on.
  const aliceSid = [...mux.sessions.entries()].find(([, s]) => s.browser && s.client.agentName === "alice")[0];
  // Some CDP target genuinely carries no browserContextId at all (an older Chrome, or the
  // browser's own non-page targets) -- must never reach a context-scoped client either way, the
  // same as a known mismatch: ctx is undefined, and undefined is not alice's own context.
  const beforeEvents = a.events("Target.targetCreated").length;
  fake.emit(aliceSid, "Target.targetCreated", { targetInfo: { targetId: "no-context-target", type: "page", title: "", url: "about:blank" } });
  await tick(20);
  assert.equal(a.events("Target.targetCreated").filter(e => e.params.targetInfo.targetId === "no-context-target").length, beforeEvents,
    "a target event with no browserContextId at all reached a context-scoped client");
});

test("cdpmux: a client of agent A never learns agent B's targets exist -- targetCreated, targetDestroyed and attachedToTarget are all fenced to A's own browserContextId", async () => {
  const { mux } = world();
  const a = client(mux, "agent", "alice");
  const b = client(mux, "agent", "bob");
  await a.call("Target.setDiscoverTargets", { discover: true });
  await b.call("Target.setDiscoverTargets", { discover: true });

  const { result: { targetId: bTargetId } } = await b.call("Target.createTarget", { url: "about:blank#bob" });
  await tick(20);
  assert.equal(a.events("Target.targetCreated").filter(e => e.params.targetInfo.targetId === bTargetId).length, 0,
    "A never sees B's target created, though Chrome's own discovery is browser-wide, not per context");
  assert.ok(b.events("Target.targetCreated").some(e => e.params.targetInfo.targetId === bTargetId), "B sees its own");

  await b.call("Target.closeTarget", { targetId: bTargetId });
  await tick(20);
  assert.equal(a.events("Target.targetDestroyed").filter(e => e.params.targetId === bTargetId).length, 0,
    "A never sees B's target destroyed either, though targetDestroyed itself carries no browserContextId at all");
  assert.ok(b.events("Target.targetDestroyed").some(e => e.params.targetId === bTargetId), "B sees its own destroyed");

  // Auto-attach fans out the same way discovery does (browser-wide, not per context) -- fenced the same way.
  await a.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await b.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { result: { targetId: bTargetId2 } } = await b.call("Target.createTarget", { url: "about:blank#bob2" });
  await tick(20);
  assert.equal(a.events("Target.attachedToTarget").filter(e => e.params.targetInfo.targetId === bTargetId2).length, 0,
    "A's auto-attach never attaches to B's target");
  assert.ok(b.events("Target.attachedToTarget").some(e => e.params.targetInfo.targetId === bTargetId2), "B still sees its own");
});

test("cdpmux: Target.getTargets answers a context-scoped agent client with only its own context's targets, though Chrome's own answer names every target in the browser", async () => {
  const { mux, fake } = world();
  const a = client(mux, "agent", "alice");
  const b = client(mux, "agent", "bob");
  const { result: { targetId: aTargetId } } = await a.call("Target.createTarget", { url: "about:blank#alice" });
  const { result: { targetId: bTargetId } } = await b.call("Target.createTarget", { url: "about:blank#bob" });

  const chromeAnswer = await mux.call("Target.getTargets");
  assert.ok(chromeAnswer.targetInfos.some(t => t.targetId === aTargetId) && chromeAnswer.targetInfos.some(t => t.targetId === bTargetId),
    "Chrome's own answer (unfenced, the mux's own call) names both -- the fence is cdpmux's, not Chrome's");

  const aAnswer = await a.call("Target.getTargets");
  assert.ok(aAnswer.result.targetInfos.some(t => t.targetId === aTargetId), "alice's own answer is missing her own target");
  assert.ok(!aAnswer.result.targetInfos.some(t => t.targetId === bTargetId), "alice's answer names bob's target");

  const bAnswer = await b.call("Target.getTargets");
  assert.ok(bAnswer.result.targetInfos.some(t => t.targetId === bTargetId), "bob's own answer is missing his own target");
  assert.ok(!bAnswer.result.targetInfos.some(t => t.targetId === aTargetId), "bob's answer names alice's target");
});

test("cdpmux: Target.createBrowserContext and Target.disposeBrowserContext sent directly by a client are refused, the same as any other REFUSED method", async () => {
  const { mux, fake } = world();
  const agent = client(mux, "agent", "alice"), fill = client(mux, "fill");
  await agent.call("Test.echo"); // let alice's own join (and the mux's own Target.createBrowserContext for it) settle first
  const before = fake.seen.filter(s => s.method === "Target.createBrowserContext").length;
  assert.ok(before >= 1, "the mux made its own call for alice's join");
  for (const method of ["Target.createBrowserContext", "Target.disposeBrowserContext"]) {
    assert.equal((await agent.call(method)).error.code, -32000, `${method} from an agent client`);
    assert.equal((await fill.call(method)).error.code, -32000, `${method} from a fill client`);
  }
  assert.equal(fake.seen.filter(s => s.method === "Target.createBrowserContext").length, before, "no client's direct call ever reached Chrome");
  assert.ok(!fake.seen.some(s => s.method === "Target.disposeBrowserContext"), "disposeBrowserContext never reached Chrome either");
});

test("cdpmux: a 'fill' client ignores agentName entirely -- no browser context, no createTarget enforcement (regression)", async () => {
  const { mux, fake } = world();
  const fill = client(mux, "fill", "alice"); // agentName means nothing for a fill client
  const r = await fill.call("Target.createTarget", { url: "about:blank#fill" });
  assert.ok(!r.error);
  const seenCall = fake.seen.find(s => s.method === "Target.createTarget");
  assert.equal(seenCall.params.browserContextId, undefined, "no browserContextId injected for a fill client");
  assert.equal(fake.seen.filter(s => s.method === "Target.createBrowserContext").length, 0, "a fill client never triggers a browser-context creation");
});

test("cdpmux: a call sent while an agent's browser context is still being made waits for it, so its Target.createTarget lands in that context, never the shared one", async () => {
  const { mux, fake } = world();
  // Chrome answers Target.createBrowserContext late: the browser session is up and the context is not.
  const real = mux.call.bind(mux);
  mux.call = (method, params, sid) => (method === "Target.createBrowserContext" ? tick(80).then(() => real(method, params, sid)) : real(method, params, sid));
  const a = client(mux, "agent", "alice-1", "alice");
  // The window itself: the browser session is up and the context is not yet made.
  const inner = [...mux.clients][0];
  for (let i = 0; i < 100 && !inner.browserSid; i++) await tick(2);
  assert.ok(inner.browserSid && !inner.browserContextId, "the browser session is open and the context is still being made");
  const made = a.call("Target.createTarget", { url: "about:blank#alice" });
  const { result } = await made;
  const info = [...fake.targets.values()].find(t => t.targetId === result.targetId);
  assert.ok(info && info.browserContextId && info.browserContextId !== "ctx-default", `created in the agent's own context, not the shared default one: ${JSON.stringify(info)}`);
  assert.equal(info.browserContextId, inner.browserContextId, "the context the mux made for this agent");
  const listed = (await a.call("Target.getTargets")).result.targetInfos.map(t => t.targetId);
  assert.ok(listed.includes(result.targetId), "and the agent sees its own target");
});

test("cdpmux: an agent client that somehow has no browser context is dropped, never served unfenced", async () => {
  const { mux } = world();
  const a = client(mux, "agent", "alice-1", "alice");
  await a.call("Target.getTargets");
  const inner = [...mux.clients][0];
  inner.browserContextId = null; // a future path that skips the ready gate
  a.send("Target.createTarget", { url: "about:blank" });
  await tick(20);
  assert.equal(a.state.closed, true, "dropped");
  assert.equal(inner.closed, true);
});
