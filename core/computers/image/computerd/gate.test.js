// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createGate, plainAddr } from "./gate.js";

test("gate: the screen's gate is strict, with no opening before a pin", () => {
  const g = createGate();
  assert.equal(g.allowedScreen("172.18.0.9"), false, "before any pin: another computer cannot try the screen's password");
  assert.equal(g.allowedScreen("127.0.0.1"), true, "this computer's own processes");
  g.pin("::ffff:172.18.0.2");
  assert.equal(g.pinned, "172.18.0.2");
  assert.equal(g.allowedScreen("172.18.0.2"), true);
  assert.equal(g.allowedScreen("::ffff:172.18.0.2"), true);
  assert.equal(g.allowedScreen("172.18.0.9"), false);
  g.pin("172.18.0.7"); // vyred came back at another address and showed the token
  assert.equal(g.allowedScreen("172.18.0.7"), true);
  assert.equal(g.allowedScreen("172.18.0.2"), false);
  g.pin("127.0.0.1"); // loopback never pins
  assert.equal(g.pinned, "172.18.0.7");
  assert.equal(plainAddr(undefined), "");
});

test("gate: an address that keeps failing is closed on at the connection, and a known address never is", () => {
  let t = 1000;
  const g = createGate({ now: () => t });
  for (let i = 0; i < 19; i++) g.failed("172.18.0.9");
  assert.equal(g.blocked("172.18.0.9"), false);
  g.failed("172.18.0.9");
  assert.equal(g.blocked("172.18.0.9"), true);
  t += 61_000;
  assert.equal(g.blocked("172.18.0.9"), false, "a minute later it may try again");
  for (let i = 0; i < 30; i++) g.failed("172.18.0.2");
  g.pin("172.18.0.2");
  assert.equal(g.blocked("172.18.0.2"), false, "vyred's own address is never blocked");
});

/** A server wired the way computerd wires it: any address connects, a valid token proves vyred and pins, anyone else unknown is closed on. */
async function serve(t, gate) {
  const server = http.createServer((req, res) => {
    const owner = req.headers.authorization === "Bearer token", cdp = req.headers.authorization === "Bearer cdp-token";
    if (owner) gate.pin(req.socket.remoteAddress);
    else if (!gate.known(req.socket.remoteAddress)) { gate.failed(req.socket.remoteAddress); req.socket.destroy(); return; }
    res.writeHead(owner || cdp ? 200 : 401).end();
  });
  server.on("connection", s => { if (gate.blocked(s.remoteAddress)) s.destroy(); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return /** @type {import("node:net").AddressInfo} */ (server.address()).port;
}

/** What a client at this source address gets back for a request with this bearer: the status line, or nothing. */
function ask(port, from, bearer) {
  return new Promise(resolve => {
    const s = net.connect({ host: "127.0.0.1", port, localAddress: from });
    let got = "";
    s.on("connect", () => s.write(`GET /ping HTTP/1.0\r\n${bearer ? `Authorization: Bearer ${bearer}\r\n` : ""}\r\n`));
    s.on("data", d => { got += d; });
    s.on("close", () => resolve(got.split("\r\n")[0].replace("HTTP/1.1", "HTTP/1.0")));
    s.on("error", e => resolve(/** @type {any} */ (e).code === "EADDRNOTAVAIL" ? "unavailable" : "error"));
    setTimeout(() => { s.destroy(); }, 2000).unref();
  });
}

test("gate: computerd answers nobody it does not know, except a valid token, which pins; vyred at a new address is let in without a restart", async t => {
  const gate = createGate();
  const port = await serve(t, gate);
  const other = await ask(port, "127.0.0.2", "");
  if (other === "unavailable") return t.skip("this machine has no 127.0.0.2 to connect from");
  assert.equal(other, "", "an address that shows no token gets no bytes, not even a 401");
  assert.equal(await ask(port, "127.0.0.2", "wrong"), "", "a wrong token neither pins nor opens anything");
  assert.equal(gate.pinned, null);
  assert.equal(await ask(port, "127.0.0.3", "token"), "HTTP/1.0 200 OK", "the token proves vyred: served, and pinned");
  assert.equal(gate.pinned, "127.0.0.3");
  assert.equal(await ask(port, "127.0.0.2", "token-guess"), "", "after the pin another computer still gets nothing");
  assert.equal(await ask(port, "127.0.0.3", ""), "HTTP/1.0 401 Unauthorized", "vyred's address meets the token check, the second wall");
  assert.equal(await ask(port, "127.0.0.4", "token"), "HTTP/1.0 200 OK", "vyred came back at another address: the token re-pins it, no restart");
  assert.equal(gate.pinned, "127.0.0.4");
  assert.equal(await ask(port, "127.0.0.3", ""), "", "and the old address is now just another peer");
});

test("gate: a CDP client's token never moves the pin; from another address it gets nothing", async t => {
  const gate = createGate();
  const port = await serve(t, gate);
  if ((await ask(port, "127.0.0.2", "")) === "unavailable") return t.skip("this machine has no 127.0.0.2 to connect from");
  assert.equal(await ask(port, "127.0.0.3", "token"), "HTTP/1.0 200 OK");
  assert.equal(gate.pinned, "127.0.0.3");
  assert.equal(await ask(port, "127.0.0.2", "cdp-token"), "", "a shared-mode agent token from another place gets nothing");
  assert.equal(gate.pinned, "127.0.0.3", "and the pin did not move");
  assert.equal(await ask(port, "127.0.0.3", "cdp-token"), "HTTP/1.0 200 OK", "from vyred's address it is served");
  assert.equal(gate.pinned, "127.0.0.3");
});

test("gate: the failure map forgets addresses once their failures have aged out", () => {
  let t = 0;
  const g = createGate({ now: () => t });
  for (let i = 0; i < 50; i++) g.failed(`172.18.0.${i}`);
  assert.equal(g.remembered, 50);
  t += 61_000;
  g.prune();
  assert.equal(g.remembered, 0);
});
