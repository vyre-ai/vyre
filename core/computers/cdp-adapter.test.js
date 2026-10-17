// @ts-check
// An agent's Chrome as the hands and the fill see it: a token opens one agent's Chrome only, clients of one agent share its pipe without mixing their answers, and nothing meant for
// one agent's Chrome ever crosses another agent's relay. The real Cdp client drives it; the relay and Chrome are fakes that speak the relay's hello and NUL-framed CDP.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createCdpAdapter } from "./cdp-adapter.js";
import { Cdp } from "../../lib/cdp.js";

/** A fake relay + Chrome for one agent: wants a hello line, then answers each NUL-framed message with its own name in the result. */
async function fakeChrome(name) {
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
        s.write(JSON.stringify({ id: m.id, result: { who: name, method: m.method, echo: m.params && m.params.v } }) + "\0");
        if (m.method === "Test.event") s.write(JSON.stringify({ method: "Test.happened", params: { who: name } }) + "\0");
      }
    });
    s.on("error", () => {});
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { port: /** @type {any} */ (server.address()).port, hellos, seen, server, socks };
}

async function world(t) {
  const chromes = { a: await fakeChrome("A"), b: await fakeChrome("B") };
  /** @type {string[]} */ const opened = [], released = [];
  const adapter = createCdpAdapter({ open: async agent => { opened.push(agent); const c = /** @type {any} */ (chromes)[agent]; return { host: "127.0.0.1", port: c.port, hello: `hello-${agent}\n`, release: () => released.push(agent) }; } });
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
