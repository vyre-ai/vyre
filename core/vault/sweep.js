// @ts-check
// sweep: find where secrets sit in plain text: in a project's files, in its git history, and in
// the shell's history. Two kinds of finding:
//   - a value the vault holds, found somewhere it should not be (named by its item);
//   - a credential the vault does not hold yet, known by its shape (credential-shapes.js: a Stripe key, a
//     GitHub token, a private key block), named by its type and provider.
// A finding is a place (file, line, commit) and a name. Never the value, a slice of it, its length
// or the line around it (ADR 0028). Everything the vault holds is compared in memory; nothing is
// written to disk, so no temporary file of secrets exists for grep to read.
//
// A sweep runs when a person asks for one, never on a timer (principle 8), and stops at the
// limits below rather than walking a whole disk.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { classify, startsLikeCredential, isKnownShape, hasPrivateKey } from "../../lib/credential-shapes.js";
import { SKIP_DIRS } from "./envfiles.js";

/**
 * @typedef {{ file: string, line: number, item?: string, type?: string, provider?: string, commit?: string, also?: number }} Finding
 * @typedef {{ fast: Map<string, string>, slow: [string, string][] }} Values value to item name, split by how they are searched
 */

const MAX_FILE = 2 * 1024 * 1024;
const MIN_VALUE = 10;
/** Characters that split a line into tokens. A value holding one of them is searched as a substring. */
const SEP = /[\s"'`=:,;(){}[\]<>|\\@/?&#]+/;
/** Token shapes worth handing to credential-shapes.js. Anything else is not a known credential shape. */
const SHAPE = { test: (/** @type {string} */ tok) => startsLikeCredential(tok) || isKnownShape(tok) || tok.startsWith("eyJ") };   // lib/credential-shapes.js: a vendor prefix, or a whole shape the table knows

/**
 * The vault's values, ready to search. Short or trivial values are left out: a 6-character
 * password matches too much to mean anything.
 * @param {Iterable<[string, string]>} pairs [value, item name]
 * @returns {Values}
 */
export function prepare(pairs) {
  /** @type {Values} */
  const v = { fast: new Map(), slow: [] };
  for (const [value, name] of pairs) {
    if (typeof value !== "string" || value.length < MIN_VALUE || /^\d+$/.test(value) || /^(true|false|null|undefined|localhost|production|development)$/i.test(value)) continue;
    if (SEP.test(value)) v.slow.push([value, name]);
    else if (!v.fast.has(value)) v.fast.set(value, name);
  }
  return v;
}

/**
 * Findings in one text. `line` is 1-based. A value found by the vault is not reported again as a
 * shape.
 * @param {string} text @param {Values} values @param {string} file
 * @returns {Finding[]}
 */
export function sweepText(text, values, file) {
  /** @type {Finding[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line.length > 100_000) continue;
    /** @type {Set<string>} */
    const seen = new Set();
    for (const tok of line.split(SEP)) {
      if (tok.length < MIN_VALUE) continue;
      const hit = values.fast.get(tok);
      if (hit) { if (!seen.has(hit)) { seen.add(hit); out.push({ file, line: n + 1, item: hit }); } continue; }
      if (tok.length <= 1024 && SHAPE.test(tok)) {
        const c = classify("", tok);
        if (c.secret && c.provider && c.type !== "config") {
          const k = `${c.type}:${c.provider}`;
          if (!seen.has(k)) { seen.add(k); out.push({ file, line: n + 1, type: c.type, provider: c.provider }); }
        }
      }
    }
    for (const [value, name] of values.slow) {
      if (!seen.has(name) && line.includes(value)) { seen.add(name); out.push({ file, line: n + 1, item: name }); }
    }
    if (hasPrivateKey(line) && !seen.has("private-key")) out.push({ file, line: n + 1, type: "private-key" });
  }
  return out;
}

/**
 * Walk a folder (or read one file) and sweep every text file, skipping dependencies, build output,
 * binaries and anything over 2 MB. Symlinks are not followed.
 * @param {string} root @param {Values} values
 * @param {{ depth?: number, limit?: number }} [opts]
 * @returns {{ findings: Finding[], scanned: number, truncated: boolean }}
 */
export function sweepFiles(root, values, { depth = 12, limit = 20_000 } = {}) {
  const abs = path.resolve(root);
  /** @type {Finding[]} */
  const findings = [];
  let scanned = 0, truncated = false;
  /** @param {string} p */
  const one = p => {
    let buf;
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size > MAX_FILE) return;
      buf = fs.readFileSync(p);
    } catch { return; }
    // A NUL in the first 8 KB means a binary file.
    if (buf.subarray(0, 8192).includes(0)) return;
    scanned++;
    findings.push(...sweepText(buf.toString("utf8"), values, p));
  };
  /** @param {string} dir @param {number} d */
  const walk = (dir, d) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of list) {
      if (truncated) return;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (d < depth && !SKIP_DIRS.has(ent.name)) walk(p, d + 1); continue; }
      if (!ent.isFile()) continue;
      if (scanned >= limit) { truncated = true; return; }
      one(p);
    }
  };
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) walk(abs, 0);
  else one(abs);
  return { findings, scanned, truncated };
}

/**
 * Sweep the lines every commit added, on every branch, newest first. One finding per file and
 * item (or shape): the newest commit that has it, and how many more do (`also`).
 * @param {string} dir a folder inside a git work tree
 * @param {Values} values
 * @param {{ maxCommits?: number, maxBytes?: number, git?: string }} [opts]
 * @returns {Promise<{ findings: Finding[], commits: number, truncated: boolean } | null>} null when not a git work tree
 */
export async function sweepHistory(dir, values, { maxCommits = 5000, maxBytes = 200 * 1024 * 1024, git = "git" } = {}) {
  const child = spawn(git, ["-C", dir, "log", "--all", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", `-n${maxCommits}`, "--format=commit %H"],
    { stdio: ["ignore", "pipe", "ignore"] });
  /** @type {Map<string, Finding>} */
  const found = new Map();
  let commit = "", file = "", line = 0, bytes = 0, commits = 0, truncated = false;
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exited = new Promise(resolve => { child.on("close", code => resolve(code)); child.on("error", () => resolve(-1)); });
  for await (const raw of rl) {
    bytes += raw.length + 1;
    if (bytes > maxBytes) { truncated = true; child.kill(); break; }
    if (raw.startsWith("commit ")) { commit = raw.slice(7, 19); commits++; continue; }
    if (raw.startsWith("+++ ")) { file = raw.startsWith("+++ b/") ? raw.slice(6) : ""; continue; }
    if (raw.startsWith("@@")) { const m = /\+(\d+)/.exec(raw); line = m ? Number(m[1]) : 0; continue; }
    if (!raw.startsWith("+") || !file) continue;
    for (const f of sweepText(raw.slice(1), values, file)) {
      const k = `${file}\n${f.item ?? `${f.type}:${f.provider ?? ""}`}`;
      const had = found.get(k);
      if (had) had.also = (had.also ?? 0) + 1;
      else found.set(k, { ...f, line, commit });
    }
    line++;
  }
  const code = await exited;
  if (code !== 0 && !truncated && commits === 0) return null;
  return { findings: [...found.values()], commits, truncated: truncated || commits >= maxCommits };
}

/** The shell history files that exist for this user. @param {string} [home] */
export function shellHistories(home = os.homedir()) {
  return [".zsh_history", ".bash_history", path.join(".local", "share", "fish", "fish_history"), ".history"]
    .map(f => path.join(home, f)).filter(f => { try { return fs.lstatSync(f).isFile(); } catch { return false; } });
}

/** Fields that name or describe rather than unlock: never searched for. */
const NOT_SECRET = new Set(["username", "account", "ssid", "holder", "name", "email", "filename", "type", "country", "expiry", "security",
  "company", "city", "region", "postal", "line1", "line2", "phone", "rp_id", "user_name", "credential_id", "user_handle", "sign_count",
  "certificate", "chain", "issued", "birthdate", "client_id", "tenant_id", "account_sid", "sid"]);

/**
 * vault.sweep: open every item, then look in the folder (and its git history, and the shell's
 * history when asked) for its values and for credential shapes. Places and names only.
 * @param {import("./vault.js").Vault} vault
 * @param {{ path: string, history?: boolean, shell?: boolean }} input
 * @param {string} caller
 * @param {{ home?: string, git?: string }} [env]
 */
export async function sweep(vault, { path: where, history = false, shell = false }, caller, env = {}) {
  const root = path.resolve(String(where || ""));
  if (!where || !fs.existsSync(root)) throw new Error(`${root} does not exist`);
  await vault.key();
  const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
  /** @type {[string, string][]} */
  const pairs = [];
  for (const r of /** @type {any[]} */ (vault.db.prepare("SELECT * FROM vault_items").all())) {
    if (!vault.rowOk("vault_items", r)) continue;
    let f;
    try { f = await vault.fields(r); } catch (e) { if (/** @type {any} */ (e).code === "locked") throw e; continue; }
    for (const [k, v] of Object.entries(f)) if (typeof v === "string" && (r.kind === "env-set" || !NOT_SECRET.has(k))) pairs.push([v, String(r.name)]);
  }
  const values = prepare(pairs);
  pairs.length = 0;
  const isDir = fs.lstatSync(root).isDirectory();
  const files = sweepFiles(root, values);
  const rel = f => (isDir ? path.relative(root, f) : path.basename(f)) || path.basename(f);
  /** @type {Record<string, any>} */
  const out = { root, findings: files.findings.map(f => ({ ...f, file: rel(f.file), where: "file" })), scanned: files.scanned };
  if (files.truncated) out.truncated = true;
  if (history && isDir) {
    const h = await sweepHistory(root, values, env.git ? { git: env.git } : {});
    if (h) { out.findings.push(...h.findings.map(f => ({ ...f, where: "history" }))); out.commits = h.commits; if (h.truncated) out.truncated = true; }
    else out.history = "not a git repository";
  }
  if (shell) {
    const hs = shellHistories(env.home);
    for (const f of hs) out.findings.push(...sweepFiles(f, values).findings.map(x => ({ ...x, file: `~/${path.relative(env.home || os.homedir(), f)}`, where: "shell" })));
    out.shell = hs.length;
  }
  const inVault = out.findings.filter(f => f.item).length;
  vault.audit("sweep", null, caller, true, `${out.findings.length} found (${inVault} vault values, ${out.findings.length - inVault} unknown credentials) in ${out.scanned} files${out.commits ? `, ${out.commits} commits` : ""}`);
  return out;
}
