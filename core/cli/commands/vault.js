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

import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import os from "node:os";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import fs from "node:fs";
import { hiddenPrompt, visiblePrompt, Scrubber, parseRunArgs, flags } from "../../vault/cli-io.js";
import { inspect } from "../../vault/backup.js";
import { templateRefs, render, parseEnvFile, parseRef } from "../../vault/refs.js";

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

/** Every call to vyred goes through here, so --json can print the reply the command acted on. */
async function tool(name, input = {}, opts) {
  const r = await call(name, input, opts);
  last = r;
  return r;
}

const PRESENCE = new Set(["presence_required", "presence_refused", "presence_denied"]);
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
  say(`  ${bold(signal(r.data.display || r.data.code))}  ${dim(`${r.data.remaining}s left`)}`);
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
  if (process.platform === "darwin" && process.stdout.isTTY && !process.env.VYRE_NO_OPEN) spawn("open", [r.data.url], { stdio: "ignore", detached: true }).unref();
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
  ["git-credential <get|store|erase>", "git's credential helper (bin/git-credential-vyre)"],
  ["put <name> [--kind k] [--description d] [--url u] [--host h ...] [--allow-body]", "prompts for the value without echo"],
  ["    [--username u] [--totp] [--field F ...]", "kinds: " + KINDS.join(", ")],
  ["grant <name> <module> [--watcher w]", "let a module use an item"],
  ["revoke <name> <module> [--watcher w]", "take it back"],
  ["pending", "grants and passes an agent asked for"],
  ["approve <id>", "allow one of them"],
  ["run [--env-file f] <item...> -- <command...>", "items as VAR=name.field, or KEY=vault://item/field lines; output scrubbed"],
  ["totp <name>", "the current code"],
  ["generate [--length n] [--words n] [--no-symbols] [name]", "a password; stored when named"],
  ["import <file> [--format f]", ".env, 1Password, Bitwarden, Chrome, Safari"],
  ["audit [name] [--limit n]", "who used what, and when"],
  ["delete <name>", "remove an item and its grants"],
  ["card", "this Vyre's card, to share"],
  ["people [add <card> [--name n] | verify <name> <fingerprint>]", "who you share with; a changed key blocks new passes until verified"],
  ["fingerprint [person]", "yours, and the safety words you and they should both see"],
  ["kit", "print a recovery kit: a one-time page on this machine"],
  ["pass create <holder> <item...> [--sealed] [--card c] [--host h ...] [--method M ...] [--path /p ...] [--expires 30d] [--note n]", "share without handing over"],
  ["pass list | pass revoke <id> | pass accept <ticket>", ""],
  ["relay <item> <url> [--header 'Name: {{vault}}'] [--data d]", "use an item relayed to you; the value is added on its owner's box"],
  ["offboard <person>", "revoke everything they hold, list what to rotate"],
  ["unlock | lock", "for the passphrase keystore"],
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
  pair, devices, "unlock-passphrase": unlockPassphrase, backup: backupCmd, restore: restoreCmd, relay: relayCmd, grant, revoke, pending, approve, run, totp, generate, import: importFile, audit, card, people, fingerprint: fingerprintCmd, kit, pass, offboard, unlock, lock, help,
};

export default {
  name: "vault", order: 40, usage: "vyre vault <command>", summary: "credentials, sealed; shared by pass; used without being seen",
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
