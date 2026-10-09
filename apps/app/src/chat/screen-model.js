// @ts-check
// The pure half of the live screen cards: the one word for a run's state, the step track, and the sign-in card's words. Node tests it; OperatorCard.tsx and SigninCard.tsx draw them.

/** @param {string} state */
export const runWord = (state) => ({ working: "Working", done: "Done", stuck: "Needs you", paused: "Paused" }[state] ?? "Working");

/** The step track: at most seven dots, the newest last; the current one is the run's state when that is still going. @param {{ line: string, state: string }[]} steps */
export const dots = (steps) => steps.slice(-7).map((s) => ({ line: s.line, state: ["working", "done", "stuck", "paused"].includes(s.state) ? s.state : "done" }));

/** The sign-in card's words by state. @param {{ site: string, state: string }} b */
export function signinWords(b) {
  if (b.state === "done") return { title: `Signed in to ${b.site}`, detail: "The assistant carries on from here. It never saw the page or your password." };
  if (b.state === "cancelled") return { title: `Sign in to ${b.site}`, detail: "You put this away." };
  if (b.state === "expired") return { title: `Sign in to ${b.site}`, detail: "This waited too long. Ask the assistant again." };
  return { title: `Sign in to ${b.site}`, detail: "Open the screen and sign in yourself. While you do, the assistant cannot see the page and gets no password. Hand back when you are done." };
}
