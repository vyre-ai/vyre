// @ts-check
// site.*: what Vyre for Chrome learned about each website, kept in Vyre Memory (team/0.2/chrome-learning-plan.md).
//
// The record's rules (allowlist, privacy, merge, self-heal) are lib/site-knowledge.js, shared with the extension
// and standalone Vyre for Chrome, so a record means the same thing on every side. This file is the store and the
// tools: one row per origin and per family, the small arrival card Chrome reads on every page, a bounded event
// ring, and a 24-hour undo for a forgotten record.
//
// Callers: the person's own surfaces and first-party modules (Chrome's bridge) read and write; an agent never
// does (Chrome's own tools read it on the person's behalf). Two settings, both on by default: memory.site.learn
// (learn at all) and memory.site.sync (take what standalone Vyre for Chrome learned on its own).

import {
  sanitize, emptyRecord, mergeRecord, mergeFamily, union, arrivalCard, heal, itemId, keyOk, isFamilyKey, isQuarantined, readConf, LIMITS,
} from "../../lib/site-knowledge.js";

const PERSON = new Set(["deck", "cli", "local", "capsule"]);
const UNDO_MS = 24 * 3_600_000;
const EVENTS_PER_KEY = 200;
const PARTS = ["frames", "controls", "api", "flows", "notes", "ready", "wall", "signedIn"];

/** Tables this part of memory owns, for memory.wipe and memory.export when they land. */
export const SITE_TABLES = Object.freeze(["memory_site", "memory_site_events", "memory_site_forgotten"]);

/**
 * @param {any} ctx
 * @param {{ denied: (m: string) => Error }} deps
 */
export function register(ctx, { denied }) {
  const db = ctx.store.db;
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
  const q = {
    get: db.prepare("SELECT key, kind, rev, record, card, updated FROM memory_site WHERE key = ?"),
    cardOf: db.prepare("SELECT card, rev FROM memory_site WHERE key = ?"),
    put: db.prepare(`INSERT INTO memory_site (key, kind, rev, record, card, updated) VALUES (?,?,?,?,?,?)
      ON CONFLICT (key) DO UPDATE SET rev = excluded.rev, record = excluded.record, card = excluded.card, updated = excluded.updated`),
    del: db.prepare("DELETE FROM memory_site WHERE key = ?"),
    all: db.prepare("SELECT key, kind, rev, record, updated FROM memory_site ORDER BY updated DESC"),
    ev: db.prepare("INSERT INTO memory_site_events (key, at, kind, item, outcome) VALUES (?,?,?,?,?)"),
    trim: db.prepare("DELETE FROM memory_site_events WHERE key = ? AND id NOT IN (SELECT id FROM memory_site_events WHERE key = ? ORDER BY id DESC LIMIT ?)"),
    forgot: db.prepare("INSERT INTO memory_site_forgotten (key, record, at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET record = excluded.record, at = excluded.at"),
    unforget: db.prepare("SELECT record, at FROM memory_site_forgotten WHERE key = ?"),
    unforgot: db.prepare("DELETE FROM memory_site_forgotten WHERE key = ?"),
    purge: db.prepare("DELETE FROM memory_site_forgotten WHERE at < ?"),
  };

  /** Who may use the store: the person's surfaces, their other devices, and Vyre's own modules. Never an agent. @param {any} caller @param {any} meta */
  const chrome = (caller, meta) => { const c = String(caller || ""); return PERSON.has(c) || /^tailnet:(?!agent:)\S+$/.test(c) || (c.startsWith("module:") && meta && meta.firstParty === true); };
  const personOnly = (caller, what) => { const c = String(caller || ""); if (!(PERSON.has(c) || /^tailnet:(?!agent:)\S+$/.test(c))) throw denied(`${what} is for the person's own surfaces`); };

  /** A setting, default on. @param {string} key */
  const setting = async key => {
    try {
      const r = await ctx.call("settings.get", { key });
      const d = r && r.data !== undefined ? r.data : r;
      if (d && typeof d.value === "boolean") return d.value;
    } catch { /* no settings hub: the default */ }
    const c = ctx.config && ctx.config.memory && ctx.config.memory.site;
    const v = c && c[key.split(".").pop() || ""];
    return typeof v === "boolean" ? v : true;
  };

  const load = (/** @type {string} */ key) => { const r = /** @type {any} */ (q.get.get(key)); return r ? JSON.parse(r.record) : null; };
  const save = (/** @type {any} */ rec) => {
    const card = arrivalCard(rec, { now: now() });
    q.put.run(rec.key, isFamilyKey(rec.key) ? "family" : "origin", rec.rev, JSON.stringify(rec), JSON.stringify(card), now());
    return card;
  };
  const event = (/** @type {string} */ key, /** @type {string} */ kind, item = null, outcome = null) => { q.ev.run(key, now(), kind, item, outcome); q.trim.run(key, key, EVENTS_PER_KEY); };
  const counts = (/** @type {any} */ r) => ({ controls: r.controls.length, api: r.api.length, flows: r.flows.length, notes: r.notes.length, frames: r.frames.length });
  const familyKey = (/** @type {string} */ id) => `family:${id}`;
  const cardFor = (/** @type {string} */ key) => { const r = /** @type {any} */ (q.cardOf.get(key)); return r ? { card: JSON.parse(r.card), rev: Number(r.rev) } : null; };
  q.purge.run(now() - UNDO_MS);

  ctx.tool("memory.site.get", {
    description: "What Vyre for Chrome knows about a site: { origin, family?, rev, family_rev } cards (the small record Chrome reads on every page), or { not_modified: true } when since_rev and family_rev are current. parts: [controls|api|flows|notes|frames] returns the full record's named parts instead of the card. Structure only, never a value. For the person's surfaces and Vyre's own modules.",
    input: { type: "object", required: ["origin"], properties: { origin: { type: "string" }, since_rev: { type: "integer" }, family_rev: { type: "integer" },
      parts: { type: "array", items: { type: "string", enum: PARTS } } } },
    run: async (i, { caller, ...meta } = {}) => {
      if (!chrome(caller, meta)) throw denied("site knowledge is for the person's own surfaces and Chrome's bridge");
      if (!keyOk(i.origin) || isFamilyKey(i.origin)) throw bad("origin is a scheme and host, like https://app.example");
      const own = cardFor(i.origin);
      const fam = own && own.card.family ? cardFor(familyKey(own.card.family)) : null;
      if (Number.isInteger(i.since_rev) && own && own.rev === i.since_rev && (!fam || fam.rev === i.family_rev)) return { not_modified: true, rev: own.rev, ...(fam ? { family_rev: fam.rev } : {}) };
      if (Array.isArray(i.parts) && i.parts.length) {
        const pick = (/** @type {any} */ rec) => rec && Object.fromEntries(i.parts.map((/** @type {string} */ p) => [p, p === "wall" ? rec.login.wall : p === "signedIn" ? rec.login.signedIn : rec[p]]).filter(([, v]) => v !== undefined));
        const rec = load(i.origin), frec = rec && rec.family ? load(familyKey(rec.family)) : null;
        return { origin: pick(rec), ...(frec ? { family: pick(frec) } : {}), rev: rec ? rec.rev : 0, ...(frec ? { family_rev: frec.rev } : {}) };
      }
      return { origin: own ? own.card : null, ...(fam ? { family: fam.card } : {}), rev: own ? own.rev : 0, ...(fam ? { family_rev: fam.rev } : {}) };
    },
  });

  ctx.tool("memory.site.put", {
    description: "Fold what Chrome observed into a site's record: { origin, target: 'origin'|'family', patch, base_rev? } -> { accepted, rev, dropped } or { accepted: false, refused: [{ path, why }] } when anything looks like a secret, a pairing seed or an email (nothing is kept, and the text is never echoed). Merges by item id, never replaces; a removal needs the current base_rev. A family is written only for an origin that belongs to it.",
    input: { type: "object", required: ["origin", "patch"], properties: { origin: { type: "string" }, target: { type: "string", enum: ["origin", "family"] }, family: { type: "string" },
      patch: { type: "object" }, base_rev: { type: "integer" } } },
    run: async (i, { caller, ...meta } = {}) => {
      if (!chrome(caller, meta)) throw denied("site knowledge is for the person's own surfaces and Chrome's bridge");
      if (!keyOk(i.origin) || isFamilyKey(i.origin)) throw bad("origin is a scheme and host, like https://app.example");
      if (!(await setting("memory.site.learn"))) return { accepted: false, learning: false };
      const target = i.target === "family" ? "family" : "origin";
      const own = load(i.origin);
      let key = i.origin;
      if (target === "family") {
        const id = String((own && own.family) || i.family || "");
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw bad("a family write names a family id");
        if (own && own.family && i.family && own.family !== i.family) throw denied("this origin belongs to another family");
        // A family is joined by the origin's own record first, so a write cannot reach a family its origin never named.
        if (!own || own.family !== id) throw denied("write the origin's record with its family first");
        key = familyKey(id);
      }
      const clean = sanitize({ ...(i.patch && typeof i.patch === "object" ? i.patch : {}), key });
      if (!clean.ok) { event(key, "refused", clean.refused.map(r => r.path).slice(0, 5).join(",").slice(0, 120), null); return { accepted: false, refused: clean.refused }; }
      const base = load(key) || emptyRecord(key);
      if (Array.isArray(clean.record.remove) && clean.record.remove.length && i.base_rev !== base.rev) throw bad(`a removal needs base_rev ${base.rev}`, "conflict");
      const rec = mergeRecord(base, clean.record, { now: now() });
      if (target === "origin" && clean.record.family && (!base.family || base.family === clean.record.family)) rec.family = clean.record.family;
      save(rec);
      event(key, "put", null, null);
      ctx.events.emit("memory.site-learned", { key, counts: counts(rec) });
      return { accepted: true, rev: rec.rev, dropped: clean.dropped.length };
    },
  });

  ctx.tool("memory.site.report", {
    description: "One outcome for one item Chrome already holds: { origin, target?, part, id, outcome: 'ok'|'miss', why? } -> { conf, quarantined }. A success raises its trust, a miss cuts it, and three misses over two days quarantine it (kept as 'used to work', dropped after 30 days).",
    input: { type: "object", required: ["origin", "part", "id", "outcome"], properties: { origin: { type: "string" }, target: { type: "string", enum: ["origin", "family"] },
      part: { type: "string", enum: PARTS }, id: { type: "string" }, outcome: { type: "string", enum: ["ok", "miss"] }, why: { type: "string" } } },
    run: async (i, { caller, ...meta } = {}) => {
      if (!chrome(caller, meta)) throw denied("site knowledge is for the person's own surfaces and Chrome's bridge");
      if (!keyOk(i.origin) || isFamilyKey(i.origin)) throw bad("origin is a scheme and host, like https://app.example");
      if (!(await setting("memory.site.learn"))) return { conf: null, learning: false };
      const own = load(i.origin);
      const key = i.target === "family" && own && own.family ? familyKey(own.family) : i.origin;
      const rec = key === i.origin ? own : load(key);
      if (!rec) return { conf: null };
      const list = i.part === "wall" ? rec.login.wall : i.part === "signedIn" ? rec.login.signedIn : rec[i.part];
      if (!Array.isArray(list)) throw bad("unknown part");
      const at = list.findIndex((/** @type {any} */ x) => itemId(i.part, x) === String(i.id).slice(0, 200));
      if (at < 0) return { conf: null };
      list[at] = heal(list[at], i.outcome, now());
      rec.rev += 1; rec.updated = new Date(now()).toISOString();
      save(rec);
      event(key, "report", `${i.part}:${String(i.id).slice(0, 60)}`, i.outcome);
      return { conf: list[at].conf, quarantined: isQuarantined(list[at]) };
    },
  });

  ctx.tool("memory.site.list", {
    description: "Every site Vyre knows: [{ key, kind, names, family, rev, updated, verified, counts, used_to_work }], newest first, for the Sites list in Memory. The person's own surfaces only.",
    input: { type: "object", properties: {} },
    run: async (_i, { caller } = {}) => {
      personOnly(caller, "the list of sites");
      const sites = /** @type {any[]} */ (q.all.all()).map(r => {
        const rec = JSON.parse(r.record);
        const items = [...rec.controls, ...rec.api, ...rec.flows, ...rec.notes, ...rec.frames, ...rec.ready, ...rec.login.wall];
        const verified = items.map(x => x.verified).filter(Boolean).sort().pop() || null;
        return { key: r.key, kind: r.kind, names: rec.names, family: rec.family, rev: Number(r.rev), updated: Number(r.updated), verified, counts: counts(rec), used_to_work: items.filter(isQuarantined).length };
      });
      return { sites };
    },
  });

  ctx.tool("memory.site.forget", {
    description: "Forget one item of a site ({ key, part, id }) or a whole record ({ key }, an origin or family:<id>); all: true forgets every site. A whole record can be brought back for 24 hours with site.restore. The person's own surfaces only.",
    input: { type: "object", properties: { key: { type: "string" }, part: { type: "string", enum: PARTS }, id: { type: "string" }, all: { type: "boolean" } } },
    run: async (i, { caller } = {}) => {
      personOnly(caller, "forgetting a site");
      if (i.all === true) {
        const rows = /** @type {any[]} */ (q.all.all());
        for (const r of rows) { q.forgot.run(r.key, r.record, now()); q.del.run(r.key); event(r.key, "forgot", null, null); }
        return { forgotten: rows.length, undo_ms: UNDO_MS };
      }
      if (!keyOk(i.key)) throw bad("key is an origin or family:<id>");
      const rec = load(i.key);
      if (!rec) return { forgotten: 0 };
      if (i.part && i.id != null) {
        const list = i.part === "wall" ? rec.login.wall : i.part === "signedIn" ? rec.login.signedIn : rec[i.part];
        if (!Array.isArray(list)) throw bad("unknown part");
        const at = list.findIndex((/** @type {any} */ x) => itemId(i.part, x) === String(i.id));
        if (at < 0) return { forgotten: 0 };
        list.splice(at, 1);
        rec.tombstones = [{ part: i.part, id: String(i.id).slice(0, 200), at: new Date(now()).toISOString() }, ...rec.tombstones].slice(0, LIMITS.tombstones);
        rec.rev += 1; rec.updated = new Date(now()).toISOString();
        save(rec); event(i.key, "forgot", `${i.part}:${String(i.id).slice(0, 60)}`, null);
        return { forgotten: 1 };
      }
      q.forgot.run(i.key, JSON.stringify(rec), now()); q.del.run(i.key); event(i.key, "forgot", null, null);
      return { forgotten: 1, undo_ms: UNDO_MS };
    },
  });

  ctx.tool("memory.site.restore", {
    description: "Bring back a site forgotten in the last 24 hours: { key } -> { restored }. The person's own surfaces only.",
    input: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    run: async (i, { caller } = {}) => {
      personOnly(caller, "restoring a site");
      const r = /** @type {any} */ (q.unforget.get(String(i.key)));
      if (!r || now() - Number(r.at) > UNDO_MS) return { restored: 0 };
      const rec = JSON.parse(r.record);
      const have = load(rec.key);
      const out = have ? union(have, rec, { now: now() }) : rec;
      save(out); q.unforgot.run(String(i.key)); event(rec.key, "restored", null, null);
      return { restored: 1 };
    },
  });

  ctx.tool("memory.site.sync", {
    description: "Two-way sync with a replica (standalone Vyre for Chrome on a computer, once it reaches this box): { have: { key: rev }, push: [records] } -> { accepted, refused, pull: [records newer than have] }. Each pushed record goes through the same allowlist and is folded in by per-item newest-verified, never overwriting. Off when memory.site.sync is off. The person's own surfaces and Chrome's bridge.",
    input: { type: "object", properties: { have: { type: "object" }, push: { type: "array", maxItems: 100, items: { type: "object" } } } },
    run: async (i, { caller, ...meta } = {}) => {
      if (!chrome(caller, meta)) throw denied("site knowledge is for the person's own surfaces and Chrome's bridge");
      if (!(await setting("memory.site.sync"))) return { accepted: 0, refused: [], pull: [], sync: false };
      if (!(await setting("memory.site.learn"))) return { accepted: 0, refused: [], pull: [], learning: false };
      let accepted = 0; const refused = [];
      for (const r of (Array.isArray(i.push) ? i.push : []).slice(0, 100)) {
        const clean = sanitize(r);
        if (!clean.ok) { refused.push({ key: String(r && r.key || "").slice(0, 100), refused: clean.refused }); if (clean.refused.length && keyOk(r && r.key)) event(r.key, "refused", clean.refused.map(x => x.path).join(",").slice(0, 120), null); continue; }
        const have = load(clean.record.key);
        const out = have ? union(have, clean.record, { now: now() }) : { ...clean.record, rev: 1, updated: new Date(now()).toISOString() };
        save(out); accepted++; event(out.key, "sync", null, null);
      }
      const haveRev = i.have && typeof i.have === "object" ? i.have : {};
      const pull = /** @type {any[]} */ (q.all.all()).filter(r => !(Number(haveRev[r.key]) >= Number(r.rev))).slice(0, 100).map(r => JSON.parse(r.record));
      return { accepted, refused, pull };
    },
  });
}
