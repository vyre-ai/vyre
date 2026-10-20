// @ts-check
// records: the app's Store calls over the kernel's gateway, one tool each (apps/app/src/store-core/contracts.js maps a Store method to a kernel call; this registers it). Every tool runs under the caller's own
// chain in the Space it names (lib/gateway-door.js: a token's or the person's facts, never the body), so the kernel's grants, sealed fields and rooms decide each answer. A refusal is
// { error: { code, message } } with the kernel's own codes (not_found, version_conflict, sealed_value_refused, bad_input, denied).
import { createDoor } from "../../lib/gateway-door.js";
import { MEMBER_BLOCKED_TYPES, MEMBER_READ_ONLY_TYPES } from "../../kernel/remote/member-guard.js";
import { segments } from "../../kernel/core/urn.js";
import { registerDevSeed } from "./dev-seed.js";
import { kitLibrary, kitFromLibrary } from "../../records/kits/library.js";
import { isSystemType } from "../../lib/record-types.js";
import { kindOf } from "../../lib/doc-refs.js";
import { registerPipeline } from "./pipeline.js";
import { registerRelationships } from "./relationship.js";
import { registerRollups, withWeighted } from "./rollup.js";
import { registerLayouts } from "./layout.js";
import { registerHistory } from "./history.js";
import { registerVisibility } from "./visibility.js";
import { registerTypeSettings } from "./type-settings.js";
import { registerRoles } from "./roles.js";
import { registerLinkFields } from "./link-fields.js";
import { registerSample } from "./sample.js";
import { registerStats } from "./stats.js";
import { withMe, withOwner } from "./me.js";
import { seesNote } from "../../lib/note-share.js";
import { registerQuick, quickFieldsOf, quickFieldsByType, forgetQuick, withFastFields, withoutFastFields, mergeOut, splitIn, bagInQuery, bagOf } from "./quick.js";
import { nextRef, refNumber, refPrefix, formatRef, mintRef, idOnCreate, idOnUpdate, keptOnUpdate, withoutBlankIds } from "./ref.js";
import { within } from "../../lib/within.js";
import { startPhotoSweep } from "./photo-sweep.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "device"];

/** The Space, type and id a record's reference names. @param {any} urn */
export function parseUrn(urn) {
  const s = segments(String(urn || ""));
  if (!s || s.length !== 3) throw refuse("that is not a record reference", "bad_input");
  return { space: s[0], type: s[1], id: s[2] };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const door = createDoor(ctx);
    // A Space's label is kept for a minute: Records opens with several calls at once, and each would otherwise ask spaces.merge-list again before it answers.
    /** @type {Map<string, { at: number, label: Promise<string | null> }>} */ const labels = new Map();
    const LABEL_MS = 60_000;
    /** The plain label spaces.merge-list gives a Space, or null. @param {string} id */
    const labelOf = async (id) => {
      let r; try { r = /** @type {any} */ (await ctx.call("spaces.merge-list", { person: ctx.kernel.owner })); } catch { r = null; }
      const row = r && r.data && Array.isArray(r.data.spaces) ? r.data.spaces.find((/** @type {any} */ x) => x.space === id) : null;
      const name = row && row.name;
      return typeof name === "string" ? name.replace(/\.vyre\.run$/, "") : null;
    };
    /** @typedef {{ space: string, gateway: any, surfaces: any, chain: any, proof: any }} Opened */
    /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: Opened) => Promise<any>} fn @param {(i: any) => any} [where] the Space a call acts in: the `space` it names, or the one its record reference names */
    /** The space a call acted in, named: its id and a plain label ("home" for the home's own space). A caller that wants a particular space passes `space`; with none the call acts in the home's own space, and says so here. @param {string} id */
    const actedIn = async id => {
      if (ctx.kernel && id === ctx.kernel.space) return { id, label: "home" };
      const kept = labels.get(id);
      if (kept && Date.now() - kept.at < LABEL_MS) return { id, label: await kept.label };
      const label = labelOf(id);
      labels.set(id, { at: Date.now(), label });
      const out = await label;
      // an unnamed answer is not kept, so a Space named a moment later shows its name on the next call
      if (out === null) labels.delete(id);
      return { id, label: out };
    };
    /** The Store calls a team MEMBER's app makes on the team's server, by tool name: the same bodies as the tools below, run under the member's own chain in the team's Space (the member door's rows, core/work/member-tools.js). @type {Map<string, { fn: (i: any, d: any) => Promise<any>, where: (i: any) => any }>} */
    const ops = new Map();
    const tool = (name, description, input, fn, where = i => i) => { ops.set(name, { fn, where }); ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const d = await door.open(where(i || {}), meta);
      const out = await fn(i || {}, d);
      // every answer names the space it acted in
      return out && typeof out === "object" && !Array.isArray(out) ? { ...out, acted_in: await actedIn(d.space) } : out;
    } }); };
    const byUrn = (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space });

    // Called by the spaces module when a Space is made: every Space already has its built-in store (the kernel opens one per hosted Space), so this answers at once and writes nothing. Twenty is
    // the store a Space asks for by name (VYRE_STORE), made by the stores layer at first use, never here.
    ctx.tool("records.workspace.create", {
      description: "Internal, for the spaces module: confirm a new Space has its store. The built-in store is always there.", input: obj({ space: str, name: str, store: str }, ["space"]), callers: ["module"],
      run: async (/** @type {any} */ i) => {
        if (i.store && i.store !== "builtin") throw refuse("that store is chosen when the Space is made; this one has the built-in store; make a new Space to use another (spaces.create)", "unavailable");
        return { workspaceId: await door.spaceOf(i) };
      },
    });
    ctx.tool("records.workspace.delete", {
      description: "Internal, for the spaces module: a Space's store goes with the Space, never by this call.", input: obj({ space: str }, ["space"]), callers: ["module"],
      run: async () => ({ ok: true }),
    });

    tool("records.me", "The person making this call, and the Space it acts in.", obj({ space: str }), async (_i, d) => ({ person: d.chain.hops[0].actor.id, space: d.space }));
    tool("records.actors", "The people of a Space: who each is and the role they hold. Only what the caller's role may see.", obj({ space: str }), async (_i, d) => {
      const list = await d.gateway.grants.members.list(d.chain);
      return { actors: (Array.isArray(list) ? list : []).map((/** @type {any} */ m) => ({ id: m.person, name: m.name || m.person, family: "person", role: m.role })) };
    });
    // A field added with records.field.add that is not a real field yet is listed with its type, marked fast: true with its state (bag or promoting), so a new column shows at once.
    tool("records.types", "The record types of a Space, as defined (a type may carry kind: project). The kernel's own bookkeeping types are left out unless `system: true` is asked for, and then carry system: true.", obj({ space: str, system: { type: "boolean" } }), async (i, d) => {
      const all = (await d.gateway.definitions(d.chain)) || [];
      const quick = await quickFieldsByType(d);
      const withFlag = all.map((/** @type {any} */ t) => (isSystemType(String(t.name)) ? { ...t, system: true } : withFastFields(t, quick.get(String(t.name)) || [])));
      return { types: i.system === true ? withFlag : withFlag.filter((/** @type {any} */ t) => !t.system) };
    });
    // What an address is, for the composer that turns a reference in instructions into a line a model reads. Answered from the TYPE DEFINITIONS alone, never a row: a first segment that is a record type the
    // Space's people made (not one of the kernel's own) is a record, whatever kind of thing the same word names elsewhere. When the definitions cannot be read it says record, which takes no shortcut.
    ctx.tool("records.address-kind", {
      internal: true,
      description: "Internal, for the composer: what a vyre:// address is, from the Space's record type definitions only (never a row). { kind, record_type? }.",
      input: obj({ urn: str }, ["urn"]), callers: ["module"],
      run: async (/** @type {any} */ i) => {
        const urn = String(i.urn || "");
        const space = (/^vyre:\/\/([^/]+)\//.exec(urn) || [])[1];
        if (!space) return { kind: "record" };
        try {
          const h = ctx.kernel.for(space);
          const owner = ctx.kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred", person: ctx.kernel.owner, path: "direct" });
          const defs = (await h.gateway.definitions(owner)) || [];
          const custom = defs.filter((/** @type {any} */ t) => !isSystemType(String(t.name)) && !(t.name === "project" && t.kind === "project")).map((/** @type {any} */ t) => String(t.name));
          const kind = kindOf(urn, custom);
          return kind === "record" ? { kind, record_type: (/^vyre:\/\/[^/]+\/([^/]+)\//.exec(urn) || [])[1] || null } : { kind };
        } catch { return { kind: "record", unknown: true }; }
      },
    });
    // A field marked fast: true (as records.types lists one) is left out of the change: it is a quick-field row until records.field.promote makes it a field of the store.
    tool("records.define", "Add or change record types and their fields (a DefineDiff). The kernel decides who may. A type that gains an ID field gives its older records their IDs, oldest first.", obj({ space: str, diff: { type: "object" } }, ["diff"]), async (i, d) => {
      i = { ...i, diff: withoutFastFields(i.diff) };
      const out = await d.gateway.records.define(d.chain, i.diff);
      // the person who defined it may update these records, so the IDs are given under their own chain, once; records that have one are left alone
      for (const t of [...((i.diff && i.diff.add_types) || []), ...((i.diff && i.diff.change_types) || [])]) {
        if (t && typeof t.name === "string" && (t.fields || []).some((/** @type {any} */ f) => f && f.name === "ref")) { try { const { skipped } = await fillIds(d, t.name); ctx.log(`records: gave ${t.name}'s records their IDs${skipped ? `; ${skipped} could not be given one` : ""}`); } catch (e) { ctx.log(`records: ${t.name}'s records were not all given their IDs (${/** @type {Error} */ (e).message})`); } }
      }
      return out;
    });
    // The planner's Note type is read raw only by an owner, an admin or the planner; even then a private note is its writer's (core/planner/note-share.js), so the raw route cuts to the same rule.
    const isPlannerNote = async (/** @type {any} */ d, /** @type {string} */ type) => type === "note" && ((await d.gateway.definitions(d.chain)) || []).some((/** @type {any} */ t) => t.name === "note" && t.protected === true);
    const mayReadRecord = (/** @type {any} */ d) => async (/** @type {string} */ urn) => { const p = urn.split("/"); try { return Boolean(await d.gateway.records.get(d.chain, p[3], p[4])); } catch { return false; } };
    const noteSeen = async (/** @type {any} */ d, /** @type {any} */ row) => { if (!row) return true; const n = row.data || {}; const me = d.chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person"); return seesNote({ kind: "note", by: n.person, visibility: n.visibility, record: n.record }, me ? String(me.actor.id) : null, mayReadRecord(d)); };
    const cutNotes = async (/** @type {any} */ d, /** @type {string} */ type, /** @type {any[]} */ rows) => { if (!(await isPlannerNote(d, type))) return rows; const out = []; for (const r of rows) if (await noteSeen(d, r)) out.push(r); return out; };
    // How many records of a type the caller may read, under the same filter: one count in the store (records.aggregate counts natively where it can), never a scan of pages here.
    // Null when it takes longer than COUNT_MS or the store cannot say, so a slow count never holds the page back. A planner Note is cut row by row after the read, so it has no count here.
    const COUNT_MS = 1500;
    const countOf = async (/** @type {any} */ d, /** @type {string} */ type, /** @type {any} */ filter) => {
      if (await isPlannerNote(d, type)) return null;
      const rows = await within(d.gateway.records.aggregate(d.chain, type, { ...(filter ? { filter } : {}), group_by: [], measures: [{ fn: "count" }] }).catch(() => null), COUNT_MS, null);
      return Array.isArray(rows) ? rows.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + Number((r && r.values && r.values.count) || 0), 0) : null;
    };
    tool("records.list", "One page of records of a type: filter, sort, a cursor from the last page. include_deleted lists the removed ones too (the Bin): your own, or all for an owner or admin.", obj({ space: str, type: str, filter: {}, sort: { type: "array" }, cursor: str, limit: { type: "integer" }, include_deleted: { type: "boolean" }, count: { type: "boolean" } }, ["type"]), async (i, d) => {
      const limit = Number.isInteger(i.limit) ? Math.min(Math.max(i.limit, 1), 200) : 50;
      const type = String(i.type);
      const filter = i.filter ? withMe(i.filter, d.chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person")?.actor.id ?? "") : undefined;
      // The type's quick fields, the page and (asked for) the count are read at once: on a store that answers over the network (Twenty) each read is a round trip, and none waits on another.
      // A filter or sort on a field still being set up is refused as before; the page read beside it is dropped.
      const pageP = d.gateway.records.query(d.chain, type, { ...(filter ? { filter } : {}), ...(Array.isArray(i.sort) ? { sort: i.sort } : {}), ...(i.include_deleted === true ? { include_deleted: true } : {}), page: { limit, ...(i.cursor ? { cursor: String(i.cursor) } : {}) } })
        .then((/** @type {any} */ r) => ({ r }), (/** @type {any} */ e) => ({ e }));
      const countP = i.count === true && !i.cursor && i.include_deleted !== true ? countOf(d, type, filter).catch(() => null) : null;
      const qf = (await quickFieldsOf(d, type)).filter((f) => f.state !== "real");
      const hit = bagInQuery({ filter: i.filter, sort: i.sort }, qf);
      if (hit) throw refuse(`${hit} is still being set up, so it cannot be filtered or sorted yet. Try again in a minute.`, "bad_input");
      const got = await pageP;
      if ("e" in got) throw got.e;
      const r = got.r;
      const seen = await cutNotes(d, type, r.rows);
      const rows = qf.length ? seen.map((/** @type {any} */ x) => mergeOut(x, qf)) : seen;
      if (!countP) return { rows, next_cursor: r.next_cursor || null };
      // A first page that holds every record is its own count; otherwise the store's count, or null when it was slow.
      return { rows, next_cursor: r.next_cursor || null, total: r.next_cursor ? await countP : rows.length };
    });
    tool("records.get", "One record by its reference, or null when it is not there or not yours to see.", obj({ urn: str }, ["urn"]), async (i, d) => {
      const u = parseUrn(i.urn);
      const rec = await d.gateway.records.get(d.chain, u.type, u.id);
      if (rec && (await isPlannerNote(d, u.type)) && !(await noteSeen(d, rec))) return { record: null };
      return { record: rec ? mergeOut(rec, (await quickFieldsOf(d, u.type)).filter((f) => f.state !== "real")) : rec };
    }, byUrn);
    // (the reference route cuts a planner Note the same way)
    tool("records.reference", "A record put in front of the AI (the # in the composer): the record as data, with every sealed part (and any part this room may not read) a {{field:urn#name}} placeholder, never a value. Null when it is not there or not yours to see.", obj({ urn: str }, ["urn"]), async (i, d) => {
      const u = parseUrn(i.urn);
      if (await isPlannerNote(d, u.type) && !(await noteSeen(d, await d.gateway.records.get(d.chain, u.type, u.id)))) return { reference: null };
      return { reference: await d.gateway.records.reference(d.chain, u.type, u.id) };
    }, byUrn);
    // A type with a `ref` field gives each record an ID when it is made (PER-0001, the next after the highest): minted here, one at a time per type so two at once do not share one, and never taken from the caller.
    /** @type {Map<string, Promise<any>>} */ const minting = new Map();
    /** @type {Map<string, number>} the highest number given out here for a type in a Space, so the next one starts past it whatever the caller can see */ const issued = new Map();
    const hasRef = async (/** @type {any} */ d, /** @type {string} */ type) => { try { return ((await d.gateway.definitions(d.chain)) || []).some((/** @type {any} */ t) => t.name === type && (t.fields || []).some((/** @type {any} */ f) => f.name === "ref")); } catch { return false; } };
    tool("records.create", "Make a record of a type. A type with an ID field gives the record the next ID (PER-0001).", obj({ space: str, type: str, data: { type: "object" } }, ["type", "data"]), async (i, d) => {
      const type = String(i.type);
      // The record's identity is Vyre's: its id and address always, and its ID on a type that has an ID field. Naming one is refused in words, never quietly replaced.
      const withRef = await hasRef(d, type);
      { const no = idOnCreate(i.data, withRef); if (no) throw refuse(no, "field_not_allowed"); }
      i = { ...i, data: withoutBlankIds(i.data || {}, withRef) };
      try { i = { ...i, data: splitIn(i.data || {}, await quickFieldsOf(d, type)) }; if ("amount" in i.data || "probability" in i.data) { const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === type); if (t) i = { ...i, data: withWeighted(t.fields || [], {}, i.data) }; } } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      { const who = d.chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person"); if (who && ["communication", "event"].includes(type)) { const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === type); i = { ...i, data: withOwner(type, t && t.fields, i.data || {}, who.actor.id) }; } }
      if (!withRef) return { record: await d.gateway.records.create(d.chain, type, i.data) };
      const key = `${d.space}:${type}`;
      const before = minting.get(key) || Promise.resolve();
      const mine = before.catch(() => {}).then(async () => {
        // Start past the highest ID this caller can see and past the last one given out here. A caller who cannot see every record (a member) may be handed an ID that a hidden record holds: the unique ID refuses it, and the next try moves on
        // (by 1, then 10, then 100...). What the refusal said is never passed on, so it does not tell anyone that a record with that ID exists.
        const last = await d.gateway.records.query(d.chain, type, { sort: [{ field: "ref", dir: "desc" }], page: { limit: 5 } }).catch(() => ({ rows: [] }));
        const seen = nextRef(type, ((last && last.rows) || []).map((/** @type {any} */ r) => r && r.data && r.data.ref));
        const n = Math.max(refNumber(refPrefix(type), seen), (issued.get(key) || 0) + 1);
        const out = await mintRef({ type, start: n, create: (ref) => d.gateway.records.create(d.chain, type, { ...(i.data || {}), ref }) });
        issued.set(key, out.n);
        return out.made;
      });
      minting.set(key, mine);
      return { record: await mine };
    });
    // Records made before their type had an ID get one, once, in the order they were made; a record that has one is left alone, so it can run again. records.list starts it when a page shows a record without one.
    const fillIds = async (/** @type {any} */ d, /** @type {string} */ type) => {
      const key = `${d.space}:${type}`;
      const before = minting.get(key) || Promise.resolve();
      const run = before.catch(() => {}).then(async () => {
        const all = await d.gateway.records.query(d.chain, type, { sort: [{ field: "created_at", dir: "asc" }], page: { limit: 1000 } });
        const rows = (all && all.rows) || [];
        let have = rows.map((/** @type {any} */ r) => r && r.data && r.data.ref).filter(Boolean);
        let skipped = 0;
        // a record that cannot be given one (an ID a hidden record holds, a record the definer may not change) is skipped and counted: the rest still get theirs
        for (const r of rows) {
          if (!(r && r.data && !r.data.ref)) continue;
          try {
            const out = await mintRef({ type, start: refNumber(refPrefix(type), nextRef(type, have)), create: (ref) => d.gateway.records.update(d.chain, type, r.id, { ref }, r.version) });
            have = [...have, formatRef(refPrefix(type), out.n)];
          } catch { skipped++; }
        }
        return { skipped };
      });
      minting.set(key, run);
      return run;
    };
    // The one way a record is changed by a tool: the ID never changes, fast-field values go to the bag, the weighted value follows. records.update and records.move both come through here.
    const applyUpdate = async (/** @type {any} */ d, /** @type {{ type: string, id: string }} */ u, /** @type {any} */ inPatch, /** @type {number} */ baseVersion) => {
      // the type is read once for the checks and the weighted value; the definitions and the fast fields are read at once
      const [defs, qf] = await Promise.all([Promise.resolve(d.gateway.definitions(d.chain)).catch(() => []), quickFieldsOf(d, u.type)]);
      const def = (defs || []).find((/** @type {any} */ x) => x.name === u.type);
      const fields = (def && def.fields) || [];
      { const no = idOnUpdate(inPatch, fields.some((/** @type {any} */ f) => f.name === "ref")) || keptOnUpdate(fields, inPatch); if (no) throw Object.assign(new Error(no), { code: "field_not_allowed" }); }
      let patch = inPatch;
      if (qf.some((f) => f.state === "bag" && patch && f.name in patch)) {
        const cur = await d.gateway.records.get(d.chain, u.type, u.id);
        try { patch = splitIn(patch, qf, cur && cur.data && cur.data.extra); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      }
      if (patch && ("amount" in patch || "probability" in patch)) {
        const t = def;
        const cur = t && (await d.gateway.records.get(d.chain, u.type, u.id));
        if (t && cur) patch = withWeighted(t.fields || [], cur.data || {}, patch);
      }
      const out = await d.gateway.records.update(d.chain, u.type, u.id, patch, baseVersion);
      return { record: mergeOut(out, qf.filter((f) => f.state !== "real")) };
    };
    tool("records.update", "Change a record's fields; a stale base_version is refused (version_conflict). A record's ID never changes.", obj({ urn: str, patch: { type: "object" }, base_version: { type: "integer" } }, ["urn", "patch", "base_version"]), async (i, d) => {
      return applyUpdate(d, parseUrn(i.urn), i.patch, i.base_version);
    }, byUrn);
    // The bin: a removed record keeps its data and history until it is restored, or deleted for good with records.forget. Whoever may change a record may remove it and bring it back (the kernel's
    // records.remove and records.restore, which every member role but a temporary one holds); a stale base_version is refused, as an update's is.
    tool("records.remove", "Move a record to the bin: { urn, base_version }. It keeps its data and history there and records.list with include_deleted lists it; records.restore brings it back, records.forget deletes it for good. A stale base_version is refused (version_conflict).", obj({ urn: str, base_version: { type: "integer" } }, ["urn", "base_version"]), async (i, d) => {
      const u = parseUrn(i.urn);
      const out = await d.gateway.records.remove(d.chain, u.type, u.id, i.base_version);
      return { removed: String(i.urn), version: out && typeof out === "object" ? out.version : undefined };
    }, byUrn);
    tool("records.restore", "Bring a record back from the bin: { urn }. It comes back with its data as it was when it was removed.", obj({ urn: str }, ["urn"]), async (i, d) => {
      const u = parseUrn(i.urn);
      const out = await d.gateway.records.restore(d.chain, u.type, u.id);
      return { restored: String(i.urn), record: out && typeof out === "object" ? mergeOut(out, (await quickFieldsOf(d, u.type)).filter((f) => f.state !== "real")) : null };
    }, byUrn);

    registerPipeline({ tool, obj, str, refuse, parseUrn, update: applyUpdate });
    registerRelationships({ tool, obj, str, refuse, parseUrn });
    registerQuick({ tool, obj, str, refuse, parseUrn, addLink: (/** @type {any} */ i, /** @type {any} */ d) => /** @type {any} */ (ops.get("records.link.add")).fn({ type: i.type, label: i.label, to: i.to, many: i.many, ...(i.inverse !== undefined ? { inverse_label: i.inverse } : {}) }, d) });
    registerLayouts({ tool, obj, str, refuse });
    registerHistory({ tool, obj, str, refuse, parseUrn });
    registerVisibility({ tool, obj, str, refuse, parseUrn });
    registerTypeSettings({ tool, obj, str, refuse });
    registerRoles({ tool, obj, str, refuse, parseUrn });
    registerLinkFields({ tool, obj, str, refuse, parseUrn });
    registerSample({ tool, obj, str, refuse, parseUrn });
    registerStats({ tool, obj, str, refuse });
    registerRollups({ tool, obj, str, refuse });
    // ---- what links to a record, and the Kits this build ships ----
    tool("records.linked", "Everything that links to a record (the reverse of a link field), across types, only what the caller may read. `truncated` is true when more exist than `limit` (default 50, at most 200).", obj({ urn: str, type: str, field: str, limit: { type: "integer" } }, ["urn"]), async (i, d) => {
      parseUrn(i.urn);
      return d.gateway.records.linked(d.chain, String(i.urn), { ...(i.type ? { type: String(i.type) } : {}), ...(i.field ? { field: String(i.field) } : {}), ...(Number.isInteger(i.limit) ? { limit: i.limit } : {}) });
    }, byUrn);
    tool("records.roles", "What a contact or organization is to the Space: every role record that points at it (prospect, client, ambassador, whatever the Space defined), current ones first. Ended roles are included unless `include_ended` is false. Only roles the caller may read.", obj({ urn: str, include_ended: { type: "boolean" } }, ["urn"]), async (i, d) => {
      parseUrn(i.urn);
      return { roles: await d.gateway.records.roles(d.chain, String(i.urn), i.include_ended === false ? { include_ended: false } : {}) };
    }, byUrn);
    tool("records.holders", "Who holds one role: a page of role records, each naming its holder. `role` is a role type, `stage` narrows to one stage. Ended roles are left out unless `include_ended` is true. Only rows the caller may read.", obj({ space: str, role: str, stage: str, include_ended: { type: "boolean" }, cursor: str, limit: { type: "integer" } }, ["role"]), async (i, d) => {
      const limit = Number.isInteger(i.limit) ? Math.min(Math.max(i.limit, 1), 200) : 50;
      const r = await d.gateway.records.holders(d.chain, { role: String(i.role), ...(i.stage !== undefined ? { stage: String(i.stage) } : {}), ...(i.include_ended === true ? { include_ended: true } : {}), page: { limit, ...(i.cursor ? { cursor: String(i.cursor) } : {}) } });
      return { rows: r.rows, next_cursor: r.next_cursor || null };
    });
    tool("records.kits.library", "The Kits this build ships, before anything is installed: id, name, version and what each adds.", obj({ space: str }), async () => ({ kits: kitLibrary() }));
    tool("records.kits.get", "One Kit from the library in the form the Flows tools take (flows.kit.card to see what it would do, flows.kit.propose to ask for the install).", obj({ space: str, id: str }, ["id"]), async i => {
      try { return { kit: kitFromLibrary(String(i.id)) }; } catch (e) { throw refuse(/** @type {any} */ (e).message, "not_found"); }
    });

    // Permanent, so the person's own act with their presence: a model or a session never runs it (it proposes through records.forget.propose), and the proof rides into the kernel's gate.
    /** How many sessions on this machine mention the record (its id): counted, never searched for what they say. Null when Recall cannot answer. @param {string} id */
    const sessionsMentioning = async id => {
      try {
        const r = /** @type {any} */ (await ctx.call("recall.search", { q: id, limit: 100, per_session: 1, hybrid: false }));
        const hits = r && r.data;
        const rows = r && r.error ? null : Array.isArray(hits) ? hits : Array.isArray(hits && hits.hits) ? hits.hits : null;
        return rows ? new Set(rows.map((/** @type {any} */ h) => h.session)).size : null;
      } catch { return null; }
    };
    ctx.tool("records.forget", {
      description: "Forget one record for good: the text of every task about it is emptied, the store destroys it and its history, its events lose their data, and its sealed values are destroyed. Linked files stay in Files. Cannot be undone. Customize-level (admin and owner), the person's own act with their presence; an assistant proposes it with records.forget.propose.",
      input: obj({ urn: str }, ["urn"]), callers: CALLERS, presence: true,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const u = parseUrn(i.urn);
        const d = await door.open({ space: u.space }, meta);
        const out = await d.gateway.migrate.forget(d.chain, { type: u.type, id: u.id, ...(d.proof ? { presence: d.proof } : {}) });
        const sessions = await sessionsMentioning(u.id);
        return {
          ...out, sessions_mentioning: sessions,
          message: [
            `Forgot the record. ${out.tasks_cleared} task text${out.tasks_cleared === 1 ? "" : "s"} emptied, ${out.erased_events === 1 ? "1 event lost its" : `${out.erased_events} events lost their`} data.`,
            out.sealed_dropped || out.sealed_left ? `${out.sealed_dropped} sealed value${out.sealed_dropped === 1 ? "" : "s"} destroyed${out.sealed_left ? `, ${out.sealed_left} could not be and still sit in the sealing store` : ""}.` : "It held no sealed values.",
            out.files_kept ? `${out.files_kept} linked file${out.files_kept === 1 ? " stays" : "s stay"} in Files: forget ${out.files_kept === 1 ? "it" : "them"} there.` : "It linked no files.",
            sessions === null ? "Memory could not be asked which sessions mention it." : `${sessions} session${sessions === 1 ? " mentions" : "s mention"} it.`,
            "Sessions that quoted this record are not searched. Forget them in Memory.",
          ].join(" "),
        };
      },
    });
    tool("records.forget.propose", "Ask the person to forget one record for good. Nothing is forgotten: a task goes to the person, who does it themselves with their presence. For an assistant, which may only propose.", obj({ urn: str, why: str }, ["urn"]), async (i, d) => {
      const u = parseUrn(i.urn);
      const rec = await d.gateway.records.get(d.chain, u.type, u.id);
      if (!rec) throw refuse("no such record: check the address (urn) you gave", "not_found");
      const me = d.chain.hops[0].actor;
      const task = await d.gateway.ask.request(d.chain, { title: `Forget ${u.type} ${u.id.slice(0, 8)}?`, record: i.urn, doer: me, output: { kind: "decision" }, note: `Proposed: forget this record for good. It cannot be undone.${i.why ? ` Why: ${String(i.why).slice(0, 300)}` : ""}` });
      return { proposed: true, task: task.id, message: "Nothing was forgotten. The person has a task to decide it with their presence." };
    }, byUrn);

    // Sealing a field for every record of a type: the kernel's own migration (gateway.migrate.sealField), never a flag on the definition. The plain values move into a new sealed field (<field>_sealed), the
    // plain field is emptied and removed from view, and the old values are scrubbed from the change log, the snapshots, the event log and the task texts that quote them. It cannot be undone, so it is an
    // owner's or an admin's own act with their presence: a model or an agent never runs it, and the kernel still checks records.define, records.update on every record and seal.put under the caller's chain.
    ctx.tool("records.field.seal", {
      description: "Seal a plain text field for every record of a type: its values move into a new sealed field, the plain field is removed from view and the old values are scrubbed from the history. Agents then see only a placeholder. Cannot be undone. An owner's or admin's own act with their presence. { type, field, class? (default free) }.",
      input: obj({ space: str, type: str, field: str, class: str }, ["type", "field"]), callers: CALLERS, presence: true,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const d = await door.open({ ...(i.space ? { space: i.space } : {}) }, meta);
        let role = null; try { role = d.gateway.members.roleOf(d.chain.hops[0].actor); } catch { role = null; }
        if (role !== "owner" && role !== "admin") throw refuse("Only an owner or an admin seals a field. Ask one of them.", "not_allowed");
        if (!d.gateway.migrate || !d.gateway.seal) throw refuse("this Space has no sealing process, so a field cannot be sealed here; ask the owner to seal it on the Space's server", "unavailable");
        const out = await d.gateway.migrate.sealField(d.chain, { type: String(i.type || ""), field: String(i.field || ""), class: i.class ? String(i.class) : "free" });
        forgetQuick(d.space);
        return { ...out, acted_in: await actedIn(d.space) };
      },
    });

    // ---- sealed values and the event feed ----
    tool("records.seal-put", "Put a value into a record's sealed field. It goes straight to the sealing process and never rides the record; the record keeps only the reference. The person's own act.", obj({ urn: str, field: str, value: str, class: str }, ["urn", "field", "value"]), async (i, d) => {
      const u = parseUrn(i.urn);
      if (!d.gateway.seal) throw refuse("this Space has no sealing process, so sealed values need another Space; ask the owner or an admin", "unavailable");
      let cls = i.class ? String(i.class) : "";
      if (!cls) {
        const def = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ t) => t.name === u.type);
        const f = def && (def.fields || []).find((/** @type {any} */ x) => x.name === i.field);
        cls = f && f.seal && f.seal.class ? String(f.seal.class) : "";
      }
      if (!cls) throw refuse("that field is not a sealed field", "bad_input");
      const put = await d.gateway.seal.put(d.chain, { record: i.urn, field: String(i.field), class: cls, value: String(i.value) });
      const ref = put && put.ref && typeof put.ref === "object" ? put.ref : put;
      const cur = await d.gateway.records.get(d.chain, u.type, u.id);
      if (!cur) throw refuse("no such record: check the address (urn) you gave", "not_found");
      return { record: await d.gateway.records.update(d.chain, u.type, u.id, { [String(i.field)]: ref }, cur.version) };
    }, byUrn);
    tool("records.reveal", "Show a sealed value to the person on their own screen, once. Human-only: the person's presence proof rides beside the request and the chain must be exactly one person.", obj({ urn: str, field: str, purpose: str }, ["urn", "field", "purpose"]), async (i, d) => {
      const u = parseUrn(i.urn);
      if (!d.gateway.seal) throw refuse("this Space has no sealing process, so sealed values need another Space; ask the owner or an admin", "unavailable");
      const rec = await d.gateway.records.get(d.chain, u.type, u.id);
      const v = rec && rec.data ? rec.data[String(i.field)] : undefined;
      if (!v || typeof v !== "object" || typeof v.ref !== "string") throw refuse("there is nothing sealed there to show", "not_found");
      if (d.remote) {
        // A space on a server: the home's sealing process checks the yes. The first call says what to sign (a challenge from the home); the proof made for that challenge (it names `home` and `challenge`) comes back beside the next call and goes on as the trailing option.
        const kp = d.kernelProof && typeof d.kernelProof.challenge === "string" ? d.kernelProof : null;
        try { return await d.gateway.seal.reveal(d.chain, { record: i.urn, ref: v.ref, purpose: String(i.purpose) }, ...(kp ? [{ presence: kp, challenge: kp.challenge }] : [])); }
        catch (e) {
          const ch = /** @type {any} */ (e) && /** @type {any} */ (e).challenge;
          if (ch && typeof ch.nonce === "string" && /^(needs_presence|presence_required)$/.test(String(/** @type {any} */ (e).code)) && !kp) return { needs_proof: true, request: { space: d.space, op: ch.op, fields: ch.fields, payload_hash: ch.payload_hash, home: ch.home, challenge: ch.nonce, expires: ch.expires } };
          throw e;
        }
      }
      return d.gateway.seal.reveal(d.chain, { record: i.urn, ref: v.ref, purpose: String(i.purpose), proof: d.proof });
    }, byUrn);
    tool("records.sees-as", "The record as the person sees it, or as their assistant would (sealed fields only as placeholders, and only the fields its grants allow).", obj({ urn: str, who: { type: "string", enum: ["person", "assistant"] } }, ["urn", "who"]), async (i, d) => {
      const u = parseUrn(i.urn);
      if (i.who !== "assistant") { const r = await d.gateway.records.get(d.chain, u.type, u.id); return { data: r ? r.data : null }; }
      // The assistant's own chain for this person, made by the kernel's Surfaces door for this one look and ended straight after.
      const s = await d.surfaces.open(d.chain, { agent: "assistant", ttl_ms: 30_000 });
      try {
        const r = await d.gateway.records.get(await d.surfaces.chainFor(s.token), u.type, u.id);
        return { data: r ? r.data : null };
      } finally { d.surfaces.revoke(s.session); }
    }, byUrn);
    tool("records.events", "The Space's event log as the caller may read it: for a record, for a task, or all; newest last.", obj({ space: str, record: str, task: str, since: { type: "integer" }, limit: { type: "integer" } }), async (i, d) => {
      const prefix = i.record ? String(i.record) : i.task ? `vyre://${d.space}/task/${String(i.task)}` : null;
      const limit = Number.isInteger(i.limit) ? Math.min(Math.max(i.limit, 1), 500) : 100;
      return { events: await d.gateway.events.read(d.chain, { ...(prefix ? { subject_prefix: prefix } : {}), ...(Number.isInteger(i.since) ? { since: i.since } : {}), limit }) };
    });
    // Who changed what, from the signed event log: an owner or an admin only. Each entry is one change to a record with the values before and after as the log keeps them (a sealed value is only ever a
    // placeholder there, so it stays sealed here), by whom and when. Filter by record, person, project or record type; newest first. The log is read through the caller's own chain, so an entry the
    // caller may not see is not in it.
    tool("records.audit", "Who changed what on a record, with the values before and after, from the signed event log. Owners and admins only. { record?, person?, project?, type?, since?, limit? }.", obj({ space: str, record: str, person: str, project: str, type: str, since: { type: "integer" }, limit: { type: "integer" }, page: { type: "integer" }, window: { type: "integer" } }), async (i, d) => {
      const role = (() => { try { return d.gateway.members.roleOf(d.chain.hops[0].actor); } catch { return null; } })();
      if (role !== "owner" && role !== "admin") throw refuse("only an owner or an admin opens the audit", "not_allowed");
      const limit = Number.isInteger(i.limit) ? Math.min(Math.max(i.limit, 1), 200) : 50;
      const prefix = i.record ? String(i.record) : null;
      const person = typeof i.person === "string" && i.person ? `person:${i.person}` : null;
      const project = typeof i.project === "string" && i.project ? i.project.replace(/^.*\//, "") : null;
      const isChange = /** @type {(t: string) => boolean} */ (t => /^[a-z][a-z0-9-]*\.(created|updated|removed|restored)$/.test(t) && !/^(grant|member|actor|offer|invite|chat|rule|team|vault|task|team-member)\./.test(t));
      // The log is read forward in pages (the log has no backward read), from the start of a window that ends at its newest event: the newest `window` events (100,000 unless asked for less), or since `since`
      // when that is later. When older events lie before the window the answer says `truncated`. A page is `page` events (1,000); the end is a page that comes back short.
      const page = Number.isInteger(i.page) ? Math.min(Math.max(i.page, 10), 1000) : 1000;
      const window = Number.isInteger(i.window) ? Math.max(i.window, 20) : 100_000;
      const first = Math.max(Number.isInteger(i.since) ? i.since : 0, Number(d.gateway.events.latestSeq()) - window);
      const truncated = first > (Number.isInteger(i.since) ? i.since : 0);
      /** @type {any[]} */ const events = [];
      for (let after = first; ;) {
        const got = await d.gateway.events.read(d.chain, { ...(prefix ? { subject_prefix: prefix } : {}), since: after, limit: page });
        events.push(...got.filter((/** @type {any} */ e) => isChange(String(e.type))));
        if (got.length < page) break;
        after = Number(got[got.length - 1].seq);
      }
      const link = (/** @type {any} */ v) => (v && typeof v === "object" ? String(v.urn || "") : typeof v === "string" ? v : "");
      const rows = [];
      const whoOf = (/** @type {any} */ e) => String(e.actor).split("@")[0];   // the log keeps a person as person:id@space; the audit names the person
      for (const e of events) {
        if (!isChange(String(e.type))) continue;
        const [recType] = String(e.type).split(".");
        if (i.type && recType !== i.type) continue;
        if (person && whoOf(e) !== person) continue;
        if (project) {
          const at = (typeof d.gateway.records.attrsOf === "function" ? d.gateway.records.attrsOf(String(e.subject)) : null) || {};
          const data = e.data || {};
          const linked = [data.after, data.before].some(x => x && typeof x === "object" && Object.values(x).some(v => (Array.isArray(v) ? v : [v]).some(one => link(one).endsWith(`/${project}`))));
          if (String(at.project || "") !== project && !linked) continue;
        }
        const data = e.data || {};
        rows.push({ seq: e.seq, time: e.time, who: whoOf(e), ...(e.acted_via ? { via: e.acted_via } : {}), verb: String(e.type).split(".")[1], type: recType, record: e.subject, version: data.version, changed: data.changed || [], before: data.before ?? null, after: data.after ?? null });
      }
      rows.reverse();
      return { changes: rows.slice(0, limit), more: rows.length > limit, ...(truncated ? { truncated: true } : {}) };
    });
    // ---- the member door: a team member's daily work on records, run as her, in the team's Space (core/work/member-tools.js) ----
    // The input keys each call takes: anything else is dropped before the tool sees it, so a member's call cannot name a Space, a proof or a chain. The kernel judges every record under her chain.
    const MEMBER_KEYS = /** @type {Record<string, string[]>} */ ({
      me: [], actors: [], types: [], list: ["type", "filter", "sort", "cursor", "limit", "include_deleted"], get: ["urn"], events: ["record", "task", "since", "limit"], audit: ["record", "changed_by", "in_project", "type", "since", "limit"],
      create: ["type", "data"], update: ["urn", "patch", "base_version"],
      // a member moves records through stages, relates records and saves her OWN layout; the kernel's write rules decide which records, and a Space-wide layout is refused to her by the tool and the kernel
      "layout.get": ["type"], "relationship.list": ["urn"], "relationship.kinds": [], move: ["urn", "stage", "lost_reason", "patch"],
      "relationship.add": ["from", "to", "kind", "since", "until", "note"], "relationship.remove": ["id"], "layout.set": ["type", "scope", "layout"],
      // a member reads a record's history, a board's totals, the Busy blocks and her roles, and logs a call or a meeting (or a note) on a record she can read: each is the same tool body the owner runs, under her chain
      history: ["urn", "limit"], stats: ["type", "group_by", "sum", "filter"], busy: ["from", "to"], "roles.summary": ["urn"], log: ["urn", "kind", "text"],
      // (0.6.4) a member reads a record's roles and who holds one, gives a record a role, shares her own synced event, undoes a change in a record's history, and removes or restores a record she may change; an
      // owner's or an admin's own field and link additions reach the team the same way, and the tools refuse every other member (link-fields.js, quick.js)
      roles: ["urn", "include_ended"], holders: ["role", "stage", "include_ended", "cursor", "limit"], "role.set": ["urn", "role", "stage", "since"], share: ["urn", "visibility"], "history.undo": ["id"],
      remove: ["urn", "base_version"], restore: ["urn"], "link.add": ["type", "label", "to", "many", "inverse_label"], "field.add": ["type", "label", "kind", "options", "to", "inverse", "many"],
    });
    /** The calls of the member door that only read. */
    const READS = ["me", "actors", "types", "list", "get", "events", "audit", "layout.get", "relationship.list", "relationship.kinds", "history", "stats", "busy", "roles.summary", "roles", "holders"];
    /** The calls of the member door that change a record. */
    const WRITES = ["update", "move", "relationship.add", "relationship.remove", "layout.set", "log", "role.set", "share", "history.undo", "remove", "restore", "link.add", "field.add"];
    const serve = (/** @type {string[]} */ calls) => async (/** @type {any} */ i, /** @type {any} */ extra) => {
      if (!extra || !extra.in_space_chain || !extra.in_space) throw refuse("only the team server's member door runs this", "denied");
      if (!i || !calls.includes(i.call)) throw refuse(`call is one of ${calls.join(", ")}`, "bad_input");
      const op = ops.get(`records.${i.call}`);
      if (!op) throw refuse("no such call; use one of the calls this tool names in its input", "not_found");
      const src = i.input && typeof i.input === "object" && !Array.isArray(i.input) ? i.input : {};
      const clean = Object.fromEntries(Object.entries(src).filter(([k]) => MEMBER_KEYS[i.call].includes(k)));
      // the audit's two filters cross the door under names that are not identity keys; the tool reads them as person and project
      if (i.call === "audit") { if ("changed_by" in clean) { clean.person = clean.changed_by; delete clean.changed_by; } if ("in_project" in clean) { clean.project = clean.in_project; delete clean.in_project; } }
      // a note is the team planner's Note (planner.serve); this door logs a call or a meeting
      if (i.call === "log" && clean.kind === "note") throw refuse("Write a note from the Notes tab: it goes to the team's planner.", "bad_input");
      const d = await door.open({}, extra);
      // The types the team's own tools keep (skills, Flows, project templates...) are not a member's through this door, as they are not through the gateway's calls (kernel/remote/member-guard.js); the owner and admins keep theirs.
      const role = (() => { try { return d.gateway.members.roleOf(d.chain.hops[0].actor); } catch { return null; } })();
      const trusted = role === "owner" || role === "admin";
      const ref = typeof clean.urn === "string" ? clean.urn : typeof clean.record === "string" ? clean.record : typeof clean.id === "string" ? clean.id : "";
      const typeOfUrn = (/** @type {string} */ x) => (/^vyre:\/\/[^/]+\/([^/]+)\//.exec(x) || [])[1];
      // the types a call names: its type, the role type it gives or lists, the type a new link goes to (a `to` that is a record address is a relationship's other end, not a type), the type its record address
      // names, and for an undo by history id the type of the record that change was on
      const named = [clean.type, clean.role, typeof clean.to === "string" && !clean.to.startsWith("vyre://") ? clean.to : undefined, typeOfUrn(ref)];
      if (!trusted && i.call === "history.undo" && /^[0-9]+$/.test(String(clean.id || ""))) {
        const ev = (await d.gateway.events.read(d.chain, { since: Number(clean.id) - 1, limit: 1 }).catch(() => []))[0];
        if (ev && Number(ev.seq) === Number(clean.id)) named.push(typeOfUrn(String(ev.subject || "")));
      }
      for (const ty of named) {
        if (typeof ty !== "string" || trusted) continue;
        if (MEMBER_BLOCKED_TYPES.has(ty)) throw refuse("no such record type; pick one from the types your screen lists, or ask the owner", "not_found");
        if (!READS.includes(i.call) && MEMBER_READ_ONLY_TYPES.has(ty)) throw refuse("that is kept by the team's own tools; ask the owner or an admin", "not_allowed");
      }
      const out = await op.fn(clean, d);
      return !trusted && i.call === "types" && out && Array.isArray(out.types) ? { ...out, types: out.types.filter((/** @type {any} */ x) => !MEMBER_BLOCKED_TYPES.has(String(x && x.name))) } : out;
    };
    const serveInput = (/** @type {string[]} */ calls) => obj({ call: { type: "string", enum: calls }, input: { type: "object" } }, ["call"]);
    ctx.tool("records.serve", { effect: "read", internal: true, callers: ["module"], description: "A team member's reads of the team's records (me, actors, types, list, get, events, history, stats, busy, roles.summary, roles, holders, and the audit for an owner or an admin), as that member, in that Space. Only the daemon's member door runs it.", input: serveInput(READS), run: serve(READS) });
    ctx.tool("records.serve-create", { effect: "write", internal: true, callers: ["module"], description: "A team member makes a record of a type, as that member, in that Space. Only the daemon's member door runs it.", input: serveInput(["create"]), run: serve(["create"]) });
    ctx.tool("records.serve-update", { effect: "write", internal: true, callers: ["module"], description: "A team member changes a record, as that member, in that Space: an update, a move, a relationship, her layout, a log, a role, her event's sharing, an undo, a removal to the bin or a restore (a stale base_version is refused); an owner's or an admin's field or link addition. Only the daemon's member door runs it.", input: serveInput(WRITES), run: serve(WRITES) });
    registerDevSeed(ctx, door, () => typeof ctx.devStandIn === "function" && ctx.devStandIn() === true);
    // the Space's profile photos that no profile names any more are removed now and then, under this module's own service chain (photo-sweep.js)
    const sweep = ctx.kernel && ctx.kernel.records && typeof ctx.kernel.serviceChain === "function" ? startPhotoSweep(ctx.kernel, (/** @type {string} */ m) => { if (typeof ctx.log === "function") ctx.log(m); }) : null;
    return { async stop() { if (sweep) sweep.stop(); } };
  },
};
