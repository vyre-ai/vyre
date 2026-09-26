// @ts-check
// `vyre connect`: MCP servers and Google accounts from the terminal (ADR 0016 decision 7).
//
// One command for both, because to a person they are the same thing: something Vyre can reach on
// their behalf. A connection names vault items and never takes a value on the command line, where
// shell history, `ps` and Claude's transcript would see it; the value goes in with
// `vyre vault put`. After an add that names an item, this asks the vault to grant it to the module
// (which wants a person here, so it goes through the presence helper), then tests the connection
// and says what came back: the server's tool count, or the Google scopes that were refused.

import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { dialogsAllowed } from "../../config/dialogs.js";
import { parseSSE } from "./threads.js";
import { callAsPerson } from "../presence.js";
import { flags } from "../../vault/cli-io.js";
import { out, dim, bold, signal, beacon } from "../style.js";

const USAGE = "vyre connect list|add|remove|test";
const HELP = [
  ["list", "MCP servers and Google accounts, with state, tools, auth and scope"],
  ["add mcp <name> [--project p]... [--agent a]... [--auth bearer|env|oauth|service-account] [--item <vault item>] [--env VAR=item]... [--var VAR=value]... [--header Name:Value]... -- <command> [args...]", "a stdio server; --var is a plain setting, never a secret"],
  ["add mcp <name> --url <url> [--sse] [--auth ...] [--item ...] [--header ...]", "an http or sse server"],
  ["add google <name> --email <address> --item <vault item> [--dwd]", "a Google account; --dwd for a service account acting as the address"],
  ["add google <name> --sign-in [--client <vault item>]", "Sign in with Google in a browser; the client defaults to google-oauth-client"],
  ["remove [mcp|google] <name>", "disconnect it; its vault items stay"],
  ["test [mcp|google] <name>", "try it now"],
];

const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => {
  if (r.error.code === "no_such_tool") out(beacon(`  this vyred has no ${String(r.error.message || "").replace(/^no tool /, "") || "such tool"} ${dim("· is the module running? vyre modules")}`));
  else out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message);
  return 1;
};
const oops = msg => { out(beacon(`  ${msg}`)); return 1; };
const STATE = { running: signal, starting: dim, stopped: dim, failed: beacon, connected: signal };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The vault items a server row names: its auth item and every env reference. */
function itemsOf(s) {
  const refs = Object.values(s.env || {}).map(v => (typeof v === "string" ? v : v && v.item)).filter(Boolean);
  return [...new Set([s.auth && s.auth.item, ...refs].filter(Boolean))];
}
const scopeText = sc => {
  if (!sc) return "";
  const p = sc.projects === "*" ? "every project" : `projects ${sc.projects.join(", ")}`;
  const a = sc.agents === "*" ? "every agent" : `agents ${sc.agents.join(", ")}`;
  return `${p} · ${a}`;
};

// ------------------------------------------------------------ list

async function list() {
  const [m, g] = await Promise.all([call("mcp.servers"), call("google.accounts")]);
  if (unreachable(m)) return fail(m);
  if (m.error && m.error.code !== "no_such_tool") return fail(m);
  if (g.error && g.error.code !== "no_such_tool") return fail(g);
  const servers = m.error ? [] : m.data, accounts = g.error ? [] : g.data;
  if (!servers.length && !accounts.length) { out(`  nothing connected yet ${dim("· vyre connect add mcp <name> -- <command>, or vyre connect add google <name> --sign-in")}`); return 0; }
  out("");
  for (const s of servers) {
    const paint = STATE[/** @type {keyof typeof STATE} */ (s.state)] || dim;
    out(`  ${bold(s.name)}  ${dim("mcp " + s.transport)}  ${paint(s.state)}  ${dim(s.tools == null ? "tools not listed yet" : plural(s.tools, "tool"))}`);
    const items = itemsOf(s);
    out(dim(`      ${[s.auth.type === "none" ? "no auth" : `${s.auth.type}${items.length ? " " + items.join(", ") : ""}`, scopeText(s.scope)].join(" · ")}`));
    if (s.error) out(beacon(`      ${s.error}`));
  }
  for (const a of accounts) {
    const as = a.auth.type === "service-account" ? `service-account ${a.auth.item} · acts as ${a.auth.subject || a.email}` : `oauth ${a.auth.item}`;
    out(`  ${bold(a.name)}  ${dim("google")}  ${signal("connected")}  ${dim(a.email)}`);
    out(dim(`      ${as} · calendar and mail`));
  }
  out("");
  return 0;
}

// ------------------------------------------------------------ add

/** Grant each item to the module, as the person here. Returns false when one could not be. */
async function grant(items, module) {
  let ok = true;
  for (const name of items) {
    const r = await callAsPerson("vault.grant", { name, module });
    if (r.error) { fail(r); ok = false; continue; }
    const g = r.data.grant;
    if (g.status === "pending") { out(`  ${beacon("waiting for approval")} ${bold(name)} to ${module} ${dim(`· vyre vault approve ${g.id}`)}`); ok = false; }
    else out(`  ${signal("granted")} ${bold(name)} to ${module}`);
  }
  return ok;
}

/** @param {any} t mcp.test's reply data @param {string} name */
function mcpTested(t, name) {
  if (t.ok) { out(`  ${signal("ok")} ${bold(name)} has ${plural(t.tools.length, "tool")} ${dim(`· ${t.ms}ms`)}`); return 0; }
  out(`  ${beacon("failed")} ${bold(name)}: ${t.error || "it did not answer"}`);
  for (const l of (t.stderr || []).slice(-5)) out(dim("      " + l));
  return 1;
}

/** @param {any} t google.test's reply data */
function googleTested(t) {
  const refused = Object.entries(t.scopes || {}).filter(([, v]) => !v).map(([k]) => k);
  if (t.ok) { out(`  ${signal("ok")} ${bold(t.account)} ${dim("· " + Object.keys(t.scopes).join(", "))}`); return 0; }
  if (refused.length) out(`  ${beacon("refused")} ${refused.join(", ")}`);
  out(beacon(`  ${t.error}`));
  return 1;
}

async function addMcp(name, args) {
  const cut = args.indexOf("--");
  const before = cut < 0 ? args : args.slice(0, cut), command = cut < 0 ? [] : args.slice(cut + 1);
  let f;
  try { f = flags(before, { string: ["auth", "item", "url"], list: ["project", "agent", "env", "var", "header"], boolean: ["sse"] }); } catch (e) { return oops(/** @type {Error} */ (e).message); }
  if (f._.length) return oops(`unexpected ${f._.join(" ")} · the command goes after --`);
  if (f.url && command.length) return oops("give a --url or a command after --, not both");
  if (!f.url && !command.length) return oops("say how to reach it: -- <command> [args...] for stdio, or --url <url>");
  if (f.sse && !f.url) return oops("--sse is for a --url server");

  /** @type {Record<string, any>} */
  const input = { name, transport: f.url ? (f.sse ? "sse" : "http") : "stdio" };
  if (f.url) input.url = f.url; else { input.command = command[0]; input.args = command.slice(1); }
  if (f.project.length || f.agent.length) input.scope = { projects: f.project.length ? f.project : "*", agents: f.agent.length ? f.agent : "*" };
  if (f.env.length) {
    input.env = {};
    for (const e of f.env) {
      const i = e.indexOf("=");
      if (i <= 0 || i === e.length - 1) return oops(`--env ${e}: give VAR=<vault item>, never a value`);
      input.env[e.slice(0, i)] = e.slice(i + 1);
    }
  }
  if (f.var.length) {
    input.vars = {};
    for (const e of f.var) {
      const i = e.indexOf("=");
      if (i <= 0) return oops(`--var ${e}: give VAR=value`);
      input.vars[e.slice(0, i)] = e.slice(i + 1);
    }
  }
  if (f.header.length) {
    input.headers = {};
    for (const h of f.header) {
      const i = h.indexOf(":");
      if (i <= 0) return oops(`--header ${h}: give Name:Value`);
      input.headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
  }
  if (f.auth) {
    if (f.auth === "env") {
      if (f.item) return oops("env auth names its items with --env VAR=<vault item>");
      if (!input.env) return oops("--auth env needs --env VAR=<vault item>");
      input.auth = { type: "env" };
    } else {
      if (!f.item) return oops(`--auth ${f.auth} needs --item <vault item>`);
      input.auth = { type: f.auth, item: f.item };
    }
  } else if (f.item) return oops("--item goes with --auth bearer|oauth|service-account");

  const r = await call("mcp.add", input, { timeout: 60_000 });
  if (r.error) return fail(r);
  const s = r.data;
  out(`  ${signal("added")} ${bold(s.name)} ${dim(`· mcp ${s.transport} · ${scopeText(s.scope)}`)}`);
  const items = itemsOf(s);
  if (!items.length) return mcpTested(s.test, s.name);
  if (!(await grant(items, "mcp"))) { out(dim(`  vyre connect test ${s.name} once it is granted`)); return 1; }
  const t = await call("mcp.test", { name: s.name }, { timeout: 60_000 });
  if (t.error) return fail(t);
  return mcpTested(t.data, s.name);
}

async function addGoogle(name, args) {
  let f;
  try { f = flags(args, { string: ["email", "item", "base", "client"], boolean: ["dwd", "sign-in"] }); } catch (e) { return oops(/** @type {Error} */ (e).message); }
  if (f._.length) return oops(`unexpected ${f._.join(" ")}`);
  if (f["sign-in"]) {
    const clash = ["email", "item", "dwd"].filter(k => f[k]);
    if (clash.length) return oops(`--sign-in finds the address itself; leave out ${clash.map(k => "--" + k).join(" and ")}`);
    return signIn(name, f.client || CLIENT_ITEM, f.base);
  }
  if (f.client) return oops("--client goes with --sign-in");
  if (!f.email || !f.item) return oops("vyre connect add google <name> --email <address> --item <vault item> [--dwd]");
  // A DWD service account acts as the address given; OAuth acts as whoever consented.
  const auth = f.dwd ? { type: "service-account", item: f.item, subject: f.email } : { type: "oauth", item: f.item };
  // --base points the account at a loopback fake; the module refuses anything else. For tests.
  const r = await call("google.add", { name, email: f.email, auth, ...(f.base ? { base: f.base } : {}) });
  if (r.error) return fail(r);
  out(`  ${signal("added")} ${bold(r.data.name)} ${dim(`· google ${r.data.email} · ${auth.type}`)}`);
  if (!(await grant([f.item], "google"))) { out(dim(`  vyre connect test ${name} once it is granted`)); return 1; }
  const t = await call("google.test", { name }, { timeout: 60_000 });
  if (t.error) return fail(t);
  return googleTested(t.data);
}

// ------------------------------------------------------------ sign in with Google

export const CLIENT_ITEM = "google-oauth-client";
export const CLIENT_PUT = "vyre vault put google-oauth-client --kind env-set --field client_id --field client_secret";
export const SIGN_IN_WAIT_MS = 10 * 60_000;
const PASTE_HINT = "Open this address in a browser. Signing in on another device? Paste the address it lands on here.";

/** Open the consent page in this machine's browser, if a person is here to see it. Failure is fine. */
function openBrowser(url) {
  if (!dialogsAllowed() || !process.stdout.isTTY) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!cmd) return;
  try {
    const p = spawn(cmd, [url], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

/**
 * vyred's event stream, opened before the sign-in starts so its end cannot be missed. Resolves
 * once vyred answers, with a close function; `onEvent` gets every event after that.
 * @param {(e: any) => void} onEvent @param {(why: string) => void} onLost
 * @returns {Promise<{ close: () => void } | { error: string }>}
 */
function follow(onEvent, onLost) {
  return new Promise(resolve => {
    let open = false, closed = false;
    const req = http.request({ socketPath: config.paths().socket, path: "/v1/events/stream?type=google.*&since=latest", method: "GET",
      headers: { accept: "text/event-stream", "x-vyre-caller": "cli" } }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve({ error: `the event stream answered ${res.statusCode}` }); return; }
      open = true;
      resolve({ close: () => { closed = true; req.destroy(); } });
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", chunk => {
        const r = parseSSE(buf + chunk);
        buf = r.rest;
        for (const fr of r.frames) { try { onEvent(JSON.parse(fr.data)); } catch {} }
      });
      res.on("end", () => { if (!closed) onLost("vyred closed the event stream"); });
    });
    req.on("error", err => { if (closed) return; if (open) onLost(`lost vyred: ${err.message}`); else resolve({ error: "unreachable" }); });
    req.end();
  });
}

/**
 * `vyre connect add google <name> --sign-in`: grant the OAuth client to google, start the sign-in,
 * show the consent address, and wait for the browser to come back to the loopback, for a pasted
 * address, for Ctrl-C (or end of input at a terminal), or for 10 minutes.
 * @param {string} name @param {string} client @param {string} [base]
 */
async function signIn(name, client, base) {
  const l = await call("vault.list", { filter: client });
  if (l.error) return fail(l);
  if (!(l.data?.items || []).some(x => x.name === client)) {
    out(beacon(`  the vault has no ${client}`));
    out(dim("  It holds a Desktop app OAuth client from the Google Cloud console (APIs and Services, Credentials). Put it in with:"));
    out(`  ${CLIENT_PUT.replace(CLIENT_ITEM, client)}`);
    return 1;
  }
  if (!(await grant([client], "google"))) { out(dim(`  run this again once ${client} is granted`)); return 1; }

  /** @type {(v: { ok: true, email: string } | { ok: false, error: string, cancelled?: boolean }) => void} */
  let settle = () => {};
  const ended = new Promise(r => { settle = r; });
  let id = "";
  /** Events that arrive before google.connect has answered with the id, looked at once it has. */
  const early = [];
  const seen = e => {
    const p = e.payload ?? e.data ?? {};
    if (!id) { early.push(e); return; }
    if (p.id !== id) return;
    if (e.type === "google.connected") settle({ ok: true, email: String(p.email || "") });
    else if (e.type === "google.connect-failed") settle({ ok: false, error: String(p.error || "the sign-in failed") });
  };
  const stream = await follow(seen, why => settle({ ok: false, error: why }));
  if ("error" in stream) return stream.error === "unreachable" ? fail({ error: { code: "unreachable", message: "" } }) : oops(stream.error);

  const r = await call("google.connect", { name, client, ...(base ? { base } : {}) });
  if (r.error) { stream.close(); return fail(r); }
  id = r.data.id;
  for (const e of early.splice(0)) seen(e);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let finishing = false, said = "";
  rl.on("line", async line => {
    const text = line.trim();
    if (!text) return;
    if (!/^https?:\/\/\S+$/.test(text)) { out(dim("  that is not an address; paste the whole address from the browser, starting with http")); return; }
    if (finishing) return;
    finishing = true;
    const f = await call("google.connect.finish", { id, url: text }, { timeout: 60_000 });
    finishing = false;
    // A refused paste that ended the sign-in also arrives as google.connect-failed; say it once.
    if (f.error && f.error.code !== "not_found") { said = f.error.message; out(beacon(`  ${said}`)); }
    else if (!f.error) settle({ ok: true, email: String(f.data.email || "") });
  });
  const stop = () => settle({ ok: false, error: "cancelled, nothing stored", cancelled: true });
  // Ctrl-C cancels always. End of input cancels only at a terminal (Ctrl-D); piped or empty stdin
  // (a script, < /dev/null) just ends the paste reader, and the loopback can still finish it.
  const eof = () => { if (process.stdin.isTTY) stop(); };
  rl.on("close", eof);
  process.on("SIGINT", stop);
  const timer = setTimeout(() => settle({ ok: false, error: "the sign-in expired after 10 minutes; nothing stored", cancelled: true }), SIGN_IN_WAIT_MS);

  // Shown only once Ctrl-C and the paste reader are listening, so a person (or a script) acting
  // on the address at once is heard.
  out("");
  out(r.data.url);
  out("");
  openBrowser(r.data.url);
  out(dim(`  ${PASTE_HINT}`));

  const result = await ended;
  clearTimeout(timer);
  process.off("SIGINT", stop);
  rl.removeAllListeners("line");
  rl.removeListener("close", eof);
  rl.close();
  process.stdin.destroy();
  stream.close();

  if (!result.ok) {
    if (result.cancelled) await call("google.connect.cancel", { id });
    if (result.error !== said) out(beacon(`  ${result.error}`));
    return 1;
  }
  out(`  ${signal("added")} ${bold(name)} ${result.email}`);
  const t = await call("google.test", { name }, { timeout: 60_000 });
  if (t.error) return fail(t);
  return googleTested(t.data);
}

// ------------------------------------------------------------ remove and test

/** Which kind a bare name is: the one that has it. Both is a question, never a guess. */
async function kindOf(name) {
  const [m, g] = await Promise.all([call("mcp.servers"), call("google.accounts")]);
  if (unreachable(m)) return { error: m };
  const inMcp = !m.error && m.data.some(s => s.name === name), inGoogle = !g.error && g.data.some(a => a.name === name);
  if (inMcp && inGoogle) return { problem: `${name} is both an MCP server and a Google account; say which: mcp ${name} or google ${name}` };
  if (inMcp) return { kind: "mcp" };
  if (inGoogle) return { kind: "google" };
  return { problem: `nothing connected is named ${name} · vyre connect list` };
}

async function target(rest, verb) {
  let [kind, name] = rest;
  if (kind !== "mcp" && kind !== "google") { name = kind; kind = undefined; }
  if (!name || rest.length > (kind ? 2 : 1)) return { code: oops(`vyre connect ${verb} [mcp|google] <name>`) };
  if (!kind) {
    const k = await kindOf(name);
    if (k.error) return { code: fail(k.error) };
    if (k.problem) return { code: oops(k.problem) };
    kind = k.kind;
  }
  return { kind, name };
}

async function remove(rest) {
  const t = await target(rest, "remove");
  if (t.code !== undefined) return t.code;
  const r = await call(`${t.kind}.remove`, { name: t.name });
  if (r.error) return fail(r);
  const gone = t.kind === "mcp" ? r.data.removed : r.data.removed === true;
  out(gone ? `  ${signal("removed")} ${bold(t.name)} ${dim("· its vault items stay; vyre vault revoke <item> " + t.kind + " takes the grant back")}` : dim(`  no ${t.kind} connection named ${t.name}`));
  return gone ? 0 : 1;
}

async function test(rest) {
  const t = await target(rest, "test");
  if (t.code !== undefined) return t.code;
  const r = await call(`${t.kind}.test`, { name: t.name }, { timeout: 60_000 });
  if (r.error) return fail(r);
  return t.kind === "mcp" ? mcpTested(r.data, t.name) : googleTested(r.data);
}

function help() {
  out("");
  for (const [u, s] of HELP) out(`  vyre connect ${u}\n      ${dim(s)}`);
  out(dim("\n  Values go in the vault first: vyre vault put <item>. A connection names items, never values.\n"));
  return 0;
}

export default {
  name: "connect", order: 41, usage: USAGE,
  summary: "MCP servers and Google accounts Vyre can reach for you",
  /** @param {string[]} args */
  async run(args) {
    const [verb, ...rest] = args;
    if (!verb || verb === "list") return list();
    if (verb === "help" || verb === "--help") return help();
    if (verb === "add") {
      const [kind, name, ...more] = rest;
      if ((kind !== "mcp" && kind !== "google") || !name || name.startsWith("-")) return oops("vyre connect add mcp|google <name> ... · vyre connect help");
      return kind === "mcp" ? addMcp(name, more) : addGoogle(name, more);
    }
    if (verb === "remove" || verb === "rm") return remove(rest);
    if (verb === "test") return test(rest);
    out(`  vyre connect ${verb}: not a verb ${dim("· list, add, remove, test")}`);
    return 1;
  },
};
