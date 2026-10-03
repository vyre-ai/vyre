#!/usr/bin/env node
// @ts-check
// gate-main: the gate as its own process (SPEC-wink-network 4.3 item 2). Usage: node gate-main.js CONFIG.json
//
// CONFIG.json (mode 0600, written by the supervisor): { listen:{host,port}, tlsCertFile, tlsKeyFile, upstream:{port,...},
// derp, forwarder, limits, uid, gid, logFile }. It binds first, THEN drops to uid/gid (so 443 needs root only for
// the bind), then reads the certificate from memory it already holds. Headscale's log reaches it as IPC messages
// ({type:"log", line}) when forked, and from `logFile` when named (read by offset, event-driven). It prints one
// JSON line when ready ({ready, host, port, pin}) and one per event, with addresses and never headers, bodies or keys.

import fs from "node:fs";
import { createGate } from "./gate.js";

const file = process.argv[2];
if (!file) { process.stderr.write("usage: gate-main.js CONFIG.json\n"); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const cert = cfg.tlsCertFile ? fs.readFileSync(cfg.tlsCertFile, "utf8") : null;
const key = cfg.tlsKeyFile ? fs.readFileSync(cfg.tlsKeyFile, "utf8") : null;
const say = (/** @type {any} */ o) => process.stdout.write(JSON.stringify(o) + "\n");

const gate = createGate({
  listen: cfg.listen, tls: cert && key ? { cert, key } : null, upstream: cfg.upstream, derp: !!cfg.derp,
  forwarder: cfg.forwarder, limits: cfg.limits, onEvent: e => say({ event: e }),
});
const at = await gate.listen();
if (typeof process.getuid === "function" && process.getuid() === 0 && cfg.uid != null) {
  process.setgroups?.([]);
  process.setgid?.(cfg.gid ?? cfg.uid);
  process.setuid?.(cfg.uid);
}
say({ ready: true, ...at, pin: gate.pin });

process.on("message", (/** @type {any} */ m) => { if (m && m.type === "log" && typeof m.line === "string") gate.reportLog(m.line); });
if (cfg.logFile) {
  let off = 0, buf = "";
  const pump = () => {
    try {
      const st = fs.statSync(cfg.logFile);
      if (st.size < off) off = 0;
      const fd = fs.openSync(cfg.logFile, "r");
      const b = Buffer.alloc(Math.min(st.size - off, 1 << 20));
      fs.readSync(fd, b, 0, b.length, off); fs.closeSync(fd);
      off += b.length; buf += b.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { gate.reportLog(buf.slice(0, i)); buf = buf.slice(i + 1); }
    } catch { /* not there yet */ }
  };
  try { off = fs.statSync(cfg.logFile).size; } catch { /* new file */ }
  try { fs.watch(cfg.logFile, pump); } catch { /* the supervisor will use IPC */ }
}
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { gate.close().then(() => process.exit(0)); });
