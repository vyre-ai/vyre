// @ts-check
// routine: an agent's Routine, written as an ordinary watcher folder (the one store Routines, Watchers and teammates' duties share).
//
// A Routine runs on a schedule ("every weekday at 9, summarise my inbox"): at its time it starts its agent, for the person who asked, with
// the instructions it was given. A Watcher runs when something new appears. Both belong to one agent and are made only by asking it.
// The code is a fixed template, reviewed once here and never text a model wrote: it files one item per firing, so a Routine's runs are
// visible like any watcher's, and the runtime wakes the agent with the instructions (runtime.js wakeAgent).

import * as cron from "./cron.js";
import { parseWhen } from "./when.js";

/** What a Routine's firing files: one item, then the runtime starts its agent. */
export const ROUTINE_EMITS = "routine.due";
/** No Routine runs more often than this: it starts an AI turn on the person's own account each time. */
export const ROUTINE_MIN_MINUTES = 15;

export const ROUTINE_WATCH_JS = `// An agent's Routine. The code is fixed; the instructions and the schedule live in watcher.json.
import { readFileSync } from "node:fs";

export default async function watch({ emit }) {
  const spec = JSON.parse(readFileSync(new URL("./watcher.json", import.meta.url), "utf8"));
  const title = String(spec.instruction || "").split("\\n")[0].slice(0, 200);
  emit({ id: spec.name + ":" + new Date().toISOString().slice(0, 19), title, about: spec.owner.agent, at: Date.now() });
}
`;

/** Whether a checked spec is a Routine (its emits is the routine's own). @param {any} spec */
export const isRoutine = spec => Boolean(spec && spec.emits === ROUTINE_EMITS && spec.owner && spec.owner.kind === "agent");

/**
 * A Routine's schedule from plain words ("weekdays 09:00", "daily 07:30", "every 2 hours", or five-field cron): cron only, never an event, and no more
 * often than every ROUTINE_MIN_MINUTES. Throws words that say how to write it.
 * @param {string} when @param {string} zone @returns {string} the cron
 */
export function routineSchedule(when, zone) {
  const t = parseWhen(when);
  if (t.schedule === "event") throw new Error("a Routine runs on a schedule, like weekdays 09:00. For something that happens or arrives, set up a Watcher with watchers.write instead");
  const c = cron.parse(t.schedule);
  // the firings of one ordinary week, one after another: any two closer than the floor refuse it
  let at = cron.next(c, Date.UTC(2026, 0, 5, 0, 0), zone);
  for (let n = 0; at != null && n < 200; n++) {
    const b = cron.next(c, at, zone);
    if (b == null) break;
    if (b - at < ROUTINE_MIN_MINUTES * 60_000) throw new Error(`a Routine runs at most every ${ROUTINE_MIN_MINUTES} minutes; it starts an AI turn each time`);
    at = b;
  }
  return t.schedule;
}

/**
 * The words a Routine's agent is started with when it is due: the instructions it was given, in Vyre's voice, and where to answer.
 * @param {string} name @param {string} instruction @param {string} every the schedule in words
 */
export function routineText(name, instruction, every) {
  return `Your routine ${name} is due (${every}). Do what it asks now, for the person who set it up, and post what you found or did here, in plain words.\n\nThe routine's instructions:\n${String(instruction).slice(0, 2000)}`;
}
