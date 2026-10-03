// @ts-check
// deck/ui/gateway-adapter: the Store (contracts.js) over a real vyred. Every Store method is ONE tool call on the person's own vyred, made through the
// `rpc` it is given (the app's client: reads now, writes in the outbox, human-only calls with a presence proof in the x-vyre-presence header). The adapter
// holds no authority and builds no chain: the daemon builds the Chain from the call's own session, never from the body (CHAT.md, "how the app reaches the
// kernel's gateway from a device"). Names follow that proposal; platform's final list replaces TOOLS below and nothing else.
//
//   rpc.read(tool, input)                 -> data, or throws Error{code,message}
//   rpc.write(tool, input, { proof? })    -> data, or throws Error{code,message}; `proof` is the PresenceProof of a human-only call, which the rpc turns into the header
//   rpc.events(onEvent)                   -> stop(); calls back for every event the vyred follows (the stream)

/** @typedef {import("./contracts.js").Store} Store */

/** The tool names, one place. */
export const TOOLS = {
  spaces: "spaces.list", actors: "actors.list", me: "me", types: "types.list",
  list: "records.list", get: "records.get", create: "records.create", update: "records.update",
  seesAs: "records.sees_as", sealPut: "records.seal_put", reveal: "records.reveal",
  tasks: "tasks.list", task: "tasks.get", request: "tasks.request", decide: "tasks.decide", submit: "tasks.submit",
  move: "tasks.move", reassign: "tasks.reassign", editTask: "tasks.edit",
  events: "events.list", define: "define", calendar: "calendar.list",
};

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
  /** @type {any[] | null} */ let spaceList = null;
  const spaces = async () => (spaceList ??= (await rpc.read(TOOLS.spaces, {}))?.spaces ?? []);
  const home = async (/** @type {string | undefined} */ s) => s ?? (await spaces())[0]?.id;
  /** A write, then the screens redraw from the store. */
  const write = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ o = undefined) => { const d = await rpc.write(tool, input, o); notify(); return d; };

  return {
    spaces,
    actors: async () => (await rpc.read(TOOLS.actors, {}))?.actors ?? [],
    types: async (space) => (await rpc.read(TOOLS.types, { space: await home(space) }))?.types ?? [],
    async list(type, q = {}) {
      /** @type {any[]} */ const out = [];
      const space = q.space;
      let cursor;
      do {
        const d = await rpc.read(TOOLS.list, { space, type, ...(q.filter ? { filter: q.filter } : {}), ...(q.sort ? { sort: q.sort } : {}), ...(cursor ? { cursor } : {}) });
        out.push(...(d?.rows ?? []));
        cursor = d?.next_cursor;
      } while (cursor);
      return out;
    },
    async get(urn) { return (await rpc.read(TOOLS.get, { urn }))?.record ?? null; },
    async create(type, data, opts = {}) { return (await write(TOOLS.create, { space: await home(opts.space), type, data, ...(opts.why ? { why: opts.why } : {}) })).record; },
    async update(urn, patch, base_version) { return (await write(TOOLS.update, { urn, patch, base_version })).record; },
    async putSealed(urn, field, value) { return (await write(TOOLS.sealPut, { urn, field, value })).record; },
    // Human-only: the proof rides in the header, never the body.
    async reveal(urn, field, purpose, proof) { return await rpc.write(TOOLS.reveal, { urn, field, purpose }, { proof }); },
    async seesAs(urn, who) { return (await rpc.read(TOOLS.seesAs, { urn, who }))?.fields ?? {}; },
    async tasks(q = {}) { return (await rpc.read(TOOLS.tasks, q))?.tasks ?? []; },
    async task(id) { return (await rpc.read(TOOLS.task, { id }))?.task ?? null; },
    async request(task) { return (await write(TOOLS.request, { task })).task; },
    async decide(id, approval) {
      const { proof, ...rest } = approval;
      return (await write(TOOLS.decide, { id, ...rest }, { proof })).task;
    },
    async submit(id, evidence) { return (await write(TOOLS.submit, { id, evidence })).task; },
    async move(id, to, _by, o = {}) { return (await write(TOOLS.move, { id, to, ...o })).task; },
    async reassign(id, doer) { return (await write(TOOLS.reassign, { id, doer })).task; },
    async editTask(id, patch) { return (await write(TOOLS.editTask, { id, patch })).task; },
    async events(q = {}) { return (await rpc.read(TOOLS.events, q))?.events ?? []; },
    async define(diff) { return await write(TOOLS.define, { diff }); },
    async addField(type, spec) { return (await write(TOOLS.define, { op: "add_field", type, spec })).field; },
    async sealField(type, field) { return (await write(TOOLS.define, { op: "seal_field", type, field })).field; },
    subscribe(fn) {
      subs.add(fn);
      if (!stop && rpc.events) stop = rpc.events(() => { spaceList = null; notify(); });
      return () => { subs.delete(fn); if (!subs.size && stop) { stop(); stop = null; } };
    },
    async me() { return (await rpc.read(TOOLS.me, {}))?.actor ?? ""; },
    async calendar(q) { return (await rpc.read(TOOLS.calendar, q ?? {}))?.events ?? []; },
  };
}

/** A tool's {error} answer as the Error the screens expect: a StoreError code where the vyred gave one, else "invalid" with its own words. @param {any} e */
export function storeError(e) {
  const code = CODES.has(e?.code) ? e.code : "invalid";
  return Object.assign(new Error(String(e?.message || "That did not work.")), { code });
}
