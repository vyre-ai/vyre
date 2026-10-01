// @ts-check
// The Vault app's line to vyred: which vault tools this vyred offers the Deck, the unlock session
// (a token kept in this module's memory only: never storage, never the address, never the DOM),
// and calls that prove presence when vyred asks.
//
// Tools from other workstreams (vault.session.*, vault.copy, vault.reveal, vault.history,
// vault.ssh.generate) may not be on this vyred yet. `has(name)` says so, from GET /v1/tools,
// which lists only what the "deck" caller may use, and the views degrade in words.

import { callTool, withPresence } from "./presence.js";

/** @type {Set<string> | null} */
let tools = null;
/** @type {{ token: string, expires: number } | null} */
let session = null;
const listeners = new Set();

/** Load the tool list once per page (again after `refresh`). */
export async function loadTools(refresh = false) {
  if (tools && !refresh) return tools;
  try {
    const res = await fetch("/v1/tools", { headers: { "x-vyre-caller": "deck" } });
    const body = await res.json();
    tools = new Set((body.data || []).map(t => String(t.name)));
  } catch { tools = new Set(); }
  return tools;
}
export const has = name => Boolean(tools && tools.has(name));

/** The open session, or null once it has expired. */
export function current() {
  if (session && session.expires && session.expires <= Date.now()) drop();
  return session;
}
export const unlocked = () => Boolean(current());
/** Hear lock and unlock. Returns an unsubscribe. */
export function watch(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(session); } catch {} } }
function drop() { session = null; changed(); }

/** @type {(ask: import("./presence.js").Ask) => Promise<boolean>} */
let confirmer = async () => false;
/** The view sets how a person is asked (the presence sheet). */
export function setConfirm(fn) { confirmer = fn; }

/**
 * Call a vault tool. Tools that act on a value get the session token added. A refusal that says
 * the session is gone drops it, so the view shows Unlock again.
 * @param {string} name @param {any} [input]
 */
export async function call(name, input = {}) {
  const withSession = ["vault.copy", "vault.reveal", "vault.totp"].includes(name) && session ? { ...input, session: session.token } : input;
  const r = await withPresence(name, withSession, { confirm: confirmer });
  if (r.error && /session/i.test(r.error.code + " " + r.error.message) && /expired|unknown|closed|locked|no such/i.test(r.error.message)) drop();
  return r;
}

/** Open a session with a presence proof. Returns { data } or { error }. */
export async function unlock() {
  if (!has("vault.session.open")) return { error: { code: "missing", message: "This box cannot unlock the vault from the Deck yet." } };
  const r = await withPresence("vault.session.open", { surface: "deck" }, { confirm: confirmer });
  if (r.data) {
    const token = String(r.data.session || r.data.token || "");
    const expires = Number(r.data.expires || r.data.expiresAt || 0) || Date.now() + 10 * 60_000;
    if (!token) return { error: { code: "bad_reply", message: "The box did not open a session" } };
    session = { token, expires };
    changed();
  }
  return r;
}

/** Close the session here and on vyred. Taking access away never needs presence. */
export async function lock() {
  const s = session;
  drop();
  if (s && has("vault.session.close")) await callTool("vault.session.close", { session: s.token });
}

/** Plain calls with no session and no presence handling, for listings. */
export { callTool };
