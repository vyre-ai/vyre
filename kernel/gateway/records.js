// kernel/gateway/records.js: the gateway's record calls (contract 3.1; invariants 1, 7, 8, 10). Every call takes the
// kernel-built chain, asks `authorize` first, writes an intent before the store call and one event after, and treats
// the store as untrusted: it never lets the store decide who may see a row, it checks each returned row itself,
// it keeps the id it minted, and it verifies a record's version hash against the event that wrote it.
import { canonical, sha256 } from "../core/canonical.js";
import { mintUuid, isUuid } from "../core/ids.js";
import { isChain, hasKind } from "../core/chain.js";
import { KernelError } from "../core/errors.js";
import { createGate } from "../core/gate.js";
import { createAggregator } from "../store/query.js";
import { isSealedShape } from "../store/values.js";
import { expr as defaultExpr } from "../expr/index.js";
import { createIdem } from "../core/idem.js";

/** The actions the gateway registers with the authorizer (contract 6.1). */
export const RECORD_ACTIONS = Object.freeze([
  { action: "records.read", resource_type: "record", risk: "read", label: "read records", gloss: "Open and search records." },
  { action: "records.create", resource_type: "record", risk: "write", label: "add records", gloss: "Create new records." },
  { action: "records.update", resource_type: "record", risk: "write", label: "edit records", gloss: "Change what a record holds." },
  { action: "records.remove", resource_type: "record", risk: "write", label: "remove records", gloss: "Move records to the bin." },
  { action: "records.restore", resource_type: "record", risk: "write", label: "restore records", gloss: "Bring records back from the bin." },
  { action: "events.read", resource_type: "event", risk: "read", label: "read the activity log", gloss: "See what happened to records you can read." },
  { action: "records.define", resource_type: "definition", risk: "admin", label: "change types", gloss: "Add or change the kinds of record and their fields." },
].map(a => Object.freeze(a)));

const TYPE_NAME = /^[a-z][a-z0-9_-]*$/;
/** Intents older than this are not replayed: they close as `unresolved` for a person to look at (K1 item 8b, K2-11). */
const INTENT_MAX_AGE = 24 * 3600 * 1000;
const checkType = (/** @type {any} */ t) => { if (typeof t !== "string" || !TYPE_NAME.test(t)) throw new KernelError("bad_input", "bad type name"); };
const checkId = (/** @type {any} */ i) => { if (typeof i !== "string" || !isUuid(i)) throw new KernelError("bad_input", "bad record id"); };
/** The head segment of every field a query, sort, group or measure names. */
const fieldHeads = (/** @type {any} */ spec) => {
  const out = new Set();
  const walk = (/** @type {any} */ f) => { if (!f || typeof f !== "object") return; for (const k of ["and", "or"]) if (Array.isArray(f[k])) f[k].forEach(walk); if (f.not) walk(f.not); if (typeof f.field === "string") out.add(f.field.split(".")[0]); };
  walk(spec.filter);
  for (const s of spec.sort || []) if (s && typeof s.field === "string") out.add(s.field.split(".")[0]);
  for (const g of spec.group_by || []) if (typeof g === "string") out.add(g.split(".")[0]);
  for (const m of spec.measures || []) if (m && typeof m.field === "string") out.add(m.field.split(".")[0]);
  return out;
};
/** A store answer that definitely means "nothing happened", so the intent can be closed as compensated. */
const REFUSED = new Set(["invalid", "unknown_type", "unknown_field", "version_conflict", "not_found", "sealed_value_refused", "unique_violation"]);
const STORE_CODES = new Set(["not_found", "version_conflict", "invalid", "unknown_type", "unknown_field", "unsupported", "unavailable", "id_mismatch", "sealed_value_refused", "unique_violation"]);

/** What a version hash covers: the record as the gateway wrote it. */
export const versionHash = (/** @type {any} */ r) => sha256(canonical({ type: r.type, id: r.id, version: r.version, deleted: Boolean(r.deleted_at), data: r.data }));

const mergePatch = (/** @type {any} */ data, /** @type {any} */ patch) => {
  const out = { ...data };
  for (const [k, v] of Object.entries(patch || {})) { if (v === null) delete out[k]; else out[k] = v; }
  return out;
};
const redactDiff = (/** @type {any} */ data, /** @type {Set<string>} */ changed) =>
  Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, isSealedShape(v) ? { sealed: true, changed: changed.has(k) } : v]));
const changedFields = (/** @type {any} */ a, /** @type {any} */ b) => {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter(k => canonical((a || {})[k] ?? null) !== canonical((b || {})[k] ?? null)).sort();
};

/**
 * @param {{ expr?: { parseExpr(s: string): any, evalExpr(n: any, ctx: any): any }, stageTasks?: (record: string, stage: string) => { title: string, state: string }[], onStageEnter?: (e: any) => any, enforce?: (chain: any, d: any) => void, members?: any, space: string, store: any, authorizer: { authorize(i: any): Promise<any> }, log: any, chains: any, clock?: () => number, sinks?: Set<string> }} cfg
 */
export function createRecords(cfg) {
  const { space, store, authorizer, log, chains } = cfg;
  const clock = cfg.clock || Date.now;
  const sinks = cfg.sinks || new Set();
  const urn = (/** @type {string} */ type, /** @type {string} */ id) => `vyre://${space}/${type}/${id}`;
  /** @type {Map<string, any>} */ const intents = new Map();
  // An intent exists to recover a write that may or may not have happened: once it is completed or compensated it has done its job, so only the last few stay (for `intents()`),
  // and what is held follows the writes still open, not every write ever made.
  /** @type {string[]} */ const retired = [];
  const retire = (/** @type {any} */ i) => { retired.push(i.id); if (retired.length > 200) intents.delete(/** @type {string} */ (retired.shift())); };
  // Kernel attributes as the gateway wrote them (owner, created_by, project, sensitivity), never the store's. A store that keeps them on disk (`store.meta`, the built-in
  // SQLite store) answers from there with a small LRU in front; any other store leaves them in memory as before.
  const kattrs = store.meta ? store.meta : new Map();
  /** Types known to hold no privileged record (a row's sensitivity is set once, when it is created, so a type found clean stays clean until a privileged record is created in it). */
  const noPrivileged = new Set();
  const hasPrivileged = (/** @type {string} */ type) => {
    if (noPrivileged.has(type)) return false;
    const found = kattrs.anyWith ? kattrs.anyWith(urn(type, ""), "sensitivity", "privileged") : [...(/** @type {Map<string, any>} */ (kattrs)).entries()].some(([u, a]) => u.startsWith(urn(type, "")) && a && a.sensitivity === "privileged");
    if (!found) noPrivileged.add(type);
    return found;
  };
  /** The latest version hash the gateway wrote, per record. On a durable log it is found by an indexed lookup of the record's last event (with a small LRU in front), so nothing here
   * grows with the number of records; on the reference log it is a Map filled as the log is read. */
  const index = (() => {
    /** @type {Map<string, { version: number, hash: string }>} */ const m = new Map();
    return {
      get(/** @type {string} */ u) {
        const hit = m.get(u);
        // Only a durable log answers by lookup; on the reference log the Map is the whole index (it is filled as records are written and by `rebuild`).
        if (hit || log.durable !== true) return hit;
        const e = log.latestFor(u);
        if (!e) return undefined;
        const v = { version: e.data.version, hash: e.data.version_hash };
        m.set(u, v); if (m.size > 10_000) m.delete(m.keys().next().value);
        return v;
      },
      set(/** @type {string} */ u, /** @type {{ version: number, hash: string }} */ v) { m.set(u, v); if (m.size > 10_000) m.delete(m.keys().next().value); },
      clear() { m.clear(); },
    };
  })();

  /** The kernel attributes of a record. On a store that keeps them on disk (`store.meta`) the disk is only a copy: the record's create event in the log is the authority (BL-3), looked up
   * by its subject with a small LRU in front, and a copy that disagrees is repaired from it. The disk answers only when the event's data was erased (a deliberate act that leaves no event to
   * check against) or the log has no create event for the record. */
  const verified = new Map();
  function attrsOf(/** @type {string} */ u) {
    const disk = kattrs.get(u);
    if (!store.meta || log.durable !== true) return disk;
    if (verified.has(u)) { const v = verified.get(u); verified.delete(u); verified.set(u, v); return v; }
    const first = log.read({ subject_prefix: u, limit: 1 })[0];
    const a = first && first.data && typeof first.data.attrs === "object" && first.data.attrs ? first.data.attrs : undefined;
    if (!a) return disk;
    if (JSON.stringify(disk) !== JSON.stringify(a)) kattrs.set(u, a);
    verified.set(u, a); if (verified.size > 10_000) verified.delete(verified.keys().next().value);
    return a;
  }

  function mapError(/** @type {any} */ e) {
    if (e instanceof KernelError) return e;
    if (e && STORE_CODES.has(e.code)) return new KernelError(e.code, e.message);
    return new KernelError("unavailable", "the store could not answer", String(e && e.message));
  }

  const { gate, allowed, check } = createGate({ authorizer, log, enforce: cfg.enforce });
  /** A read through query, aggregate or search is one act on the type: counted once against the type-level decision, never per row. */
  /** A page is `{ limit: whole number from 1, cursor? }`; a limit above 500 is a page of 500. Anything else is a bad request, not a store error. @param {any} spec */
  const checkPage = (spec) => {
    const pg = spec && spec.page;
    if (!pg || typeof pg !== "object" || !Number.isInteger(pg.limit) || pg.limit < 1) throw new KernelError("bad_input", "a page needs a limit of 1 or more, as a whole number");
    if (pg.cursor !== undefined && typeof pg.cursor !== "string") throw new KernelError("bad_input", "a cursor is text");
    if (pg.limit > 500) return { ...spec, page: { ...pg, limit: 500 } };
    return spec;
  };
  const AGG_MAX_GROUPS = 10_000, AGG_MAX_PAGES = 40, AGG_MAX_MS = 8_000;
  const countRead = async (/** @type {any} */ chain, /** @type {string} */ type) => { const d = await check(chain, "records.read", urn(type, "*"), { probe: true }); if (d && cfg.enforce) cfg.enforce(chain, d); return d; };
  const members = cfg.members;
  const idem = createIdem({ clock });

  /** A field allow-list from a decision's obligations: every hop's grant may narrow it, so the result is their intersection. null means no limit. */
  const allowList = (/** @type {any} */ d) => {
    let allow = null;
    for (const o of (d && d.obligations) || []) if (o.type === "fields") allow = allow === null ? new Set(o.allow) : new Set([...allow].filter(f => o.allow.includes(f)));
    return allow;
  };
  /** The role the chain's person holds, for `human` seals (a field hidden from members outside chosen roles). */
  const roleOfChain = (/** @type {any} */ chain) => { const h = chain.hops.find((/** @type {any} */ x) => x.actor.kind === "person"); return h && members && members.membership ? members.membership(h.actor)?.role : undefined; };
  /** Fields this chain may not see at all: `human`-level sealed fields when its role is not among the reveal roles (or no person is in the chain). */
  async function hiddenFields(/** @type {any} */ chain, /** @type {string} */ type) {
    let defs;
    try { defs = typeof store.types === "function" ? await store.types() : []; } catch { return null; }
    const def = defs.find((/** @type {any} */ t) => t.name === type);
    if (!def) return new Set();
    const role = roleOfChain(chain);
    return new Set(def.fields.filter((/** @type {any} */ f) => f.kind === "sealed" && f.seal && f.seal.level === "human" && !(role && (f.seal.reveal_roles || []).includes(role))).map((/** @type {any} */ f) => f.name));
  }
  const limitsOf = async (/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ d) => ({ allow: allowList(d), hidden: (await hiddenFields(chain, type)) || new Set() });
  // ---- the room's view (CH-8): a session whose token names a chat with more than one person reads what EVERYONE in it may read, whoever asks and however it asks ----
  /** The viewer chains of the chain's room when it is a group (the chat's live participants), else null. `not_found` when the person the session is for has left the chat. */
  async function viewersOf(/** @type {any} */ chain) {
    const people = cfg.room ? cfg.room.peopleOf(chain) : null;
    if (!people) return null;
    cfg.room.noteRead(chain);
    return Promise.all(people.map(async (/** @type {string} */ person) => chains.fromFacts({ kind: "viewer", person, vouched: true })));
  }
  /** What the whole room may read of one record: null when anyone cannot read it (a record someone cannot see is not in the room's view), else the fields everyone is allowed (`allow`, null for no limit) and any hidden from anyone. */
  async function roomLim(/** @type {any[]} */ vs, /** @type {string} */ type, /** @type {string} */ u, /** @type {boolean} */ probe = false) {
    /** @type {Set<string> | null} */ let allow = null;
    const hidden = new Set();
    let ok = true;
    for (const v of vs) {
      const d = await check(v, "records.read", u, probe ? { probe: true } : {});
      if (!d && !probe) { ok = false; continue; }
      const l = await limitsOf(v, type, d);
      if (l.allow) allow = allow === null ? new Set(l.allow) : new Set([...allow].filter(f => /** @type {Set<string>} */ (l.allow).has(f)));
      for (const h of l.hidden) hidden.add(h);
    }
    return ok ? { allow, hidden } : null;
  }
  const refuseOutside = (/** @type {Set<string> | null} */ allow, /** @type {any} */ data) => { if (allow) for (const k of Object.keys(data || {})) if (!allow.has(k)) throw new KernelError("field_not_allowed", `${k} is outside what this access allows`); };

  const isModel = (/** @type {any} */ chain) => hasKind(chain, "agent") || chain.hops.some((/** @type {any} */ h) => h.actor.kind === "service" && sinks.has(h.actor.id));

  /**
   * A chain holding a model may not filter, sort, group or measure on a sealed field or any of its sub-fields (hint
   * included): that is an equality oracle on a value the model must never learn (invariants 5, 6). The definition comes
   * from the store; if it cannot be read, the query is refused rather than guessed.
   */
  async function guardSealed(/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ spec, /** @type {any[] | null} */ vs = null) {
    const heads = fieldHeads(spec);
    if (!heads.size) return;
    // A group session may filter, sort, group or measure only on fields the whole room may read, and never on a sealed field: anything else is an oracle on one person's reach.
    if (vs) {
      const rl = await roomLim(vs, type, urn(type, "*"), true);
      let sealedNames = new Set();
      try { const def = typeof store.describe === "function" ? await store.describe(type) : undefined; if (def && Array.isArray(def.fields)) sealedNames = new Set(def.fields.filter((/** @type {any} */ f) => f.kind === "sealed").map((/** @type {any} */ f) => f.name)); else throw new Error("no describe"); } catch { throw new KernelError("unsupported", "cannot check the fields of this type, so a group session may not query by field"); }
      for (const h of heads) if (rl && (rl.hidden.has(h) || (rl.allow && !rl.allow.has(h) && !["id", "version", "type", "created_at", "updated_at"].includes(h)))) throw new KernelError("bad_input", `${h} is outside what everyone in this room may read`);
      for (const h of heads) if (sealedNames.has(h)) throw new KernelError("bad_input", `${h} is sealed: it cannot be filtered, sorted, grouped or measured in a group chat`);
    }
    // A field the access does not allow, or that is hidden from this chain, cannot be filtered, sorted or grouped on either: that would be an oracle.
    const probe = await check(chain, "records.read", urn(type, "*"), { probe: true });
    const lim = await limitsOf(chain, type, probe);
    for (const h of heads) if (lim.hidden.has(h) || (lim.allow && !lim.allow.has(h) && h !== "id" && h !== "version" && h !== "type" && h !== "created_at" && h !== "updated_at")) throw new KernelError("bad_input", `${h} is outside what this access allows`);
    if (!isModel(chain)) return;
    let def;
    try { def = typeof store.describe === "function" ? await store.describe(type) : undefined; } catch (e) { throw mapError(e); }
    if (!def || !Array.isArray(def.fields)) throw new KernelError("unsupported", "cannot check the fields of this type, so a model may not query by field");
    const sealed = new Set(def.fields.filter((/** @type {any} */ f) => f.kind === "sealed").map((/** @type {any} */ f) => f.name));
    for (const h of heads) if (sealed.has(h)) throw new KernelError("bad_input", `${h} is sealed: it cannot be filtered, sorted, grouped or measured by an assistant`);
  }

  /**
   * Stage gates (contract 9; records' defineStage and defineRule): a record cannot enter a stage unless the type's rules hold for the record as it
   * would be, and it cannot leave a stage until that stage's required tasks are done. Fail closed: a type with rules and no evaluator wired
   * refuses the stage change rather than skipping the rule.
   * @returns {Promise<{ entered?: { stage: string, templates: any[] } }>}
   */
  async function stageGate(/** @type {string} */ type, /** @type {string} */ u, /** @type {any} */ beforeData, /** @type {any} */ merged) {
    let defs;
    try { defs = typeof store.types === "function" ? await store.types() : []; } catch { throw new KernelError("unavailable", "the type definitions could not be read, so the stage rules were not checked"); }
    const def = defs.find((/** @type {any} */ t) => t.name === type);
    if (!def || !((def.rules && def.rules.length) || (def.stages && def.stages.length))) return {};
    const sf = def.fields.find((/** @type {any} */ f) => f.kind === "stage");
    const from = sf && beforeData ? beforeData[sf.name] : undefined, to = sf ? merged[sf.name] : undefined;
    const moved = !sf || from !== to;
    if (!moved) return {};
    if ((def.rules || []).length) {
      const expr = cfg.expr === undefined ? defaultExpr : cfg.expr; // null switches it off (the fail-closed test)
      if (!expr) throw new KernelError("unavailable", "this type has rules and no rule evaluator is wired, so the change was refused");
      const order = sf ? { [sf.name]: (def.stages || []).map((/** @type {any} */ s) => s.name) } : {};
      for (const r of def.rules) {
        let ok = false;
        try { ok = expr.evalExpr(expr.parseExpr(r.require), { values: merged, stageOrder: order }) === true; } catch { ok = false; }
        if (!ok) throw new KernelError("rule_failed", `the rule ${r.name || "(unnamed)"} does not hold for ${type}${to ? ` in ${to}` : ""}`);
      }
    }
    if (sf && from !== undefined && from !== null && from !== to) {
      const stage = (def.stages || []).find((/** @type {any} */ s) => s.name === from);
      const need = ((stage && stage.tasks) || []).filter((/** @type {any} */ t) => t.required);
      if (need.length) {
        if (!cfg.stageTasks) throw new KernelError("unavailable", "this stage has required tasks and tasks are not wired, so the change was refused");
        const have = cfg.stageTasks(u, from);
        const open = need.filter((/** @type {any} */ t) => !have.some((/** @type {any} */ h) => h.title === t.title && h.state === "done"));
        if (open.length) throw new KernelError("stage_tasks_open", `${from} still has required tasks: ${open.map((/** @type {any} */ t) => t.title).join(", ")}`);
      }
    }
    const entering = (def.stages || []).find((/** @type {any} */ s) => s.name === to);
    return to !== undefined && to !== null ? { entered: { stage: String(to), templates: (entering && entering.tasks) || [] } } : {};
  }

  /** Shape a stored row for the caller: checked, labelled, and with sealed values as placeholders when a model is in the chain. */
  function shape(/** @type {any} */ chain, /** @type {any} */ r, /** @type {{ allow: Set<string> | null, hidden: Set<string> } | undefined} */ lim, /** @type {{ allow: Set<string> | null, hidden: Set<string> } | undefined} */ room = undefined) {
    const u = urn(r.type, r.id);
    const known = index.get(u);
    const hash = versionHash(r);
    const modified = !known || known.version !== r.version || known.hash !== hash;
    // Placeholders by destination (8.4): a model in the chain, or a declared model sink anywhere in it.
    const model = isModel(chain);
    const cut = (/** @type {any} */ o) => (lim ? Object.fromEntries(Object.entries(o).filter(([k]) => !lim.hidden.has(k) && (!lim.allow || lim.allow.has(k)))) : o);
    const own = cut(r.data);
    // A group session: a field is a value only when everyone in the room may read it and it is not sealed; any other field this chain could see is a placeholder the kernel fills at the moment of an action.
    const base = room ? Object.fromEntries(Object.entries(own).map(([k, v]) => [k, room.hidden.has(k) || (room.allow && !room.allow.has(k)) || isSealedShape(v) ? `{{field:${u}#${k}}}` : v])) : own;
    const data = model ? Object.fromEntries(Object.entries(base).map(([k, v]) => [k, isSealedShape(v) ? { sealed: /** @type {any} */ (v).sealed, present: Boolean(/** @type {any} */ (v).present), valid_format: Boolean(/** @type {any} */ (v).valid_format) } : v])) : base;
    return Object.freeze({ ...r, data, urn: u, labels: { trust: modified ? "external" : "member", red: "internal", source_spaces: [space] }, ...(modified ? { modified_outside: true } : {}) });
  }

  async function write(/** @type {any} */ chain, /** @type {"create"|"update"|"remove"|"restore"} */ op, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ input, /** @type {number | null} */ base, /** @type {() => Promise<any>} */ run, /** @type {(() => Promise<any>) | null} */ getBefore, /** @type {any} */ attrs) {
    checkType(type); checkId(id);
    const u = urn(type, id);
    const d = await gate(chain, `records.${op}`, u);
    const lim = await limitsOf(chain, type, d);
    if (op === "create" || op === "update") refuseOutside(lim.allow, input);
    let before = null;
    if (getBefore) { try { before = await getBefore(); } catch (e) { throw mapError(e); } }
    let stage = {};
    if (op === "create" || op === "update") stage = await stageGate(type, u, before ? before.data : null, op === "create" ? input : mergePatch(before ? before.data : {}, input));
    // What the store must show for this to be our change and no one else's: the exact data and deleted state.
    const merged = op === "create" ? input : op === "update" ? mergePatch(before ? before.data : {}, input) : before ? before.data : null;
    const expect = merged === null || merged === undefined ? null : sha256(canonical({ deleted: op === "remove", data: merged }));
    const intent = { id: mintUuid(clock()), decision: d.decision, chain: chain.hops, record: u, base_version: base, operation: op, input_hash: sha256(canonical(input)), expect, before_data: before ? before.data : null, state: "open", started_at: clock(), stored: await chains.serialize(chain), ...(attrs ? { attrs } : {}) };
    intents.set(intent.id, intent);
    // One database transaction for the record and its event (built-in store only): they commit together, one fsync, or not at all. It spans only steps that wait on the microtask queue.
    const tx = cfg.unit && typeof store.undo === "function" ? await cfg.unit.begin() : null;
    /** Commit the unit; a commit that fails takes the record back out of memory and says so. */
    const finishTx = async () => {
      if (!tx) return;
      try { tx.commit(); } catch (e) { try { await store.undo(type, id, before); } catch { /* the store is reloaded from disk at the next start */ } throw new KernelError("unavailable", "the record and its event could not be committed", String(e && /** @type {any} */ (e).message)); }
    };
    let rec;
    try {
    try { rec = await run(); }
    catch (e) {
      const err = mapError(e);
      // A definite refusal means nothing happened. A lost answer (unavailable) may mean it did: the intent stays open for recovery.
      if (REFUSED.has(err.code)) { intent.state = "compensated"; retire(intent); }
      await finishTx();
      throw err;
    }
    if (rec.id !== id || rec.type !== type) {
      intent.state = "compensated"; retire(intent);
      try { if (op === "create") await store.remove(type, id, rec.version); } catch { /* best effort */ }
      await finishTx();
      throw new KernelError("id_mismatch", "the store did not keep the id it was given");
    }
    // The store is not trusted to say what it wrote: compare what it returned with what this call asked for (K2-5).
    const got = sha256(canonical({ deleted: Boolean(rec.deleted_at), data: rec.data }));
    const staleVersion = (op === "update" || op === "remove") && !(rec.version > base);
    if ((expect !== null && got !== expect) || staleVersion) {
      intent.state = "unresolved";
      try { if (op === "create") await store.remove(type, id, rec.version); } catch { /* best effort */ }
      try { log.append(chain, { type: "store.disagreed", sv: 1, subject: u, data: { operation: op, expected: expect, got, version: rec.version } }, { decision: d.decision }); } catch { /* the refusal stands */ }
      await finishTx();
      throw new KernelError("store_disagreed", "the store's answer does not match what was asked, so nothing was recorded as done");
    }
    try { emit(chain, intent, rec, before, d.decision, false); }
    catch (e) {
      // The event was refused: with a unit, the record goes with it (disk rolled back, memory taken back); without one the intent stays open for recovery as before.
      if (tx) { tx.rollback(); try { await store.undo(type, id, before); } catch { /* reloaded from disk at the next start */ } intent.state = "compensated"; retire(intent); }
      throw e;
    }
    if (attrs) kattrs.set(u, attrs);
    // The stage was entered: one event says so (Flow triggers `enters-stage` read it), then the tasks side is told (below).
    if (/** @type {any} */ (stage).entered) { try { log.append(chain, { type: "record.stage-entered", sv: 1, subject: u, data: { type, id, stage: /** @type {any} */ (stage).entered.stage }, vis: "subject", red: "internal" }, { decision: d.decision }); } catch { /* the write stands; the entry is also reported to onStageEnter */ } }
    await finishTx();
    } finally { if (tx) tx.abandon(); }
    // The stage was entered: tell the tasks side to create the stage's task templates for this record (best effort; the write stands).
    if (/** @type {any} */ (stage).entered && cfg.onStageEnter) { try { await cfg.onStageEnter({ record: u, ...(/** @type {any} */ (stage).entered), chain }); } catch { /* the stage rule retries on the next move */ } }
    return shape(chain, rec, lim);
  }

  function emit(/** @type {any} */ chain, /** @type {any} */ intent, /** @type {any} */ rec, /** @type {any} */ before, /** @type {string} */ decision, /** @type {boolean} */ recovered) {
    const changed = changedFields(before ? before.data : {}, rec.data);
    const set = new Set(changed);
    const hash = versionHash(rec);
    const verb = { create: "created", update: "updated", remove: "removed", restore: "restored" }[/** @type {"create"} */ (intent.operation)];
    const sealed = Object.values(rec.data).some(isSealedShape);
    log.append(chain, {
      type: `${rec.type}.${verb}`, sv: 1, subject: intent.record,
      data: { changed, version: rec.version, version_hash: hash, ...(verb === "created" && intent.attrs ? { attrs: intent.attrs } : {}), ...(before ? { before: redactDiff(before.data, set) } : {}), after: redactDiff(rec.data, set), ...(recovered ? { recovered: true } : {}) },
      red: sealed ? "pii" : "internal",
      // Record events carry field values: only a chain that may read the record may read them (R2-1).
      vis: "subject",
    }, { decision });
    index.set(intent.record, { version: rec.version, hash });
    intent.state = "completed"; retire(intent);
  }

  async function createOnce(/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ opts) {
    const id = mintUuid(clock());
    const a = opts.attrs || {};
    for (const k of Object.keys(a)) if (!["owner", "project", "sensitivity"].includes(k)) throw new KernelError("bad_input", `${k} is not a kernel attribute`);
    const last = chain.hops[chain.hops.length - 1].actor;
    // The attributes ride in the create event (the chain covers it), so the log, not the disk, says what a record's owner, project and sensitivity are.
    const attrs = { space, created_by: `${last.kind}:${last.id}`, ...a };
    const rec = await write(chain, "create", type, id, data, null, () => store.create(type, id, data), null, attrs);
    if (a.sensitivity === "privileged") noPrivileged.delete(type);
    return rec;
  }

  return {
    async define(chain, diff) {
      const d = await gate(chain, "records.define", `vyre://${space}/definition/types`);
      for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) if (!TYPE_NAME.test(t.name)) throw new KernelError("bad_input", `bad type name ${t.name}`);
      // The definition changes in the store and then its event is written; an event the log refuses puts the definitions back, so a defined type never stands without its line in the log.
      let was = null;
      try { was = typeof store.types === "function" ? await store.types() : null; } catch { was = null; }
      let res;
      try { res = await store.define(diff); } catch (e) { throw mapError(e); }
      if (res.applied) {
        try { log.append(chain, { type: "types.defined", sv: 1, subject: `vyre://${space}/definition/types`, data: { changes: res.changes } }, { decision: d.decision }); }
        catch (e) {
          if (was) {
            const had = new Map(was.map((/** @type {any} */ t) => [t.name, t]));
            const names = new Set([...(diff.add_types || []), ...(diff.change_types || [])].map((/** @type {any} */ t) => t.name).concat(diff.remove_types || []));
            const back = { add_types: [...names].filter(n => had.has(n)).map(n => had.get(n)), remove_types: [...names].filter(n => !had.has(n)) };
            try { await store.define(back); } catch { /* the type stays defined; the caller is still told it failed */ }
          }
          throw e;
        }
      }
      return res;
    },

    async get(chain, type, id) {
      checkType(type); checkId(id);
      const u = urn(type, id);
      let dec;
      try { dec = await gate(chain, "records.read", u); } catch (e) { if (e instanceof KernelError && e.code === "not_found") return null; throw e; }
      let r;
      try { r = await store.get(type, id); } catch (e) { throw mapError(e); }
      if (!r || r.id !== id || r.type !== type) return null;
      const vs = await viewersOf(chain);
      const room = vs ? await roomLim(vs, type, u) : undefined;
      if (room === null) return null;
      return shape(chain, r, await limitsOf(chain, type, dec), room);
    },

    async query(chain, type, spec) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      checkType(type);
      spec = checkPage(spec);
      const vs = await viewersOf(chain);
      await guardSealed(chain, type, spec, vs);
      const readDec = await countRead(chain, type);
      let cursor = spec.page.cursor, out = [], next;
      for (let pages = 0; pages < 10; pages++) {
        let p;
        try { p = await store.query(type, { ...spec, build_index: Boolean(readDec), page: { limit: spec.page.limit, ...(cursor ? { cursor } : {}) } }); } catch (e) { throw mapError(e); }
        const hiddenSet = await hiddenFields(chain, type);
        for (const r of p.rows) {
          if (r.type !== type) continue;
          const dec = await check(chain, "records.read", urn(r.type, r.id));
          if (!dec) continue;
          const room = vs ? await roomLim(vs, type, urn(r.type, r.id)) : undefined;
          if (room === null) continue;
          out.push(shape(chain, r, { allow: allowList(dec), hidden: hiddenSet || new Set() }, room));
        }
        next = p.next_cursor;
        if (out.length || !next) break;
        cursor = next;
      }
      // A cursor only when a row this chain may read is still ahead: otherwise its presence would count rows it cannot see (K2-10).
      let more = false;
      for (let ahead = 0; next && !more && ahead < 10; ahead++) {
        let p;
        try { p = await store.query(type, { ...spec, build_index: Boolean(readDec), page: { limit: spec.page.limit, cursor: next } }); } catch (e) { throw mapError(e); }
        for (const r of p.rows) if (r.type === type && await allowed(chain, "records.read", urn(r.type, r.id)) && (!vs || await roomLim(vs, type, urn(r.type, r.id)))) { more = true; break; }
        if (!more) next = p.next_cursor;
      }
      return { rows: out, ...(more ? { next_cursor: next } : {}) };
    },

    async aggregate(chain, type, spec) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      checkType(type);
      if (!spec || typeof spec !== "object" || !Array.isArray(spec.measures) || (spec.group_by !== undefined && !Array.isArray(spec.group_by))) throw new KernelError("bad_input", "an aggregate needs measures, and group_by as a list");
      const vs = await viewersOf(chain);
      await guardSealed(chain, type, spec, vs);
      const typeDec = await countRead(chain, type);
      // The store totals the rows itself (one GROUP BY) only when every row of the type gets this chain's answer: no room, grants that cover the whole type with no row predicate, no
      // rule on reading, no privileged record in the type, and every field it groups or measures is one the chain may see. Anything else is totalled below, row by row.
      if (typeDec && !vs && typeof store.aggregate === "function" && !hasPrivileged(type) && typeof authorizer.rowUniform === "function" && await authorizer.rowUniform({ chain, action: "records.read", type })) {
        const lim = await limitsOf(chain, type, typeDec);
        const used = [...(spec.group_by || []), ...(spec.measures || []).map((/** @type {any} */ m) => m && m.field).filter(Boolean)];
        if (used.every((/** @type {string} */ k) => !lim.hidden.has(k) && (!lim.allow || lim.allow.has(k)))) {
          try { return await store.aggregate(type, { ...spec, build_index: true }); } catch (e) { throw mapError(e); }
        }
      }
      // A store cannot hide rows from a total, so the gateway aggregates only the rows it has itself allowed. Rows are cut to the fields the total uses and the loop yields at every row.
      const need = new Set([...(spec.group_by || []), ...(spec.measures || []).map((/** @type {any} */ m) => m && m.field).filter(Boolean)]);
      // Folded a row at a time: memory is the number of groups (capped), never the number of rows; the scan is capped at 40 pages (20,000 rows) and in time, and says so (`unsupported`) rather than totalling a part.
      // The store already applied the filter; rows are cut to the fields the total uses, so the filter must not be applied again to the cut row.
      const agg = createAggregator({ ...spec, filter: undefined }, { maxGroups: AGG_MAX_GROUPS });
      const started = Date.now();
      let cursor, pages = 0;
      for (;;) {
        if (++pages > AGG_MAX_PAGES || Date.now() - started > AGG_MAX_MS) throw new KernelError("unsupported", "too many rows to total here for this access; narrow the filter");
        let p;
        try { p = await store.query(type, { filter: spec.filter, build_index: Boolean(typeDec), page: { limit: 500, ...(cursor ? { cursor } : {}) } }); } catch (e) { throw mapError(e); }
        const hiddenSet = await hiddenFields(chain, type);
        for (const r of p.rows) {
          if (r.type !== type) continue;
          const dec = await check(chain, "records.read", urn(r.type, r.id));
          if (!dec) continue;
          const room = vs ? await roomLim(vs, type, urn(r.type, r.id)) : undefined;
          if (room === null) continue;
          const al = allowList(dec);
          const cutRow = (/** @type {string} */ k) => need.has(k) && !(hiddenSet && hiddenSet.has(k)) && (!al || al.has(k)) && !(room && (room.hidden.has(k) || (room.allow && !room.allow.has(k)) || isSealedShape(r.data[k])));
          try { agg.add({ ...r, data: Object.fromEntries(Object.entries(r.data).filter(([k]) => cutRow(k))) }); } catch (e) { if (e && e.code === "unsupported") throw new KernelError("unsupported", e.message); throw e; }
        }
        if (!p.next_cursor) return agg.result();
        cursor = p.next_cursor;
      }
    },

    async search(chain, spec) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      for (const t of spec.types || []) checkType(t);
      spec = checkPage(spec);
      const vs = await viewersOf(chain);
      let p;
      try { p = await store.search(spec); } catch (e) { throw mapError(e); }
      const rows = [];
      for (const h of p.rows) {
        const dec = await check(chain, "records.read", urn(h.type, h.id));
        if (!dec) continue;
        if (vs && !(await roomLim(vs, h.type, urn(h.type, h.id)))) continue;
        // A snippet is text from some field: it is shown only when the access has no field limit and no field is hidden from this chain.
        const limited = vs !== null || allowList(dec) !== null || ((await hiddenFields(chain, h.type)) || new Set([1])).size > 0;
        const { snippet: _s, ...bare } = h;
        rows.push(limited ? bare : h);
      }
      // Page after filtering: a cursor only when an allowed hit is ahead (K2-10).
      let more = false, next = p.next_cursor;
      for (let ahead = 0; next && !more && ahead < 10; ahead++) {
        let q;
        try { q = await store.search({ ...spec, page: { ...spec.page, cursor: next } }); } catch (e) { throw mapError(e); }
        for (const h of q.rows) if (await allowed(chain, "records.read", urn(h.type, h.id)) && (!vs || await roomLim(vs, h.type, urn(h.type, h.id)))) { more = true; break; }
        if (!more) next = q.next_cursor;
      }
      return { rows, ...(more ? { next_cursor: next } : {}) };
    },

    async create(chain, type, data, opts = {}) {
      return idem.once(chain, "create", opts.idem, { type, data, attrs: opts.attrs }, () => createOnce(chain, type, data, opts));
    },
    async update(chain, type, id, patch, base, opts = {}) {
      return idem.once(chain, "update", opts.idem, { type, id, patch, base }, () => write(chain, "update", type, id, patch, base, () => store.update(type, id, patch, base), () => store.get(type, id)));
    },
    async remove(chain, type, id, base, opts = {}) {
      return idem.once(chain, "remove", opts.idem, { type, id, base }, () => write(chain, "remove", type, id, {}, base, () => store.remove(type, id, base), () => store.get(type, id)));
    },
    async restore(chain, type, id, opts = {}) {
      return idem.once(chain, "restore", opts.idem, { type, id }, () => write(chain, "restore", type, id, {}, null, () => store.restore(type, id), () => store.get(type, id, { include_deleted: true })));
    },
    /** Kernel attributes of a record, from the gateway's own index. A record it did not write has none, so a policy predicate on it never matches. */
    /**
     * An event as this chain may see it (G-2): a record event carries field values in `before` and `after`, so the fields the chain's grant does not
     * allow, and `human`-level sealed fields hidden from its role, are cut from the diff and from `changed`. Other events pass unchanged.
     */
    async viewEvent(chain, e) {
      const d = e.data;
      if (!d || typeof d !== "object" || !d.after || typeof d.after !== "object") return e;
      const [, type] = String(e.subject).slice(7).split("/");
      if (!type || !TYPE_NAME.test(type)) return e;
      const dec = await check(chain, "records.read", e.subject);
      const lim = await limitsOf(chain, type, dec);
      // A group session sees the room's view of an event too: fields not every person may read are cut from the diff.
      const vs = await viewersOf(chain);
      const rl = vs ? await roomLim(vs, type, e.subject) : null;
      if (vs && rl === null) return Object.freeze({ ...e, data: { type: e.data && e.data.type }, redacted_view: true });
      if (rl) { if (rl.allow) lim.allow = lim.allow ? new Set([...lim.allow].filter(f => /** @type {Set<string>} */ (rl.allow).has(f))) : rl.allow; for (const h of rl.hidden) lim.hidden.add(h); }
      if (!lim.allow && !lim.hidden.size) return e;
      const keep = (/** @type {string} */ k) => !lim.hidden.has(k) && (!lim.allow || lim.allow.has(k));
      const cut = (/** @type {any} */ o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => keep(k))) : o);
      return Object.freeze({ ...e, data: { ...d, ...(d.before ? { before: cut(d.before) } : {}), after: cut(d.after), changed: (d.changed || []).filter(keep) }, redacted_view: true });
    },
    attrsOf: attrsOf,


    /**
     * Close intents a crash left open. An intent completes only when the store shows exactly the data this intent
     * expected (hash of the expected data and deleted state), and the event is written as the intent's own chain.
     * Nothing changed since the base means nothing happened (compensated); anything else, including another person's
     * change on the same record, or an intent past its age limit, is `unresolved` for a person to look at. Never guesses.
     */
    async recover() {
      const result = { completed: 0, compensated: 0, still_open: 0, unresolved: 0 };
      for (const intent of intents.values()) {
        if (intent.state !== "open") continue;
        if (clock() - intent.started_at > INTENT_MAX_AGE) { intent.state = "unresolved"; result.unresolved++; continue; }
        const [, type, id] = intent.record.slice(7).split("/");
        let rec;
        try { rec = id ? await store.get(type, id, { include_deleted: true }) : null; } catch { result.still_open++; continue; }
        const op = intent.operation;
        const exact = Boolean(rec) && intent.expect !== null && sha256(canonical({ deleted: Boolean(rec.deleted_at), data: rec.data })) === intent.expect
          && (op === "create" || (op === "restore" ? !rec.deleted_at : rec.version > intent.base_version));
        if (exact) {
          let c;
          try { c = await chains.restore(intent.stored); } catch { intent.state = "unresolved"; result.unresolved++; continue; }
          emit(c, intent, rec, intent.before_data ? { data: intent.before_data } : null, intent.decision, true);
          result.completed++;
          continue;
        }
        const untouched = op === "create" ? !rec : Boolean(rec) && (op === "restore" ? Boolean(rec.deleted_at) : !rec.deleted_at && rec.version === intent.base_version);
        if (untouched) { intent.state = "compensated"; retire(intent); result.compensated++; } else { intent.state = "unresolved"; result.unresolved++; }
      }
      return result;
    },

    openIntents: () => [...intents.values()].filter(i => i.state === "open").length,
    intents: () => [...intents.values()].map(({ stored: _s, ...rest }) => rest),
    /** Rebuild the version-hash index from the log (after a restart). */
    rebuild() {
      index.clear();
      // A durable log answers by lookup (`latestFor`), so there is nothing to read back: the index fills as records are touched.
      if (log.durable === true) return;
      for (const e of (log.iterate ? log.iterate({}) : log.read())) {
        const d = e.data;
        if (d && typeof d === "object" && typeof d.version_hash === "string" && typeof d.version === "number") index.set(e.subject, { version: d.version, hash: d.version_hash });
      }
    },
    versionHash,
  };
}
