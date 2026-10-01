// @ts-check
// A real-Chrome check of "Sign in with GitHub" in Settings > Connections, on testbox only:
//
//   node deck/test/connections-github-browser.js [--port 4796] [--out <dir>]
//
// It starts the native bar's world with --fake-github (deck/test/native-bar/fake-github.mjs, a
// global fetch() intercept preloaded into the spawned vyred, never a real GitHub request) and one
// headless Chrome, opens /settings, adds a GitHub account (name, code, Open GitHub link), waits
// for the fake device flow to complete for real (github.connect polling connect.js's own timer,
// not sped up), checks the account shows with its login, then disconnects it. A test helper, not
// part of the product.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { CHROME_SAFE } from "../../lib/chrome-flags/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", "4796"));
const OUT = path.resolve(arg("--out", fs.mkdtempSync(path.join(SCRATCH, "gh-shots-"))));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @type {import("node:child_process").ChildProcess[]} */ const started = [];
const scratch = fs.mkdtempSync(path.join(SCRATCH, "gh-chrome-"));
let failed = 0;
const say = (/** @type {string} */ check, /** @type {boolean} */ pass, detail = "") => { if (!pass) failed++; process.stdout.write(JSON.stringify({ check, pass, ...(detail ? { detail } : {}) }) + "\n"); };
async function stopAll() {
  for (const p of started.reverse()) { try { p.kill("SIGTERM"); } catch {} }
  await sleep(1500);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

try {
  const w = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "native-bar", "world.js"), "--port", String(PORT), "--fake-github", "--fake-github-login", "alex-harlow", "--fake-github-pending", "1"],
    { stdio: ["ignore", "pipe", "inherit"] });
  started.push(w);
  /** @type {{ url: string }} */
  const world = await new Promise((resolve, reject) => {
    let buf = "";
    w.stdout?.on("data", d => { buf += d; const l = buf.split("\n").find(x => x.startsWith("{")); if (l) resolve(JSON.parse(l)); });
    w.once("exit", c => reject(new Error(`world exited ${c}`)));
    setTimeout(() => reject(new Error("world did not come up in 120 s")), 120_000);
  });
  const bin = process.env.CHROME || path.join(os.homedir(), "vyre-ci/pwa-chrome/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell");
  const cdpPort = 9531 + Math.floor(Math.random() * 400);
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", ...CHROME_SAFE, `--user-data-dir=${scratch}`,
    "--no-sandbox", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  const CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }
  const tab = await openTab(CDP, { width: 1280, height: 900, scale: 1, mobile: false });
  const shot = async (/** @type {string} */ name, /** @type {string} */ sel) => {
    await tab.run(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }); return true;`);
    await sleep(300);
    const r = await tab.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
  };
  await tab.go(`${world.url}/settings#connections`, 2500);
  await tab.run(`await waitFor("[data-act=add-github]", 15000); return true;`);

  // 1. Open the form, name the account, start the device flow.
  await tab.run(`await click("[data-act=add-github]"); await waitFor("form[data-form=github]"); return true;`);
  await tab.run(`type("#cgh-name", "work"); document.querySelector("form[data-form=github]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); return true;`);
  const codeShown = await tab.run(`const c = await waitFor(".cn-gh-code", 10000); return c.textContent;`).catch(e => String(e));
  say("the device code shows", codeShown === "WXYZ-1234", `saw "${codeShown}"`);
  const openHref = await tab.run(`return document.querySelector("a[data-act=open-github]")?.getAttribute("href") || "";`);
  say("Open GitHub points at verification_uri_complete", openHref === "https://github.com/login/device?user_code=WXYZ-1234", openHref);
  await shot("gh-code", "[data-signin=waiting]");

  // 2. The fake device flow completes for real (connect.js's own poll timer, not sped up): the
  //    account appears, the form closes, the token never reaches the page.
  await tab.run(`await waitFor("[data-github=work]", 20000); return true;`);
  const rowText = await tab.run(`return document.querySelector('[data-github=work]').textContent;`);
  say("the connected account shows its login, not a token", /alex-harlow/.test(rowText) && !/fake-gh-token/.test(rowText), rowText.slice(0, 200));
  const formGone = await tab.run(`return !document.querySelector("[data-signin]");`);
  say("the form closes once connected", formGone);
  await shot("gh-connected", "[data-github=work]");

  // 3. Disconnect asks first, then removes it; no client secret is configured in this world, so
  //    the revoke is skipped and the row's status says so rather than pretending it is gone clean.
  await tab.run(`await click('[data-github=work] button[data-act=remove]'); await waitFor('[data-github=work] button[data-act=remove-yes]'); return true;`);
  await tab.run(`await click('[data-github=work] button[data-act=remove-yes]'); await wait(800); return true;`);
  const afterRemove = await tab.run(`return !document.querySelector("[data-github=work]");`);
  say("Disconnect removes the row", afterRemove);

  say("no page errors", tab.errors.length === 0, tab.errors.slice(0, 3).join(" | "));
  process.stdout.write(JSON.stringify({ shots: OUT }) + "\n");
} catch (e) {
  say("ran", false, String(/** @type {Error} */ (e).stack || e));
} finally {
  await stopAll();
  process.exit(failed ? 1 : 0);
}
