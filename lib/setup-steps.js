// @ts-check
// The setup step list the box holds (#11): the same ten steps the setup page draws (site/setup/flow.js STEPS, app-design), each done, current,
// skipped or todo, worked out from what is true on the box plus two small saved sets (steps the person skipped, steps they passed). The page, the
// onboarding module and `sudo vyre setup` all read this one list, so closing the page loses nothing.

/** The page's exact list: id, title, where it happens, and whether the person may leave it for later. */
export const SETUP_STEPS = Object.freeze([
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
].map(s => Object.freeze(s)));

/** The steps a person may skip and finish later from Settings, Setup (ai and phone can be skipped too, #52). */
export const SKIPPABLE = Object.freeze(["ai", "phone", "computers", "history"]);
/** The steps only the person passes (the box cannot see it): history is done once they have been through it. */
export const PASSABLE = Object.freeze(["history"]);

/**
 * @typedef {{ install?: boolean, words?: boolean, address?: boolean, tailscale?: boolean, ai?: boolean, phone?: boolean, passkey?: boolean, assistant?: boolean, computers?: boolean, history?: boolean }} Facts
 *   what the box can see is true for each step
 * @typedef {"done"|"current"|"skipped"|"todo"} StepStatus
 */

/**
 * The list the page and the terminal draw. A step is done when the box sees it is, else skipped when the person skipped it (and it may be), else todo; the
 * first step that is neither done nor skipped is the current one, and the rest after it are todo. Skipped steps stay listed as skipped.
 * @param {Facts} facts @param {{ skipped?: string[], passed?: string[] }} [saved]
 * @returns {{ steps: { id: string, title: string, where: string, optional: boolean, n: number, status: StepStatus }[], current: string|null, finished: boolean, skipped: string[] }}
 */
export function setupList(facts, saved = {}) {
  const skipped = new Set((saved.skipped || []).filter(id => SKIPPABLE.includes(id)));
  const passed = new Set(saved.passed || []);
  const done = id => Boolean(/** @type {any} */ (facts)[id]) || (PASSABLE.includes(id) && passed.has(id));
  let current = null;
  const steps = SETUP_STEPS.map((s, i) => {
    /** @type {StepStatus} */ let status = done(s.id) ? "done" : skipped.has(s.id) ? "skipped" : "todo";
    if (status === "todo" && current === null) { current = s.id; status = "current"; }
    return { ...s, n: i + 1, status };
  });
  return { steps, current, finished: current === null, skipped: steps.filter(s => s.status === "skipped").map(s => s.id) };
}

/**
 * `sudo vyre setup`'s words, from the list (design section 5 of the setup flow): where setup stands, the ten steps with a tick or a circle, and the one
 * place to continue. Plain text lines, no colour.
 * @param {ReturnType<typeof setupList>} list @param {{ address?: string|null, notes?: Record<string, string> }} [o] address: where the person continues once the passkey step is reached
 */
export function setupLines(list, { address = null, notes = {} } = {}) {
  const cur = list.steps.find(s => s.id === list.current);
  if (list.finished) {
    const left = list.steps.filter(s => s.status === "skipped");
    return [`Setup is finished.${address ? ` Vyre is running at ${address}` : ""}`,
      ...(left.length ? [`Skipped: ${left.map(s => s.title).join(", ")}. Open Settings, Setup to do ${left.length === 1 ? "it" : "them"}.`] : [])];
  }
  const head = `Vyre setup: step ${cur.n} of ${list.steps.length}, ${cur.title}`;
  if (cur.where === "At your address") {
    return [head, `Steps 1 to ${cur.n - 1} are done${list.skipped.length ? ` or skipped` : ""}.`, "", address ? `Continue at ${address}` : "Continue at your server's address."];
  }
  return [head, "",
    ...list.steps.map(s => `${s.status === "done" ? "✓" : s.status === "skipped" ? "–" : "○"} ${s.title}${s.optional ? " (optional)" : ""}${s.status === "skipped" ? " (skipped)" : ""}${notes[s.id] ? `     ${notes[s.id]}` : ""}`),
    "", "Go back to the vyre.run/setup tab to continue. If you closed it,", "run this for a link to carry on from this server:  sudo vyre setup --new-link"];
}
