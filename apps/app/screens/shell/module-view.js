// @ts-check
// A module's view in the app (SPEC-0.3.0 module surface): what to draw from a frame, and what to do with an action's answer. Pure, so the rules are tested without a screen.
// The module's code never runs here. The server (core/views) reads the module's `views` declaration, calls the module's own tool and answers one small frame; the app draws that frame with
// its own components and sends back ids and a few typed values, never tool names. An outward action answers a preview first: the exact words, and a token the second call must return.

/** @typedef {{ id: string, title: string, subtitle?: string, accessory?: string, icon?: string, group?: string, actions?: any[] }} ViewRow */

/** The tool input for a view's frame. @param {{ module: string, view: string, q?: string, id?: string, form?: string }} a */
export function getInput(a) {
  return { module: a.module, command: a.view, ...(a.q ? { q: a.q } : {}), ...(a.id ? { id: a.id, view: "detail" } : {}), ...(a.form ? { form: a.form, view: "form" } : {}) };
}

/** The tool input for an action: ids and typed values, plus the preview's proof when the person said yes to an outward one. @param {{ module: string, view: string, action: string, id?: string, column?: string, q?: string, form?: string, fields?: Record<string, string>, asked?: { hash: string, token: string } | null }} a */
export function actInput(a) {
  return { module: a.module, command: a.view, action: a.action, ...(a.id ? { id: a.id } : {}), ...(a.column ? { column: a.column } : {}), ...(a.q ? { q: a.q } : {}), ...(a.form ? { form: a.form } : {}),
    ...(a.fields ? { fields: a.fields } : {}), ...(a.asked ? { asked: { hash: a.asked.hash, token: a.asked.token } } : {}) };
}

/** A form's required fields that are still empty: their labels. @param {any} frame @param {Record<string, string>} values */
export function missingFields(frame, values) {
  return (Array.isArray(frame && frame.fields) ? frame.fields : []).filter((/** @type {any} */ f) => f.required && !String(values[f.name] ?? "").trim()).map((/** @type {any} */ f) => String(f.label || f.name));
}

/** The form values to start from: each field empty, or its first choice for a choice with a default. @param {any} frame */
export function initialValues(frame) {
  return Object.fromEntries((Array.isArray(frame && frame.fields) ? frame.fields : []).map((/** @type {any} */ f) => [f.name, f.type === "choice" && Array.isArray(f.choices) && f.choices[0] && f.required ? String(typeof f.choices[0] === "string" ? f.choices[0] : f.choices[0].id ?? f.choices[0].value ?? "") : ""]));
}

/**
 * What the screen does with the server's answer to an action.
 *   reload    the action is done; say so and read the view again
 *   frame     show this frame (a form, or a detail)
 *   preview   show the exact words and ask; "Send" calls the action again with `asked`
 *   open      open this link (https and mailto only; the server has already refused the rest)
 *   copy      put this text on the clipboard
 *   command   go to another view of the same module
 *   held      say that it waits for the person's OK at the Gate
 *   needs     say what is missing (a connection or a key)
 *   error     say what went wrong
 * @param {any} r
 */
export function outcome(r) {
  if (!r || typeof r !== "object") return { effect: "error", message: "That did not work." };
  if (r.kind === "view" && r.frame) return { effect: "frame", frame: r.frame };
  if (r.kind === "preview") return { effect: "preview", title: String(r.title || ""), words: Array.isArray(r.words) ? r.words : [], asked: { hash: String(r.hash || ""), token: String(r.token || "") } };
  if (r.kind === "push") return { effect: "command", command: String(r.command || "") };
  if (r.kind === "held") return { effect: "held", message: String(r.message || "Waiting for your OK.") };
  if (r.kind === "needs") return { effect: "needs", message: String(r.message || "A connection is missing."), ...(r.need ? { need: r.need } : {}) };
  if (r.kind === "error") return { effect: "error", message: String(r.message || "That did not work.") };
  if (r.kind === "done" && r.effect && typeof r.effect === "object") {
    const [kind, value] = Object.entries(r.effect)[0] || [];
    if (kind === "open") return { effect: "open", url: String(value) };
    if (kind === "copy") return { effect: "copy", text: String(value) };
    return { effect: "reload", said: `${kind === "ask" ? "Ask" : "Say"}: ${String(value)}`.slice(0, 300) };
  }
  if (r.kind === "done") return { effect: "reload", said: String(r.said || "Done.") };
  return { effect: "error", message: "That did not work." };
}

/** The move a drop on a column asks for, or null when the card is already there or the view has no move. @param {any} card @param {string} to @param {string} from @param {any[]} actions */
export function moveAction(card, to, from, actions) {
  if (!card || to === from || to === "other") return null;
  const a = (Array.isArray(actions) ? actions : []).find(x => x && x.id === "move");
  return a ? { action: "move", id: String(card.id), column: to } : null;
}

/** Bars for a summary's chart: each point's height as a share of the largest, at least a sliver for a non-zero value. @param {{ points: { label: string, value: number }[] } | undefined} chart */
export function barHeights(chart) {
  const pts = chart && Array.isArray(chart.points) ? chart.points : [];
  const max = Math.max(0, ...pts.map(p => p.value));
  return pts.map(p => ({ label: p.label, value: p.value, share: max > 0 ? Math.max(p.value > 0 ? 0.04 : 0, p.value / max) : 0 }));
}

/** The row actions a card or row offers on every row: the frame's own, in order. The Capsule shortcut hints are not shown here. @param {ViewRow} row @param {any[]} [fallback] */
export function actionsOf(row, fallback) {
  const own = Array.isArray(row && row.actions) ? row.actions : fallback || [];
  return own.filter((/** @type {any} */ a) => a && a.id && a.id !== "move").map((/** @type {any} */ a) => ({ id: String(a.id), title: String(a.title || a.id), outward: Boolean(a.outward) }));
}
