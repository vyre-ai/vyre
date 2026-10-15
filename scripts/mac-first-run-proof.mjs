#!/usr/bin/env node
// mac-first-run-proof: the Vyre Mac app's first run, on a clean macOS runner, walked screen by screen the way a person walks it: name, Create (add a server), Vault, Ready. TEST ONLY.
//
//   node scripts/mac-first-run-proof.mjs --app /Applications/Vyre.app --out first-run-out
//
// The app is the real one, installed from its dmg onto an empty Mac, with the same sources a release builds. Only two build-time constants differ (EXPO_PUBLIC_VYRE_NAMES_DIRECTORY and
// EXPO_PUBLIC_VYRE_RELAY, the seams the Windows proof uses): the names directory and the relay are stand-ins on this runner (nothing reaches vyre.run). The server is a real vyred on this runner,
// started the way the install line starts one (the one-time code the app prints), so the app's Create step has something real to pair with. The mouse is a real mouse event into the window and
// the keys are typed into the focused field; only the window is driven, never the screen (local/capsule/native/Sources/Agent/AgentDrive.swift).
//
// A step that fails says what the screen showed. The run is red when any step fails. This is a release gate (.github/workflows/first-run.yml, needed by release.yml): the 0.5.0 app shipped stuck
// at Vault on any device with no server, and nothing walked the screens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MacPage } from "./lib/first-run/page.mjs";
import { codeFromInstallLine, wordsFromPage } from "./lib/first-run/lines.mjs";
import { startStandins } from "./lib/proof/standins.mjs";
import { startDaemonServer } from "./lib/proof/server-daemon.mjs";

if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true") { console.error("mac-first-run-proof: only on a GitHub macOS runner (it opens the app and a server)"); process.exit(2); }

const args = process.argv.slice(2);
const flag = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const APP = path.resolve(flag("--app", "/Applications/Vyre.app"));
const OUT = path.resolve(flag("--out", "first-run-out"));
/** The two ports the proof's web build was made with (.github/workflows/first-run.yml). */
const PORTS = { names: Number(flag("--names-port", "8787")), relay: Number(flag("--relay-port", "8788")) };
fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** @type {{ name: string, ok: boolean, note: string }[]} */
const results = [];
/** @type {MacPage | null} */ let page = null;
const slugOf = (/** @type {string} */ n) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
async function check(/** @type {string} */ name, /** @type {() => Promise<string | void>} */ fn) {
  let ok = false, note = "";
  try { note = (await fn()) || ""; ok = true; } catch (e) { note = String(/** @type {Error} */ (e).message || e).split("\n")[0].slice(0, 500); }
  if (!ok && page) { try { note += " | the screen says: " + (await page.text()).replace(/\s+/g, " ").slice(0, 300); } catch { /* the page is gone */ } }
  if (page) await page.shot(path.join(OUT, `${String(results.length + 1).padStart(2, "0")}-${slugOf(name).slice(0, 50)}.png`));
  results.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}   ${name}${note ? ": " + note : ""}`);
  return ok;
}

/** What to read when the app does not find the server: the server's own log, the app's log, and whether this page can open a socket to the relay. */
async function diagnose() {
  const say = (/** @type {string} */ t) => console.log("  diag: " + t.replace(/\s+/g, " ").slice(0, 900));
  try { say("server log: " + (srv ? srv.logs.slice(-25).join(" | ") : "no server")); } catch { /* none */ }
  try { say("app log: " + fs.readFileSync(path.join(os.homedir(), "Library", "Logs", "Vyre", "app.log"), "utf8").slice(-1500)); } catch { say("no app log"); }
  try {
    const r = await /** @type {MacPage} */ (page).evaluate((url) => new Promise((res) => { let ws; try { ws = new WebSocket(url + "/v1/diag"); } catch (e) { return res("constructor threw " + e); } const t = setTimeout(() => res("no answer in 5 s, state " + ws.readyState), 5000); ws.onopen = () => { clearTimeout(t); res("open"); ws.close(); }; ws.onerror = () => { clearTimeout(t); res("error, state " + ws.readyState); }; ws.onclose = (ev) => { clearTimeout(t); res("closed " + ev.code); }; }), ins ? ins.relay : "");
    say("page to relay socket: " + r);
  } catch (e) { say("page probe failed: " + /** @type {Error} */ (e).message); }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-first-run-"));
const person = "walker" + Math.random().toString(36).slice(2, 7);
const spaceName = "Harlow Legal " + Math.random().toString(36).slice(2, 5);
let ins = /** @type {Awaited<ReturnType<typeof startStandins>> | null} */ (null);
let srv = /** @type {Awaited<ReturnType<typeof startDaemonServer>> | null} */ (null);
let stopped = false;
const finish = async () => {
  if (stopped) return; stopped = true;
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  try { page?.stop(); } catch { /* gone */ }
  try { await srv?.stop(); } catch { /* gone */ }
  try { await ins?.stop(); } catch { /* gone */ }
};
const watchdog = setTimeout(async () => { console.log("FAIL   the proof did not finish in 20 minutes"); await finish(); process.exit(1); }, 20 * 60_000);
watchdog.unref();

try {
  await check("the stand-ins answer (names directory and relay), on the ports this app build was made with", async () => {
    ins = await startStandins({ out: OUT, ports: PORTS, appOrigins: "vyreapp://box" });
    const r = await fetch(`${ins.names}/v1/names/check?name=${person}`);
    if (!r.ok) throw new Error("the directory answered " + r.status);
    return `names ${ins.names}, relay ${ins.relay}`;
  });
  if (!ins) throw new Error("no stand-ins");
  const names = ins.names;

  const bin = path.join(APP, "Contents", "MacOS", "Vyre");
  await check("the app is installed (a real Vyre.app) and starts in an empty home", async () => {
    if (!fs.existsSync(bin)) throw new Error("no app at " + APP);
    page = new MacPage(bin, { VYRE_HOME: home, VYRE_SOCKET: path.join(home, "vyred.sock") });
    await page.started();
    const v = fs.existsSync(path.join(APP, "Contents", "Resources", "app", "index.html"));
    if (!v) throw new Error("the app carries no web build (Contents/Resources/app)");
    return fs.readdirSync(home).length ? "home not empty: " + fs.readdirSync(home).join(",") : "empty home";
  });
  const p = /** @type {MacPage} */ (page);

  await check("the window opens with no server of its own (boxless), as the shell of a Mac app", async () => {
    const o = await p.open();
    if (!o.boxless) throw new Error("the window is not the no-server kind");
    await p.waitFor("Sign in to Vyre", 90_000);
    const s = await p.evaluate(() => { const x = /** @type {any} */ (window).__vyreShell; return x ? { kind: x.kind, boxless: x.boxless } : null; });
    if (!s || s.kind !== "mac" || s.boxless !== true) throw new Error("the shell is " + JSON.stringify(s));
    return "Sign in to Vyre";
  });

  await check("Identity: I am new to Vyre, pick a name, the directory says it is free", async () => {
    await p.click("I am new to Vyre");
    await p.click("Continue");
    await p.waitFor("Pick your name");
    await p.fill("name", person);
    await p.waitFor(`${person}.vyre.run is free`, 30_000);
    return `${person}.vyre.run`;
  });
  await check("Identity: reserve the name; the recovery kit shows; the directory holds the name", async () => {
    await p.click("Reserve this name");
    await p.waitFor("Save your recovery kit", 60_000);
    const r = await fetch(`${names}/v1/ids/resolve?name=${person}`);
    if (r.status !== 200) throw new Error("the directory answered " + r.status + " for the new name");
    return "resolves";
  });
  await check("Identity: I saved my recovery kit, Continue; with no server the next screen is Space, not Vault (the 0.5.0 stall)", async () => {
    await p.clickAria("I saved my recovery kit");
    await p.click("Continue");
    const t = await p.waitFor("Create a space or join one", 30_000);
    if (/Let's set up your vault/.test(t)) throw new Error("the Vault came before a server");
    return "Create a space or join one";
  });

  await check("Create: a space, its name and the server choice reach the install line", async () => {
    await p.click("Create a space");
    await p.click("Continue");
    await p.waitFor("Name your space");
    await p.fill("Harlow Legal", spaceName);
    await p.click("Continue");
    await p.waitFor("Can members use their own computers?");
    await p.click("Continue");
    await p.waitFor("Get a server");
    await p.click("I have a server");
    await p.waitFor("Run this on your server", 30_000);
    return spaceName;
  });
  let code = "";
  await check("Create: the screen shows one install line with the one-time code", async () => {
    const t = await p.waitFor("VYRE_CODE=", 30_000);
    code = codeFromInstallLine(t);
    if (!code) throw new Error("no code in the install line");
    return "VYRE_CODE=<code>";
  });
  await check("Create: the server starts from that code (a real vyred on this runner) and the app finds it", async () => {
    const dirForServer = ins ? ins.namesForServer : names;
    let ownerId = "";
    try { const j = /** @type {any} */ (await (await fetch(`${names}/v1/ids/resolve?name=${person}`)).json()); ownerId = String(j?.data?.id || j?.data?.record?.id || j?.id || ""); } catch { /* none */ }
    srv = await startDaemonServer({ dir: path.join(OUT, "server"), code, relay: ins ? ins.relayForServer : "", directory: dirForServer, store: "plain", ...(ownerId ? { ownerId } : {}) });
    await p.click("I have the code");
    try { await p.waitFor("Do the four words match?", 90_000); } catch (e) { await diagnose(); throw e; }
    return srv.kind;
  });
  await check("Create: the four words on the screen are the ones the server shows", async () => {
    const held = await srv.words();
    const shown = wordsFromPage(await p.text()).join(" ");
    if (!held || shown !== held) throw new Error(`the screen shows "${shown}", the server holds "${held}"`);
    return held;
  });
  await check("Create: they match; the server makes the space and its vault", async () => {
    await p.click("They match");
    await p.waitFor(`Setting up ${spaceName}`, 30_000);
    const t = await p.waitFor("Continue", 120_000);
    // Continue stays disabled until the setup has finished: wait for the title's mark by trying until the screen moves on
    for (let i = 0; i < 120; i++) {
      try { await p.click("Continue", 2_000); } catch { await sleep(1000); continue; }
      const now = await p.text();
      if (!/Setting up/.test(now)) return now.replace(/\s+/g, " ").slice(0, 80);
      await sleep(1000);
    }
    throw new Error("the space setup never finished. The screen says: " + t.replace(/\s+/g, " ").slice(0, 200));
  });

  await check("Vault: the vault is offered once a server exists, a master password makes it", async () => {
    await p.waitFor("Let's set up your vault", 30_000);
    await p.click("Create my master password");
    await p.waitFor("Master password");
    const pw = "Correct-Horse-Battery-" + Math.random().toString(36).slice(2, 8);
    await p.fill("Master password", pw);
    await p.fill("Master password again", pw);
    await p.click("Continue");
    await p.waitFor("Only you know it", 30_000);
    await p.clickAria("I understand that a forgotten master password cannot be reset");
    await p.click("Open my vault");
    await p.waitFor("Save your vault recovery secret", 60_000);
    await p.clickAria("I saved my vault recovery secret");
    await p.click("Continue");
    return "vault open";
  });
  await check("Inference: Connect your AI can be skipped", async () => {
    await p.waitFor("Connect your AI", 30_000);
    await p.click("Skip for now");
    return "skipped";
  });
  await check("Ready: the app says the person is in the space, and opens it", async () => {
    let t = await p.text();
    for (let i = 0; i < 3 && /Use this computer for your work/.test(t); i++) { await p.click("Continue"); t = await p.text(); await sleep(500); }
    t = await p.waitFor(`You are in ${spaceName}`, 30_000);
    await p.click(`Open ${spaceName}`);
    await sleep(2000);
    const where = await p.evaluate(() => location.pathname);
    if (!/\/u\/now/.test(String(where))) throw new Error("the app opened at " + where);
    return String(where);
  });
} catch (e) {
  results.push({ name: "the proof ran", ok: false, note: String(/** @type {Error} */ (e).stack || e).slice(0, 600) });
  console.log("FAIL   the proof ran: " + String(/** @type {Error} */ (e).message || e));
} finally {
  await finish();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
