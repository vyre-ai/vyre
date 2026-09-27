// @ts-check
// Which of the sessions tools this box has: the one place that knows (shared core, no DOM).
//
// Chat is built against tools the sessions team has not shipped yet (threads.unqueue, .edit,
// .steer, .rewind, .checkpoints, .mode, .model, .commands, .shell, .remember, .thinking, .tasks,
// .kill_task, sessions.models). The Deck gets no list of tools, so each is learnt lazily: the
// first call that comes back "no such tool" marks it missing, and every control that needs it
// is disabled from then on with NEEDS_UPDATE as its title. A tool that answered once is known
// to be there. Listeners hear each change, so a control drawn before the answer updates.

export const NEEDS_UPDATE = "Needs the sessions update";

/** The tools chat calls that older boxes lack. */
export const SESSION_TOOLS = Object.freeze([
  "threads.interrupt", "threads.unqueue", "threads.edit", "threads.steer", "threads.rewind", "threads.checkpoints",
  "threads.mode", "threads.model", "sessions.models", "threads.commands", "threads.shell", "threads.remember",
  "threads.thinking", "threads.tasks", "threads.kill_task",
]);

const MISSING_CODES = new Set(["no_such_tool", "unknown_tool", "http_404"]);

/**
 * Did a call fail because the tool is not on this box? vyred says no_such_tool (HTTP 404). A
 * not_found counts only when it is about the tool: the same code also means "no such thread" or
 * "no such message", which must not switch a control off for good.
 * @param {any} err
 */
export const isMissing = err => !!err && (err.missing === true || MISSING_CODES.has(String(err.code || ""))
  || (err.code === "not_found" && /\btool\b/i.test(String(err.message || ""))));

/**
 * @returns {{ has: (tool: string) => boolean|null, set: (tool: string, ok: boolean) => void,
 *   on: (fn: (tool: string, ok: boolean) => void) => () => void,
 *   use: <T>(tool: string, run: () => Promise<{ data?: T, error?: any }>) => Promise<{ data?: T, error?: any, missing?: boolean }> }}
 */
export function createCaps() {
  /** @type {Map<string, boolean>} */
  const known = new Map();
  /** @type {Set<(tool: string, ok: boolean) => void>} */
  const subs = new Set();
  const set = (/** @type {string} */ tool, /** @type {boolean} */ ok) => {
    if (known.get(tool) === ok) return;
    known.set(tool, ok);
    for (const fn of subs) { try { fn(tool, ok); } catch {} }
  };
  return {
    /** true: answered before; false: missing; null: not asked yet. */
    has: tool => (known.has(tool) ? /** @type {boolean} */ (known.get(tool)) : null),
    set,
    on(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    /** Call a tool through `run` (the surface's own call), and learn from the answer. A missing tool is not called again. */
    async use(tool, run) {
      if (known.get(tool) === false) return { error: { code: "no_such_tool", message: NEEDS_UPDATE }, missing: true };
      const r = await run();
      if (r && r.error) {
        if (isMissing(r.error)) { set(tool, false); return { ...r, missing: true }; }
        return r;
      }
      set(tool, true);
      return r;
    },
  };
}

/** The page's one probe: every chat view on a surface shares what it learnt. */
export const CAPS = createCaps();
