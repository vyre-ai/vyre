// AR-S2 on macOS Safari: drive the real Safari through safaridriver (WebDriver over HTTP, no
// dependencies). Two runs: the artifact framed by the Deck stand-in with sandbox="allow-scripts"
// (how the Deck and the phone show it), and the artifact opened as the top-level page (a public
// link, the content route opened directly). Needs `sudo safaridriver --enable` once; runs on a
// GitHub macOS runner, never on a person's Mac.

import { spawn } from "node:child_process";
import { startServer } from "./sandbox-server.mjs";
import { verify } from "./sandbox-verify.mjs";

const DRIVER = 4444;
const wd = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${DRIVER}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + label); await sleep(500); } }

const srv = await startServer({ port: 8123 });
const driver = spawn("safaridriver", ["-p", String(DRIVER)], { stdio: ["ignore", "inherit", "inherit"] });
let session = null, code = 1;
try {
  await until(async () => { try { await fetch(`http://127.0.0.1:${DRIVER}/status`); return true; } catch { return false; } }, 20000, "safaridriver to listen");
  const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  session = s.sessionId;
  console.log("Safari:", JSON.stringify(s.capabilities.browserVersion), s.capabilities.platformName);
  await wd("POST", `/session/${session}/url`, { url: srv.url + "/" });
  await until(() => srv.state.report, 60000, "the Deck stand-in's report");
  await wd("POST", `/session/${session}/url`, { url: srv.url + "/a/hostile?mode=top" });
  const topText = await until(async () => { try { return await wd("POST", `/session/${session}/execute/sync`, { script: "var e=document.getElementById('results');return e?e.textContent:null", args: [] }); } catch { return null; } }, 30000, "the top-level page's results");
  const top = JSON.parse(topText);
  console.log("user agent (framed):", srv.state.report.ua);
  console.log("user agent (top):", top.ua);
  const { failures, lines } = verify(srv.state.report, top, srv.state);
  console.log(lines.join("\n"));
  if (failures.length) { console.log("\nTHE SANDBOX DID NOT HOLD:\n- " + failures.join("\n- ")); code = 1; }
  else { console.log("\nThe sandbox held in Safari, framed and at the top level."); code = 0; }
} catch (e) {
  console.error("harness error:", e && e.stack || e);
  console.log("server saw:", JSON.stringify(srv.state.served));
  code = 2;
} finally {
  try { if (session) await wd("DELETE", `/session/${session}`); } catch {}
  driver.kill();
  await srv.close();
}
process.exit(code);
