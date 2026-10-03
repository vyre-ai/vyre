// @ts-check
// "Research is reading harlowlegal.com": the live line under a project's stage, derived from a teammate session's events (contract 9.4). Nothing
// polls: a line is computed when an event arrives and handed out at most once per 60 seconds per teammate; the last one waits for the next
// event or an external tick. The clock is injectable.

const MIN_MS = 60_000;
const VERBS = Object.freeze({ Read: "reading", Glob: "looking through", Grep: "searching", WebFetch: "reading", WebSearch: "searching the web for", Write: "writing", Edit: "editing", Bash: "running", Task: "asking for help with" });

/** @param {string} s */
const clean = s => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
/** A url or path as a short target: the host, or the file name. @param {string} t */
function target(t) {
  const s = clean(t);
  try { const u = new URL(s); return u.host; } catch { /* not a url */ }
  return s.split("/").filter(Boolean).at(-1) || s;
}

/**
 * The line one session event says, or null when it says nothing new (a text delta) or the teammate stopped.
 * @param {{ type: string, data?: any }} e @returns {string|null|undefined} undefined: this event does not change the line
 */
export function lineOf(e) {
  const d = e.data || {};
  if (e.type === "thread.finished" || e.type === "thread.stopped") return null;
  if (e.type === "thread.tool" && d.name) {
    const verb = /** @type {any} */ (VERBS)[d.name] || "working on";
    const what = target(d.summary || d.target || "");
    return what ? `${verb} ${what}` : verb;
  }
  if (e.type === "thread.started" || e.type === "thread.turn") return "getting started";
  if (e.type === "task.stuck") return "stuck";
  return undefined;
}

/**
 * @param {any} kernel
 * @param {{ project: string, clock?: () => number, minIntervalMs?: number, onLine?: (teammate: string, line: string|null) => void, nameOf?: (teammate: string) => string }} o
 */
export function createDoingLine(kernel, { project, clock = Date.now, minIntervalMs = MIN_MS, onLine = () => {}, nameOf = id => id.charAt(0).toUpperCase() + id.slice(1) }) {
  const every = Math.max(MIN_MS, minIntervalMs);
  /** @type {Map<string, { shown: string|null, at: number, pending: string|null|undefined }>} */ const state = new Map();
  const slot = (/** @type {string} */ t) => { let s = state.get(t); if (!s) { s = { shown: null, at: -Infinity, pending: undefined }; state.set(t, s); } return s; };
  const words = (/** @type {string} */ t, /** @type {string|null} */ l) => (l ? `${nameOf(t)} is ${l}` : null);

  /** Hand out the pending line if a minute has passed. @param {string} t */
  function publish(t) {
    const s = slot(t);
    if (s.pending === undefined) return false;
    if (clock() - s.at < every && s.shown !== null) return false;
    s.shown = s.pending === null ? null : words(t, s.pending); s.at = clock(); s.pending = undefined;
    onLine(t, s.shown);
    return true;
  }
  /** One session event of a teammate. @param {string} teammate @param {{ type: string, data?: any }} e */
  function observe(teammate, e) {
    const l = lineOf(e);
    if (l === undefined) return;
    slot(teammate).pending = l;
    publish(teammate);
  }
  return {
    observe,
    /** Let a due line go out (called by whatever already wakes the project, at most once a minute). */
    tick() { for (const t of state.keys()) publish(t); },
    /** The line to show now for a teammate, or null. @param {string} t */
    line: t => slot(t).shown,
    /** Follow a project's events through the kernel. A teammate is the agent actor of the event. Returns the unsubscribe. @param {any} chain */
    attach(chain) {
      return kernel.events.subscribe(chain, `doing:${project}`, { subject_prefix: project }, (/** @type {any} */ e) => {
        const a = String(e.actor || "");
        if (a.startsWith("agent:")) observe(a.slice(6).split("@")[0], e);
      });
    },
  };
}
