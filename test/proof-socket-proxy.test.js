// @ts-check
// The two proxies the first-run proof puts in front of a vyred socket: the browser's front adds the named caller and notes method and path (never a body), and the Mac app's front passes every byte through
// untouched while noting the request lines the app's window sent.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { tcpFront, unixFront } from "../scripts/lib/proof/socket-proxy.mjs";

/** An upstream on a unix socket that echoes the caller header it was given. */
async function upstream(/** @type {import("node:test").TestContext} */ t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psp-"));
  const sock = path.join(dir, "u.sock");
  const seen = /** @type {string[]} */ ([]);
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url} caller=${req.headers["x-vyre-caller"]} host=${req.headers.host}`); res.writeHead(200, { "content-type": "text/plain" }); res.end(`ok ${req.url}`); });
  await new Promise((r) => server.listen(sock, () => r(null)));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { sock, dir, seen };
}

test("the browser's front names the caller, keeps the path without its query, and answers what the daemon answered", async (t) => {
  const up = await upstream(t);
  const front = await tcpFront({ socket: up.sock, caller: "cli" });
  t.after(() => front.close());
  const r = await fetch(`${front.url}/app/onboard?secret=1`, { headers: { "x-vyre-caller": "mcp" } });
  assert.equal(await r.text(), "ok /app/onboard?secret=1");
  assert.deepEqual(up.seen, ["GET /app/onboard?secret=1 caller=cli host=localhost"], "the caller is the front's, never the page's");
  assert.deepEqual(front.calls, ["GET /app/onboard"], "the note has no query");
  const p = await fetch(`${front.url}/v1/tools/identity.status`, { method: "POST", body: "{}" });
  assert.equal(p.status, 200);
  assert.deepEqual(front.calls, ["GET /app/onboard", "POST /v1/tools/identity.status"]);
});

test("the Mac app's front passes the bytes through and notes the request lines", async (t) => {
  const up = await upstream(t);
  const listen = path.join(up.dir, "app.sock");
  const front = await unixFront({ listen, upstream: up.sock });
  t.after(() => front.close());
  const answer = await new Promise((res, rej) => {
    const c = net.connect(listen, () => c.write("GET /app/ HTTP/1.1\r\nhost: localhost\r\nx-vyre-caller: capsule\r\nconnection: close\r\n\r\n"));
    let all = "";
    c.on("data", (d) => { all += d; });
    c.on("close", () => res(all));
    c.on("error", rej);
  });
  assert.match(String(answer), /^HTTP\/1\.1 200/);
  assert.match(String(answer), /ok \/app\/$/);
  assert.deepEqual(up.seen, ["GET /app/ caller=capsule host=localhost"], "the header the app sent arrives as it was");
  assert.deepEqual(front.calls, ["GET /app/"]);
});
