// @ts-check
// Which of the sessions tools this box has: the one place that knows (shared core, no DOM).
//
// The sessions contract (core/switchboard on work/sessions): threads.interrupt, .unqueue, .edit,
// .send-now (a dash), .rewind, .mode, .model and .commands are live (sessions.models.get lists
// the model per purpose), and since 034c71e5 .shell ("!"), .remember ("#"), .thinking, .tasks,
// .kill-task and images on threads.send; an older box may still lack them. The Deck gets no list of tools, so each
// is learnt lazily: the first call that comes back "no such tool" marks it missing, and every
// control that needs it is disabled from then on with NEEDS_UPDATE as its title. A tool that
// answered once is known to be there. Listeners hear each change, so a control drawn before the
// answer updates.
//
// Images on send are a feature, not a tool: nothing answers "no such tool" for them (an older box
// drops a field it does not know). They shipped with threads.tasks, which the session view asks
// on open, so its answer says it for the images and for the other tools of that release (LINKED).
// A box that has not answered yet keeps images off (composer.js asks first).
//
// What the contract does not offer yet (NOT_OFFERED) starts off on the page's probe, so those
// controls are off from the first draw and never called. Empty now: everything chat calls ships.

export const NEEDS_UPDATE = "Needs the sessions update";

/** The contract's tools chat calls that older boxes lack. */
export const SESSION_TOOLS = Object.freeze([
  "threads.interrupt", "threads.unqueue", "threads.edit", "threads.send-now", "threads.rewind", "threads.mode",
  "threads.model", "threads.commands", "sessions.models.get",
  "threads.shell", "threads.remember", "threads.thinking", "threads.tasks", "threads.kill-task",
  // "Fork from here" (native-core/pickers.js's rewindSheet, session.js's onFork): no probe rides in
  // on another tool's answer yet (nothing calls threads.fork until the reader actually tries it),
  // so it stays off until then even on a box that has it. Worth a LINKED entry, once native-core
  // or sessions says which release ships it alongside, the way REWIND_CODE rides on threads.commands.
  "threads.fork",
]);

/** Images sent with threads.send: a feature, not a tool, so it has a name of its own here. */
export const SEND_IMAGES = "threads.send:images";

/**
 * threads.rewind with restore "code" or "both" (files put back): a feature of threads.rewind, not
 * a tool. It shipped with threads.model and threads.commands, so the answer either gives (there
 * or missing) says it for this one too (LINKED).
 */
export const REWIND_CODE = "threads.rewind:code";

/** What shipped together in sessions 034c71e5: threads.tasks' answer says it for all of them. */
export const RELEASE_034 = Object.freeze(["threads.shell", "threads.remember", "threads.thinking", "threads.kill-task", SEND_IMAGES]);

/** Features that came in with a tool: what the tool's answer says holds for them too. */
const LINKED = Object.freeze(/** @type {Record<string, readonly string[]>} */ ({
  "threads.model": [REWIND_CODE], "threads.commands": [REWIND_CODE],
  "threads.tasks": RELEASE_034,
}));

/** Not offered by the server yet: off from the start on the page's probe. */
export const NOT_OFFERED = Object.freeze(/** @type {string[]} */ ([]));

const MISSING_CODES = new Set(["no_such_tool", "unknown_tool", "http_404"]);

/**
 * Did a call fail because the tool is not on this box? vyred says no_such_tool (HTTP 404). A
 * box that did not answer (offline; api.js calls that "missing" too) is not a verdict. A
 * not_found counts only when it is about the tool: the same code also means "no such thread" or
 * "no such message", which must not switch a control off for good.
 * @param {any} err
 */
export const isMissing = err => !!err && err.code !== "offline" && (err.missing === true || MISSING_CODES.has(String(err.code || ""))
  || (err.code === "not_found" && /\btool\b/i.test(String(err.message || ""))));

/**
 * @param {{ off?: readonly string[] }} [o] tools known missing from the start (no listener hears them)
 * @returns {{ has: (tool: string) => boolean|null, set: (tool: string, ok: boolean) => void,
 *   on: (fn: (tool: string, ok: boolean) => void) => () => void,
 *   use: <T>(tool: string, run: () => Promise<{ data?: T, error?: any }>) => Promise<{ data?: T, error?: any, missing?: boolean }> }}
 */
export function createCaps(o = {}) {
  /** @type {Map<string, boolean>} */
  const known = new Map((o.off || []).map(t => [t, false]));
  /** @type {Set<(tool: string, ok: boolean) => void>} */
  const subs = new Set();
  const set = (/** @type {string} */ tool, /** @type {boolean} */ ok) => {
    if (known.get(tool) === ok) return;
    known.set(tool, ok);
    for (const fn of subs) { try { fn(tool, ok); } catch {} }
    for (const f of LINKED[tool] || []) set(f, ok);
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
export const CAPS = createCaps({ off: NOT_OFFERED });
