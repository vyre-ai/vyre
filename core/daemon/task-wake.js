// @ts-check
// core/daemon/task-wake.js: an agent teammate does the task it is given (G08). A task whose doer is an agent, ready and in a project the agent is a teammate of, wakes that agent: it starts the task,
// runs one turn as the agent in a side thread, and hands the turn's reply in as the task's result (or flags the task stuck). Nothing here polls: the kernel's task events wake it, and a task is woken once
// (a ledger on disk, so a restart does not wake it again).
//
// Whose account and where: the turn runs on the account of the person who assigned the task (the person who started the Flow or applied the template), through the agents module's `agents.work`, on this
// machine, which is the project's server. Never another member's account and never a member's computer. A person with no usable account makes the task stuck, in words that name the next step; there is
// no silent fallback to someone else's account.
//
// G22 stays as it is: the task is moved to working first (the kernel's reach guard opens a project to an agent only while it works a task there), every read stays logged, and the reach closes when the
// task is handed in or flagged stuck. The doer chain is the kernel's own `agent_session` chain for [assigner, agent]; the daemon vouches for it because the daemon started the session.
import fs from "node:fs";
import path from "node:path";

const WAKE_EVENTS = /^task\.(created|readied|unblocked|reopened)$/;
const MAX_TURNS = 2;
const WORK_MS = 6 * 3600_000;
const cut = (/** @type {unknown} */ s, /** @type {number} */ n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The words the agent is given. The reply is the result, so it is told to reply and nothing else.
 * @param {{ title: string, note?: string, project: string }} t
 */
export function briefOf(t) {
  return [
    `You have a task in the project ${t.project}.`,
    `Task: ${cut(t.title, 300)}`,
    ...(t.note ? [`Details: ${cut(t.note, 2000)}`] : []),
    "Do the work now, using what this project gives you. When you are finished, reply with a short plain-text result: what you did and where it is. That reply is handed in as the task's result.",
    "If you cannot do it, start your reply with STUCK: and say exactly what is missing and who could give it.",
  ].join("\n");
}

/** @param {{ root: string, log?: (m: string) => void, hear: (type: string, fn: (e: any) => any) => (() => void) | void, callModule: (tool: string, input: any) => Promise<any> }} o */
export function createTaskWakeHost(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, { stop: () => void, wake: (id: string) => Promise<any> }>} */ const spaces = new Map();
  const dir = path.join(o.root, "task-wake");
  /** @type {(() => void)[]} */ const offs = [];
  /** thread id -> the task it works and the last whole text it said */
  /** @type {Map<string, { space: string, task: string, text: string }>} */ const threads = new Map();
  /** @type {Map<string, (thread: string) => Promise<void>>} */ const finishers = new Map();

  offs.push(/** @type {any} */ (o.hear("thread.text", (/** @type {any} */ e) => {
    const w = threads.get(String(e.thread || ""));
    const p = e.payload || {};
    if (w && p.done && !p.kind && !p.notice) w.text = String(p.text || "");
  })) || (() => {}));
  offs.push(/** @type {any} */ (o.hear("thread.finished", (/** @type {any} */ e) => {
    const w = threads.get(String(e.thread || ""));
    if (!w) return;
    const f = finishers.get(w.space);
    if (f) void f(String(e.thread)).catch(err => log(`task-wake ${w.space}: ${/** @type {Error} */ (err).message}`));
  })) || (() => {}));

  /** A small JSON ledger per Space: which tasks were woken, how many turns each has had. */
  function ledgerFor(/** @type {string} */ space) {
    const file = path.join(dir, `${space}.json`.replace(/[^A-Za-z0-9._-]/g, "_"));
    /** @type {{ tasks: Record<string, any> }} */ let data = { tasks: {} };
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = { tasks: {} }; }
    if (!data.tasks) data.tasks = {};
    const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { log(`task-wake: the ledger was not saved (${/** @type {Error} */ (e).message})`); } };
    return { get: (/** @type {string} */ id) => data.tasks[id], set: (/** @type {string} */ id, /** @type {any} */ v) => { data.tasks[id] = { ...(data.tasks[id] || {}), ...v }; save(); }, all: () => data.tasks };
  }

  /**
   * @param {{ space: string, gw: any, chains: any, ownerChain: () => any, ownerId: () => string, grantWork: { make: (agent: string, task: string, until: number) => Promise<any>, end: (task: string) => Promise<any> }, subscribe: (cb: (e: any) => any) => any, nameOf?: (person: string) => string, clock?: () => number }} s
   */
  function attach(s) {
    if (spaces.has(s.space)) return spaces.get(s.space);
    const ledger = ledgerFor(s.space);
    const nameOf = s.nameOf || ((/** @type {string} */ p) => p);
    let stopped = false;
    /** the tasks being claimed right now: two events for one task (created, then readied) wake it once */
    const claiming = new Set();
    /** @type {Set<Promise<any>>} */ const inflight = new Set();
    const track = (/** @type {Promise<any>} */ p) => { const q = p.catch(err => log(`task-wake ${s.space}: ${/** @type {Error} */ (err).message}`)); inflight.add(q); void q.finally(() => inflight.delete(q)); return q; };

    /** The doer's own chain for a task: [the assigner, the agent], vouched by this daemon, which started the session. @param {any} t */
    const doerChain = (/** @type {any} */ t) => s.chains.fromFacts({ kind: "agent_session", vouched: true, person: assignerOf(t), agent: t.doer.id, session: `wake-${t.id}` });
    const assignerOf = (/** @type {any} */ t) => (t.assigned_by && t.assigned_by.kind === "person" ? String(t.assigned_by.id) : s.ownerId());

    /** The project's short name, the agent's name, and whether the agent is on the project's team. @param {any} t */
    async function resolve(t) {
      if (!t.project) return null;
      const ref = await o.callModule("work.project.ref", { project: String(t.project) }).catch(() => null);
      if (!ref || !ref.slug) return null;
      const agents = await o.callModule("agents.list", {}).catch(() => null);
      const list = Array.isArray(agents) ? agents : agents && Array.isArray(agents.agents) ? agents.agents : [];
      const agent = list.find((/** @type {any} */ a) => a && a.uid === t.doer.id);
      if (!agent) return null;
      const rows = (await s.gw.records.query(s.ownerChain(), "team-member", { filter: { field: "project", op: "eq", value: { urn: ref.urn } }, page: { limit: 500 } }).catch(() => ({ rows: [] }))).rows || [];
      const onTeam = rows.some((/** @type {any} */ r) => r.data && r.data.actor && r.data.actor.actor && r.data.actor.actor.kind === "agent" && String(r.data.actor.actor.id) === t.doer.id);
      return onTeam ? { slug: String(ref.slug), name: String(ref.name || ref.slug), agent: String(agent.name) } : null;
    }

    /** Flag the task stuck as its doer, with the words and the next step. @param {any} t @param {string} reason @param {string} fix */
    async function stuck(t, reason, fix) {
      try { await s.gw.ask.stuck(doerChain(t), t.id, { reason: cut(reason, 300), suggested_fix: cut(fix, 400) }); } catch (e) { log(`task-wake ${s.space}: ${t.id} could not be flagged stuck (${/** @type {Error} */ (e).message})`); }
      ledger.set(t.id, { state: "stuck", at: (s.clock || Date.now)() });
      void s.grantWork.end(t.id).catch(() => {});
    }

    /** Start one turn for a task that is working. @param {any} t @param {{ slug: string, name: string, agent: string }} r @param {number} turn */
    async function run(t, r, turn) {
      const person = assignerOf(t);
      let started;
      try {
        started = await o.callModule("agents.work", { agent: r.agent, project: r.slug, person, owner: person === s.ownerId(), prompt: briefOf({ title: t.title, note: t.note, project: r.name }) });
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "account_required") return stuck(t, `needs ${nameOf(person)} to connect an AI account`, `${nameOf(person)} adds an AI account under Settings, then moves this task back to ready.`);
        return stuck(t, `the turn could not start: ${cut(/** @type {Error} */ (e).message, 160)}`, "Check the agent and its project, then move this task back to ready.");
      }
      threads.set(String(started.thread), { space: s.space, task: t.id, text: "" });
      ledger.set(t.id, { state: "woken", thread: String(started.thread), turns: turn, at: (s.clock || Date.now)() });
    }

    /** A task is ready for an agent: wake it, once. @param {string} id */
    async function wake(id) {
      const had = ledger.get(id);
      if (stopped || claiming.has(id) || (had && (had.state === "starting" || had.state === "woken"))) return null;   // already being worked; a task a person moved back to ready is woken again
      claiming.add(id);
      try { return await wakeOnce(id); } finally { claiming.delete(id); }
    }
    async function wakeOnce(/** @type {string} */ id) {
      const t = await s.gw.ask.get(s.ownerChain(), id).catch(() => null);
      if (!t || t.state !== "ready" || !t.doer || t.doer.kind !== "agent") return null;
      const r = await resolve(t);
      if (!r) return null;
      ledger.set(id, { state: "starting", turns: 0, at: (s.clock || Date.now)() });
      try {
        await s.grantWork.make(t.doer.id, id, (s.clock || Date.now)() + WORK_MS);
        await s.gw.ask.start(doerChain(t), id);
      }
      catch (e) { ledger.set(id, { state: "skipped" }); log(`task-wake ${s.space}: ${id} was not started (${/** @type {Error} */ (e).message})`); return null; }
      await run(t, r, 1);
      return ledger.get(id);
    }

    /** A woken turn ended: hand its reply in, or try once more, or flag the task. @param {string} thread */
    async function turnEnded(thread) {
      const w = threads.get(thread);
      if (!w) return;
      threads.delete(thread);
      const id = w.task, rec = ledger.get(id);
      if (!rec || rec.state !== "woken" || rec.thread !== thread) return;
      const t = await s.gw.ask.get(s.ownerChain(), id).catch(() => null);
      if (!t || t.state !== "working") { ledger.set(id, { state: "finished" }); return; }
      const text = w.text.trim();
      const r = await resolve(t);
      if (/^STUCK:/i.test(text)) return stuck(t, text.replace(/^STUCK:\s*/i, ""), "Give the agent what it asked for, then move this task back to ready.");
      if (!text) {
        // a turn that ended with neither a result nor a flag is tried once more, then flagged
        if (rec.turns < MAX_TURNS && r) { ledger.set(id, { state: "starting" }); return run(t, r, rec.turns + 1); }
        return stuck(t, "the agent's turn ended without a result", "Move this task back to ready to try again, or give it to someone else.");
      }
      try {
        await s.gw.ask.complete(doerChain(t), id, { note: text, sources: [`session:${thread}`] });
        ledger.set(id, { state: "done", at: (s.clock || Date.now)() });
        void s.grantWork.end(id).catch(() => {});
      } catch (e) {
        return stuck(t, `the result was not accepted: ${cut(/** @type {Error} */ (e).message, 200)}`, "Open the task, read what the agent wrote, and finish it by hand.");
      }
    }
    finishers.set(s.space, thread => track(turnEnded(thread)));

    const sub = s.subscribe((/** @type {any} */ e) => {
      if (stopped || !e || !WAKE_EVENTS.test(String(e.type)) || !e.data || e.data.state !== "ready") return;
      const t = e.data.task;
      if (!t || !t.doer || t.doer.kind !== "agent") return;
      return track(wake(String(t.id)));
    });

    const host = Object.freeze({
      wake: (/** @type {string} */ id) => wake(id),
      /** Wait for the work in flight (a test, or a stop). */
      async idle() { while (inflight.size) await Promise.all([...inflight]); },
      stop() { stopped = true; finishers.delete(s.space); try { if (typeof sub === "function") sub(); else if (sub && typeof sub.stop === "function") sub.stop(); } catch { /* already stopped */ } },
    });
    spaces.set(s.space, host);
    return host;
  }

  return Object.freeze({
    attach,
    get: (/** @type {string} */ space) => spaces.get(space) || null,
    stop() { for (const h of spaces.values()) h.stop(); spaces.clear(); for (const f of offs) { try { f(); } catch { /* gone */ } } offs.length = 0; },
  });
}
