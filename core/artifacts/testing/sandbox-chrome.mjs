// AR-S2 baseline in Chrome for Testing on Linux (and any OS with CHROME set): the same hostile page,
// framed and at the top level, so a failure elsewhere can be told from a failure of the harness.
// Chrome runs headless against the local server; the Deck stand-in posts its report back, and the
// top-level page navigates itself to the collector with its results.

import { spawn } from "node:child_process";
import { CHROME_SAFE } from "../../../lib/chrome-flags/index.js";
import { startServer } from "./sandbox-server.mjs";
import { verify } from "./sandbox-verify.mjs";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("set CHROME to a Chrome binary"); process.exit(3); }
const flags = [...CHROME_SAFE, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio", "--user-data-dir=" + (process.env.RUNNER_TEMP || "/tmp") + "/sandbox-proof-" + process.pid, ...(process.env.CHROME_EXTRA_FLAGS ? process.env.CHROME_EXTRA_FLAGS.split(/\s+/) : [])];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = await startServer({ port: 8123 });
let code = 1;
try {
  // Framed: Chrome stays open while the page runs; the report lands on the server.
  const c = spawn(CHROME, [...flags, srv.url + "/"], { stdio: "ignore" });
  const end = Date.now() + 60000;
  while (!srv.state.report && Date.now() < end) await sleep(500);
  c.kill();
  // Top level: the page navigates itself to the collector with its results.
  const c2 = spawn(CHROME, [...flags, srv.url + "/a/hostile?mode=top&report=nav"], { stdio: "ignore" });
  const end2 = Date.now() + 60000;
  while (!srv.state.top && Date.now() < end2) await sleep(500);
  c2.kill();
  const top = srv.state.top;
  if (!srv.state.report) console.log("framed: no report");
  if (!top) console.log("top-level: no results in the dumped DOM");
  console.log("user agent:", srv.state.report && srv.state.report.ua);
  const { failures, lines } = verify(srv.state.report, top, srv.state);
  console.log(lines.join("\n"));
  if (failures.length) { console.log("\nTHE SANDBOX DID NOT HOLD:\n- " + failures.join("\n- ")); code = 1; }
  else { console.log("\nThe sandbox held in Chrome, framed and at the top level."); code = 0; }
} finally { await srv.close(); }
process.exit(code);
