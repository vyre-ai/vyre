#!/usr/bin/env node
// vyre-chrome: control your own Chrome from Claude Code, with no Vyre server.
//   vyre-chrome install [--browsers chrome,brave]   register the native host, print the extension folder
//   vyre-chrome uninstall [--purge]                 remove the host registration (--purge: also the logs)
//   vyre-chrome mcp                                 the stdio MCP server Claude Code runs
//   vyre-chrome status | report [--last N] [--out F] | logs on|off|path [--shots on|off]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PKG, dataDirOf, sockPathOf, createRuntime } from "./runtime.js";
import { serve } from "./mcp.js";
import { readConfig, writeConfig, report } from "./trace.js";
import * as nativeHost from "../native-host/install.js";
import { extensionIdFromKey } from "../native-host/install.js";
import { guide } from "../index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(PKG, "extension", "manifest.json"), "utf8")).version; } catch { return "0.0.0"; } })();
const out = (/** @type {string} */ s = "") => process.stdout.write(s + "\n");
const flag = (/** @type {string[]} */ a, /** @type {string} */ n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : "true") : undefined; };

const HELP = `vyre-chrome ${version}: control your own Chrome from Claude Code

  vyre-chrome install [--browsers chrome,brave]   register the connector; prints what to do next
  vyre-chrome uninstall [--purge]                 remove the connector (--purge also deletes the logs)
  vyre-chrome status                              is it installed, is logging on
  vyre-chrome report [--last N] [--out FILE]      one redacted bundle of your last N sessions, with a summary
  vyre-chrome logs on|off|path                    turn the local trace on or off, or print where it is
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
    let id; try { id = extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8")).key); } catch { throw new Error(`the extension is missing at ${extDir}`); }
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(hostDir, "sock-path"), sock);
    const browsers = flag(args, "browsers");
    const r = nativeHost.install({ vyreHome: dataDir, hostDir, extensionId: id, ...(browsers ? { browsers: /** @type {any} */ (browsers.split(",")) } : {}) });
    out(`Registered the connector for: ${r.written.map((/** @type {any} */ w) => w.browser).join(", ")}`);
    out();
    out(guide(extDir, id, r.written.map((/** @type {any} */ w) => w.browser)).split("\n").slice(1, 5).join("\n"));
    out();
    out("Then add it to Claude Code (once):");
    out(`  claude mcp add vyre-chrome -- "${process.execPath}" "${path.join(HERE, "cli.mjs")}" mcp`);
    out();
    out("In Claude Code, allow the read and edit tools if you like, and leave chrome_send and chrome_resume on ask: those are where you approve a send, post or payment, or let it carry on after you pressed Esc.");
    out(`A trace of every session is written to ${path.join(dataDir, "logs")} on this computer only. "vyre-chrome logs off" turns it off.`);
    return;
  }

  if (cmd === "uninstall") {
    const r = nativeHost.uninstall({ vyreHome: dataDir });
    for (const f of ["sock-path", "node-path"]) { try { fs.unlinkSync(path.join(hostDir, f)); } catch { /* not there */ } }
    out(`Removed the connector (${(r.removed || []).map((/** @type {any} */ x) => x.browser).join(", ") || "nothing was registered"}).`);
    out("Remove it from Claude Code with: claude mcp remove vyre-chrome");
    out("Remove the extension in chrome://extensions.");
    if (flag(args, "purge")) { fs.rmSync(dataDir, { recursive: true, force: true }); out(`Deleted ${dataDir}.`); }
    else out(`Your logs are still in ${path.join(dataDir, "logs")}. "vyre-chrome uninstall --purge" deletes them.`);
    return;
  }

  if (cmd === "status") {
    const c = readConfig(dataDir);
    let host; try { host = nativeHost.status({ vyreHome: dataDir, hostDir }); } catch (e) { host = { error: /** @type {Error} */ (e).message }; }
    out(JSON.stringify({ version, dataDir, extensionDir: extDir, logs: c.logs, screenshots: c.shots === true, host }, null, 2));
    return;
  }

  if (cmd === "logs") {
    const sub = args[0];
    if (sub === "on" || sub === "off") { writeConfig(dataDir, { logs: sub }); out(`Logging is ${sub}.`); return; }
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
