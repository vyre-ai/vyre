// kernel/seal/engine.js: the sealing engine (contract 8; invariants 5 and 6). It holds sealed plaintext, encrypted at rest
// under the Space's vault key, and holds it only here: `put` takes a value in, `use` merges it into a template and hands
// the merged output to the egress boundary, `reveal` returns it to a human's reveal view, `check` asks whether a prompt
// contains a value the session resolved. The engine runs in its own process (serve.js); nothing else holds plaintext.
// Errors never carry a value, a ref's plaintext or a stack that could.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonical, hmac, sameMac } from "../core/canonical.js";
import { mintUuid } from "../core/ids.js";
import { CLASSES } from "./classes.js";
import { normalized } from "./normalize.js";

export class SealError extends Error {
  /** @param {string} code @param {string} message generic: never a value */
  constructor(code, message) { super(message); this.name = "SealError"; this.code = code; }
}

const MAX_WINDOWS = 400_000;
const MIN_LEDGER_LEN = 6;

/**
 * @param {{ key: Buffer, ticket_key: Buffer, dir?: string, egress: (out: { output_ref: string, text: string, destination: any }) => void, clock?: () => number, rand?: (n: number) => Buffer }} cfg
 *   key: the Space's vault key (32 bytes). ticket_key: shared with the kernel, which mints one ticket per sensitive call.
 *   dir: where the encrypted vault is kept (omit for memory only). egress: the connector boundary a merged output goes to.
 */
export function createSealEngine(cfg) {
  const clock = cfg.clock || Date.now;
  const rand = cfg.rand || (n => randomBytes(n));
  if (!Buffer.isBuffer(cfg.key) || cfg.key.length !== 32) throw new SealError("bad_key", "the vault key must be 32 bytes");
  /** @type {Map<string, any>} */ const vault = new Map();
  /** @type {Map<string, any>} */ const derivatives = new Map();
  /** @type {Map<string, { key: Buffer, lens: Map<number, Set<string>> }>} */ const ledgers = new Map();
  /** @type {Map<string, any[]>} */ const stashes = new Map();
  /** @type {Set<string>} */ const usedNonces = new Set();
  const file = cfg.dir ? path.join(cfg.dir, "vault.json") : null;

  const seal = (/** @type {string} */ text, /** @type {string} */ aad) => {
    const iv = rand(12), c = createCipheriv("aes-256-gcm", cfg.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return { iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url") };
  };
  const open = (/** @type {any} */ e, /** @type {string} */ aad) => {
    try {
      const d = createDecipheriv("aes-256-gcm", cfg.key, Buffer.from(e.iv, "base64url"));
      d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(e.tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(e.ct, "base64url")), d.final()]).toString("utf8");
    } catch { throw new SealError("unreadable", "the sealed value could not be opened"); }
  };
  const persist = () => { if (file) { fs.writeFileSync(file + ".tmp", JSON.stringify([...vault])); fs.renameSync(file + ".tmp", file); } };
  if (file && fs.existsSync(file)) for (const [k, v] of JSON.parse(fs.readFileSync(file, "utf8"))) vault.set(k, v);

  /** A ticket is the kernel's word that it authorized exactly this call: bound to the op, the args hash, an expiry and a nonce. */
  function checkTicket(/** @type {string} */ op, /** @type {any} */ args, /** @type {any} */ ticket) {
    if (!ticket || typeof ticket.mac !== "string" || typeof ticket.nonce !== "string" || typeof ticket.exp !== "number") throw new SealError("no_ticket", "this call needs the kernel's ticket");
    const body = canonical({ op, args, nonce: ticket.nonce, exp: ticket.exp });
    if (!sameMac(createHmac("sha256", cfg.ticket_key).update(body).digest("base64url"), ticket.mac)) throw new SealError("bad_ticket", "the ticket does not match this call");
    if (ticket.exp < clock()) throw new SealError("expired", "the ticket has expired");
    if (usedNonces.has(ticket.nonce)) throw new SealError("replayed", "the ticket was already used");
    usedNonces.add(ticket.nonce);
  }

  function ledgerFor(/** @type {string} */ session) {
    let l = ledgers.get(session);
    if (!l) { l = { key: rand(32), lens: new Map() }; ledgers.set(session, l); }
    return l;
  }
  /** Keep keyed hashes of the value's normalised form (never the value). The key lives only in memory and dies with the session. */
  function addToLedger(/** @type {string} */ session, /** @type {string} */ value) {
    const norm = normalized(value);
    if (norm.length < MIN_LEDGER_LEN) return;
    const l = ledgerFor(session);
    if (!l.lens.has(norm.length)) l.lens.set(norm.length, new Set());
    /** @type {Set<string>} */ (l.lens.get(norm.length)).add(hmac(l.key, norm));
  }

  return {
    /** Take a value in. Returns metadata only. */
    put(/** @type {{ record: string, field: string, class: string, value: string, hint_allowed?: boolean, session?: string }} */ a) {
      const def = CLASSES[a.class];
      if (!def) throw new SealError("invalid_class", "unknown seal class");
      if (typeof a.value !== "string" || !a.value.length) throw new SealError("invalid", "nothing to seal");
      const ref = `seal_${mintUuid(clock(), rand)}`;
      const meta = { sealed: def.label, ref, present: true, valid_format: Boolean(def.valid(a.value)), set_at: clock(), ...(a.hint_allowed && def.hint ? { hint: def.hint(a.value) } : {}) };
      vault.set(ref, { class: a.class, record: a.record, field: a.field, meta, enc: seal(a.value, ref) });
      persist();
      return { ref: meta };
    },

    meta(/** @type {{ ref: string }} */ a) {
      const v = vault.get(a.ref);
      if (!v) throw new SealError("not_found", "no such sealed value");
      return { ref: v.meta, class: v.class, record: v.record, field: v.field };
    },

    /** Merge into a template's body at the declared slot and hand the output to the egress boundary. Returns that it happened. */
    use(/** @type {{ ref: string, template: { id: string, version: number, body: string, slots: string[], headers?: Record<string, string> }, slot: string, destination: any, session?: string }} */ a, /** @type {any} */ ticket) {
      checkTicket("use", a, ticket);
      const v = vault.get(a.ref);
      if (!v) throw new SealError("not_found", "no such sealed value");
      const t = a.template;
      if (!t || typeof t.body !== "string" || !Array.isArray(t.slots) || !t.slots.includes(a.slot)) throw new SealError("bad_slot", "the template does not declare that slot");
      // Positions are body-only (R6-4): a slot marker in a header or subject is refused, and a slot nobody wrote is refused.
      const marker = `{{${a.slot}}}`;
      if (Object.values(t.headers || {}).some(h => String(h).includes("{{"))) throw new SealError("slot_not_in_body", "a sealed slot may be in the body only");
      if (!t.body.includes(marker)) throw new SealError("slot_not_in_body", "the template body has no such slot");
      // Bound to purpose and subject (R5-4): a verified contact point or a document of the same record, nothing else.
      const d = a.destination;
      const ok = d && ((d.kind === "contact_point" && d.verified === true && d.record === v.record) || (d.kind === "document" && d.record === v.record && typeof d.document === "string"));
      if (!ok) throw new SealError("destination_not_allowed", "a sealed value goes only to a verified contact point or a document of its own record");
      const plain = open(v.enc, a.ref);
      const text = t.body.split(marker).join(plain);
      const output_ref = `vyre://${(v.record || "").slice(7).split("/")[0]}/seal-output/${mintUuid(clock(), rand)}`;
      // The merged output is itself sealed: kept encrypted, never returned. Echoes are defended by the ledger.
      derivatives.set(output_ref, { enc: seal(text, output_ref), record: v.record });
      if (a.session) addToLedger(a.session, plain);
      cfg.egress({ output_ref, text, destination: d });
      return { merged: true, output_ref };
    },

    /** Return the value to a human's reveal view. The kernel has already checked presence and that the chain is one person. */
    reveal(/** @type {{ ref: string, purpose: string, session?: string, ttl_ms?: number }} */ a, /** @type {any} */ ticket) {
      checkTicket("reveal", a, ticket);
      const v = vault.get(a.ref);
      if (!v) throw new SealError("not_found", "no such sealed value");
      const value = open(v.enc, a.ref);
      if (a.session) addToLedger(a.session, value);
      return { value, expires_in_ms: a.ttl_ms || 30_000, record: v.record, field: v.field, class: v.class };
    },

    /** Does this text contain a value the session resolved? Exact or normalised; answers a class label, never a value. */
    check(/** @type {{ session: string, text: string }} */ a) {
      const l = ledgers.get(a.session);
      if (!l || !l.lens.size) return { hit: null };
      const norm = normalized(a.text);
      let windows = 0;
      for (const [len, set] of l.lens) {
        for (let i = 0; i + len <= norm.length; i++) {
          if (++windows > MAX_WINDOWS) return { hit: null, truncated: true };
          if (set.has(hmac(l.key, norm.slice(i, i + len)))) return { hit: { class: "ledger" } };
        }
      }
      return { hit: null };
    },

    /** Keep what a detector took out of a prompt, bound to the session; erased with it. */
    stash(/** @type {{ session: string, originals: any[] }} */ a) {
      const list = stashes.get(a.session) || [];
      for (const o of a.originals) { list.push({ cls: o.cls, label: o.label, index: o.index, enc: seal(o.value, `stash:${a.session}`) }); addToLedger(a.session, o.value); }
      stashes.set(a.session, list);
      return { stashed: list.length };
    },
    stashed(/** @type {{ session: string }} */ a) { return { n: (stashes.get(a.session) || []).length }; },

    /** The session is over: its ledger and stash are erased. */
    endSession(/** @type {{ session: string }} */ a) { ledgers.delete(a.session); stashes.delete(a.session); return { ended: true }; },

    /** Forget a sealed value (the field was removed or unsealed with an Ask). */
    forget(/** @type {{ ref: string }} */ a) { const had = vault.delete(a.ref); persist(); return { forgotten: had }; },

    stats: () => ({ values: vault.size, derivatives: derivatives.size, sessions: ledgers.size }),
  };
}
