// @ts-check
// `vyre vault` — the Vault from the terminal (docs/adr/0001-vault-crypto.md).
//
// The terminal is the one place a person types a value, so this file is built around keeping
// that value off every screen and out of every history. Values are never taken on the command
// line, where shell history, `ps` and Claude's transcript would all see them: `put` prompts
// without echo, or reads piped stdin. Nothing here prints a value except the two things a person
// asked for in their own terminal: a TOTP code and a freshly generated password with no name.
//
// `run` is the path for scripts outside Vyre. It asks vyred for the values, gives them to one
// child's environment, and scrubs them from its output, so a stray `console.log(process.env)`
// shows `<concealed by vyre>` instead of a key. It prints nothing of its own on success, so it
// can sit in front of any command without changing that command's output.

import { callAsPerson } from "../presence.js";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { dialogsAllowed } from "../../config/dialogs.js";
import { finished } from "node:stream/promises";
import os from "node:os";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import fs from "node:fs";
import { hiddenPrompt, visiblePrompt, Scrubber, parseRunArgs, flags } from "../../vault/cli-io.js";
import { inspect } from "../../vault/backup.js";
import { templateRefs, render, parseEnvFile, parseRef } from "../../vault/refs.js";
import { KINDS as VAULT_KINDS, defaultField as defaultFieldOf } from "../../vault/kinds.js";
import { setupPlan, addAllowedSigner, findPrivateKeys } from "../../vault/ssh/setup.js";

// --json, on every command: the tool's own `{"data":...}` or `{"error":{code,message}}` as one
// line on stdout and nothing else there. Exit codes: 0 ok, 1 error, 3 presence refused or
// required, 4 the vault is locked. `run` keeps its child's output and exit code, and never
// prints the values it injected, in either mode.
let JSON_MODE = false;
/** The last reply from vyred, and whether --json has already printed a line for this command. */
let last = /** @type {any} */ (null);
let printed = false;
const say = (/** @type {string} */ s) => { if (!JSON_MODE) out(s); };
const hint = (/** @type {string} */ s) => { if (!JSON_MODE) process.stderr.write(s); };
const jsonLine = obj => { if (!printed) { process.stdout.write(JSON.stringify(obj) + "\n"); printed = true; } };

/**
 * Every call to vyred goes through here, so --json can print the reply the command acted on. A
 * tool that needs the person (put, grant, reveal, copy and the rest) asks for their proof at this
 * terminal, as `vyre learn` does; a tool that does not answers the first call as before.
 */
async function tool(name, input = {}, opts) {
  const r = await callAsPerson(name, input, { timeout: opts && opts.timeout });
  last = r;
  return r;
}

const PRESENCE = new Set(["presence_required", "presence_refused", "presence_denied", "no_terminal"]);
/** The exit code for a reply: 3 when a person must prove presence, 4 when the vault is locked. */
export function exitFor(r) {
  if (!r || !r.error) return 0;
  if (PRESENCE.has(r.error.code)) return 3;
  if (r.error.code === "locked" || /vault is locked|, which is locked|has no passphrase yet/.test(String(r.error.message || ""))) return 4;
  return 1;
}

const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => {
  last = r;
  if (JSON_MODE) jsonLine({ error: r.error });
  else if (r.error.code === "no_such_tool") out(beacon(`  this vyred has no ${String(r.error.message || "").replace(/^no tool /, "") || "such tool"} yet `) + dim("· update Vyre and run vyre restart"));
  else out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message);
  return exitFor(r);
};
const oops = msg => {
  if (JSON_MODE) jsonLine({ error: { code: "bad_input", message: msg } });
  else out(beacon(`  ${msg}`));
  return 1;
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : w.endsWith("s") ? "es" : "s"}`;
// Kinds, and the field each hands over, come from the vault so the two never disagree.
const KINDS = [...VAULT_KINDS];

/** An origin from a url a person typed, which may lack the scheme. */
function origin(url) {
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "https://" + url).origin; } catch { return null; }
}

const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

const grantText = g => g.module + (g.watcher ? `/${g.watcher}` : "");

// ------------------------------------------------------------ list

/** What a typed item's details say, in list words. Never a value. */
const detailWords = d => !d ? [] : [
  d.provider, d.issuer, d.ssid && `network ${d.ssid}`, d.product, d.filename,
  d.scope && d.scope.length && `scope ${d.scope.join(", ")}`, Number.isInteger(d.count) && `${d.count} codes`,
  d.expires && d.expires - Date.now() >= 14 * 86400_000 && `until ${day(d.expires)}`,
];

async function list(args) {
  let f;
  try { f = flags(args, { string: ["kind", "host"] }); } catch (e) { return oops(e.message); }
  const filter = f._.join(" ").trim();
  const r = await tool("vault.list", { ...(filter ? { filter } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.host ? { host: f.host } : {}) });
  if (r.error) return fail(r);
  const { locked, items = [] } = r.data;
  if (locked) say(beacon("  the vault is locked ") + dim("· vyre vault unlock"));
  if (!items.length) {
    say(dim(filter || f.kind || f.host ? "  nothing in the vault matches" : "  the vault is empty · vyre vault add <name>"));
    return 0;
  }
  say("");
  for (const it of items) {
    say(`  ${bold(it.name)}  ${dim(it.kind)}${it.rotate ? "  " + beacon("rotate") : ""}${it.stale ? "  " + beacon("stale") : ""}`);
    if (it.description) say(`    ${it.description}`);
    const meta = [
      it.fields?.length && "fields " + it.fields.join(", "),
      it.url && it.url,
      it.hosts?.length && "hosts " + it.hosts.join(", "),
      it.ssh && it.ssh.fingerprint,
      it.origin && "from " + it.origin,
      ...detailWords(it.details),
    ].filter(Boolean);
    if (meta.length) say(dim(`    ${meta.join(" · ")}`));
    const ends = it.details && it.details.expires;
    if (ends && ends - Date.now() < 14 * 86400_000) say(beacon(`    ${ends <= Date.now() ? "expired" : "expires"} ${day(ends)}`));
    if (it.grants?.length) say(dim(`    granted to ${it.grants.map(grantText).join(", ")}`));
  }
  say("");
  return 0;
}

// ------------------------------------------------------------ get, read, edit

/** One item's metadata, as `get` prints it. */
function showItem(it) {
  say("");
  say(`  ${bold(it.name)}  ${dim(it.kind)}${it.rotate ? "  " + beacon("rotate") : ""}${it.stale ? "  " + beacon("stale") : ""}`);
  if (it.description) say(`    ${it.description}`);
  if (it.fields?.length) say(`    fields    ${it.fields.join(", ")}${it.otp ? dim("  · --otp for the code") : ""}`);
  if (it.url) say(`    url       ${it.url}`);
  if (it.hosts?.length) say(`    hosts     ${it.hosts.join(", ")}`);
  if (it.ssh) { say(`    key       ${it.ssh.type} ${it.ssh.fingerprint}`); say(dim(`    ${it.ssh.public}`)); }
  if (it.grants?.length) say(`    granted   ${it.grants.map(grantText).join(", ")}`);
  if (it.origin) say(dim(`    from ${it.origin}`));
  if (it.stale) say(beacon(`    ${it.staleWhy || "marked stale"}`));
  if (it.updated) say(dim(`    updated ${day(it.updated)}`));
  say("");
}

const missingSurface = (r, verb) => r.error && r.error.code === "no_such_tool" && !JSON_MODE
  ? oops(`this vyred cannot ${verb} yet: vault.${verb} arrives with the vault's surfaces · vyre vault read vault://<item>/<field> prints one field meanwhile`) : null;

async function get(args) {
  let f;
  try { f = flags(args, { string: ["field"], boolean: ["reveal", "copy", "otp"] }); } catch (e) { return oops(e.message); }
  const name = f._[0];
  if (!name || f._.length > 1) return oops("vyre vault get <item> [--reveal | --copy | --otp] [--field f]");
  if ([f.reveal, f.copy, f.otp].filter(Boolean).length > 1) return oops("choose one of --reveal, --copy and --otp");
  const field = f.field ? { field: f.field } : {};
  if (f.otp) return totp([name]);
  if (f.reveal) {
    const r = await tool("vault.reveal", { name, ...field });
    if (r.error) return missingSurface(r, "reveal") ?? fail(r);
    const d = r.data || {};
    if (typeof d.value === "string") say(d.value);
    else for (const [k, v] of Object.entries(d.fields || {})) say(`  ${k}: ${v}`);
    return 0;
  }
  if (f.copy) {
    const r = await tool("vault.copy", { name, ...field });
    if (r.error) return missingSurface(r, "copy") ?? fail(r);
    const secs = r.data && r.data.clearsAt ? Math.max(0, Math.round((r.data.clearsAt - Date.now()) / 1000)) : null;
    say(`  ${signal("copied")} ${bold(name)}${f.field ? "." + f.field : ""}${secs !== null ? dim(` · the clipboard clears in ${secs}s`) : ""}`);
    return 0;
  }
  const r = await tool("vault.item", { name });
  if (r.error) return fail(r);
  if (f.field && !(r.data.item.fields || []).includes(f.field) && !(f.field === "otp" && r.data.item.otp)) return oops(`${name} has no field ${f.field}`);
  showItem(r.data.item);
  return 0;
}

/** `read vault://item/field`: the value alone on stdout, for $(...) and pipes. */
async function read(args) {
  let f;
  try { f = flags(args, { boolean: ["no-newline"] }); } catch (e) { return oops(e.message); }
  if (f._.length !== 1) return oops("vyre vault read vault://<item>/<field>  (vault://<item>/otp is the current code)");
  try { parseRef(f._[0]); } catch (e) { return oops(e.message); }
  const r = await tool("vault.resolve", { refs: [f._[0]], destination: "the terminal" });
  if (r.error) return fail(r);
  if (!JSON_MODE) {
    const v = Object.values(r.data.values || {})[0] ?? "";
    process.stdout.write(v + (f["no-newline"] ? "" : "\n"));
  }
  return 0;
}

async function edit(args) {
  let f;
  try { f = flags(args, { string: ["rename", "description", "url"], list: ["host", "field", "remove-field"] }); } catch (e) { return oops(e.message); }
  const name = f._[0];
  if (!name || f._.length > 1) return oops("vyre vault edit <item> [--rename n] [--description d] [--url u] [--host +h|-h ...] [--field F ...] [--remove-field F ...]");
  /** @type {Record<string, any>} */
  const input = { name };
  for (const k of ["rename", "description", "url"]) if (f[k] !== undefined) input[k] = f[k];
  const add = f.host.filter(h => !h.startsWith("-")).map(h => origin(h.replace(/^\+/, "")));
  const drop = f.host.filter(h => h.startsWith("-")).map(h => origin(h.slice(1)));
  if ([...add, ...drop].includes(null)) return oops("--host takes +https://host to add or -https://host to remove");
  if (add.length) input.addHosts = add;
  if (drop.length) input.removeHosts = drop;
  if (f["remove-field"].length) input.removeFields = f["remove-field"];
  if (f.field.length) {
    if (!process.stdin.isTTY && f.field.length > 1) return oops("with piped input, replace one --field at a time");
    /** @type {Record<string, string>} */
    const fields = {};
    try {
      for (const k of f.field) { const v = await hiddenPrompt(`new ${k}: `); if (!v) return oops(`no ${k} given, nothing changed`); fields[k] = v; }
    } catch (e) { return oops(e.message === "cancelled" ? "cancelled, nothing changed" : e.message); }
    input.fields = fields;
  }
  if (Object.keys(input).length === 1) return oops("nothing to change · see vyre vault help");
  const r = await tool("vault.edit", input);
  if (input.fields) for (const k of Object.keys(input.fields)) input.fields[k] = "";
  if (r.error) return fail(r);
  say(`  ${signal("updated")} ${bold(r.data.name)}${r.data.renamedFrom ? dim(` · was ${r.data.renamedFrom}`) : ""}`);
  return 0;
}

// ------------------------------------------------------------ inject

/** `inject -i tpl [-o out] [--force] [--reveal]`: with -o, vyred writes the file itself. */
async function inject(args) {
  let i, o, force = false, reveal = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-i" || a === "--in") i = args[++k];
    else if (a === "-o" || a === "--out") o = args[++k];
    else if (a === "--force" || a === "-f") force = true;
    else if (a === "--reveal") reveal = true;
    else return oops(`vyre vault inject -i <template> [-o <out>] [--force] [--reveal] · unknown ${a}`);
  }
  if (!i) return oops("vyre vault inject -i <template> [-o <out>] [--force]");
  let template;
  try { template = fs.readFileSync(i === "-" ? 0 : path.resolve(i), "utf8"); } catch (e) { return oops(`cannot read ${i}: ${e.message}`); }
  let refs;
  try { refs = templateRefs(template); } catch (e) { return oops(e.message); }
  if (o) {
    const r = await tool("vault.render", { template, out: path.resolve(o), ...(force ? { force: true } : {}) });
    if (r.error) return fail(r);
    say(`  ${signal("wrote")} ${bold(r.data.file)} ${dim(`· ${plural(r.data.refs, "reference")} · 0600`)}`);
    for (const w of r.data.warnings || []) say(beacon(`  ${w}`));
    return 0;
  }
  if (process.stdout.isTTY && !reveal) return oops("this would print secrets to your terminal · -o <file> writes them to a file instead, or --reveal if you mean it");
  if (!refs.length) { if (JSON_MODE) jsonLine({ data: { values: {} } }); else process.stdout.write(render(template, {})); return 0; }
  const r = await tool("vault.resolve", { refs, destination: "stdout" });
  if (r.error) return fail(r);
  if (!JSON_MODE) process.stdout.write(render(template, r.data.values || {}));
  return 0;
}

// ------------------------------------------------------------ ssh

async function ssh(args) {
  const [sub, ...rest] = args;
  if (sub === "keys" || sub === undefined) {
    const r = await tool("vault.ssh.keys");
    if (r.error) return fail(r);
    const keys = r.data.keys || [];
    if (!keys.length) say(dim("  no ssh keys · vyre vault ssh generate <name> or vyre vault ssh add <name> --file <key>"));
    for (const k of keys) {
      say(`  ${bold(k.name)}  ${dim(k.type || "?")}  ${k.fingerprint || beacon(k.problem || "")}`);
      if (k.public) say(dim(`    ${k.public}`));
    }
    say(dim(r.data.socket ? `\n  agent: ${r.data.socket}` : "\n  the ssh agent is off · set vault.ssh in config.json"));
    return 0;
  }
  if (sub === "generate") {
    let f;
    try { f = flags(rest, { string: ["type", "comment"] }); } catch (e) { return oops(e.message); }
    if (f._.length !== 1) return oops("vyre vault ssh generate <name> [--type ed25519|rsa|ecdsa] [--comment c]");
    const r = await tool("vault.ssh.generate", { name: f._[0], ...(f.type ? { type: f.type } : {}), ...(f.comment ? { comment: f.comment } : {}) }, { timeout: 60_000 });
    if (r.error) return fail(r);
    say(`  ${signal("generated")} ${bold(r.data.key.name)} ${dim(`· ${r.data.key.type} · ${r.data.key.fingerprint}`)}`);
    say(r.data.key.public);
    return 0;
  }
  if (sub === "add") {
    let f;
    try { f = flags(rest, { string: ["file"] }); } catch (e) { return oops(e.message); }
    if (f._.length !== 1 || !f.file) return oops("vyre vault ssh add <name> --file <private key>");
    const r = await tool("vault.ssh.add", { name: f._[0], file: path.resolve(f.file) });
    if (r.error) return fail(r);
    say(`  ${signal("added")} ${bold(r.data.key.name)} ${dim(`· ${r.data.key.type} · ${r.data.key.fingerprint}`)}`);
    if (r.data.advice) say(beacon(`  ${r.data.advice}`));
    return 0;
  }
  if (sub === "approvals") {
    let f;
    try { f = flags(rest, { boolean: ["revoke"], string: ["host"] }); } catch (e) { return oops(e.message); }
    if (f.revoke) {
      const r = await tool("vault.ssh.forget", { ...(f._[0] ? { name: f._[0] } : {}), ...(f.host ? { host: f.host } : {}) });
      if (r.error) return fail(r);
      say(`  ${signal("ended")} ${plural(r.data.ended, "lease")} ${dim("· the next signature asks again")}`);
      return 0;
    }
    const r = await tool("vault.ssh.approvals");
    if (r.error) return fail(r);
    const { leases = [], waiting = [] } = r.data;
    if (!leases.length && !waiting.length) { say(dim("  no ssh approvals · the first signature per key and host asks")); return 0; }
    for (const l of leases) say(`  ${bold(l.name)}  ${l.host}  ${dim("until " + new Date(l.expires).toISOString().slice(11, 16))}`);
    for (const w of waiting) say(`  ${beacon(w.id)}  ${w.summary} ${dim("· vyre vault ssh approve " + w.id)}`);
    return 0;
  }
  if (sub === "approve") {
    if (rest.length !== 1) return oops("vyre vault ssh approve <id>");
    const r = await tool("vault.ssh.approve", { id: rest[0] });
    if (r.error) return fail(r);
    say(`  ${signal("approved")} ${bold(r.data.lease.name)} for ${r.data.lease.host} ${dim("· 8 hours or until the vault locks")}`);
    return 0;
  }
  if (sub === "agent-line") {
    const r = await tool("vault.ssh.keys");
    if (r.error) return fail(r);
    if (!r.data.socket) return oops('the ssh agent is off · set "vault": { "ssh": { "socket": "ssh/agent.sock" } } in config.json and restart vyred');
    if (!JSON_MODE) process.stdout.write(`IdentityAgent "${r.data.socket}"\n`);
    hint(dim(`  put that line under a Host block in ~/.ssh/config (Vyre never edits it), or: export SSH_AUTH_SOCK="${r.data.socket}"\n`));
    return 0;
  }
  if (sub === "setup") {
    // Shows the lines for ssh and the shell; changes git's settings only with --git.
    let f;
    try { f = flags(rest, { boolean: ["git"] }); } catch (e) { return oops(e.message); }
    const r = await tool("vault.ssh.keys");
    if (r.error) return fail(r);
    if (!r.data.socket) return oops('the ssh agent is off · set "vault": { "ssh": { "socket": "ssh/agent.sock" } } in config.json and restart vyred');
    const keys = (r.data.keys || []).filter(k => k.public);
    const key = f._[0] ? keys.find(k => k.name === f._[0]) : keys.find(k => k.type === "ssh-ed25519") || keys[0];
    if (!key) return oops(f._[0] ? `no ssh key named ${f._[0]}` : "no ssh key yet · vyre vault ssh generate <name>, or vyre vault ssh import");
    let email = "";
    try { email = execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not set */ }
    const allowedSigners = path.join(os.homedir(), ".config", "git", "allowed_signers");
    const plan = setupPlan({ socket: r.data.socket, pub: key.public, email, allowedSigners });
    say(`  ${bold(key.name)} ${dim(`· ${key.fingerprint}`)}\n`);
    say(dim("  1. in ~/.ssh/config (Vyre never edits it):"));
    for (const l of plan.ssh) say(`     ${l}`);
    say(dim("\n  2. in your shell profile, so git and ssh-add find the agent:"));
    for (const l of plan.shell) say(`     ${l}`);
    say(dim(`\n  3. git signs commits with this key${f.git ? "" : " (run again with --git to apply)"}:`));
    for (const c of plan.git) say(`     git ${c.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    if (!f.git) return 0;
    for (const c of plan.git) execFileSync("git", c, { stdio: "ignore" });
    if (plan.allowed) addAllowedSigner(allowedSigners, plan.allowed);
    say(`\n  ${signal("git now signs")} ${dim(`every commit and tag with ${key.name}; each signature asks you first${plan.allowed ? "" : " · set git user.email, then run this again for allowed_signers"}`)}`);
    return 0;
  }
  if (sub === "import") {
    // Moves private keys from ~/.ssh (or --dir) into the vault, one vault.ssh.add each.
    let f;
    try { f = flags(rest, { string: ["dir"] }); } catch (e) { return oops(e.message); }
    const dir = path.resolve(f.dir || path.join(os.homedir(), ".ssh"));
    const found = findPrivateKeys(dir);
    if (!found.length) { say(dim(`  no private keys in ${dir}`)); return 0; }
    let failed = 0;
    for (const k of found) {
      const r = await tool("vault.ssh.add", { name: k.name, file: k.file });
      if (r.error) { failed++; say(`  ${beacon("not added")} ${path.basename(k.file)} ${dim(`· ${r.error.message}`)}`); continue; }
      say(`  ${signal("added")} ${bold(k.name)} ${dim(`· ${r.data.key.fingerprint} · from ${path.basename(k.file)}`)}`);
    }
    say(dim(`\n  the files are still in ${dir}: once vyre vault ssh setup works for you, delete them`));
    return failed ? 1 : 0;
  }
  return oops(`vyre vault ssh ${sub}: keys, generate, add, import, setup [--git], approvals [--revoke], approve or agent-line`);
}

// ------------------------------------------------------------ git credential helper

/** All of stdin, for the credential protocol. */
function stdinText() {
  return new Promise((resolve, reject) => {
    const parts = [];
    process.stdin.on("data", c => parts.push(Buffer.from(c)));
    process.stdin.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/** `git-credential-vyre <get|store|erase>`: git's side of the helper protocol. */
async function gitCredential(args) {
  const action = args[0];
  // git may add actions later; an unknown one is answered with nothing, as the protocol asks.
  if (!["get", "store", "erase"].includes(action)) return 0;
  const request = await stdinText();
  const r = await tool("vault.git", { action, request }, { timeout: 120_000 });
  if (r.error) {
    if (JSON_MODE) return fail(r);
    process.stderr.write(`vyre: ${r.error.message}\n`);
    return exitFor(r);
  }
  if (!JSON_MODE && r.data.response) process.stdout.write(r.data.response);
  if (!JSON_MODE && action === "get" && r.data.why) process.stderr.write(`vyre: ${r.data.why}\n`);
  return 0;
}

// ------------------------------------------------------------ put

async function put(args) {
  const f = flags(args, { string: ["kind", "description", "url", "username", "expires", "provider", "product", "from", "key-from", "ssid"], list: ["host", "field", "scope"], boolean: ["totp", "allow-body"] });
  if (f._.length !== 1) {
    if (f._.length === 0) return oops("vyre vault put <name> [--kind k] [--description d] [--url u] [--host h ...]");
    return oops("values are never taken on the command line, where shell history and your agents would see them. " +
      `Run vyre vault put ${f._[0]} and type it at the prompt, or pipe it in.`);
  }
  const name = f._[0];
  const kind = f.kind || "secret";
  if (!KINDS.includes(kind)) return oops(`--kind is one of ${KINDS.join(", ")}`);
  if (kind === "passkey") return oops("a passkey is made by the site you sign up on, through autofill; it is never typed in");
  if (kind === "ssh-key") return oops("ssh keys come in through vyre vault ssh generate or vyre vault ssh add");
  const tty = !!process.stdin.isTTY;

  /** @type {Record<string, string>} */
  const fields = {};
  const hidden = async (key, q) => { const v = await hiddenPrompt(q); if (!v) throw new Error(`no ${key} given`); fields[key] = v; };
  try {
    if (kind === "secret" || kind === "api-key") await hidden("value", "value: ");
    else if (kind === "note") await hidden("text", tty ? "note (Enter to finish): " : "");
    else if (kind === "login") {
      if (f.username !== undefined) fields.username = f.username;
      else if (tty) fields.username = await visiblePrompt("username: ");
      else return oops("with piped input, give the username as --username; stdin is the password");
      if (f.totp && !tty) return oops("--totp needs a terminal, since stdin is the password");
      await hidden("password", "password: ");
      if (f.totp) await hidden("totp", "TOTP secret or otpauth:// URI: ");
    } else if (kind === "card") {
      if (!tty) return oops("a card needs a terminal: it asks for four fields");
      fields.holder = await visiblePrompt("name on card: ");
      await hidden("number", "number: ");
      fields.expiry = await visiblePrompt("expiry (MM/YY): ");
      await hidden("cvv", "security code: ");
    } else if (kind === "env-set" || f.field.length) {
      // Named fields, for an env-set or any kind: each is asked for, hidden.
      if (!f.field.length) return oops("an env-set needs its variable names: --field NAME --field OTHER");
      if (!tty && f.field.length > 1) return oops(`with piped input ${kind === "env-set" ? "an env-set" : "a put"} takes one --field; use a terminal for more`);
      for (const k of f.field) await hidden(k, `${k}: `);
    } else if (kind === "address" || kind === "identity") {
      if (!tty) return oops(`${kind === "address" ? "an address" : "an identity"} needs a terminal: it asks for several fields`);
      for (const [k, q] of kind === "address"
        ? [["name", "name: "], ["line1", "street: "], ["line2", "line 2 (optional): "], ["city", "city: "], ["region", "state or region: "], ["postal", "postal code: "], ["country", "country: "], ["phone", "phone (optional): "]]
        : [["type", "document (passport, driver's license...): "], ["name", "name on it: "], ["country", "country: "], ["expiry", "expires (YYYY-MM-DD): "]]) {
        const v = await visiblePrompt(q);
        if (v) fields[k] = v;
      }
      if (kind === "identity") await hidden("number", "number: ");
    } else if (kind === "file" || (kind === "cert" && f.from)) {
      if (!f.from) return oops("a file comes from disk: --from <path> (64 KB at most)");
      const bytes = fs.readFileSync(path.resolve(f.from));
      if (bytes.length > 48 * 1024) return oops(`${f.from} is larger than 48 KB`);
      if (kind === "file") { fields.content = bytes.toString("base64"); fields.filename = path.basename(f.from); }
      else fields.certificate = bytes.toString("utf8");
      if (kind === "cert" && f["key-from"]) fields.private_key = fs.readFileSync(path.resolve(f["key-from"]), "utf8");
    } else if (kind === "wifi") {
      fields.ssid = f.ssid ?? (tty ? await visiblePrompt("network name: ") : "");
      if (!fields.ssid) return oops("a Wi-Fi network needs its name: --ssid <name>");
      await hidden("password", "password: ");
    } else if (kind === "cloud") {
      if (f.from) { fields.json = fs.readFileSync(path.resolve(f.from), "utf8"); }
      else {
        if (!tty) return oops("with piped input, a cloud credential takes --field secret_access_key, or --from <service-account.json>");
        fields.access_key_id = await visiblePrompt("access key id: ");
        await hidden("secret_access_key", "secret access key: ");
      }
    } else {
      // Every other kind asks for the one field it hands over: a PAT's token, a key, codes.
      const k = /** @type {string} */ (defaultFieldOf(kind) || "value");
      if (f.username !== undefined) fields.username = f.username;
      await hidden(k, kind === "authenticator" ? "secret or otpauth:// URI: " : kind === "recovery-codes" ? "codes, separated by spaces: " : `${k.replace(/_/g, " ")}: `);
    }
  } catch (e) {
    return oops(e.message === "cancelled" ? "cancelled, nothing stored" : e.message);
  }

  let hosts = f.host;
  if (!hosts.length && f.url) { const o = origin(f.url); if (o) hosts = [o]; }
  /** @type {Record<string, any>} */
  const input = { name, kind, fields };
  if (f.description) input.description = f.description;
  if (f.url) input.url = f.url;
  if (hosts.length) input.hosts = hosts;
  if (f["allow-body"]) input.relay = { body: true };
  /** @type {Record<string, any>} */
  const details = {};
  if (f.expires) details.expires = f.expires;
  if (f.scope.length) details.scope = f.scope.flatMap(x => x.split(/[,\s]+/)).filter(Boolean);
  if (f.provider) details.provider = f.provider;
  if (f.product) details.product = f.product;
  if (Object.keys(details).length) input.details = details;
  const r = await tool("vault.put", input);
  for (const k of Object.keys(fields)) fields[k] = "";
  if (r.error) return fail(r);
  // A `<vault>/<item>` name went to a shared vault: a revision, a merge, or a conflict kept aside.
  if (r.data.conflict) { say(`  ${beacon("conflict")} ${bold(r.data.name)} ${dim(`· someone changed the same field first; yours is kept as a conflict revision beside rev ${r.data.current}`)}`); return 0; }
  if (r.data.rev) { say(`  ${signal(r.data.merged ? "merged" : "shared")} ${bold(r.data.name)} ${dim(`· rev ${r.data.rev} in ${r.data.vault}`)}`); return 0; }
  say(`  ${signal(r.data.created ? "stored" : "updated")} ${bold(r.data.name)} ${dim(`· ${r.data.kind}${hosts.length ? " · sent only to " + hosts.join(", ") : ""}`)}`);
  return 0;
}

// ------------------------------------------------------------ grants

async function grant(args) {
  const f = flags(args, { string: ["watcher"] });
  const [name, module] = f._;
  if (!name || !module || f._.length > 2) return oops("vyre vault grant <name> <module> [--watcher w]");
  const r = await tool("vault.grant", { name, module, ...(f.watcher ? { watcher: f.watcher } : {}) });
  if (r.error) return fail(r);
  const g = r.data.grant;
  if (g.status === "pending") say(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${g.id}`)}`);
  else say(`  ${signal("granted")} ${bold(g.name)} to ${grantText(g)}`);
  return 0;
}

async function revoke(args) {
  const f = flags(args, { string: ["watcher"] });
  const [name, module] = f._;
  if (!name || !module || f._.length > 2) return oops("vyre vault revoke <name> <module> [--watcher w]");
  const r = await tool("vault.revoke", { name, module, ...(f.watcher ? { watcher: f.watcher } : {}) });
  if (r.error) return fail(r);
  say(r.data.revoked ? `  ${signal("revoked")} ${bold(name)} from ${module}${f.watcher ? "/" + f.watcher : ""}` : dim(`  ${module} had no grant of ${name}`));
  return 0;
}

async function pending() {
  const r = await tool("vault.pending");
  if (r.error) return fail(r);
  const { grants = [], passes = [], people = [], accepts = [], agentGrants = [] } = r.data;
  if (!grants.length && !passes.length && !people.length && !accepts.length && !agentGrants.length) { say(dim("  nothing waiting for approval")); return 0; }
  say("");
  for (const g of grants) say(`  ${beacon(g.id)}  grant ${bold(g.name)} to ${grantText(g)}`);
  for (const p of passes) say(`  ${beacon(p.id)}  ${p.mode || "relayed"} pass for ${bold(p.holder)}: ${(p.items || []).join(", ")}${p.expires ? dim(" · until " + day(p.expires)) : ""}`);
  for (const p of people) say(`  ${beacon(p.id)}  trust the card for ${bold(p.name)} ${dim("· fingerprint " + (p.fingerprint || "unreadable"))}`);
  for (const g of agentGrants) say(`  ${beacon(g.id)}  let ${bold(g.agent)} sign in to ${g.origin} as ${bold(g.item)}${g.expires ? dim(" · until " + day(g.expires)) : ""}`);
  for (const a of accepts) say(`  ${beacon(a.id)}  accept a ${a.mode || ""} pass from ${bold(a.owner)}: ${(a.items || []).join(", ")}`);
  say(dim(`\n  vyre vault approve <id>\n`));
  return 0;
}

async function approve(args) {
  const id = args[0];
  if (!id || args.length > 1) return oops("vyre vault approve <id>");
  const r = await tool("vault.approve", { id });
  if (r.error) return fail(r);
  const a = r.data.approved || {};
  const what = a.holder ? `pass for ${bold(a.holder)}` : a.owner ? `pass from ${bold(a.owner)}: ${(a.items || []).join(", ")}` : a.fingerprint ? `card for ${bold(a.name)} ${dim("· " + a.fingerprint)}` : `${bold(a.name || id)}${a.module ? " to " + grantText(a) : ""}`;
  say(`  ${signal("approved")} ${what}`);
  if (r.data.ticket) ticket(r.data.ticket, a.holder);
  return 0;
}

// ------------------------------------------------------------ run

/**
 * The environment for `run`: items named before `--` (through vault.inject) and an --env-file
 * of `KEY=vault://item/field` lines (through vault.resolve). Returns the env and the values to
 * scrub, or an exit code.
 */
async function runEnv(args) {
  const at = args.indexOf("--");
  const usage = "vyre vault run [--env-file f] [<item...>] -- <command...>";
  if (at < 0) return { code: oops(`put -- between the items and the command: ${usage}`) };
  const left = [], cmd = args.slice(at + 1);
  let envFile = null;
  for (let i = 0; i < at; i++) {
    if (args[i] === "--env-file") envFile = args[++i];
    else if (args[i].startsWith("--env-file=")) envFile = args[i].slice(11);
    else left.push(args[i]);
  }
  if (!cmd.length) return { code: oops(`no command after --: ${usage}`) };
  if (!left.length && !envFile) return { code: oops(`name at least one item, or --env-file, before --: ${usage}`) };
  let items = [];
  if (left.length) { try { items = parseRunArgs([...left, "--", ...cmd]).items; } catch (e) { return { code: oops(e.message) }; } }
  /** @type {Record<string, string>} */
  const env = {};
  const values = [];
  if (envFile) {
    let vars;
    try { vars = parseEnvFile(fs.readFileSync(path.resolve(envFile), "utf8")); } catch (e) { return { code: oops(`${envFile}: ${e.message}`) }; }
    const refs = [...new Set(vars.flatMap(v => v.refs))];
    let resolved = {};
    if (refs.length) {
      const r = await tool("vault.resolve", { refs, destination: `the environment of ${path.basename(cmd[0])}` });
      if (r.error) return { code: fail(r) };
      resolved = r.data.values || {};
      values.push(...Object.values(resolved));
    }
    for (const v of vars) env[v.key] = v.refs.length ? render(v.value, resolved) : render(v.value, {});
  }
  if (items.length) {
    const r = await tool("vault.inject", { items });
    if (r.error) return { code: fail(r) };
    Object.assign(env, r.data.env || {});
    values.push(...Object.values(r.data.env || {}));
  }
  return { env, values, cmd };
}

async function run(args) {
  const got = await runEnv(args);
  if (got.code !== undefined) return got.code;
  // --json never prints what run injected: the child's output is the output.
  printed = true;
  const { env, values } = got;
  const [bin, ...rest] = got.cmd;
  const child = spawn(bin, rest, { env: { ...process.env, ...env }, stdio: ["inherit", "pipe", "pipe"] });
  const so = new Scrubber(values), se = new Scrubber(values);
  child.stdout.pipe(so).pipe(process.stdout, { end: false });
  child.stderr.pipe(se).pipe(process.stderr, { end: false });
  const forward = sig => () => { try { child.kill(sig); } catch { /* already gone */ } };
  const onInt = forward("SIGINT"), onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const code = await new Promise(resolve => {
      child.on("error", e => { const nf = /** @type {any} */ (e).code === "ENOENT"; oops(nf ? `${bin}: command not found` : e.message); resolve(nf ? 127 : 126); });
      child.on("close", (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] || 0) : 1)));
    });
    await Promise.all([finished(so).catch(() => {}), finished(se).catch(() => {})]);
    return code;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    values.length = 0;
  }
}

// ------------------------------------------------------------ for people

async function totp(args) {
  const name = args[0];
  if (!name || args.length > 1) return oops("vyre vault totp <name>");
  const r = await tool("vault.totp", { name });
  if (r.error) return fail(r);
  say(`  ${bold(signal(r.data.display || r.data.code))}  ${dim(`${r.data.remaining}s left${r.data.next ? ` · next ${r.data.next}` : ""}`)}`);
  return 0;
}

/** `sweep <path>`: where the vault's values, and credentials it lacks, sit in plain text. */
async function sweepCmd(args) {
  let f;
  try { f = flags(args, { boolean: ["history", "shell"] }); } catch (e) { return oops(e.message); }
  if (f._.length > 1) return oops("vyre vault sweep [path] [--history] [--shell]");
  const where = path.resolve(f._[0] || ".");
  const r = await tool("vault.sweep", { path: where, ...(f.history ? { history: true } : {}), ...(f.shell ? { shell: true } : {}) });
  if (r.error) return fail(r);
  const d = r.data;
  const found = d.findings || [];
  say(`  ${found.length ? beacon(plural(found.length, "place")) : signal("nothing found")} ${dim(`· ${d.scanned} files${d.commits ? `, ${d.commits} commits` : ""}${d.shell ? `, ${d.shell} shell histories` : ""}${d.truncated ? ", stopped at the limit" : ""}`)}`);
  if (d.history) say(dim(`  history: ${d.history}`));
  for (const x of found) {
    const at = x.where === "history" ? `${x.file}:${x.line} ${dim(`in commit ${x.commit}${x.also ? ` and ${x.also} more` : ""}`)}` : `${x.file}:${x.line}`;
    const what = x.item ? `${bold(x.item)} ${dim("from the vault")}` : `${beacon([x.type, x.provider].filter(Boolean).join(" "))} ${dim("not in the vault")}`;
    say(`  ${at}  ${what}`);
  }
  if (found.some(x => x.where === "history")) say(dim("  a value in git history stays there after you delete it: rotate it (vyre vault rotate <name>)"));
  if (found.some(x => !x.item)) say(dim("  bring unknown ones in with vyre vault import <folder> --rewrite, or vyre vault put"));
  return 0;
}

/** `rotate <name>`: a new credential at the provider, or its page and steps. */
async function rotateCmd(args) {
  if (args.length !== 1) return oops("vyre vault rotate <name>");
  const r = await tool("vault.rotate", { name: args[0] });
  if (r.error) return fail(r);
  const d = r.data;
  if (!d.rotated) {
    say(`  ${bold(args[0])} ${dim(`· ${d.guided.provider} has no API for this; by hand:`)}\n  ${d.guided.steps}\n  ${d.guided.url}`);
    say(dim(`  then: vyre vault put ${args[0]} --kind <kind>`));
    return 0;
  }
  say(`  ${signal("rotated")} ${bold(args[0])} ${dim(`· ${d.provider} · the old one ${d.revoked ? "is revoked" : "still works"}${d.expires ? ` · until ${day(d.expires)}` : ""}`)}`);
  if (!d.revoked && d.reason) say(beacon(`  ${d.reason}`));
  return 0;
}

/** `codes`: every one-time code, current and next. `codes import`: scanned codes into the vault. */
async function codesCmd(args) {
  if (args[0] === "import") return codesImport(args.slice(1));
  let f;
  try { f = flags(args, {}); } catch (e) { return oops(e.message); }
  const r = await tool("vault.codes", f._.length ? { names: f._ } : {});
  if (r.error) return fail(r);
  const list = r.data.codes || [];
  if (!list.length) { say(dim("  no one-time codes yet · vyre vault codes import <scanned code...>")); return 0; }
  const wide = Math.min(40, Math.max(...list.map(c => c.name.length)));
  for (const c of list) {
    if (c.error) { say(`  ${c.name.padEnd(wide)}  ${beacon(c.error)}`); continue; }
    const half = Math.floor(c.code.length / 2);
    say(`  ${c.name.padEnd(wide)}  ${bold(signal(c.code.slice(0, half) + " " + c.code.slice(half)))}  ${dim(`next ${c.next} · ${c.remaining}s`)}`);
  }
  return 0;
}

/**
 * Scanned codes, as text: otpauth-migration:// parts from Google Authenticator's export, or
 * otpauth://totp/ addresses, given as arguments, one per line in a file (--from), or piped in.
 * Previews first, then imports. Reading a QR picture is the phone's or the Deck's job.
 */
async function codesImport(args) {
  let f;
  try { f = flags(args, { string: ["from"], boolean: ["preview"] }); } catch (e) { return oops(e.message); }
  let uris = [...f._];
  if (f.from) uris.push(...fs.readFileSync(path.resolve(f.from), "utf8").split(/\s+/));
  if (!uris.length && !process.stdin.isTTY) uris.push(...fs.readFileSync(0, "utf8").split(/\s+/));
  uris = uris.filter(u => /^otpauth(-migration)?:\/\//i.test(u));
  if (!uris.length) return oops("vyre vault codes import <otpauth-migration://...> [more parts] | --from codes.txt   (scan the export on your phone or in the Deck to get these)");
  const p = await tool("vault.codes.import", { uris, preview: true });
  if (p.error) return fail(p);
  const d = p.data;
  for (const m of d.missing || []) say(beacon(`  scan part${m.parts.length > 1 ? "s" : ""} ${m.parts.join(", ")} of ${m.of} too`) + dim(" · the export is split across several codes"));
  say(`  ${signal(plural((d.add || []).length, "account"))} to add${d.add && d.add.length ? `: ${d.add.join(", ")}` : ""}`);
  if ((d.same || []).length) say(dim(`  already here: ${d.same.join(", ")}`));
  for (const s of d.skipped || []) say(dim(`  skipped: ${s}`));
  if (f.preview || (d.missing || []).length || !(d.add || []).length) return (d.missing || []).length ? 1 : 0;
  const r = await tool("vault.codes.import", { uris });
  if (r.error) return fail(r);
  say(`  ${signal("added")} ${r.data.added.join(", ")} ${dim("· vyre vault codes shows them")}`);
  return 0;
}

async function generate(args) {
  let f;
  try { f = flags(args, { string: ["length", "words", "description"], boolean: ["symbols"] }); } catch (e) { return oops(e.message); }
  if (f._.length > 1) return oops("vyre vault generate [--length n] [--words n] [--no-symbols] [name]");
  /** @type {Record<string, any>} */
  const input = {};
  for (const k of ["length", "words"]) {
    if (f[k] === undefined) continue;
    const n = Number(f[k]);
    if (!Number.isInteger(n) || n < 1) return oops(`--${k} takes a whole number`);
    input[k] = n;
  }
  if (f.symbols !== undefined) input.symbols = f.symbols;
  if (f._[0]) input.name = f._[0];
  if (f.description) input.description = f.description;
  const r = await tool("vault.generate", input);
  if (r.error) return fail(r);
  if (input.name) { say(`  ${signal("stored")} ${bold(input.name)} ${dim(`· ${Math.round(r.data.bits)} bits`)}`); return 0; }
  // You asked in your own terminal, so the value goes to stdout alone and pipes cleanly.
  say(r.data.value);
  hint(dim(`  ${Math.round(r.data.bits)} bits · vyre vault generate <name> stores one without showing it\n`));
  return 0;
}

async function importFile(args) {
  let f;
  try { f = flags(args, { string: ["format"], boolean: ["preview", "update-conflicts", "rewrite"] }); } catch (e) { return oops(e.message); }
  if (f._.length !== 1) return oops("vyre vault import <file|folder> [--preview] [--update-conflicts] [--rewrite] [--format f]");
  const file = path.resolve(f._[0]);
  const base = { file, ...(f.format ? { format: f.format } : {}) };
  // Preview first, always: the token it returns binds the import to this exact file, so a file
  // swapped between the two calls is refused (ADR 0028, decision 1).
  const p = await tool("vault.import.preview", base);
  if (p.error) return fail(p);
  const { format, counts = {}, add = [], same = [], conflicts = [], renamed = [], skipped = [], token } = p.data;
  if (f.preview) {
    const kinds = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing";
    say(`  ${bold(format)} ${dim(`· ${kinds}`)}`);
    say(`  ${signal(plural(add.length, "item"))} to add${add.length ? `: ${add.join(", ")}` : ""}`);
    if (same.length) say(dim(`  already here, skipped: ${same.join(", ")}`));
    for (const c of conflicts) say(beacon(`  conflict: ${c.name}`) + dim(` has another password than ${c.existing} · --update-conflicts makes a new version`));
    for (const r of renamed) say(dim(`  renamed: ${r.from} to ${r.to}, the name is taken`));
    for (const s of skipped) say(dim(`  skipped: ${s}`));
    for (const e of p.data.files || []) envPreview(e);
    for (const t of p.data.templates || []) say(dim(`  template, not imported: ${path.relative(process.cwd(), t) || t}`));
    if (p.data.truncated) say(beacon("  stopped at 200 files: import a smaller folder"));
    say(dim(`  vyre vault import ${f._[0]}${f["update-conflicts"] ? " --update-conflicts" : ""}${p.data.files ? " --rewrite" : ""} to import it`));
    return 0;
  }
  const r = await tool("vault.import", { ...base, token, conflicts: f["update-conflicts"] ? "update" : "skip", ...(f.rewrite ? { rewrite: true } : {}) });
  if (r.error) return fail(r);
  const d = r.data;
  const added = d.added || [], updated = d.updated || [], left = d.conflicts || [];
  say(`  ${signal(plural(added.length, "item"))} added from ${d.format} ${dim(`· ${updated.length} updated · ${(d.same || []).length} already here · ${left.length} conflicts skipped · ${(d.skipped || []).length} not imported`)}`);
  if (added.length) say(`    ${added.join(", ")}`);
  if (updated.length) say(`  ${signal("updated")} ${updated.join(", ")} ${dim("· the old passwords stay in vyre vault history")}`);
  if (left.length) say(beacon(`  conflicts skipped: ${left.join(", ")}`) + dim(" · --update-conflicts to take the file's passwords"));
  for (const x of d.renamed || []) say(dim(`  renamed: ${x.from} to ${x.to}`));
  for (const s of d.skipped || []) say(dim(`  skipped: ${s}`));
  for (const x of d.rewritten || []) say(`  ${signal("rewritten")} ${path.relative(process.cwd(), x) || x} ${dim("· values swapped for vault:// references")}`);
  for (const x of d.unchanged || []) say(dim(`  left as it was: ${path.relative(process.cwd(), x) || x}`));
  if (d.advice) say(beacon(`  ${d.advice}`));
  return 0;
}

/** One .env file in a preview: what goes into the vault, typed, and what stays. Never a value. */
function envPreview(e) {
  const where = path.relative(process.cwd(), e.file) || e.file;
  const state = { add: "new", same: "already here", conflict: beacon("differs from the vault"), nothing: "nothing secret" }[e.state] || e.state;
  say(`\n  ${bold(where)} ${dim("→")} ${e.item ? bold(e.item) : dim("stays as it is")} ${dim("· ")}${state}`);
  for (const v of e.vars || []) {
    if (!v.secret) continue;
    const what = [v.type, v.provider, v.mode].filter(Boolean).join(" ");
    const until = v.expires ? dim(` · expires ${new Date(v.expires).toISOString().slice(0, 10)}`) : "";
    say(`    ${v.key.padEnd(28)} ${dim(what)}${until}${v.public ? beacon(" · public name, secret value") : ""}`);
  }
  if ((e.kept || []).length) say(dim(`    stays in the file: ${e.kept.join(", ")}`));
  if (e.git && e.git.tracked) say(beacon("    committed to git: the values stay in its history, change them at the provider"));
  else if (e.git && !e.git.ignored) say(beacon("    not in .gitignore: add it before a commit picks it up"));
}

async function audit(args) {
  const f = flags(args, { string: ["limit"] });
  const input = {};
  if (f._[0]) input.name = f._[0];
  if (f.limit) input.limit = Number(f.limit);
  const r = await tool("vault.audit", input);
  if (r.error) return fail(r);
  const entries = r.data.entries || [];
  if (!entries.length) { say(dim("  no audit entries yet")); return 0; }
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
    const res = e.ok ? signal("ok") : beacon("refused") + (e.why ? dim(" " + e.why) : "");
    say(`  ${dim(when)}  ${e.action.padEnd(14)} ${bold(e.name || "")} ${dim("by " + e.who)}  ${res}`);
  }
  return 0;
}

async function card() {
  const r = await tool("vault.identity");
  if (r.error) return fail(r);
  say(`\n  ${bold(r.data.name)} ${dim(r.data.relay ? "· relay " + r.data.relay : "· no relay address yet")}`);
  if (r.data.fingerprint) say(`  ${dim("fingerprint")} ${r.data.fingerprint}\n`);
  say(r.data.card);
  say(dim(`\n  send this card to whoever will share with you; it carries no secret\n`));
  return 0;
}

// ------------------------------------------------------------ people

// ------------------------------------------------------------ shared vaults and devices

/** `vyre vault vaults create|list|rotate|sync` */
async function vaults(args) {
  const [sub = "list", ...rest] = args;
  if (sub === "list") {
    const r = await tool("vault.vaults.list");
    if (r.error) return fail(r);
    if (!r.data.vaults.length) { say(dim("  no shared vaults · vyre vault vaults create <name>")); return 0; }
    for (const v of r.data.vaults) {
      say(`\n  ${bold(v.name)} ${dim(`· ${v.role} · key version ${v.kv}`)}${v.conflicts ? " " + beacon(`${plural(v.conflicts, "conflict")}`) : ""}`);
      for (const m of v.members) say(`    ${m.name.padEnd(20)} ${dim(m.role.padEnd(10))} ${dim(m.fingerprint)}`);
      for (const i of v.items) say(`    ${dim("item")} ${i.name}${i.rotate ? " " + beacon("rotate") : ""}`);
    }
    say("");
    return 0;
  }
  if (sub === "create") {
    if (rest.length !== 1) return oops("vyre vault vaults create <name>");
    const r = await tool("vault.vaults.create", { name: rest[0] });
    if (r.error) return fail(r);
    say(`  ${signal("created")} ${bold(r.data.vault.name)} ${dim("· you are its owner, and this Vyre is its home")}`);
    return 0;
  }
  if (sub === "rotate") {
    if (rest.length !== 1) return oops("vyre vault vaults rotate <vault>");
    const r = await tool("vault.vaults.rotate", { vault: rest[0] });
    if (r.error) return fail(r);
    say(`  ${signal("rotated")} ${bold(r.data.vault)} ${dim(`· key version ${r.data.kv}`)}`);
    return 0;
  }
  if (sub === "sync") {
    if (rest.length > 1) return oops("vyre vault vaults sync [vault]");
    const r = await tool("vault.vaults.sync", rest[0] ? { vault: rest[0] } : {});
    if (r.error) return fail(r);
    for (const x of r.data.synced) say(`  ${x.removed ? beacon("removed") : signal("synced")} ${bold(x.vault)}${x.taken ? dim(` · ${x.taken} new`) : ""}${x.ignored ? " " + beacon(`${x.ignored} ignored`) : ""}`);
    return 0;
  }
  return oops(`vyre vault vaults ${sub}: create, list, rotate or sync`);
}

/** `vyre vault members invite|accept|role|remove` */
async function members(args) {
  const [sub, ...rest] = args;
  let f;
  try { f = flags(rest, { string: ["role"] }); } catch (e) { return oops(e.message); }
  if (sub === "invite") {
    const [v, person] = f._;
    if (!v || !person || f._.length > 2) return oops("vyre vault members invite <vault> <person> [--role admin|member|read-only]");
    const r = await tool("vault.members.invite", { vault: v, person, ...(f.role ? { role: f.role } : {}) });
    if (r.error) return fail(r);
    say(`  ${signal("invited")} ${bold(r.data.member)} ${dim(`to ${r.data.vault} as ${r.data.role}; send them this, it carries no secret:`)}\n`);
    say(r.data.invite);
    say(dim(`\n  they run: vyre vault members accept <invite>\n`));
    return 0;
  }
  if (sub === "accept") {
    if (f._.length !== 1) return oops("vyre vault members accept <invite>");
    const r = await tool("vault.members.accept", { invite: f._[0] });
    if (r.error) return fail(r);
    say(`  ${signal("joined")} ${bold(r.data.vault.name)} ${dim(`· ${r.data.vault.role} · ${plural(r.data.vault.items.length, "item")}`)}`);
    return 0;
  }
  if (sub === "role") {
    const [v, person, role] = f._;
    if (!v || !person || !role) return oops("vyre vault members role <vault> <person> <admin|member|read-only>");
    const r = await tool("vault.members.role", { vault: v, person, role });
    if (r.error) return fail(r);
    say(`  ${signal("changed")} ${bold(r.data.member)} ${dim(`is ${r.data.role} in ${r.data.vault}`)}`);
    return 0;
  }
  if (sub === "remove") {
    const [v, person] = f._;
    if (!v || !person || f._.length > 2) return oops("vyre vault members remove <vault> <person>");
    const r = await tool("vault.members.remove", { vault: v, person });
    if (r.error) return fail(r);
    say(`  ${signal("removed")} ${bold(r.data.removed)} ${dim(`from ${r.data.vault} · new key version ${r.data.kv}`)}`);
    if (r.data.rotate.length) say(beacon(`  rotate: ${r.data.rotate.join(", ")}`) + dim(" · they could read these"));
    return 0;
  }
  return oops(`vyre vault members ${sub}: invite, accept, role or remove`);
}

/** `vyre vault move <item> <vault>` */
async function move(args) {
  if (args.length !== 2) return oops("vyre vault move <item> <vault>");
  const r = await tool("vault.move", { name: args[0], to: args[1] });
  if (r.error) return fail(r);
  if (r.data.conflict) { say(`  ${beacon("conflict")} ${bold(r.data.name)} ${dim("· the vault already has a different version; nothing was moved")}`); return 1; }
  say(`  ${signal("moved")} ${bold(r.data.moved)} ${dim("→ " + r.data.to)}`);
  return 0;
}

/** `vyre vault device join [--role full|storage] [--approval a] | approve <code> | list | sync` */
async function device(args) {
  const [sub = "list", ...rest] = args;
  let f;
  try { f = flags(rest, { string: ["role", "approval"] }); } catch (e) { return oops(e.message); }
  if (sub === "join") {
    const r = await tool("vault.device.join", { ...(f.role ? { role: f.role } : {}), ...(f.approval ? { approval: f.approval } : {}) });
    if (r.error) return fail(r);
    if (r.data.joined) { say(`  ${signal("joined")} ${dim(`${r.data.home}'s vault as ${r.data.role}${r.data.pulled ? ` · ${plural(r.data.pulled, "item")}` : ""}`)}`); return 0; }
    say(`\n  ${bold("this device")} ${dim("· fingerprint")} ${r.data.fingerprint}\n`);
    say(r.data.code);
    say(dim(`\n  on a device that has your vault: vyre vault device approve <code>\n  compare the fingerprint it shows with this one, then here: vyre vault device join --approval <answer>\n`));
    return 0;
  }
  if (sub === "approve") {
    if (f._.length !== 1) return oops("vyre vault device approve <code>");
    const r = await tool("vault.device.approve", { code: f._[0] });
    if (r.error) return fail(r);
    say(`  ${signal("approved")} ${bold(r.data.device)} ${dim(`as ${r.data.role} · fingerprint ${r.data.fingerprint}; give it this answer:`)}\n`);
    say(r.data.approval);
    say("");
    return 0;
  }
  if (sub === "list") {
    const r = await tool("vault.device.list");
    if (r.error) return fail(r);
    if (!r.data.group) { say(dim("  this vault is on one device · vyre vault device join on another")); return 0; }
    for (const d of r.data.devices) say(`  ${bold(d.name.padEnd(20))} ${dim(d.role.padEnd(8))} ${dim(d.fingerprint)}`);
    return 0;
  }
  if (sub === "sync") {
    const r = await tool("vault.device.sync");
    if (r.error) return fail(r);
    say(`  ${signal("synced")} ${dim(`${r.data.pulled ?? 0} pulled · ${r.data.pushed ?? 0} pushed`)}`);
    return 0;
  }
  return oops(`vyre vault device ${sub}: join, approve, list or sync`);
}

async function people(args) {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "list") {
    const r = await tool("vault.people");
    if (r.error) return fail(r);
    if (!r.data.people.length) { say(dim("  no one yet · vyre vault people add <card>")); return 0; }
    say("");
    for (const p of r.data.people) {
      const st = p.blocked ? beacon(p.changed ? "key changed" : "unverified v1 card") : p.verified ? signal("verified") : dim("pinned");
      say(`  ${bold(p.name)}  ${p.fingerprint}  ${st}`);
    }
    say("");
    return 0;
  }
  if (sub === "add") {
    let f;
    try { f = flags(rest, { string: ["name"] }); } catch (e) { return oops(e.message); }
    if (f._.length !== 1) return oops("vyre vault people add <card> [--name n]");
    const r = await tool("vault.person.add", { card: f._[0], ...(f.name ? { name: f.name } : {}) });
    if (r.error) return fail(r);
    if (r.data.pending) { say(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${r.data.pending.id}`)}`); return 0; }
    const p = r.data.person;
    if (r.data.changed) say(`  ${beacon("key changed")} ${bold(p.name)} ${dim("· new fingerprint " + p.fingerprint)}\n  ${dim(`no new pass reaches them until you compare fingerprints and run vyre vault people verify ${p.name} <fingerprint>`)}`);
    else say(`  ${signal(r.data.pinned ? "pinned" : "unchanged")} ${bold(p.name)} ${dim("· fingerprint " + p.fingerprint)}`);
    return 0;
  }
  if (sub === "verify") {
    const [name, ...fp] = rest;
    if (!name || !fp.length) return oops("vyre vault people verify <name> <fingerprint>");
    const r = await tool("vault.people.verify", { name, fingerprint: fp.join(" ") });
    if (r.error) return fail(r);
    say(`  ${signal("verified")} ${bold(r.data.person.name)} ${dim("· " + r.data.person.fingerprint)}`);
    return 0;
  }
  return oops(`vyre vault people ${sub}: list, add or verify`);
}

async function fingerprintCmd(args) {
  if (args.length > 1) return oops("vyre vault fingerprint [person]");
  const r = await tool("vault.fingerprint", args[0] ? { with: args[0] } : {});
  if (r.error) return fail(r);
  say(`  ${dim("yours ")} ${r.data.fingerprint}`);
  if (r.data.person) {
    say(`  ${dim("theirs")} ${r.data.person.fingerprint} ${dim("· " + r.data.person.name + (r.data.person.verified ? ", verified" : ""))}`);
    say(`\n  ${bold(r.data.words.join(" "))}\n  ${dim("read these to each other; they match on both screens only if neither key was swapped")}`);
  }
  return 0;
}

async function kit() {
  const r = await tool("vault.kit");
  if (r.error) return fail(r);
  say(`  ${signal("recovery kit")} ${dim("· one load, gone by " + new Date(r.data.expires).toLocaleTimeString())}`);
  say(`  ${r.data.url}`);
  say(dim("  print it, write your password on it by hand, keep it somewhere safe"));
  // Opened for a person at a terminal only; a script or a test gets the address and nothing else.
  if (process.platform === "darwin" && process.stdout.isTTY && !process.env.VYRE_NO_OPEN && dialogsAllowed()) spawn("open", [r.data.url], { stdio: "ignore", detached: true }).unref();
  return 0;
}

// ------------------------------------------------------------ passes

function ticket(t, holder) {
  say(dim(`\n  send this ticket to ${holder || "the holder"}; it carries no secret:\n`));
  say(t);
  say(dim(`\n  they run: vyre vault pass accept <ticket>\n`));
}

async function pass(args) {
  const [sub, ...rest] = args;
  if (sub === "create") {
    let f;
    try { f = flags(rest, { string: ["card", "expires", "note"], list: ["host", "method", "path"], boolean: ["sealed"] }); } catch (e) { return oops(e.message); }
    const [holder, ...items] = f._;
    if (!holder || !items.length) return oops("vyre vault pass create <holder> <item...> [--sealed] [--card c] [--host h ...] [--expires 30d] [--note n]");
    /** @type {Record<string, any>} */
    const input = { holder, items, mode: f.sealed ? "sealed" : "relayed" };
    if (f.card) input.card = f.card;
    if (f.host.length) input.hosts = f.host;
    if (f.method.length) input.methods = f.method;
    if (f.path.length) input.paths = f.path;
    if (f.expires) input.expires = f.expires;
    if (f.note) input.note = f.note;
    const r = await tool("vault.pass.create", input);
    if (r.error) return fail(r);
    const p = r.data.pass;
    say(`  ${signal("pass")} ${dim(p.id)} for ${bold(p.holder)}: ${p.items.join(", ")} ${dim(`· ${p.mode}${p.expires ? " · until " + day(p.expires) : ""}`)}`);
    if (p.mode === "sealed") say(beacon("  sealed: revoking this pass means rotating these items"));
    if (p.status === "pending" || !r.data.ticket) say(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${p.id}`)}`);
    else ticket(r.data.ticket, p.holder);
    return 0;
  }
  if (sub === "list" || sub === undefined) {
    const r = await tool("vault.pass.list");
    if (r.error) return fail(r);
    const { passes = [], held = [] } = r.data;
    if (!passes.length && !held.length) { say(dim("  no passes given or held")); return 0; }
    if (passes.length) say(bold("\n  given"));
    for (const p of passes) {
      const st = p.status === "active" ? signal(p.status) : p.status === "pending" ? beacon(p.status) : dim(p.status || "");
      say(`  ${dim(p.id)}  ${bold(p.holder)}  ${(p.items || []).join(", ")}  ${dim(p.mode || "")}${p.expires ? dim(" · until " + day(p.expires)) : ""}  ${st}`);
    }
    if (held.length) say(bold("\n  held"));
    for (const h of held) say(`  ${dim(h.id)}  from ${bold(h.owner)}  ${(h.items || []).join(", ")}  ${dim(h.mode || "")}`);
    say("");
    return 0;
  }
  if (sub === "revoke") {
    if (rest.length !== 1) return oops("vyre vault pass revoke <id>");
    const r = await tool("vault.pass.revoke", { id: rest[0] });
    if (r.error) return fail(r);
    say(r.data.revoked ? `  ${signal("revoked")} ${rest[0]}` : dim(`  ${rest[0]} was not active`));
    if (r.data.rotate?.length) say(beacon(`  rotate: ${r.data.rotate.join(", ")}`) + dim(" · then vyre vault put each one again"));
    return 0;
  }
  if (sub === "accept") {
    if (rest.length !== 1) return oops("vyre vault pass accept <ticket>");
    const r = await tool("vault.pass.accept", { ticket: rest[0] });
    if (r.error) return fail(r);
    if (r.data.pending) { out(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${r.data.pending.id}`)}`); return 0; }
    const h = r.data.held;
    say(`  ${signal("accepted")} ${h.mode} pass from ${bold(h.owner)}: ${h.items.join(", ")}`);
    return 0;
  }
  return oops(`vyre vault pass ${sub}: create, list, revoke or accept`);
}

/** `emergency ...`: a verified contact can open your items after a wait you can stop (ADR 0028, decision 8). */
async function emergency(args) {
  const [sub, ...rest] = args;
  const stateWords = c => c.state === "waiting" ? beacon(`asked · opens ${day(c.opens)}`) : c.state === "released" ? beacon("released") : c.state === "denied" ? dim("denied") : signal("standby");
  if (sub === "add") {
    let f;
    try { f = flags(rest, { string: ["wait"], list: ["item"] }); } catch (e) { return oops(e.message); }
    if (f._.length !== 1) return oops("vyre vault emergency add <person> [--wait 7d] [--item n ...]");
    const r = await tool("vault.emergency.add", { person: f._[0], ...(f.wait ? { wait: f.wait } : {}), ...(f.item.length ? { items: f.item } : {}) });
    if (r.error) return fail(r);
    const e = r.data.emergency;
    say(`  ${signal("emergency")} ${bold(e.person)} can ask; it opens ${e.wait} after they ask unless you deny it ${dim(`· ${plural(r.data.escrowed.length, "item")} sealed to them`)}`);
    say(dim("  they run: vyre vault emergency request <you>"));
    return 0;
  }
  if (sub === "list" || sub === undefined) {
    const r = await tool("vault.emergency.list");
    if (r.error) return fail(r);
    if (!r.data.contacts.length) { say(dim("  no emergency contacts · vyre vault emergency add <person>")); return 0; }
    say("");
    for (const c of r.data.contacts) say(`  ${bold(c.person)}  ${dim("wait " + c.wait)}  ${stateWords(c)}  ${dim(Array.isArray(c.items) ? c.items.join(", ") : c.items)}`);
    say("");
    return 0;
  }
  if (sub === "deny" || sub === "remove") {
    if (rest.length !== 1) return oops(`vyre vault emergency ${sub} <person>`);
    const r = await tool(`vault.emergency.${sub}`, { person: rest[0] });
    if (r.error) return fail(r);
    say(sub === "deny" ? `  ${signal("denied")} ${bold(rest[0])} ${dim("· they may ask again, and wait again")}` : `  ${signal("removed")} ${bold(rest[0])} ${dim("· the escrow is deleted")}`);
    if (r.data.warning) say(beacon(`  ${r.data.warning}`));
    return 0;
  }
  if (sub === "refresh") {
    if (rest.length > 1) return oops("vyre vault emergency refresh [person]");
    const r = await tool("vault.emergency.refresh", rest.length ? { person: rest[0] } : {});
    if (r.error) return fail(r);
    for (const x of r.data.refreshed) say(`  ${signal("refreshed")} ${bold(x.person)} ${dim(`· ${plural(x.items, "item")}`)}`);
    if (!r.data.refreshed.length) say(dim("  no emergency contacts"));
    return 0;
  }
  if (sub === "request" || sub === "status") {
    if (rest.length !== 1) return oops(`vyre vault emergency ${sub} <owner>`);
    const r = await tool(`vault.emergency.${sub}`, { owner: rest[0] });
    if (r.error) return fail(r);
    const d = r.data;
    if (d.state === "waiting") say(`  ${beacon("waiting")} ${bold(d.owner)}'s items open on ${day(d.opens)} unless they deny it`);
    else if (d.state === "released") say(`  ${signal("released")} from ${bold(d.owner)}: ${(d.added || d.items || []).join(", ")}${d.already ? dim(" · already here") : ""}`);
    else if (d.state === "denied") say(`  ${dim("denied")} ${bold(d.owner)} closed the request ${dim("· you may ask again")}`);
    else say(dim(`  ${d.owner} named you as an emergency contact; nothing asked yet · vyre vault emergency request ${d.owner}`));
    return 0;
  }
  return oops(`vyre vault emergency ${sub}: add, list, deny, remove, refresh, request or status`);
}

async function offboard(args) {
  const person = args.join(" ").trim();
  if (!person) return oops("vyre vault offboard <person>");
  const r = await tool("vault.offboard", { person });
  if (r.error) return fail(r);
  const { revoked = [], rotate = [] } = r.data;
  say(`  ${signal("offboarded")} ${bold(r.data.person)} ${dim(`· ${plural(revoked.length, "pass")} revoked`)}`);
  if (rotate.length) say(beacon(`  rotate: ${rotate.join(", ")}`) + dim(" · they received these sealed"));
  else say(dim("  nothing to rotate: every pass was relayed"));
  return 0;
}

async function remove(args) {
  if (args.length !== 1) return oops("vyre vault delete <name>");
  const r = await tool("vault.delete", { name: args[0] });
  if (r.error) return fail(r);
  say(`  ${signal("deleted")} ${bold(args[0])}`);
  return 0;
}

/**
 * Use an item someone relayed to you. `{{vault}}` in a header or the body is where their Vyre
 * adds the value; it never reaches this machine, and neither this command nor its output sees it.
 */
async function relayCmd(args) {
  let f;
  try { f = flags(args, { string: ["method", "data", "owner"], list: ["header"] }); } catch (e) { return oops(e.message); }
  const [item, url] = f._;
  if (!item || !url || f._.length > 2) return oops("vyre vault relay <item> <url> [--method M] [--header 'Name: value'] [--data body] [--owner o]");
  /** @type {Record<string, string>} */
  const headers = {};
  for (const h of f.header) {
    const i = h.indexOf(":");
    if (i < 1) return oops(`--header "${h}" is not Name: value`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const request = { url, method: f.method || (f.data !== undefined ? "POST" : "GET"), headers, ...(f.data !== undefined ? { body: f.data } : {}) };
  const r = await tool("vault.relay", { item, request, ...(f.owner ? { owner: f.owner } : {}) }, { timeout: 60_000 });
  if (r.error) return fail(r);
  hint(dim(`  ${r.data.status}${r.data.headers?.["content-type"] ? " · " + r.data.headers["content-type"] : ""}\n`));
  process.stdout.write(String(r.data.body ?? "") + (String(r.data.body ?? "").endsWith("\n") ? "" : "\n"));
  return r.data.status >= 200 && r.data.status < 400 ? 0 : 1;
}

// ------------------------------------------------------------ devices and backups

/** A passphrase typed twice on a terminal, once when piped. */
async function newPassphrase(what) {
  const a = await hiddenPrompt(`${what}: `);
  if (process.stdin.isTTY && (await hiddenPrompt("again: ")) !== a) throw new Error("the two did not match");
  return a;
}

async function pair(args) {
  const f = flags(args, { string: ["name"] });
  const r = await tool("vault.device.code", f.name ? { name: f.name } : {});
  if (r.error) return fail(r);
  say(`\n  pairing code  ${bold(signal(r.data.display || r.data.code))}  ${dim("· single use, for 5 minutes")}\n`);
  if (r.data.fill) say(`  fill address  ${bold(r.data.fill)}\n`);
  else say(beacon("  this vyred has no fill listener yet ") + dim("· set vault.fill in config.json\n"));
  say(dim("  type both into the Vyre extension's settings\n"));
  return 0;
}

async function devices(args) {
  if (args[0] === "revoke") {
    if (args.length !== 2) return oops("vyre vault devices revoke <id>");
    const r = await tool("vault.device.revoke", { id: args[1] });
    if (r.error) return fail(r);
    say(`  ${signal("revoked")} ${args[1]} ${dim("· its sessions end now")}`);
    return 0;
  }
  if (args[0] === "unlock") {
    if (args.length !== 2) return oops("vyre vault devices unlock <id>");
    const r = await tool("vault.device.unlock", { device: args[1] });
    if (r.error) return fail(r);
    say(`  ${signal("unlocked")} ${args[1]}${r.data.expires ? dim(" · until " + new Date(r.data.expires).toISOString().slice(11, 16)) : ""}`);
    return 0;
  }
  const r = await tool("vault.devices");
  if (r.error) return fail(r);
  const list = r.data.devices || [];
  if (!list.length) { say(dim("  no paired devices · vyre vault pair")); return 0; }
  for (const d of list) say(`  ${dim(d.id)}  ${bold(d.name)}  ${d.revoked ? dim("revoked") : d.sessions ? signal("unlocked") : dim("locked")}${d.lastSeen ? dim(" · seen " + day(d.lastSeen)) : ""}`);
  return 0;
}

async function unlockPassphrase() {
  let passphrase;
  try { passphrase = await newPassphrase("unlock passphrase for browser autofill"); } catch (e) { return oops(e.message); }
  const r = await tool("vault.unlock-passphrase", { passphrase });
  passphrase = "";
  if (r.error) return fail(r);
  say(`  ${signal("set")} ${dim("· paired extensions ask for it before they fill anything")}`);
  return 0;
}

async function backupCmd(args) {
  if (args.length !== 1) return oops("vyre vault backup <file>");
  let passphrase;
  try { passphrase = await newPassphrase("backup passphrase (12 characters or more)"); } catch (e) { return oops(e.message); }
  const r = await tool("vault.backup", { file: path.resolve(args[0]), passphrase }, { timeout: 60_000 });
  passphrase = "";
  if (r.error) return fail(r);
  say(`  ${signal("backed up")} ${plural(r.data.items, "item")} to ${bold(r.data.file)}`);
  say(dim("  it opens only with that passphrase; keep the two apart"));
  return 0;
}

async function restoreCmd(args) {
  const f = flags(args, { boolean: ["replace"] });
  if (f._.length !== 1) return oops("vyre vault restore <file> [--replace]");
  const file = path.resolve(f._[0]);
  let info;
  try { info = inspect(fs.readFileSync(file, "utf8").trim()); } catch (e) { return oops(`${file} is not a Vyre backup: ${e.message}`); }
  say(dim(`  backup from ${day(info.at)} · ${plural(info.items, "item")}`));
  let passphrase;
  try { passphrase = await hiddenPrompt("backup passphrase: "); } catch { return oops("cancelled"); }
  const r = await tool("vault.restore", { file, passphrase, mode: f.replace ? "replace" : "merge" }, { timeout: 60_000 });
  passphrase = "";
  if (r.error) return fail(r);
  const d = r.data;
  say(`  ${signal("restored")} ${plural(d.added.length, "item")}${d.kept.length ? dim(` · ${d.kept.length} already here, kept`) : ""} ${dim(`· identity ${d.identity}`)}`);
  return 0;
}

// ------------------------------------------------------------ lock

async function unlock() {
  let passphrase;
  try { passphrase = await hiddenPrompt("passphrase: "); } catch { return oops("cancelled"); }
  const r = await tool("vault.unlock", { passphrase });
  passphrase = "";
  if (r.error) return fail(r);
  say(`  ${signal("unlocked")}`);
  return 0;
}

async function lock() {
  const r = await tool("vault.lock");
  if (r.error) return fail(r);
  say(`  ${signal("locked")}`);
  return 0;
}

// ------------------------------------------------------------ account

/**
 * The account password, typed twice on a terminal. Piped, the first line is the password, and
 * a second line, if there is one, must match it.
 */
async function newPassword() {
  if (process.stdin.isTTY) {
    const a = await hiddenPrompt("new vault password (12 or more characters): ");
    if ((await hiddenPrompt("again: ")) !== a) throw new Error("the two did not match");
    return a;
  }
  const lines = (await hiddenPrompt("")).split(/\r?\n/);
  if (lines.length > 1 && lines[1] !== "" && lines[1] !== lines[0]) throw new Error("the two did not match");
  return lines[0];
}

/** One password line: prompted on a terminal, the first line when piped. */
async function onePassword(q) {
  const v = await hiddenPrompt(q);
  return process.stdin.isTTY ? v : v.split(/\r?\n/)[0];
}

async function account(args) {
  const [verb, ...rest] = args;
  if (verb === "create") {
    let password;
    try { password = await newPassword(); } catch (e) { return oops(e.message); }
    const r = await tool("vault.account.create", { password });
    password = "";
    if (r.error) return fail(r);
    say(`\n  ${signal("your personal vault has a password")}  ${dim(`account ${r.data.acct}`)}`);
    if (r.data.moved) say(dim(`  ${plural(r.data.moved, "item")} moved into it (logins, cards, notes, one-time codes)`));
    // The one time the Secret Key is shown. It is not written to any file here.
    say(`\n  Secret Key  ${bold(r.data.secretKey)}\n`);
    say(beacon("  write this down or run vyre vault kit now: ") + dim("it is shown this once, and with your password it is the only way into this vault on a new device\n"));
    return 0;
  }
  if (verb === "unlock") {
    let f;
    try { f = flags(rest, { boolean: ["touchid"] }); } catch (e) { return oops(e.message); }
    let input;
    if (f.touchid) input = { method: "touchid" };
    else {
      try { input = { password: await onePassword("vault password: ") }; } catch { return oops("cancelled"); }
    }
    const r = await tool("vault.account.unlock", input);
    input = null;
    if (r.error) return fail(r);
    say(`  ${signal("unlocked")} ${dim(`· personal vault${r.data.method === "touchid" ? ", with Touch ID" : ""}`)}`);
    return 0;
  }
  if (verb === "lock") {
    const r = await tool("vault.account.lock");
    if (r.error) return fail(r);
    say(`  ${signal("locked")} ${dim("· personal vault; agents keep what is granted to them")}`);
    return 0;
  }
  if (verb === "enroll-touchid") {
    let password;
    try { password = await onePassword("vault password: "); } catch { return oops("cancelled"); }
    const r = await tool("vault.account.enroll-touchid", { password });
    password = "";
    if (r.error) return fail(r);
    say(`  ${signal("Touch ID unlock is on")} ${dim("· vyre vault account unlock --touchid")}`);
    return 0;
  }
  if (verb === "status" || verb === undefined) {
    const r = await tool("vault.account.status");
    if (r.error) return fail(r);
    const d = r.data;
    if (!d.account) { say(dim("  no account password yet · vyre vault account create")); return 0; }
    say(`  account   ${bold(d.acct || "")}`);
    say(`  personal  ${d.unlocked ? signal("unlocked") : dim("locked")}`);
    say(`  Touch ID  ${d.touchid ? signal("on") : dim("off · vyre vault account enroll-touchid")}`);
    return 0;
  }
  return oops("vyre vault account create | unlock [--touchid] | lock | enroll-touchid | status");
}

async function migrateKey() {
  const r = await tool("vault.migrate-key");
  if (r.error) return fail(r);
  say(`  ${signal("done")} ${dim(`· vault key ${r.data.key ? "moved to this build" : "already fine"}, Secret Key ${r.data.secretKey ? "moved" : "already fine"}`)}`);
  return 0;
}

// ------------------------------------------------------------ dispatch

const HELP = [
  ["list [filter] [--kind k] [--host h]", "names, kinds and grants; never values"],
  ["get <item> [--reveal | --copy | --otp] [--field f]", "metadata; or the value, the clipboard, the code"],
  ["read vault://<item>/<field>", "one value on stdout; vault://<item>/otp is the current code"],
  ["add <name> ...", "the same as put"],
  ["edit <item> [--rename n] [--description d] [--url u] [--host +h|-h] [--field F] [--remove-field F]", "change in place; --field prompts for the new value"],
  ["rm <item>", "the same as delete"],
  ["inject -i <template> [-o <out>] [--force] [--reveal]", "fill {{ vault://item/field }}; -o is written by vyred, 0600"],
  ["share <item...> --with <person> [...]", "the same as pass create"],
  ["ssh keys | generate <name> [--type t] | add <name> --file f", "keys for the vault's ssh agent"],
  ["ssh approvals [--revoke [name]] | approve <id> | agent-line", "signing leases, and the IdentityAgent line"],
  ["ssh import [--dir ~/.ssh] | setup [name] [--git]", "move ~/.ssh keys in; the lines for ssh, your shell and git commit signing"],
  ["git-credential <get|store|erase>", "git's credential helper (bin/git-credential-vyre)"],
  ["put <name> [--kind k] [--description d] [--url u] [--host h ...] [--allow-body]", "prompts for the value without echo"],
  ["    [--username u] [--totp] [--field F ...] [--expires 90d] [--scope s ...] [--provider p] [--from file]", "kinds: " + KINDS.join(", ")],
  ["grant <name> <module> [--watcher w]", "let a module use an item"],
  ["revoke <name> <module> [--watcher w]", "take it back"],
  ["pending", "grants and passes an agent asked for"],
  ["approve <id>", "allow one of them"],
  ["run [--env-file f] <item...> -- <command...>", "items as VAR=name.field, or KEY=vault://item/field lines; output scrubbed"],
  ["totp <name>", "the current code, and the next"],
  ["sweep [path] [--history] [--shell]", "where your secrets sit in plain text: files, git history, shell history; places and names only"],
  ["rotate <name>", "a new credential at its provider (AWS, GitLab, Cloudflare, Google Cloud), or the page and steps"],
  ["codes [name...] | codes import <scanned code...> [--from f] [--preview]", "every one-time code, current and next; bring in a Google Authenticator export"],
  ["generate [--length n] [--words n] [--no-symbols] [name]", "a password; stored when named"],
  ["import <file|folder> [--preview] [--update-conflicts] [--rewrite] [--format f]", ".env files (a whole project), 1Password, Bitwarden, Chrome, Apple Passwords; --rewrite swaps .env values for vault:// refs"],
  ["audit [name] [--limit n]", "who used what, and when"],
  ["delete <name>", "remove an item and its grants"],
  ["card", "this Vyre's card, to share"],
  ["people [add <card> [--name n] | verify <name> <fingerprint>]", "who you share with; a changed key blocks new passes until verified"],
  ["fingerprint [person]", "yours, and the safety words you and they should both see"],
  ["kit", "print a recovery kit: a one-time page on this machine"],
  ["vaults [list | create <name> | rotate <vault> | sync [vault]]", "vaults shared with a team; items appear as <vault>/<item>"],
  ["members invite <vault> <person> [--role r] | accept <invite> | role <vault> <person> <role> | remove <vault> <person>", "who is in a shared vault"],
  ["move <item> <vault>", "move an item into a shared vault"],
  ["device join [--role full|storage] [--approval a] | approve <code> | list | sync", "your other devices: a Mac, or a box that stores and runs agents"],
  ["pass create <holder> <item...> [--sealed] [--card c] [--host h ...] [--method M ...] [--path /p ...] [--expires 30d] [--note n]", "share without handing over"],
  ["pass list | pass revoke <id> | pass accept <ticket>", ""],
  ["relay <item> <url> [--header 'Name: {{vault}}'] [--data d]", "use an item relayed to you; the value is added on its owner's box"],
  ["offboard <person>", "revoke everything they hold, list what to rotate"],
  ["emergency add <person> [--wait 7d] [--item n ...] | list | deny <person> | remove <person> | refresh | request <owner> | status <owner>", "a verified contact can open your items after a wait you can stop"],
  ["account create | unlock [--touchid] | lock | enroll-touchid | status", "the password (and Touch ID) for your personal vault"],
  ["unlock | lock", "for the passphrase keystore"],
  ["migrate-key", "after an update: move the keychain key to this build (macOS may ask you to allow it)"],
  ["pair [--name n] | devices [revoke|unlock <id>]", "browser extensions that autofill logins"],
  ["unlock-passphrase", "what an extension asks for before it fills"],
  ["backup <file> | restore <file> [--replace]", "the whole vault, sealed to a passphrase of its own"],
  ["--json", "on any command: the tool's {data} or {error} as one line; exit 3 presence, 4 locked"],
];

function help() {
  say(`\n  ${bold("vyre vault")} ${dim("· credentials, sealed; shared by pass; used without being seen")}\n`);
  for (const [u, s] of HELP) say(`  ${u}${s ? "\n      " + dim(s) : ""}`);
  say("");
  return 0;
}

/** `share <item...> --with <person> [...]`: a pass, said the way 1Password says it. */
async function share(args) {
  let f;
  try { f = flags(args, { string: ["with", "card", "expires", "note"], list: ["host"], boolean: ["sealed"] }); } catch (e) { return oops(e.message); }
  if (!f.with || !f._.length) return oops("vyre vault share <item...> --with <person> [--sealed] [--card c] [--host h ...] [--expires 30d] [--note n]");
  const rest = [f.with, ...f._];
  if (f.sealed) rest.push("--sealed");
  for (const k of ["card", "expires", "note"]) if (f[k] !== undefined) rest.push(`--${k}`, f[k]);
  for (const h of f.host) rest.push("--host", h);
  return pass(["create", ...rest]);
}

const SUBS = {
  list, ls: list, get, read, add: put, put, edit, rm: remove, delete: remove, inject, share, ssh, "git-credential": gitCredential,
  pair, devices, "unlock-passphrase": unlockPassphrase, backup: backupCmd, restore: restoreCmd, relay: relayCmd, grant, revoke, pending, approve, run, totp, codes: codesCmd, sweep: sweepCmd, rotate: rotateCmd, generate, import: importFile, audit, card, people, fingerprint: fingerprintCmd, kit, vaults, members, move, device, pass, offboard, emergency, unlock, lock, account, "migrate-key": migrateKey, help,
};

export default {
  name: "vault", order: 40, usage: "vyre vault <command>", summary: "credentials, sealed; shared by pass; used without being seen",
  // `vyre help vault` and `vyre vault <sub> --help` show the vault's own list of commands.
  help: () => help(),
  /** @param {string[]} argv */
  async run(argv) {
    // --json anywhere before a `--` (after it, the flag belongs to run's child).
    const at = argv.indexOf("--");
    const mine = at < 0 ? argv : argv.slice(0, at);
    JSON_MODE = mine.includes("--json");
    last = null; printed = false;
    const args = JSON_MODE ? [...mine.filter(a => a !== "--json"), ...(at < 0 ? [] : argv.slice(at))] : argv;
    const [sub, ...rest] = args;
    let code;
    if (sub === undefined) code = await list([]);
    else if (sub === "--help" || sub === "-h") code = help();
    else {
      const fn = SUBS[sub];
      if (!fn) { code = oops(`vyre vault ${sub}: not a vault command`); if (!JSON_MODE) help(); }
      else { try { code = await fn(rest); } catch (e) { code = oops(e.message); } }
    }
    if (JSON_MODE && !printed) jsonLine(last ? (last.error ? { error: last.error } : { data: last.data }) : { data: null });
    return code;
  },
};
