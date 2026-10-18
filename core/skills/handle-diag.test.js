// DIAG (temporary): which handle survives daemon stop()
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import fs from "node:fs";
import net from "node:net";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";

const stacks = []; const servers = [];
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) { servers.push([this, new Error().stack.split("\n").slice(2, 6).join(" | ")]); stacks.push(String(a[0]) + " " + String(a[1]) + "\n" + new Error().stack.split("\n").slice(2, 9).join("\n")); return origListen.apply(this, a); };

test("diag: what is open after stop", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(`${root}/config.json`, JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: (m) => { if (/appmods|failed|waiting|did not stop|warn/i.test(String(m))) console.log("DIAG-LOG " + String(m).slice(0, 300)); }, presence: present, kernel: true });
  asOwner(d, root);
  console.log("DIAG-STATES " + JSON.stringify([...d.registry.modules].filter(([n, r]) => r.state !== "running").map(([n, r]) => [n, r.state, String(r.error || "").slice(0, 160)])));
  await d.stop();
  await new Promise(r => setTimeout(r, 1500));
  const lines = [];
  for (const h of /** @type {any} */ (process)._getActiveHandles()) {
    const n = h && h.constructor && h.constructor.name;
    if (h === process.stdout || h === process.stderr || h === process.stdin) continue;
    let extra = "";
    try {
      if (h instanceof net.Server) extra = JSON.stringify(h.address());
      else if (n === "Socket") extra = `local ${h.localAddress}:${h.localPort} remote ${h.remoteAddress}:${h.remotePort} pending=${h.pending} connecting=${h.connecting} path=${h._pipeName || ""}`;
      else if (n === "ChildProcess") extra = `pid ${h.pid} args ${(h.spawnargs || []).join(" ").slice(0, 160)}`;
      else if (n === "Timeout") extra = `idle ${h._idleTimeout} ms; ${(h._onTimeout && h._onTimeout.toString().slice(0, 220)) || ""}`;
    } catch (e) { extra = String(e); }
    lines.push(`${n} ${extra}`);
  }
  console.log("DIAG-SERVERS\n" + servers.map(([sv, st]) => `listening=${sv.listening} ${st}`).join("\n") + "\nDIAG-SERVERS-END");
  console.log("DIAG-LISTEN\n" + stacks.filter(x => /127\.0\.0\.1|^0 /.test(x)).join("\n--\n") + "\nDIAG-LISTEN-END");
  console.log("DIAG-HANDLES\n" + lines.join("\n") + "\nDIAG-END");
});
