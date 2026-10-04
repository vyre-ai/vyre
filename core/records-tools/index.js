// @ts-check
// records: the app's Store calls over the kernel's gateway, one tool each (deck/ui/contracts.js maps a Store method to a kernel call; this registers it). Every tool runs under the caller's own
// chain in the Space it names (lib/gateway-door.js: a token's or the person's facts, never the body), so the kernel's grants, sealed fields and rooms decide each answer. A refusal is
// { error: { code, message } } with the kernel's own codes (not_found, version_conflict, sealed_value_refused, bad_input, denied).
import { createDoor } from "../../lib/gateway-door.js";
import { segments } from "../../kernel/core/urn.js";
import { registerDevSeed } from "./dev-seed.js";
import { kitLibrary, kitFromLibrary } from "../../records/kits/library.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device"];

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
    /** @typedef {{ space: string, gateway: any, surfaces: any, chain: any, proof: any }} Opened */
    /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: Opened) => Promise<any>} fn @param {(i: any) => any} [where] the Space a call acts in: the `space` it names, or the one its record reference names */
    /** The space a call acted in, named: its id and a plain label ("home" for the home's own space). A caller that wants a particular space passes `space`; with none the call acts in the home's own space, and says so here. @param {string} id */
    const actedIn = async id => {
      if (ctx.kernel && id === ctx.kernel.space) return { id, label: "home" };
      let r; try { r = /** @type {any} */ (await ctx.call("spaces.self", { person: ctx.kernel.owner, space: id })); } catch { r = null; }
      const name = r && r.data && r.data.space && r.data.space.name;
      return { id, label: typeof name === "string" ? name.replace(/\.vyre\.run$/, "") : null };
    };
    const tool = (name, description, input, fn, where = i => i) => ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const d = await door.open(where(i || {}), meta);
      const out = await fn(i || {}, d);
      // every answer names the space it acted in
      return out && typeof out === "object" && !Array.isArray(out) ? { ...out, acted_in: await actedIn(d.space) } : out;
    } });
    const byUrn = (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space });

    // Called by the spaces module when a Space is made: every Space already has its built-in store (the kernel opens one per hosted Space), so this answers at once and writes nothing. Twenty is
    // the store a Space asks for by name (VYRE_STORE), made by the stores layer at first use, never here.
    ctx.tool("records.workspace.create", {
      description: "Internal, for the spaces module: confirm a new Space has its store. The built-in store is always there.", input: obj({ space: str, name: str, store: str }, ["space"]), callers: ["module"],
      run: async (/** @type {any} */ i) => {
        if (i.store && i.store !== "builtin") throw refuse("that store is chosen when the Space is made; this one has the built-in store", "unavailable");
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
    // The kernel's own bookkeeping types (Flows' definitions, runs and approvals, goals) are `system: true` and left out of the default list, so Customize and Records show only the person's own.
    const SYSTEM_TYPES = new Set(["goal", "flow-approval", "flow-state", "flow-schedule", "flow-run"]);
    const isSystem = (/** @type {string} */ n) => SYSTEM_TYPES.has(n) || n.startsWith("def-") || n.startsWith("flow-");
    tool("records.types", "The record types of a Space, as defined (a type may carry kind: project). The kernel's own bookkeeping types are left out unless `system: true` is asked for, and then carry system: true.", obj({ space: str, system: { type: "boolean" } }), async (i, d) => {
      const all = (await d.gateway.definitions(d.chain)) || [];
      const withFlag = all.map((/** @type {any} */ t) => (isSystem(String(t.name)) ? { ...t, system: true } : t));
      return { types: i.system === true ? withFlag : withFlag.filter((/** @type {any} */ t) => !t.system) };
    });
    tool("records.define", "Add or change record types and their fields (a DefineDiff). The kernel decides who may.", obj({ space: str, diff: { type: "object" } }, ["diff"]), (i, d) => d.gateway.records.define(d.chain, i.diff));
    tool("records.list", "One page of records of a type: filter, sort, a cursor from the last page.", obj({ space: str, type: str, filter: {}, sort: { type: "array" }, cursor: str, limit: { type: "integer" } }, ["type"]), async (i, d) => {
      const limit = Number.isInteger(i.limit) ? Math.min(Math.max(i.limit, 1), 200) : 50;
      const r = await d.gateway.records.query(d.chain, String(i.type), { ...(i.filter ? { filter: i.filter } : {}), ...(Array.isArray(i.sort) ? { sort: i.sort } : {}), page: { limit, ...(i.cursor ? { cursor: String(i.cursor) } : {}) } });
      return { rows: r.rows, next_cursor: r.next_cursor || null };
    });
    tool("records.get", "One record by its reference, or null when it is not there or not yours to see.", obj({ urn: str }, ["urn"]), async (i, d) => {
      const u = parseUrn(i.urn);
      return { record: await d.gateway.records.get(d.chain, u.type, u.id) };
    }, byUrn);
    tool("records.create", "Make a record of a type.", obj({ space: str, type: str, data: { type: "object" } }, ["type", "data"]), async (i, d) => ({ record: await d.gateway.records.create(d.chain, String(i.type), i.data) }));
    tool("records.update", "Change a record's fields; a stale base_version is refused (version_conflict).", obj({ urn: str, patch: { type: "object" }, base_version: { type: "integer" } }, ["urn", "patch", "base_version"]), async (i, d) => {
      const u = parseUrn(i.urn);
      return { record: await d.gateway.records.update(d.chain, u.type, u.id, i.patch, i.base_version) };
    }, byUrn);

    // ---- what links to a record, and the Kits this build ships ----
    tool("records.linked", "Everything that links to a record (the reverse of a link field), across types, only what the caller may read. `truncated` is true when more exist than `limit` (default 50, at most 200).", obj({ urn: str, type: str, field: str, limit: { type: "integer" } }, ["urn"]), async (i, d) => {
      parseUrn(i.urn);
      return d.gateway.records.linked(d.chain, String(i.urn), { ...(i.type ? { type: String(i.type) } : {}), ...(i.field ? { field: String(i.field) } : {}), ...(Number.isInteger(i.limit) ? { limit: i.limit } : {}) });
    }, byUrn);
    tool("records.kits.library", "The Kits this build ships, before anything is installed: id, name, version, a plain description and what each adds (types, templates, roles, flows, views, sealed fields).", obj({ space: str }), async () => ({ kits: kitLibrary() }));
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
      if (!rec) throw refuse("no such record", "not_found");
      const me = d.chain.hops[0].actor;
      const task = await d.gateway.ask.request(d.chain, { title: `Forget ${u.type} ${u.id.slice(0, 8)}?`, record: i.urn, doer: me, output: { kind: "decision" }, note: `Proposed: forget this record for good. It cannot be undone.${i.why ? ` Why: ${String(i.why).slice(0, 300)}` : ""}` });
      return { proposed: true, task: task.id, message: "Nothing was forgotten. The person has a task to decide it with their presence." };
    }, byUrn);

    // ---- sealed values and the event feed ----
    tool("records.seal-put", "Put a value into a record's sealed field. It goes straight to the sealing process and never rides the record; the record keeps only the reference. The person's own act.", obj({ urn: str, field: str, value: str, class: str }, ["urn", "field", "value"]), async (i, d) => {
      const u = parseUrn(i.urn);
      if (!d.gateway.seal) throw refuse("this Space has no sealing process", "unavailable");
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
      if (!cur) throw refuse("no such record", "not_found");
      return { record: await d.gateway.records.update(d.chain, u.type, u.id, { [String(i.field)]: ref }, cur.version) };
    }, byUrn);
    tool("records.reveal", "Show a sealed value to the person on their own screen, once. Human-only: the person's presence proof rides beside the request and the chain must be exactly one person.", obj({ urn: str, field: str, purpose: str }, ["urn", "field", "purpose"]), async (i, d) => {
      const u = parseUrn(i.urn);
      if (!d.gateway.seal) throw refuse("this Space has no sealing process", "unavailable");
      const rec = await d.gateway.records.get(d.chain, u.type, u.id);
      const v = rec && rec.data ? rec.data[String(i.field)] : undefined;
      if (!v || typeof v !== "object" || typeof v.ref !== "string") throw refuse("there is nothing sealed there to show", "not_found");
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
    registerDevSeed(ctx, door, () => typeof ctx.devStandIn === "function" && ctx.devStandIn() === true);
    return { async stop() {} };
  },
};
