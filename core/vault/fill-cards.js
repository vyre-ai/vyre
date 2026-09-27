// @ts-check
// fill-cards: cards and addresses through the fill listener, so the extension can fill a
// checkout or an address form (ADR 0006, decision 3 for reprompt; ADR 0010 for the listener).
//
//   POST /v1/fill/cards         { url }        -> { cards: [{ name, description }], addresses: [{ name, description }] }
//   POST /v1/fill/card.fill     { url, name }  -> { holder?, number?, expiry?, exp_month?, exp_year?, cvv? }
//   POST /v1/fill/address.fill  { url, name }  -> the address fields the item has
//
// A card or an address is not tied to a site the way a login is, so the list is the same on every
// page and the page's origin is only written to the audit row, never used to choose. Listing needs
// a paired device; a value needs a live session too. A card asks every time (reprompt, the default
// Vault.put gives a card): its fill needs a session opened in the last 60 seconds, so a card fills
// just after a proof made for it, not anywhere in a 30-minute window. A card's PIN is never sent: no
// checkout asks for it. Audit rows carry the item's name and the page's origin, never a value.

import { gate, openFailed } from "./fill-save.js";
import { reprompt } from "./session.js";
import { SPEC } from "../../lib/vault-kinds/kinds.js";

/** How recent the proof must be for an item that asks every time. */
export const REPROMPT_MS = 60_000;

const ok = data => ({ status: 200, body: { data } });
const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const origin = u => { try { const x = new URL(String(u)); return ["http:", "https:"].includes(x.protocol) ? x.origin : null; } catch { return null; } };

/** Rows of one kind, names and descriptions only. @param {import("./fill.js").Fill} fill @param {string} kind */
function listed(fill, kind) {
  return /** @type {any[]} */ (fill.db.prepare("SELECT * FROM vault_items WHERE kind = ? ORDER BY name").all(kind))
    .filter(r => fill.vault.rowOk("vault_items", r))
    .map(r => ({ name: r.name, description: r.description || "" }));
}

/**
 * A card's expiry as the page wants it: "MM/YY", with the month and the four-digit year apart.
 * Takes "12/29", "12/2029", "12-29", "1229", "122029", "2029-12" and "12 / 29". Anything else is
 * null, and the caller hands the expiry over as it was written.
 * @param {unknown} v
 * @returns {{ expiry: string, exp_month: string, exp_year: string } | null}
 */
export function normalExpiry(v) {
  const s = String(v ?? "").trim();
  let m, y;
  let x;
  if ((x = /^(\d{4})\s*[-/.]\s*(\d{1,2})$/.exec(s))) { y = x[1]; m = x[2]; }
  else if ((x = /^(\d{1,2})\s*[-/.]\s*(\d{2}|\d{4})$/.exec(s))) { m = x[1]; y = x[2]; }
  else if ((x = /^(\d{2})(\d{2}|\d{4})$/.exec(s))) { m = x[1]; y = x[2]; }
  else return null;
  const month = Number(m);
  if (!(month >= 1 && month <= 12)) return null;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const mm = String(month).padStart(2, "0");
  return { expiry: `${mm}/${String(year).slice(2)}`, exp_month: mm, exp_year: String(year) };
}

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export function listRoute(fill, b, h) {
  const d = fill.device(h);
  if ("status" in d) return d;
  const o = origin(b.url);
  fill.vault.audit("fill-cards", null, fill.who(d), true, o || "no page");
  return ok({ cards: listed(fill, "card"), addresses: listed(fill, "address") });
}

/**
 * The shared half of a card or address fill: device, session, the page, the item, the reprompt
 * rule and the sealed fields. Returns the fields, or a reply (already audited).
 * @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h @param {"card"|"address"} kind
 */
async function open(fill, b, h, kind) {
  const action = kind === "card" ? "fill-card" : "fill-address";
  const name = typeof b.name === "string" && b.name ? b.name : null;
  const g = gate(fill, h, action, name);
  if (g.reply) return { reply: g.reply };
  const { d, who, s, refuse } = /** @type {any} */ (g);
  if (!name) return { reply: refuse(400, "bad_input", `give the ${kind}'s name`) };
  const o = origin(b.url);
  if (!o) return { reply: refuse(400, "bad_input", "the page is not an http or https page") };
  const r = fill.vault.row(name);
  if (!r || r.kind !== kind) return { reply: refuse(404, "not_found", `no ${kind} named ${name}`) };
  // Asks every time: the proof behind this session must be fresh, not the start of a long window.
  if (reprompt(fill.vault, name) && !(fill.now() - Number(s.created) < REPROMPT_MS))
    return { reply: refuse(401, "reprompt", `this ${kind} asks every time: unlock again`) };
  let f;
  try { f = await fill.vault.fields(r); } catch (e) { const [st, c, m] = openFailed(e, name); return { reply: refuse(st, c, m) }; }
  fill.db.prepare("UPDATE vault_sessions SET last_used = ? WHERE id = ?").run(fill.now(), s.id);
  fill.vault.audit(action, name, who, true, o);
  fill.vault.emit("vault.filled", { name, device: d.id, what: kind });
  return { f };
}

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export async function cardRoute(fill, b, h) {
  const got = await open(fill, b, h, "card");
  if (got.reply) return got.reply;
  const f = /** @type {Record<string, string>} */ (got.f);
  /** @type {Record<string, string>} */
  const out = {};
  if (f.holder) out.holder = f.holder;
  if (f.number) out.number = f.number;
  if (f.expiry) Object.assign(out, normalExpiry(f.expiry) || { expiry: f.expiry });
  if (f.cvv) out.cvv = f.cvv;
  return ok(out);
}

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export async function addressRoute(fill, b, h) {
  const got = await open(fill, b, h, "address");
  if (got.reply) return got.reply;
  const f = /** @type {Record<string, string>} */ (got.f);
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of /** @type {string[]} */ (SPEC.address.fields)) if (f[k]) out[k] = f[k];
  return ok(out);
}

/**
 * POST identities {}: every login's sites and the name to show for it, for the phone's and the
 * Mac's own autofill list (iOS and macOS ASCredentialIdentityStore, Android's inline chips). The
 * OS must know (site, user) before anyone unlocks, or it shows nothing. This is the one place a
 * username leaves the seal, into storage the OS protects (ADR 0028, threat model), so it needs a
 * live session to fetch, and `vault.autofill.identities: "names"` in config.json sends the item's
 * name in place of the username. Passwords never.
 * @param {import("./fill.js").Fill} fill @param {any} _b @param {Record<string, string>} h
 */
export async function identitiesRoute(fill, _b, h) {
  const g = gate(fill, h, "identities", null);
  if (g.reply) return g.reply;
  const namesOnly = fill.identities === "names";
  const out = [];
  for (const r of /** @type {any[]} */ (fill.db.prepare("SELECT * FROM vault_items WHERE kind IN ('login', 'passkey') ORDER BY name").all())) {
    if (!fill.vault.rowOk("vault_items", r)) continue;
    const details = json(r.details, {});
    if (r.kind === "passkey") {
      // The user handle is what the site knows the account by; iOS files the passkey under it.
      let handle = "";
      try { handle = (await fill.vault.fields(r)).user_handle || ""; } catch { /* locked: listed without it */ }
      out.push({ name: r.name, kind: "passkey", rp: details.rp, credential: details.credential, userHandle: handle, user: namesOnly ? r.name : r.description.split(" · ")[0] });
      continue;
    }
    let user = r.name;
    if (!namesOnly) {
      // A locked personal vault gives what it can: the item name stands in for the username.
      try { user = (await fill.vault.fields(r)).username || r.name; } catch { user = r.name; }
    }
    // Whether it has a one-time-code seed (iOS 18 offers it for code fields); never the seed.
    out.push({ name: r.name, kind: "login", sites: fill.hostsOf(r), apps: json(r.apps, []), user, totp: json(r.fields, []).includes("totp") });
  }
  fill.vault.audit("identities", null, g.who, true, `${out.length} identities${namesOnly ? ", names only" : ""}`);
  return ok({ identities: out, users: namesOnly ? "names" : "usernames" });
}
