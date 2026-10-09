// @ts-check
// "Run on this computer": the words and rules for the UX half of R031-95, without a screen. A session runs on this Mac or on the server, and the person is told where and, when it moved, why.
// The box (session-transfer's runner) answers with a placement { where, computer, reason, since }, settings, and the sessions running here; this turns them into the chip, the chat line, the
// Settings page's limits and the list. Pure, so Node tests it.

/** Why a session is on the server, in the words a person uses. A code the app does not know is shown plainly, never as the code. */
export const REASON_WORDS = /** @type {Record<string, string>} */ ({
  "lid-closed": "lid closed", asleep: "this Mac went to sleep", unplugged: "this Mac is on battery", "cpu-cap": "it used more processor than you allow", "mem-cap": "it used more memory than you allow",
  "switched-off": "running on this Mac is switched off", offline: "this Mac is offline", crash: "it stopped unexpectedly, and was resumed from its last step", you: "you moved it",
});
const why = (/** @type {string | null | undefined} */ r) => (r ? REASON_WORDS[r] || "this Mac could not run it" : "");

/** @typedef {{ where: "mac" | "server", computer?: string, reason?: string | null, since?: number | null }} Placement */

/** The chip on a session. Tapping it offers the other place. @param {Placement | null | undefined} p */
export function chipOf(p) {
  if (!p) return null;
  const mac = p.where === "mac";
  const name = (p.computer || "").trim();
  return { label: mac ? (name ? `On ${name}` : "On this Mac") : "On the server", tone: /** @type {"ok" | "plain"} */ (mac ? "ok" : "plain"), moveTo: /** @type {"mac" | "server"} */ (mac ? "server" : "mac"),
    moveLabel: mac ? "Move to the server" : "Move to this Mac", why: mac ? "" : why(p.reason) };
}

/** The one line in the chat when a session moves. @param {{ to: string, reason?: string | null }} e */
export function movedLine(e) {
  const where = e.to === "mac" ? "this Mac" : "the server";
  const w = why(e.reason);
  return `Moved to ${where}${w ? `: ${w}` : ""}.`;
}

/** The limits a person may set. Percent of one core's worth is how the box counts; memory is in megabytes. @typedef {{ enabled: boolean, pluggedInOnly: boolean, cpuPercent: number, memoryMb: number }} MacSettings */
export const LIMIT_RANGE = { cpuPercent: [10, 100], memoryMb: [512, 65536] };
export const DEFAULT_SETTINGS = /** @type {MacSettings} */ ({ enabled: false, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 });

/** What the box sent, kept to what is known. @param {any} d @returns {MacSettings} */
export function pickSettings(d) {
  const n = (/** @type {any} */ v, /** @type {number} */ dflt) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  return { enabled: Boolean(d && d.enabled), pluggedInOnly: d && typeof d.pluggedInOnly === "boolean" ? d.pluggedInOnly : DEFAULT_SETTINGS.pluggedInOnly, cpuPercent: n(d && d.cpuPercent, DEFAULT_SETTINGS.cpuPercent), memoryMb: n(d && d.memoryMb, DEFAULT_SETTINGS.memoryMb) };
}

/** A limit typed by the person: the number inside the range, or a sentence saying what is allowed. @param {"cpuPercent" | "memoryMb"} key @param {string} text */
export function parseLimit(key, text) {
  const [lo, hi] = LIMIT_RANGE[key], v = Number(String(text).replace(/[, ]/g, ""));
  if (!Number.isFinite(v) || !Number.isInteger(v)) return { error: `Use a whole number from ${lo} to ${hi}.` };
  if (v < lo || v > hi) return { error: `Use a number from ${lo} to ${hi}.` };
  return { value: v };
}

/** The sentence under the switch. @param {MacSettings} s */
export function switchNote(s) {
  if (!s.enabled) return "Sessions run on the server. Turn this on to let them run on this Mac too.";
  return `Sessions may run on this Mac${s.pluggedInOnly ? " while it is plugged in" : ""}, up to ${s.cpuPercent}% of the processor and ${s.memoryMb >= 1024 ? `${Math.round(s.memoryMb / 102.4) / 10} GB` : `${s.memoryMb} MB`} of memory. Past a limit, a session moves to the server and carries on.`;
}

/** The sessions running here, for the Settings page and the menu bar. @param {any} d */
export function pickHere(d) {
  const list = Array.isArray(d) ? d : d && Array.isArray(d.sessions) ? d.sessions : [];
  return list.filter((/** @type {any} */ x) => x && typeof x.thread === "string").map((/** @type {any} */ x) => ({
    thread: String(x.thread), title: String(x.title || "A session"), state: /** @type {"running" | "waiting" | "paused"} */ (x.state === "waiting" || x.state === "paused" ? x.state : "running"),
    cpuPercent: typeof x.cpuPercent === "number" ? Math.round(x.cpuPercent) : 0, memoryMb: typeof x.memoryMb === "number" ? Math.round(x.memoryMb) : 0 }));
}

/** One row of the list: the title and what it is using. @param {ReturnType<typeof pickHere>[number]} s */
export function hereLine(s) {
  const mem = s.memoryMb >= 1024 ? `${Math.round(s.memoryMb / 102.4) / 10} GB` : `${s.memoryMb} MB`;
  return { title: s.title, sub: `${s.state === "paused" ? "Paused" : s.state === "waiting" ? "Waiting for you" : "Running"}, ${s.cpuPercent}% processor, ${mem}` };
}

/** The line for a session that did not run here. @param {string | null | undefined} code */
export const whyNotLine = (code) => (code ? `It did not run on this Mac because ${why(code)}.` : "It ran where it was meant to.");
