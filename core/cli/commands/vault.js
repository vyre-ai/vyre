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

const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => { out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message); return 1; };
const oops = msg => { out(beacon(`  ${msg}`)); return 1; };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : w.endsWith("s") ? "es" : "s"}`;
const KINDS = ["secret", "api-key", "login", "card", "note", "env-set"];

/** An origin from a url a person typed, which may lack the scheme. */
function origin(url) {
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "https://" + url).origin; } catch { return null; }
}

const day = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

const grantText = g => g.module + (g.watcher ? `/${g.watcher}` : "");

// ------------------------------------------------------------ list

async function list(args) {
  const filter = args.join(" ").trim();
  const r = await call("vault.list", filter ? { filter } : {});
  if (r.error) return fail(r);
  const { locked, items = [] } = r.data;
  if (locked) out(beacon("  the vault is locked ") + dim("· vyre vault unlock"));
  if (!items.length) {
    out(dim(filter ? `  nothing in the vault matches ${JSON.stringify(filter)}` : "  the vault is empty · vyre vault put <name>"));
    return 0;
  }
  out("");
  for (const it of items) {
    out(`  ${bold(it.name)}  ${dim(it.kind)}${it.rotate ? "  " + beacon("rotate") : ""}`);
    if (it.description) out(`    ${it.description}`);
    const meta = [
      it.fields?.length && "fields " + it.fields.join(", "),
      it.url && it.url,
      it.hosts?.length && "hosts " + it.hosts.join(", "),
      it.origin && "from " + it.origin,
    ].filter(Boolean);
    if (meta.length) out(dim(`    ${meta.join(" · ")}`));
    if (it.grants?.length) out(dim(`    granted to ${it.grants.map(grantText).join(", ")}`));
  }
  out("");
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
  const r = await call("vault.put", input);
  for (const k of Object.keys(fields)) fields[k] = "";
  if (r.error) return fail(r);
  out(`  ${signal(r.data.created ? "stored" : "updated")} ${bold(r.data.name)} ${dim(`· ${r.data.kind}${hosts.length ? " · sent only to " + hosts.join(", ") : ""}`)}`);
  return 0;
}

// ------------------------------------------------------------ grants

async function grant(args) {
  const f = flags(args, { string: ["watcher"] });
  const [name, module] = f._;
  if (!name || !module || f._.length > 2) return oops("vyre vault grant <name> <module> [--watcher w]");
  const r = await call("vault.grant", { name, module, ...(f.watcher ? { watcher: f.watcher } : {}) });
  if (r.error) return fail(r);
  const g = r.data.grant;
  if (g.status === "pending") out(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${g.id}`)}`);
  else out(`  ${signal("granted")} ${bold(g.name)} to ${grantText(g)}`);
  return 0;
}

async function revoke(args) {
  const f = flags(args, { string: ["watcher"] });
  const [name, module] = f._;
  if (!name || !module || f._.length > 2) return oops("vyre vault revoke <name> <module> [--watcher w]");
  const r = await call("vault.revoke", { name, module, ...(f.watcher ? { watcher: f.watcher } : {}) });
  if (r.error) return fail(r);
  out(r.data.revoked ? `  ${signal("revoked")} ${bold(name)} from ${module}${f.watcher ? "/" + f.watcher : ""}` : dim(`  ${module} had no grant of ${name}`));
  return 0;
}

async function pending() {
  const r = await call("vault.pending");
  if (r.error) return fail(r);
  const { grants = [], passes = [], people = [], accepts = [] } = r.data;
  if (!grants.length && !passes.length && !people.length && !accepts.length) { out(dim("  nothing waiting for approval")); return 0; }
  out("");
  for (const g of grants) out(`  ${beacon(g.id)}  grant ${bold(g.name)} to ${grantText(g)}`);
  for (const p of passes) out(`  ${beacon(p.id)}  ${p.mode || "relayed"} pass for ${bold(p.holder)}: ${(p.items || []).join(", ")}${p.expires ? dim(" · until " + day(p.expires)) : ""}`);
  for (const p of people) out(`  ${beacon(p.id)}  trust the card for ${bold(p.name)} ${dim("· fingerprint " + (p.fingerprint || "unreadable"))}`);
  for (const a of accepts) out(`  ${beacon(a.id)}  accept a ${a.mode || ""} pass from ${bold(a.owner)}: ${(a.items || []).join(", ")}`);
  out(dim(`\n  vyre vault approve <id>\n`));
  return 0;
}

async function approve(args) {
  const id = args[0];
  if (!id || args.length > 1) return oops("vyre vault approve <id>");
  const r = await call("vault.approve", { id });
  if (r.error) return fail(r);
  const a = r.data.approved || {};
  const what = a.holder ? `pass for ${bold(a.holder)}` : a.owner ? `pass from ${bold(a.owner)}: ${(a.items || []).join(", ")}` : a.fingerprint ? `card for ${bold(a.name)} ${dim("· " + a.fingerprint)}` : `${bold(a.name || id)}${a.module ? " to " + grantText(a) : ""}`;
  out(`  ${signal("approved")} ${what}`);
  if (r.data.ticket) ticket(r.data.ticket, a.holder);
  return 0;
}

// ------------------------------------------------------------ run

async function run(args) {
  let parsed;
  try { parsed = parseRunArgs(args); } catch (e) { return oops(e.message); }
  const r = await call("vault.inject", { items: parsed.items });
  if (r.error) return fail(r);
  const env = r.data.env || {};
  const values = Object.values(env);
  const [bin, ...rest] = parsed.cmd;
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
  const r = await call("vault.totp", { name });
  if (r.error) return fail(r);
  out(`  ${bold(signal(r.data.display || r.data.code))}  ${dim(`${r.data.remaining}s left`)}`);
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
  const r = await call("vault.generate", input);
  if (r.error) return fail(r);
  if (input.name) { out(`  ${signal("stored")} ${bold(input.name)} ${dim(`· ${Math.round(r.data.bits)} bits`)}`); return 0; }
  // You asked in your own terminal, so the value goes to stdout alone and pipes cleanly.
  out(r.data.value);
  process.stderr.write(dim(`  ${Math.round(r.data.bits)} bits · vyre vault generate <name> stores one without showing it\n`));
  return 0;
}

async function importFile(args) {
  const f = flags(args, { string: ["format"] });
  if (f._.length !== 1) return oops("vyre vault import <file> [--format f]");
  const file = path.resolve(f._[0]);
  const r = await call("vault.import", { file, ...(f.format ? { format: f.format } : {}) });
  if (r.error) return fail(r);
  const { format, added = [], duplicate = [], skipped = [], advice } = r.data;
  out(`  ${signal(plural(added.length, "item"))} added from ${format} ${dim(`· ${duplicate.length} already here · ${skipped.length} skipped`)}`);
  if (added.length) out(`    ${added.join(", ")}`);
  if (duplicate.length) out(dim(`  already in the vault: ${duplicate.join(", ")}`));
  for (const s of skipped) out(dim(`  skipped: ${s}`));
  if (advice) out(beacon(`  ${advice}`));
  return 0;
}

async function audit(args) {
  const f = flags(args, { string: ["limit"] });
  const input = {};
  if (f._[0]) input.name = f._[0];
  if (f.limit) input.limit = Number(f.limit);
  const r = await call("vault.audit", input);
  if (r.error) return fail(r);
  const entries = r.data.entries || [];
  if (!entries.length) { out(dim("  no audit entries yet")); return 0; }
  for (const e of entries) {
    const when = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
    const res = e.ok ? signal("ok") : beacon("refused") + (e.why ? dim(" " + e.why) : "");
    out(`  ${dim(when)}  ${e.action.padEnd(14)} ${bold(e.name || "")} ${dim("by " + e.who)}  ${res}`);
  }
  return 0;
}

async function card() {
  const r = await call("vault.identity");
  if (r.error) return fail(r);
  out(`\n  ${bold(r.data.name)} ${dim(r.data.relay ? "· relay " + r.data.relay : "· no relay address yet")}`);
  if (r.data.fingerprint) out(`  ${dim("fingerprint")} ${r.data.fingerprint}\n`);
  out(r.data.card);
  out(dim(`\n  send this card to whoever will share with you; it carries no secret\n`));
  return 0;
}

// ------------------------------------------------------------ people

async function people(args) {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "list") {
    const r = await call("vault.people");
    if (r.error) return fail(r);
    if (!r.data.people.length) { out(dim("  no one yet · vyre vault people add <card>")); return 0; }
    out("");
    for (const p of r.data.people) {
      const st = p.blocked ? beacon(p.changed ? "key changed" : "unverified v1 card") : p.verified ? signal("verified") : dim("pinned");
      out(`  ${bold(p.name)}  ${p.fingerprint}  ${st}`);
    }
    out("");
    return 0;
  }
  if (sub === "add") {
    let f;
    try { f = flags(rest, { string: ["name"] }); } catch (e) { return oops(e.message); }
    if (f._.length !== 1) return oops("vyre vault people add <card> [--name n]");
    const r = await call("vault.person.add", { card: f._[0], ...(f.name ? { name: f.name } : {}) });
    if (r.error) return fail(r);
    if (r.data.pending) { out(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${r.data.pending.id}`)}`); return 0; }
    const p = r.data.person;
    if (r.data.changed) out(`  ${beacon("key changed")} ${bold(p.name)} ${dim("· new fingerprint " + p.fingerprint)}\n  ${dim(`no new pass reaches them until you compare fingerprints and run vyre vault people verify ${p.name} <fingerprint>`)}`);
    else out(`  ${signal(r.data.pinned ? "pinned" : "unchanged")} ${bold(p.name)} ${dim("· fingerprint " + p.fingerprint)}`);
    return 0;
  }
  if (sub === "verify") {
    const [name, ...fp] = rest;
    if (!name || !fp.length) return oops("vyre vault people verify <name> <fingerprint>");
    const r = await call("vault.people.verify", { name, fingerprint: fp.join(" ") });
    if (r.error) return fail(r);
    out(`  ${signal("verified")} ${bold(r.data.person.name)} ${dim("· " + r.data.person.fingerprint)}`);
    return 0;
  }
  return oops(`vyre vault people ${sub}: list, add or verify`);
}

async function fingerprintCmd(args) {
  if (args.length > 1) return oops("vyre vault fingerprint [person]");
  const r = await call("vault.fingerprint", args[0] ? { with: args[0] } : {});
  if (r.error) return fail(r);
  out(`  ${dim("yours ")} ${r.data.fingerprint}`);
  if (r.data.person) {
    out(`  ${dim("theirs")} ${r.data.person.fingerprint} ${dim("· " + r.data.person.name + (r.data.person.verified ? ", verified" : ""))}`);
    out(`\n  ${bold(r.data.words.join(" "))}\n  ${dim("read these to each other; they match on both screens only if neither key was swapped")}`);
  }
  return 0;
}

async function kit() {
  const r = await call("vault.kit");
  if (r.error) return fail(r);
  out(`  ${signal("recovery kit")} ${dim("· one load, gone by " + new Date(r.data.expires).toLocaleTimeString())}`);
  out(`  ${r.data.url}`);
  out(dim("  print it, write your password on it by hand, keep it somewhere safe"));
  // Opened for a person at a terminal only; a script or a test gets the address and nothing else.
  if (process.platform === "darwin" && process.stdout.isTTY && !process.env.VYRE_NO_OPEN) spawn("open", [r.data.url], { stdio: "ignore", detached: true }).unref();
  return 0;
}

// ------------------------------------------------------------ passes

function ticket(t, holder) {
  out(dim(`\n  send this ticket to ${holder || "the holder"}; it carries no secret:\n`));
  out(t);
  out(dim(`\n  they run: vyre vault pass accept <ticket>\n`));
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
    const r = await call("vault.pass.create", input);
    if (r.error) return fail(r);
    const p = r.data.pass;
    out(`  ${signal("pass")} ${dim(p.id)} for ${bold(p.holder)}: ${p.items.join(", ")} ${dim(`· ${p.mode}${p.expires ? " · until " + day(p.expires) : ""}`)}`);
    if (p.mode === "sealed") out(beacon("  sealed: revoking this pass means rotating these items"));
    if (p.status === "pending" || !r.data.ticket) out(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${p.id}`)}`);
    else ticket(r.data.ticket, p.holder);
    return 0;
  }
  if (sub === "list" || sub === undefined) {
    const r = await call("vault.pass.list");
    if (r.error) return fail(r);
    const { passes = [], held = [] } = r.data;
    if (!passes.length && !held.length) { out(dim("  no passes given or held")); return 0; }
    if (passes.length) out(bold("\n  given"));
    for (const p of passes) {
      const st = p.status === "active" ? signal(p.status) : p.status === "pending" ? beacon(p.status) : dim(p.status || "");
      out(`  ${dim(p.id)}  ${bold(p.holder)}  ${(p.items || []).join(", ")}  ${dim(p.mode || "")}${p.expires ? dim(" · until " + day(p.expires)) : ""}  ${st}`);
    }
    if (held.length) out(bold("\n  held"));
    for (const h of held) out(`  ${dim(h.id)}  from ${bold(h.owner)}  ${(h.items || []).join(", ")}  ${dim(h.mode || "")}`);
    out("");
    return 0;
  }
  if (sub === "revoke") {
    if (rest.length !== 1) return oops("vyre vault pass revoke <id>");
    const r = await call("vault.pass.revoke", { id: rest[0] });
    if (r.error) return fail(r);
    out(r.data.revoked ? `  ${signal("revoked")} ${rest[0]}` : dim(`  ${rest[0]} was not active`));
    if (r.data.rotate?.length) out(beacon(`  rotate: ${r.data.rotate.join(", ")}`) + dim(" · then vyre vault put each one again"));
    return 0;
  }
  if (sub === "accept") {
    if (rest.length !== 1) return oops("vyre vault pass accept <ticket>");
    const r = await call("vault.pass.accept", { ticket: rest[0] });
    if (r.error) return fail(r);
    if (r.data.pending) { out(`  ${beacon("waiting for approval")} ${dim(`· vyre vault approve ${r.data.pending.id}`)}`); return 0; }
    const h = r.data.held;
    out(`  ${signal("accepted")} ${h.mode} pass from ${bold(h.owner)}: ${h.items.join(", ")}`);
    return 0;
  }
  return oops(`vyre vault pass ${sub}: create, list, revoke or accept`);
}

async function offboard(args) {
  const person = args.join(" ").trim();
  if (!person) return oops("vyre vault offboard <person>");
  const r = await call("vault.offboard", { person });
  if (r.error) return fail(r);
  const { revoked = [], rotate = [] } = r.data;
  out(`  ${signal("offboarded")} ${bold(r.data.person)} ${dim(`· ${plural(revoked.length, "pass")} revoked`)}`);
  if (rotate.length) out(beacon(`  rotate: ${rotate.join(", ")}`) + dim(" · they received these sealed"));
  else out(dim("  nothing to rotate: every pass was relayed"));
  return 0;
}

async function remove(args) {
  if (args.length !== 1) return oops("vyre vault delete <name>");
  const r = await call("vault.delete", { name: args[0] });
  if (r.error) return fail(r);
  out(`  ${signal("deleted")} ${bold(args[0])}`);
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
  const r = await call("vault.relay", { item, request, ...(f.owner ? { owner: f.owner } : {}) }, { timeout: 60_000 });
  if (r.error) return fail(r);
  process.stderr.write(dim(`  ${r.data.status}${r.data.headers?.["content-type"] ? " · " + r.data.headers["content-type"] : ""}\n`));
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
  const r = await call("vault.device.code", f.name ? { name: f.name } : {});
  if (r.error) return fail(r);
  out(`\n  pairing code  ${bold(signal(r.data.display || r.data.code))}  ${dim("· single use, for 5 minutes")}\n`);
  if (r.data.fill) out(`  fill address  ${bold(r.data.fill)}\n`);
  else out(beacon("  this vyred has no fill listener yet ") + dim("· set vault.fill in config.json\n"));
  out(dim("  type both into the Vyre extension's settings\n"));
  return 0;
}

async function devices(args) {
  if (args[0] === "revoke") {
    if (args.length !== 2) return oops("vyre vault devices revoke <id>");
    const r = await call("vault.device.revoke", { id: args[1] });
    if (r.error) return fail(r);
    out(`  ${signal("revoked")} ${args[1]} ${dim("· its sessions end now")}`);
    return 0;
  }
  if (args[0] === "unlock") {
    if (args.length !== 2) return oops("vyre vault devices unlock <id>");
    const r = await call("vault.device.unlock", { device: args[1] });
    if (r.error) return fail(r);
    out(`  ${signal("unlocked")} ${args[1]}${r.data.expires ? dim(" · until " + new Date(r.data.expires).toISOString().slice(11, 16)) : ""}`);
    return 0;
  }
  const r = await call("vault.devices");
  if (r.error) return fail(r);
  const list = r.data.devices || [];
  if (!list.length) { out(dim("  no paired devices · vyre vault pair")); return 0; }
  for (const d of list) out(`  ${dim(d.id)}  ${bold(d.name)}  ${d.revoked ? dim("revoked") : d.sessions ? signal("unlocked") : dim("locked")}${d.lastSeen ? dim(" · seen " + day(d.lastSeen)) : ""}`);
  return 0;
}

async function unlockPassphrase() {
  let passphrase;
  try { passphrase = await newPassphrase("unlock passphrase for browser autofill"); } catch (e) { return oops(e.message); }
  const r = await call("vault.unlock-passphrase", { passphrase });
  passphrase = "";
  if (r.error) return fail(r);
  out(`  ${signal("set")} ${dim("· paired extensions ask for it before they fill anything")}`);
  return 0;
}

async function backupCmd(args) {
  if (args.length !== 1) return oops("vyre vault backup <file>");
  let passphrase;
  try { passphrase = await newPassphrase("backup passphrase (12 characters or more)"); } catch (e) { return oops(e.message); }
  const r = await call("vault.backup", { file: path.resolve(args[0]), passphrase }, { timeout: 60_000 });
  passphrase = "";
  if (r.error) return fail(r);
  out(`  ${signal("backed up")} ${plural(r.data.items, "item")} to ${bold(r.data.file)}`);
  out(dim("  it opens only with that passphrase; keep the two apart"));
  return 0;
}

async function restoreCmd(args) {
  const f = flags(args, { boolean: ["replace"] });
  if (f._.length !== 1) return oops("vyre vault restore <file> [--replace]");
  const file = path.resolve(f._[0]);
  let info;
  try { info = inspect(fs.readFileSync(file, "utf8").trim()); } catch (e) { return oops(`${file} is not a Vyre backup: ${e.message}`); }
  out(dim(`  backup from ${day(info.at)} · ${plural(info.items, "item")}`));
  let passphrase;
  try { passphrase = await hiddenPrompt("backup passphrase: "); } catch { return oops("cancelled"); }
  const r = await call("vault.restore", { file, passphrase, mode: f.replace ? "replace" : "merge" }, { timeout: 60_000 });
  passphrase = "";
  if (r.error) return fail(r);
  const d = r.data;
  out(`  ${signal("restored")} ${plural(d.added.length, "item")}${d.kept.length ? dim(` · ${d.kept.length} already here, kept`) : ""} ${dim(`· identity ${d.identity}`)}`);
  return 0;
}

// ------------------------------------------------------------ lock

async function unlock() {
  let passphrase;
  try { passphrase = await hiddenPrompt("passphrase: "); } catch { return oops("cancelled"); }
  const r = await call("vault.unlock", { passphrase });
  passphrase = "";
  if (r.error) return fail(r);
  out(`  ${signal("unlocked")}`);
  return 0;
}

async function lock() {
  const r = await call("vault.lock");
  if (r.error) return fail(r);
  out(`  ${signal("locked")}`);
  return 0;
}

// ------------------------------------------------------------ dispatch

const HELP = [
  ["list [filter]", "names, kinds and grants; never values"],
  ["put <name> [--kind k] [--description d] [--url u] [--host h ...] [--allow-body]", "prompts for the value without echo"],
  ["    [--username u] [--totp] [--field F ...]", "kinds: " + KINDS.join(", ")],
  ["grant <name> <module> [--watcher w]", "let a module use an item"],
  ["revoke <name> <module> [--watcher w]", "take it back"],
  ["pending", "grants and passes an agent asked for"],
  ["approve <id>", "allow one of them"],
  ["run <item...> -- <command...>", "items as VAR=name.field; output scrubbed"],
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
];

function help() {
  out(`\n  ${bold("vyre vault")} ${dim("· credentials, sealed; shared by pass; used without being seen")}\n`);
  for (const [u, s] of HELP) out(`  ${u}${s ? "\n      " + dim(s) : ""}`);
  out("");
  return 0;
}

const SUBS = {
  list, ls: list, put, delete: remove, pair, devices, "unlock-passphrase": unlockPassphrase, backup: backupCmd, restore: restoreCmd, relay: relayCmd, grant, revoke, pending, approve, run, totp, generate, import: importFile, audit, card, people, fingerprint: fingerprintCmd, kit, pass, offboard, unlock, lock, help,
};

export default {
  name: "vault", order: 40, usage: "vyre vault <command>", summary: "credentials, sealed; shared by pass; used without being seen",
  /** @param {string[]} args */
  async run(args) {
    const [sub, ...rest] = args;
    if (sub === undefined) return list([]);
    if (sub === "--help" || sub === "-h") return help();
    const fn = SUBS[sub];
    if (!fn) { out(beacon(`  vyre vault ${sub}: not a vault command`)); help(); return 1; }
    try { return await fn(rest); } catch (e) { return oops(e.message); }
  },
};
