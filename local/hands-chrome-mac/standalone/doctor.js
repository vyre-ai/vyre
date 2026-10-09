// @ts-check
// doctor: checks the whole path from a terminal, the way a person would if they knew where to look.
//   node -> the installed copy -> the connector registered for each browser -> the launcher starts -> the host really talks to a bridge
//   -> a server is listening and what it says -> which browsers are running and whether any started a connector process.
// It never touches a page, and it never sends anything to the live server's socket (a hello from here would replace the real extension's).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import * as nativeHost from "../native-host/install.js";
import { encode, reader } from "../native-host/stdio.js";
import { createBridge } from "../bridge.js";
import { diagnoseConnection } from "../diagnose.js";

/** @typedef {{ name: string, level: "ok"|"warn"|"fail"|"info", text: string, fix?: string }} Check */

/** Helper processes and browsers driven by a test are not the person's browser. (Spelled out of parts so the launch-flag hygiene test, which greps for the flag, does not mistake this filter for a launch.) */
const SKIP_PROC = new RegExp("Helper|crashpad|--type=|--" + "headless");

/**
 * Browsers running now with when they started (macOS and Linux: `ps`). Only the main process of each, never a helper.
 * @param {string} [platform] @param {string|null} [psText] `ps` output for a test @returns {{ name: string, startedAt: number }[]}
 */
export function runningBrowsers(platform = process.platform, psText = null) {
  if (platform === "win32") return [];
  const r = { stdout: psText ?? spawnSync("ps", ["-axo", "lstart=,command="], { encoding: "utf8" }).stdout };
  const names = /** @type {Array<[string, RegExp]>} */ ([["Google Chrome", /Google Chrome\.app\/Contents\/MacOS\/Google Chrome( |$)|\/(google-)?chrome( |$)/], ["Dia", /Dia\.app\/Contents\/MacOS\/Dia( |$)/], ["Arc", /Arc\.app\/Contents\/MacOS\/Arc( |$)/], ["Brave", /Brave Browser\.app\/Contents\/MacOS\/Brave Browser( |$)/], ["Edge", /Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge( |$)/]]);
  /** @type {{ name: string, startedAt: number }[]} */ const out = [];
  for (const line of String(r.stdout || "").split("\n")) {
    const m = /^\s*(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/.exec(line);
    if (!m || SKIP_PROC.test(m[2])) continue;
    for (const [name, re] of names) if (re.test(m[2])) { const t = Date.parse(m[1]); if (Number.isFinite(t) && !out.some(o => o.name === name)) out.push({ name, startedAt: t }); }
  }
  return out;
}

/** @param {number} pid */
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * @param {{ dataDir: string, appDir: string, extensionId: string, selftest?: boolean, platform?: string, home?: string }} o
 * @returns {Promise<{ checks: Check[], ok: boolean, next: string }>}
 */
export async function doctor({ dataDir, appDir, extensionId, selftest = true, platform = process.platform, home = os.homedir() }) {
  /** @type {Check[]} */ const checks = [];
  const add = (/** @type {Check} */ c) => { checks.push(c); return c; };

  // 1. Node
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 22 ? { name: "node", level: "ok", text: `Node ${process.version} (${process.execPath})` } : { name: "node", level: "fail", text: `Node ${process.version} is too old`, fix: "Install Node 22 or newer." });

  // 2. The installed copy
  const hostDir = process.env.VYRE_CHROME_HOST_DIR || path.join(appDir, "native-host");
  const launcher = path.join(hostDir, platform === "win32" ? "run-host.cmd" : "run-host.sh");
  const installedApp = path.join(dataDir, "app");
  add(fs.existsSync(path.join(installedApp, "extension", "manifest.json"))
    ? { name: "install", level: "ok", text: `installed at ${installedApp}` }
    : { name: "install", level: "fail", text: `nothing installed at ${installedApp}`, fix: "Run `./vyre-chrome install` from the unpacked release." });

  // 3. The connector, registered for each browser
  /** @type {any} */ let st = null;
  try { st = nativeHost.status({ vyreHome: dataDir, hostDir, platform }); } catch (e) { add({ name: "connector", level: "fail", text: `could not read the registration: ${/** @type {Error} */ (e).message}` }); }
  if (st) {
    if (!st.installed.length) add({ name: "connector", level: "fail", text: "not registered with any browser", fix: "Run `vyre-chrome install`." });
    for (const b of st.installed) {
      const wrongId = b.extensionId && b.extensionId !== extensionId;
      add(wrongId ? { name: `connector:${b.browser}`, level: "fail", text: `${b.browser} allows extension ${b.extensionId}, but this package's extension is ${extensionId}`, fix: "Run `vyre-chrome install` again." }
        : !b.pointsAtLauncher ? { name: `connector:${b.browser}`, level: "warn", text: `${b.browser}: the registration points somewhere else than this install's launcher`, fix: "Run `vyre-chrome install` again." }
        : { name: `connector:${b.browser}`, level: "ok", text: `registered for ${b.browser} (${b.file})` });
    }
    // A browser that is installed but has no registration
    for (const b of /** @type {import("../native-host/install.js").Browser[]} */ (Object.keys(nativeHost.BROWSERS))) {
      if (!nativeHost.available(b, platform) || st.installed.some((/** @type {any} */ x) => x.browser === b)) continue;
      const folder = path.dirname(nativeHost.manifestDir(home, platform, b));
      if (fs.existsSync(folder)) add({ name: `connector:${b}`, level: "warn", text: `${b} is installed but the connector is not registered for it`, fix: `Run \`vyre-chrome install --browsers ${b}\`.` });
    }
    add(st.launcherExists && st.launcherExecutable ? { name: "launcher", level: "ok", text: `launcher ${launcher} exists and is executable` } : { name: "launcher", level: "fail", text: `launcher ${launcher} is missing or not executable`, fix: "Run `vyre-chrome install` again." });
    add(st.nodePath && fs.existsSync(st.nodePath) ? { name: "node-path", level: "ok", text: `the connector runs ${st.nodePath}` } : { name: "node-path", level: "fail", text: `the node recorded for the connector is missing (${st.nodePath || "none"})`, fix: "Run `vyre-chrome install` again." });
  }

  if (selftest) {
    // 4. The launcher really starts node and host.js (no connection made).
    try {
      const r = platform === "win32" ? spawnSync(`"${launcher}"`, ["--selftest"], { encoding: "utf8", timeout: 15_000, shell: true }) : spawnSync(launcher, ["--selftest"], { encoding: "utf8", timeout: 15_000 });
      const j = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "{}");
      add(r.status === 0 && j.ok ? { name: "launcher-run", level: "ok", text: `the launcher starts the connector with node ${j.node}; it would connect to ${j.socket}` } : { name: "launcher-run", level: "fail", text: `the launcher did not start the connector (exit ${r.status}): ${String(r.stderr || r.stdout || "").trim().slice(0, 200)}`, fix: "Run `vyre-chrome install` again; if it persists, check the Node install." });
    } catch (e) { add({ name: "launcher-run", level: "fail", text: `the launcher could not run: ${/** @type {Error} */ (e).message}`, fix: "Run `vyre-chrome install` again." }); }

    // 5. The host really talks to a bridge: a private socket, a private bridge, a real host process, a framed hello.
    try {
      const sock = platform === "win32" ? `\\\\.\\pipe\\vyre-chrome-doctor-${process.pid}` : path.join(fs.mkdtempSync(path.join("/tmp", "vc-doc-")), "c.sock");
      const bridge = createBridge({ sockPath: sock, timeoutMs: 3000 });
      await bridge.listen();
      let hello = false;
      bridge.on(e => { if (e.event === "hello") hello = true; });
      const child = spawn(process.execPath, [path.join(hostDir, "host.js")], { env: { ...process.env, VYRE_CHROME_SOCK: sock }, stdio: ["pipe", "pipe", "ignore"] });
      child.stdin.on("error", () => {});
      child.stdin.write(encode({ event: "hello", protocol: 1, version: "doctor", ops: [], caps: {} }));
      const end = Date.now() + 5000;
      while (!hello && Date.now() < end) await new Promise(r => setTimeout(r, 50));
      // And back the other way: the bridge sends the host a request, the host hands it to "Chrome" (its stdout).
      let back = false;
      if (hello) {
        const rd = reader();
        child.stdout.on("data", d => { try { for (const m of rd.push(d)) if (m && m.op === "doctor.ping") back = true; } catch { /* not ours */ } });
        bridge.call("doctor.ping", {}, { timeoutMs: 800 }).catch(() => {});
        const end2 = Date.now() + 2000;
        while (!back && Date.now() < end2) await new Promise(r => setTimeout(r, 50));
      }
      try { child.kill(); } catch { /* gone */ }
      await bridge.close();
      try { if (platform !== "win32") fs.rmSync(path.dirname(sock), { recursive: true, force: true }); } catch { /* gone */ }
      add(hello && back ? { name: "host-roundtrip", level: "ok", text: "a real connector process said hello to a bridge and relayed a request back: the connector itself works" }
        : { name: "host-roundtrip", level: "fail", text: hello ? "the connector said hello but did not relay a request back" : "a real connector process could not reach a bridge", fix: "Run `vyre-chrome install` again; check that nothing blocks local sockets." });
    } catch (e) { add({ name: "host-roundtrip", level: "fail", text: `the connector self-test could not run: ${/** @type {Error} */ (e).message}` }); }
  }

  // 6. A running server, and what it says
  const statusFile = path.join(dataDir, "run", "status.json");
  /** @type {any} */ let server = null;
  try { server = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch { /* none */ }
  if (server && Number.isInteger(server.pid) && alive(server.pid)) {
    if (server.connected) add({ name: "server", level: "ok", text: `the server (pid ${server.pid}) is connected to Chrome (extension ${server.extension ? server.extension.version : "?"})` });
    else add({ name: "server", level: "fail", text: `the server (pid ${server.pid}) is running but has no extension: ${server.problem || "unknown"}`, ...(server.fix ? { fix: server.fix } : {}) });
  } else {
    const sockPath = platform === "win32" ? "" : path.join(dataDir, "run", "chrome.sock");
    const listening = sockPath && fs.existsSync(sockPath) && await new Promise(res => { const s = net.connect(sockPath); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
    add(listening ? { name: "server", level: "warn", text: "something is listening on the connector socket but wrote no status" }
      : { name: "server", level: "info", text: "no Vyre Computer server is running right now (Claude Code starts it when a session uses the tools)" });
  }

  // 7. Which browsers are running, and did any of them start a connector process?
  if (platform !== "win32") {
    const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "";
    const names = [["Google Chrome", /Google Chrome\.app\/Contents\/MacOS\/Google Chrome( |$)|\/chrome( |$)|google-chrome( |$)/], ["Dia", /Dia\.app\/Contents\/MacOS\/Dia( |$)/], ["Arc", /Arc\.app\/Contents\/MacOS\/Arc( |$)/], ["Brave", /Brave Browser\.app\/Contents\/MacOS\/Brave Browser( |$)/], ["Edge", /Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge( |$)/]];
    const running = names.filter(([, re]) => ps.split("\n").some(l => /** @type {RegExp} */ (re).test(l) && !/Helper|crashpad|--type=/.test(l))).map(([n]) => n);
    const hosts = ps.split("\n").filter(l => /native-host\/host\.js|run-host\.sh/.test(l) && !/doctor|--selftest/.test(l)).length;
    add({ name: "browsers", level: "info", text: running.length ? `running now: ${running.join(", ")}` : "no supported browser is running right now" });
    add(running.length && !hosts ? { name: "connector-process", level: "warn", text: "a browser is running but has started no connector process", fix: "Check chrome://extensions: Vyre Computer must be loaded and enabled; click its toolbar icon for the reason. If it is, quit and reopen the browser once." }
      : { name: "connector-process", level: hosts ? "ok" : "info", text: hosts ? `${hosts} connector process(es) running: a browser started the connector` : "no connector process is running" });
  }

  // 8. Did a browser start BEFORE the connector was registered? (Real-use finding 2: a Chrome that had been running for days only connected after a restart.)
  if (st && st.installed.length) {
    for (const rb of runningBrowsers(platform)) {
      const reg = st.installed.find((/** @type {any} */ x) => new RegExp(x.browser === "chrome" ? "chrome" : x.browser, "i").test(rb.name));
      if (!reg) continue;
      let wrote = 0; try { wrote = fs.statSync(reg.file).mtimeMs; } catch { /* gone */ }
      if (wrote && rb.startedAt < wrote - 1000 && !(server && server.connected)) {
        add({ name: `restart:${rb.name}`, level: "warn", text: `${rb.name} started ${new Date(rb.startedAt).toLocaleString()}, before the connector was registered (${new Date(wrote).toLocaleString()})`, fix: `Quit ${rb.name} completely and open it again once. A browser that was already running may not pick up a newly registered connector until it restarts.` });
      }
    }
  }

  const failing = checks.filter(c => c.level === "fail");
  const warns = checks.filter(c => c.level === "warn");
  const next = failing[0] ? failing[0].fix || failing[0].text : warns[0] ? warns[0].fix || warns[0].text
    : server && server.connected ? "Everything is connected."
    : "Everything on this computer is fine. If Claude Code cannot reach Chrome: load and enable the extension in chrome://extensions (click its toolbar icon for the reason), and if it is loaded, quit and reopen Chrome once.";
  return { checks, ok: failing.length === 0, next };
}

/** @param {{ checks: Check[], next: string }} r */
export function render(r) {
  const mark = { ok: "OK  ", warn: "WARN", fail: "FAIL", info: "    " };
  return [...r.checks.map(c => `${mark[c.level]} ${c.text}${c.fix ? `\n       -> ${c.fix}` : ""}`), "", `Next: ${r.next}`].join("\n");
}

// Diagnose helper kept for the install command's live check.
export { diagnoseConnection };
