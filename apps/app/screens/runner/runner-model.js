// @ts-check
// "Run on this computer": the words and rules for the UX half of R031-95, without a screen. A session runs on this Mac or on the server, and the person is told where and, when it moved, why.
// The box (session-transfer's runner) answers with a placement { where, computer, reason, since }, settings, and the sessions running here; this turns them into the chip, the chat line, the
// Settings page's limits and the list. Pure, so Node tests it.
import { spaceTitle } from "../devices/device-model.js";

/** Why a session is on the server, in the words a person uses. A code the app does not know is shown plainly, never as the code. */
export const REASON_WORDS = /** @type {Record<string, string>} */ ({
  "lid-closed": "lid closed", asleep: "this Mac went to sleep", unplugged: "this Mac is on battery", "cpu-cap": "it used more processor than you allow", "mem-cap": "it used more memory than you allow",
  "switched-off": "running on this Mac is switched off", offline: "this Mac is offline", crash: "it stopped unexpectedly, and was resumed from its last step", you: "you moved it",
  "lease-expired": "this Mac stopped checking in", "version-skew": "this Mac runs an older Vyre", folder: "this chat works in a folder on your Mac",
});
/** The reason in words; a code this app does not know says nothing (the line stays "Moved to the server."), never the code. */
const why = (/** @type {string | null | undefined} */ r) => (r ? REASON_WORDS[r] || "" : "");

/** @typedef {{ where: "mac" | "server", computer?: string, reason?: string | null, since?: number | null, state?: "here" | "moving" | "server" | "locked" | "updating" | "paused", offer?: "mac" | null, pinned?: boolean, pin?: "server" | "mac" | null, epoch?: number }} Placement */

/**
 * The chip on a session. Tapping it offers the other place. While it is moving the chip says only that; "locked", "updating" and "paused" say so without a menu; and when the lid has opened the
 * session stays on the server with an offer to bring it back, which the chip asks as a question.
 * @param {Placement | null | undefined} p
 */
export function chipOf(p) {
  if (!p) return null;
  const mac = p.where === "mac";
  const name = (p.computer || "").trim();
  const fixed = (/** @type {string} */ label, /** @type {"ok" | "plain"} */ tone = "plain") => ({ label, tone, moveTo: /** @type {"mac" | "server" | null} */ (null), moveLabel: "", why: "" });
  // A session kept where it is (contracts/runner.md: pinned, read only in v1) offers no move; the chip says it stays.
  if (p.pinned && p.state !== "moving") return { ...fixed(mac ? (name ? `On ${name}` : "On this Mac") : "On the server", mac ? "ok" : "plain"), why: mac ? "it is kept on this Mac" : "it is kept on the server" };
  if (p.state === "moving") return fixed("Moving");
  if (p.state === "locked") return fixed("Locked");
  if (p.state === "updating") return fixed("This Mac is updating");
  if (p.state === "paused") return fixed("Paused on this Mac", "ok");
  if (!mac && p.offer === "mac") return { label: "Bring back to this Mac?", tone: /** @type {"ok" | "plain"} */ ("plain"), moveTo: /** @type {"mac" | "server" | null} */ ("mac"), moveLabel: "Bring it back to this Mac", why: why(p.reason) };
  return { label: mac ? (name ? `On ${name}` : "On this Mac") : "On the server", tone: /** @type {"ok" | "plain"} */ (mac ? "ok" : "plain"), moveTo: /** @type {"mac" | "server" | null} */ (mac ? "server" : "mac"),
    moveLabel: mac ? "Move to the server" : "Move to this Mac", why: mac ? "" : why(p.reason) };
}

/** Whether an update from the box is newer than what is shown: a higher epoch wins, and an update with none is taken. @param {number | undefined} have @param {number | undefined} incoming */
export const fresher = (have, incoming) => incoming === undefined || have === undefined || incoming >= have;

/** The one line in the chat when a session moves (or, for a session pinned to a folder, pauses). @param {{ to: string, reason?: string | null }} e */
export function movedLine(e) {
  if (e.reason === "folder" && e.to === "paused") return "Paused: this chat works in a folder on your Mac.";
  const where = e.to === "mac" ? "this Mac" : "the server";
  const w = why(e.reason);
  return `Moved to ${where}${w ? `: ${w}` : ""}.`;
}

/** What the chat's status line says while its process starts on a computer (`thread.placing`, state "starting"); nothing once it is up or has fallen back. The computer is named by its own name, never an id. @param {{ state?: string, computer?: string } | null | undefined} e */
export function placingWords(e) {
  if (!e || e.state !== "starting") return "";
  const n = String(e.computer || "").trim();
  return n ? `Starting on ${n}...` : "Starting on your computer...";
}

/** The one line when nothing could start on the computer and the server runs the chat instead (`thread.placing`, state "fallback"). @param {{ state?: string, computer?: string } | null | undefined} e */
export function placingLine(e) {
  if (!e || e.state !== "fallback") return "";
  const n = String(e.computer || "").trim();
  return `${n || "Your computer"} did not answer. Running on the server instead.`;
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

/** The sentence under the switch; `shared` names the spaces this computer is lent to. @param {MacSettings} s @param {string[]} [shared] */
export function switchNote(s, shared = []) {
  if (!s.enabled) return "Sessions run on the server. Turn this on to let them run on this Mac too. You approve once. Turn it off any time and they go back to the server.";
  const names = shared.length > 1 ? `${shared.slice(0, -1).join(", ")} and ${shared[shared.length - 1]}` : shared[0] || "";
  return `Sessions may run on this Mac${s.pluggedInOnly ? " while it is plugged in" : ""}, up to ${s.cpuPercent}% of the processor and ${s.memoryMb >= 1024 ? `${Math.round(s.memoryMb / 102.4) / 10} GB` : `${s.memoryMb} MB`} of memory. Past a limit, a session moves to the server and carries on.${names ? ` Shared with ${names}.` : ""}`;
}

/** What turning the switch on or off has to do, from spaces.devices.list for this computer: the spaces to lend it to and the ones it is lent to now. A space it was removed from is left alone. @param {any} d */
export function lendPlan(d) {
  const rows = d && Array.isArray(d.spaces) ? d.spaces : [];
  const live = rows.filter((/** @type {any} */ r) => r && r.space && r.enrolled && !r.removed);
  const pick = (/** @type {any} */ r) => ({ space: String(r.space), title: spaceTitle(r) });
  return { device: d && d.device && typeof d.device.eid === "string" ? d.device.eid : "", toLend: live.filter((/** @type {any} */ r) => !r.lent).map(pick), lent: live.filter((/** @type {any} */ r) => r.lent).map(pick) };
}

/** Why the switch did not turn on, in words. @param {string | undefined} code @param {string} message */
export function switchRefusal(code, message) {
  if (code === "presence_required" || code === "presence_denied" || code === "denied") return "Not turned on: it needs your approval. Approve on this computer, then try again.";
  if (code === "device_removed") return "Not turned on: this computer was removed from a space. Add it again from Spaces.";
  return message ? `Not turned on: ${message.charAt(0).toLowerCase()}${message.slice(1)}` : "Not turned on. That did not go through.";
}

/** The sessions running here, for the Settings page and the menu bar. The box words each row's second line and accessory (`line`, `cpu`: runner.here in contracts/runner.md), so the Lumen list and this list read the same; an older box sends the numbers only. @param {any} d */
export function pickHere(d) {
  const list = Array.isArray(d) ? d : d && Array.isArray(d.sessions) ? d.sessions : [];
  return list.filter((/** @type {any} */ x) => x && typeof x.thread === "string").map((/** @type {any} */ x) => ({
    thread: String(x.thread), title: String(x.title || "A session"), computer: typeof x.computer === "string" ? x.computer : "", state: /** @type {"running" | "waiting" | "paused"} */ (x.state === "waiting" || x.state === "paused" ? x.state : "running"),
    cpuPercent: typeof x.cpuPercent === "number" ? Math.round(x.cpuPercent) : 0, memoryMb: typeof x.memoryMb === "number" ? Math.round(x.memoryMb) : 0,
    ...(typeof x.line === "string" && x.line ? { line: x.line } : {}), ...(typeof x.cpu === "string" && x.cpu ? { cpu: x.cpu } : {}) }));
}

/** One row of the list: the title and what it is using, in the box's own words when it sent them. @param {ReturnType<typeof pickHere>[number]} s */
export function hereLine(s) {
  if (s.line) return { title: s.title, sub: s.line };
  const mem = s.memoryMb >= 1024 ? `${Math.round(s.memoryMb / 102.4) / 10} GB` : `${s.memoryMb} MB`;
  return { title: s.title, sub: `${s.state === "paused" ? "Paused" : s.state === "waiting" ? "Waiting for you" : "Running"}, ${s.cpuPercent}% processor, ${mem}` };
}

/** The line for a session that did not run here. @param {string | null | undefined} code */
export const whyNotLine = (code) => (code ? `It did not run on this Mac because ${why(code)}.` : "It ran where it was meant to.");

const STATES = ["here", "moving", "server", "locked", "updating", "paused"];

/** A placement as the box sent it, kept to what is known; anything that is not on this Mac or the server is no placement. @param {any} d @returns {Placement | null} */
export function pickPlacement(d) {
  if (!d || (d.where !== "mac" && d.where !== "server")) return null;
  return { where: d.where, ...(typeof d.computer === "string" && d.computer ? { computer: d.computer } : {}), reason: typeof d.reason === "string" ? d.reason : null, since: typeof d.since === "number" ? d.since : null,
    ...(STATES.includes(d.state) ? { state: d.state } : {}), ...(d.offer === "mac" ? { offer: /** @type {"mac"} */ ("mac") } : {}), ...(d.pinned === true ? { pinned: true, pin: d.pin === "mac" ? /** @type {"mac"} */ ("mac") : /** @type {"server"} */ ("server") } : {}), ...(Number.isInteger(d.epoch) ? { epoch: d.epoch } : {}) };
}
