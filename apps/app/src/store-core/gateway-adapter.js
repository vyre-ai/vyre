// @ts-check
// store-core/gateway-adapter (moved from the old Deck's ui/gateway-adapter): the Store (contracts.js) over a real vyred. Every Store method is ONE tool call on the person's own vyred, made through the
// `rpc` it is given (the app's client: reads now, writes in the outbox, human-only calls with a presence proof in the x-vyre-presence header). The adapter
// holds no authority and builds no chain: the daemon builds the Chain from the call's own session, never from the body (CHAT.md, "how the app reaches the
// kernel's gateway from a device"). Names follow that proposal; platform's final list replaces TOOLS below and nothing else.
//
//   rpc.read(tool, input)                 -> data, or throws Error{code,message}
//   rpc.write(tool, input, { proof? })    -> data, or throws Error{code,message}; `proof` is the PresenceProof of a human-only call, which the rpc turns into the header
//   rpc.events(onEvent)                   -> stop(); calls back for every event the vyred follows (the stream)

import { spaceName } from "../state/space-name.js";

/** @typedef {import("./contracts.js").Store} Store */

/** The tool names, one place: platform's list (team/0.2/CHAT.md, "the gateway tools for the app"). `space` is optional on each (absent = the home's own). */
export const TOOLS = {
  me: "records.me", spaceList: "spaces.list", actors: "records.actors", types: "records.types", define: "records.define",
  list: "records.list", get: "records.get", create: "records.create", update: "records.update",
  seesAs: "records.sees-as", sealPut: "records.seal-put", reveal: "records.reveal", events: "records.events",
  tasks: "tasks.list", task: "tasks.get", request: "tasks.request", decide: "tasks.decide", move: "tasks.move", submit: "tasks.submit",
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
    return { ...a, name: a.family === "person" || !a.family ? (me && id === me ? "You" : "Someone") : a.family === "assistant" ? "An assistant" : "An agent" };
  });
}

/** A tool answer that may be the thing itself or wrapped one level ({record}, {task}, {field}): the platform has not frozen the wrapping, so read both. @param {any} d @param {string} k */
const one = (d, k) => (d && typeof d === "object" && k in d ? d[k] : d);
/** The rows of a page. @param {any} d */
const rowsOf = (d) => (Array.isArray(d) ? d : d?.rows ?? d?.tasks ?? d?.records ?? d?.items ?? []);

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
  /** @type {Set<() => void>} */ const subs = new Set();
  /** @type {null | (() => void)} */ let stop = null;
  const notify = () => { for (const f of [...subs]) { try { f(); } catch { /* a screen's redraw must not stop the others */ } } };
  /** @type {any | null} */ let meCache = null;
  const meAnswer = async () => (meCache ??= await rpc.read(TOOLS.me, {}));
  const meId = async () => { const p = (await meAnswer())?.person; return typeof p === "string" ? p : p?.id ?? ""; };
  /** The spaces on this Vyre, named by spaces.list (windows' tool); records.me names the home's own space, which is added when the list does not have it. */
  const spaces = async () => {
    const d = await meAnswer();
    const listed = await rpc.read(TOOLS.spaceList, {}).catch(() => []);
    /** @type {any[]} */ const out = (Array.isArray(listed) ? listed : listed?.spaces ?? []).filter((/** @type {any} */ x) => !x.status || x.status === "done")
      .map((/** @type {any} */ x) => ({ id: x.id, name: spaceName(x), kind: x.role === "owner" ? "mine" : "team" }));
    const own = d?.space ?? d?.spaces?.[0]?.id;
    if (Array.isArray(d?.spaces) && d.spaces.length) return d.spaces;
    if (own && !out.some((x) => x.id === own)) out.unshift({ id: own, name: "Home", kind: "mine" });
    return out;
  };
  /** A write, then the screens redraw from the store. */
  const write = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ o = undefined) => { const d = await rpc.write(tool, input, o); notify(); return d; };
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
        const d = await rpc.read(TOOLS.list, { ...sp(q.space), type, ...(q.filter ? { filter: q.filter } : {}), ...(q.sort ? { sort: q.sort } : {}), ...(cursor ? { cursor } : {}) });
        out.push(...rowsOf(d));
        cursor = d?.next_cursor;
      } while (cursor);
      return out;
    },
    async get(urn) { const d = await rpc.read(TOOLS.get, { urn }); const r = one(d, "record"); return r && typeof r === "object" ? r : null; },
    async create(type, data, opts = {}) { return one(await write(TOOLS.create, { ...sp(opts.space), type, data, ...(opts.why ? { why: opts.why } : {}) }), "record"); },
    async update(urn, patch, base_version) { return one(await write(TOOLS.update, { urn, patch, base_version }), "record"); },
    async putSealed(urn, field, value) { return one(await write(TOOLS.sealPut, { urn, field, value }), "record"); },
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
    // The daemon derives the transition (start, stuck, skip, fix) from the kernel's own rules: the screen names where it wants to go.
    async move(id, to, _by, o = {}) { return one(await write(TOOLS.move, { id, to, ...o }), "task"); },
    async reassign() { throw Object.assign(new Error("Reassigning a task is not available on this Vyre yet."), { code: "invalid" }); },
    async editTask() { throw Object.assign(new Error("Editing a task is not available on this Vyre yet."), { code: "invalid" }); },
    async events(q = {}) { const d = await rpc.read(TOOLS.events, q); return Array.isArray(d) ? d : d?.events ?? []; },
    async define(diff) { return await write(TOOLS.define, { diff }); },
    // Customize is a definition change: the field is added to, or sealed in, the type's own definition.
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
    async sealField(type, field) {
      /** @type {any} */ let sealed;
      await changeType(type, (t) => { const f = t.fields.find((/** @type {any} */ x) => x.name === field); if (f) { f.seal = f.seal || { level: "ai", class: "free" }; sealed = f; } return t; });
      return sealed;
    },
    subscribe(fn) {
      subs.add(fn);
      if (!stop && rpc.events) stop = rpc.events(() => { meCache = null; notify(); });
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
