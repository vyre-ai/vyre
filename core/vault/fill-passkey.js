// @ts-check
// fill-passkey: passkeys through the fill listener, so the extension can stand in for the
// browser's own authenticator on the Mac (ADR 0028, decision 7).
//
//   POST /v1/fill/passkeys        { url, rpId }                                   -> { passkeys: [{ id, name, description }] }
//   POST /v1/fill/passkey.create  { url, rpId, challenge, user, algs, exclude? }  -> { name, response }
//   POST /v1/fill/passkey.get     { url, rpId, challenge, allow?, id? }           -> { response } | { choose: [...] }
//   POST /v1/fill/passkey.assert  { rpId, clientDataHash, credential }             -> { credentialId, authenticatorData, signature, userHandle }
//   POST /v1/fill/passkey.register { rpId, clientDataHash, user, algs, exclude? }  -> { name, credentialId, attestationObject }
//
// The last two are for iOS, macOS and Android's Credential Manager, which build clientDataJSON
// themselves (with the origin they checked) and hand over only its hash. With "none"
// attestation, registration does not sign the client data at all, so its hash is only echoed.
//
// The page's origin is the extension worker's to give (the sender's URL, never the page's say),
// and webauthn.js refuses an rpId the origin may not claim. Listing needs a paired device; making
// or using a passkey needs a live session too, the same person-present window a password fill
// has, which is what lets the response say the user was verified. The private key is sealed in
// the vault as a `passkey` item and never leaves vyred: only signatures do. Audit rows carry the
// rpId and the item's name, never a key, a challenge or a user handle.

import crypto from "node:crypto";
import { gate, openFailed } from "./fill-save.js";
import { createCredential, getAssertion, assertHash, rpIdAllowed } from "./webauthn.js";
import { slug } from "./import.js";

const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
const ok = data => ({ status: 200, body: { data } });
const origin = u => { try { const x = new URL(String(u)); return x.protocol === "https:" || (x.protocol === "http:" && x.hostname === "localhost") ? x.origin : null; } catch { return null; } };
const B64U = /^[A-Za-z0-9_-]{1,1400}$/;

/** Passkey rows for an rpId, from their listable details. @param {import("./fill.js").Fill} fill @param {string} rpId */
function passkeysFor(fill, rpId) {
  return /** @type {any[]} */ (fill.db.prepare("SELECT * FROM vault_items WHERE kind = 'passkey' ORDER BY name").all())
    .filter(r => fill.vault.rowOk("vault_items", r) && json(r.details, {}).rp === rpId);
}

/** A WebAuthn error name and message the page can be given, as the browser would. */
const domError = e => {
  const n = /** @type {any} */ (e).name;
  return ["SecurityError", "NotSupportedError", "InvalidStateError", "NotAllowedError", "TypeError"].includes(n) ? n : "UnknownError";
};

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export function listRoute(fill, b, h) {
  const d = fill.device(h);
  if ("status" in d) return d;
  const o = origin(b.url), rpId = String(b.rpId || (o ? new URL(o).hostname : ""));
  if (!o || !rpIdAllowed(rpId, o)) return ok({ passkeys: [] });
  return ok({ passkeys: passkeysFor(fill, rpId).map(r => ({ id: json(r.details, {}).credential, name: r.name, description: r.description })) });
}

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export async function createRoute(fill, b, h) {
  const g = gate(fill, h, "passkey-create", null);
  if (g.reply) return g.reply;
  const { refuse } = /** @type {any} */ (g);
  const o = origin(b.url);
  if (!o) return refuse(400, "SecurityError", "passkeys need an https page");
  const rpId = String(b.rpId || new URL(o).hostname);
  const exclude = Array.isArray(b.exclude) ? b.exclude.filter(x => typeof x === "string" && B64U.test(x)) : [];
  if (exclude.length && passkeysFor(fill, rpId).some(r => exclude.includes(json(r.details, {}).credential)))
    return refuse(409, "InvalidStateError", `a passkey for this account on ${rpId} is already in the vault`);
  let made;
  try { made = createCredential({ rpId, origin: o, challenge: b.challenge, user: b.user, algs: Array.isArray(b.algs) ? b.algs : [], crossOrigin: Boolean(b.crossOrigin), topOrigin: b.topOrigin }); }
  catch (e) { return refuse(400, domError(e), /** @type {Error} */ (e).message); }
  const c = made.credential;
  let name = slug(`${rpId} ${c.userName || "passkey"}`) || "passkey";
  for (let n = 2; fill.vault.row(name); n++) name = `${slug(`${rpId} ${c.userName || "passkey"}`).slice(0, 120)}-${n}`;
  try {
    await fill.vault.put({ name, kind: "passkey", description: `${c.userName || c.displayName || "passkey"} · ${rpId}`,
      fields: { private_key: c.privateKey, credential_id: c.id, user_handle: c.userHandle, user_name: c.userName, display_name: c.displayName, rp_id: rpId, public_key: c.publicKey, sign_count: "0" },
      hosts: [o], origin: "passkey", details: { rp: rpId, credential: c.id } }, `device:${g.d.id}:${g.d.name}`);
  } catch (e) { const [s, code, m] = openFailed(e, name); return refuse(s, code, m); }
  fill.vault.audit("passkey-create", name, g.who, true, rpId);
  fill.vault.emit("vault.item-added", { name, kind: "passkey" });
  return ok({ name, response: made.response });
}

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export async function getRoute(fill, b, h) {
  const g = gate(fill, h, "passkey-get", null);
  if (g.reply) return g.reply;
  const { refuse } = /** @type {any} */ (g);
  const o = origin(b.url);
  if (!o) return refuse(400, "SecurityError", "passkeys need an https page");
  const rpId = String(b.rpId || new URL(o).hostname);
  if (!rpIdAllowed(rpId, o)) return refuse(400, "SecurityError", `${o} may not use passkeys for ${rpId}`);
  const allow = Array.isArray(b.allow) ? b.allow.filter(x => typeof x === "string" && B64U.test(x)) : [];
  let rows = passkeysFor(fill, rpId);
  if (allow.length) rows = rows.filter(r => allow.includes(json(r.details, {}).credential));
  if (typeof b.id === "string") rows = rows.filter(r => json(r.details, {}).credential === b.id);
  if (!rows.length) return refuse(404, "NotAllowedError", `no passkey for ${rpId} in the vault`);
  // More than one account here: the extension asks which, then comes back with its id.
  if (rows.length > 1) return ok({ choose: rows.map(r => ({ id: json(r.details, {}).credential, name: r.name, description: r.description })) });
  const r = rows[0];
  let f;
  try { f = await fill.vault.fields(r); } catch (e) { const [s, code, m] = openFailed(e, r.name); return refuse(s, code, m); }
  let out;
  try {
    out = getAssertion({ credential: { id: f.credential_id, rpId: f.rp_id, userHandle: f.user_handle, privateKey: f.private_key, signCount: Number(f.sign_count) || 0 },
      origin: o, challenge: b.challenge, crossOrigin: Boolean(b.crossOrigin), topOrigin: b.topOrigin });
  } catch (e) { return refuse(400, domError(e), /** @type {Error} */ (e).message); }
  fill.db.prepare("UPDATE vault_sessions SET last_used = ? WHERE id = ?").run(fill.now(), g.s.id);
  fill.vault.audit("passkey-get", r.name, g.who, true, rpId);
  fill.vault.emit("vault.filled", { name: r.name, device: g.d.id });
  return ok({ response: out.response });
}

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export async function assertRoute(fill, b, h) {
  const g = gate(fill, h, "passkey-get", null);
  if (g.reply) return g.reply;
  const { refuse } = /** @type {any} */ (g);
  const rpId = String(b.rpId || "");
  if (typeof b.credential !== "string" || !B64U.test(b.credential)) return refuse(400, "TypeError", "name the passkey by its credential id");
  const r = passkeysFor(fill, rpId).find(x => json(x.details, {}).credential === b.credential);
  if (!r) return refuse(404, "NotAllowedError", `no such passkey for ${rpId}`);
  let f;
  try { f = await fill.vault.fields(r); } catch (e) { const [s, code, m] = openFailed(e, r.name); return refuse(s, code, m); }
  let out;
  try { out = assertHash({ credential: { id: f.credential_id, rpId: f.rp_id, userHandle: f.user_handle, privateKey: f.private_key, signCount: Number(f.sign_count) || 0 }, clientDataHash: b.clientDataHash }); }
  catch (e) { return refuse(400, domError(e), /** @type {Error} */ (e).message); }
  fill.db.prepare("UPDATE vault_sessions SET last_used = ? WHERE id = ?").run(fill.now(), g.s.id);
  fill.vault.audit("passkey-get", r.name, g.who, true, rpId);
  fill.vault.emit("vault.filled", { name: r.name, device: g.d.id });
  return ok(out);
}

/** @param {import("./fill.js").Fill} fill @param {any} b @param {Record<string, string>} h */
export async function registerRoute(fill, b, h) {
  const rpId = String(b.rpId || "");
  if (typeof b.clientDataHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(b.clientDataHash)) {
    const g0 = gate(fill, h, "passkey-create", null);
    return g0.reply || /** @type {any} */ (g0).refuse(400, "TypeError", "clientDataHash is 32 bytes of base64url");
  }
  // The platform checked the origin; the registration itself is the same as the extension's, with
  // the rpId's own https origin standing in for the page (none attestation signs no client data).
  const made = await createRoute(fill, { url: `https://${rpId}`, rpId, challenge: crypto.randomBytes(32).toString("base64url"), user: b.user, algs: b.algs, exclude: b.exclude }, h);
  if (made.status !== 200) return made;
  const d = made.body.data;
  return ok({ name: d.name, credentialId: d.response.id, attestationObject: d.response.response.attestationObject,
    authenticatorData: d.response.response.authenticatorData, publicKey: d.response.response.publicKey });
}

/** For tests: a fresh challenge, as a relying party makes one. */
export const challenge = () => crypto.randomBytes(32).toString("base64url");
