// @ts-check
// outside/mcp: the MCP an outside agent speaks (Streamable HTTP, one JSON-RPC message in a POST, a JSON answer), beside the Vault's. The bearer token names one registered agent; the tools are the few in
// lib/outside.js, and each is a thin call that the kernel decides under the agent's own chain, so the agent holds only what it was given. Pure of sockets: the listener, or a test, calls `handle`.
import { MCP_TOOLS, toolsFor, reachLine } from "../../lib/outside.js";

const PROTOCOL = "2025-06-18";
const FIELD_CHARS = 2000, LIST_MAX = 50, LIST_DEFAULT = 20, FILE_TEXT_MAX = 200 * 1024;
const TEXT_NAME = /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|html?|css|js|ts|py|sh|log|ini|env\.example)$/i;
const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });

/** A field value as an outsider may see it: a sealed or hidden value is a word, never the value. @param {any} v */
export function shown(v) {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.sealed === "string") return "[sealed]";
  if (typeof v === "string") return /^\{\{field:/.test(v) ? "[hidden]" : v.length > FIELD_CHARS ? `${v.slice(0, FIELD_CHARS)}...` : v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v).slice(0, FIELD_CHARS);
}

/** What a record is to an outsider: its address and its fields. @param {any} rec */
export const flat = rec => ({ urn: rec.urn, ...(rec.version !== undefined ? { version: rec.version } : {}), fields: Object.fromEntries(Object.entries(rec.data || {}).map(([k, v]) => [k, shown(v)])) });

/** Which needs an agent holds, from what it was given. @param {any[]} reach */
export function needsOf(reach) {
  const n = new Set();
  for (const r of reach) {
    if (r.kind === "records") { n.add("records.read"); if (r.spec.write) n.add("records.write"); }
    else if (r.kind === "memory") n.add("memory.read");
    else if (r.kind === "files") n.add("files.read");
  }
  return n;
}

/** The type and id a record address names, or why not. @param {unknown} urn */
export function parseRecord(urn) {
  const s = typeof urn === "string" && urn.startsWith("vyre://") ? urn.slice(7).split("/") : null;
  if (!s || s.length !== 3 || !s[1] || !s[2]) throw bad("give the record's address, such as vyre://<space>/client/<id>");
  return { type: s[1], id: s[2] };
}

/**
 * @param {{ store: ReturnType<typeof import("./store.js").openStore>, door: ReturnType<typeof import("../../lib/token-door.js").createDoor>, now: () => number, kernel: any,
 *   emit: (type: string, payload: any) => void, hold: (agent: any, tool: string, change: any) => Promise<{ held: string, summary: string }>, extra?: (agent: any) => Promise<{ tools: any[], call: (tool: string, args: any, source: string) => Promise<any> } | null>,
 *   refuse: (source: string, reason: string, agent?: string) => void, name?: string }} d
 */
export function createMcp(d) {
  const K = d.kernel;
  const chainOf = (/** @type {any} */ agent) => { if (!K || !K.outside) throw bad("this build has no kernel, so there is nothing for an outside agent to reach", "unavailable"); return K.outside.chain(agent.id); };
  const typesOf = (/** @type {any[]} */ reach) => [...new Set(reach.filter(r => r.kind === "records").flatMap(r => r.spec.types || []))];
  const writableTypes = (/** @type {any[]} */ reach) => [...new Set(reach.filter(r => r.kind === "records" && r.spec.write).flatMap(r => r.spec.types || []))];
  const projectOf = (/** @type {any[]} */ reach, /** @type {string} */ kind, /** @type {unknown} */ ref) => {
    const want = String(ref ?? "").trim().toLowerCase();
    for (const r of reach) if (r.kind === kind) for (const p of r.spec.projects || []) if ([p.id, p.slug, p.name].some((/** @type {any} */ x) => String(x || "").toLowerCase() === want)) return p;
    throw bad(`${String(ref ?? "").slice(0, 60)} is not a project you were given`, "not_found");
  };
  /** A refusal from the kernel, said in plain words and as "not found" so a record or type you may not read looks like one that is not there. @param {unknown} e @param {string} what */
  const unreadable = (e, what) => { const c = e && /** @type {any} */ (e).code; if (c === "not_allowed" || c === "not_found" || c === "denied") return bad(`${what} was not found for you`, "not_found"); return e; };

  /** One call of a tool, as the agent. @param {any} agent @param {string} tool @param {any} a */
  async function perform(agent, tool, a) {
    const reach = d.store.reach(agent.id);
    if (tool === "whoami") {
      return { name: agent.name, reach: reachLine(reach.map(r => ({ kind: r.kind, ...r.spec })), p => p), ends: agent.expires, tools: toolsFor(needsOf(reach)).map(t => t.name) };
    }
    const chain = chainOf(agent);
    if (tool === "records_types") return { types: reach.filter(r => r.kind === "records").flatMap(r => r.spec.defs || []) };
    if (tool === "records_list") {
      const type = String(a.type || "");
      if (!typesOf(reach).includes(type)) throw bad(`${type.slice(0, 60)} was not found for you`, "not_found");
      const limit = Number.isInteger(a.limit) ? Math.min(Math.max(a.limit, 1), LIST_MAX) : LIST_DEFAULT;
      let r;
      try { r = await K.records.query(chain, type, { ...(a.filter && typeof a.filter === "object" ? { filter: a.filter } : {}), page: { limit } }); } catch (e) { throw unreadable(e, type.slice(0, 60)); }
      return { records: (r.rows || []).map(flat), ...(r.next_cursor ? { more: true } : {}) };
    }
    if (tool === "records_get") {
      const { type, id } = parseRecord(a.urn);
      if (!typesOf(reach).includes(type)) throw bad("that record was not found for you", "not_found");
      let ref;
      try { ref = await K.records.reference(chain, type, id); } catch (e) { throw unreadable(e, "that record"); }
      if (!ref) throw bad("that record was not found for you", "not_found");
      return { urn: ref.urn, title: ref.title, fields: ref.fields.map((/** @type {any} */ f) => (f.placeholder ? { label: f.label, hidden: true } : { label: f.label, value: shown(f.value) })) };
    }
    if (tool === "memory_ask") {
      const p = projectOf(reach, "memory", a.project);
      const q = String(a.question || "").trim();
      if (!q) throw bad("ask a question");
      let facts;
      try { facts = await K.memory.recall(chain, { q, project: p.id, limit: 10 }); } catch (e) { throw unreadable(e, "that memory"); }
      return { project: p.name, facts: facts.map((/** @type {any} */ f) => ({ text: f.text, source: f.source, kind: f.kind })) };
    }
    if (tool === "files_read") {
      const p = projectOf(reach, "files", a.project);
      const rel = String(a.path || "").replace(/^\/+|\/+$/g, "");
      if (rel.split("/").some((/** @type {string} */ s) => s === ".." || s === ".")) throw bad("give a path inside the project's folder");
      const full = rel ? `${p.drive_path}/${rel}` : p.drive_path;
      // A project's folder also holds Vyre's own marker and the chats' private folders (chat/, made/): an outside agent is given the project's files, never those.
      if (/^(chat|made)(\/|$)/.test(rel) || rel.split("/").some((/** @type {string} */ seg) => seg.startsWith("."))) throw bad("that was not found for you", "not_found");
      let entries = [];
      try { entries = (await K.drive.list(chain, full)).filter((/** @type {any} */ e) => { const name = String(e.path ?? e.name ?? e).slice(p.drive_path.length).replace(/^\/+/, ""); return !/^(chat|made)\//.test(name) && !name.split("/").some((/** @type {string} */ seg) => seg.startsWith(".")); }); } catch (e) { throw unreadable(e, "that folder"); }
      if (entries.length && !(entries.length === 1 && String(entries[0].path ?? entries[0].name ?? entries[0]) === full)) {
        return { project: p.name, folder: rel || "/", files: entries.slice(0, 200).map((/** @type {any} */ e) => ({ name: String(e.path ?? e.name ?? e).slice(p.drive_path.length).replace(/^\/+/, ""), ...(e.size !== undefined ? { bytes: e.size } : {}) })) };
      }
      if (!rel) return { project: p.name, folder: "/", files: [] };
      let f;
      try { f = await K.drive.get(chain, full, { maxBytes: FILE_TEXT_MAX * 5 }); } catch (e) { throw unreadable(e, "that file"); }
      const bytes = f && (f.bytes || f.data || f);
      const len = bytes && bytes.length !== undefined ? bytes.length : 0;
      if (TEXT_NAME.test(rel) && len <= FILE_TEXT_MAX) return { project: p.name, file: rel, bytes: len, text: Buffer.from(bytes).toString("utf8") };
      return { project: p.name, file: rel, bytes: len, note: "this file is not text Vyre reads out; its name and size are all it gives" };
    }
    if (tool === "records_create" || tool === "records_update") {
      const type = tool === "records_create" ? String(a.type || "") : parseRecord(a.urn).type;
      if (!writableTypes(reach).includes(type)) throw bad(`${tool} needs the person to give you write access to ${type.slice(0, 60)} first`, "denied");
      if (!a.fields || typeof a.fields !== "object" || Array.isArray(a.fields) || !Object.keys(a.fields).length) throw bad("give the fields to set: { field: value }");
      const r = await d.hold(agent, tool, tool === "records_create" ? { type, fields: a.fields } : { type, urn: a.urn, fields: a.fields });
      return { held: r.held, message: `Waiting for the person to approve: ${r.summary}. Call held_get to see their answer.` };
    }
    if (tool === "held_get") {
      const h = d.store.held(String(a.held || ""));
      if (!h || h.agent !== agent.id) throw bad("that is not something you asked for", "not_found");
      return await d.heldState(h);
    }
    throw bad("unknown tool", "not_found");
  }

  /**
   * One HTTP request to the endpoint. @param {{ method: string, headers: Record<string, any>, body: string, source: string }} q
   * @returns {Promise<{ status: number, body?: any, headers?: Record<string, string> }>}
   */
  async function handle(q) {
    if (q.method !== "POST") return { status: 405 };
    const m = /^Bearer\s+(\S+)$/i.exec(String(q.headers.authorization || ""));
    const gate = d.door.admit(q.source);
    if (!gate.ok) { d.refuse(q.source, gate.why); return { status: gate.status }; }
    const agent = m ? d.store.byToken(m[1]) : null;
    if (!agent || agent.revoked || agent.expires <= d.now()) {
      d.door.miss(q.source);
      d.refuse(q.source, agent ? (agent.revoked ? "ended agent" : "expired agent") : "unknown token", agent ? agent.id : "");
      return { status: 401 };
    }
    d.door.clear(q.source);
    if (!d.door.credit(agent.id, agent.rate)) { d.refuse(q.source, "rate", agent.id); return { status: 429 }; }
    let msg;
    try { msg = JSON.parse(q.body); } catch { return { status: 400 }; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") return { status: 400 };
    const reply = (/** @type {any} */ result) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, result } });
    const fail = (/** @type {number} */ code, /** @type {string} */ message) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, error: { code, message } } });
    if (msg.id === undefined) return { status: 202 };
    if (msg.method === "initialize") return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: d.name || "vyre", version: "1" }, instructions: "You reach only what the person gave you. Start with whoami." });
    if (msg.method === "ping") return reply({});
    const extra = await d.extra?.(agent).catch(() => null);
    if (msg.method === "tools/list") return reply({ tools: [...toolsFor(needsOf(d.store.reach(agent.id))), ...(extra ? extra.tools : [])].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    if (msg.method !== "tools/call" || !msg.params) return fail(-32601, "unknown method");
    const name = String(msg.params.name), args = msg.params.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
    const listed = new Set([...toolsFor(needsOf(d.store.reach(agent.id))).map(t => t.name), ...(extra ? extra.tools.map((/** @type {any} */ t) => t.name) : [])]);
    if (!listed.has(name)) return reply({ isError: true, content: [{ type: "text", text: MCP_TOOLS.some(t => t.name === name) ? `${name} needs the person to give you more access first` : "unknown tool" }] });
    d.store.used(agent.id);
    try {
      const out = extra && extra.tools.some((/** @type {any} */ t) => t.name === name) ? await extra.call(name, args, q.source) : await perform(agent, name, args);
      d.emit("outside.used", { id: agent.id, name: agent.name, tool: name, resource: resourceOf(name, args), outcome: "ok" });
      return reply(out && out.content ? out : { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      const err = /** @type {any} */ (e);
      d.emit("outside.used", { id: agent.id, name: agent.name, tool: name, resource: resourceOf(name, args), outcome: err && err.code ? String(err.code) : "failed" });
      return reply({ isError: true, content: [{ type: "text", text: String(err && err.message || "failed").slice(0, 300) }] });
    }
  }
  return { handle, perform };
}

/** What a call touched, for the record of use: an address or a type or a project, never a value. @param {string} tool @param {any} a */
function resourceOf(tool, a) {
  const s = (/** @type {unknown} */ v) => String(v ?? "").slice(0, 120);
  if (tool === "records_get" || tool === "records_update") return s(a.urn);
  if (tool === "records_list" || tool === "records_create") return s(a.type);
  if (tool === "memory_ask" || tool === "files_read") return s(a.project);
  if (tool === "held_get") return s(a.held);
  return "";
}
