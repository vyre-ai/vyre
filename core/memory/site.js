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

import fs from "node:fs";
import { answerSite, neededKeys } from "./site-answer.js";
import {
  sanitize, testNow, emptyRecord, mergeRecord, mergeFamily, union, arrivalCard, heal, itemId, keyOk, isFamilyKey, isQuarantined, readConf, LIMITS,
} from "../../lib/site-knowledge.js";

const PERSON = new Set(["deck", "cli", "local", "capsule"]);
const PERSON_LABEL = /^(?:tailnet:(?!agent:)|device:)\S+$/;
const GONE_MS = 365 * 24 * 3_600_000;
const UNDO_MS = 24 * 3_600_000;
const EVENTS_PER_KEY = 200;
const PARTS = ["frames", "controls", "api", "flows", "notes", "ready", "wall", "signedIn"];

/** Tables this part of memory owns, for memory.wipe and memory.export when they land. */
export const SITE_TABLES = Object.freeze(["memory_site", "memory_site_events", "memory_site_forgotten", "memory_site_gone", "memory_site_forgotten_items"]);

/**
 * @param {any} ctx
 * @param {{ denied: (m: string) => Error }} deps
 */
export function register(ctx, { denied }) {
  const db = ctx.store.db;
  // The store's one clock: the miss window and the two-day quarantine read it. Under a test flag a harness may set it (VYRE_SITE_TEST_CLOCK).
  const now = () => testNow(process.env, p => fs.readFileSync(p, "utf8")) ?? (ctx.now ? ctx.now() : Date.now());
  const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
  const q = {
    get: db.prepare("SELECT key, kind, rev, record, card, updated FROM memory_site WHERE key = ?"),
    cardOf: db.prepare("SELECT card, rev FROM memory_site WHERE key = ?"),
    put: db.prepare(`INSERT INTO memory_site (key, kind, rev, record, card, updated, names, family) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (key) DO UPDATE SET rev = excluded.rev, record = excluded.record, card = excluded.card, updated = excluded.updated, names = excluded.names, family = excluded.family`),
    del: db.prepare("DELETE FROM memory_site WHERE key = ?"),
    all: db.prepare("SELECT key, kind, rev, record, updated FROM memory_site ORDER BY updated DESC"),
    index: db.prepare("SELECT key, names, family FROM memory_site"),
    byKeys: (/** @type {number} */ n) => db.prepare(`SELECT record FROM memory_site WHERE key IN (${Array(n).fill("?").join(",")})`),
    ev: db.prepare("INSERT INTO memory_site_events (key, at, kind, item, outcome) VALUES (?,?,?,?,?)"),
    trim: db.prepare("DELETE FROM memory_site_events WHERE key = ? AND id NOT IN (SELECT id FROM memory_site_events WHERE key = ? ORDER BY id DESC LIMIT ?)"),
    forgot: db.prepare("INSERT INTO memory_site_forgotten (key, record, at) VALUES (?,?,?) ON CONFLICT (key) DO UPDATE SET record = excluded.record, at = excluded.at"),
    unforget: db.prepare("SELECT record, at FROM memory_site_forgotten WHERE key = ?"),
    unforgot: db.prepare("DELETE FROM memory_site_forgotten WHERE key = ?"),
    purge: db.prepare("DELETE FROM memory_site_forgotten WHERE at < ?"),
    itemForgot: db.prepare("INSERT INTO memory_site_forgotten_items (key, part, id, item, at) VALUES (?,?,?,?,?) ON CONFLICT (key, part, id) DO UPDATE SET item = excluded.item, at = excluded.at"),
    itemGet: db.prepare("SELECT item, at FROM memory_site_forgotten_items WHERE key = ? AND part = ? AND id = ?"),
    itemDel: db.prepare("DELETE FROM memory_site_forgotten_items WHERE key = ? AND part = ? AND id = ?"),
    itemPurge: db.prepare("DELETE FROM memory_site_forgotten_items WHERE at < ?"),
    gone: db.prepare("INSERT INTO memory_site_gone (key, at) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET at = excluded.at"),
    goneGet: db.prepare("SELECT at FROM memory_site_gone WHERE key = ?"),
    goneDel: db.prepare("DELETE FROM memory_site_gone WHERE key = ?"),
    goneAll: db.prepare("SELECT key, at FROM memory_site_gone"),
    gonePurge: db.prepare("DELETE FROM memory_site_gone WHERE at < ?"),
  };

  /** Who may use the store: the person's surfaces, their other devices, and Vyre's own modules. Never an agent. @param {any} caller @param {any} meta */
  const isPerson = (/** @type {any} */ caller) => { const c = String(caller || ""); return PERSON.has(c) || PERSON_LABEL.test(c); };
  const chrome = (caller, meta) => isPerson(caller) || (String(caller || "").startsWith("module:") && meta && meta.firstParty === true);
  const personOnly = (caller, what) => { if (!isPerson(caller)) throw denied(`${what} is for the person's own surfaces`); };

  /**
   * A setting, on by default. With no settings hub at all it is the default; if the hub fails, the last value it gave (a
   * person's OFF is never ignored on an error), and with none known, off.
   * @param {string} key
   */
  const last = new Map();
  const setting = async key => {
    let failed = false;
    try {
      const r = await ctx.call("settings.get", { key });
      if (r && r.error) failed = r.error.code !== "no_such_tool";
      else { const d = r && r.data !== undefined ? r.data : r; if (d && typeof d.value === "boolean") { last.set(key, d.value); return d.value; } if (d && d.value === undefined) { const v = dflt(key); last.set(key, v); return v; } }
    } catch { failed = true; }
    if (failed) return last.has(key) ? /** @type {boolean} */ (last.get(key)) : false;
    return dflt(key);
  };
  const dflt = (/** @type {string} */ key) => { const c = ctx.config && ctx.config.memory && ctx.config.memory.site; const k = key.split(".").pop() || ""; const v = c && c[k]; return typeof v === "boolean" ? v : true; };

  /** The ids a record already holds, which a step may refer to. @param {any} rec */
  const knownIds = rec => (rec ? [...rec.controls, ...rec.frames, ...rec.api].map((/** @type {any} */ x) => x.id).concat(rec.flows.flatMap((/** @type {any} */ f) => (f.steps || []).map((/** @type {any} */ st) => st.id))) : []);
  const load = (/** @type {string} */ key) => { const r = /** @type {any} */ (q.get.get(key)); return r ? JSON.parse(r.record) : null; };
  const save = (/** @type {any} */ rec) => {
    const card = arrivalCard(rec, { now: now() });
    q.put.run(rec.key, isFamilyKey(rec.key) ? "family" : "origin", rec.rev, JSON.stringify(rec), JSON.stringify(card), now(), (rec.names || []).join("|").toLowerCase(), rec.family || null);
    return card;
  };
  const event = (/** @type {string} */ key, /** @type {string} */ kind, item = null, outcome = null) => { q.ev.run(key, now(), kind, item, outcome); q.trim.run(key, key, EVENTS_PER_KEY); };
  const counts = (/** @type {any} */ r) => ({ controls: r.controls.length, api: r.api.length, flows: r.flows.length, notes: r.notes.length, frames: r.frames.length });
  const familyKey = (/** @type {string} */ id) => `family:${id}`;
  const cardFor = (/** @type {string} */ key) => { const r = /** @type {any} */ (q.cardOf.get(key)); return r ? { card: JSON.parse(r.card), rev: Number(r.rev) } : null; };
  /** Forgotten records leave the disk after 24 hours, whenever the store is used, not only at start. */
  const purge = () => { q.purge.run(now() - UNDO_MS); q.itemPurge.run(now() - UNDO_MS); q.gonePurge.run(now() - GONE_MS); };
  purge();

  /** Forget a whole record: kept for 24 hours for an undo, and remembered as forgotten so a replica cannot bring it back. @param {string} key @param {any} [rec] @param {string} [why] @param {string|null} [item] */
  const forgetKey = (key, rec = load(key), why = "forgot", item = null) => {
    if (!rec) return 0;
    q.forgot.run(key, JSON.stringify(rec), now()); q.gone.run(key, now()); q.del.run(key); event(key, why, item, null);
    // What was said about it is forgotten too: an answer that quoted the site stays in the answers log and in a correction of it.
    const like = `%"site:${key.replace(/[%_]/g, "")}:%`;
    // Each in its own try: the answers log is memory's own and may lack a table, and one failing must not skip the other.
    try { db.prepare("UPDATE memory_iq_fixes SET old = '[forgotten]', text = CASE WHEN action = 'replace' THEN text ELSE NULL END WHERE answer IN (SELECT id FROM memory_iq_answers WHERE turns LIKE ?)").run(like); } catch { /* no fixes table */ }
    try { db.prepare("UPDATE memory_iq_answers SET answer = '[forgotten]' WHERE turns LIKE ?").run(like); } catch { /* no answers table */ }
    return 1;
  };
  /** Bring back a record forgotten in the last 24 hours. @param {string} key */
  const restoreKey = key => {
    purge();
    const r = /** @type {any} */ (q.unforget.get(String(key)));
    if (!r || now() - Number(r.at) > UNDO_MS) return 0;
    const rec = JSON.parse(r.record);
    const have = load(rec.key);
    save(have ? union(have, rec, { now: now() }) : rec); q.unforgot.run(String(key)); q.goneDel.run(String(key)); event(rec.key, "restored", null, null);
    return 1;
  };

  ctx.tool("memory.site.get", {
    description: "What Vyre for Chrome knows about a site: { origin, family?, rev, family_rev } cards (the small record Chrome reads on every page), or { not_modified: true } when since_rev and family_rev are current. parts: [controls|api|flows|notes|frames] returns the full record's named parts instead of the card. Structure only, never a value. For the person's surfaces and Vyre's own modules.",
    input: { type: "object", required: ["origin"], properties: { origin: { type: "string" }, since_rev: { type: "integer" }, family_rev: { type: "integer" },
      parts: { type: "array", items: { type: "string", enum: PARTS } } } },
    run: async (i, { caller, ...meta } = {}) => {
      if (!chrome(caller, meta)) throw denied("site knowledge is for the person's own surfaces and Chrome's bridge");
      if (!keyOk(i.origin) || isFamilyKey(i.origin)) throw bad("origin is a scheme and host, like https://app.example");
      purge();
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
      // Notes are the person's own words: only a person's surface may write one, never Chrome's bridge.
      const clean = sanitize({ ...(i.patch && typeof i.patch === "object" ? i.patch : {}), key }, { now: now(), notes: isPerson(caller), known: knownIds(load(key)) });
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
      purge();
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
    description: "Forget one item of a site ({ key, part, id }) or a whole record ({ key }, an origin or family:<id>); all: true forgets every site. Either can be brought back for 24 hours with memory.site.restore ({ key } or { key, part, id }). The person's own surfaces only.",
    input: { type: "object", properties: { key: { type: "string" }, part: { type: "string", enum: PARTS }, id: { type: "string" }, all: { type: "boolean" } } },
    run: async (i, { caller } = {}) => {
      personOnly(caller, "forgetting a site");
      purge();
      if (i.all === true) {
        const rows = /** @type {any[]} */ (q.all.all());
        for (const r of rows) forgetKey(r.key, JSON.parse(r.record));
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
        q.itemForgot.run(i.key, String(i.part), String(i.id).slice(0, 200), JSON.stringify(list[at]), now());
        list.splice(at, 1);
        rec.tombstones = [{ part: i.part, id: String(i.id).slice(0, 200), at: new Date(now()).toISOString() }, ...rec.tombstones].slice(0, LIMITS.tombstones);
        rec.rev += 1; rec.updated = new Date(now()).toISOString();
        save(rec); event(i.key, "forgot", `${i.part}:${String(i.id).slice(0, 60)}`, null);
        return { forgotten: 1 };
      }
      forgetKey(i.key, rec);
      return { forgotten: 1, undo_ms: UNDO_MS };
    },
  });

  /** Bring back one forgotten item within 24 hours: it returns with the trust it had, and its tombstone is lifted. @param {string} key @param {string} part @param {string} id */
  const restoreItem = (key, part, id) => {
    purge();
    const r = /** @type {any} */ (q.itemGet.get(key, part, id));
    const rec = load(key);
    if (!r || !rec || now() - Number(r.at) > UNDO_MS) return 0;
    const list = part === "wall" ? rec.login.wall : part === "signedIn" ? rec.login.signedIn : rec[part];
    if (!Array.isArray(list)) return 0;
    if (!list.some((/** @type {any} */ x) => itemId(part, x) === id)) list.push(JSON.parse(r.item));
    rec.tombstones = rec.tombstones.filter((/** @type {any} */ t) => !(t.part === part && t.id === id));
    rec.rev += 1; rec.updated = new Date(now()).toISOString();
    save(rec); q.itemDel.run(key, part, id); event(key, "restored", `${part}:${id.slice(0, 60)}`, null);
    return 1;
  };

  ctx.tool("memory.site.restore", {
    description: "Bring back what was forgotten in the last 24 hours: a whole site ({ key }) or one row of it ({ key, part, id }) -> { restored }. The person's own surfaces only.",
    input: { type: "object", required: ["key"], properties: { key: { type: "string" }, part: { type: "string", enum: PARTS }, id: { type: "string" } } },
    run: async (i, { caller } = {}) => {
      personOnly(caller, "restoring a site");
      if (i.part && i.id != null) return { restored: restoreItem(String(i.key), String(i.part), String(i.id)) };
      return { restored: restoreKey(String(i.key)) };
    },
  });

  /** Every list of items a record holds, with the part name the lib uses. @param {any} rec */
  const partsOf = rec => [["frames", rec.frames], ["controls", rec.controls], ["api", rec.api], ["flows", rec.flows], ["notes", rec.notes], ["ready", rec.ready], ["wall", rec.login.wall], ["signedIn", rec.login.signedIn]];
  /** Items of a pushed record that are newer than the moment the person forgot the site; older ones are what they forgot. */
  const newerThan = (/** @type {any} */ rec, /** @type {number} */ at) => {
    const cut = new Date(at).toISOString();
    const keep = (/** @type {any[]} */ l) => l.filter(x => x.verified && x.verified > cut);
    return { ...rec, frames: keep(rec.frames), controls: keep(rec.controls), api: keep(rec.api), flows: keep(rec.flows), notes: keep(rec.notes), ready: keep(rec.ready), login: { ...rec.login, wall: keep(rec.login.wall), signedIn: keep(rec.login.signedIn) } };
  };
  const itemCount = (/** @type {any} */ rec) => partsOf(rec).reduce((n, [, l]) => n + l.length, 0);
  /** A replica cannot raise trust: an item this store did not already hold starts at 0.5 at most. */
  const capNew = (/** @type {any} */ out, /** @type {any} */ had) => {
    const held = new Set(partsOf(had).flatMap(([part, l]) => l.map((/** @type {any} */ x) => `${part}|${itemId(part, x)}`)));
    for (const [part, l] of partsOf(out)) for (const x of l) if (!held.has(`${part}|${itemId(part, x)}`) && x.conf > 0.5) x.conf = 0.5;
    return out;
  };

  ctx.tool("memory.site.detail", {
    description: "One site in full, for the Sites list: { key, kind, names, family, related, rev, updated, verified, used_to_work, events, parts: { frames, controls, api, flows, notes, ready, wall, signedIn } } where each item is { id, label, conf, verified, quarantined, src } and never a selector, a value or page text beyond what the record holds (structure only). Each item's id is what memory.site.forget { key, part, id } removes. The person's own surfaces only.",
    input: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    run: async (i, { caller } = {}) => {
      personOnly(caller, "a site's detail");
      if (!keyOk(i.key)) throw bad("key is an origin or family:<id>");
      const rec = load(i.key);
      if (!rec) return { key: i.key, found: false };
      const row = (/** @type {any} */ x, /** @type {string} */ label) => ({ id: null, label, conf: readConf(x, now()), verified: x.verified || null, quarantined: isQuarantined(x), src: x.src });
      const parts = {
        frames: rec.frames.map((/** @type {any} */ x) => ({ ...row(x, `${x.role} frame`), id: itemId("frames", x) })),
        controls: rec.controls.map((/** @type {any} */ x) => ({ ...row(x, `${x.name || x.role} on ${x.page}`), id: itemId("controls", x) })),
        api: rec.api.map((/** @type {any} */ x) => ({ ...row(x, `${x.method} ${x.pathTemplate}`), id: itemId("api", x) })),
        flows: rec.flows.map((/** @type {any} */ x) => ({ ...row(x, x.title || x.name), id: itemId("flows", x), runs: x.runs, fails: x.fails })),
        notes: rec.notes.map((/** @type {any} */ x) => ({ ...row(x, x.name), id: itemId("notes", x) })),
        ready: rec.ready.map((/** @type {any} */ x) => ({ ...row(x, `ready: ${x.kind}${x.arg ? ` ${x.arg}` : ""}`), id: itemId("ready", x) })),
        wall: rec.login.wall.map((/** @type {any} */ x) => ({ ...row(x, `sign-in: ${x.kind}${x.arg ? ` ${x.arg}` : ""}`), id: itemId("wall", x) })),
        signedIn: rec.login.signedIn.map((/** @type {any} */ x) => ({ ...row(x, `signed in: ${x.kind}${x.arg ? ` ${x.arg}` : ""}`), id: itemId("signedIn", x) })),
      };
      const all = Object.values(parts).flat();
      const events = /** @type {any[]} */ (db.prepare("SELECT at, kind, outcome FROM memory_site_events WHERE key = ? ORDER BY id DESC LIMIT 10").all(i.key)).map(e => ({ at: Number(e.at), kind: String(e.kind), ...(e.outcome ? { outcome: String(e.outcome) } : {}) }));
      return { key: rec.key, found: true, kind: isFamilyKey(rec.key) ? "family" : "origin", names: rec.names, family: rec.family, related: rec.related, rev: rec.rev, updated: rec.updated,
        verified: all.map(x => x.verified).filter(Boolean).sort().pop() || null, used_to_work: all.filter(x => x.quarantined).length, events, parts };
    },
  });

  ctx.tool("memory.site.sync", {
    description: "Two-way sync with a replica (standalone Vyre for Chrome on a computer, once it reaches this box): { have: { key: rev }, push: [records] } -> { accepted, skipped, refused, pull: [records newer than have], forgotten: [{ key, at }] }. Each pushed record goes through the same allowlist and is folded in by per-item newest-verified, never overwriting; items the store did not hold start at 0.5 at most; items older than a forget the person made are dropped, and the replica is told what was forgotten. Off when memory.site.sync is off. The person's own surfaces and Chrome's bridge.",
    input: { type: "object", properties: { have: { type: "object" }, push: { type: "array", maxItems: 100, items: { type: "object" } } } },
    run: async (i, { caller, ...meta } = {}) => {
      if (!chrome(caller, meta)) throw denied("site knowledge is for the person's own surfaces and Chrome's bridge");
      if (!(await setting("memory.site.sync"))) return { accepted: 0, skipped: 0, refused: [], pull: [], forgotten: [], sync: false };
      if (!(await setting("memory.site.learn"))) return { accepted: 0, skipped: 0, refused: [], pull: [], forgotten: [], learning: false };
      purge();
      let accepted = 0, skipped = 0; const refused = [];
      /** @type {any[]} */ const cleaned = [];
      for (const r of (Array.isArray(i.push) ? i.push : []).slice(0, 100)) {
        const clean = sanitize(r, { now: now() });
        if (!clean.ok) { refused.push({ key: String(r && r.key || "").slice(0, 100), refused: clean.refused }); if (clean.refused.length && keyOk(r && r.key)) event(r.key, "refused", clean.refused.map(x => x.path).join(",").slice(0, 120), null); continue; }
        cleaned.push(clean.record);
      }
      // A family exists here only because an origin named it: one already stored, or one in this same push.
      const families = new Set(cleaned.filter(r => !isFamilyKey(r.key) && r.family).map(r => r.family));
      for (const r of /** @type {any[]} */ (q.all.all())) { if (r.kind === "origin") { const f = JSON.parse(r.record).family; if (f) families.add(f); } }
      for (let rec of cleaned) {
        if (isFamilyKey(rec.key) && !families.has(rec.key.slice("family:".length))) { refused.push({ key: rec.key, refused: [{ path: "key", why: "a family with no origin naming it" }] }); continue; }
        const gone = /** @type {any} */ (q.goneGet.get(rec.key));
        if (gone) { rec = newerThan(rec, Number(gone.at)); if (!itemCount(rec)) { skipped++; continue; } }
        const have = load(rec.key);
        const out = have ? capNew(union(have, rec, { now: now() }), have) : mergeRecord(emptyRecord(rec.key), rec, { now: now() });
        if (!have && rec.family) out.family = rec.family;
        save(out); accepted++; event(out.key, "sync", null, null);
      }
      const haveRev = i.have && typeof i.have === "object" ? i.have : {};
      const pull = /** @type {any[]} */ (q.all.all()).filter(r => !(Number(haveRev[r.key]) >= Number(r.rev))).slice(0, 100).map(r => JSON.parse(r.record));
      const forgotten = /** @type {any[]} */ (q.goneAll.all()).map(g => ({ key: g.key, at: new Date(Number(g.at)).toISOString() }));
      return { accepted, skipped, refused, pull, forgotten };
    },
  });
  return {
    isPerson,
    /** memory.ask's step: what Vyre for Chrome knows about a site the question names, or null. */
    answer: (/** @type {string} */ question) => {
      // Match the question against an index of names, families and hosts first; only the matched sites' records are parsed.
      const index = /** @type {any[]} */ (q.index.all()).map(r => ({ key: String(r.key), names: String(r.names || "").split("|").filter(Boolean), family: r.family ? String(r.family) : null }));
      const keys = neededKeys(question, index);
      if (!keys.length) return null;
      const records = /** @type {any[]} */ (q.byKeys(keys.length).all(...keys)).map(r => JSON.parse(r.record));
      return answerSite(question, records, { now: now() });
    },
    forgetKey, restoreKey,
    /** The record keys whose forgetting a correction of an answer caused, for undoing it. */
    forgottenBy: (/** @type {number} */ fix) => /** @type {any[]} */ (db.prepare("SELECT key FROM memory_site_events WHERE kind = 'forgot-by-answer' AND item = ?").all(String(fix))).map(r => String(r.key)),
  };
}
