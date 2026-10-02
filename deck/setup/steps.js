// @ts-check
// The ten steps of the one setup flow, as the person's own address sees them: steps 1 to 7 are done by the time anyone is here
// (the passkey is made at this address), so this draws the same list the setup page draws (site/setup/flow.js, kept equal by
// steps.test.js) with 8 to 10 live. Pure: no DOM, no network. The state comes from onboard.status, the server's own record.

export const STEPS = Object.freeze([
  { id: "install", title: "Install", where: "On your server", optional: false },
  { id: "words", title: "Check the words", where: "On your server", optional: false },
  { id: "address", title: "Choose your address", where: "In your browser", optional: false },
  { id: "tailscale", title: "Connect Tailscale", where: "In your browser", optional: false },
  { id: "ai", title: "Sign in to your AI", where: "In your browser", optional: false },
  { id: "phone", title: "Add your phone", where: "In your browser", optional: true },
  { id: "passkey", title: "Create your passkey", where: "At your address", optional: false },
  { id: "assistant", title: "You and your assistant", where: "At your address", optional: false },
  { id: "computers", title: "Your computers", where: "At your address", optional: true },
  { id: "history", title: "Your history", where: "At your address", optional: true },
]);

/**
 * Where steps 8 to 10 stand, from onboard.status. `passed` holds steps the person moved past in this tab that the server does not
 * record as done (the history list is read-only, so Continue is only a page move). `skipped` is the server's own skipped list.
 * @param {any} status onboard.status's answer, or null before it arrives
 * @param {{ passed?: string[] }} [local]
 */
export function setupSteps(status, local = {}) {
  const st = status || {};
  const passed = new Set(local.passed || []);
  const steps = st.steps || {}, detail = st.detail || {};
  const person = typeof st.person === "string" && st.person.trim() !== "";
  const mac = detail.devices && detail.devices.mac && detail.devices.mac.connected === true;
  const skipped = id => (id === "computers" ? steps.devices : steps[id]) === "skipped";
  /** @type {Record<string, "done"|"skipped"|"todo">} */
  const own = {
    assistant: person ? "done" : "todo",
    computers: mac ? "done" : skipped("computers") || passed.has("computers") ? "skipped" : "todo",
    history: skipped("history") ? "skipped" : passed.has("history") ? "done" : "todo",
  };
  const firstTodo = ["assistant", "computers", "history"].find(id => own[id] === "todo") || null;
  const list = STEPS.map((s, i) => {
    const n = i + 1;
    const status = n <= 7 ? "done" : own[s.id] === "todo" ? (s.id === firstTodo ? "current" : "todo") : own[s.id];
    return { ...s, n, status };
  });
  return { list, current: firstTodo, number: firstTodo ? STEPS.findIndex(s => s.id === firstTodo) + 1 : 10, finished: firstTodo === null };
}
