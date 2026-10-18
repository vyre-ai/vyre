// DIAG (temporary): which handle survives daemon stop()
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import fs from "node:fs";
import net from "node:net";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";

const stacks = [];
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) { stacks.push(String(a[0]) + " " + String(a[1]) + "\n" + new Error().stack.split("\n").slice(2, 9).join("\n")); return origListen.apply(this, a); };

test("diag: what is open after stop", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(`${root}/config.json`, JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {}, presence: present, kernel: true });
  asOwner(d, root);
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
  console.log("DIAG-LISTEN\n" + stacks.filter(x => /127\.0\.0\.1|^0 /.test(x)).join("\n--\n") + "\nDIAG-LISTEN-END");
  console.log("DIAG-HANDLES\n" + lines.join("\n") + "\nDIAG-END");
});
