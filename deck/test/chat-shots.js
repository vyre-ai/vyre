// @ts-check
// Screenshots of Chat in the sample world, on a laptop and a phone: the demo session (bottom, top,
// a fold opened), a permission ask, a question, the composer with a steer and a queued message,
// rewind, and a terminal. Starts its own world (deck/test/world.js with CHAT_DEMO=1) and one
// chrome-headless-shell under `nice -n 15`, and stops both. Each shot also checks that the page
// did not scroll sideways and threw nothing. A test helper, not part of the product.
//
//   node deck/test/chat-shots.js <out dir> [--port 4795] [--only demo,ask]
//
// Runs on testbox (the load rule: one Chrome at a time), in vyre-chrome --headless=new. CHROME=<path> names another binary.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";
import { CHROME_SAFE } from "../../lib/chrome-flags/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : "chat-shots");
const PORT = Number(arg("--port", "4795"));
const ONLY = arg("--only", "").split(",").filter(Boolean);
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const log = (/** @type {string} */ s) => process.stderr.write(`chat-shots: ${s}\n`);
fs.mkdirSync(OUT, { recursive: true });

for (let waited = 0; os.loadavg()[0] >= 8; waited += 30) {
  if (waited >= 900) { log("load stayed at 8 or more for 15 minutes; giving up"); process.exit(0); }
  await sleep(30_000);
}

/** @type {import("node:child_process").ChildProcess[]} */
const started = [];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chat-shots-chrome-"));
async function stopAll() {
  for (const p of started.reverse()) {
    if (p.exitCode != null || p.signalCode != null) continue;
    const gone = new Promise(r => p.once("exit", r));
    try { p.kill("SIGTERM"); } catch {}
    await Promise.race([gone, sleep(6000)]);
    if (p.exitCode == null && p.signalCode == null) try { p.kill("SIGKILL"); } catch {}
  }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on("SIGINT", () => { stopAll().then(() => process.exit(1)); });
process.on("SIGTERM", () => { stopAll().then(() => process.exit(1)); });

const env = { ...process.env, CHAT_DEMO: "1", VYRE_NO_DIALOGS: "1", VYRE_TAILSCALE_BIN: path.join(HERE, "fake-tailscale.js") };
const world = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "world.js"), String(PORT)], { env, stdio: ["ignore", "pipe", "inherit"] });
started.push(world);
const base = await new Promise((resolve, reject) => {
  let buf = "";
  world.stdout?.on("data", d => { buf += d; const m = buf.match(/deck world: (http:\/\/\S+?)\/? /); if (m) resolve(m[1]); });
  world.once("exit", c => reject(new Error(`world exited ${c}`)));
  setTimeout(() => reject(new Error("world did not come up in 120 s")), 120_000);
});
log(`world ${base}`);

// vyre-chrome in the new headless mode: chrome-headless-shell (the old mode) loses the variable
// font's space advances and draws "No one is typing" as "Nooneis typing" (pwa, 27 Sep).
const bin = process.env.CHROME || "/usr/local/bin/vyre-chrome";
const cdpPort = 9431 + Math.floor(Math.random() * 400);
const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", ...CHROME_SAFE, `--user-data-dir=${profile}`,
  "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
started.push(chrome);
const CDP = `http://127.0.0.1:${cdpPort}`;
for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }

const tool = async (/** @type {string} */ name, /** @type {any} */ input) =>
  (await fetch(`${base}/v1/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify(input) })).json();

// The two live sessions reach their asks a few seconds after the world is up.
let threads = [];
for (let i = 0; i < 60; i++) {
  const r = await tool("threads.list", {});
  threads = r.data?.threads || r.data || [];
  const asks = (await tool("threads.asks", {})).data || [];
  if (threads.length >= 4 && asks.length >= 3) break;
  await sleep(500);
}
const idOf = (/** @type {string} */ name) => { const t = threads.find((/** @type {any} */ t) => t.name === name); if (!t) throw new Error(`no thread named ${name}`); return t.id; };
const DEMO = idOf("Tidy the intake form"), ASK = idOf("Intake form, second pass"), QUESTION = idOf("Northwind menu page"), PLAN = idOf("Northwind price list plan");
const cwd = threads.find((/** @type {any} */ t) => t.id === DEMO).cwd;

const DEVICES = [
  { name: "desk", width: 1280, height: 800, scale: 1, mobile: false },
  { name: "phone", width: 390, height: 844, scale: 2, mobile: true, standalone: true },
];

/** Each shot: where, then what to do in the page before the picture. */
const SHOTS = [
  { name: "1-demo", thread: DEMO },
  { name: "1b-demo-top", thread: DEMO, script: `document.querySelector(".thread-view").scrollTop = 0; await wait(300);` },
  { name: "2-fold-open", thread: DEMO, script: `const r = await waitFor(".cv-run-head"); r.click(); await wait(400); r.scrollIntoView({ block: "start" }); await wait(300);` },
  { name: "3-ask", thread: ASK },
  { name: "4-question", thread: QUESTION },
  { name: "4b-question-end", thread: QUESTION, script: `const c = await waitFor(".cv-q-actions, .cv-question .btn"); c.scrollIntoView({ block: "end" }); await wait(300);` },
  { name: "6-rewind", thread: DEMO, script: `const ta = await waitFor(".composer textarea"); ta.focus();
    for (let i = 0; i < 2; i++) { ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(120); } await wait(400);` },
  // Last: it sends into the ask session (a steer, then a queued line).
  { name: "5-composer", thread: ASK, script: `const ta = await waitFor(".composer textarea");
    type(".composer textarea", "Keep the phone field optional"); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await wait(800);
    type(".composer textarea", "Then update the changelog"); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true })); await wait(1000);` },
  { name: "7-terminal", term: true },
  { name: "8-plan", thread: PLAN, script: `await waitFor(".cv-plan", 15000); await wait(300);` },
];

let failed = 0;
for (const dev of DEVICES) {
  const tab = await openTab(CDP, dev);
  for (const s of SHOTS) {
    if (ONLY.length && !ONLY.some(o => s.name.includes(o))) continue;
    try {
      if (s.term) {
        await tab.go(`${base}/chat`, 1500);
        const term = await tab.run(`const m = await import("/chat/term.js"); const r = await m.openTerminal(${JSON.stringify(cwd)}); return r.term || JSON.stringify(r.error);`);
        await tab.go(`${base}/chat?term=${encodeURIComponent(term)}`, 2500);
      } else {
        await tab.go(`${base}/chat/thread/${encodeURIComponent(/** @type {string} */ (s.thread))}`, 2500);
      }
      if (s.script) await tab.run(s.script);
      await sleep(300);
      const wide = await tab.run(`return document.documentElement.scrollWidth > innerWidth + 1;`);
      if (wide) { failed++; log(`${s.name} ${dev.name}: the page scrolls sideways`); }
      fs.writeFileSync(path.join(OUT, `${s.name}-${dev.name}.png`), await tab.shot());
    } catch (e) { failed++; log(`${s.name} ${dev.name}: ${/** @type {Error} */ (e).message}`); }
  }
  if (tab.errors.length) { failed++; log(`${dev.name} page errors: ${[...new Set(tab.errors)].join(" | ").slice(0, 2000)}`); }
  await tab.close();
}
await stopAll();
log(`${failed ? failed + " problems" : "ok"}; shots in ${OUT}`);
process.exit(failed ? 1 : 0);
