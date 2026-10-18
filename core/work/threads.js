// @ts-check
import crypto from "node:crypto";
// Agents are persistent and each has many threads (team/0.6/plans/threads.md). A THREAD is a chat of one person and one agent: its id is the chat id and never changes. The engine's runs
// (switchboard threads) are not exposed here; a thread's state is read from them. Everything is read through the kernel's own chat read, so a chat the caller is not in is not found.

const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** The agent ids a name or an id stands for: what the chat's assistants list may hold. @param {any} ctx @param {string} agent */
async function agentKeys(ctx, agent) {
  const keys = new Set([agent]);
  const byName = await ctx.call("agents.uid", { name: agent.toLowerCase() }).catch(() => null);
  if (byName && byName.data && byName.data.uid) keys.add(String(byName.data.uid));
  const byUid = await ctx.call("agents.uid", { uid: agent }).catch(() => null);
  if (byUid && byUid.data && byUid.data.name) keys.add(String(byUid.data.name));
  return keys;
}

/**
 * Where a chat lives, from its project and who is in it: a project of its own is "project"; otherwise (the unfiled Personal or the old General) it is "personal" while only the caller is in it and "space" once anyone else is.
 * @param {any} project the project record's data, or null @param {number} people how many people are in the chat
 */
export function placeOf(project, people) {
  const unfiled = !project || project.personal_of || project.slug === "general";
  return unfiled ? (people > 1 ? "space" : "personal") : "project";
}

/** The faces a row shows: people with their names (from the Space's member list) and agents with theirs. @param {any} ctx @param {any} k */
export async function facesOf(ctx, k) {
  const person = new Map(), agent = new Map();
  const m = await ctx.call("spaces.members.list", { space: k.space }, { relay: true }).catch(() => null);
  for (const r of (m && m.data && Array.isArray(m.data.members) ? m.data.members : [])) if (r && r.person) person.set(String(r.person), r.name ? String(r.name) : null);
  const known = await ctx.call("agents.list", {}).then((/** @type {any} */ r) => (r && r.data) || []).catch(() => []);
  for (const a of Array.isArray(known) ? known : []) if (a && a.name) { agent.set(String(a.name), String(a.name)); if (a.uid) agent.set(String(a.uid), String(a.name)); }
  return {
    people: (/** @type {string[]} */ ids) => ids.map(id => ({ id, name: person.get(id) || null })),
    agents: (/** @type {string[]} */ ids) => ids.map(id => ({ id, name: agent.get(id) || id })),
    agentName: (/** @type {string} */ id) => agent.get(id) || id,
  };
}

/** The messages others made in a chat after this person's read marker, from the stream's own tables; 0 when there is none. @param {any} db @param {string} who @param {string} chat */
function unreadOf(db, who, chat) {
  if (!db || !who) return 0;
  try {
    const mark = /** @type {any} */ (db.prepare("SELECT upto FROM stream_groups_marks WHERE person = ? AND session = ?").get(`person:${who}`, chat));
    const row = /** @type {any} */ (db.prepare("SELECT COUNT(DISTINCT json_extract(json, '$.data.message')) AS n FROM stream_frames WHERE session = ? AND cur > ? AND json_extract(json, '$.type') IN ('chat.user-message', 'chat.text-done') AND json_extract(json, '$.author') != ?").get(chat, mark ? Number(mark.upto) : 0, `person:${who}`));
    return row ? Number(row.n) || 0 : 0;
  } catch { return 0; }
}

/** The display link a fork keeps to its origin: { thread, message } from the record's text, or null. @param {any} v */
function forkedOf(v) {
  let o = v;
  if (typeof v === "string") { try { o = JSON.parse(v); } catch { return null; } }
  return o && typeof o === "object" && typeof o.thread === "string" && o.thread ? { thread: o.thread, message: String(o.message || "") } : null;
}

/** What the Gate holds for this person, by the engine run it was filed under: a held send, share or post is a question only they can answer. Read as the person (the Gate shows only what they may handle). @param {any} ctx @returns {Promise<Map<string, number>>} */
async function heldThreads(ctx) {
  const r = await ctx.call("gate.held", {}, { relay: true }).catch(() => null);
  /** @type {Map<string, number>} */ const out = new Map();
  for (const it of (r && Array.isArray(r.data) ? r.data : [])) if (it && it.thread) out.set(String(it.thread), (out.get(String(it.thread)) || 0) + 1);
  return out;
}

/** The runs with the held items counted as open questions, so a thread waiting on the Gate needs the person. @param {any[]} runs @param {Map<string, number>} held */
export const withHeld = (runs, held) => runs.map(r => (held.get(String(r.thread)) ? { ...r, needs: (Number(r.needs) || 0) + (held.get(String(r.thread)) || 0) } : r));

/**
 * One thread as a screen reads it.
 * @param {any} rec the chat record (data) @param {any[]} runs the chat's engine runs (threads.of-chat) @param {number} unread
 */
export function threadRow(rec, runs, unread) {
  const data = rec.data || rec;
  const needs = runs.some(r => Number(r.needs) > 0), live = runs.some(r => r.live === true);
  const line = runs.filter(r => r.last_line).sort((a, b) => (b.last || 0) - (a.last || 0))[0];
  return {
    thread: String(data.chat),
    agent: Array.isArray(data.agents) && data.agents.length ? String(data.agents[0]) : null,
    title: String(data.title || "") || "New thread",
    started: data.started || null,
    last_active: data.last_active || data.started || null,
    state: needs ? "needs_you" : live ? "live" : "idle",
    last_line: line ? line.last_line : null,
    unread,
    project: data.project && data.project.urn ? String(data.project.urn) : null,
    forked_from: forkedOf(data.forked_from),
  };
}

/** The person and, when the chat is theirs alone with one agent, that agent's id; null for a chat that is not a thread. @param {any} k @param {any} chain @param {string} chat */
export function soloAgent(k, chain, chat) {
  const hop = chain && chain.hops && chain.hops[0];
  if (!hop || !hop.actor || hop.actor.kind !== "person") return null;
  let c; try { c = k.chats.read(chain, chat); } catch { return null; }
  const people = [...c.people], agents = [...c.assistants];
  return people.length === 1 && people[0] === String(hop.actor.id) && agents.length === 1 ? { person: String(hop.actor.id), agent: String(agents[0]) } : null;
}

/**
 * The threads of one agent that this caller is in alone with it, newest first.
 * @param {{ ctx: any, kernelOf: () => any, chainOf: (extra: any) => Promise<any>, chatRows: (chain: any, spec: any) => Promise<any[]> }} d
 */
export async function threadsOf(d, agent, extra, { limit = 50, before = null } = {}) {
  const chain = await d.chainOf(extra);
  const k = d.kernelOf();
  const hop = chain && chain.hops && chain.hops[0];
  if (!hop || !hop.actor || hop.actor.kind !== "person") throw fail("denied", "threads are a person's own: ask from your own session");
  const me = String(hop.actor.id);
  const keys = await agentKeys(d.ctx, agent);
  const mine = new Set((await k.chats.mine(chain)).map((/** @type {any} */ m) => m.chat));
  const rows = (await d.chatRows(chain, { page: { limit: 500 } })).filter((/** @type {any} */ r) => mine.has(r.data.chat));
  const held = await heldThreads(d.ctx);
  /** @type {any[]} */ const out = [];
  for (const r of rows) {
    let c; try { c = k.chats.read(chain, r.data.chat); } catch { continue; }
    const people = [...c.people], agents = [...c.assistants];
    if (people.length !== 1 || people[0] !== me || agents.length !== 1 || !keys.has(String(agents[0]))) continue;
    const runs = ((await d.ctx.call("threads.of-chat", { chat: r.data.chat }).then((/** @type {any} */ x) => (x && x.data) || {}).catch(() => ({}))).runs) || [];
    out.push(threadRow({ ...r.data, agents }, withHeld(runs, held), unreadOf(d.ctx.store && d.ctx.store.db, me, r.data.chat)));
  }
  out.sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
  const after = before ? out.filter(t => String(t.last_active || "") < String(before)) : out;
  return { agent, threads: after.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200)), count: out.length };
}

/** Proof that a create comes from work.project.chat: the chat_pj_ ids are reserved to it, so nobody else can take a project's chat first. */
export const PROJECT_CHAT = Symbol("project-chat");

/** The id of a project's group chat: fixed by the project, so a project has one. @param {string} projectUrn */
export const projectChatId = projectUrn => `chat_pj_${crypto.createHash("sha256").update(String(projectUrn)).digest("hex").slice(0, 20)}`;

/** The key of a chat: the set of people (and, for a project's chat, the project). A hash of sorted ids, so the same people are always the same chat. @param {string[]} people @param {string | null} project */
export function chatKey(people, project = null) {
  const h = crypto.createHash("sha256").update(`${project || ""}|${[...new Set(people)].sort().join(",")}`).digest("hex").slice(0, 20);
  return `${project ? "pj" : "cs"}_${h}`;
}

/**
 * Every thread the caller is in, each with what a screen needs, and the chat it belongs to.
 * @param {{ ctx: any, kernelOf: () => any, chainOf: (extra: any) => Promise<any>, chatRows: (chain: any, spec: any) => Promise<any[]>, pinnedOf: (person: string) => Map<string, string> }} d
 */
async function loadMine(d, extra) {
  const chain = await d.chainOf(extra);
  const k = d.kernelOf();
  const hop = chain && chain.hops && chain.hops[0];
  if (!hop || !hop.actor || hop.actor.kind !== "person") throw fail("denied", "the chat list is a person's own: ask from your own session");
  const me = String(hop.actor.id);
  const db = d.ctx.store && d.ctx.store.db;
  const faces = await facesOf(d.ctx, k);
  const projects = new Map(((await k.records.query(chain, "project", { page: { limit: 500 } })).rows || []).map((/** @type {any} */ p) => [p.urn, { urn: p.urn, name: p.data.name, slug: p.data.slug, personal_of: p.data.personal_of }]));
  const mine = new Set((await k.chats.mine(chain)).map((/** @type {any} */ m) => m.chat));
  const pins = d.pinnedOf(me);
  const rows = (await d.chatRows(chain, { page: { limit: 500 } })).filter((/** @type {any} */ r) => mine.has(r.data.chat));
  const held = await heldThreads(d.ctx);
  /** @type {any[]} */ const items = [];
  for (const r of rows) {
    let c; try { c = k.chats.read(chain, r.data.chat); } catch { continue; }
    const ppl = [...c.people], agents = [...c.assistants];
    const proj = r.data.project && r.data.project.urn ? projects.get(r.data.project.urn) || null : null, place = placeOf(proj, ppl.length);
    const project = place === "project" && proj ? { urn: proj.urn, name: proj.name } : null;
    const runs = ((await d.ctx.call("threads.of-chat", { chat: r.data.chat }).then((/** @type {any} */ x) => (x && x.data) || {}).catch(() => ({}))).runs) || [];
    const thread = { ...threadRow({ ...r.data, agents }, withHeld(runs, held), unreadOf(db, me, r.data.chat)), place, project, faces: { people: faces.people(ppl), agents: faces.agents(agents) }, pinned: pins.get(String(r.data.chat)) || null };
    items.push({ ppl, agents, place, project, projectChat: Boolean(r.data.project_chat), thread, key: r.data.project_chat ? String(r.data.chat) : chatKey(ppl, project ? project.urn : null) });
  }
  return { me, k, faces, items };
}

/** One chat (a set of people) as a screen reads it: the threads in it, newest first, and the summary of them. @param {any} faces @param {string} me @param {any[]} group the items of one chat */
function chatOf(faces, me, group) {
  const threads = group.map(g => g.thread).sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
  const first = group[0], oldest = [...group].sort((a, b) => String(a.thread.started || "").localeCompare(String(b.thread.started || "")))[0];
  const ppl = first.ppl, other = ppl.filter((/** @type {string} */ p) => p !== me);
  const agentIds = [...new Set(group.flatMap(g => g.agents))];
  const live = threads.find(t => t.state === "needs_you") || threads.find(t => t.state === "live") || null;
  const person = other.length === 1 && first.place !== "project" ? faces.people(other)[0] : null;
  return {
    chat: first.key, kind: person ? "person" : "group",
    name: first.project ? first.project.name : person ? (person.name || person.id) : oldest.thread.title,
    ...(person ? { person: person.id } : {}),
    place: first.place, project: first.project,
    people: ppl.length, agents: agentIds.length,
    faces: { people: faces.people(ppl), agents: faces.agents(agentIds) },
    threads: threads.length, latest: threads[0], live, needs_you: threads.some(t => t.state === "needs_you"),
    unread: threads.reduce((n, t) => n + (Number(t.unread) || 0), 0), last_active: threads[0].last_active,
  };
}

/**
 * The chat list as one summary: the pinned Assistant, people, groups (each a chat with its thread count and its latest or live thread), agents (one row each) and Flows. Read through the caller's own chats only.
 * @param {{ ctx: any, kernelOf: () => any, chainOf: (extra: any) => Promise<any>, chatRows: (chain: any, spec: any) => Promise<any[]>, pinnedOf: (person: string) => Map<string, string> }} d
 */
export async function summarize(d, extra) {
  const { me, faces, items } = await loadMine(d, extra);
  /** @type {Map<string, any[]>} */ const byAgent = new Map(), byChat = new Map();
  for (const it of items) {
    if (it.ppl.length === 1 && it.agents.length === 1) { const l = byAgent.get(String(it.agents[0])) || []; l.push(it.thread); byAgent.set(String(it.agents[0]), l); }
    else byChat.set(it.key, [...(byChat.get(it.key) || []), it]);
  }
  /** @type {any[]} */ const pinned = [], agentRows = [];
  for (const [agent, threads] of byAgent) {
    threads.sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
    const live = threads.find(t => t.state === "needs_you") || threads.find(t => t.state === "live") || null;
    const row = { kind: "agent", agent, name: faces.agentName(agent), place: threads[0].place, threads: threads.length, latest: threads[0], live, needs_you: threads.some(t => t.state === "needs_you"), unread: threads.reduce((n, t) => n + (Number(t.unread) || 0), 0), last_active: threads[0].last_active };
    if (threads.some(t => t.pinned === "assistant")) pinned.push(row); else agentRows.push(row);
  }
  const chats = [...byChat.values()].map(g => chatOf(faces, me, g));
  const newest = (/** @type {any} */ a, /** @type {any} */ b) => String(b.last_active || "").localeCompare(String(a.last_active || ""));
  pinned.sort(newest); agentRows.sort(newest); chats.sort(newest);
  return { pinned, people: chats.filter(c => c.kind === "person"), groups: chats.filter(c => c.kind === "group"), agents: agentRows, flows: await flowRows(d.ctx) };
}

/** The person id in a person link ({ actor: { id } } or { id }), or "". @param {any} v */
const personId = v => String((v && v.actor && v.actor.id) || (v && v.id) || "");

/**
 * "You and <person>": your chat with them, the threads you share (any chat that has both of you), and the projects you are both on. Read through the caller's own chats and projects only.
 * @param {any} d @param {any} extra @param {string} person
 */
export async function personShared(d, extra, person) {
  const { me, k, faces, items } = await loadMine(d, extra);
  if (!person || person === me) throw fail("bad_input", "name another person");
  const chain = await d.chainOf(extra);
  const both = items.filter(it => it.ppl.includes(person));
  const direct = items.filter(it => it.key === chatKey([me, person]));
  const newest = (/** @type {any[]} */ l) => l.map(it => it.thread).sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
  const projects = new Map(((await k.records.query(chain, "project", { page: { limit: 500 } })).rows || []).map((/** @type {any} */ p) => [p.urn, { urn: p.urn, name: p.data.name, owner: personId(p.data.owner), personal: Boolean(p.data.personal_of) }]));
  /** @type {Map<string, Set<string>>} */ const team = new Map();
  for (const [urn, p] of projects) if (p.owner) team.set(urn, new Set([p.owner]));
  for (const t of (await k.records.query(chain, "team-member", { page: { limit: 1000 } })).rows || []) {
    const u = t.data.project && t.data.project.urn, a = personId(t.data.actor);
    if (u && a && team.has(String(u))) /** @type {Set<string>} */ (team.get(String(u))).add(String(a));
  }
  const together = [...team].filter(([urn, set]) => set.has(me) && set.has(person) && !(projects.get(urn) || { personal: true }).personal).map(([urn]) => ({ urn, name: /** @type {any} */ (projects.get(urn)).name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const dm = direct.length ? chatOf(faces, me, direct) : null;
  // the files in the chats you both are in, newest first: read through your own chain, so only what you may open
  /** @type {any[]} */ const files = [];
  for (const it of both.slice(0, 20)) {
    const got = await d.filesOf(chain, String(it.thread.thread)).catch(() => ({ files: [] }));
    for (const f of got.files || []) files.push({ ...f, thread: it.thread.thread, thread_title: it.thread.title });
  }
  files.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return { files: files.slice(0, 50), file_count: files.length, person: faces.people([person])[0], chat: dm ? { chat: dm.chat, threads: dm.threads, latest: dm.latest, last_active: dm.last_active } : null, threads: newest(both).slice(0, 20), shared_threads: both.length, projects: together };
}

/**
 * The threads of one chat: by a thread in it, or by the people (you are always one of them).
 * @param {any} d @param {any} extra @param {{ chat?: string, people?: string[], limit?: number, before?: string | null }} q
 */
export async function chatThreads(d, extra, q) {
  const { me, faces, items } = await loadMine(d, extra);
  let key = null;
  if (q.chat) {
    const named = String(q.chat);
    const hit = items.find(it => it.thread.thread === named) || items.find(it => it.key === named);
    if (!hit) throw fail("not_found", "no such chat (work.chat.summary lists yours)");
    key = hit.key;
  } else key = chatKey([me, ...(q.people || []).map(String)]);
  const group = items.filter(it => it.key === key);
  if (!group.length) { if (q.chat) throw fail("not_found", "no such chat (work.chat.summary lists yours)"); return { chat: key, exists: false, people: faces.people([...new Set([me, ...(q.people || []).map(String)])]), threads: [], count: 0 }; }
  const c = chatOf(faces, me, group);
  const all = group.map(g => g.thread).sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
  const after = q.before ? all.filter(t => String(t.last_active || "") < String(q.before)) : all;
  return { chat: c.chat, exists: true, name: c.name, kind: c.kind, place: c.place, project: c.project, people: faces.people(group[0].ppl), threads: after.slice(0, Math.min(Math.max(Number(q.limit) || 50, 1), 200)), count: all.length };
}

/** A run's state in a thread's words: running or waiting is live, paused or failed needs the person, the rest is idle. @param {string} state */
const runState = state => (state === "running" || state === "waiting" ? "live" : state === "paused" || state === "failed" ? "needs_you" : "idle");

/** One Flow run as a thread of that Flow. @param {any} r a row of flows.runs @param {any} [attention] its row of flows.attention, when a person has to look at it */
export function runThread(r, attention = null) {
  // a run held at a gate, or stuck, is waiting for a person even though its state says waiting
  const over = ["done", "cancelled"].includes(String(r.state));
  const asks = attention && !over ? { gate: attention.gate === true, reason: String(attention.message || attention.step_label || attention.kind || "").slice(0, 200) } : null;
  return { kind: "run", id: String(r.id), flow: String(r.flow), state: asks ? "needs_you" : runState(String(r.state)), ...(asks ? { needs: asks } : {}), started: r.started_at || null, finished: r.finished_at || null, summary: r.label ? String(r.label) : null, error: r.error && r.error.message ? String(r.error.message).slice(0, 200) : null };
}

/**
 * A Flow's runs as its threads, newest first, read through the caller's own relayed call: flows.runs already shows a member only the Flows she made or that are shared with her.
 * @param {any} ctx @param {string | null} flow
 */
async function runsOf(ctx, flow) {
  const r = await ctx.call("flows.runs", { ...(flow ? { id: flow } : {}), limit: 200 }, { relay: true });
  if (r && r.error) { if (r.error.code === "not_found") return []; throw fail(r.error.code || "failed", r.error.message); }
  const rows = r && Array.isArray(r.data) ? r.data : [];
  // which of the runs the caller may see are waiting for a person (a held gate, a stuck step): flows.attention lists the Space's, so only the ids flows.runs already showed are used
  const seen = new Set(rows.map((/** @type {any} */ x) => String(x.id)));
  const att = await ctx.call("flows.attention", {}, { relay: true }).then((/** @type {any} */ a) => (a && a.data && Array.isArray(a.data.runs) ? a.data.runs : [])).catch(() => []);
  const need = new Map(att.filter((/** @type {any} */ a) => seen.has(String(a.run))).map((/** @type {any} */ a) => [String(a.run), a]));
  return rows.map((/** @type {any} */ x) => runThread(x, need.get(String(x.id)) || null)).sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")));
}

/** The Flow rows of the chat list: one per Flow that has runs, with its run count and latest or live run. @param {any} ctx */
export async function flowRows(ctx) {
  const byFlow = new Map();
  for (const t of await runsOf(ctx, null).catch(() => /** @type {any[]} */ ([]))) byFlow.set(t.flow, [...(byFlow.get(t.flow) || []), t]);
  // every Flow is a chat of its own, with or without runs. flows.list names every Flow in the Space, so a Flow is shown only when the caller may inspect it: it has runs they were shown, or flows.runs for it
  // does not refuse them (flows.runs applies the same inspect rule). Its name is the list's label.
  const listed = (await ctx.call("flows.list", {}, { relay: true }).then((/** @type {any} */ x) => (x && Array.isArray(x.data) ? x.data : [])).catch(() => [])).slice(0, 200);
  const names = new Map(listed.map((/** @type {any} */ f) => [String(f.id), String(f.label || f.name || "")]));
  /** @type {any[]} */ const rows = [...byFlow].map(([flow, runs]) => ({ kind: "flow", flow, name: names.get(String(flow)) || flow, runs: runs.length, latest: runs[0], live: runs.find(t => t.state === "needs_you") || runs.find(t => t.state === "live") || null, needs_you: runs.some(t => t.state === "needs_you"), last_active: runs[0].started || null }));
  for (const f of listed) {
    const id = String(f.id);
    if (byFlow.has(id)) continue;
    const mine = await ctx.call("flows.runs", { id, limit: 1 }, { relay: true }).then((/** @type {any} */ r) => !(r && r.error)).catch(() => false);
    if (mine) rows.push({ kind: "flow", flow: id, name: names.get(id) || id, runs: 0, latest: null, live: null, needs_you: false, last_active: f.updated_at || f.created_at || null });
  }
  return rows.sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
}

/** The table that remembers where a fork starts: the new thread, the engine run and transcript message to fork from. Written only by work.thread.fork, read only by the stream when the fork first runs. @param {any} db */
function forksTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS work_thread_forks (chat TEXT PRIMARY KEY, source_run TEXT NOT NULL, resume_at TEXT NOT NULL, origin TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL)");
  return db;
}

/** The table that remembers which chat a Flow was drafted from (flows.from-chat with a chat). Written only by work.flow.origin, read only for a person in that chat. @param {any} db */
function originsTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS work_flow_origins (flow TEXT PRIMARY KEY, chat TEXT NOT NULL, person TEXT NOT NULL, at INTEGER NOT NULL)");
  return db;
}

/**
 * Register the thread tools that read and start. `chatTool` is the work module's own (it keeps the member door's copy), `createChat` the very function work.chat.create runs.
 * @param {{ ctx: any, chatTool: (name: string, def: any) => void, kernelOf: () => any, chainOf: (extra: any) => Promise<any>, chatRows: (chain: any, spec: any) => Promise<any[]>, createChat: (input: any, extra: any) => Promise<any>, hubOf: () => any, changeChat: (input: any, extra: any) => Promise<any>, pinnedOf: (person: string) => Map<string, string> }} d
 */
export function registerThreads(d) {
  d.chatTool("work.agent.threads", {
    description: "Your threads with one agent, newest first: title, state (live, needs_you, idle), last line, unread. A thread is a chat of you and that agent.",
    input: obj({ agent: { type: "string", description: "the agent's name or id" }, limit: { type: "integer" }, before: { type: "string", description: "a last_active value: only older threads" } }, ["agent"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => threadsOf(d, String(input.agent), extra, { limit: input.limit, before: input.before ? String(input.before) : null }),
  });
  d.chatTool("work.agent.thread.new", {
    description: "Start a new thread with an agent. Old threads stay and can be continued. Returns { thread, agent }.",
    input: obj({ agent: { type: "string", description: "the agent's name or id" }, title: { type: "string" }, project: { type: "string" }, id: { type: "string", description: "the thread's id (chat_<uuid>), chosen by the device that made its key ring" }, ring: { type: "object", description: "the chat's key ring, made on your device (as work.chat.create takes it)" } }, ["agent"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const agent = String(input.agent);
      const made = await d.createChat({ agents: [agent], ...(input.title ? { title: String(input.title) } : {}), ...(input.project ? { project: String(input.project) } : {}), ...(input.id ? { id: String(input.id) } : {}), ...(input.ring ? { ring: input.ring } : {}) }, extra);
      return { thread: made.chat, agent: (made.agents && made.agents[0]) || agent };
    },
  });
  d.chatTool("work.chat.summary", {
    description: "Your chat list in sections: pinned Assistant, people, groups, agents (one row each: thread count, latest and live thread) and Flows.",
    input: obj({}),
    run: async (/** @type {any} */ _input, /** @type {any} */ extra) => summarize(d, extra),
  });
  d.chatTool("work.flow.threads", {
    description: "A Flow's runs as its threads, newest first: id, state (live, needs_you, idle), started, finished, error. Only Flows you made or share.",
    input: obj({ flow: { type: "string", description: "the Flow's id" } }, ["flow"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const chain = await d.chainOf(extra);
      const hop = chain && chain.hops && chain.hops[0];
      if (!hop || !hop.actor || hop.actor.kind !== "person") throw fail("denied", "a Flow's runs are read from a person's own session");
      const threads = await runsOf(d.ctx, String(input.flow));
      // "How it was made": the chat the Flow was drafted from, shown only to a person who is in that chat
      const made = /** @type {any} */ (originsTable(d.ctx.store.db).prepare("SELECT chat, at FROM work_flow_origins WHERE flow = ?").get(String(input.flow)));
      let origin = null;
      if (made) { try { d.kernelOf().chats.read(chain, String(made.chat)); origin = { kind: "made", id: "made", chat: String(made.chat), title: "How it was made", state: "idle", started: new Date(Number(made.at)).toISOString() }; } catch { origin = null; } }
      return { flow: String(input.flow), threads, ...(origin ? { made: origin } : {}), count: threads.length };
    },
  });
  d.chatTool("work.chat.threads", {
    description: "A chat's threads, newest first, found by a thread in it or by its people, with who is in it.",
    input: obj({ chat: { type: "string", description: "a thread id or a chat key from work.chat.summary" }, people: { type: "array", items: { type: "string" }, description: "the other people in the chat, when no chat is named" }, limit: { type: "integer" }, before: { type: "string" } }),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => chatThreads(d, extra, { chat: input.chat ? String(input.chat) : undefined, people: Array.isArray(input.people) ? input.people : [], limit: input.limit, before: input.before ? String(input.before) : null }),
  });
  d.chatTool("work.chat.add-people", {
    description: "Add people to a chat of several people: every thread in it takes them. Give each thread's ring; returns the threads still missing one.",
    input: obj({ chat: { type: "string", description: "a thread id or a chat key from work.chat.summary" }, people: { type: "array", items: { type: "string" } }, rings: { type: "object", description: "thread id -> that thread's key ring with the new people's devices added (addHolders), made on your device" } }, ["chat", "people"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const { me, faces, items } = await loadMine(d, extra);
      const named = String(input.chat || "");
      const hit = items.find(it => it.thread.thread === named) || items.find(it => it.key === named);
      if (!hit) throw fail("not_found", "no such chat (work.chat.summary lists yours)");
      if (hit.ppl.length === 1) throw fail("bad_input", "this is a thread with an agent: work.thread.add-people adds people to it");
      const group = items.filter(it => it.key === hit.key);
      if (group.some(it => it.projectChat)) throw fail("bad_input", "a project's chat has the project's team in it: change the team (work.project.level) and the chat follows");
      const add = [...new Set((Array.isArray(input.people) ? input.people : []).map(String))].filter(p => !hit.ppl.includes(p));
      if (!add.length) throw fail("bad_input", "name people who are not in the chat yet");
      const rings = input.rings && typeof input.rings === "object" ? input.rings : {};
      /** @type {string[]} */ const changed = [], missingRing = [];
      /** @type {{ thread: string, error: string }[]} */ const failed = [];
      for (const it of group) {
        const thread = String(it.thread.thread);
        if (!rings[thread]) { missingRing.push(thread); continue; }
        try { await d.changeChat({ chat: thread, add_people: add, ring: rings[thread] }, extra); changed.push(thread); }
        catch (e) { failed.push({ thread, error: String(e && /** @type {any} */ (e).message || e).slice(0, 200) }); }
      }
      return { chat: chatKey([...hit.ppl, ...add]), people: faces.people([...hit.ppl, ...add]), added: add, changed, missing_rings: missingRing, failed, done: !missingRing.length && !failed.length };
    },
  });
  d.chatTool("work.project.chat", {
    description: "A project's group chat, made on first use for its team: { chat, people, missing, extra }. A member's device applies the gap with work.chat.change.",
    input: obj({ project: { type: "string", description: "the project's short name, record id or address" }, ring: { type: "object", description: "on first use: the chat's key ring, made on your device for the id returned with needs_ring; the server never makes it" } }, ["project"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const chain = await d.chainOf(extra), k = d.kernelOf(), hop = chain && chain.hops && chain.hops[0];
      if (!hop || !hop.actor || hop.actor.kind !== "person" || chain.viewer === true || chain.hops.length !== 1) throw fail("denied", "a project's chat is a person's own: ask from your own session, not through an agent");
      const me = String(hop.actor.id);
      const rec = await d.hubOf().projectOf(String(input.project || ""));
      if (!rec || !(await k.records.get(chain, "project", rec.id).catch(() => null))) throw fail("not_found", "no such project (projects.list shows them)");
      const team = await d.hubOf().teamOf(rec.id);
      if (!team) throw fail("not_found", "no such project (projects.list shows them)");
      if (team.personal_of) throw fail("bad_input", "a Personal project is yours alone: it has no group chat. Chat there with an agent instead.");
      const writers = team.people.filter(p => p.level !== "viewer").map(p => p.id), readers = team.people.filter(p => p.level === "viewer").map(p => p.id);
      const id = projectChatId(team.urn);
      const readIt = () => { try { return k.chats.read(chain, id); } catch { return null; } };
      let c = readIt();
      if (!c && !(await d.hubOf().chatRecord(id))) {
        if (!writers.includes(me)) return { chat: null, id, pending: true, people: [], missing: writers, extra: [], readonly: readers, readonly_for_you: readers.includes(me) };
        // End to end: the first chat needs the ring a device made; the server never makes or holds a project chat's key.
        if (!input.ring) return { chat: null, id, needs_ring: true, people: writers, missing: [], extra: [], readonly: readers, readonly_for_you: readers.includes(me) };
        const made = await d.createChat({ title: team.name, project: team.slug, people: writers.filter(p => p !== me), id, ring: input.ring }, { ...extra, projectChat: PROJECT_CHAT });
        const recd = await d.hubOf().chatRecord(String(made.chat));
        if (recd) await d.hubOf().setChatFields(recd, { project_chat: true });
        c = readIt();
      } else if (c) {
        const recd = await d.hubOf().chatRecord(id);
        if (recd && !recd.data.project_chat) await d.hubOf().setChatFields(recd, { project_chat: true });
      }
      if (!c) return { chat: id, id, member: false, people: [], missing: [], extra: [], readonly: readers, readonly_for_you: readers.includes(me), waiting: writers.includes(me) };
      const people = [...c.people];
      return { chat: id, id, member: true, people, missing: writers.filter(p => !people.includes(p)), extra: people.filter(p => !writers.includes(p)), readonly: readers, readonly_for_you: readers.includes(me) };
    },
  });
  d.chatTool("work.person.shared", {
    description: "What you and one person share: your chat with them, the threads you are both in, their files, and the projects you are both on.",
    input: obj({ person: { type: "string", description: "the person's id" } }, ["person"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => personShared(d, extra, String(input.person)),
  });
  d.chatTool("work.thread.add-people", {
    description: "Add people to your thread with an agent. They read its earlier messages; the agent keeps its context. Needs your device's key ring.",
    input: obj({ thread: { type: "string" }, people: { type: "array", items: { type: "string" } }, ring: { type: "object", description: "the chat's key ring with the new people's devices added (addHolders), made on your device" } }, ["thread", "people"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const chain = await d.chainOf(extra), k = d.kernelOf();
      const thread = String(input.thread);
      const people = Array.isArray(input.people) ? input.people.map(String).filter(Boolean) : [];
      if (!people.length) throw fail("bad_input", "name the people to add");
      // only a thread of you and one agent moves; in a chat of other people, a new thread there is made with work.chat.thread.new, and adding to a group is the group's own change
      const solo = soloAgent(k, chain, thread);
      if (!solo) throw fail("not_found", "no such thread of yours with an agent (work.agent.threads lists them); to add people to a chat of people, start a thread in the chat of exactly those people with work.chat.thread.new");
      if (people.includes(solo.person)) throw fail("bad_input", "you are already in it");
      await d.changeChat({ chat: thread, add_people: people, ...(input.ring ? { ring: input.ring } : {}) }, extra);
      const where = await chatThreads(d, extra, { chat: thread, limit: 1 });
      return { thread, chat: where.chat, place: where.place, people: where.people };
    },
  });
  d.chatTool("work.chat.thread.new", {
    description: "Start a new thread in the chat of you and these people, with an agent if named. Returns { thread, chat }.",
    input: obj({ people: { type: "array", items: { type: "string" }, description: "the other people; none for your own chat" }, agent: { type: "string" }, title: { type: "string" }, project: { type: "string" }, id: { type: "string", description: "the thread's id (chat_<uuid>), chosen by the device that made its key ring" }, ring: { type: "object", description: "the new chat's key ring, made on your device" } }),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const people = Array.isArray(input.people) ? input.people.map(String) : [];
      const made = await d.createChat({ people, agents: input.agent ? [String(input.agent)] : [], ...(input.title ? { title: String(input.title) } : {}), ...(input.project ? { project: String(input.project) } : {}), ...(input.id ? { id: String(input.id) } : {}), ...(input.ring ? { ring: input.ring } : {}) }, extra);
      const where = await chatThreads(d, extra, { chat: String(made.chat), limit: 1 });
      return { thread: made.chat, chat: where.chat };
    },
  });
  d.chatTool("work.thread.fork", {
    description: "Fork a thread at one of the agent's replies: a new thread keeping everything up to it. The original is unchanged. Returns { thread, forked_from }.",
    input: obj({ thread: { type: "string", description: "the thread to fork" }, message: { type: "string", description: "the id of the agent's reply, as its frames carry it" }, title: { type: "string" }, id: { type: "string", description: "the new thread's id (chat_<uuid>), chosen by the device that made its key ring" }, ring: { type: "object", description: "the new chat's key ring, made on your device" } }, ["thread", "message"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const chain = await d.chainOf(extra), k = d.kernelOf();
      const origin = String(input.thread), message = String(input.message);
      if (input.id && String(input.id).startsWith("chat_pj_")) throw fail("bad_input", "that id is reserved for a project's group chat; choose an id like chat_<uuid>");
      const solo = soloAgent(k, chain, origin);
      if (!solo) throw fail("not_found", "no such thread (work.agent.threads lists yours); only a thread of you and one agent can be forked");
      // a fork is a NEW chat: an id that already names a chat (this thread's own, or any other) is refused before anything is made, and a repeat id can never rewrite another thread's fork origin
      if (input.id && (await d.hubOf().chatRecord(String(input.id)) || (() => { try { return k.chats.read(chain, String(input.id)); } catch { return null; } })())) throw fail("exists", "that id already names a chat: a fork needs a new one");
      const point = await d.ctx.call("threads.fork-point", { chat: origin, message });
      if (point.error) throw fail(point.error.code || "failed", point.error.message);
      const rec = await d.hubOf().chatRecord(origin);
      const title = String(input.title || "") || `${(rec && rec.data.title) || "Thread"} (fork)`;
      const project = rec && rec.data.project && rec.data.project.urn ? String(rec.data.project.urn) : null;
      const made = await d.createChat({ agents: [solo.agent], title, ...(project ? { project } : {}), ...(input.id ? { id: String(input.id) } : {}), ...(input.ring ? { ring: input.ring } : {}) }, extra);
      forksTable(d.ctx.store.db).prepare("INSERT INTO work_thread_forks (chat, source_run, resume_at, origin, message, at) VALUES (?,?,?,?,?,?)").run(String(made.chat), String(point.data.run), String(point.data.uuid), origin, message, Date.now());
      const mine = await d.hubOf().chatRecord(String(made.chat));
      const link = { thread: origin, message };
      if (mine) await d.hubOf().setChatFields(mine, { forked_from: JSON.stringify(link) });
      return { thread: made.chat, forked_from: link };
    },
  });
  // flows.from-chat tells which chat a draft Flow came from (the assistant names the chat it works in). Only the flows module asks, as the person who made the draft, and only a chat that person is in is kept.
  d.ctx.tool("work.flow.origin", {
    internal: true,
    description: "Keep the chat a draft Flow was made from: { flow, chat }. Only the flows module asks, as the person who made it.",
    input: obj({ flow: { type: "string" }, chat: { type: "string" } }, ["flow", "chat"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      if (String(extra && extra.caller) !== "module:flows") throw fail("denied", "only the flows module keeps where a Flow was made");
      const chain = await d.chainOf(extra);
      try { d.kernelOf().chats.read(chain, String(input.chat)); } catch { return { kept: false }; }
      const hop = chain.hops[0];
      originsTable(d.ctx.store.db).prepare("INSERT OR IGNORE INTO work_flow_origins (flow, chat, person, at) VALUES (?,?,?,?)").run(String(input.flow), String(input.chat), String(hop.actor.id), Date.now());
      return { kept: true };
    },
  });
  // The stream asks this when a thread is first answered: a fork has not run yet and starts from the point it was forked at. Nothing else asks, and a thread that already has a run is not forked again.
  d.ctx.tool("work.chat.fork-source", {
    internal: true,
    description: "Where a forked thread starts, for the stream's first answer in it: { run, resume_at }, or null. Only the stream asks.",
    input: obj({ chat: { type: "string" } }, ["chat"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      if (String(extra && extra.caller) !== "module:stream") throw fail("denied", "only the stream asks where a forked thread starts");
      const row = /** @type {any} */ (forksTable(d.ctx.store.db).prepare("SELECT source_run, resume_at FROM work_thread_forks WHERE chat = ?").get(String(input.chat)));
      if (!row) return null;
      const runs = ((await d.ctx.call("threads.of-chat", { chat: String(input.chat) }).then((/** @type {any} */ x) => (x && x.data) || {}).catch(() => ({}))).runs) || [];
      return runs.length ? null : { run: String(row.source_run), resume_at: String(row.resume_at) };
    },
  });
}

