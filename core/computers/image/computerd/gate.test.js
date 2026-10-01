// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createGate, plainAddr } from "./gate.js";

test("gate: before the first token anyone may connect; after, only the pinned address and loopback", () => {
  const g = createGate();
  assert.equal(g.allowed("172.18.0.9"), true, "before the pin: anything may connect (and only gets a 401)");
  g.pin("::ffff:172.18.0.2");
  assert.equal(g.pinned, "172.18.0.2");
  assert.equal(g.allowed("172.18.0.2"), true);
  assert.equal(g.allowed("::ffff:172.18.0.2"), true);
  assert.equal(g.allowed("172.18.0.9"), false, "another computer is refused");
  assert.equal(g.allowed("127.0.0.1"), true, "the computer's own processes");
  assert.equal(g.allowed("::1"), true);
  // vyred comes back at another address and shows the token: it is let in again, and the old one is not.
  g.pin("172.18.0.7");
  assert.equal(g.allowed("172.18.0.7"), true);
  assert.equal(g.allowed("172.18.0.2"), false);
  // Loopback never pins; a pin needs an address that is not this computer's own.
  g.pin("127.0.0.1");
  assert.equal(g.pinned, "172.18.0.7");
  assert.equal(plainAddr(undefined), "");
});

/** A server wired the way computerd wires it: the gate at the connection, then a bearer check that answers 401. */
async function serve(t, gate) {
  const server = http.createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer token";
    if (ok) gate.pin(req.socket.remoteAddress);
    res.writeHead(ok ? 200 : 401).end();
  });
  server.on("connection", s => { if (!gate.allowed(s.remoteAddress)) s.destroy(); });
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
    s.on("close", () => resolve(got.split("\r\n")[0]));
    s.on("error", e => resolve(/** @type {any} */ (e).code === "EADDRNOTAVAIL" ? "unavailable" : "error"));
    setTimeout(() => { s.destroy(); }, 2000).unref();
  });
}

test("gate: a connection from another computer gets nothing beyond a 401 before the pin, and nothing at all after it", async t => {
  const gate = createGate();
  const port = await serve(t, gate);
  const other = await ask(port, "127.0.0.2", "");
  if (other === "unavailable") return t.skip("this machine has no 127.0.0.2 to connect from");
  assert.equal(other, "HTTP/1.0 401 Unauthorized", "before the pin: a 401 and nothing else");
  assert.equal(await ask(port, "127.0.0.2", "wrong"), "HTTP/1.0 401 Unauthorized", "a wrong token neither pins nor opens anything");
  assert.equal(gate.pinned, null);
  // vyred (here 127.0.0.3 stands for its address) shows the token: pinned.
  assert.equal(await ask(port, "127.0.0.3", "token"), "HTTP/1.0 200 OK");
  assert.equal(gate.pinned, "127.0.0.3");
  assert.equal(await ask(port, "127.0.0.2", ""), "", "after the pin: the other computer is closed on, no bytes");
  assert.equal(await ask(port, "127.0.0.2", "token-guess"), "");
  assert.equal(await ask(port, "127.0.0.3", ""), "HTTP/1.0 401 Unauthorized", "vyred's address is still met by the token check, the second wall");
});
