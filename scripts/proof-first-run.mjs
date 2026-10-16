#!/usr/bin/env node
// scripts/proof-first-run.mjs: the new first run, end to end, with nothing standing in for the parts that matter. One line per step (PASS, or FAIL with the reason, or SKIP when an earlier step it needs failed).
//
//   node scripts/proof-first-run.mjs --server installer|mac [--dist apps/app/dist] [--mac-app /Applications/Vyre.app] [--out DIR]
//
// What runs for real:
//   - a person's computer: a real vyred (core/daemon) on a fresh home that serves the app's own web export (apps/app/dist, built from this checkout), the way the Mac app's vyred does;
//   - the first run itself: the real screens in a real browser, driven through Identity (username, master password, recovery key), then Create a space, with the one install command the screen shows;
//   - the server: the REAL installer (scripts/install-box.sh in docker on a Linux runner, or scripts/install-mac-server.sh on a hosted macOS runner), run with that command's one-time code;
//   - the relay (relay/node/server.js) and the names directory (the Worker's own code), both on loopback or the runner's address; nothing reaches vyre.run;
//   - with --mac-app: the installed Vyre.app, started against that vyred (through a proxy that only notes request lines), whose window must load the app and call the daemon.
// It ends where a person ends: the app says Ready, the server names this identity its owner, the space is listed, and after a lock the master password opens the identity again.
// Exits 0 when nothing failed. CI only (the installers use fixed folders and system services).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRun } from "./lib/proof/run.mjs";
import { startStandins } from "./lib/proof/standins.mjs";
import { startInstallerServer } from "./lib/proof/server-installer.mjs";
import { startMacServer } from "./lib/proof/server-mac.mjs";
import { tcpFront, unixFront } from "./lib/proof/socket-proxy.mjs";
import { start } from "../core/daemon/index.js";
import { socketPath } from "../core/config/index.js";
import { CHROME_SAFE } from "../lib/chrome-flags/index.js";
import { AI_SIGNIN_COPY } from "../lib/first-run-shape.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const server = /** @type {"installer" | "mac"} */ (take("--server", "installer"));
const dist = path.resolve(take("--dist", path.join(repo, "apps/app/dist")));
const macApp = take("--mac-app", "");
const out = path.resolve(take("--out", path.join(os.tmpdir(), `proof-first-run-${process.pid}`)));
if (!["installer", "mac"].includes(server)) { console.error("proof-first-run: --server is installer or mac"); process.exit(64); }
if (process.env.GITHUB_ACTIONS !== "true" && process.env.VYRE_ALLOW_LOCAL_RUN !== "1") { console.error("proof-first-run runs on CI only (the installers use fixed folders and system services)"); process.exit(2); }
if (!fs.existsSync(path.join(dist, "index.html"))) { console.error(`proof-first-run: no web export at ${dist} (build apps/app with npx expo export -p web --output-dir dist)`); process.exit(64); }
if (!fs.existsSync(path.join(repo, "apps/app/dist/index.html")) && path.resolve(dist) !== path.join(repo, "apps/app/dist")) { console.error("proof-first-run: the daemon serves apps/app/dist; build the export there"); process.exit(64); }

const require = createRequire(process.env.PW_FROM || path.join(os.homedir(), "shots/"));
const { chromium } = require("playwright");

const PASSWORD = "correct horse battery staple";
const USERNAME = `proof${Math.random().toString(36).slice(2, 7)}`;
const SPACE = `space${Math.random().toString(36).slice(2, 7)}`;

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

const cleanups = /** @type {(() => Promise<any> | any)[]} */ ([]);
let code = 1;
try {
  const inCI = process.env.GITHUB_ACTIONS === "true";
  const hostIp = process.env.PROOF_HOST_IP || Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1";
  const ins = await startStandins({ out, ...(server === "installer" ? { host: "0.0.0.0", publicHost: hostIp } : {}) });
  cleanups.push(() => ins.stop());

  // A person's computer: a real vyred on a fresh home. Development switches only for the name reservation and the stand-in presence key (a release build ignores both); the master password
  // key derivation is the real one (Argon2id at the production cost).
  const base = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "vf-"));
  const root = path.join(base, ".vyre");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ machine: "device", name: "proof-computer", transcripts: [], vault: { keystore: "file" }, names: { directory: ins.names }, network: { directory: ins.names },
    relay: { enabled: true, url: ins.relay }, modules: { disable: ["recall", "memory", "learn"] } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "proof\n");
  process.env.VYRE_HOME = root;
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_TEST_SELF_RESERVE = "1";
  process.env.VYRE_NO_DIALOGS = "1";
  const lines = /** @type {string[]} */ ([]);
  const daemon = await start({ root, kernel: true, log: (/** @type {any} */ m) => { lines.push(String(m)); } });
  cleanups.push(() => daemon.stop());
  const upstream = socketPath(root);
  const tool = async (/** @type {string} */ name, input = {}) => { const r = await daemon.registry.call(name, input, "cli"); if (r.error) throw Object.assign(new Error(`${name}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  const front = await tcpFront({ socket: upstream, caller: "cli" });
  cleanups.push(() => front.close());

  // The installed Mac app, when asked for: it connects to a socket of ours that passes every byte to the daemon and notes the request lines.
  /** @type {any} */ let appFront = null, appChild = null;
  if (macApp) {
    await run.step("the Mac app from the dmg is installed, signed, and starts against this computer's vyred", async () => {
      const bin = path.join(macApp, "Contents", "MacOS", "Vyre");
      if (!fs.existsSync(bin)) throw new Error(`no app at ${macApp}`);
      const v = spawnSync("codesign", ["--verify", "--deep", "--strict", macApp], { encoding: "utf8" });
      if (v.status !== 0) throw new Error(`codesign: ${String(v.stderr).slice(0, 200)}`);
      const sock = path.join(base, "app.sock");
      appFront = await unixFront({ listen: sock, upstream });
      cleanups.push(() => appFront.close());
      const appHome = path.join(base, "app-home");
      fs.mkdirSync(appHome, { recursive: true, mode: 0o700 });
      appChild = spawn(bin, [], { env: { ...process.env, VYRE_HOME: appHome, VYRE_SOCKET: sock, VYRE_NO_DIALOGS: "1", VYRE_CAPSULE_TEST: "", VYRE_CAPSULE_DRIVE: "" }, stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; appChild.stderr.on("data", (/** @type {any} */ d) => { err += d; });
      cleanups.push(() => { try { appChild.kill("SIGTERM"); } catch { /* gone */ } });
      await until(() => { if (appChild.exitCode !== null) throw new Error(`the app exited (${appChild.exitCode}): ${err.slice(-300)}`); return appFront.calls.some((c) => /^GET \/app\//.test(c)); }, 90_000, "the app's window asking vyred for /app/");
      await until(() => appFront.calls.some((c) => /^POST \/v1\/tools\//.test(c)), 60_000, "the app's page calling a tool");
      spawnSync("screencapture", ["-x", path.join(out, "mac-window.png")]);
      return `${appFront.calls.length} requests, first ${appFront.calls[0]}`;
    });
  }

  const browser = await chromium.launch({ args: [...CHROME_SAFE] });
  cleanups.push(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 520, height: 1000 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const pageErrors = /** @type {string[]} */ ([]);
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));
  const heading = async () => (await page.locator("[role=heading]").first().innerText({ timeout: 4000 }).catch(() => "")).trim();
  const at = async (/** @type {string} */ want, ms = 20_000) => {
    const ok = await page.locator("[role=heading]", { hasText: want }).first().waitFor({ timeout: ms }).then(() => true, () => false);
    if (!ok) throw new Error(`expected the screen "${want}", found "${await heading()}" (${(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)})`);
  };
  const press = (/** @type {string} */ label) => page.getByRole("button", { name: label }).first().click({ timeout: 10_000 });
  const typeInto = (/** @type {string} */ label, /** @type {string} */ v) => page.locator(`input[aria-label="${label}"], textarea[aria-label="${label}"]`).first().fill(v, { timeout: 10_000 });
  const shot = (/** @type {string} */ n) => page.screenshot({ path: path.join(out, `${n}.png`), fullPage: true }).catch(() => {});

  /** @type {string} */ let recoveryKey = "", installCode = "", personId = "";
  /** @type {any} */ let srv = null;
  const open = () => page.goto(`${front.url}/app/onboard`, { waitUntil: "domcontentloaded" });

  await run.step("the first screen is Create your identity", async () => {
    await open();
    await at("Create your identity", 40_000);
    await shot("01-create-identity");
  });

  await run.step("create an identity: username, master password, recovery key", async () => {
    await typeInto("Username", USERNAME);
    await typeInto("Master password", PASSWORD);
    await typeInto("Confirm master password", PASSWORD);
    await press("Create");
    await at("Save your recovery key", 60_000);
    const body = await page.locator("body").innerText();
    const m = /[A-Z2-7]{4}(?:-[A-Z2-7]{2,4}){6}/.exec(body);
    if (!m) throw new Error(`no recovery key on the screen: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
    recoveryKey = m[0];
    await shot("02-recovery-key");
    await page.getByRole("switch").first().click({ timeout: 6000 });
    await press("Continue");
    await at(AI_SIGNIN_COPY.title);
    await press(AI_SIGNIN_COPY.skip);
    await at("Your space");
    const st = await tool("identity.status");
    if (!st.exists || st.username !== USERNAME) throw new Error(`the device's identity is ${JSON.stringify(st)}`);
    personId = String(st.id);
    return `${USERNAME} ${personId}`;
  }, { needs: ["the first screen is Create your identity"] });

  await run.step("create a space: the screen shows one install command with a one-time code", async () => {
    await page.getByRole("radio", { name: "Create a space" }).first().click({ timeout: 10_000 });
    await at("Where should it run?");
    await page.getByRole("radio", { name: server === "mac" ? "Always-on Mac" : "Linux server" }).first().click({ timeout: 10_000 });
    await press("Show the command");
    await at("Waiting for it to come online", 30_000);
    const body = await page.locator("body").innerText();
    const m = /VYRE_CODE=([A-Za-z0-9_-]+)/.exec(body);
    if (!m) throw new Error(`no install command on the screen: ${body.replace(/\s+/g, " ").slice(0, 300)}`);
    if (/\bvyre (up|space|wink|install)\b/i.test(body.replace(/vyre\.run/g, ""))) throw new Error("the screen shows a vyre subcommand");
    installCode = m[1];
    await shot("03-install-command");
    return `code ${installCode.slice(0, 4)}…`;
  }, { needs: ["create an identity: username, master password, recovery key"] });

  await run.step(`the real installer runs the command on a ${server === "mac" ? "Mac" : "Linux"} server`, async () => {
    const a = { dir: path.join(out, "server"), repo, code: installCode, relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store: /** @type {"records" | "plain"} */ (server === "mac" ? "plain" : "records") };
    srv = server === "mac" ? await startMacServer(a) : await startInstallerServer({ ...a, devBuild: true, recreate: false, ownerId: personId });
    cleanups.push(() => srv.stop());
    return srv.kind;
  }, { needs: ["create a space: the screen shows one install command with a one-time code"] });

  await run.step("the server pairs to the creator and the app reaches Ready", async () => {
    // The screen turns itself over when the space is online; the Continue button stays off until then.
    await until(async () => (await page.getByRole("button", { name: "Continue" }).first().isEnabled().catch(() => false)), 240_000, "the screen saying the space is online");
    await shot("04-space-online");
    await press("Continue");
    await at("You're in", 30_000);
    await shot("05-ready");
    const body = await page.locator("body").innerText();
    if (!/owner/i.test(body)) throw new Error(`Ready does not list the space with the owner role: ${body.replace(/\s+/g, " ").slice(0, 200)}`);
    await press("Open Vyre");
    await until(async () => !/\/onboard/.test(page.url()), 20_000, "Open Vyre leaving the first run");
  }, { needs: [`the real installer runs the command on a ${server === "mac" ? "Mac" : "Linux"} server`] });

  await run.step("the server names this identity its owner, and the app lists the space", async () => {
    const owner = await srv.operator("spaces.owner.status", {});
    if (!owner || owner.identity !== personId) throw new Error(`the server's owner is ${JSON.stringify(owner)}, not ${personId}`);
    const list = await tool("onboard.space.list", {});
    const spaces = Array.isArray(list && list.spaces) ? list.spaces : [];
    if (!spaces.some((/** @type {any} */ s) => s.role === "owner")) throw new Error(`the app lists no owned space: ${JSON.stringify(list).slice(0, 300)}`);
    return `${spaces.length} space(s)`;
  }, { needs: ["the server pairs to the creator and the app reaches Ready"] });

  await run.step("after a lock the unlock screen takes the master password", async () => {
    await tool("identity.lock");
    await page.goto(`${front.url}/app/`, { waitUntil: "domcontentloaded" });
    await at("Welcome back", 40_000);
    await shot("06-unlock");
    await typeInto("Master password", "zebra quartz mango pillow");
    await press("Unlock");
    await page.getByText("not your master password", { exact: false }).first().waitFor({ timeout: 30_000 });
    await typeInto("Master password", PASSWORD);
    await press("Unlock");
    await until(async () => (await tool("identity.status")).unlocked === true, 30_000, "the identity unlocking");
    await page.locator("[role=heading]", { hasText: "Welcome back" }).first().waitFor({ state: "detached", timeout: 15_000 });
  }, { needs: ["the server names this identity its owner, and the app lists the space"] });

  await run.step("the recovery key opens the identity too", async () => {
    await tool("identity.lock");
    await page.goto(`${front.url}/app/`, { waitUntil: "domcontentloaded" });
    await at("Welcome back", 40_000);
    await press("Use my recovery key");
    await typeInto("Recovery key", recoveryKey);
    await press("Unlock");
    await until(async () => (await tool("identity.status")).unlocked === true, 30_000, "the identity unlocking with the recovery key");
  }, { needs: ["after a lock the unlock screen takes the master password"] });

  if (macApp) {
    await run.step("the Mac app's window kept calling the daemon through the whole run", async () => {
      const posts = appFront.calls.filter((/** @type {string} */ c) => /^POST \/v1\/tools\//.test(c)).length;
      if (posts < 3) throw new Error(`the window made only ${posts} tool calls`);
      return `${appFront.calls.length} requests, ${posts} tool calls`;
    }, { needs: ["the Mac app from the dmg is installed, signed, and starts against this computer's vyred"] });
  }

  await run.step("no page error in the browser during the run", async () => {
    const noisy = pageErrors.filter((e) => !/color scheme|dark mode/i.test(e));
    if (noisy.length) throw new Error(noisy.slice(0, 3).join(" | "));
  });
  fs.writeFileSync(path.join(out, "daemon.log"), lines.join("\n").replace(/VYRE_CODE=\S+/g, "VYRE_CODE=<hidden>"));
} finally {
  code = run.finish();
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
}
process.exit(code);
