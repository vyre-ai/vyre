#!/usr/bin/env node
// Vyre for Chrome (`vyre-chrome`): control your own Chrome from Claude Code, with no Vyre server.
//   vyre-chrome install [--browsers chrome,brave]   register the native host, print the extension folder
//   vyre-chrome uninstall [--purge]                 remove the host registration (--purge: also the logs)
//   vyre-chrome mcp                                 the stdio MCP server Claude Code runs
//   vyre-chrome status | report [--last N] [--out F] | logs on|off|path|values|shots
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PKG, dataDirOf, sockPathOf, createRuntime } from "./runtime.js";
import { serve } from "./mcp.js";
import { readConfig, writeConfig, report } from "./trace.js";
import readline from "node:readline";
import { doctor, render, runningBrowsers } from "./doctor.js";
import { createBridge } from "../bridge.js";
import { diagnoseConnection } from "../diagnose.js";
import * as nativeHost from "../native-host/install.js";
import { extensionIdFromKey } from "../native-host/install.js";
import { guide, extensionsPage } from "../index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER = ".vyre-chrome-marker";
/** Read-only copies: folders 0500, files 0400 (the launcher and the entry points keep their run bit). @param {string} d */
function lock(d) { if (process.platform === "win32") return; const walk = (/** @type {string} */ p) => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) return; if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); fs.chmodSync(p, 0o500); } else fs.chmodSync(p, st.mode & 0o111 ? 0o500 : 0o400); }; walk(d); }
/** Make a locked copy writable again so it can be replaced or removed. @param {string} d */
function unlock(d) { if (process.platform === "win32" || !fs.existsSync(d)) return; const walk = (/** @type {string} */ p) => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) return; fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600); if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(d); }
const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(PKG, "extension", "manifest.json"), "utf8")).version; } catch { return "0.0.0"; } })();
const out = (/** @type {string} */ s = "") => process.stdout.write(s + "\n");
const flag = (/** @type {string[]} */ a, /** @type {string} */ n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : "true") : undefined; };

/** A hostname from whatever the person typed: a domain, or a URL. Null when it is not one. @param {string} raw */
const hostOf = raw => { const h = String(raw || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, ""); return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(h) ? h : null; };
/** @param {string} q */
const ask = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a); }); });

/**
 * After install: wait for the extension to connect and say "connected" or the exact next step. If a server already holds the
 * connector socket, its own status file is what is watched.
 * @param {{ dataDir: string, sock: string, extensionId: string, seconds: number, hostRegistered: boolean }} o
 */
async function liveCheck({ dataDir, sock, extensionId, seconds, hostRegistered }) {
  const bridge = createBridge({ sockPath: sock, extensionOrigin: `chrome-extension://${extensionId}/`, timeoutMs: 3000 });
  /** @type {string|null} */ let listenErr = null;
  try { await bridge.listen(); } catch (e) { listenErr = /** @type {Error} */ (e).message; }
  const statusFile = path.join(dataDir, "run", "status.json");
  const served = () => { try { const j = JSON.parse(fs.readFileSync(statusFile, "utf8")); return j && j.connected === true ? j : null; } catch { return null; } };
  const end = Date.now() + seconds * 1000;
  /** @type {any} */ let info = null;
  while (Date.now() < end) {
    if (bridge.connected()) { info = bridge.info(); break; }
    const sv = listenErr ? served() : null;
    if (sv) { info = sv.extension || {}; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  const stats = bridge.stats();
  await bridge.close();
  if (info) { out(`Connected: Vyre for Chrome is talking to your browser (extension ${info.version || "?"}). You are done with Chrome; add it to Claude Code (below) if you have not.`); return true; }
  let d = diagnoseConnection({ connected: false, hostRegistered, stats });
  if (listenErr) { try { const j = JSON.parse(fs.readFileSync(statusFile, "utf8")); if (j && j.problem) d = { stage: j.stage, problem: j.problem, fix: j.fix }; } catch { /* keep ours */ } }
  out(`Not connected yet after ${seconds} s: ${d ? d.problem : "unknown"}.`);
  if (d) out(`Next: ${d.fix}`);
  return false;
}

const HELP = `Vyre for Chrome ${version} (vyre-chrome): control your own Chrome from Claude Code

  vyre-chrome install [--browsers chrome,brave]   register the connector; prints what to do next
  vyre-chrome uninstall [--purge]                 remove the connector (--purge also deletes the logs)
  vyre-chrome status                              is it installed, is the server connected, is logging on
  vyre-chrome doctor                              checks the whole path from a terminal and says the one fix
  vyre-chrome report [--last N] [--out FILE]      one redacted bundle of your last N sessions, with a summary
  vyre-chrome config ghl-host <domain> [--remove]  optional: a GoHighLevel domain to always count (white-label domains are recognised automatically)
  vyre-chrome config learn on|off                 learn each site's structure on this computer (default on; never a value)
  vyre-chrome config confirm-sends on|off         ask you before a send and before resuming after Esc (default on)
  vyre-chrome logs on|off|path                    turn the local trace on or off, or print where it is
  vyre-chrome logs values builder|all|none        which typed values a trace keeps (default builder: only on GoHighLevel automation pages)
  vyre-chrome logs shots on|off                   keep a small screenshot of a failure (off by default)
  vyre-chrome mcp                                 the MCP server (Claude Code runs this; you do not)

Logs stay in ${dataDirOf()}/logs and never leave this computer.`;

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  const dataDir = dataDirOf();
  const hostDir = process.env.VYRE_CHROME_HOST_DIR || path.join(PKG, "native-host");
  const extDir = path.join(PKG, "extension");
  const sock = sockPathOf(dataDir);

  if (cmd === "mcp") {
    /** @type {any} */ let runtime;
    try { runtime = await createRuntime({ dataDir, version }); } catch (e) {
      if (/** @type {any} */ (e).code === "vyred_running") { process.stderr.write(`vyre-chrome: ${/** @type {Error} */ (e).message}\n`); process.exit(1); }
      throw e;
    }
    // Never hang on the way out: give the bridge a moment to close, then leave whatever it is doing.
    const stop = async () => { try { await Promise.race([runtime.stop(), new Promise(r => setTimeout(r, 2000))]); } finally { process.exit(0); } };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    await serve({ runtime, stdin: process.stdin, stdout: process.stdout, version, log: m => process.stderr.write(`[vyre-chrome] ${m}\n`) });
    return stop();
  }

  if (cmd === "install") {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dataDir, 0o700); } catch { /* not ours to change */ }
    fs.writeFileSync(path.join(dataDir, MARKER), "vyre-chrome data folder: safe to delete with `vyre-chrome uninstall --purge`\n", { mode: 0o600 });
    // The package runs from a private, read-only copy under the data folder, so nothing that later writes to
    // wherever it was unpacked changes what Chrome and Claude Code run, and moving the download breaks nothing.
    const appDir = process.env.VYRE_CHROME_NO_COPY ? PKG : path.join(dataDir, "app");
    if (appDir !== PKG) { unlock(appDir); fs.rmSync(appDir, { recursive: true, force: true }); fs.cpSync(PKG, appDir, { recursive: true, dereference: false, filter: src => !/(^|\/)(node_modules|\.git)(\/|$)/.test(src) }); }
    const hostDirNow = process.env.VYRE_CHROME_HOST_DIR || path.join(appDir, "native-host");
    const extDirNow = path.join(appDir, "extension");
    let id; try { id = extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(extDirNow, "manifest.json"), "utf8")).key); } catch { throw new Error(`the extension is missing at ${extDirNow}`); }
    fs.writeFileSync(path.join(hostDirNow, "sock-path"), sock);
    const browsers = flag(args, "browsers");
    const r = nativeHost.install({ vyreHome: dataDir, hostDir: hostDirNow, extensionId: id, ...(browsers ? { browsers: /** @type {any} */ (browsers.split(",")) } : {}) });
    if (appDir !== PKG) lock(appDir);
    // The launcher: put `vyre-chrome` on the person's PATH (~/.local/bin), since a login shell often has no node on PATH at all.
    const launcher = ["vyre-chrome", path.join("standalone", "vyre-chrome")].map(f => path.join(appDir, f)).find(f => fs.existsSync(f));
    let linked = null;
    if (launcher && process.platform !== "win32") {
      try {
        const bin = path.join(os.homedir(), ".local", "bin");
        fs.mkdirSync(bin, { recursive: true });
        const link = path.join(bin, "vyre-chrome");
        let mine = true;
        try { const st = fs.lstatSync(link); mine = st.isSymbolicLink() && /vyre-chrome/.test(fs.readlinkSync(link)); } catch { /* not there */ }
        if (mine) { try { fs.unlinkSync(link); } catch { /* not there */ } fs.symlinkSync(launcher, link); linked = { link, onPath: String(process.env.PATH || "").split(path.delimiter).includes(bin) }; }
        else linked = { link, foreign: true };
      } catch { /* a read-only home: the printed steps below still work */ }
    }
    const regd = r.written.map((/** @type {any} */ w) => w.browser);
    const notRegd = Object.keys(nativeHost.BROWSERS).filter(b => nativeHost.available(/** @type {any} */ (b), process.platform) && !regd.includes(b));
    out(`Vyre for Chrome is installed. Registered the connector for: ${regd.join(", ")}.`);
    if (notRegd.length) out(`Not registered (not found on this computer): ${notRegd.join(", ")}. If you use one of them, run: vyre-chrome install --browsers <name>`);
    const open = runningBrowsers().filter(b => regd.some(r => new RegExp(r === "chrome" ? "chrome" : r, "i").test(b.name)));
    if (open.length) out(`${open.map(b => b.name).join(" and ")} ${open.length > 1 ? "are" : "is"} already running (since ${new Date(Math.min(...open.map(b => b.startedAt))).toLocaleString()}). A browser that was open before the connector was registered may not see it until you quit it completely and open it again once. The check at the end tells you whether that is needed.`);
    else out("If your browser is already open, it may need a quit and reopen before it sees the connector. The check at the end tells you.");
    out();
    out(guide(extDirNow, id, r.written.map((/** @type {any} */ w) => w.browser)).split("\n").slice(1, 5).join("\n"));
    out();
    out("Then add it to Claude Code (once):");
    out(`  claude mcp add vyre-chrome -- "${process.execPath}" "${path.join(appDir, "standalone", "cli.mjs")}" mcp`);
    out();
    out("Never put chrome_send or chrome_resume in a Claude Code allow list: they are where you approve. If your Claude Code can show a question from a tool, the server asks you itself before a send, and before it carries on after you pressed Esc. `vyre-chrome config confirm-sends off` turns those questions off.");
    out(`A trace of every session is written to ${path.join(dataDir, "logs")} on this computer only. "vyre-chrome logs off" turns it off.`);
    if (linked && !linked.foreign) {
      out(`The command is now ${linked.link}.`);
      if (!linked.onPath) { out(`~/.local/bin is not on your PATH yet. Add it once: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   (then open a new terminal)`); }
    } else if (launcher) out(`Run it any time as: ${launcher}`);
    out("To update, unpack the new release and run its install again.");
    // The live check: wait for the extension to connect and say so, or say exactly what to do. Skipped with --no-wait, and off a terminal unless --wait N is given.
    const waitFlag = flag(args, "wait");
    const seconds = flag(args, "no-wait") !== undefined ? 0 : waitFlag !== undefined ? Math.max(0, Number(waitFlag) || 60) : process.stdout.isTTY ? 60 : 0;
    if (seconds > 0) {
      out();
      out(`Now load the extension if you have not: ${[...new Set(r.written.map((/** @type {any} */ w) => extensionsPage(w.browser)))].join(" or ")} > Developer mode > Load unpacked > ${extDirNow}`);
      out(`Waiting up to ${seconds} s for it to connect (Ctrl-C to skip)...`);
      const ok = await liveCheck({ dataDir, sock, extensionId: id, seconds, hostRegistered: r.written.length > 0 });
      if (!ok) process.exitCode = 2;
    }
    return;
  }

  if (cmd === "config") {
    if (args[0] === "ghl-host") {
      const cur = readConfig(dataDir).ghlHosts || [];
      if (!args[1]) { out(cur.length ? cur.join("\n") : "No extra GoHighLevel domains. gohighlevel.com and leadconnectorhq.com always count."); return; }
      const h = hostOf(args[1]);
      if (!h) throw new Error(`"${args[1]}" is not a domain`);
      const next = flag(args, "remove") ? cur.filter((/** @type {string} */ x) => x !== h) : [...new Set([...cur, h])];
      writeConfig(dataDir, { ghlHosts: next });
      out(flag(args, "remove") ? `Removed ${h}.` : `Counting ${h} as GoHighLevel.`);
      return;
    }
    if (args[0] === "confirm-sends" && ["on", "off"].includes(args[1])) { writeConfig(dataDir, { confirmSends: args[1] === "on" }); out(`Asking you before a send or a resume is ${args[1]}.`); return; }
    if (args[0] === "learn" && ["on", "off"].includes(args[1])) { writeConfig(dataDir, { learn: args[1] === "on" }); out(`Learning each site's structure is ${args[1]}. It is on unless you turn it off, and it never stores a value.`); return; }
    throw new Error("config: confirm-sends on|off | learn on|off | ghl-host <domain> [--remove]");
  }

  if (cmd === "uninstall") {
    const appDirU = path.join(dataDir, "app");
    const hostDirU = process.env.VYRE_CHROME_HOST_DIR || (fs.existsSync(appDirU) ? path.join(appDirU, "native-host") : hostDir);
    const r = nativeHost.uninstall({ vyreHome: dataDir });
    for (const f of ["sock-path", "node-path"]) { try { fs.unlinkSync(path.join(hostDirU, f)); } catch { /* read-only copy or not there */ } }
    try { const link = path.join(os.homedir(), ".local", "bin", "vyre-chrome"); if (fs.lstatSync(link).isSymbolicLink() && /vyre-chrome/.test(fs.readlinkSync(link))) fs.unlinkSync(link); } catch { /* none */ }
    unlock(appDirU); fs.rmSync(appDirU, { recursive: true, force: true });
    out(`Removed the connector (${(r.removed || []).map((/** @type {any} */ x) => x.browser).join(", ") || "nothing was registered"}).`);
    out("Remove it from Claude Code with: claude mcp remove vyre-chrome");
    out("Remove the extension in chrome://extensions.");
    if (flag(args, "purge")) {
      // Only ever delete a folder this program made, and never a link, the home folder or a root.
      const real = (() => { try { return fs.realpathSync(dataDir); } catch { return dataDir; } })();
      const st = (() => { try { return fs.lstatSync(dataDir); } catch { return null; } })();
      const home = (() => { try { return fs.realpathSync(os.homedir()); } catch { return os.homedir(); } })();
      if (!st) out(`${dataDir} does not exist.`);
      else if (st.isSymbolicLink() || !st.isDirectory()) out(`Not deleting ${dataDir}: it is a link or not a folder.`);
      else if (!fs.existsSync(path.join(dataDir, MARKER))) out(`Not deleting ${dataDir}: it does not hold this program's marker file, so it is not a folder this program made.`);
      else if (real === home || real === path.parse(real).root || home.startsWith(real + path.sep)) out(`Not deleting ${dataDir}: it is your home folder or above it.`);
      else { fs.rmSync(dataDir, { recursive: true, force: true }); out(`Deleted ${dataDir}.`); }
    }
    else out(`Your logs are still in ${path.join(dataDir, "logs")}. "vyre-chrome uninstall --purge" deletes them.`);
    return;
  }

  if (cmd === "doctor") {
    const appDirD = fs.existsSync(path.join(dataDir, "app", "extension")) ? path.join(dataDir, "app") : PKG;
    let extId = "";
    try { extId = extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(appDirD, "extension", "manifest.json"), "utf8")).key); } catch { /* reported as a failed install check */ }
    const r = await doctor({ dataDir, appDir: appDirD, extensionId: extId, selftest: flag(args, "no-selftest") === undefined });
    out(render(r));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  if (cmd === "status") {
    const c = readConfig(dataDir);
    let host; try { host = nativeHost.status({ vyreHome: dataDir, hostDir: fs.existsSync(path.join(dataDir, "app")) ? path.join(dataDir, "app", "native-host") : hostDir }); } catch (e) { host = { error: /** @type {Error} */ (e).message }; }
    /** @type {any} */ let server = null;
    try { server = JSON.parse(fs.readFileSync(path.join(dataDir, "run", "status.json"), "utf8")); } catch { /* no server running */ }
    out(JSON.stringify({ version, dataDir, extensionDir: extDir, logs: c.logs, screenshots: c.shots === true, host, server: server ? { pid: server.pid, connected: server.connected, problem: server.problem, fix: server.fix } : null, hint: "vyre-chrome doctor checks the whole path" }, null, 2));
    return;
  }

  if (cmd === "logs") {
    const sub = args[0];
    if (sub === "on" || sub === "off") { writeConfig(dataDir, { logs: sub }); out(`Logging is ${sub}.`); return; }
    if (sub === "values") { const v = args[1]; if (!["builder", "all", "none"].includes(v)) throw new Error("logs values: builder (default: typed values on GoHighLevel automation pages only), all, or none"); writeConfig(dataDir, { values: v }); out(`Typed values are kept for: ${v}.`); return; }
    if (sub === "shots") { const v = args[1] === "on"; writeConfig(dataDir, { shots: v }); out(`Failure screenshots are ${v ? "on" : "off"}.`); return; }
    if (sub === "path" || sub === undefined) { out(path.join(dataDir, "logs")); return; }
    throw new Error(`logs: unknown "${sub}"`);
  }

  if (cmd === "report") {
    const last = Number(flag(args, "last")) || 5;
    const { summary, bundle } = report(dataDir, { last });
    const file = flag(args, "out") || path.join(dataDir, "reports", `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    out(`Wrote ${file}`);
    out(`${summary.calls} calls in ${summary.sessions.length} session(s), ${summary.failures} failed.`);
    const kinds = Object.entries(summary.failuresByKind).map(([k, n]) => `${k} ${n}`).join(", ");
    if (kinds) out(`Failures by kind: ${kinds}`);
    for (const s of summary.slowest.slice(0, 3)) out(`Slow: ${s.tool} ${s.runMs} ms (waited ${s.waitMs} ms on the page) ${s.host || ""}${s.path || ""}`);
    out(`Selector fallback rate: ${(summary.fallbackRate * 100).toFixed(1)}%`);
    out("The bundle is masked (secrets, emails, phone numbers) and is only on this computer. Send it to whoever is improving this.");
    return;
  }

  if (cmd === "version" || cmd === "--version") { out(version); return; }
  out(HELP);
}

main().catch(e => { process.stderr.write(`vyre-chrome: ${e && e.message || e}\n`); process.exit(1); });
