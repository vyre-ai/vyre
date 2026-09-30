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
import * as nativeHost from "../native-host/install.js";
import { extensionIdFromKey } from "../native-host/install.js";
import { guide } from "../index.js";

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

const HELP = `Vyre for Chrome ${version} (vyre-chrome): control your own Chrome from Claude Code

  vyre-chrome install [--browsers chrome,brave]   register the connector; prints what to do next
  vyre-chrome uninstall [--purge]                 remove the connector (--purge also deletes the logs)
  vyre-chrome status                              is it installed, is logging on
  vyre-chrome report [--last N] [--out FILE]      one redacted bundle of your last N sessions, with a summary
  vyre-chrome config ghl-host <domain> [--remove]  optional: a GoHighLevel domain to always count (white-label domains are recognised automatically)
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
    const runtime = await createRuntime({ dataDir, version });
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
    out(`Vyre for Chrome is installed. Registered the connector for: ${r.written.map((/** @type {any} */ w) => w.browser).join(", ")}`);
    out();
    out(guide(extDirNow, id, r.written.map((/** @type {any} */ w) => w.browser)).split("\n").slice(1, 5).join("\n"));
    out();
    out("Then add it to Claude Code (once):");
    out(`  claude mcp add vyre-chrome -- "${process.execPath}" "${path.join(appDir, "standalone", "cli.mjs")}" mcp`);
    out();
    out("Never put chrome_send or chrome_resume in a Claude Code allow list: they are where you approve. If your Claude Code can show a question from a tool, the server asks you itself before a send, and before it carries on after you pressed Esc. `vyre-chrome config confirm-sends off` turns those questions off.");
    out(`A trace of every session is written to ${path.join(dataDir, "logs")} on this computer only. "vyre-chrome logs off" turns it off.`);
    out("To update, unpack the new release and run its install again.");
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
    throw new Error("config: confirm-sends on|off | ghl-host <domain> [--remove]");
  }

  if (cmd === "uninstall") {
    const appDirU = path.join(dataDir, "app");
    const hostDirU = process.env.VYRE_CHROME_HOST_DIR || (fs.existsSync(appDirU) ? path.join(appDirU, "native-host") : hostDir);
    const r = nativeHost.uninstall({ vyreHome: dataDir });
    for (const f of ["sock-path", "node-path"]) { try { fs.unlinkSync(path.join(hostDirU, f)); } catch { /* read-only copy or not there */ } }
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

  if (cmd === "status") {
    const c = readConfig(dataDir);
    let host; try { host = nativeHost.status({ vyreHome: dataDir, hostDir: fs.existsSync(path.join(dataDir, "app")) ? path.join(dataDir, "app", "native-host") : hostDir }); } catch (e) { host = { error: /** @type {Error} */ (e).message }; }
    out(JSON.stringify({ version, dataDir, extensionDir: extDir, logs: c.logs, screenshots: c.shots === true, host }, null, 2));
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
