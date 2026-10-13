#!/usr/bin/env node
// records-box: a throwaway Vyre home with the Records stack (Twenty, docker) for a live check over the daemon's socket. TEST ONLY, never on the Mac.
//   node scripts/records-box.mjs [--dir /tmp/rbox]   prints SOCKET <path> and READY once the home Space's record store answers; Ctrl-C (or stopping the unit) tears the stack down.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStandins } from "./lib/proof/standins.mjs";
import { startDaemonServer } from "./lib/proof/server-daemon.mjs";

const i = process.argv.indexOf("--dir");
const dir = i > 0 ? process.argv[i + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "rbox-"));
fs.mkdirSync(dir, { recursive: true });
const ins = await startStandins({ out: dir });
const srv = await startDaemonServer({ dir: path.join(dir, "server"), name: "rbox", code: "", relay: ins.relayForServer, directory: ins.namesForServer, store: "records" });
console.log(`SOCKET ${path.join(dir, "server", ".vyre", "vyred.sock")}`);
const t0 = Date.now();
for (;;) {
  const r = await srv.registry.call("records.types", {}, "cli").catch((/** @type {any} */ e) => ({ error: { message: String(e.message) } }));
  if (r && !r.error) { console.log(`READY records.types answered after ${Math.round((Date.now() - t0) / 1000)} s`); break; }
  if (Date.now() - t0 > 600_000) { console.log(`NOT READY after 10 min: ${JSON.stringify(r).slice(0, 200)}`); break; }
  await new Promise((res) => setTimeout(res, 5000));
}
const stop = async () => { try { await srv.stop(); } catch { /* stopped */ } await ins.stop(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
