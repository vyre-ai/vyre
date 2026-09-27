// @ts-check
// accounts: which mail accounts a caller may use, and how each one is served (ADR 0016 decision 8).
//
// A mail account is a vault connection (ADR 0028 decision 9b): the vault keeps the list, the
// items and the surfaces each one is granted to, and answers vault.connections.list for the
// caller mail passes it. This file turns what vyred verified into that caller, turns a
// connection into the adapter that serves it, and picks the one account a send goes from.
//
// Rules, and why:
// - The caller comes from vyred, never from the input: the Capsule is `capsule`, a person's own
//   session in a thread is `mcp:thread:<id>`, an agent is `mcp:agent:<name>`. Only a module may
//   say whom it acts for (`on_behalf`), since a module is code the person installed.
// - People's managing callers (cli, local, deck) see every account, as the vault decides.
// - A send with no account names the only one or asks. It never guesses: an email from the wrong
//   address is a mistake the person sees.

import { EMAIL } from "../connectors/message.js";

/** mail's own table: the tool map of an MCP-served account, by connection id. Nothing secret. */
export const MIGRATIONS = [
  `CREATE TABLE mail_maps (account TEXT PRIMARY KEY, server TEXT NOT NULL, map TEXT NOT NULL, guessed INTEGER NOT NULL, updated INTEGER NOT NULL);`,
];

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
const fail = (msg, code = "bad_input", detail) => Object.assign(new Error(msg), { code, ...(detail ? { detail } : {}) });

/**
 * The caller string the vault decides surfaces by, from what vyred verified.
 * @param {string} caller @param {{ thread?: string, agent?: string }} meta @param {any} [behalf]
 */
export function callerFor(caller, meta = {}, behalf) {
  const c = String(caller || "");
  if (meta.agent) return `mcp:agent:${meta.agent}`;
  if (/^(mcp|tailnet|harness):agent:./.test(c)) return c;
  if (c === "mcp") return meta.thread ? `mcp:thread:${meta.thread}` : "mcp";
  if (c.startsWith("module:")) {
    const b = behalf && typeof behalf === "object" ? behalf : {};
    if (b.surface === "capsule") return "capsule";
    if (b.surface === "agent" && typeof b.agent === "string" && b.agent) return `mcp:agent:${b.agent}`;
    if (b.surface === "chat") return typeof b.thread === "string" && b.thread ? `mcp:thread:${b.thread}` : "mcp";
    if (b.surface === "phone") return "mobile";
    return c;
  }
  return c;
}

/** The thread and agent a held item is filed under, from the caller string. @param {string} c */
export function filingOf(c) {
  const t = /^mcp:thread:(.+)$/s.exec(c);
  const a = /^(?:mcp|tailnet|harness):agent:(.+)$/s.exec(c);
  return { ...(t ? { thread: t[1] } : {}), ...(a ? { agent: a[1] } : {}) };
}

/**
 * Which adapter serves a connection, or null when mail cannot act on it.
 * @param {{ source: string, provider?: string }} row
 * @returns {"google" | "mcp" | "imap" | "apps-script" | null}
 */
export function adapterOf(row) {
  if (row.source === "google") return "google";
  if (row.source === "mcp") return "mcp";
  if (row.source === "vault" && row.provider === "imap-smtp") return "imap";
  if (row.source === "vault" && row.provider === "google-apps-script") return "apps-script";
  return null;
}

/**
 * An IMAP and SMTP login's settings from its item's plain fields (the vault catalog's names).
 * The password stays in the vault; it is fetched per call as the `password` field.
 * @param {string} item @param {Record<string, string>} f @param {string} account
 */
export function imapConfig(item, f, account) {
  const tls = f.security === "starttls" ? "starttls" : f.security === "none" ? "none" : "implicit";
  const port = v => { const n = /^\d{1,5}$/.test(String(v || "")) ? Number(v) : 0; return n >= 1 && n <= 65535 ? n : undefined; };
  const address = EMAIL.test(String(f.from || "")) ? String(f.from) : EMAIL.test(account) ? account : String(f.username || "");
  return {
    address, ...(f.username ? { username: String(f.username) } : {}),
    imap: { host: String(f.imap_host || ""), ...(port(f.imap_port) ? { port: port(f.imap_port) } : {}), tls },
    smtp: { host: String(f.smtp_host || ""), ...(port(f.smtp_port) ? { port: port(f.smtp_port) } : {}), tls },
    auth: { item, field: "password" },
  };
}

/** An account as mail's tools show it: never a value. */
export const view = r => ({ account: r.id, adapter: adapterOf(r), address: r.account, label: r.label || r.account, provider: r.provider, source: r.source });

/**
 * The one account a send goes from: the one named, or the only one this caller may use.
 * @param {any[]} usable @param {string} [name]
 */
export function pickFor(usable, name) {
  if (name !== undefined) {
    const one = usable.find(a => a.id === name);
    if (!one) throw fail(`no mail account ${String(name).slice(0, 64)} that this caller may use${usable.length ? `; the accounts are ${usable.map(a => `${a.id} (${a.account})`).join(", ")}` : ""}`, "no_account");
    return one;
  }
  if (!usable.length) throw fail("no mail account is connected for this surface · add one in Vault, Connections", "no_account");
  if (usable.length > 1) throw fail(`say which account this goes from: ${usable.map(a => `${a.id} (${a.account})`).join(", ")}`, "ambiguous",
    { accounts: usable.map(a => ({ account: a.id, address: a.account })) });
  return usable[0];
}
