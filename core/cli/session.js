// @ts-check
// The regular `vyre` in SESSION MODE (VYRE_SOCKET and VYRE_THREAD set, as in a session Vyre started): bin/vyre and core/cli/index.js hand the whole command line to run() below before anything else loads,
// so the CLI's own local and human commands (update, up, down, setup, vault, grants, keys, anything that reads VYRE_HOME or touches docker or systemd) are refused before they run. Three verbs work:
//
//   vyre tools find "<words>"         the tools that fit what you are about to do, each with a ready call
//   vyre tools describe <tool>        what one tool does and the input it takes
//   vyre call <tool> '<json>'         run one tool you may use
//
// It is a client of the session's OWN socket (VYRE_SOCKET, core/daemon/threadsock.js): vyred binds the caller there (mcp:thread:<id>, mcp:agent:<name>), checks the connecting process belongs to the
// session, carries the session's own kernel token and refuses every person-only and human-only tool. The CLI never reads the person's session file, never opens vyred's own socket, never reads
// Vyre's home, and never says who it is: the same registry path as a call made through Vyre's MCP server (harness/mcp/server.js), so the one-yes floor, the Gate that holds a send and the
// agent-reach lists judge it identically. The daemon stays the security boundary; the refusals here are a convenience. Output is short plain text for a model. The shim that puts bin/vyre first on a
// sandboxed session's PATH is bin/session/vyre.

import { request } from "../daemon/client.js";
import { PERSON_ONLY, HUMAN_ONLY } from "../presence/index.js";
import { canonical } from "../../lib/tool-names.js";
import { catalogOf, indexOf, find, shapeFind } from "../../harness/mcp/core-tools.js";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import path from "node:path";
import { Scrubber, runKeys, openRun } from "../vault/cli-io.js";

const MAX_INPUT = 64 * 1024;
const MAX_OUT = 20_000;
const TOOL = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const USAGE = `vyre tools find "<words>"      find the tool for what you want to do
vyre tools describe <tool>   what a tool does and what it needs
vyre call <tool> '<json>'    run a tool (a send is held for the person's approval)
vyre vault run --item "<name>" -- <command>   run a command with a Vault item the person allowed in scripts`;
const DRIVES = /^(threads|agents)\./;

/** Is this process a session Vyre started? The same pair the client uses to talk on the session\'s own socket. @param {Record<string, string | undefined>} [env] */
export const inSession = (env = process.env) => Boolean(env.VYRE_SOCKET && env.VYRE_THREAD);

/** The identity this process calls under: the session's own socket binds it, so the label is only the form the daemon expects. @param {Record<string, string | undefined>} env */
const callerOf = env => (env.VYRE_AGENT ? `mcp:agent:${env.VYRE_AGENT}` : "mcp");

/** What the session may be offered, as the MCP server offers it. @param {Record<string, string | undefined>} env @param {{ name: string }} t */
const offered = (env, t) => !t.name.startsWith("harness.") && !PERSON_ONLY.has(t.name) && !HUMAN_ONLY.has(t.name) && !(env.VYRE_AGENT && env.VYRE_AGENT_KIND !== "assistant" && DRIVES.test(t.name));

/** @param {any} s */
const clip = s => { const t = typeof s === "string" ? s : JSON.stringify(s, null, 2); return t.length > MAX_OUT ? `${t.slice(0, MAX_OUT)}\n... ${t.length - MAX_OUT} more characters: ask for less (a narrower call, a limit).` : t; };

/** One input property in a line. @param {string} name @param {any} p @param {boolean} req */
const field = (name, p, req) => `  ${name}${req ? " (required)" : ""}: ${p && p.type ? [].concat(p.type).join("|") : "any"}${p && p.description ? ` - ${String(p.description).replace(/\s+/g, " ").slice(0, 160)}` : ""}`;

/**
 * Run one command line. Pure over its ports so a test drives it without a socket.
 * @param {string[]} argv @param {{ env?: Record<string, string | undefined>, request?: typeof request, out?: (s: string) => void, err?: (s: string) => void }} [d]
 * @returns {Promise<number>} the exit code: 0 done, 1 refused or failed, 2 not understood
 */
export async function run(argv, d = {}) {
  const env = d.env || process.env, out = d.out || (s => process.stdout.write(s + "\n")), err = d.err || (s => process.stderr.write(s + "\n"));
  const req = d.request || request;
  const ident = { caller: callerOf(env), timeout: 120_000 };
  if (!env.VYRE_SOCKET) { err("vyre: this is not a Vyre session, so there is nothing to reach."); return 1; }
  const usage = () => { err(`vyre: say what you want.\n${USAGE}`); return 2; };
  const [a, b, ...rest] = argv;
  if (a === "vault" && b === "run") return vaultRun(rest, { req, ident, err });

  const catalog = async () => {
    const r = await req("GET", "/v1/tools", undefined, ident);
    if (r.error) throw Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code });
    return catalogOf(r.data.filter(/** @param {any} t */ t => offered(env, t)));
  };

  try {
    if (a === "tools" && b === "find") {
      const query = rest.join(" ").trim();
      if (!query || rest.length < 1) return usage();
      if (query.length > 300) { err("vyre: the words are too long (300 characters at most)."); return 2; }
      const cat = await catalog();
      const found = find(indexOf(cat), query, 5);
      const byName = new Map(cat.map(c => [c.name, c]));
      const shaped = shapeFind(found, n => (byName.get(n) || {}).input);
      const lines = [];
      // the index speaks MCP names (comms_send); a shell calls the tool by its own name (comms.send)
      const real = (/** @type {string} */ n) => (byName.get(n) || { tool: n }).tool;
      for (const t of shaped.tools) lines.push(`${real(t.name)}: ${t.description}\n  call: vyre call ${real(t.call.arguments.tool)} '${JSON.stringify(t.call.arguments.arguments || {})}'`);
      for (const t of shaped.also || []) lines.push(`${real(t.name)}: ${t.description}${t.needs ? ` (needs ${t.needs.join(", ")})` : ""}`);
      if (shaped.unsure) lines.push(shaped.unsure);
      if (!shaped.tools.length) lines.push(`Nothing fits "${query}". Try other words, or: vyre call vyre_core '{}' for the map of Vyre's modules.`);
      out(lines.join("\n"));
      return 0;
    }
    if (a === "tools" && b === "describe") {
      const name = rest[0];
      if (!name || rest.length !== 1 || !TOOL.test(name)) return usage();
      const cat = await catalog();
      const hit = cat.find(c => c.tool === name || c.name === name);
      if (!hit) { err(`vyre: no tool ${name} that you may use. Find it with: vyre tools find "<words>"`); return 1; }
      const props = (hit.input && hit.input.properties) || {}, need = new Set((hit.input && hit.input.required) || []);
      out([`${hit.tool}: ${hit.description}`, ...Object.keys(props).slice(0, 40).map(k => field(k, props[k], need.has(k))), Object.keys(props).length ? "" : "  (no input)", `call: vyre call ${hit.tool} '<json of the input above>'`].join("\n").trim());
      return 0;
    }
    if (a === "call") {
      const name = b && TOOL.test(b) ? canonical(b) : b;
      if (!name || !TOOL.test(name) || rest.length > 1) return usage();
      const text = rest[0] === undefined ? "{}" : rest[0];
      if (Buffer.byteLength(text) > MAX_INPUT) { err(`vyre: the input is longer than ${MAX_INPUT / 1024} KB.`); return 2; }
      let input; try { input = JSON.parse(text); } catch { err("vyre: the input is not JSON. Write one object, for example '{\"to\":\"x@y.com\"}'."); return 2; }
      if (!input || typeof input !== "object" || Array.isArray(input)) { err("vyre: the input is one JSON object."); return 2; }
      if (name.startsWith("harness.") || PERSON_ONLY.has(name) || HUMAN_ONLY.has(name)) { err(`vyre: ${name} is the person's own; ask them to do it in Vyre.`); return 1; }
      if (name === "vault.use.env") { err(`vyre: ${name} answers only vyre vault run: vyre vault run --item "<name>" -- <command>`); return 2; }
      const r = await req("POST", "/v1/tools/" + encodeURIComponent(name), input, ident);
      if (r.error) { err(`${r.error.code}: ${r.error.message}`); return 1; }
      const data = r.data;
      if (data && typeof data === "object" && data.held) { out(`${data.message || "Held for the person's approval in Vyre."} (item ${data.held}; nothing has been sent.)`); return 0; }
      out(clip(data === undefined ? "done" : data));
      return 0;
    }
  } catch (e) {
    err(`vyre: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  if (a === undefined || a === "help" || a === "--help" || a === "-h") { out(`vyre, inside a session: four commands.\n${USAGE}`); return a === undefined ? 2 : 0; }
  if (a === "version" || a === "--version" || a === "-v") { out((await import("../daemon/index.js")).VERSION); return 0; }
  if (a === "tools" || a === "call") return usage();
  err(`vyre ${a}: not available inside a session. Find the tool for what you want: vyre tools find "<words>"`);
  return 2;
}

/**
 * `vyre vault run --item "<name>" [--item "<name>"] -- <command...>`: run one program with Vault items in its environment, each field under its canonical name (NORTHWIND_API_KEY). Only an item the
 * person marked Allowed in scripts, and only one this session's agent may use: the daemon decides (vault.use.env). The values come sealed to a key made here for this one run, so no tool result
 * carries them, and the program's output is shown with every secret hidden as [hidden: NAME], in its encoded forms too. The program itself can read them: that is what the setting allows.
 * @param {string[]} args @param {{ req: typeof request, ident: any, err: (s: string) => void, spawnFn?: typeof spawn, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} o
 * @returns {Promise<number>}
 */
export async function vaultRun(args, { req, ident, err, spawnFn = spawn, stdout = process.stdout, stderr = process.stderr }) {
  const usage = 'vyre vault run --item "<name>" -- <command...>';
  const at = args.indexOf("--");
  if (at < 0) { err(`vyre: put -- before the command: ${usage}`); return 2; }
  const left = args.slice(0, at), cmd = args.slice(at + 1), items = [];
  for (let i = 0; i < left.length; i++) {
    const x = left[i];
    if (x === "--item" && typeof left[i + 1] === "string" && left[i + 1]) items.push(left[++i]);
    else if (x.startsWith("--item=") && x.length > 7) items.push(x.slice(7));
    else { err(`vyre: name each item with --item: ${usage}`); return 2; }
  }
  if (!items.length || !cmd.length) { err(`vyre: ${usage}`); return 2; }
  const box = runKeys().box;
  const r = await req("POST", "/v1/tools/vault.use.env", { items, key: box.public, command: path.basename(cmd[0]) }, ident);
  if (r.error) { err(`${r.error.code}: ${r.error.message}`); return 1; }
  /** @type {{ env?: Record<string, string>, hidden?: string[] }} */ let opened;
  try { opened = openRun(box.private, r.data && r.data.box, "vault-run", "vault-run"); } catch { err("vyre: the Vault's answer could not be opened, so nothing ran"); return 1; }
  const env = opened.env || {}, hidden = new Set(opened.hidden || []);
  const values = Object.entries(env).filter(([k]) => hidden.has(k)).map(([k, v]) => ({ value: String(v), mark: `[hidden: ${k}]` }));
  const child = spawnFn(cmd[0], cmd.slice(1), { env: { ...process.env, ...env }, stdio: ["inherit", "pipe", "pipe"] });
  const so = new Scrubber(values), se = new Scrubber(values);
  /** @type {any} */ (child.stdout).pipe(so).pipe(stdout, { end: false });
  /** @type {any} */ (child.stderr).pipe(se).pipe(stderr, { end: false });
  const code = await new Promise(resolve => {
    child.on("error", (/** @type {any} */ e) => { err(e && e.code === "ENOENT" ? `vyre: ${cmd[0]}: command not found` : `vyre: ${e && e.message}`); resolve(e && e.code === "ENOENT" ? 127 : 126); });
    child.on("close", (/** @type {number | null} */ c, /** @type {string | null} */ sig) => resolve(c ?? (sig ? 128 : 1)));
  });
  await Promise.all([finished(so).catch(() => {}), finished(se).catch(() => {})]);
  values.length = 0;
  return /** @type {number} */ (code);
}
