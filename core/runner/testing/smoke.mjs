// A manual smoke run of the whole runner on this computer, with timings: node testing/smoke.mjs <base dir>
// Used on the Windows 11 VM, where the integration tests are slow (BitLocker). Prints each step and each runner event.
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import os from "node:os";
import { createRunner } from "../runner.js";
import { fakeSpace } from "./fake-space.js";
const t0 = Date.now(), log = (...a) => console.log(String(Math.round((Date.now() - t0) / 1000)).padStart(4) + "s", ...a);
const base = process.argv[2];
const agentDir = path.join(base, "agent"); fs.mkdirSync(agentDir, { recursive: true });
fs.copyFileSync(new URL("./fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
const up = http.createServer((req, res) => { res.end("ok"); }); await new Promise(r => up.listen(0, "127.0.0.1", r));
const sp = fakeSpace();
const r = createRunner({ base: path.join(base, "rn"), space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), watchdog: false, onEvent: e => log("event", JSON.stringify(e).slice(0, 700)) });
log("decide", JSON.stringify(r.decide()));
const routes = [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.address().port}`, credential: { ref: "vault://provider", header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }] }];
try {
  const h = await r.start({ session: "s1", command: process.execPath, args: [path.join(agentDir, "agent.js")], readOnly: [agentDir, path.dirname(process.execPath)], routes,
    env: { VYRE_PROBE_FILE: path.join(base, "secret.txt"), VYRE_PROBE_HOME: os.homedir(), VYRE_PROBE_PORT: String(up.address().port) } });
  log("started pid", h.pid);
  fs.writeFileSync(path.join(base, "secret.txt"), "OUTSIDE");
  h.child.stdout.on("data", d => log("agent>", String(d).trim().slice(0, 300)));
  h.send("turn write the memo"); 
  for (let i = 0; i < 60 && sp.state.checkpoints.get("s1")?.turn !== 1; i++) await new Promise(r => setTimeout(r, 1000));
  log("checkpoint turn", sp.state.checkpoints.get("s1")?.turn, "files", [...sp.state.files.keys()].join(","));
  h.send("probe");
  await new Promise(r => setTimeout(r, 15000));
  await h.stop(); log("stopped");
} catch (e) { log("ERROR", e.stack || e.message); }
await r.lock(); log("locked", JSON.stringify(r.status()));
process.exit(0);
