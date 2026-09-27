// @ts-check
// `vyre vault`: the Vault from the terminal (docs/adr/0001-vault-crypto.md).
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
import { personIO } from "./presence.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { dialogsAllowed } from "../../config/dialogs.js";
import { finished } from "node:stream/promises";
import os from "node:os";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { emit, viewing, nextFor, EXIT, openInBrowser } from "../kit.js";
import { derive, prompt } from "../view.js";
import fs from "node:fs";
import { hiddenPrompt, visiblePrompt, Scrubber, parseRunArgs, flags } from "../../vault/cli-io.js";
import { inspect } from "../../vault/backup.js";
import { templateRefs, render, parseEnvFile, parseRef } from "../../vault/refs.js";

// --json, on every command: the tool's own `{"data":...}` or `{"error":{code,message}}` as one
// line on stdout and nothing else there. Exit codes: 0 ok, 1 error, 3 presence refused or
// required, 4 the vault is locked. `run` keeps its child's output and exit code, and never
// prints the values it injected, in either mode.
//
// --view: the same line as a frame (core/cli/view.js), drawn by the verb's view in VIEWS: the
// items as a table, one item as a card, the recovery kit's address as a qr frame. Nothing is read
// from a terminal: a value, passphrase or password comes piped in with --stdin, and without it
// the verb is a prompt frame naming that flag, exit 2. The live code (totp) is one frame.
let JSON_MODE = false;
/** --stdin: under --view, the secret this verb needs comes piped in. */
let STDIN = false;
/** The words that ran this verb, for a prompt frame to run again with --stdin. */
let AGAIN = /** @type {string[]} */ (["vault"]);
/** The last reply from vyred, and whether --json has already printed a line for this command. */
let last = /** @type {any} */ (null);
let printed = false;
const say = (/** @type {string} */ s) => { if (!JSON_MODE) out(s); };
const hint = (/** @type {string} */ s) => { if (!JSON_MODE) process.stderr.write(s); };
const jsonLine = obj => { if (!printed) { emit(obj, viewing() ? viewOf(obj) : undefined); printed = true; } };

/**
 * Under --view with no --stdin: a prompt frame for the secret, naming the flag that pipes it in,
 * and exit 2. Null when the verb may go on and read it.
 * @param {string} label what to type
 */
function secretGate(label) {
  if (!viewing() || STDIN) return null;
  jsonLine({ prompt: "secret", label });
  return EXIT.USAGE;
}

/**
 * Every call to vyred goes through here, so --json can print the reply the command acted on. A
 * tool that needs the person (put, grant, reveal, copy and the rest) asks for their proof at this
 * terminal, as `vyre learn` does; a tool that does not answers the first call as before.
 */
async function tool(name, input = {}, opts) {
  const r = await callAsPerson(name, input, { timeout: opts && opts.timeout, io: personIO() });
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
const KINDS = ["secret", "api-key", "login", "card", "note", "env-set", "ssh-key"];

/** An origin from a url a person typed, which may lack the scheme. */
function origin(url) {
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "https://" + url).origin; } catch { return null; }
}

const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

const grantText = g => g.module + (g.watcher ? `/${g.watcher}` : "");

// ------------------------------------------------------------ list

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
    ].filter(Boolean);
    if (meta.length) say(dim(`    ${meta.join(" · ")}`));
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
  try { f = flags(args, { string: ["field"], boolean: ["reveal", "copy", "otp", "once"] }); } catch (e) { return oops(e.message); }
  const name = f._[0];
  if (!name || f._.length > 1) return oops("vyre vault get <item> [--reveal | --copy | --otp [--once]] [--field f]");
  if ([f.reveal, f.copy, f.otp].filter(Boolean).length > 1) return oops("choose one of --reveal, --copy and --otp");
  const field = f.field ? { field: f.field } : {};
  if (f.otp) return totp(f.once ? [name, "--once"] : [name]);
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
    const gate = secretGate(`The new ${f.field[0]} for ${name}`);
    if (gate !== null) return gate;
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
  return oops(`vyre vault ssh ${sub}: keys, generate, add, approvals [--revoke], approve or agent-line`);
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
  const f = flags(args, { string: ["kind", "description", "url", "username"], list: ["host", "field"], boolean: ["totp", "allow-body"] });
  if (f._.length !== 1) {
    if (f._.length === 0) return oops("vyre vault put <name> [--kind k] [--description d] [--url u] [--host h ...]");
    return oops("values are never taken on the command line, where shell history and your agents would see them. " +
      `Run vyre vault put ${f._[0]} and type it at the prompt, or pipe it in.`);
  }
  const name = f._[0];
  const kind = f.kind || "secret";
  if (!KINDS.includes(kind)) return oops(`--kind is one of ${KINDS.join(", ")}`);
  const tty = !viewing() && !!process.stdin.isTTY;
  if (kind !== "env-set" || f.field.length) {
    const gate = secretGate(kind === "login" ? `The password for ${name}` : kind === "note" ? `The note ${name}` : kind === "card" ? `The card ${name}` : `The value of ${name}`);
    if (gate !== null) return gate;
  }

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
    } else if (kind === "env-set") {
      if (!f.field.length) return oops("an env-set needs its variable names: --field NAME --field OTHER");
      if (!tty && f.field.length > 1) return oops("with piped input an env-set takes one --field; use a terminal for more");
      for (const k of f.field) await hidden(k, `${k}: `);
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
  const { grants = [], passes = [], people = [], accepts = [] } = r.data;
  if (!grants.length && !passes.length && !people.length && !accepts.length) { say(dim("  nothing waiting for approval")); return 0; }
  say("");
  for (const g of grants) say(`  ${beacon(g.id)}  grant ${bold(g.name)} to ${grantText(g)}`);
  for (const p of passes) say(`  ${beacon(p.id)}  ${p.mode || "relayed"} pass for ${bold(p.holder)}: ${(p.items || []).join(", ")}${p.expires ? dim(" · until " + day(p.expires)) : ""}`);
  for (const p of people) say(`  ${beacon(p.id)}  trust the card for ${bold(p.name)} ${dim("· fingerprint " + (p.fingerprint || "unreadable"))}`);
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
  // Under --view the child gets no stdin either: a surface runs it and there is no one to type.
  const child = spawn(bin, rest, { env: { ...process.env, ...env }, stdio: [viewing() ? "ignore" : "inherit", "pipe", "pipe"] });
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

// ------------------------------------------------------------ one-time codes

/** The live view stops on its own after this, so a forgotten terminal does not ask for codes all day. */
export const TOTP_LIVE_MS = 5 * 60_000;
const BAR = 20;

/** Digits grouped as the Deck shows them: 123 456, 1234 5678. Anything else as it came. */
export function groupCode(code) {
  const c = String(code ?? "");
  if (/^\d{6}$/.test(c)) return c.slice(0, 3) + " " + c.slice(3);
  if (/^\d{8}$/.test(c)) return c.slice(0, 4) + " " + c.slice(4);
  return c;
}

/**
 * When the code vault.totp just returned stops being valid, on the local clock. The tool's
 * `remaining` is whole seconds, so `fetchedAt + remaining` is up to a second past the real end;
 * TOTP periods start on multiples of `period` since the epoch, so snap to the nearest one.
 * @param {number} fetchedAt @param {number} remaining @param {number} period
 */
export function periodEnd(fetchedAt, remaining, period) {
  const p = Math.max(1, Number(period) || 30) * 1000;
  return Math.round((fetchedAt + Math.max(0, Number(remaining) || 0) * 1000) / p) * p;
}

/**
 * One frame of the live code: the grouped code, a text bar of the seconds left, and the count.
 * Pure, so the countdown is tested without a terminal or a clock.
 * @param {{ now: number, endsAt: number, period: number, code: string, next?: string, paint?: boolean }} f
 * @returns {{ line: string, left: number }}
 */
export function totpFrame({ now, endsAt, period, code, next, paint = true }) {
  const p = Math.max(1, Number(period) || 30);
  const left = Math.max(0, Math.min(p, Math.ceil((endsAt - now) / 1000)));
  const full = Math.round((left / p) * BAR);
  const low = left <= 5;
  const c = (/** @type {(s: string) => string} */ fn, /** @type {string} */ s) => (paint ? fn(s) : s);
  const bar = c(low ? beacon : signal, "█".repeat(full)) + c(dim, "░".repeat(BAR - full));
  const line = `  ${c(bold, c(low ? beacon : signal, groupCode(code)))}  ${bar} ${c(dim, `${String(left).padStart(2)}s`)}` +
    (next ? c(dim, `  next ${groupCode(next)}`) : "");
  return { line, left };
}

/**
 * @typedef {{ now(): number, write(s: string): void, every(ms: number, fn: () => void): () => void,
 *   keys(onQuit: () => void, onEnter?: () => void): () => void }} LiveIO
 */

/** The terminal for the live code: a one-second timer, q, Esc or Ctrl-C to quit, Enter for another. */
const liveIO = /** @type {LiveIO} */ ({
  now: () => Date.now(),
  write: s => { process.stdout.write(s); },
  every: (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
  keys: (onQuit, onEnter) => {
    const stdin = process.stdin;
    const onSig = () => onQuit();
    process.on("SIGINT", onSig);
    if (!stdin.isTTY) return () => { process.removeListener("SIGINT", onSig); };
    const onData = (/** @type {Buffer} */ b) => { const k = b.toString("utf8"); if (k === "q" || k === "Q" || k === "\x1b" || k === "\x03") onQuit(); else if ((k === "\r" || k === "\n") && onEnter) onEnter(); };
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    return () => {
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      process.removeListener("SIGINT", onSig);
    };
  },
});

/**
 * The live code: redrawn in place each second from the local clock. When the period ends the code
 * is gone and the next one waits for Enter, since from a terminal every code asks for its own
 * proof (ADR 0004, the CLI's window covers no codes). With `auto`, one vault.totp call when a
 * period rolls over instead (never one a second). Resolves with the exit code when the person
 * quits, the time runs out, or a fetch fails.
 * @param {{ code: string, period: number, remaining: number, next?: string }} first
 * @param {{ fetch: () => Promise<any>, io?: LiveIO, maxMs?: number, paint?: boolean, name?: string, auto?: boolean }} o
 */
export function liveTotp(first, { fetch, io = liveIO, maxMs = TOTP_LIVE_MS, paint = true, name = "<name>", auto = false }) {
  const started = io.now();
  let cur = first;
  let endsAt = periodEnd(started, cur.remaining, cur.period);
  let fetching = false, done = false, want = auto;
  /** @type {() => void} */ let stopTick = () => {};
  /** @type {() => void} */ let stopKeys = () => {};
  const clear = "\r\x1b[2K";
  const draw = () => io.write(clear + totpFrame({ now: io.now(), endsAt, period: cur.period, code: cur.code, next: cur.next, paint }).line);
  return new Promise(resolve => {
    const finish = (/** @type {number} */ code, /** @type {string} */ why = "") => {
      if (done) return;
      done = true;
      stopTick(); stopKeys();
      io.write((why ? clear + why : "") + "\x1b[?25h\n");
      resolve(code);
    };
    const tick = async () => {
      if (done || fetching) return;
      const now = io.now();
      if (now - started >= maxMs) return finish(0, dim(`  stopped after ${Math.round(maxMs / 60_000)} minutes · vyre vault totp ${name} for more`));
      if (now >= endsAt && !want) {
        io.write(clear + (paint ? dim : String)(`  expired · Enter for a new code (asks again) · q quits`));
        return;
      }
      if (now >= endsAt) {
        fetching = true;
        want = auto;
        io.write(clear);
        // The terminal back in its normal mode meanwhile: if this call asks for the terminal code,
        // the person types it at a line prompt, not into our key reader.
        stopKeys();
        const r = await fetch();
        fetching = false;
        if (!done) stopKeys = io.keys(() => finish(0), onEnter);
        if (done) return;
        if (r.error) { last = r; return finish(exitFor(r), beacon(`  ${r.error.code}: `) + String(r.error.message || "")); }
        const prev = endsAt;
        cur = r.data;
        endsAt = periodEnd(io.now(), cur.remaining, cur.period);
        // vyred's clock a little behind ours: keep to one call a period rather than asking again next second.
        if (endsAt <= prev) endsAt = prev + Math.max(1, Number(cur.period) || 30) * 1000;
      }
      draw();
    };
    const onEnter = () => { if (!done && !fetching && io.now() >= endsAt) { want = true; tick(); } };
    io.write("\x1b[?25l");
    draw();
    stopTick = io.every(1000, () => { tick(); });
    stopKeys = io.keys(() => finish(0), onEnter);
  });
}

async function totp(args) {
  let f;
  try { f = flags(args, { boolean: ["once"] }); } catch (e) { return oops(e.message); }
  const name = f._[0];
  if (!name || f._.length > 1) return oops("vyre vault totp <name> [--once]");
  const r = await tool("vault.totp", { name });
  if (r.error) return fail(r);
  if (JSON_MODE) return 0;
  const d = r.data;
  // Piped: the code alone on stdout, for $(...), and the seconds on stderr.
  if (!process.stdout.isTTY) { process.stdout.write(`${d.code}\n`); hint(`  ${d.remaining}s left\n`); return 0; }
  if (f.once) {
    say(totpFrame({ now: Date.now(), endsAt: periodEnd(Date.now(), d.remaining, d.period), period: d.period, code: d.code, next: d.next }).line);
    return 0;
  }
  return liveTotp(d, { name, fetch: () => tool("vault.totp", { name }) });
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
  const f = flags(args, { string: ["format"] });
  if (f._.length !== 1) return oops("vyre vault import <file> [--format f]");
  const file = path.resolve(f._[0]);
  const r = await tool("vault.import", { file, ...(f.format ? { format: f.format } : {}) });
  if (r.error) return fail(r);
  const { format, added = [], duplicate = [], skipped = [], advice } = r.data;
  say(`  ${signal(plural(added.length, "item"))} added from ${format} ${dim(`· ${duplicate.length} already here · ${skipped.length} skipped`)}`);
  if (added.length) say(`    ${added.join(", ")}`);
  if (duplicate.length) say(dim(`  already in the vault: ${duplicate.join(", ")}`));
  for (const s of skipped) say(dim(`  skipped: ${s}`));
  if (advice) say(beacon(`  ${advice}`));
  return 0;
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

// ------------------------------------------------------------ Watchtower, breaches, history

/** The Deck's Watchtower words (deck/vault/model.js REASON), in the order it lists them. */
const REASONS = [
  ["weak", "weak", "easy to guess · vyre vault generate <name> makes a strong one"],
  ["reused", "reused", "the same value is in more than one item"],
  ["rotate", "rotate", "a copy left this box · replace the value to clear it"],
  ["old", "old", "not changed for more than a year"],
  ["2fa-available", "two-factor available", "the site offers one-time codes · vyre vault edit <item> --field totp"],
  ["unprotected", "not yet protected", "still opened without your password · vyre vault account create"],
];

/** `health`: Watchtower. Names and reason codes from vyred, never a value. */
async function health(args) {
  if (args.length) return oops("vyre vault health");
  const r = await tool("vault.health");
  if (r.error) return fail(r);
  const { items = [], counts = {}, checked = 0 } = r.data || {};
  say("");
  say(`  ${bold("Watchtower")} ${dim(`· ${plural(checked, "item")} checked`)}`);
  say("  " + REASONS.map(([k, label]) => (counts[k] ? beacon(`${counts[k]} ${label}`) : dim(`0 ${label}`))).join(dim(" · ")));
  if (!items.length) { say(`\n  ${signal("nothing to fix")}\n`); return 0; }
  for (const [k, label, why] of REASONS) {
    const rows = items.filter(i => (i.reasons || []).includes(k));
    if (!rows.length) continue;
    say(`\n  ${bold(label)} ${dim(`· ${why}`)}`);
    if (k === "reused") {
      const groups = new Map();
      for (const i of rows) { const g = i.group || i.name; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i.name); }
      for (const names of groups.values()) say(`    ${names.map(n => bold(n)).join(dim(", "))} ${dim("· same value")}`);
    } else for (const i of rows) say(`    ${bold(i.name)}  ${dim(i.kind)}`);
  }
  say("");
  return 0;
}

/** `breach`: every login's password against known breaches, by k-anonymity. Opt-in, and a network call. */
async function breach(args) {
  if (args.length) return oops("vyre vault breach checks every login at once (only the first 5 characters of each password's SHA-1 leave); it takes no item");
  const r = await tool("vault.breach.check", {}, { timeout: 120_000 });
  if (r.error) {
    if (!JSON_MODE && /breach check is off/.test(String(r.error.message))) {
      last = r;
      out(beacon("  the breach check is off ") + dim('· set "vault": { "breach": "ask" } in config.json, then vyre restart; every check still asks you first'));
      return 1;
    }
    return fail(r);
  }
  const { breached = [], checked = 0 } = r.data || {};
  if (!breached.length) { say(`  ${signal("none found")} ${dim(`· none of ${plural(checked, "password")} appears in a known breach`)}`); return 0; }
  say(`  ${beacon(`${breached.length} of ${plural(checked, "password")}`)} appear in known breaches ${dim("· replace them: vyre vault edit <item> --field password")}`);
  for (const n of breached) say(`    ${bold(n)}`);
  return 0;
}

/** `history <item> [--field f]`: versions, who and which fields changed. Never a value. */
async function history(args) {
  let f;
  try { f = flags(args, { string: ["field"] }); } catch (e) { return oops(e.message); }
  if (f._.length !== 1) return oops("vyre vault history <item> [--field f]");
  const r = await tool("vault.history", { name: f._[0], ...(f.field ? { field: f.field } : {}) });
  if (r.error) return fail(r);
  const entries = r.data.entries || [];
  if (!entries.length) { say(dim(f.field ? `  no version of ${f._[0]} changed ${f.field}` : `  no versions of ${f._[0]} kept yet`)); return 0; }
  say("");
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 16);
    const tag = e.current ? signal("current") : e.readable ? dim("kept   ") : dim("gone   ");
    say(`  ${bold(("v" + e.version).padEnd(5))} ${tag}  ${dim(when)}  ${(e.changed || []).join(", ") || dim("no fields")}  ${dim("by " + e.by)}`);
  }
  const back = entries.find(e => !e.current && e.readable);
  if (back) say(dim(`\n  vyre vault revert ${f._[0]} <version> puts one back, as a new version`));
  say("");
  return 0;
}

/** `revert <item> <version>`: an older version's fields back, as a new version. */
async function revert(args) {
  const [name, v, ...more] = args;
  const version = Number(v);
  if (!name || v === undefined || more.length) return oops("vyre vault revert <item> <version> · vyre vault history <item> lists the versions");
  if (!Number.isInteger(version) || version < 1) return oops(`${v} is not a version · vyre vault history ${name} lists them`);
  const r = await tool("vault.revert", { name, version });
  if (r.error) return fail(r);
  say(`  ${signal("reverted")} ${bold(r.data.name)} ${dim(`· version ${r.data.from} is back, as version ${r.data.version}`)}`);
  return 0;
}

/** `clear-clipboard`: take a copied value off the clipboard now, if it is still there. */
async function clearClipboard(args) {
  if (args.length) return oops("vyre vault clear-clipboard");
  const r = await tool("vault.clipboard.clear");
  if (r.error) return fail(r);
  say(`  ${signal("cleared")} ${dim("· anything the vault copied is off the clipboard")}`);
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
  if (process.stdout.isTTY && !viewing() && !process.env.VYRE_NO_OPEN && dialogsAllowed()) openInBrowser(r.data.url);
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
  const gate = secretGate("The unlock passphrase for browser autofill");
  if (gate !== null) return gate;
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
  const gate = secretGate("A passphrase for the backup (12 characters or more)");
  if (gate !== null) return gate;
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
  const gate = secretGate("The backup's passphrase");
  if (gate !== null) return gate;
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
  const gate = secretGate("The vault's passphrase");
  if (gate !== null) return gate;
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
    const gate = secretGate("A new vault password (12 or more characters)");
    if (gate !== null) return gate;
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
      const gate = secretGate("The vault password");
      if (gate !== null) return gate;
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
    const gate = secretGate("The vault password");
    if (gate !== null) return gate;
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
  ["get <item> [--reveal | --copy | --otp [--once]] [--field f]", "metadata; or the value, the clipboard, the code"],
  ["read vault://<item>/<field>", "one value on stdout; vault://<item>/otp is the current code"],
  ["add <name> ...", "the same as put"],
  ["edit <item> [--rename n] [--description d] [--url u] [--host +h|-h] [--field F] [--remove-field F]", "change in place; --field prompts for the new value"],
  ["rm <item>", "the same as delete"],
  ["inject -i <template> [-o <out>] [--force] [--reveal]", "fill {{ vault://item/field }}; -o is written by vyred, 0600"],
  ["share <item...> --with <person> [...]", "the same as pass create"],
  ["ssh keys | generate <name> [--type t] | add <name> --file f", "keys for the vault's ssh agent"],
  ["ssh approvals [--revoke [name]] | approve <id> | agent-line", "signing leases, and the IdentityAgent line"],
  ["git-credential <get|store|erase>", "git's credential helper (bin/git-credential-vyre)"],
  ["put <name> [--kind k] [--description d] [--url u] [--host h ...] [--allow-body]", "prompts for the value without echo"],
  ["    [--username u] [--totp] [--field F ...]", "kinds: " + KINDS.join(", ")],
  ["grant <name> <module> [--watcher w]", "let a module use an item"],
  ["revoke <name> <module> [--watcher w]", "take it back"],
  ["pending", "grants and passes an agent asked for"],
  ["approve <id>", "allow one of them"],
  ["run [--env-file f] <item...> -- <command...>", "items as VAR=name.field, or KEY=vault://item/field lines; output scrubbed"],
  ["totp <name> [--once]", "the code, live: redrawn each second, the next one fetched as a period ends; q to stop"],
  ["health", "Watchtower: weak, reused, old and to-rotate items, by name"],
  ["breach", "check every login's password against known breaches (opt-in: vault.breach \"ask\")"],
  ["history <item> [--field f] | revert <item> <version>", "an item's versions, and putting one back"],
  ["clear-clipboard", "take what the vault copied off the clipboard now"],
  ["generate [--length n] [--words n] [--no-symbols] [name]", "a password; stored when named"],
  ["import <file> [--format f]", ".env, 1Password, Bitwarden, Chrome, Safari"],
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
  ["account create | unlock [--touchid] | lock | enroll-touchid | status", "the password (and Touch ID) for your personal vault"],
  ["unlock | lock", "for the passphrase keystore"],
  ["migrate-key", "after an update: move the keychain key to this build (macOS may ask you to allow it)"],
  ["pair [--name n] | devices [revoke|unlock <id>]", "browser extensions that autofill logins"],
  ["unlock-passphrase", "what an extension asks for before it fills"],
  ["backup <file> | restore <file> [--replace]", "the whole vault, sealed to a passphrase of its own"],
  ["--json", "on any command: the tool's {data} or {error} as one line; exit 3 presence, 4 locked"],
  ["--view --stdin", "for the Capsule, chat and the phone: frames; a secret comes piped in with --stdin, else exit 2"],
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

// ------------------------------------------------------------ views (--view)

/** The verb and its first word, for VIEWS: "ssh keys", "pass list", or the verb alone. */
let SUB = "list";

const table = (title, rows, columns, empty) => ({ kind: "table", title, rows, empty: empty || "Nothing here yet",
  columns: columns.map(([key, label]) => ({ key, label })) });
const when = ms => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "");
const joined = a => (Array.isArray(a) ? a.join(", ") : a || "");

/** How to draw a verb's data when the derived view is poor. Each gets the tool's data (inside {data}). */
const VIEWS = {
  list: d => table(d.locked ? "Vault (locked: vyre vault unlock)" : "Vault", (d.items || []).map(it => ({ name: it.name, kind: it.kind, description: it.description || "",
    fields: joined(it.fields), hosts: joined(it.hosts), grants: (it.grants || []).map(grantText).join(", ") })),
  [["name", "Item"], ["kind", "Kind"], ["description", "Description"], ["fields", "Fields"], ["hosts", "Hosts"], ["grants", "Granted to"]], "The vault is empty"),
  get: d => d.item ? { kind: "card", title: d.item.name, state: d.item.rotate || d.item.stale ? "failed" : undefined, fields: [
    { label: "Kind", value: String(d.item.kind) }, ...(d.item.description ? [{ label: "Description", value: d.item.description }] : []),
    ...(d.item.fields?.length ? [{ label: "Fields", value: joined(d.item.fields) }] : []), ...(d.item.url ? [{ label: "Url", value: d.item.url }] : []),
    ...(d.item.hosts?.length ? [{ label: "Hosts", value: joined(d.item.hosts) }] : []), ...(d.item.grants?.length ? [{ label: "Granted to", value: d.item.grants.map(grantText).join(", ") }] : []),
    ...(d.item.updated ? [{ label: "Updated", value: day(d.item.updated) }] : [])] } : derive(d),
  pending: d => table("Waiting for approval · vyre vault approve <id>", [
    ...(d.grants || []).map(g => ({ id: g.id, what: `grant ${g.name} to ${grantText(g)}` })),
    ...(d.passes || []).map(p => ({ id: p.id, what: `${p.mode || "relayed"} pass for ${p.holder}: ${joined(p.items)}` })),
    ...(d.people || []).map(p => ({ id: p.id, what: `trust the card for ${p.name} (${p.fingerprint || "unreadable"})` })),
    ...(d.accepts || []).map(a => ({ id: a.id, what: `accept a ${a.mode || ""} pass from ${a.owner}: ${joined(a.items)}` }))],
  [["id", "Id"], ["what", "Waiting"]], "Nothing waiting for approval"),
  audit: d => table("Audit", (d.entries || []).map(e => ({ at: when(e.at), action: e.action, name: e.name || "", who: e.who, result: e.ok ? "ok" : `refused${e.why ? " " + e.why : ""}` })),
    [["at", "When"], ["action", "Action"], ["name", "Item"], ["who", "By"], ["result", "Result"]], "No audit entries yet"),
  health: d => table(`Watchtower · ${d.checked || 0} checked`, (d.items || []).map(i => ({ name: i.name, kind: i.kind, reasons: joined(i.reasons) })),
    [["name", "Item"], ["kind", "Kind"], ["reasons", "Why"]], "Nothing to fix"),
  breach: d => table(`Breaches · ${d.checked || 0} passwords checked`, (d.breached || []).map(name => ({ name })), [["name", "In a known breach"]], "None found"),
  history: d => table("Versions", (d.entries || []).map(e => ({ version: `v${e.version}`, state: e.current ? "current" : e.readable ? "kept" : "gone", at: when(e.at), changed: joined(e.changed), by: e.by })),
    [["version", "Version"], ["state", "State"], ["at", "When"], ["changed", "Changed"], ["by", "By"]], "No versions kept yet"),
  people: d => table("People", (d.people || []).map(p => ({ name: p.name, fingerprint: p.fingerprint, state: p.blocked ? (p.changed ? "key changed" : "unverified v1 card") : p.verified ? "verified" : "pinned" })),
    [["name", "Name"], ["fingerprint", "Fingerprint"], ["state", "State"]], "No one yet"),
  "people list": d => VIEWS.people(d),
  "vaults list": d => table("Shared vaults", (d.vaults || []).map(v => ({ name: v.name, role: v.role, members: (v.members || []).length, items: (v.items || []).length, conflicts: v.conflicts || 0 })),
    [["name", "Vault"], ["role", "Your role"], ["members", "Members"], ["items", "Items"], ["conflicts", "Conflicts"]], "No shared vaults"),
  vaults: d => VIEWS["vaults list"](d),
  "device list": d => table("Devices with this vault", d.devices || [], [["name", "Device"], ["role", "Role"], ["fingerprint", "Fingerprint"]], "This vault is on one device"),
  device: d => d.devices ? VIEWS["device list"](d) : derive(d),
  "pass list": d => table("Passes", [...(d.passes || []).map(p => ({ id: p.id, way: "given", who: p.holder, items: joined(p.items), mode: p.mode || "", status: p.status || "" })),
    ...(d.held || []).map(h => ({ id: h.id, way: "held", who: h.owner, items: joined(h.items), mode: h.mode || "", status: "" }))],
  [["id", "Id"], ["way", "Given or held"], ["who", "Holder or owner"], ["items", "Items"], ["mode", "Mode"], ["status", "Status"]], "No passes given or held"),
  pass: d => (d.passes || d.held ? VIEWS["pass list"](d) : derive(d)),
  devices: d => d.devices ? table("Browser extensions", d.devices.map(x => ({ id: x.id, name: x.name, state: x.revoked ? "revoked" : x.sessions ? "unlocked" : "locked", seen: x.lastSeen ? day(x.lastSeen) : "" })),
    [["name", "Extension"], ["id", "Id"], ["state", "State"], ["seen", "Last seen"]], "No paired devices") : derive(d),
  ssh: d => d.keys ? table(d.socket ? `SSH keys · agent ${d.socket}` : "SSH keys · the agent is off", d.keys.map(k => ({ name: k.name, type: k.type || "", fingerprint: k.fingerprint || k.problem || "" })),
    [["name", "Key"], ["type", "Type"], ["fingerprint", "Fingerprint"]], "No ssh keys") : derive(d),
  "ssh keys": d => VIEWS.ssh(d),
  "ssh approvals": d => d.leases || d.waiting ? table("SSH approvals", [...(d.leases || []).map(l => ({ id: "", what: `${l.name} for ${l.host}`, until: when(l.expires) })),
    ...(d.waiting || []).map(w => ({ id: w.id, what: w.summary, until: "waiting: vyre vault ssh approve " + w.id }))], [["what", "Lease"], ["until", "Until"], ["id", "Id"]], "No ssh approvals") : derive(d),
  "account status": d => ({ kind: "card", title: "Personal vault", state: d.account ? (d.unlocked ? "ok" : "wait") : "wait", fields: d.account
    ? [{ label: "Account", value: String(d.acct || "") }, { label: "Personal", value: d.unlocked ? "unlocked" : "locked" }, { label: "Touch ID", value: d.touchid ? "on" : "off" }]
    : [{ label: "No account password yet", value: "vyre vault account create" }] }),
  account: d => (d && "account" in d && "unlocked" in d ? VIEWS["account status"](d) : derive(d)),
  card: d => ({ kind: "card", title: String(d.name || "Your card"), fields: [...(d.fingerprint ? [{ label: "Fingerprint", value: d.fingerprint }] : []),
    { label: "Relay", value: d.relay || "no relay address yet" }, { label: "Card", value: String(d.card || "") }] }),
  fingerprint: d => ({ kind: "card", title: "Fingerprints", fields: [{ label: "Yours", value: String(d.fingerprint) },
    ...(d.person ? [{ label: `${d.person.name}${d.person.verified ? ", verified" : ""}`, value: String(d.person.fingerprint) }, { label: "Read these to each other", value: joined(d.words).replace(/, /g, " ") }] : [])] }),
  totp: d => ({ kind: "card", title: "One-time code", state: "ok", fields: [{ label: "Code", value: groupCode(d.code) }, { label: "Left", value: `${d.remaining} s` },
    ...(d.next ? [{ label: "Next", value: groupCode(d.next) }] : [])] }),
  kit: d => ({ kind: "qr", text: String(d.url), caption: `Your recovery kit: open it once on this machine, before ${new Date(d.expires).toISOString().slice(11, 16)} UTC. Print it and write your password on it by hand.` }),
  pair: d => ({ kind: "card", title: "Pair a browser extension", state: "wait", fields: [{ label: "Pairing code", value: String(d.display || d.code) },
    { label: "Fill address", value: d.fill || "this vyred has no fill listener yet (vault.fill in config.json)" }, { label: "Where", value: "the Vyre extension's settings; single use, for 5 minutes" }] }),
};

/** The view of the one line vault prints: its {data}, {error} or a prompt for a secret. @param {any} obj */
function viewOf(obj) {
  if (obj && obj.prompt) {
    return prompt({ name: "secret", label: String(obj.label), secret: true,
      args: [...AGAIN.filter(a => a !== "--stdin"), "--stdin"], answer: "stdin" });
  }
  if (obj && obj.error) {
    const next = nextFor(obj.error);
    return { kind: "error", code: String(obj.error.code || "failed"), message: String(obj.error.message || obj.error.code), ...(next ? { next } : {}) };
  }
  const d = obj ? obj.data : null;
  if (d === null || d === undefined) return { kind: "text", lines: [] };
  const v = VIEWS[/** @type {keyof typeof VIEWS} */ (SUB)] || VIEWS[/** @type {keyof typeof VIEWS} */ (SUB.split(" ")[0])];
  try { return v ? v(d) : derive(d); } catch { return derive(d); }
}

const SUBS = {
  list, ls: list, get, read, add: put, put, edit, rm: remove, delete: remove, inject, share, ssh, "git-credential": gitCredential,
  pair, devices, "unlock-passphrase": unlockPassphrase, backup: backupCmd, restore: restoreCmd, relay: relayCmd, grant, revoke, pending, approve, run, totp, health, breach, history, revert, "clear-clipboard": clearClipboard, generate, import: importFile, audit, card, people, fingerprint: fingerprintCmd, kit, vaults, members, move, device, pass, offboard, unlock, lock, account, "migrate-key": migrateKey, help,
};

/** Every verb run() handles, for `vyre commands` (core/cli/verbs.js); an alias shares its verb's row. */
const VERBS = [
  { verb: "list", aliases: ["ls"], summary: "names, kinds and grants; never values", usage: "[filter] [--kind k] [--host h]", read: true },
  { verb: "get", summary: "an item's metadata; or the value, the clipboard, the code", usage: "<item> [--reveal] [--copy] [--otp] [--once] [--field f]", read: true },
  { verb: "read", summary: "one value on stdout; vault://<item>/otp is the current code", usage: "<ref> [--no-newline]", person: true },
  { verb: "put", aliases: ["add"], summary: "store a value, typed without echo (or piped in with --stdin)", usage: "<name> [--kind k] [--description d] [--url u] [--host h] [--username u] [--totp] [--field f] [--allow-body] [--stdin]", person: true },
  { verb: "edit", summary: "change an item in place; --field asks for the new value", usage: "<item> [--rename n] [--description d] [--url u] [--host h] [--field f] [--remove-field f] [--stdin]", person: true },
  { verb: "delete", aliases: ["rm"], summary: "remove an item and its grants", usage: "<name>", person: true },
  { verb: "inject", summary: "fill {{ vault://item/field }} in a template (-i and -o work too)", usage: "[--in template] [--out file] [--force] [--reveal]", person: true },
  { verb: "share", summary: "the same as pass create", usage: "<item...> [--with person] [--sealed] [--card c] [--host h] [--expires e] [--note n]", person: true },
  { verb: "ssh", summary: "keys for the vault's ssh agent, and its signing leases", usage: "[keys|generate|add|approvals|approve|agent-line] [name] [--type t] [--comment c] [--file f] [--revoke] [--host h]" },
  { verb: "git-credential", summary: "git's credential helper (reads git's request on stdin)", usage: "<get|store|erase>" },
  { verb: "pair", summary: "a pairing code for a browser extension that autofills logins", usage: "[--name n]", person: true },
  { verb: "devices", summary: "paired browser extensions; revoke or unlock one", usage: "[revoke|unlock] [id]", read: true },
  { verb: "unlock-passphrase", summary: "what an extension asks for before it fills", usage: "[--stdin]", person: true },
  { verb: "backup", summary: "the whole vault, sealed to a passphrase of its own", usage: "<file> [--stdin]", person: true },
  { verb: "restore", summary: "put a vault backup back", usage: "<file> [--replace] [--stdin]", person: true },
  { verb: "relay", summary: "use an item relayed to you; the value is added on its owner's box", usage: "<item> <url> [--method m] [--header h] [--data d] [--owner o]", person: true },
  { verb: "grant", summary: "let a module use an item", usage: "<name> <module> [--watcher w]", person: true },
  { verb: "revoke", summary: "take a grant back", usage: "<name> <module> [--watcher w]" },
  { verb: "pending", summary: "grants and passes an agent asked for", usage: "", read: true },
  { verb: "approve", summary: "allow one of them", usage: "<id>", person: true },
  { verb: "run", summary: "run a command with items in its environment, its output scrubbed (the command goes after --)", usage: "[--env-file f] [item...]", person: true },
  { verb: "totp", summary: "the one-time code, live", usage: "<name> [--once]", person: true, live: true },
  { verb: "health", summary: "Watchtower: weak, reused, old and to-rotate items, by name", usage: "", read: true },
  { verb: "breach", summary: "check every login's password against known breaches", usage: "" },
  { verb: "history", summary: "an item's versions", usage: "<item> [--field f]", read: true },
  { verb: "revert", summary: "put an older version back, as a new one", usage: "<item> <version>", person: true },
  { verb: "clear-clipboard", summary: "take what the vault copied off the clipboard now", usage: "" },
  { verb: "generate", summary: "a password; stored when named", usage: "[name] [--length n] [--words n] [--no-symbols] [--description d]" },
  { verb: "import", summary: ".env, 1Password, Bitwarden, Chrome, Safari", usage: "<file> [--format f]", person: true },
  { verb: "audit", summary: "who used what, and when", usage: "[name] [--limit n]", read: true },
  { verb: "card", summary: "this Vyre's card, to share", usage: "", read: true },
  { verb: "people", summary: "who you share with; add a card or verify a changed key", usage: "[list|add|verify] [card] [--name n]" },
  { verb: "fingerprint", summary: "yours, and the safety words you and they should both see", usage: "[person]", read: true },
  { verb: "kit", summary: "a recovery kit: a one-time page on this machine", usage: "", person: true },
  { verb: "vaults", summary: "vaults shared with a team", usage: "[list|create|rotate|sync] [vault]" },
  { verb: "members", summary: "who is in a shared vault", usage: "<invite|accept|role|remove> [args...] [--role r]", person: true },
  { verb: "move", summary: "move an item into a shared vault", usage: "<item> <vault>", person: true },
  { verb: "device", summary: "your other devices: a Mac, or a box that stores and runs agents", usage: "[join|approve|list|sync] [code] [--role r] [--approval a]" },
  { verb: "pass", summary: "share without handing over", usage: "[create|list|revoke|accept] [args...] [--sealed] [--card c] [--host h] [--method m] [--path p] [--expires e] [--note n]" },
  { verb: "offboard", summary: "revoke everything a person holds, list what to rotate", usage: "<person>", person: true },
  { verb: "unlock", summary: "unlock the passphrase keystore", usage: "[--stdin]", person: true },
  { verb: "lock", summary: "lock it", usage: "" },
  { verb: "account", summary: "the password (and Touch ID) for your personal vault", usage: "[create|unlock|lock|enroll-touchid|status] [--touchid] [--stdin]" },
  { verb: "migrate-key", summary: "after an update: move the keychain key to this build", usage: "", person: true },
  { verb: "help", summary: "the vault's own list of commands", usage: "", read: true },
];

/** The words run() dispatches on, verbs and aliases, for the test that holds VERBS to them. */
export const HANDLED = Object.freeze(Object.keys(SUBS));

export default {
  name: "vault", order: 40, usage: `vyre vault [${VERBS.map(v => v.verb).join("|")}] [--json]`, verbs: VERBS, summary: "credentials, sealed; shared by pass; used without being seen",
  // `vyre help vault` and `vyre vault <sub> --help` show the vault's own list of commands.
  help: () => help(),
  /** @param {string[]} argv */
  async run(argv) {
    // --json anywhere before a `--` (after it, the flag belongs to run's child).
    const at = argv.indexOf("--");
    const mine = at < 0 ? argv : argv.slice(0, at);
    JSON_MODE = mine.includes("--json");
    STDIN = mine.includes("--stdin");
    last = null; printed = false;
    AGAIN = ["vault", ...mine.filter(a => a !== "--json")];
    const own = mine.filter(a => a !== "--json" && a !== "--stdin");
    const args = JSON_MODE || STDIN ? [...own, ...(at < 0 ? [] : argv.slice(at))] : argv;
    const [sub, ...rest] = args;
    const base = sub === undefined ? "list" : ({ ls: "list", add: "put", rm: "delete" })[sub] || sub;
    SUB = rest[0] && !rest[0].startsWith("-") ? `${base} ${rest[0]}` : base;
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
