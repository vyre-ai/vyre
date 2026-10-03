// @ts-check
// Stuck is a state, not a mechanism (contract 9.4). The kernel cannot read a model's mind, so this watches what can be measured, plus the assistant
// saying so. It reports a task stuck through the kernel's own move (`kernel.tasks.move`, which checks the transition table: a guarded task can never
// be skipped by its doer to avoid a check, R6-11) with a reason and a fix composed here from the cause, never from a model's words (R6-7):
//  - a permission fix is a structured request built from observed denials, scoped to the task, never a model's text;
//  - a model's own suggested fix is quoted text, labelled as the doer's, with no one-tap action;
//  - the same request is offered once, then not again for the cool-down (7 days), so a stuck loop cannot wear a person down.
// The seven triggers: the assistant says so; a permission refused 3 times; a budget refuses; a wait too long on a dependency or an approval;
// silence from a live session; a session that ended with no result; the same tool failing 5 times.

const DAY = 86_400_000;
const FIFTEEN_MIN = 15 * 60_000;

/** A model's words as quoted text: control characters out, capped, never a link or button (T37). @param {string} s @param {number} [n] */
const quote = (s, n = 400) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * @typedef {{ id: string, doer: { id: string, kind: string }, checker?: any, output?: { kind: string }, state?: string }} WatchedTask
 * @param {{ kernel: any, chain: any, clock?: () => number, stallAfterMs?: number, denyLimit?: number, failLimit?: number, coolDownMs?: number,
 *   whoIsResponsible?: (task: WatchedTask) => string|null }} o `chain`: the kernel-built chain of the watch itself (a service hop), which may move a task to stuck
 */
export function createStuckWatch({ kernel, chain, clock = Date.now, stallAfterMs = FIFTEEN_MIN, denyLimit = 3, failLimit = 5, coolDownMs = 7 * DAY, whoIsResponsible = () => null }) {
  /** @type {Map<string, { task: WatchedTask, last: number, denials: Map<string, number>, fails: Map<string, number>, session: boolean, waiting: { on: string, since: number }|null, moved: boolean }>} */
  const tasks = new Map();
  /** @type {Map<string, number>} fix key to the time it was last offered */
  const offered = new Map();
  /** @type {{ task: string, reason: string, at: number }[]} */ const log = [];

  /** @param {WatchedTask} task @param {{ session?: boolean }} [o] */
  function track(task, { session = true } = {}) {
    tasks.set(task.id, { task, last: clock(), denials: new Map(), fails: new Map(), session, waiting: null, moved: false });
  }
  const get = (/** @type {string} */ id) => { const t = tasks.get(id); if (!t) throw Object.assign(new Error("not a watched task"), { code: "not_found" }); return t; };

  /**
   * Move the task to stuck. The fix: `action` only when the kernel built it from observation and it was not offered inside the cool-down.
   * @param {string} id @param {string} reason @param {{ text?: string, action?: any, key?: string }} [fix]
   */
  async function raise(id, reason, fix = {}) {
    const w = get(id);
    if (w.moved) return { moved: false, why: "already stuck" };
    let action = fix.action;
    let text = fix.text || "";
    if (action && fix.key) {
      const at = offered.get(fix.key);
      if (at !== undefined && clock() - at < coolDownMs) { action = undefined; text = `${text} This was offered before and not taken up; it is not offered again for now.`.trim(); }
      else offered.set(fix.key, clock());
    }
    const stuck = { reason: quote(reason, 300), since: clock(), ...(text || action ? { suggested_fix: { text: quote(text, 500), ...(action ? { action } : {}) } } : {}) };
    try {
      await kernel.tasks.move(chain, id, "stuck", { stuck });
      w.moved = true;
      log.push({ task: id, reason: stuck.reason, at: clock() });
      return { moved: true, stuck, responsible: whoIsResponsible(w.task) };
    } catch (e) {
      return { moved: false, why: /** @type {any} */ (e).message, code: /** @type {any} */ (e).code };
    }
  }

  const touch = (/** @type {string} */ id) => { const w = get(id); w.last = clock(); return w; };

  return {
    track, raise, log,
    /** Any event from the task's session: it is alive and not silent. @param {string} id */
    heard(id) { touch(id); },
    /** 1. The assistant says so (tool tasks.stuck): its words are quoted, they give no one-tap power. @param {string} id @param {{ reason: string, suggested_fix?: string }} o */
    said(id, { reason, suggested_fix }) {
      const w = get(id);
      return raise(id, reason, suggested_fix ? { text: `From ${w.task.doer.id}: "${quote(suggested_fix)}"` } : {});
    },
    /** 2. A permission was refused: three times for the same action and resource makes it stuck, with a grant request built here. @param {string} id @param {{ action: string, resource: string }} o */
    async denied(id, { action, resource }) {
      const w = touch(id);
      const k = `${action}\u0000${resource}`;
      const n = (w.denials.get(k) || 0) + 1;
      w.denials.set(k, n);
      if (n < denyLimit) return { moved: false, count: n };
      return raise(id, `${w.task.doer.id} was refused ${action} on ${resource} ${n} times.`, {
        text: `Allow ${action} on ${resource} for this task, or reassign it.`, key: `grant\u0000${w.task.doer.id}\u0000${k}`,
        action: { kind: "grant_request", resource, action_name: action, scope: { task: id } } });
    },
    /** 3. A meter will not reserve more. @param {string} id @param {{ meter: string }} o */
    async budget(id, { meter }) {
      touch(id);
      return raise(id, `Out of ${meter} for now.`, { text: `Raise the ${meter} limit, or wait for it to reset.`, key: `budget\u0000${meter}`, action: { kind: "raise_budget", action_name: meter, scope: { task: id } } });
    },
    /** 4. It waits on a dependency or an approval. Checked on tick. @param {string} id @param {{ on: string, since?: number }|null} o */
    waitingOn(id, o) { get(id).waiting = o ? { on: o.on, since: o.since ?? clock() } : null; },
    /** 5 and 4: the timers. Call at most once a minute from whatever already wakes the project. Returns what moved. */
    async tick() {
      /** @type {any[]} */ const out = [];
      for (const [id, w] of tasks) {
        if (w.moved) continue;
        if (w.waiting && clock() - w.waiting.since >= stallAfterMs) out.push(await raise(id, `Still waiting on ${w.waiting.on}.`, { text: `Check ${w.waiting.on}, or reassign the task.` }));
        else if (w.session && w.task.state !== "waiting" && clock() - w.last >= stallAfterMs) out.push(await raise(id, `No activity from ${w.task.doer.id} for ${Math.round(stallAfterMs / 60_000)} minutes.`, { text: "Open the session to see what it is doing, or reassign the task." }));
      }
      return out;
    },
    /** 6. The session ended without a result (a crash, a lost node, a kill). @param {string} id @param {{ result: boolean }} o */
    sessionEnded(id, { result }) {
      const w = get(id); w.session = false;
      return result ? Promise.resolve({ moved: false }) : raise(id, `${w.task.doer.id}'s session ended without a result.`, { text: "Start it again, or reassign the task." });
    },
    /** 7. The same tool fails again and again. @param {string} id @param {string} tool */
    async toolFailed(id, tool) {
      const w = touch(id);
      const n = (w.fails.get(tool) || 0) + 1;
      w.fails.set(tool, n);
      if (n < failLimit) return { moved: false, count: n };
      return raise(id, `${tool} failed ${n} times in a row for ${w.task.doer.id}.`, { text: `Look at why ${tool} fails, or reassign the task.` });
    },
    /** A fix the person declined: not offered again for the cool-down. @param {string} key */
    declined(key) { offered.set(key, clock()); },
    /** Unblocked or reassigned: the task may become stuck again later. @param {string} id */
    cleared(id) { const w = get(id); w.moved = false; w.last = clock(); w.denials.clear(); w.fails.clear(); w.waiting = null; w.session = true; },
  };
}
