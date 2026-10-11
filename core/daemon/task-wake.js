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
import { leadKind, leadBrief, parseLead, REPORT, MAX_STUCK_TIMES } from "./lead-turn.js";

const WAKE_EVENTS = /^task\.(created|readied|unblocked|reopened)$/;
const MAX_TURNS = 2;
const WORK_MS = 6 * 3600_000;
const DEFAULT_DAILY_LIMIT = 100;
const RESUME_EVERY_MS = 30 * 60_000;
const cut = (/** @type {unknown} */ s, /** @type {number} */ n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** What a provider's refusal says, in one word: the sign-in was refused, the quota or rate limit is spent, or nothing we know. @param {string} text */
export function classifyRefusal(text) {
  const m = String(text || "");
  if (/quota|rate.?limit|429|credit|billing|exceed|overloaded|usage limit/i.test(m)) return "quota";
  if (/401|403|unauthori[sz]ed|forbidden|invalid.*(key|token|credential)|expired|revoked|not signed in|please log ?in|login|authenticat/i.test(m)) return "auth";
  return "";
}

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

/**
 * The one grant a teammate agent holds to work a task: exactly this task and this agent, tasks.read and tasks.work, until `until`. Nothing else is ever asked of the kernel's mint.
 * @param {string} space @param {string} agent the agent's stable id @param {string} task @param {number} until
 */
export function taskGrantSpec(space, agent, task, until) {
  return { subject: { kind: "actor", actor: { kind: "agent", id: agent, space } }, actions: ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${space}/task/${task}` }, conditions: { when: { expires: until } }, source: `task-wake:${task}`, reason: "an agent teammate works the task it was given" };
}

/** @param {{ root: string, log?: (m: string) => void, hear: (type: string, fn: (e: any) => any) => (() => void) | void, callModule: (tool: string, input: any) => Promise<any> }} o */
export function createTaskWakeHost(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, { stop: () => void, wake: (id: string) => Promise<any> }>} */ const spaces = new Map();
  const dir = path.join(o.root, "task-wake");
  /** @type {(() => void)[]} */ const offs = [];
  /** thread id -> the task it works and the last whole text it said */
  /** @type {Map<string, { space: string, task: string, text: string, err?: string }>} */ const threads = new Map();
  /** @type {Map<string, (thread: string) => Promise<void>>} */ const finishers = new Map();

  offs.push(/** @type {any} */ (o.hear("thread.text", (/** @type {any} */ e) => {
    const w = threads.get(String(e.thread || ""));
    const p = e.payload || {};
    if (w && p.done && !p.kind && !p.notice) w.text = String(p.text || "");
    // what the provider said when it refused (a notice or an error line), kept to classify an empty turn
    else if (w && (p.notice || p.kind === "error" || p.error) && (p.text || p.error)) w.err = `${w.err || ""} ${String(p.error || p.text)}`.slice(-600);
  })) || (() => {}));
  offs.push(/** @type {any} */ (o.hear("thread.finished", (/** @type {any} */ e) => {
    const w = threads.get(String(e.thread || ""));
    if (!w) return;
    const fp = e.payload || {};
    if (fp.ok === false || fp.error || fp.reason) w.err = `${w.err || ""} ${String(fp.error || fp.reason || "")}`.slice(-600);
    const f = finishers.get(w.space);
    if (f) void f(String(e.thread)).catch(err => log(`task-wake ${w.space}: ${/** @type {Error} */ (err).message}`));
  })) || (() => {}));

  /** A small JSON ledger per Space: which tasks were woken, how many turns each has had. */
  function ledgerFor(/** @type {string} */ space) {
    const file = path.join(dir, `${space}.json`.replace(/[^A-Za-z0-9._-]/g, "_"));
    /** @type {{ tasks: Record<string, any>, days: Record<string, number>, reports: Record<string, number> }} */ let data = { tasks: {}, days: {}, reports: {} };
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = { tasks: {}, days: {}, reports: {} }; }
    if (!data.tasks) data.tasks = {};
    if (!data.reports) data.reports = {};
    if (!data.days) data.days = {};
    const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { log(`task-wake: the ledger was not saved (${/** @type {Error} */ (e).message})`); } };
    return { get: (/** @type {string} */ id) => data.tasks[id], set: (/** @type {string} */ id, /** @type {any} */ v) => { data.tasks[id] = { ...(data.tasks[id] || {}), ...v }; save(); }, all: () => data.tasks,
      reportAt: (/** @type {string} */ project) => data.reports[project], setReportAt: (/** @type {string} */ project, /** @type {number} */ at) => { data.reports[project] = at; save(); },
      /** turns the wake started today in a project, and one more */
      turns: (/** @type {string} */ key) => data.days[key] || 0, count: (/** @type {string} */ key) => { data.days[key] = (data.days[key] || 0) + 1; for (const k of Object.keys(data.days)) if (!k.endsWith(key.slice(-10))) delete data.days[k]; save(); } };
  }

  /**
   * @param {{ space: string, gw: any, chains: any, ownerChain: () => any, ownerId: () => string, notify?: (n: { person: string, project: string, title: string, note: string }) => Promise<any>, grantWork: { make: (agent: string, task: string, until: number) => Promise<any>, end: (task: string) => Promise<any> }, subscribe: (cb: (e: any) => any) => any, nameOf?: (person: string) => string, clock?: () => number, resumeEveryMs?: number, sweepAfterMs?: number, say?: (m: { project: string, slug: string, agent: string, text: string }) => Promise<any> }} s
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
    const dayKey = (/** @type {string} */ slug) => `${slug}|${new Date((s.clock || Date.now)()).toISOString().slice(0, 10)}`;
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
      return onTeam ? { slug: String(ref.slug), name: String(ref.name || ref.slug), agent: String(agent.name), urn: String(ref.urn), id: String(ref.id || "") } : null;
    }

    /** Flag the task stuck as its doer, with the words and the next step. @param {any} t @param {string} reason @param {string} fix */
    async function stuck(t, reason, fix) {
      try { await s.gw.ask.stuck(doerChain(t), t.id, { reason: cut(reason, 300), suggested_fix: cut(fix, 400) }); } catch (e) { log(`task-wake ${s.space}: ${t.id} could not be flagged stuck (${/** @type {Error} */ (e).message})`); }
      ledger.set(t.id, { state: "stuck", stuckTimes: ((ledger.get(t.id) || {}).stuckTimes || 0) + 1, at: (s.clock || Date.now)() });
      void s.grantWork.end(t.id).catch(() => {});
    }

    /** The roster of a project: each teammate's name and role, with their actor. @param {string} urn */
    async function rosterOf(urn) {
      const rows = (await s.gw.records.query(s.ownerChain(), "team-member", { filter: { field: "project", op: "eq", value: { urn } }, page: { limit: 200 } }).catch(() => ({ rows: [] }))).rows || [];
      const agents = await o.callModule("agents.list", {}).catch(() => null);
      const list = Array.isArray(agents) ? agents : agents && Array.isArray(agents.agents) ? agents.agents : [];
      return rows.filter((/** @type {any} */ x) => x.data && x.data.role && x.data.actor && x.data.actor.actor && x.data.actor.actor.kind === "agent").map((/** @type {any} */ x) => {
        const id = String(x.data.actor.actor.id), a = list.find((/** @type {any} */ y) => y && y.uid === id);
        return { agent: a ? String(a.name) : id, role: String(x.data.role), actor: x.data.actor.actor };
      });
    }

    /** Is this the project lead's own plan or report task? The lead is the agent the project record names. @param {any} t @param {{ id: string, agent: string }} r */
    async function leadTaskKind(t, r) {
      const kind = leadKind(t.title);
      if (!kind || !r.id) return null;
      const rec = await s.gw.records.get(s.ownerChain(), "project", r.id).catch(() => null);
      return rec && rec.data && String(rec.data.lead || "").toLowerCase() === r.agent.toLowerCase() ? kind : null;
    }

    /** The words for a turn: the task's own brief, or for the lead's plan and report the team and the project's tasks, numbered for this turn. @param {any} t @param {{ slug: string, name: string, agent: string, urn: string, id: string }} r */
    async function promptFor(t, r) {
      const kind = await leadTaskKind(t, r);
      if (!kind) return briefOf({ title: t.title, note: t.note, project: r.name });
      const roster = await rosterOf(r.urn);
      const all = (await s.gw.ask.list(s.ownerChain(), {}).catch(() => [])).filter((/** @type {any} */ x) => x && x.id !== t.id && (x.project === r.urn || x.record === r.urn));
      const named = new Map(roster.map((/** @type {any} */ m) => [m.actor.id, m.agent]));
      const tasks = all.slice(0, 60).map((/** @type {any} */ x, /** @type {number} */ i) => ({ n: i + 1, id: String(x.id), title: String(x.title), who: x.doer && x.doer.kind === "agent" ? (named.get(x.doer.id) || "an agent") : "a person", state: String(x.state), ...(x.stuck && x.stuck.reason ? { why: String(x.stuck.reason) } : {}), times: (ledger.get(x.id) || {}).stuckTimes || (x.state === "stuck" ? 1 : 0) }));
      ledger.set(t.id, { lead: kind, map: tasks.map(x => ({ n: x.n, id: x.id })) });
      return leadBrief({ kind, project: r.name, roster: roster.map((/** @type {any} */ m) => ({ agent: m.agent, role: m.role })), tasks });
    }

    /** Check a lead's picks and turn each into a recommendation for the person: only a stuck task, only to another teammate of this project whose role the lead named, and not one that has been stuck twice. Nothing is moved here. Returns the plain-words lines for the message. @param {any} t @param {{ slug: string, name: string, agent: string, urn: string, id: string }} r @param {{ task: number, to: string }[]} picks */
    async function recommendPicks(t, r, picks) {
      const rec = ledger.get(t.id) || {}, map = Array.isArray(rec.map) ? rec.map : [], roster = await rosterOf(r.urn), out = [];
      for (const p of picks) {
        const entry = map.find((/** @type {any} */ m) => m.n === p.task), target = roster.find((/** @type {any} */ m) => m.role === p.to && m.agent.toLowerCase() !== r.agent.toLowerCase());
        const cur = entry ? await s.gw.ask.get(s.ownerChain(), entry.id).catch(() => null) : null;
        const title = cur ? `"${cut(cur.title, 60)}"` : `task ${p.task}`;
        if (!cur || cur.state !== "stuck") { out.push(`I did not move ${title}: it is not stuck.`); continue; }
        if (!target) { out.push(`I did not move ${title}: no one else on the team holds the role ${p.to}.`); continue; }
        if (((ledger.get(cur.id) || {}).stuckTimes || 1) >= MAX_STUCK_TIMES) { out.push(`I did not move ${title}: it has been stuck twice. It needs you.`); continue; }
        if (!cur.doer || cur.doer.kind !== "agent") { out.push(`I did not move ${title}: a person has it.`); continue; }
        // The lead only RECOMMENDS: the daemon never acts as a person who is not there, and the lead has no authority of its own over another task yet. The person moves it in one tap.
        out.push(`I recommend moving ${title} to ${target.agent}, who holds the role ${p.to}. Open the task and choose to give it to ${target.agent}.`);
      }
      return out;
    }

    /** Start one turn for a task that is working. @param {any} t @param {{ slug: string, name: string, agent: string, urn: string, id: string }} r @param {number} turn */
    async function run(t, r, turn) {
      const person = assignerOf(t);
      let started;
      ledger.count(dayKey(r.slug));
      try {
        started = await o.callModule("agents.work", { agent: r.agent, project: r.slug, person, owner: person === s.ownerId(), prompt: await promptFor(t, r) });
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "account_attention") {
          const msg = String(/** @type {Error} */ (e).message), who = (/person:(\S+)/.exec(msg) || [])[1] || person, kind = (/kind:(\w+)/.exec(msg) || [])[1] || "other";
          const word = /** @type {Record<string, string>} */ ({ auth: "sign-in refused", quota: "out of quota or rate limited", removed: "account removed or not usable", other: "start failed" })[kind] || "start failed";
          const fix = /** @type {Record<string, string>} */ ({
            auth: "Sign in to the account again, or pick another account for agent work in the project's settings, then move this task back to ready.",
            quota: "Wait for the quota to reset, top it up, or pick another account for agent work in the project's settings, then move this task back to ready.",
            removed: "Pick another account for agent work in the project's settings, then move this task back to ready.",
            other: "Check the account under Settings, or pick another for agent work in the project's settings, then move this task back to ready.",
          })[kind] || "Pick another account for agent work in the project's settings, then move this task back to ready.";
          return stuck(t, `${nameOf(who)}'s AI account for agent work needs attention (${word})`, fix);
        }
        if (code === "account_required") return stuck(t, `needs ${nameOf(person)} to connect an AI account`, `${nameOf(person)} adds an AI account under Settings, then moves this task back to ready.`);
        return stuck(t, `the turn could not start: ${cut(/** @type {Error} */ (e).message, 160)}`, "Check the agent and its project, then move this task back to ready.");
      }
      threads.set(String(started.thread), { space: s.space, task: t.id, text: "" });
      ledger.set(t.id, { state: "woken", thread: String(started.thread), turns: turn, at: (s.clock || Date.now)() });
    }

    /** The day's limit on turns the wake starts by itself is spent: the task waits (it stays ready), and the person who gave it is told once a day. @param {any} t @param {{ slug: string, name: string }} r @param {number} limit */
    async function pause(t, r, limit) {
      ledger.set(t.id, { state: "paused", reason: "daily limit", at: (s.clock || Date.now)() });
      const key = `${dayKey(r.slug)}|told`;
      if (!ledger.get(key)) {
        ledger.set(key, { state: "notice" });
        const person = assignerOf(t);
        try { if (s.notify) await s.notify({ person, project: String(t.project), title: `Agent work paused on ${r.name}: daily limit`, note: `Agents have started ${limit} turns on ${r.name} today by themselves, which is this project's daily limit, so tasks given to them wait as "paused: daily limit". They start again tomorrow, or a member raises the limit in the project's agent work settings.` }); } catch (e) { log(`task-wake ${s.space}: the daily-limit notice was not raised (${/** @type {Error} */ (e).message})`); }
      }
      return ledger.get(t.id);
    }

    /**
     * The lead's report is a duty: every project with a lead gets a report task for its lead once a day (the project's setting says how often, or off), which wakes like any teammate's task. The first
     * time a project is seen it is only marked: its plan is the first word, not a report.
     */
    async function reports() {
      const now = (s.clock || Date.now)();
      const projects = (await s.gw.records.query(s.ownerChain(), "project", { page: { limit: 500 } }).catch(() => ({ rows: [] }))).rows || [];
      for (const p of projects) {
        if (stopped || !p.data || !p.data.lead) continue;
        const slug = String(p.data.slug || ""), set = await o.callModule("agents.work.setting", { project: slug }).catch(() => null);
        const hours = set && set.report_hours !== null && set.report_hours !== undefined ? Number(set.report_hours) : 24;
        if (!hours) continue;   // off for this project
        const last = ledger.reportAt(p.id);
        if (last === undefined) { ledger.setReportAt(p.id, now); continue; }
        if (now - last < hours * 3600_000) continue;
        const roster = await rosterOf(p.urn), lead = roster.find((/** @type {any} */ m) => m.agent.toLowerCase() === String(p.data.lead).toLowerCase());
        if (!lead) continue;
        const open = (await s.gw.ask.list(s.ownerChain(), { doer: lead.actor.id, state: ["ready", "working"] }).catch(() => [])).some((/** @type {any} */ x) => String(x.title || "").startsWith(REPORT) && x.project === p.urn);
        if (open) continue;
        try {
          await s.gw.ask.request(s.ownerChain(), { title: `${REPORT}${String(p.data.name || slug)}`, note: "The project's regular report for the person.", project: p.urn, record: p.urn, doer: lead.actor, output: { kind: "note" } });
          ledger.setReportAt(p.id, now);
        } catch (e) { log(`task-wake ${s.space}: the report for ${slug} was not asked for (${/** @type {Error} */ (e).message})`); }
      }
    }

    /** Paused tasks start again once the day's count allows it. */
    async function resumePaused() {
      for (const [id, rec] of Object.entries(ledger.all())) if (!stopped && rec && rec.state === "paused") await wake(id);
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
      const set = await o.callModule("agents.work.setting", { project: r.slug }).catch(() => null);
      const limit = (set && set.daily_limit) || DEFAULT_DAILY_LIMIT;
      if (ledger.turns(dayKey(r.slug)) >= limit) return pause(t, r, limit);
      ledger.set(id, { state: "starting", turns: 0, at: (s.clock || Date.now)() });
      try {
        const until = (s.clock || Date.now)() + WORK_MS;
        await s.grantWork.make(t.doer.id, id, until);
        ledger.set(id, { until, agent: t.doer.id });
        await s.gw.ask.start(doerChain(t), id);
      }
      catch (e) { ledger.set(id, { state: "skipped" }); void s.grantWork.end(id).catch(() => {}); log(`task-wake ${s.space}: ${id} was not started (${/** @type {Error} */ (e).message})`); return null; }
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
      if (!text && classifyRefusal(w.err || "")) {
        const kind = classifyRefusal(w.err || ""), person = assignerOf(t);
        return stuck(t, `${nameOf(person)}'s AI account for agent work needs attention (${kind === "quota" ? "out of quota or rate limited" : "sign-in refused"})`,
          kind === "quota" ? "Wait for the quota to reset, top it up, or pick another account for agent work in the project's settings, then move this task back to ready." : "Sign in to the account again, or pick another account for agent work in the project's settings, then move this task back to ready.");
      }
      if (!text) {
        // a turn that ended with neither a result nor a flag is tried once more, then flagged
        if (rec.turns < MAX_TURNS && r) { ledger.set(id, { state: "starting" }); return run(t, r, rec.turns + 1); }
        return stuck(t, "the agent's turn ended without a result", "Move this task back to ready to try again, or give it to someone else.");
      }
      let note = text;
      if (rec.lead && r) {
        const parsed = parseLead(text);
        const lines = parsed.picks.length ? await recommendPicks(t, r, parsed.picks) : [];
        if (parsed.ignored) lines.push("I could not read my own list of moves, so I made none.");
        note = [parsed.message || "No message.", ...lines].join("\n");
        try { if (s.say) await s.say({ project: r.urn, slug: r.slug, agent: r.agent, text: note }); } catch (e) { log(`task-wake ${s.space}: the lead's message was not posted (${/** @type {Error} */ (e).message})`); }
      }
      try {
        await s.gw.ask.complete(doerChain(t), id, { note, sources: [`session:${thread}`] });
        ledger.set(id, { state: "done", at: (s.clock || Date.now)() });
        void s.grantWork.end(id).catch(() => {});
      } catch (e) {
        return stuck(t, `the result was not accepted: ${cut(/** @type {Error} */ (e).message, 200)}`, "Open the task, read what the agent wrote, and finish it by hand.");
      }
    }
    finishers.set(s.space, thread => track(turnEnded(thread)));

    /**
     * After a restart: a task that was being worked when the daemon stopped has no turn any more. It gets one more turn (a task has at most two), then it is flagged stuck with the reason.
     * A task that never got as far as working is woken as new.
     */
    async function recover() {
      for (const [id, rec] of Object.entries(ledger.all())) {
        if (stopped || !rec || (rec.state !== "woken" && rec.state !== "starting")) continue;
        if (rec.thread && threads.has(rec.thread)) continue;   // its turn is still running in this process
        const t = await s.gw.ask.get(s.ownerChain(), id).catch(() => null);
        if (!t) { ledger.set(id, { state: "finished" }); continue; }
        if (t.state === "ready") { ledger.set(id, { state: "skipped" }); await wake(id); continue; }
        if (t.state !== "working") { ledger.set(id, { state: "finished" }); continue; }
        const r = await resolve(t);
        // the grant the stopped turn held is ended and a fresh one made: a restart never extends the old expiry
        if (r && rec.turns < MAX_TURNS) {
          try { await s.grantWork.end(id); const until = (s.clock || Date.now)() + WORK_MS; await s.grantWork.make(t.doer.id, id, until); ledger.set(id, { state: "starting", until }); }
          catch (e) { log(`task-wake ${s.space}: ${id} could not be given a fresh grant (${/** @type {Error} */ (e).message})`); continue; }
          await run(t, r, rec.turns + 1);
        }
        else await stuck(t, "the server restarted while the agent was working on this", "Move this task back to ready to start it again.");
      }
    }

    /**
     * The task grant lives only as long as the agent has a reason to hold it. For every task being worked: it was handed in or moved on (end the grant); it went to another doer (end it); the agent
     * is no longer a teammate of the project, or the project is gone (flag the task, then end it); its time ran out with the task still working (flag the task, then end it). The flag comes first
     * because the agent's own chain needs the grant to flag its task.
     */
    async function sweep() {
      for (const [id, rec] of Object.entries(ledger.all())) {
        if (stopped || !rec || (rec.state !== "woken" && rec.state !== "starting")) continue;
        const t = await s.gw.ask.get(s.ownerChain(), id).catch(() => null);
        const end = async (/** @type {string} */ why) => { threads.forEach((w, th) => { if (w.task === id) threads.delete(th); }); ledger.set(id, { state: why }); await s.grantWork.end(id).catch(() => {}); };
        if (!t || t.state !== "working" || !t.doer || t.doer.id !== rec.agent) { await end("finished"); continue; }
        if ((s.clock || Date.now)() >= (rec.until || Infinity)) { await stuck(t, "the agent's time on this task ran out", "Move this task back to ready to give the agent a fresh turn, or give it to someone else."); await end("stuck"); continue; }
        if (!(await resolve(t))) { await stuck(t, "the agent is no longer a teammate of this project, or the project is gone", "Add the agent back to the project's team, or give the task to someone else."); await end("stuck"); }
      }
    }
    /** @type {NodeJS.Timeout | null} */ let sweepTimer = null;
    const sweepSoon = () => { if (sweepTimer || stopped) return; sweepTimer = setTimeout(() => { sweepTimer = null; void track(sweep()); }, s.sweepAfterMs ?? 2000); if (typeof sweepTimer.unref === "function") sweepTimer.unref(); };

    const sub = s.subscribe((/** @type {any} */ e) => {
      if (!stopped && e && Object.values(ledger.all()).some(r => r && (r.state === "woken" || r.state === "starting"))) sweepSoon();
      if (stopped || !e || !WAKE_EVENTS.test(String(e.type)) || !e.data || e.data.state !== "ready") return;
      const t = e.data.task;
      if (!t || !t.doer || t.doer.kind !== "agent") return;
      return track(wake(String(t.id)));
    });

    const timer = setInterval(() => { void track(resumePaused()); void track(sweep()); void track(reports()); }, s.resumeEveryMs || RESUME_EVERY_MS); if (typeof timer.unref === "function") timer.unref();
    const host = Object.freeze({
      wake: (/** @type {string} */ id) => wake(id),
      recover: () => track(recover().then(resumePaused).then(reports)),
      resumePaused: () => track(resumePaused()),
      sweep: () => track(sweep()),
      reports: () => track(reports()),
      /** Wait for the work in flight (a test, or a stop). */
      async idle() { while (inflight.size) await Promise.all([...inflight]); },
      stop() { stopped = true; clearInterval(timer); if (sweepTimer) clearTimeout(sweepTimer); finishers.delete(s.space); try { if (typeof sub === "function") sub(); else if (sub && typeof sub.stop === "function") sub.stop(); } catch { /* already stopped */ } },
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
