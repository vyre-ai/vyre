// AR-S2 in the iOS simulator's Safari (the phone app is the Deck in iOS Safari): boot a simulator,
// open the Deck stand-in in Mobile Safari with simctl, and read the report the page posts back to
// the server. The simulator shares the host's network, so 127.0.0.1 is this runner. The framed run
// only: a page opened at the top level has nowhere to report to without WebDriver.

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
  sh("xcrun", "simctl", "openurl", pick.udid, srv.url + "/");
  const end = Date.now() + 120000;
  while (!srv.state.report && Date.now() < end) await sleep(1000);
  if (!srv.state.report) { console.error("the Deck stand-in never reported in Mobile Safari. Served:", JSON.stringify(srv.state.served)); code = 2; }
  else {
    console.log("user agent:", srv.state.report.ua);
    const { failures, lines } = verify(srv.state.report, null, srv.state);
    console.log(lines.join("\n"));
    if (failures.length) { console.log("\nTHE SANDBOX DID NOT HOLD:\n- " + failures.join("\n- ")); code = 1; }
    else { console.log("\nThe sandbox held in iOS Safari (framed)."); code = 0; }
  }
} finally {
  spawnSync("xcrun", ["simctl", "shutdown", pick.udid]);
  await srv.close();
}
process.exit(code);
