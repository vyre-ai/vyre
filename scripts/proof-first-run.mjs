#!/usr/bin/env node
// scripts/proof-first-run.mjs: the new first run, end to end, on a client machine with NO vyred. One line per step (PASS, FAIL with the reason and what the screen said, SKIP when an earlier step it needs failed).
//
//   node scripts/proof-first-run.mjs --client browser --server installer --dist <proof export> [--out DIR]     (Linux: headless Chromium on the proof export, the real installer in docker)
//   node scripts/proof-first-run.mjs --client mac-app --server mac --app /Applications/Vyre.app [--out DIR]    (macOS: the dmg-installed Mac app, real mouse events, the real Mac installer)
//
// The client is the app's own first-run screens running the in-page tool host (apps/app/src/host): no daemon answers them. Walked as a person walks them: Get started, Create an identity (username, master
// password, recovery key), Create a space with the one install command, the real installer running that command on a server, the server pairing to the creator, Ready, then coming back (a new page, or the
// app started again) to the unlock screen with the master password and with the recovery key. What is a stand-in: the names directory (the Worker's own code) and the relay (relay/node/server.js), on the
// runner at the two ports the proof build of the app was made with (EXPO_PUBLIC_VYRE_NAMES_DIRECTORY and EXPO_PUBLIC_VYRE_RELAY: build-time seams, so a shipped app cannot be pointed anywhere); nothing
// reaches vyre.run. The mouse in the Mac app is a real mouse event into its window and the keys are typed into the focused field (local/capsule/native/Sources/Agent/AgentDrive.swift, a driven mode that
// starts only in a test home). CI only.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createRun } from "./lib/proof/run.mjs";
import { startStandins } from "./lib/proof/standins.mjs";
import { startInstallerServer } from "./lib/proof/server-installer.mjs";
import { startMacServer } from "./lib/proof/server-mac.mjs";
import { MacPage } from "./lib/first-run/page.mjs";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import { AI_SIGNIN_COPY } from "../lib/first-run-shape.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const client = /** @type {"browser" | "mac-app"} */ (take("--client", "browser"));
const server = /** @type {"installer" | "mac"} */ (take("--server", client === "mac-app" ? "mac" : "installer"));
const dist = path.resolve(take("--dist", ""));
const appPath = take("--app", "/Applications/Vyre.app");
const out = path.resolve(take("--out", path.join(os.tmpdir(), `proof-first-run-${process.pid}`)));
const PORTS = { names: Number(take("--names-port", "8787")), relay: Number(take("--relay-port", "8788")), page: Number(take("--page-port", "8789")) };
if (!["browser", "mac-app"].includes(client) || !["installer", "mac"].includes(server)) { console.error("proof-first-run: --client browser|mac-app, --server installer|mac"); process.exit(64); }
if (process.env.GITHUB_ACTIONS !== "true" && process.env.VYRE_ALLOW_LOCAL_RUN !== "1") { console.error("proof-first-run runs on CI only (the installers use fixed folders and system services)"); process.exit(2); }
if (client === "browser" && !fs.existsSync(path.join(dist, "index.html"))) { console.error(`proof-first-run: --dist needs a web export (proof build) with index.html, got ${dist}`); process.exit(64); }

const PASSWORD = "correct horse battery staple";
const USERNAME = `proof${Math.random().toString(36).slice(2, 7)}`;
fs.mkdirSync(out, { recursive: true });
const run = createRun({ out });
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {() => Promise<any> | any} f @param {number} ms @param {string} what */
async function until(f, ms, what) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch (e) { last = String(/** @type {Error} */ (e).message); } await wait(500); }
  throw new Error(`${what} did not happen in ${Math.round(ms / 1000)} s${last ? `: ${last}` : ""}`);
}

/**
 * One interface over the two clients. `click(text)` presses the button, choice or switch showing that text; `fill(label, value)` types into the field with that label; `waitFor(text)` waits for the
 * screen to say it; `text()` is what the screen says now.
 * @typedef {{ open(): Promise<void>, text(): Promise<string>, waitFor(t: string, ms?: number): Promise<string>, click(t: string): Promise<void>, fill(l: string, v: string): Promise<void>, shot(n: string): Promise<void>, reopen(): Promise<void>, errors(): string[], noVyred(): Promise<string>, stop(): Promise<void> }} Driver
 */

/** Headless Chromium on the proof export, served at /app/ by a small static server on the page's fixed port (the stand-in directory allows that origin). @returns {Promise<Driver>} */
async function browserDriver() {
  const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
  const { chromium } = require("playwright");
  const TYPES = /** @type {Record<string, string>} */ ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml" });
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(String(req.url).split("?")[0]).replace(/^\/app/, "") || "/";
    let f = path.join(dist, p);
    const missing = !f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory();
    if (missing && path.extname(p)) { res.writeHead(404); return res.end(); }
    if (missing) f = path.join(dist, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  }).listen(PORTS.page, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const browser = await chromium.launch({ args: [...CHROME_SAFE] });
  const ctx = await browser.newContext({ viewport: { width: 520, height: 1000 }, serviceWorkers: "block" });
  /** @type {any} */ let page = null;
  const pageErrors = /** @type {string[]} */ ([]);
  const body = async () => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  const d = {
    async open() { if (page) await page.close().catch(() => {}); page = await ctx.newPage(); page.on("pageerror", (/** @type {Error} */ e) => pageErrors.push(String(e.message).slice(0, 200))); await page.goto(`http://127.0.0.1:${PORTS.page}/app/onboard`, { waitUntil: "domcontentloaded" }); },
    text: body,
    async waitFor(/** @type {string} */ t, ms = 30_000) { await until(async () => (await body()).includes(t), ms, `the screen saying "${t}"`).catch(async (e) => { throw new Error(`${e.message}. The screen says: ${(await body()).slice(0, 300)}`); }); return body(); },
    async click(/** @type {string} */ t) {
      const el = page.getByRole("button", { name: t }).or(page.getByRole("radio", { name: t })).or(page.getByRole("switch", { name: t })).or(page.getByText(t, { exact: true })).first();
      await el.click({ timeout: 15_000 });
    },
    async fill(/** @type {string} */ l, /** @type {string} */ v) { await page.locator(`input[aria-label="${l}"], textarea[aria-label="${l}"]`).first().fill(v, { timeout: 15_000 }); },
    async shot(/** @type {string} */ n) { await page.screenshot({ path: path.join(out, `${n}.png`), fullPage: true }).catch(() => {}); },
    // Coming back: a new page in the same browser profile (what is kept on the device stays; what was in the old page's memory does not).
    async reopen() { await d.open(); },
    errors: () => pageErrors.filter((e) => !/color scheme|dark mode/i.test(e)),
    // A browser on a static file server has no daemon of any kind: nothing answers /v1 here.
    async noVyred() { const r = await fetch(`http://127.0.0.1:${PORTS.page}/v1/tools/identity.status`, { method: "POST" }); const t = await r.text(); if (/"data"|"error"/.test(t) && r.headers.get("content-type") === "application/json") throw new Error("something on the client answers /v1"); return "the page's origin serves files only"; },
    async stop() { await browser.close().catch(() => {}); srv.close(); },
  };
  return d;
}

/** The dmg-installed Mac app with no vyred: its window is the bundled app. @returns {Promise<Driver>} */
async function macDriver() {
  const bin = path.join(appPath, "Contents", "MacOS", "Vyre");
  if (!fs.existsSync(bin)) throw new Error(`no app at ${appPath}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-first-run-"));
  /** @type {MacPage | null} */ let page = null;
  const start = async () => { page?.stop(); page = new MacPage(bin, { VYRE_HOME: home, VYRE_SOCKET: path.join(home, "no-vyred.sock"), VYRE_NO_DIALOGS: "1" }); await page.started(60_000); await page.open(); };
  const need = () => /** @type {MacPage} */ (page);
  return {
    open: start,
    text: () => need().text(),
    async waitFor(t, ms = 30_000) { return need().waitFor(t, ms); },
    async click(t) {
      // A choice, a button or a switch is found by its own words; the first matching element is the one on screen.
      await need().click(t, 20_000);
    },
    async fill(l, v) { await need().fill(l, v, 20_000); },
    async shot(n) { await need().shot(path.join(out, `${n}.png`)); },
    async reopen() { need().stop(); await wait(1500); await start(); },
    errors: () => [],
    // The app is pointed at a socket that does not exist and its own home holds none: no vyred is running for this app, so its window is the bundled app and the first run is the in-page host's. (The server the
    // Mac installer makes runs a vyred of its own under launchd; that is the other machine's, in its own home.)
    async noVyred() {
      for (const f of [path.join(home, "no-vyred.sock"), path.join(home, "vyred.sock"), path.join(home, "vyred.pid")]) if (fs.existsSync(f)) throw new Error(`the client has ${path.basename(f)}`);
      const t = await need().text();
      if (/Can't reach your vault/.test(t)) throw new Error("the lock covered the app: the window had neither a daemon nor the in-page host");
      return "no vyred socket or pid in the app's home, and the window shows its first run";
    },
    async stop() { page?.stop(); },
  };
}

const cleanups = /** @type {(() => Promise<any> | any)[]} */ ([]);
let code = 1;
try {
  const hostIp = process.env.PROOF_HOST_IP || Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1";
  const ins = await startStandins({ out, ports: { names: PORTS.names, relay: PORTS.relay }, appOrigins: `vyreapp://box,http://127.0.0.1:${PORTS.page}`, ...(server === "installer" ? { host: "0.0.0.0", publicHost: hostIp } : {}) });
  cleanups.push(() => ins.stop());
  const drv = client === "mac-app" ? await macDriver() : await browserDriver();
  cleanups.push(() => drv.stop());

  /** @type {string} */ let recoveryKey = "", installCode = "", personId = "";
  /** @type {any} */ let srv = null;
  const S = (/** @type {string} */ n) => n;

  await run.step(S("the first screen offers Create an identity and Sign in"), async () => {
    await drv.open();
    const t = await drv.waitFor("Get started", 60_000);
    if (!t.includes("Create an identity") || !t.includes("Sign in")) throw new Error(`the first screen does not offer both: ${t.slice(0, 200)}`);
    await drv.shot("01-get-started");
  });

  await run.step(S("the client machine runs no vyred: the first run is the app's in-page host"), async () => drv.noVyred(), { needs: [S("the first screen offers Create an identity and Sign in")] });

  await run.step(S("create an identity: username, master password, recovery key"), async () => {
    await drv.click("Create an identity");
    await drv.waitFor("Create your identity");
    await drv.fill("Username", USERNAME);
    await drv.fill("Master password", PASSWORD);
    await drv.fill("Confirm master password", PASSWORD);
    await drv.click("Create");
    const t = await drv.waitFor("Save your recovery key", 120_000);
    const m = /[A-Z2-7]{4}(?:-[A-Z2-7]{2,4}){6}/i.exec(t);
    if (!m) throw new Error(`no recovery key on the screen: ${t.slice(0, 200)}`);
    recoveryKey = m[0];
    await drv.shot("02-recovery-key");
    await drv.click(client === "mac-app" ? "I saved it" : "I saved it");
    await drv.click("Continue");
    await drv.waitFor(AI_SIGNIN_COPY.title);
    await drv.click(AI_SIGNIN_COPY.skip);
    await drv.waitFor("Your space");
    const r = await fetch(`${ins.names}/v1/ids/resolve?name=${USERNAME}`);
    const j = /** @type {any} */ (await r.json());
    if (r.status !== 200 || !j.data || !/^per_[a-z2-7]{26}$/.test(String(j.data.id))) throw new Error(`the directory has no identity for ${USERNAME}: ${r.status}`);
    personId = String(j.data.id);
    return `${USERNAME} ${personId}`;
  }, { needs: [S("the first screen offers Create an identity and Sign in")] });

  await run.step(S("create a space: the screen shows one install command with a one-time code"), async () => {
    await drv.click("Create a space");
    await drv.waitFor("Where should it run?");
    await drv.click(server === "mac" ? "Always-on Mac" : "Linux server");
    await drv.click("Show the command");
    const t = await drv.waitFor("Waiting for it to come online", 90_000);
    const m = /VYRE_CODE=([A-Za-z0-9_-]+)/.exec(t);
    if (!m) throw new Error(`no install command on the screen: ${t.slice(0, 300)}`);
    if (/\bvyre (up|space|wink|install)\b/i.test(t.replace(/vyre\.run/g, ""))) throw new Error("the screen shows a vyre subcommand");
    if (/four words|words match/i.test(t)) throw new Error("the screen asks for words");
    installCode = m[1];
    await drv.shot("03-install-command");
    return `code ${installCode.slice(0, 4)}...`;
  }, { needs: [S("create an identity: username, master password, recovery key")] });

  await run.step(S("the real installer runs the command on a server"), async () => {
    const a = { dir: path.join(out, "server"), repo, code: installCode, relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store: /** @type {"records" | "plain"} */ (server === "mac" ? "plain" : "records") };
    srv = server === "mac" ? await startMacServer(a) : await startInstallerServer({ ...a, devBuild: true, recreate: false, ownerId: personId });
    cleanups.push(() => srv.stop());
    return srv.kind;
  }, { needs: [S("create a space: the screen shows one install command with a one-time code")] });

  await run.step(S("the server pairs to the creator, the screen names it, and the app reaches Ready"), async () => {
    const t = await drv.waitFor("Your space is online", 300_000);
    await drv.shot("04-space-online");
    if (/four words|words match/i.test(t)) throw new Error("the online screen asks for words");
    if (!/Not your server\?/i.test(t)) throw new Error(`the online screen does not offer "Not your server? Remove it": ${t.slice(0, 300)}`);
    await drv.click("Continue");
    const ready = await drv.waitFor("You're in", 60_000);
    await drv.shot("05-ready");
    if (!/owner/i.test(ready)) throw new Error(`Ready does not list the space with the owner role: ${ready.slice(0, 200)}`);
    await drv.click("Open Vyre");
    await until(async () => !(await drv.text()).includes("You're in"), 30_000, "Open Vyre leaving the first run");
  }, { needs: [S("the real installer runs the command on a server")] });

  await run.step(S("the server names this identity its owner"), async () => {
    const owner = await srv.operator("spaces.owner.status", {});
    if (!owner || owner.identity !== personId) throw new Error(`the server's owner is ${JSON.stringify(owner)}, not ${personId}`);
  }, { needs: [S("the server pairs to the creator, the screen names it, and the app reaches Ready")] });

  await run.step(S("coming back: the unlock screen takes the master password, refuses a wrong one"), async () => {
    await drv.reopen();
    await drv.waitFor("Welcome back", 60_000);
    await drv.shot("06-unlock");
    await drv.fill("Master password", "zebra quartz mango pillow");
    await drv.click("Unlock");
    await drv.waitFor("not your master password", 120_000);
    await drv.fill("Master password", PASSWORD);
    await drv.click("Unlock");
    await until(async () => !(await drv.text()).includes("Welcome back"), 120_000, "the master password opening the identity");
  }, { needs: [S("the server names this identity its owner")] });

  await run.step(S("coming back again: the recovery key opens the identity too"), async () => {
    await drv.reopen();
    await drv.waitFor("Welcome back", 60_000);
    await drv.click("Use my recovery key");
    await drv.fill("Recovery key", recoveryKey);
    await drv.click("Unlock");
    await until(async () => !(await drv.text()).includes("Welcome back"), 60_000, "the recovery key opening the identity");
  }, { needs: [S("coming back: the unlock screen takes the master password, refuses a wrong one")] });

  await run.step(S("no page error during the run"), async () => {
    const e = drv.errors();
    if (e.length) throw new Error(e.slice(0, 3).join(" | "));
  });
} finally {
  code = run.finish();
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
}
process.exit(code);
