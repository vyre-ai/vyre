#!/usr/bin/env node
// A stand-in for wink/forwarder, speaking its command line and its two sockets, for host.test.js.
// It joins nothing. Env: FAKE_NODEKEY (this node's key), FAKE_ROUTES (JSON {"100.64.0.1:8443": "<home peer socket>"}),
// FAKE_BLACKHOLE=1 (accept a dial and never answer: the 25 s tsnet case), FAKE_FAIL_START=1.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { encodeHeader } from "../peer-channel.js";

const a = process.argv.slice(2);
const arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : ""; };
if (process.env.FAKE_FAIL_START) { console.log(JSON.stringify({ event: "error", what: "up", error: "no control" })); process.exit(1); }
const nodeKey = process.env.FAKE_NODEKEY;
const routes = JSON.parse(process.env.FAKE_ROUTES || "{}");
const dialSock = arg("-dial-sock");
fs.mkdirSync(path.dirname(dialSock), { recursive: true, mode: 0o700 });
try { fs.unlinkSync(dialSock); } catch {}
net.createServer(c => {
  let buf = Buffer.alloc(0);
  const onData = d => {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf(10);
    if (i < 0) return;
    c.off("data", onData);
    const req = JSON.parse(buf.subarray(0, i).toString());
    const rest = buf.subarray(i + 1);
    if (process.env.FAKE_BLACKHOLE) return; // never answers; the client closes when it gives up
    const target = routes[req.addr];
    if (!target) { c.end(JSON.stringify({ ok: false, error: "context deadline exceeded" }) + "\n"); return; }
    const u = net.connect(target, () => {
      u.write(encodeHeader({ nodeKey, stableId: "9", tags: [], remoteAddr: "100.64.0.2:40000" }));
      c.write(JSON.stringify({ ok: true }) + "\n");
      if (rest.length) u.write(rest);
      c.pipe(u); u.pipe(c);
    });
    u.on("error", () => c.destroy()); c.on("error", () => u.destroy());
  };
  c.on("data", onData);
}).listen(dialSock, () => {
  fs.chmodSync(dialSock, 0o600);
  console.log(JSON.stringify({ event: "ready", nodeKey, stableId: "9", ips: ["100.64.0.2"] }));
});
process.on("SIGTERM", () => process.exit(0));
