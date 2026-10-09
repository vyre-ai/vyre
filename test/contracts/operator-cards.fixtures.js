// @ts-check
// Fixtures for contracts/operator-cards.md (team/contracts/operator-cards.md). A consumer builds against these while chat builds the real cards: operations drives the cards from Vyre Computer,
// design draws them. Every value here is checked against the real tools and events by test/contracts/operator-cards.test.js, so a fixture that drifts from the producer fails there.

export const THREAD = "thr_contract";

export const operatorFixtures = {
  /** What the driver sends and gets back. */
  calls: {
    operator: { input: { computer: "kit", title: "Kit's computer", thread: THREAD }, output: { run: "0123456789ab", state: "working" } },
    step: { input: { run: "0123456789ab", line: "Opening the workflow list", state: "working" }, output: { run: "0123456789ab", state: "working" } },
    stuck: { input: { run: "0123456789ab", line: "The site asked for a code I do not have", state: "stuck", ask: "The 6-digit code" }, output: { run: "0123456789ab", state: "stuck" } },
    runGet: { input: { run: "0123456789ab", wait_ms: 1000 }, output: { run: "0123456789ab", state: "working", reply: "123456" } },
    signin: { input: { computer: "kit", site: "GoHighLevel", why: "I need to look at the workflow", thread: THREAD, wait_ms: 0 }, output: { id: "0123456789ab", state: "waiting" } },
    ask: {
      input: { title: "Which computer?", thread: THREAD, wait_ms: 0, questions: [{ id: "computer", prompt: "Which computer should I use?", choices: [{ label: "The cloud computer", detail: "always on" }, "Your Mac"], allowText: true }] },
      output: { id: "0123456789ab", title: "Which computer?", state: "waiting", questions: [{ id: "computer", prompt: "Which computer should I use?", choices: [{ label: "The cloud computer", detail: "always on" }, { label: "Your Mac" }], allowText: true, optional: false }] },
    },
    answered: { id: "0123456789ab", title: "Which computer?", state: "answered", questions: [], answers: { computer: { choice: "Your Mac" } }, lines: ["Which computer should I use? Your Mac"] },
  },
  /** The payloads on the thread's event stream; the app draws a card from each. */
  events: {
    "thread.operator": { run: "0123456789ab", computer: "kit", title: "Kit's computer", state: "working", line: "Opening the workflow list", ask: "", steps: [{ line: "Opening the workflow list", state: "working" }] },
    "thread.signin": { id: "0123456789ab", computer: "kit", site: "GoHighLevel", why: "I need to look at the workflow", state: "waiting" },
    "thread.questions": { id: "0123456789ab", title: "Which computer?", state: "waiting", questions: [{ id: "computer", prompt: "Which computer should I use?", choices: [{ label: "The cloud computer", detail: "always on" }, { label: "Your Mac" }], allowText: true, optional: false }] },
  },
  states: { operator: ["working", "done", "stuck", "paused"], signin: ["waiting", "done", "cancelled", "expired"], ask: ["waiting", "answered", "cancelled", "expired"] },
  limits: { stepLine: 160, steps: 7, reply: 500, signinsWaiting: 10, asksWaiting: 20, waitMs: 55_000, questions: 6, choices: 8, runHours: 6, askMinutes: 30 },
};

/** Whether `got` has the same keys and value types as `want` (arrays: every element has the shape of the first one in `want`; a key missing from `want` is extra). For checking an event against a fixture. @param {any} got @param {any} want @returns {string} "" when the shape matches, else where it does not */
export function shapeDiff(got, want, at = "$") {
  const kind = (/** @type {any} */ v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  if (kind(got) !== kind(want)) return `${at}: ${kind(got)}, wanted ${kind(want)}`;
  if (kind(want) === "array") { for (let i = 0; i < got.length && want.length; i++) { const d = shapeDiff(got[i], want[0], `${at}[${i}]`); if (d) return d; } return ""; }
  if (kind(want) !== "object") return "";
  for (const k of Object.keys(want)) { if (!(k in got)) { if (k === "detail" || k === "reply" || k === "answers" || k === "lines") continue; return `${at}.${k}: missing`; } const d = shapeDiff(got[k], want[k], `${at}.${k}`); if (d) return d; }
  for (const k of Object.keys(got)) if (!(k in want) && !["detail", "answers", "lines"].includes(k)) return `${at}.${k}: not in the contract`;
  return "";
}
