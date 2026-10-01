// AR-S2 in the iOS simulator's Safari (the phone app is the Deck in iOS Safari): boot a simulator,
// open the Deck stand-in in Mobile Safari with simctl, and read the report the page posts back to
// the server. The simulator shares the host's network, so 127.0.0.1 is this runner. The top-level run
// has the page navigate itself to the collector with its results.

import { execFileSync, spawnSync } from "node:child_process";
import { startServer } from "./sandbox-server.mjs";
import { verify } from "./sandbox-verify.mjs";

const sh = (...a) => execFileSync(a[0], a.slice(1), { encoding: "utf8" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const devices = JSON.parse(sh("xcrun", "simctl", "list", "devices", "available", "--json")).devices;
const pick = Object.entries(devices).filter(([rt]) => /iOS/.test(rt)).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).reverse()
  .flatMap(([, ds]) => ds).find(d => /iPhone/.test(d.name));
if (!pick) { console.error("no iPhone simulator on this runner"); process.exit(3); }
console.log("simulator:", pick.name, pick.udid);
spawnSync("xcrun", ["simctl", "boot", pick.udid], { stdio: "inherit" });
sh("xcrun", "simctl", "bootstatus", pick.udid, "-b");

const srv = await startServer({ port: 8123 });
let code = 1;
try {
  // Mobile Safari is slow to start on a runner: launch it, let it settle, and retry the open.
  spawnSync("xcrun", ["simctl", "launch", pick.udid, "com.apple.mobilesafari"], { stdio: "inherit", timeout: 120000 });
  await sleep(20000);
  const open = async url => { for (let i = 1; i <= 6; i++) { const r = spawnSync("xcrun", ["simctl", "openurl", pick.udid, url], { encoding: "utf8", timeout: 120000 }); if (r.status === 0) return; console.log(`openurl attempt ${i} failed: ${String(r.stderr).split("\n")[0]}`); await sleep(15000); } throw new Error("Mobile Safari would not open " + url); };
  await open(srv.url + "/");
  const end = Date.now() + 120000;
  while (!srv.state.report && Date.now() < end) await sleep(1000);
  if (srv.state.report) { await open(srv.url + "/a/hostile?mode=top&report=nav"); const e2 = Date.now() + 90000; while (!srv.state.top && Date.now() < e2) await sleep(1000); }
  if (!srv.state.report) { console.error("the Deck stand-in never reported in Mobile Safari. Served:", JSON.stringify(srv.state.served)); code = 2; }
  else {
    console.log("user agent:", srv.state.report.ua);
    const { failures, lines } = verify(srv.state.report, srv.state.top, srv.state);
    console.log(lines.join("\n"));
    if (failures.length) { console.log("\nTHE SANDBOX DID NOT HOLD:\n- " + failures.join("\n- ")); code = 1; }
    else { console.log("\nThe sandbox held in iOS Safari, framed and at the top level."); code = 0; }
  }
} finally {
  spawnSync("xcrun", ["simctl", "shutdown", pick.udid]);
  await srv.close();
}
process.exit(code);
