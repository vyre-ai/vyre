// @ts-check
// Stuck is a state, not a mechanism (contract 9.4). The kernel owns the transitions and the one detection it can make itself: a permission refused three times in a
// task (`ask.observeDenial`, with its own fix built from the denials and its own seven-day cool-down, `ask.declineFix`). This watch measures what only the host of a
// session can see and reports it through the kernel's `ask.stuck`, as the task's doer (the kernel checks the transition table: a guarded task can never be skipped by
// its doer to avoid a check, R6-11). The fix it offers is quoted text with no one-tap power; a one-tap fix comes only from what the kernel observed (R6-7).
// The triggers here: the assistant says so; a budget refuses; a wait too long on a dependency or an approval; silence from a live session; a session that ended with no
// result; the same tool failing 5 times. Permission denials are the kernel's: `denied` hands them to `ask.observeDenial` and does not count them itself.

const FIFTEEN_MIN = 15 * 60_000;

/** A model's words as quoted text: control characters out, capped, never a link or button (T37). @param {string} s @param {number} [n] */
const quote = (s, n = 400) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * @typedef {{ id: string, doer: { id: string, kind: string }, checker?: any, output?: { kind: string }, state?: string }} WatchedTask
 * @param {{ kernel: any, chainOf: (task: WatchedTask) => any, detectChain?: any, clock?: () => number, stallAfterMs?: number, failLimit?: number,
 *   whoIsResponsible?: (task: WatchedTask) => string|null }} o `chainOf(task)`: the doer's own kernel-built chain (the session host holds it); `detectChain`: the kernel's detection chain, for `denied` (a platform gap: only the kernel's own module holds it)
 */
export function createStuckWatch({ kernel, chainOf, detectChain = null, clock = Date.now, stallAfterMs = FIFTEEN_MIN, failLimit = 5, whoIsResponsible = () => null }) {
  /** @type {Map<string, { task: WatchedTask, last: number, fails: Map<string, number>, session: boolean, waiting: { on: string, since: number }|null, moved: boolean }>} */
  const tasks = new Map();
  /** @type {{ task: string, reason: string, at: number }[]} */ const log = [];

  /** @param {WatchedTask} task @param {{ session?: boolean }} [o] */
  function track(task, { session = true } = {}) {
    tasks.set(task.id, { task, last: clock(), fails: new Map(), session, waiting: null, moved: false });
  }
  const get = (/** @type {string} */ id) => { const t = tasks.get(id); if (!t) throw Object.assign(new Error("not a watched task"), { code: "not_found" }); return t; };

  /**
   * Move the task to stuck, through the kernel, as its doer. The fix is text only.
   * @param {string} id @param {string} reason @param {{ text?: string }} [fix]
   */
  async function raise(id, reason, fix = {}) {
    const w = get(id);
    if (w.moved) return { moved: false, why: "already stuck" };
    const stuck = { reason: quote(reason, 300), since: clock(), ...(fix.text ? { suggested_fix: { text: quote(fix.text, 400) } } : {}) };
    try {
      await kernel.ask.stuck(chainOf(w.task), id, { reason: stuck.reason, ...(fix.text ? { suggested_fix: stuck.suggested_fix.text } : {}) });
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
    /**
     * 2. A permission was refused: the kernel counts it (three times for the same action and resource in a task makes it stuck, with a grant request it built, and a
     * cool-down once a person declines it). Needs the kernel's detection chain.
     * @param {string} id @param {{ action: string, resource: string }} o
     */
    async denied(id, { action, resource }) {
      const w = touch(id);
      if (!detectChain) return { moved: false, why: "no detection chain" };
      if (w.moved) return { moved: false, why: "already stuck" };
      try {
        const t = await kernel.ask.observeDenial(detectChain, id, { action, resource });
        if (t && t.state === "stuck") { w.moved = true; log.push({ task: id, reason: t.stuck.reason, at: clock() }); return { moved: true, stuck: t.stuck, responsible: whoIsResponsible(w.task) }; }
        return { moved: false };
      } catch (e) { return { moved: false, why: /** @type {any} */ (e).message, code: /** @type {any} */ (e).code }; }
    },
    /** 3. A meter will not reserve more. @param {string} id @param {{ meter: string }} o */
    async budget(id, { meter }) {
      touch(id);
      return raise(id, `Out of ${meter} for now.`, { text: `Raise the ${meter} limit, or wait for it to reset.` });
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
    /** Unblocked or reassigned: the task may become stuck again later. @param {string} id */
    cleared(id) { const w = get(id); w.moved = false; w.last = clock(); w.fails.clear(); w.waiting = null; w.session = true; },
  };
}
