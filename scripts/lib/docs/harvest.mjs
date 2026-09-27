#!/usr/bin/env node
// @ts-check
// harvest: the worker behind scripts/gen-docs-reference. Run as a child process with a throwaway
// VYRE_HOME and HOME; never run it by hand against a real home.
//
// It loads every module the way vyred does, but hands each one a context whose `tool` only
// records the definition, whose `call` answers "no such tool", and whose events go nowhere. Each
// module starts twice, once as the box and once as the Mac, because some register different tools
// for each role (link). Nothing a module starts is allowed to reach outside this process: child
// processes throw, fetch rejects, and a listening socket is refused. Every start has a timeout, and the process exits when done, so a timer or file watcher a module
// leaves behind cannot keep it alive.
//
// It also reads the CLI's command list from core/cli, which is data, not help text.
//
//   node harvest.mjs <repo> <out.json>

import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, outFile] = process.argv.slice(2);
if (!repo || !outFile) { console.error("usage: harvest.mjs <repo> <out.json>"); process.exit(2); }
if (!process.env.VYRE_HOME || !process.env.VYRE_HOME.startsWith(String(process.env.HOME))) {
  console.error("harvest: needs a temporary VYRE_HOME inside a temporary HOME");
  process.exit(2);
}

const START_TIMEOUT_MS = 5000;
const blocked = [];
const refuse = what => (...args) => { blocked.push(`${what} ${String(args[0]).slice(0, 60)}`); throw new Error(`docs harvest: ${what} is not allowed`); };
for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  /** @type {any} */ (childProcess)[fn] = refuse(fn);
}
syncBuiltinESMExports();
net.Server.prototype.listen = function (...args) { blocked.push(`listen ${JSON.stringify(args[0] ?? null).slice(0, 60)}`); throw new Error("docs harvest: listening is not allowed"); };
globalThis.fetch = async url => { blocked.push(`fetch ${String(url).slice(0, 60)}`); throw new Error("docs harvest: fetch is not allowed"); };

const { discover, Registry } = await import(pathToFileURL(path.join(repo, "core/modules/index.js")).href);
const config = await import(pathToFileURL(path.join(repo, "core/config/index.js")).href);
const store = await import(pathToFileURL(path.join(repo, "core/store/index.js")).href);
const { commands } = await import(pathToFileURL(path.join(repo, "core/cli/index.js")).href);

const found = discover(["core", "local", "modules"].map(d => path.join(repo, d)));
const events = { emit: () => ({ id: 0 }), on: () => () => {}, since: () => [], prune: () => 0 };

/** @param {any} def */
const record = (name, def) => ({
  name,
  description: typeof def.description === "string" ? def.description : "",
  input: def.input || null,
  callers: Array.isArray(def.callers) ? [...def.callers] : null,
  internal: Boolean(def.internal),
  hook: Boolean(def.hook),
  presence: Boolean(def.presence),
});

/** @param {"box" | "local"} role */
async function harvest(role) {
  const home = path.join(String(process.env.VYRE_HOME), role);
  fs.mkdirSync(home, { recursive: true });
  const p = config.paths(home);
  config.ensure(home);
  const db = store.open(p.db);
  // The keychain is never touched: a file keystore in the temp home.
  const cfg = { ...config.load(home), role, vault: { keystore: "file" } };
  delete cfg.problems;
  const registry = new Registry({ db, events, config: cfg, paths: p, log: () => {}, handler: () => async () => {} });
  registry.call = async () => ({ error: { code: "no_such_tool", message: "not available while building the docs" } });
  /** @type {Record<string, { tools: any[], error: string | null }>} */
  const out = {};
  for (const f of found) {
    const m = f.manifest;
    if (!m || f.problems.length) continue;
    const tools = [];
    const ctx = registry.context(m);
    ctx.tool = (name, def) => { tools.push(record(name, def || {})); };
    let error = null, timer;
    try {
      const mod = (await import(pathToFileURL(path.join(f.dir, m.main || "index.js")).href)).default;
      const handle = await Promise.race([
        mod.start(ctx),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("start timed out")), START_TIMEOUT_MS); }),
      ]);
      try { await Promise.race([handle?.stop?.(), new Promise(r => setTimeout(r, 1000))]); } catch {}
    } catch (e) { error = /** @type {Error} */ (e).message; }
    finally { clearTimeout(timer); }
    out[m.name] = { tools, error };
  }
  return out;
}

const result = { box: await harvest("box"), local: await harvest("local"), commands: [], blocked };
result.commands = (await commands()).filter(c => !c.secret).map(c => ({
  name: c.name, aliases: c.aliases || [], summary: c.summary || "", usage: c.usage || "",
  order: c.order ?? 50, hidden: Boolean(c.hidden), help: typeof c.help === "string" ? c.help : "",
}));
// Descriptions sometimes carry a path under the temp home; the page shows it as ~.
const text = JSON.stringify(result, null, 1).split(String(process.env.HOME)).join("~");
fs.writeFileSync(outFile, text);
process.exit(0);
