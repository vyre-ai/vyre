// @ts-check
// An agent's Routines and Watchers as one list: what the agent set up for itself when a person asked (watchers.list with agent), and a teammate's duties
// (team.duties.list), which are the same thing under an older name: a duty on a schedule is a Routine, a duty on an event is a Watcher.
// A Routine runs on a schedule; a Watcher runs when something new appears. Pure: the tools are called in routines-source.ts.
// There is no form here: people ask the agent in chat, and this list only pauses, resumes, runs now and deletes.

/** @typedef {"pause" | "resume" | "run" | "delete"} Act */
/**
 * @typedef {{ key: string, source: "own" | "duty", name: string, id: string, kind: "routine" | "watcher", title: string, when: string,
 *   state: "on" | "paused" | "waiting" | "broken" | "off", word: string, tone: "ok" | "plain" | "warn" | "err", person: string,
 *   next: string, last: string, result: string, items: number | null, failures: number, why: string, actions: Act[] }} Row
 */

import { dayTimeOf } from "../../src/time/show.js";

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
/** "20 Oct, 9:00 am" in the viewer's own zone (lib/time, through the app's one way to show a time), or "" for no time. @param {unknown} iso */
export function whenWords(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? dayTimeOf(t) : "";
}

/** The person a row runs for, in words: "you" for the signed-in person, else a short form of the id. @param {string} id @param {string | null} self */
export function personWords(id, self) {
  if (!id) return "";
  if (self && id === self) return "you";
  return id.startsWith("per_") ? `member ${id.slice(4, 10)}` : id;
}

/** A duty's trigger as a Routine (a time) or a Watcher (an event or a push). @param {string} trigger */
export const dutyKind = (trigger) => (/^(daily|weekdays|hourly|every)\b/i.test(trigger.trim()) || /^[\d*/,\- ]+$/.test(trigger.trim()) ? "routine" : "watcher");

/** What a row can do now: only what the server lets the person do (rule: never show a button it will refuse). @param {Row["state"]} state @returns {Act[]} */
const actsFor = (state) => (state === "on" ? ["run", "pause", "delete"] : state === "paused" || state === "broken" ? ["resume", "delete"] : state === "off" ? ["resume", "delete"] : ["delete"]);

/**
 * One of the agent's own Routines or Watchers, from watchers.list.
 * @param {any} w @param {string | null} self @returns {Row}
 */
export function ownRow(w, self) {
  const kind = w.kind === "routine" ? "routine" : "watcher";
  const waiting = w.waiting === true;
  const state = w.state === "on" ? "on" : waiting ? "waiting" : w.state === "paused" ? "paused" : w.state === "invalid" || w.state === "missing" || w.state === "changed" ? "broken" : "off";
  const word = state === "on" ? "On" : state === "waiting" ? "Testing" : state === "paused" ? "Paused" : state === "broken" ? "Needs a fix" : "Off";
  const when = kind === "routine" ? str(w.every) : str(w.title) || (str(w.every) ? `Checks ${str(w.every)}` : "");
  const why = state === "waiting" ? "Waiting for its first test to pass" : state === "paused" ? str(w.pausedWhy) : state === "broken" ? (Array.isArray(w.problems) && w.problems.length ? String(w.problems[0]) : str(w.lastError)) : "";
  return {
    key: `own:${str(w.name)}`, source: "own", name: str(w.name), id: str(w.name), kind,
    title: kind === "routine" ? str(w.instruction) || str(w.title) || str(w.name) : str(w.title) || str(w.name),
    when: kind === "routine" ? (when ? `Runs ${when}` : "") : when,
    state, word, tone: state === "on" ? "ok" : state === "broken" ? "err" : state === "paused" ? "warn" : "plain",
    person: personWords(str(w.person), self), next: state === "on" ? whenWords(w.next) : "", last: whenWords(w.lastRun),
    result: str(w.lastError) ? `Failed: ${str(w.lastError)}` : w.lastRun ? "Ran" : "", items: kind === "watcher" && Number.isFinite(Number(w.items)) ? Number(w.items) : null,
    failures: Number(w.failures) || 0, why, actions: actsFor(state),
  };
}

/**
 * One of a teammate's duties, from team.duties.list: the same row, with the duty's own words.
 * @param {any} d @param {string | null} self @returns {Row}
 */
export function dutyRow(d, self) {
  const trigger = str(d.trigger), kind = dutyKind(trigger);
  const state = d.enabled ? "on" : "off";
  return {
    key: `duty:${str(d.id)}`, source: "duty", name: str(d.watcher), id: str(d.id), kind, title: str(d.title) || str(d.instruction),
    when: kind === "routine" ? `Runs ${trigger}` : `When ${trigger}`, state, word: d.enabled ? "On" : d.started ? "Paused" : "Off", tone: d.enabled ? "ok" : "plain",
    person: personWords(str(d.run_as), self), next: "", last: "", result: "", items: null, failures: 0, why: "", actions: d.enabled ? ["run", "pause", "delete"] : ["resume", "delete"],
  };
}

/**
 * The one list: Routines first, then Watchers, each by title. The agent's own and its duties, from the two answers as given.
 * @param {any} watchers watchers.list's answer @param {any} duties team.duties.list's answer, or null @param {string | null} self @returns {Row[]}
 */
export function routineRows(watchers, duties, self) {
  const own = (Array.isArray(watchers && watchers.watchers) ? watchers.watchers : []).filter((/** @type {any} */ w) => w && typeof w.name === "string" && w.agent).map((/** @type {any} */ w) => ownRow(w, self));
  const dut = (Array.isArray(duties && duties.duties) ? duties.duties : []).filter((/** @type {any} */ d) => d && typeof d.id === "string").map((/** @type {any} */ d) => dutyRow(d, self));
  return [...own, ...dut].sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title) : a.kind === "routine" ? -1 : 1));
}

/** The words under a row on the agent's panel: what and when, and who it runs for. @param {Row} r */
export const rowLine = (r) => [r.when, r.person ? `For ${r.person}` : ""].filter(Boolean).join(" · ");

/** The detail lines on the agent's page: next run, last run with its result, items found, failures. @param {Row} r @returns {string[]} */
export function detailLines(r) {
  return [
    r.next ? `Next run ${r.next}` : "",
    r.last ? `Last run ${r.last}${r.result ? `: ${r.result}` : ""}` : "",
    r.items != null ? `${r.items} ${r.items === 1 ? "item" : "items"} found` : "",
    r.failures ? `${r.failures} ${r.failures === 1 ? "failure" : "failures"} in a row` : "",
    r.why,
  ].filter(Boolean);
}

/** The button words, the person's acts. */
export const ACT_LABEL = /** @type {Record<Act, string>} */ ({ pause: "Pause", resume: "Resume", run: "Run now", delete: "Delete" });

/** The empty state: there is nothing to fill in, the person asks the agent. @param {string} agent */
export const emptyLine = (agent) => `Ask ${agent} to set one up, for example "every morning at 9, check my inbox and tell me what needs me".`;

/**
 * The call for one act on one row: the watchers tools for the agent's own, the team's duty tools for a duty.
 * @param {Row} r @param {Act} act @returns {{ tool: string, input: Record<string, unknown> }}
 */
export function actCall(r, act) {
  if (r.source === "duty") return { tool: act === "pause" ? "team.duties.disable" : act === "resume" ? "team.duties.enable" : act === "run" ? "team.duties.run-now" : "team.duties.delete", input: { id: r.id } };
  return { tool: act === "pause" ? "watchers.pause" : act === "resume" ? "watchers.resume" : act === "run" ? "watchers.run" : "watchers.delete", input: { name: r.name } };
}

/** What the person is told after an act. @param {Row} r @param {Act} act */
export const actDone = (r, act) => (act === "delete" ? `${r.title} is deleted.` : act === "run" ? `${r.title} ran.` : act === "pause" ? `${r.title} is paused.` : `${r.title} is on.`);

/** A sample list for the picture tests and the sample world: one Routine, one Watcher waiting for its test, one paused. */
export const SAMPLE_ROWS = /** @type {Row[]} */ (routineRows({ watchers: [
  { name: "morning-inbox", agent: "scout", kind: "routine", state: "on", instruction: "Check my inbox and tell me what needs me", every: "every weekday at 09:00", person: "per_self", next: "2026-10-21T09:00:00", lastRun: "2026-10-20T09:00:00", failures: 0 },
  { name: "northwind-invoices", agent: "scout", kind: "watcher", state: "on", title: "Tells you when an invoice from Northwind arrives", every: "every 15 minutes", person: "per_self", next: "2026-10-20T10:15:00", lastRun: "2026-10-20T10:00:00", items: 3, failures: 0 },
  { name: "status-page", agent: "scout", kind: "watcher", state: "paused", waiting: true, title: "Tells you when the status page reports an outage", every: "every 30 minutes", person: "per_x2b9c4d1e", items: 0 },
] }, { duties: [{ id: "d1", watcher: "duty-scout-d1", trigger: "daily 17:00", title: "Sum up the day's open tasks", enabled: false, started: true, run_as: "per_self" }] }, "per_self"));
