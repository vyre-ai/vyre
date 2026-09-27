// @ts-check
// A fake app for tests: answers the helper's requests from a state object, so the hands can be
// driven without a screen. `onAct` decides what an action does to the state; by default a press
// does nothing, which is exactly the case the hands must not report as a success.

/**
 * @param {{ window?: string, elements: any[], texts?: string[], app?: string, bundle?: string, origin?: string, front?: boolean }} state
 * @param {(req: any, state: any) => any} [onAct]
 */
export function fakeApp(state, onAct = () => ({ acted: true })) {
  /** @type {any[]} */
  const calls = [];
  const head = () => ({ app: state.app ?? "Calculator", pid: 4242, bundle: state.bundle ?? "com.apple.calculator", front: state.front ?? true,
    window: state.window ?? "Calculator", ...(state.origin ? { origin: state.origin } : {}) });
  const run = async (/** @type {any} */ req) => {
    calls.push(req);
    if (req.cmd === "where") return head();
    if (req.cmd === "snap") {
      return structuredClone({ ...head(), elements: state.elements, texts: state.texts || [], truncated: false });
    }
    if (req.cmd === "act") {
      // As the helper: a key to an app in the background is refused, never posted into nothing.
      if (req.kind === "key" && state.front === false) {
        const { HandsError } = await import("./runner.js");
        throw new HandsError("needs_front", `${state.app ?? "Calculator"} is in the background; a key only reaches the app in front`);
      }
      const el = state.elements.find(e => e.path === req.path);
      if (!el || el.role !== req.role || (req.name && el.name !== req.name)) {
        const { HandsError } = await import("./runner.js");
        throw new HandsError("moved", `the element at ${req.path} changed; nothing was done`);
      }
      return { path: req.path, role: el.role, kind: req.kind, ...onAct(req, state) };
    }
    throw new Error("unexpected " + req.cmd);
  };
  return { run, calls, state };
}

/** A fake overlay that records what the hands told it, and can press the stop keys. */
export function fakeOverlay() {
  /** @type {any[]} */
  const sent = [];
  /** @type {Array<() => void>} */
  const stops = [];
  return {
    sent,
    async controlling(/** @type {string} */ app, /** @type {any} */ at) { sent.push({ controlling: { app, ...(at || {}) } }); },
    ring(/** @type {any} */ r) { sent.push({ ring: r }); },
    done() { sent.push({ done: true }); },
    close() { sent.push({ close: true }); },
    onStop(/** @type {() => void} */ fn) { stops.push(fn); },
    /** What the helper does on Escape: print {"stop":true}. */
    pressStop() { for (const fn of stops) fn(); },
  };
}
