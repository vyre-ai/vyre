// @ts-check
// codes: the authenticator. Every item with a one-time-code seed, its current and next code, and
// Google Authenticator's export (or plain otpauth:// codes) brought in as authenticator items.
//
// The list opens every seed, so it takes presence, and it rides the 30-minute window like a
// single code does. It returns codes, never a seed. The client draws the countdown from
// `remaining` and asks again when a code rolls over, and only while the list is on screen.

import { totp, parseOtpauth } from "./totp.js";
import { gather } from "./otpmigration.js";
import { slug, NAME } from "./import.js";

const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/**
 * Current and next codes for every item holding a seed (or the ones named).
 * @param {import("./vault.js").Vault} vault
 * @param {{ names?: string[], at?: number }} input
 * @param {string} caller
 */
export async function codes(vault, { names, at = Date.now() } = {}, caller) {
  await vault.key();
  const want = Array.isArray(names) && names.length ? new Set(names.map(String)) : null;
  const rows = /** @type {any[]} */ (vault.db.prepare("SELECT * FROM vault_items ORDER BY name").all())
    .filter(r => json(r.fields, []).includes("totp") && (!want || want.has(r.name)) && vault.rowOk("vault_items", r));
  const out = [];
  for (const r of rows) {
    let f;
    try { f = await vault.fields(r); } catch (e) { if (/** @type {any} */ (e).code === "locked") throw e; continue; }
    let c;
    try { c = totp(f.totp, { at }); } catch { out.push({ name: r.name, kind: r.kind, error: "the seed does not read as a TOTP" }); continue; }
    const next = totp(f.totp, { at: at + c.remaining * 1000 }).code;
    const d = json(r.details, {});
    out.push({ name: r.name, kind: r.kind, ...(d.issuer ? { issuer: d.issuer } : {}), code: c.code, next, period: c.period, remaining: c.remaining, digits: c.digits });
  }
  vault.audit("totp", null, caller, true, `${out.length} codes listed`);
  return { codes: out, at };
}

/** A seed, normalised, so the same account scanned twice is found. @param {string} t */
const seedOf = t => { try { const p = parseOtpauth(t); return `${p.algorithm}:${p.digits}:${p.period}:${p.secret.toString("hex")}`; } catch { return null; } };

/**
 * Bring in accounts from scanned codes: Google Authenticator's `otpauth-migration://` parts (all
 * of a batch, in any order) and plain `otpauth://totp/` URIs. A seed already in the vault is
 * `same`. With `preview`, nothing is stored. Names come from the issuer and the account label.
 * @param {import("./vault.js").Vault} vault
 * @param {{ uris: string[], preview?: boolean }} input
 * @param {string} caller
 */
export async function importCodes(vault, { uris, preview = false }, caller) {
  if (!Array.isArray(uris) || !uris.length) throw new Error("give the scanned codes as uris");
  if (uris.length > 100) throw new Error("at most 100 codes at a time");
  const g = gather(uris.map(String));
  if (g.missing.length && !preview) {
    const m = g.missing[0];
    throw Object.assign(new Error(`scan part${m.parts.length > 1 ? "s" : ""} ${m.parts.join(", ")} of ${m.of} too; the export is split across ${m.of} codes`), { code: "incomplete" });
  }
  await vault.key();
  const seeds = new Map();
  const taken = new Set();
  for (const r of /** @type {any[]} */ (vault.db.prepare("SELECT * FROM vault_items").all())) {
    taken.add(String(r.name));
    if (!json(r.fields, []).includes("totp") || !vault.rowOk("vault_items", r)) continue;
    try { const s = seedOf((await vault.fields(r)).totp); if (s) seeds.set(s, r.name); }
    catch (e) { if (/** @type {any} */ (e).code === "locked") throw e; }
  }
  const add = [], same = [], renamed = [], skipped = [...g.skipped];
  for (const a of g.accounts) {
    const s = seedOf(a.uri);
    const who = [a.issuer, a.account].filter(Boolean).join(" ") || "an account";
    if (!s) { skipped.push(`${who}: the code does not read as a TOTP`); continue; }
    if (seeds.has(s)) { same.push(seeds.get(s)); continue; }
    const base = slug([a.issuer, a.account].filter(Boolean).join(" ")) || "code";
    let name = base;
    for (let n = 2; taken.has(name) || !NAME.test(name); n++) name = `${base.slice(0, 120)}-${n}`;
    if (name !== base) renamed.push({ from: base, to: name });
    taken.add(name);
    seeds.set(s, name);
    add.push({ name, a });
  }
  const added = [];
  if (!preview) {
    for (const { name, a } of add) {
      try {
        await vault.put({ name, kind: "authenticator", description: [a.issuer, a.account].filter(Boolean).join(" · "),
          fields: { totp: a.uri, ...(a.account ? { account: a.account } : {}) }, origin: "import:authenticator",
          ...(a.issuer ? { details: { issuer: a.issuer.slice(0, 80) } } : {}) }, caller);
        added.push(name);
      } catch (e) { skipped.push(`${name}: ${/** @type {Error} */ (e).message}`); }
    }
  }
  vault.audit(preview ? "import-preview" : "import", null, caller, true, `authenticator: ${preview ? add.length + " new" : added.length + " added"}, ${same.length} same, ${skipped.length} skipped`);
  return { ...(preview ? { add: add.map(x => x.name) } : { added }), same, renamed, skipped, ...(g.missing.length ? { missing: g.missing } : {}) };
}
