// @ts-check
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
  /** @type {any[]} */ const out = [];
  for (const r of rows) {
    let c; try { c = k.chats.read(chain, r.data.chat); } catch { continue; }
    const people = [...c.people], agents = [...c.assistants];
    if (people.length !== 1 || people[0] !== me || agents.length !== 1 || !keys.has(String(agents[0]))) continue;
    const runs = ((await d.ctx.call("threads.of-chat", { chat: r.data.chat }).then((/** @type {any} */ x) => (x && x.data) || {}).catch(() => ({}))).runs) || [];
    out.push(threadRow({ ...r.data, agents }, runs, unreadOf(d.ctx.store && d.ctx.store.db, me, r.data.chat)));
  }
  out.sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
  const after = before ? out.filter(t => String(t.last_active || "") < String(before)) : out;
  return { agent, threads: after.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200)), count: out.length };
}

/**
 * The chat list as one summary: the pinned Assistant, people, groups, agents (one row per agent, with its thread count and its latest or live thread) and Flows. Read through the caller's own chats only.
 * @param {{ ctx: any, kernelOf: () => any, chainOf: (extra: any) => Promise<any>, chatRows: (chain: any, spec: any) => Promise<any[]>, pinnedOf: (person: string) => Map<string, string> }} d
 */
export async function summarize(d, extra) {
  const chain = await d.chainOf(extra);
  const k = d.kernelOf();
  const hop = chain && chain.hops && chain.hops[0];
  if (!hop || !hop.actor || hop.actor.kind !== "person") throw fail("denied", "the chat list is a person's own: ask from your own session");
  const me = String(hop.actor.id);
  const db = d.ctx.store && d.ctx.store.db;
  const names = new Map();
  const known = await d.ctx.call("agents.list", {}).then((/** @type {any} */ r) => (r && r.data) || []).catch(() => []);
  for (const a of Array.isArray(known) ? known : []) if (a && a.name) { names.set(String(a.name), String(a.name)); if (a.uid) names.set(String(a.uid), String(a.name)); }
  const mine = new Set((await k.chats.mine(chain)).map((/** @type {any} */ m) => m.chat));
  const pins = d.pinnedOf(me);
  const rows = (await d.chatRows(chain, { page: { limit: 500 } })).filter((/** @type {any} */ r) => mine.has(r.data.chat));
  /** @type {any[]} */ const people = [], groups = [];
  /** @type {Map<string, any[]>} */ const byAgent = new Map();
  for (const r of rows) {
    let c; try { c = k.chats.read(chain, r.data.chat); } catch { continue; }
    const ppl = [...c.people], agents = [...c.assistants];
    const base = { chat: String(r.data.chat), title: String(r.data.title || "") || "New chat", last_active: r.data.last_active || r.data.started || null, unread: unreadOf(db, me, r.data.chat) };
    if (ppl.length === 1 && agents.length === 1) {
      const runs = ((await d.ctx.call("threads.of-chat", { chat: r.data.chat }).then((/** @type {any} */ x) => (x && x.data) || {}).catch(() => ({}))).runs) || [];
      const list = byAgent.get(String(agents[0])) || [];
      list.push({ ...threadRow({ ...r.data, agents }, runs, base.unread), pinned: pins.get(String(r.data.chat)) || null });
      byAgent.set(String(agents[0]), list);
    } else if (ppl.length === 2 && agents.length === 0) {
      people.push({ kind: "person", person: ppl.find((/** @type {string} */ p) => p !== me) || null, ...base });
    } else {
      groups.push({ kind: "group", people: ppl.length, agents: agents.length, ...base });
    }
  }
  /** @type {any[]} */ const pinned = [], agentRows = [];
  for (const [agent, threads] of byAgent) {
    threads.sort((a, b) => String(b.last_active || "").localeCompare(String(a.last_active || "")));
    const live = threads.find(t => t.state === "needs_you") || threads.find(t => t.state === "live") || null;
    const row = { kind: "agent", agent, name: names.get(agent) || agent, threads: threads.length, latest: threads[0], live, needs_you: threads.some(t => t.state === "needs_you"), unread: threads.reduce((n, t) => n + (Number(t.unread) || 0), 0) };
    if (threads.some(t => t.pinned === "assistant")) pinned.push(row); else agentRows.push(row);
  }
  const newest = (/** @type {any} */ a, /** @type {any} */ b) => String((b.latest && b.latest.last_active) || b.last_active || "").localeCompare(String((a.latest && a.latest.last_active) || a.last_active || ""));
  pinned.sort(newest); agentRows.sort(newest); people.sort(newest); groups.sort(newest);
  return { pinned, people, groups, agents: agentRows, flows: await flowRows(d.ctx) };
}

/** A run's state in a thread's words: running or waiting is live, paused or failed needs the person, the rest is idle. @param {string} state */
const runState = state => (state === "running" || state === "waiting" ? "live" : state === "paused" || state === "failed" ? "needs_you" : "idle");

/** One Flow run as a thread of that Flow. @param {any} r a row of flows.runs */
export function runThread(r) {
  return { kind: "run", id: String(r.id), flow: String(r.flow), state: runState(String(r.state)), started: r.started_at || null, finished: r.finished_at || null, summary: r.label ? String(r.label) : null, error: r.error && r.error.message ? String(r.error.message).slice(0, 200) : null };
}

/**
 * A Flow's runs as its threads, newest first, read through the caller's own relayed call: flows.runs already shows a member only the Flows she made or that are shared with her.
 * @param {any} ctx @param {string | null} flow
 */
async function runsOf(ctx, flow) {
  const r = await ctx.call("flows.runs", { ...(flow ? { id: flow } : {}), limit: 200 }, { relay: true });
  if (r && r.error) { if (r.error.code === "not_found") return []; throw fail(r.error.code || "failed", r.error.message); }
  const rows = r && Array.isArray(r.data) ? r.data : [];
  return rows.map(runThread).sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")));
}

/** The Flow rows of the chat list: one per Flow that has runs, with its run count and latest or live run. @param {any} ctx */
export async function flowRows(ctx) {
  const byFlow = new Map();
  for (const t of await runsOf(ctx, null).catch(() => /** @type {any[]} */ ([]))) byFlow.set(t.flow, [...(byFlow.get(t.flow) || []), t]);
  return [...byFlow].map(([flow, runs]) => ({ kind: "flow", flow, name: flow, runs: runs.length, latest: runs[0], live: runs.find(t => t.state === "needs_you") || runs.find(t => t.state === "live") || null, needs_you: runs.some(t => t.state === "needs_you") }))
    .sort((a, b) => String(b.latest.started || "").localeCompare(String(a.latest.started || "")));
}

/** The table that remembers where a fork starts: the new thread, the engine run and transcript message to fork from. Written only by work.thread.fork, read only by the stream when the fork first runs. @param {any} db */
function forksTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS work_thread_forks (chat TEXT PRIMARY KEY, source_run TEXT NOT NULL, resume_at TEXT NOT NULL, origin TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL)");
  return db;
}

/**
 * Register the thread tools that read and start. `chatTool` is the work module's own (it keeps the member door's copy), `createChat` the very function work.chat.create runs.
 * @param {{ ctx: any, chatTool: (name: string, def: any) => void, kernelOf: () => any, chainOf: (extra: any) => Promise<any>, chatRows: (chain: any, spec: any) => Promise<any[]>, createChat: (input: any, extra: any) => Promise<any>, hubOf: () => any, pinnedOf: (person: string) => Map<string, string> }} d
 */
export function registerThreads(d) {
  d.chatTool("work.agent.threads", {
    description: "Your threads with one agent, newest first: title, state (live, needs_you, idle), last line, unread. A thread is a chat of you and that agent.",
    input: obj({ agent: { type: "string", description: "the agent's name or id" }, limit: { type: "integer" }, before: { type: "string", description: "a last_active value: only older threads" } }, ["agent"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => threadsOf(d, String(input.agent), extra, { limit: input.limit, before: input.before ? String(input.before) : null }),
  });
  d.chatTool("work.agent.thread.new", {
    description: "Start a new thread with an agent: a new chat of you and it. Old threads stay as they are and can be continued. Returns { thread, agent }.",
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
      return { flow: String(input.flow), threads, count: threads.length };
    },
  });
  d.chatTool("work.thread.fork", {
    description: "Fork a thread from one of the agent's replies: a new thread that keeps everything up to and including that reply. The original is unchanged. Returns { thread, forked_from }.",
    input: obj({ thread: { type: "string", description: "the thread to fork" }, message: { type: "string", description: "the id of the agent's reply, as its frames carry it" }, title: { type: "string" }, id: { type: "string", description: "the new thread's id (chat_<uuid>), chosen by the device that made its key ring" }, ring: { type: "object", description: "the new chat's key ring, made on your device" } }, ["thread", "message"]),
    run: async (/** @type {any} */ input, /** @type {any} */ extra) => {
      const chain = await d.chainOf(extra), k = d.kernelOf();
      const origin = String(input.thread), message = String(input.message);
      const solo = soloAgent(k, chain, origin);
      if (!solo) throw fail("not_found", "no such thread (work.agent.threads lists yours); only a thread of you and one agent can be forked");
      const point = await d.ctx.call("threads.fork-point", { chat: origin, message });
      if (point.error) throw fail(point.error.code || "failed", point.error.message);
      const rec = await d.hubOf().chatRecord(origin);
      const title = String(input.title || "") || `${(rec && rec.data.title) || "Thread"} (fork)`;
      const project = rec && rec.data.project && rec.data.project.urn ? String(rec.data.project.urn) : null;
      const made = await d.createChat({ agents: [solo.agent], title, ...(project ? { project } : {}), ...(input.id ? { id: String(input.id) } : {}), ...(input.ring ? { ring: input.ring } : {}) }, extra);
      forksTable(d.ctx.store.db).prepare("INSERT OR REPLACE INTO work_thread_forks (chat, source_run, resume_at, origin, message, at) VALUES (?,?,?,?,?,?)").run(String(made.chat), String(point.data.run), String(point.data.uuid), origin, message, Date.now());
      const mine = await d.hubOf().chatRecord(String(made.chat));
      const link = { thread: origin, message };
      if (mine) await d.hubOf().setChatFields(mine, { forked_from: JSON.stringify(link) });
      return { thread: made.chat, forked_from: link };
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

