// kernel/gateway/memory.js: a Space's own memory, written and read through the gateway (DESIGN-memory-layers, the Space layer).
// A fact is filed by a chain that holds `memory.file`, with the source it came from; it is read back by a chain that holds `memory.read`. Nothing here decides who may: every call asks
// `authorize` first, so a Space's agents write and read only where a grant of theirs says. A Space's facts live in that Space's store and answer only to that Space's chains: a source
// that names another Space is refused, and nothing is ever copied across Spaces. A fact keeps the labels of the chain that filed it (an assistant that read outside text files a fact
// labelled external), the source it came from, and who filed it, taken from the chain and never from the caller. The text is free text, so the event log carries only its hash.
import { createHash } from "node:crypto";
import { createGate } from "../core/gate.js";
import { isChain, isExactlyPerson } from "../core/chain.js";
import { mintUuid } from "../core/ids.js";
import { KernelError } from "../core/errors.js";

export const MEMORY_ACTIONS = Object.freeze([
  { action: "memory.file", resource_type: "memory", risk: "write", label: "file a fact", gloss: "Write a fact, with its source, into this Space's memory." },
  { action: "memory.read", resource_type: "memory", risk: "read", label: "read the Space's memory", gloss: "Search the facts this Space has filed." },
  { action: "memory.retire", resource_type: "memory", risk: "write", label: "retire a fact", gloss: "Take a fact out of use: its filer, or a person with the right." },
].map(a => Object.freeze(a)));

export const MEMORY_KINDS = Object.freeze(["fact", "decision", "policy", "note"]);
const TEXT_MAX = 2000, TOPICS_MAX = 8, TOPIC_MAX = 40, SOURCE_MAX = 300, SCAN_MAX = 500, LIMIT_MAX = 50;
/** The type a fact is kept as. Protected, so the records calls never read or write it: only this gateway does, after its own gate. */
export const MEMORY_FACT = Object.freeze({
  name: "memory_fact", label: "Memory fact", protected: true, system: true,
  fields: Object.freeze([
    { name: "text", kind: "text", label: "Fact", required: true }, { name: "source", kind: "text", label: "Source", required: true },
    { name: "kind", kind: "choice", label: "Kind", options: [...MEMORY_KINDS], required: true }, { name: "topics", kind: "text", label: "Topics (JSON)" },
    { name: "by", kind: "text", label: "Filed by", required: true }, { name: "filed_at", kind: "number", label: "Filed (ms)", required: true },
    { name: "key", kind: "text", label: "Content key", required: true }, { name: "state", kind: "choice", label: "State", options: ["active", "retired"], required: true },
    { name: "labels", kind: "text", label: "Labels (JSON)", required: true },
    // Where the fact lives (R031-08): "" for the whole Space, `project:<id>` for one project, `agent:<id>` for what an agent learned and takes with it to every project
    { name: "scope", kind: "text", label: "Scope" },
  ]),
});

/**
 * @param {{ space: string, store: any, authorizer: any, log: any, clock?: () => number, enforce?: (chain: any, d: any) => void }} cfg
 */
export function createMemoryGateway(cfg) {
  const { gate, check } = createGate({ authorizer: cfg.authorizer, log: cfg.log, enforce: cfg.enforce });
  const clock = cfg.clock || Date.now;
  const urn = (/** @type {string} */ id) => `vyre://${cfg.space}/memory/${id}`;
  const actorOf = (/** @type {any} */ chain) => { const a = chain.hops[chain.hops.length - 1].actor; return `${a.kind}:${a.id}`; };
  const mustChain = (/** @type {any} */ c) => { if (!isChain(c)) throw new KernelError("bad_input", "a call needs a kernel-built chain"); };
  const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex");
  let defined = false;
  const ready = async () => {
    if (defined) return;
    const have = typeof cfg.store.types === "function" ? (await cfg.store.types()).find((/** @type {any} */ t) => t.name === MEMORY_FACT.name) : null;
    await cfg.store.define(have ? (have.fields.some((/** @type {any} */ x) => x.name === "scope") ? { add_types: [MEMORY_FACT] } : { change_types: [MEMORY_FACT] }) : { add_types: [MEMORY_FACT] });
    defined = true;
  };
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ data, /** @type {any} */ decision) => {
    try { cfg.log.append(chain, { type, sv: 1, subject, data, vis: "space", red: "internal" }, decision ? { decision } : {}); } catch { /* the act stands; the note is best effort */ }
  };
  const shape = (/** @type {any} */ r) => Object.freeze({ id: r.id, urn: urn(r.id), text: r.data.text, source: r.data.source, kind: r.data.kind, topics: JSON.parse(r.data.topics || "[]"), by: r.data.by,
    filed_at: r.data.filed_at, state: r.data.state, labels: JSON.parse(r.data.labels), scope: r.data.scope || "" });
  /** The agent a chain works as: its first agent hop, or null. @param {any} chain */
  const agentOf = (chain) => { const h = chain.hops.find((/** @type {any} */ x) => x.actor.kind === "agent"); return h ? String(h.actor.id) : null; };
  const projectUrn = (/** @type {string} */ id) => `vyre://${cfg.space}/project/${id}`;

  /** The source a fact names: a record, task or file of THIS Space the filer may read, or an opaque session or thread reference. */
  async function checkSource(/** @type {any} */ chain, /** @type {any} */ source) {
    if (typeof source !== "string" || !source.trim() || source.length > SOURCE_MAX) throw new KernelError("bad_input", "a fact needs its source: a record of this Space, or a session or thread");
    if (source.startsWith("vyre://")) {
      const m = /^vyre:\/\/([^/\s]+)\/([a-z][a-z0-9_-]{0,63})\/([A-Za-z0-9_.-]{1,200})$/.exec(source);
      if (!m) throw new KernelError("bad_input", "that source is not a record reference");
      if (m[1] !== cfg.space) throw new KernelError("bad_input", "a fact's source is in this Space: nothing crosses Spaces");
      // What the filer may not read cannot be filed as a fact about it: a fact would carry it out.
      const action = m[2] === "task" ? "tasks.read" : "records.read";
      if (!(await check(chain, action, source))) throw new KernelError("not_found", "no such source");
      return source;
    }
    if (!/^(session|thread|chat):[A-Za-z0-9_.#-]{1,120}$/.test(source)) throw new KernelError("bad_input", "a source is a record of this Space, or session:<id>, thread:<id> or chat:<id>");
    return source;
  }

  return Object.freeze({
    /**
     * File a fact into this Space's memory. Returns the fact; the same text from the same source filed twice is one fact (the first is returned, `existing: true`).
     * @param {any} chain @param {{ text: string, source: string, kind?: string, topics?: string[], scope?: string }} f (`scope`: "agent" keeps it with the agent across projects, "project:<id>" in one project it may reach; none is the whole Space)
     */
    async file(chain, f) {
      mustChain(chain);
      if (chain.space !== cfg.space) throw new KernelError("not_found", "no such record");
      const d = await gate(chain, "memory.file", urn("new"));
      if (!f || typeof f !== "object") throw new KernelError("bad_input", "a fact is an object");
      for (const k of Object.keys(f)) if (!["text", "source", "kind", "topics", "scope"].includes(k)) throw new KernelError("bad_input", `a fact has no ${k}: who filed it and when are the kernel's`);
      const text = typeof f.text === "string" ? f.text.trim() : "";
      if (!text || text.length > TEXT_MAX) throw new KernelError("bad_input", `a fact is text of 1 to ${TEXT_MAX} characters`);
      // A placeholder is how a sealed or room-hidden value is named; a fact is a statement, so one that carries a token would act as an instruction to fill it.
      if (/\{\{(field|sealed):/.test(text)) throw new KernelError("bad_input", "a fact does not carry a placeholder: name the record in its source");
      const kind = f.kind === undefined ? "fact" : f.kind;
      if (!MEMORY_KINDS.includes(kind)) throw new KernelError("bad_input", `kind is one of ${MEMORY_KINDS.join(", ")}`);
      const topics = f.topics === undefined ? [] : f.topics;
      if (!Array.isArray(topics) || topics.length > TOPICS_MAX || topics.some((/** @type {any} */ t) => typeof t !== "string" || !t.trim() || t.length > TOPIC_MAX)) throw new KernelError("bad_input", `topics are up to ${TOPICS_MAX} short words`);
      const source = await checkSource(chain, f.source);
      let scope = "";
      if (f.scope !== undefined) {
        const m = typeof f.scope === "string" ? /^project:([A-Za-z0-9_-]{1,64})$/.exec(f.scope) : null;
        if (f.scope === "agent") { const a = agentOf(chain); if (!a) throw new KernelError("bad_input", "only an agent has a scope of its own: name a project, or leave the scope out"); scope = `agent:${a}`; }
        else if (m) { if (!(await check(chain, "project.reach", projectUrn(m[1])))) throw new KernelError("not_found", "no such record"); scope = `project:${m[1]}`; }
        else throw new KernelError("bad_input", 'scope is "agent" or "project:<id>"');
      }
      await ready();
      const key = sha(`${scope}\u0000${source}\u0000${text}`);
      const have = (await cfg.store.query("memory_fact", { filter: { and: [{ field: "key", op: "eq", value: key }, { field: "state", op: "eq", value: "active" }] }, page: { limit: 1 } })).rows[0];
      if (have) return Object.freeze({ ...shape(have), existing: true });
      const id = mintUuid(clock());
      const labels = { trust: chain.labels.trust, red: chain.labels.red, source_spaces: [...chain.labels.source_spaces] };
      const rec = await cfg.store.create("memory_fact", id, { text, source, kind, topics: JSON.stringify([...new Set(topics.map((/** @type {string} */ t) => t.trim().toLowerCase()))]), by: actorOf(chain), filed_at: clock(), key, state: "active", labels: JSON.stringify(labels), scope });
      note(chain, "memory.filed", urn(id), { id, source, kind, topics, text_hash: sha(text) }, d.decision);
      return Object.freeze({ ...shape(rec), existing: false });
    },

    /**
     * The facts this chain may read (an empty list when it may read none), newest first, optionally narrowed by words in the text, a topic, a kind or a source. Each fact is asked about on its own (`memory.read` on its
     * reference), so a grant narrowed to some facts shows only those, and one the chain may not read is absent, never marked.
     * @param {any} chain @param {{ q?: string, topic?: string, kind?: string, source?: string, limit?: number, project?: string }} [o]
     * A fact with a scope is read only where it belongs: an agent's own, from that agent's chain, in every project; a project's, only by a chain working in that project (the model slot's project, else `project`) that may reach it.
     */
    async recall(chain, o = {}) {
      mustChain(chain);
      if (chain.space !== cfg.space) throw new KernelError("not_found", "no such record");
      // A grant for the whole memory answers at once; one narrowed to some facts is found by asking about each fact below. A chain with neither sees nothing, as a chain with no access always does.
      const d = await check(chain, "memory.read", `vyre://${cfg.space}/memory/*`);
      await ready();
      const limit = Math.min(Math.max(Number.isInteger(o.limit) ? /** @type {number} */ (o.limit) : 20, 1), LIMIT_MAX);
      const q = typeof o.q === "string" ? o.q.trim().toLowerCase() : "";
      const topic = typeof o.topic === "string" ? o.topic.trim().toLowerCase() : "";
      const rows = (await cfg.store.query("memory_fact", { filter: { field: "state", op: "eq", value: "active" }, sort: [{ field: "filed_at", dir: "desc" }], page: { limit: SCAN_MAX } })).rows;
      const me = agentOf(chain), here = typeof chain.project === "string" ? chain.project : (typeof o.project === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.project) ? o.project : null);
      const mayHere = here ? await check(chain, "project.reach", projectUrn(here)) : false;
      /** @type {any[]} */ const out = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        const f = shape(r);
        if (f.scope.startsWith("agent:") && f.scope !== `agent:${me}`) continue;
        if (f.scope.startsWith("project:") && !(mayHere && f.scope === `project:${here}`)) continue;
        if (o.kind && f.kind !== o.kind) continue;
        if (o.source && f.source !== o.source) continue;
        if (topic && !f.topics.includes(topic)) continue;
        if (q && !q.split(/\s+/).every((/** @type {string} */ w) => f.text.toLowerCase().includes(w))) continue;
        if (!(await check(chain, "memory.read", f.urn))) continue;
        out.push(f);
      }
      if (out.length) note(chain, "memory.recalled", `vyre://${cfg.space}/memory/*`, { returned: out.length, ...(topic ? { topic } : {}) }, d ? d.decision : undefined);
      return out;
    },

    /** Take a fact out of use: its filer, or a person (exactly one person in the chain) who holds the right. The fact stays in the store, retired, with its source. @param {any} chain @param {string} id */
    async retire(chain, id) {
      mustChain(chain);
      if (chain.space !== cfg.space) throw new KernelError("not_found", "no such record");
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new KernelError("bad_input", "name a fact");
      const d = await gate(chain, "memory.retire", urn(id));
      await ready();
      const r = await cfg.store.get("memory_fact", id);
      if (!r || r.data.state !== "active") throw new KernelError("not_found", "no such record");
      if (r.data.by !== actorOf(chain) && !isExactlyPerson(chain)) throw new KernelError("not_allowed", "only the one who filed a fact, or a person, retires it");
      const n = await cfg.store.update("memory_fact", id, { state: "retired" }, r.version);
      note(chain, "memory.retired", urn(id), { id }, d.decision);
      return shape(n);
    },
  });
}
