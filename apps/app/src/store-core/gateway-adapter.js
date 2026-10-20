// @ts-check
// store-core/gateway-adapter (moved from the old Deck's ui/gateway-adapter): the Store (contracts.js) over a real vyred. Every Store method is ONE tool call on the person's own vyred, made through the
// `rpc` it is given (the app's client: reads now, writes in the outbox, human-only calls with a presence proof in the x-vyre-presence header). The adapter
// holds no authority and builds no chain: the daemon builds the Chain from the call's own session, never from the body (CHAT.md, "how the app reaches the
// kernel's gateway from a device"). Names follow that proposal; platform's final list replaces TOOLS below and nothing else.
//
//   rpc.read(tool, input)                 -> data, or throws Error{code,message}
//   rpc.write(tool, input, { proof? })    -> data, or throws Error{code,message}; `proof` is the PresenceProof of a human-only call, which the rpc turns into the header
//   rpc.events(onEvent)                   -> stop(); calls back for every event the vyred follows (the stream)

import { placeTag, spaceName } from "../state/space-name.js";

/** @typedef {import("./contracts.js").Store} Store */

/** The tool names, one place: platform's list (team/0.2/CHAT.md, "the gateway tools for the app"). `space` is optional on each (absent = the home's own). */
export const TOOLS = {
  me: "records.me", spaceList: "spaces.list", actors: "records.actors", types: "records.types", define: "records.define",
  list: "records.list", get: "records.get", create: "records.create", update: "records.update",
  seesAs: "records.sees-as", sealPut: "records.seal-put", reveal: "records.reveal", events: "records.events", fieldSeal: "records.field.seal",
  tasks: "tasks.list", task: "tasks.get", request: "tasks.request", decide: "tasks.decide", move: "tasks.move", submit: "tasks.submit", review: "tasks.review",
};

/**
 * An actor the kernel knows only by its id reads as a word, never as the id: "You" for the signed-in person, "Someone" for another person, "An assistant" or "An agent" for the rest. An actor with
 * a name keeps it. @param {any[]} actors @param {string} me
 */
export function readableActors(actors, me) {
  return actors.map((a) => {
    if (!a || typeof a !== "object") return a;
    const id = String(a.id ?? "");
    const named = typeof a.name === "string" && a.name.trim() !== "" && a.name !== id;
    if (named) return a;
    return { ...a, name: a.family === "person" || !a.family ? (me && id === me ? "You" : "Someone") : a.family === "assistant" ? "An agent" : "An agent" };
  });
}

/** A tool answer that may be the thing itself or wrapped one level ({record}, {task}, {field}): the platform has not frozen the wrapping, so read both. @param {any} d @param {string} k */
const one = (d, k) => (d && typeof d === "object" && k in d ? d[k] : d);
/** The rows of a page. @param {any} d */
const rowsOf = (d) => (Array.isArray(d) ? d : d?.rows ?? d?.tasks ?? d?.records ?? d?.items ?? []);

/**
 * What a box event says changed: a record event (`contact.updated`, the kernel's `<type>.<verb>` for every record write) names its type; a records, types or members event may
 * change anything; any other event (a chat, an agent at work) may not touch records at all, so a reader waits a moment and reads once for the burst.
 * @param {any} e @returns {import("./contracts.js").ChangeHint | undefined}
 */
export function eventHint(e) {
  const t = String((e && e.type) || "");
  const m = /^([a-z][a-z0-9_-]*)\.(created|updated|removed|restored)$/.exec(t);
  if (m && !["records", "types", "members", "grants", "spaces"].includes(m[1])) return { type: m[1] };
  if (/^(records|types|members|grants|spaces)\./.test(t)) return undefined;
  return { soon: true };
}

/** The page a list asks for: records.list's largest. */
export const LIST_PAGE = 200;

/** The StoreError codes the screens know. */
const CODES = new Set(["version_conflict", "not_found", "sealed_value_refused", "invalid"]);

/** @param {string} urn @returns {{ space: string, type: string, id: string }} */
export function parseUrn(urn) {
  const m = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(String(urn));
  if (!m) throw Object.assign(new Error(`That is not a record address: ${urn}`), { code: "invalid" });
  return { space: m[1], type: m[2], id: m[3] };
}

/**
 * @param {{ rpc: { read(tool: string, input?: any): Promise<any>, write(tool: string, input?: any, o?: { proof?: any }): Promise<any>, events?(on: (e: any) => void): () => void } }} deps
 * @returns {Store}
 */
export function createGatewayStore({ rpc }) {
  /** @type {Set<(hint?: import("./contracts.js").ChangeHint) => void>} */ const subs = new Set();
  /** @type {null | (() => void)} */ let stop = null;
  // Inside a batch (an import of many rows) nothing is told until the end, and then once.
  let quiet = 0, held = false;
  const notify = (/** @type {import("./contracts.js").ChangeHint | undefined} */ hint = undefined) => {
    if (quiet) { held = true; return; }
    for (const f of [...subs]) { try { f(hint); } catch { /* a screen's redraw must not stop the others */ } }
  };
  /** The record type a reference names, for the change hint; undefined when it is not a reference. @param {string} urn */
  const typeOf = (urn) => { try { return { type: parseUrn(urn).type }; } catch { return undefined; } };
  /** @type {any | null} */ let meCache = null;
  const meAnswer = async () => (meCache ??= await rpc.read(TOOLS.me, {}));
  const meId = async () => { const p = (await meAnswer())?.person; return typeof p === "string" ? p : p?.id ?? ""; };
  /** The spaces on this Vyre, named by spaces.list (windows' tool); records.me names the home's own space, which is added when the list does not have it. */
  const spaces = async () => {
    const d = await meAnswer();
    const listed = await rpc.read(TOOLS.spaceList, {}).catch(() => []);
    /** @type {any[]} */ const out = (Array.isArray(listed) ? listed : listed?.spaces ?? []).filter((/** @type {any} */ x) => !x.status || x.status === "done")
      .map((/** @type {any} */ x) => ({ id: x.id, name: spaceName(x), tag: placeTag(x), kind: x.role === "owner" ? "mine" : "team" }));
    const own = d?.space ?? d?.spaces?.[0]?.id;
    if (Array.isArray(d?.spaces) && d.spaces.length) return d.spaces;
    if (own && !out.some((x) => x.id === own)) out.unshift({ id: own, name: "Home", kind: "mine" });
    return out;
  };
  /** A write, then the screens redraw from the store. */
  const write = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ o = undefined, /** @type {import("./contracts.js").ChangeHint | undefined} */ hint = undefined) => { const d = await rpc.write(tool, input, o); notify(hint); return d; };
  /** The Space-optional input: only name a space when the screen did. */
  const sp = (/** @type {any} */ space) => (space ? { space } : {});
  const types = async (/** @type {string | undefined} */ space) => { const d = await rpc.read(TOOLS.types, sp(space)); return Array.isArray(d) ? d : d?.types ?? []; };
  /** A definition change for one type, as records.define's diff. @param {string} type @param {(t: any) => any} change */
  const changeType = async (type, change) => {
    const t = (await types(undefined)).find((/** @type {any} */ x) => x.name === type);
    if (!t) throw Object.assign(new Error(`There is no record type "${type}".`), { code: "not_found" });
    const next = change(structuredClone(t));
    await write(TOOLS.define, { diff: { change_types: [next] } });
    return next;
  };

  return {
    spaces,
    actors: async () => { const d = await rpc.read(TOOLS.actors, {}); return readableActors(Array.isArray(d) ? d : d?.actors ?? [], await meId()); },
    types,
    async list(type, q = {}) {
      /** @type {any[]} */ const out = [];
      let cursor;
      do {
        // the largest page records.list gives (200): a long type is read in a quarter of the round trips the default page of 50 took, each one a wait on the box and its store
        const d = await rpc.read(TOOLS.list, { ...sp(q.space), type, ...(q.filter ? { filter: q.filter } : {}), ...(q.sort ? { sort: q.sort } : {}), limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
        out.push(...rowsOf(d));
        cursor = d?.next_cursor;
      } while (cursor);
      return out;
    },
    async get(urn) { const d = await rpc.read(TOOLS.get, { urn }); const r = one(d, "record"); return r && typeof r === "object" ? r : null; },
    // a record write tells which type changed, so a list re-reads that type and not every type
    async create(type, data, opts = {}) { return one(await write(TOOLS.create, { ...sp(opts.space), type, data, ...(opts.why ? { why: opts.why } : {}) }, undefined, { type }), "record"); },
    async update(urn, patch, base_version) { return one(await write(TOOLS.update, { urn, patch, base_version }, undefined, typeOf(urn)), "record"); },
    async putSealed(urn, field, value) { return one(await write(TOOLS.sealPut, { urn, field, value }, undefined, typeOf(urn)), "record"); },
    async batch(work) {
      quiet++;
      try { return await work(); } finally { quiet--; if (!quiet && held) { held = false; notify(); } }
    },
    // Human-only: the proof rides in the header, never the body.
    async reveal(urn, field, purpose, proof) { return await rpc.write(TOOLS.reveal, { urn, field, purpose }, { proof }); },
    async seesAs(urn, who) { const d = await rpc.read(TOOLS.seesAs, { urn, who }); return d?.data ?? d?.fields ?? d ?? {}; },
    async tasks(q = {}) { return rowsOf(await rpc.read(TOOLS.tasks, q)).map((/** @type {any} */ t) => t); },
    async task(id) { const d = await rpc.read(TOOLS.task, { id }); const t = one(d, "task"); return t && typeof t === "object" ? t : null; },
    async request(task) { return one(await write(TOOLS.request, { task }), "task"); },
    async decide(id, approval) {
      const { proof, ...rest } = approval;
      return one(await write(TOOLS.decide, { id, ...rest }, { proof }), "task");
    },
    // The kernel lets a doer hand in only what it has started (ready -> working -> done). A person pressing Mark done on a task that is still ready means both, so the start is made here.
    async submit(id, evidence) {
      const cur = one(await rpc.read(TOOLS.task, { id }), "task");
      if (cur && typeof cur === "object" && cur.state === "ready") await write(TOOLS.move, { id, to: "working" });
      return one(await write(TOOLS.submit, { id, evidence }), "task");
    },
    // The reviewer's pass or request for changes, with the checklist and a note. A pass sends nothing; the approver decides.
    async review(id, input) { return one(await write(TOOLS.review, { id, ...input }), "task"); },
    // The daemon derives the transition (start, stuck, skip, fix) from the kernel's own rules: the screen names where it wants to go.
    async move(id, to, _by, o = {}) { return one(await write(TOOLS.move, { id, to, ...o }), "task"); },
    async reassign() { throw Object.assign(new Error("Reassigning a task is not available on this Vyre yet."), { code: "invalid" }); },
    async editTask() { throw Object.assign(new Error("Editing a task is not available on this Vyre yet."), { code: "invalid" }); },
    async events(q = {}) { const d = await rpc.read(TOOLS.events, q); return Array.isArray(d) ? d : d?.events ?? []; },
    async define(diff) { return await write(TOOLS.define, { diff }); },
    // Adding a field is a definition change on the type. Sealing one is not: it is the kernel's own migration (records.field.seal), which moves every value into a sealed field and scrubs the old ones.
    async addField(type, spec) {
      /** @type {any} */ let made;
      await changeType(type, (t) => {
        let name = String(spec.label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
        const base = name; let n = 2;
        while (t.fields.some((/** @type {any} */ f) => f.name === name)) name = `${base}_${n++}`;
        made = { name, label: spec.label, kind: spec.kind, ...(spec.to ? { to: spec.to } : {}), ...(spec.options ? { options: spec.options } : {}), ...(spec.kind === "sealed" ? { seal: { level: "ai", class: "free" } } : {}) };
        t.fields.push(made);
        return t;
      });
      return made;
    },
    // The space is the record's own (the page names it): the migration acts on that space's type, whichever space is showing.
    async sealField(type, field, space) {
      const d = await write(TOOLS.fieldSeal, { ...sp(space), type, field });
      return d && typeof d.sealed_field === "string" ? { name: d.sealed_field, label: field, kind: "sealed" } : undefined;
    },
    subscribe(fn) {
      subs.add(fn);
      if (!stop && rpc.events) stop = rpc.events((e) => { meCache = null; notify(eventHint(e)); });
      return () => { subs.delete(fn); if (!subs.size && stop) { stop(); stop = null; } };
    },
    me: meId,
  };
}

/** A tool's {error} answer as the Error the screens expect: a StoreError code where the vyred gave one, else "invalid" with its own words. @param {any} e */
export function storeError(e) {
  const code = CODES.has(e?.code) ? e.code : "invalid";
  // A hosted space whose home has not yet been given the person's session answers needs_presence to a plain read (UX-34): that is not something the person can act on here.
  if (e?.code === "needs_presence") return Object.assign(new Error("This space is still being set up. It opens when its home answers."), { code });
  return Object.assign(new Error(String(e?.message || "That did not work.")), { code });
}
