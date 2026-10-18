// @ts-check
// Agents are persistent and each has many threads (team/0.6/plans/threads.md). A THREAD is a chat of one person and one agent: its id is the chat id and never changes. The engine's runs
// (switchboard threads) are not exposed here; a thread's state is read from them. Everything is read through the kernel's own chat read, so a chat the caller is not in is not found.

const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** The agent ids a name or an id stands for: what the chat's assistants list may hold. @param {(tool: string, input: any) => Promise<any>} call @param {string} agent */
async function agentKeys(call, agent) {
  const keys = new Set([agent]);
  const byName = await call("agents.uid", { name: agent.toLowerCase() }).catch(() => null);
  if (byName && byName.data && byName.data.uid) keys.add(String(byName.data.uid));
  const byUid = await call("agents.uid", { uid: agent }).catch(() => null);
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
    forked_from: data.forked_from && data.forked_from.thread ? { thread: String(data.forked_from.thread), message: String(data.forked_from.message || "") } : null,
  };
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
  const keys = await agentKeys((tool, input) => d.ctx.call(tool, input), agent);
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
 * Register the thread tools that read and start. `chatTool` is the work module's own (it keeps the member door's copy), `createChat` the very function work.chat.create runs.
 * @param {{ ctx: any, chatTool: (name: string, def: any) => void, kernelOf: () => any, chainOf: (extra: any) => Promise<any>, chatRows: (chain: any, spec: any) => Promise<any[]>, createChat: (input: any, extra: any) => Promise<any> }} d
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
}
