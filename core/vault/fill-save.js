// @ts-check
// fill-save: two more routes on the fill listener for the extension (ADR 0006, section 6).
//
//   POST /v1/fill/otp   { name, url }                        -> { code, remaining, period }
//   POST /v1/fill/save  { url, username?, password, name? }  -> { name, created, updated }
//
// Both need a paired device and a live session, the same two things /fill needs, and both are
// held to the page's exact origin. Save is how a login typed into a page becomes an item: a new
// one gets hosts = that origin and nothing wider; an update keeps the replaced password in the
// item's sealed `history` field (the last 5), so a mistaken save can be undone. Neither route
// ever sends a password back, and nothing here writes one into an audit row, event or error.

import { totp } from "./totp.js";
import { appOf } from "./fill.js";

const MAX_VALUE = 64 * 1024;
const HISTORY = 5;

const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
const ok = data => ({ status: 200, body: { data } });

function origin(u) {
  try { const x = new URL(String(u)); return ["http:", "https:"].includes(x.protocol) ? x.origin : null; } catch { return null; }
}

/**
 * The device and session a request carries, or a refusal (already audited).
 * @param {import("./fill.js").Fill} fill @param {Record<string, string>} h @param {string} action @param {string|null} name
 */
export function gate(fill, h, action, name) {
  const d = fill.device(h);
  if ("status" in d) return { reply: d };
  const who = fill.who(d);
  const refuse = (status, code, why) => { fill.vault.audit(action, name, who, false, why); return fail(status, code, why); };
  const s = fill.session(d, h["x-vyre-session"]);
  if (s === "missing") return { reply: refuse(401, "session_required", "unlock first") };
  if (s === "expired") return { reply: refuse(401, "session_expired", "the session ended; unlock again") };
  return { d, who, s, refuse };
}

/** The error a locked or unreadable item gives. A locked message is the vault's own words; any other is dropped. */
export function openFailed(e, name) {
  const locked = /** @type {any} */ (e).code === "locked";
  return locked ? [423, "vault_locked", String(/** @type {any} */ (e).message)] : [500, "internal", `could not open ${name}`];
}

/**
 * @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function otpRoute(fill, b, h) {
  const name = typeof b.name === "string" && b.name ? b.name : null;
  const g = gate(fill, h, "fill-otp", name);
  if (g.reply) return g.reply;
  const { d, who, refuse } = /** @type {any} */ (g);
  if (!name) return refuse(400, "bad_input", "give the login's name");
  // A native app on the phone is named by package and certificate (fill.js appOf).
  const app = appOf(b.url);
  const o = app || origin(b.url);
  if (!o) return refuse(400, "bad_input", "the page is not an http or https page");
  const r = fill.vault.row(name);
  if (!r || r.kind !== "login") return refuse(404, "not_found", `no login named ${name}`);
  if (app ? !fill.appLogins(app).some(x => x.name === r.name) : !fill.hostsOf(r).includes(o)) return refuse(403, "wrong_origin", `${name} is not for ${o}`);
  let f;
  try { f = await fill.vault.fields(r); } catch (e) { const [st, c, m] = openFailed(e, name); return refuse(st, c, m); }
  if (!f.totp) return refuse(404, "no_totp", `${name} has no one-time code`);
  let c;
  try { c = totp(f.totp, { at: fill.now() }); } catch { return refuse(500, "bad_seed", `${name}'s one-time code seed does not parse`); }
  fill.vault.audit("fill-otp", name, who, true, o);
  fill.vault.emit("vault.filled", { name, device: d.id, what: "otp" });
  return ok({ code: c.code, remaining: c.remaining, period: c.period });
}

/**
 * @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function saveRoute(fill, b, h) {
  const named = typeof b.name === "string" && b.name ? b.name : null;
  const g = gate(fill, h, "fill-save", named);
  if (g.reply) return g.reply;
  const { who, refuse } = /** @type {any} */ (g);
  const o = origin(b.url);
  if (!o) return refuse(400, "bad_input", "the page is not an http or https page");
  if (typeof b.password !== "string" || !b.password || b.password.length > MAX_VALUE) return refuse(400, "bad_input", "give the password to save");
  if (b.username !== undefined && (typeof b.username !== "string" || b.username.length > 1024)) return refuse(400, "bad_input", "the username must be text");
  const username = typeof b.username === "string" ? b.username : "";
  const vault = fill.vault;

  // Which login this is: the one named (update on change), else one for this origin with the same username.
  let r = null, f = null;
  try {
    if (named) {
      r = vault.row(named);
      if (!r || r.kind !== "login") return refuse(404, "not_found", `no login named ${named}`);
      if (!fill.hostsOf(r).includes(o)) return refuse(403, "wrong_origin", `${named} is not for ${o}`);
      f = await vault.fields(r);
    } else {
      for (const cand of fill.logins(o)) {
        const row = vault.row(cand.name);
        const cf = await vault.fields(row);
        if ((cf.username || "") === username) { r = row; f = cf; break; }
      }
    }
  } catch (e) { const [st, c, m] = openFailed(e, named || o); return refuse(st, c, m); }

  try {
    if (r && f) {
      if (f.password === b.password) {
        vault.audit("fill-save", r.name, who, true, `${o} unchanged`);
        return ok({ name: r.name, created: false, updated: false });
      }
      const history = json(f.history, []);
      const past = Array.isArray(history) ? history.filter(x => x && typeof x.password === "string") : [];
      if (f.password) past.unshift({ password: f.password, at: fill.now() });
      const fields = { ...f, password: b.password, history: JSON.stringify(past.slice(0, HISTORY)) };
      if (!fields.username && username) fields.username = username;
      await vault.put({ name: r.name, kind: "login", description: r.description, fields, url: r.url, hosts: json(r.hosts, []) }, who);
      vault.audit("fill-save", r.name, who, true, `${o} updated`);
      return ok({ name: r.name, created: false, updated: true });
    }
    const name = freeName(vault, new URL(o).hostname);
    await vault.put({ name, kind: "login", description: `saved from ${o}`, fields: { ...(username ? { username } : {}), password: b.password }, url: o, hosts: [o] }, who);
    vault.audit("fill-save", name, who, true, `${o} created`);
    return ok({ name, created: true, updated: false });
  } catch (e) {
    const [st, c, m] = openFailed(e, named || o);
    return refuse(st, c, st === 500 ? "could not save the login" : m);
  }
}

/** A new item's name from the page's host: "mail.example.com", then "mail.example.com-2" and on. */
function freeName(vault, host) {
  const base = String(host).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100) || "login";
  if (!vault.row(base)) return base;
  for (let i = 2; i < 1000; i++) if (!vault.row(`${base}-${i}`)) return `${base}-${i}`;
  throw new Error("too many logins for this host");
}
