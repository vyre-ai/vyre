// @ts-check
// A fake app for tests: answers the helper's requests from a state object, so the hands can be
// driven without a screen. `onAct` decides what an action does to the state; by default a press
// does nothing, which is exactly the case the hands must not report as a success.

/**
 * @param {{ window?: string, elements: any[], texts?: string[] }} state
 * @param {(req: any, state: any) => any} [onAct]
 */
export function fakeApp(state, onAct = () => ({ acted: true })) {
  /** @type {any[]} */
  const calls = [];
  const run = async (/** @type {any} */ req) => {
    calls.push(req);
    if (req.cmd === "snap") {
      return structuredClone({ app: "Calculator", pid: 4242, front: true, window: state.window ?? "Calculator", elements: state.elements, texts: state.texts || [], truncated: false });
    }
    if (req.cmd === "act") {
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
