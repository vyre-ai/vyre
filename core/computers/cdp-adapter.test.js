// @ts-check
// An agent's Chrome as the hands and the fill see it: a token opens one agent's Chrome only, clients of one agent share its pipe without mixing their answers, and nothing meant for
// one agent's Chrome ever crosses another agent's relay. The real Cdp client drives it; the relay and Chrome are fakes that speak the relay's hello and NUL-framed CDP.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createCdpAdapter, RETAIN_MS } from "./cdp-adapter.js";
import { Cdp } from "../../lib/cdp.js";

/** A fake relay + Chrome for one agent: wants a hello line, then answers each NUL-framed message with its own name in the result. */
async function fakeChrome(name, hook = null) {
  /** @type {string[]} */ const hellos = [], seen = [];
  /** @type {net.Socket[]} */ const socks = [];
  const server = net.createServer(s => {
    socks.push(s);
    let buf = Buffer.alloc(0), greeted = false;
    s.on("data", d => {
      buf = Buffer.concat([buf, d]);
      if (!greeted) { const i = buf.indexOf(10); if (i < 0) return; hellos.push(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1); greeted = true; }
      for (let i; (i = buf.indexOf(0)) >= 0;) {
        const m = JSON.parse(buf.subarray(0, i).toString()); buf = buf.subarray(i + 1); seen.push(m.method);
        const custom = hook ? hook(m) : undefined;
        s.write(JSON.stringify({ id: m.id, result: custom !== undefined ? custom : { who: name, method: m.method, echo: m.params && m.params.v } }) + "\0");
        if (m.method === "Test.event") s.write(JSON.stringify({ method: "Test.happened", params: { who: name } }) + "\0");
      }
    });
    s.on("error", () => {});
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const emit = (/** @type {any} */ o) => { for (const k of socks) k.write(JSON.stringify(o) + "\0"); };
  return { port: /** @type {any} */ (server.address()).port, hellos, seen, server, socks, emit };
}

async function world(t, hookA = null, now = undefined) {
  const chromes = { a: await fakeChrome("A", hookA), b: await fakeChrome("B") };
  /** @type {string[]} */ const opened = [], released = [];
  const adapter = createCdpAdapter({ ...(now ? { now } : {}), open: async agent => { opened.push(agent); const c = /** @type {any} */ (chromes)[agent]; return { host: "127.0.0.1", port: c.port, hello: `hello-${agent}\n`, release: () => released.push(agent) }; } });
  t.after(async () => { await adapter.close(); for (const c of Object.values(chromes)) { c.socks.forEach(s => s.destroy()); c.server.close(); } });
  const open = async agent => { const ep = await adapter.endpoint(agent); const cdp = new Cdp({ cdpUrl: `${ep.url}/cdp`, token: ep.token }); t.after(() => cdp.close()); return { cdp, ep }; };
  return { chromes, adapter, opened, released, open };
}
// the real client sets auto-attach when it connects: the fakes answer anything, so connect() works unchanged

test("the real Cdp client reaches an agent's Chrome through its endpoint, after the relay's hello", async t => {
  const w = await world(t);
  const { cdp } = await w.open("a");
  assert.equal((await cdp.send("Browser.getVersion", { v: 7 })).who, "A");
  assert.deepEqual(w.chromes.a.hellos, ["hello-a"]);
  assert.deepEqual(w.opened, ["a"]);
});

test("a token opens its own agent's Chrome and no other: B's Chrome sees nothing of what is sent with A's token, and the other way", async t => {
  const w = await world(t);
  const a = await w.open("a"), b = await w.open("b");
  assert.notEqual(a.ep.token, b.ep.token);
  assert.equal((await a.cdp.send("Fill.type", { v: "secret-for-a" })).who, "A");
  assert.equal((await b.cdp.send("Fill.type", { v: "secret-for-b" })).who, "B");
  const seenA = w.chromes.a.seen.join(","), seenB = w.chromes.b.seen.join(",");
  assert.ok(seenA.includes("Fill.type") && seenB.includes("Fill.type"));
  assert.equal(w.chromes.a.seen.filter(m => m === "Fill.type").length, 1);
  assert.equal(w.chromes.b.seen.filter(m => m === "Fill.type").length, 1);
  assert.deepEqual(w.chromes.a.hellos, ["hello-a"]);
  assert.deepEqual(w.chromes.b.hellos, ["hello-b"]);
  // a made-up token, none, and the other agent's endpoint address with a wrong token get nothing
  for (const token of ["", "x".repeat(43)]) assert.equal((await fetch(`${a.ep.url}/cdp/json/version`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status, 401);
  const refused = await new Promise(resolve => { const ws = new WebSocket(`ws://${a.ep.url.slice(7)}/cdp/devtools/browser?token=${"y".repeat(43)}`); ws.onerror = () => resolve("refused"); ws.onopen = () => resolve("open"); });
  assert.equal(refused, "refused");
});

test("two clients of one agent (hands and fill) share its pipe: each gets its own answers, and events reach both", async t => {
  const w = await world(t);
  const one = await w.open("a"), two = await w.open("a");
  /** @type {any[]} */ const heard1 = [], heard2 = [];
  one.cdp.on(m => heard1.push(m)); two.cdp.on(m => heard2.push(m));
  const [r1, r2] = await Promise.all([one.cdp.send("Test.one", { v: 1 }), two.cdp.send("Test.two", { v: 2 })]);
  assert.deepEqual([r1.method, r1.echo, r2.method, r2.echo], ["Test.one", 1, "Test.two", 2]);
  await one.cdp.send("Test.event", {});
  await new Promise(r => setTimeout(r, 50));
  assert.ok(heard1.some(m => m.method === "Test.happened") && heard2.some(m => m.method === "Test.happened"));
  assert.deepEqual(w.opened, ["a"], "one relay connection for the agent, not one per client");
});

test("dropping an agent closes its clients and releases the hold; the next endpoint use opens a fresh relay", async t => {
  const w = await world(t);
  const { cdp } = await w.open("a");
  await cdp.send("Browser.getVersion");
  w.adapter.drop("a");
  assert.deepEqual(w.released, ["a"]);
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await cdp.send("Browser.getVersion")).who, "A", "the client reconnects through the same endpoint");
  assert.deepEqual(w.opened, ["a", "a"]);
});


// ---- full DevTools for the agent, and the fill's window -------------------------------------------------------------------------------

const PASS = "Hunter2-Pa$$word!", USERNAME = "alice@example.com";
const forms = v => [v, encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, "+"), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")];

test("the agent has every DevTools capability in its own Chrome: network, elements, eval, cookies, storage, downloads and the rest all go through untouched", async t => {
  const w = await world(t);
  const { cdp } = await w.open("a");
  const methods = ["Network.enable", "Network.getAllCookies", "Network.getCookies", "Network.setCookie", "Network.getResponseBody", "Network.getRequestPostData", "Runtime.evaluate", "Runtime.callFunctionOn", "DOM.getDocument", "DOM.getOuterHTML",
    "DOMSnapshot.captureSnapshot", "Storage.getCookies", "Storage.clearDataForOrigin", "DOMStorage.getDOMStorageItems", "IndexedDB.requestDatabaseNames", "Page.getResourceContent", "Page.captureScreenshot", "Page.navigate", "Fetch.enable", "Debugger.enable",
    "Browser.setDownloadBehavior", "Browser.getVersion", "Emulation.setUserAgentOverride", "Input.dispatchKeyEvent", "Target.createTarget", "Log.enable", "Security.disable", "Page.addScriptToEvaluateOnNewDocument", "Page.setDownloadBehavior"];
  for (const m of methods) assert.equal((await cdp.send(m, { v: m })).echo, m, m);
  assert.deepEqual(methods.filter(m => !w.chromes.a.seen.includes(m)), [], "every one of them reached Chrome");
});

test("a fill's window: the agent's clients are cut and shut out, only the fill's token is let in, and the agent is let back in when it ends", async t => {
  const w = await world(t);
  const agent = await w.open("a");
  await agent.cdp.send("Browser.getVersion");
  const FILL = "f".repeat(43);
  await w.adapter.shield("a", true, { fill_token: FILL });
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await fetch(`${agent.ep.url}/cdp/json/version`, { headers: { authorization: `Bearer ${agent.ep.token}` } })).status, 423, "the agent's own token is refused during the window");
  const refused = await new Promise(resolve => { const ws = new WebSocket(`ws://${agent.ep.url.slice(7)}/cdp/devtools/browser?token=${agent.ep.token}`); ws.onerror = () => resolve("refused"); ws.onopen = () => resolve("open"); });
  assert.equal(refused, "refused");
  const fill = new Cdp({ cdpUrl: `${agent.ep.url}/cdp`, token: FILL });
  t.after(() => fill.close());
  assert.equal((await fill.send("Browser.getVersion")).who, "A", "the fill's token works");
  await assert.rejects(() => agent.cdp.send("Browser.getVersion"), /closed|timed out|refused|could not|HTTP 423/, "the agent's old connection is gone");
  await w.adapter.shield("a", false);
  assert.equal((await fetch(`${agent.ep.url}/cdp/json/version`, { headers: { authorization: `Bearer ${FILL}` } })).status, 401, "the fill's token is dead after the window");
  const again = new Cdp({ cdpUrl: `${agent.ep.url}/cdp`, token: agent.ep.token });
  t.after(() => again.close());
  assert.equal((await again.send("Browser.getVersion")).who, "A", "the agent is back");
});

test("the fill's values are in no DevTools result: eval, DOM, network bodies (also base64), events and post data, in every form; the fill's own client sees them as they are", async t => {
  /** @type {Record<string, any>} */
  const leaks = {
    "Runtime.evaluate": { result: { type: "string", value: `typed ${PASS} for ${USERNAME}` } },
    "DOM.getOuterHTML": { outerHTML: `<input value="${PASS}"><a href="/x?p=${encodeURIComponent(PASS)}">${JSON.stringify(PASS).slice(1, -1)}</a>` },
    "Network.getAllCookies": { cookies: [{ name: "session", value: "tok-not-a-secret" }] },
    "Network.getResponseBody": { body: Buffer.from(`{"echo":"${PASS}","ok":true}`).toString("base64"), base64Encoded: true },
    "Network.getRequestPostData": { postData: `user=${USERNAME}&pw=${encodeURIComponent(PASS)}` },
  };
  const w = await world(t, m => leaks[m.method]);
  const FILL = "f".repeat(43);
  const agent = await w.open("a");
  await w.adapter.shield("a", true, { fill_token: FILL });
  w.adapter.register("a", [PASS, USERNAME, "123456"]);
  const fill = new Cdp({ cdpUrl: `${agent.ep.url}/cdp`, token: FILL });
  t.after(() => fill.close());
  assert.ok(JSON.stringify(await fill.send("Runtime.evaluate", {})).includes(PASS), "the fill's own client is given what Chrome said, unchanged");
  // a sign-in request goes out while the window is open, with its body
  w.chromes.a.emit({ method: "Network.requestWillBeSent", params: { requestId: "r1", request: { url: "https://x.test/login", method: "POST", postData: `pw=${PASS}`, hasPostData: true } } });
  await new Promise(r => setTimeout(r, 50));
  await w.adapter.shield("a", false);
  const after = new Cdp({ cdpUrl: `${agent.ep.url}/cdp`, token: agent.ep.token });
  t.after(() => after.close());
  /** @type {any[]} */ const heard = [];
  after.on(m => heard.push(m));
  const results = [];
  for (const method of ["Runtime.evaluate", "DOM.getOuterHTML", "Network.getAllCookies", "Network.getResponseBody"]) results.push(await after.send(method, { requestId: "r0" }));
  const blob = JSON.stringify(results);
  for (const v of [PASS, USERNAME]) for (const f of forms(v)) assert.ok(!blob.includes(f), `a result still holds ${f.slice(0, 12)}...`);
  assert.ok(blob.includes("[value]"), "replaced by a marker, not dropped");
  assert.ok(blob.includes("tok-not-a-secret"), "cookies and tokens are the agent's to see");
  assert.deepEqual(Buffer.from(results[3].body, "base64").toString(), '{"echo":"[value]","ok":true}', "inside a base64 body too");
  await assert.rejects(() => after.send("Network.getRequestPostData", { requestId: "r1" }), /not kept/, "the sign-in request's body is never given out");
  assert.equal((await after.send("Network.getRequestPostData", { requestId: "r-other" })).postData !== undefined, true, "other requests' bodies are given, scrubbed of the values only");
  w.chromes.a.emit({ method: "Network.requestWillBeSent", params: { requestId: "r1", request: { url: "https://x.test/login", method: "POST", postData: `pw=${PASS}`, hasPostData: true } } });
  w.chromes.a.emit({ method: "Runtime.consoleAPICalled", params: { args: [{ type: "string", value: `debug ${PASS}` }] } });
  await new Promise(r => setTimeout(r, 80));
  assert.ok(heard.length >= 2);
  assert.ok(!JSON.stringify(heard).includes(PASS) && !JSON.stringify(heard).includes("postData\":\"pw"), "events: the console and the sign-in request carry neither the password nor the body");
});

test("the values stay scrubbed for ten minutes after the window and not for ever; the clock decides", async t => {
  const clock = { t: 1_000_000 };
  const w = await world(t, m => m.method === "Runtime.evaluate" ? { result: { value: `p=${PASS}` } } : undefined, () => clock.t);
  const agent = await w.open("a");
  await w.adapter.shield("a", true, { fill_token: "f".repeat(43) });
  w.adapter.register("a", [PASS]);
  await w.adapter.shield("a", false);
  const c = new Cdp({ cdpUrl: `${agent.ep.url}/cdp`, token: agent.ep.token });
  t.after(() => c.close());
  assert.ok(!JSON.stringify(await c.send("Runtime.evaluate", {})).includes(PASS));
  clock.t += RETAIN_MS + 1;
  assert.ok(JSON.stringify(await c.send("Runtime.evaluate", {})).includes(PASS), "outside the window and its retention nothing is redacted");
});
