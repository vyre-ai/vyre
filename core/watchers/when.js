// @ts-check
// when: a duty's trigger in plain words, read into the one shape the runtime already runs.
//
//   thread.finished                       an event (free: nothing listens or polls until it happens)
//   memory.decided where project=harlow   an event with payload fields that must match
//   daily 07:00 | weekdays 09:30 | hourly | every 30 minutes | every 2 hours | 15 7 * * 1-5
//   push gmail                            a connection's push (Gmail watch, Drive changes): no polling
//
// It answers { schedule, on, where } exactly as watcher.json spells them, or throws a message
// that says how to write it.

import { parse as parseCron } from "./cron.js";

const EVENT = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const CONN = /^[a-z][a-z0-9-]{0,40}$/;
/** Nothing polls faster than this (RULES: light by default). */
export const MIN_EVERY_MINUTES = 5;

const hm = (h, m) => {
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`"${h}:${String(m).padStart(2, "0")}" is not a time of day; write it like 07:00`);
  return [h, m];
};
const at = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); if (!m) throw new Error(`"${s}" is not a time of day; write it like 07:00`); return hm(Number(m[1]), Number(m[2])); };

/** @param {string} text @returns {{ schedule: string, on: string|null, where: Record<string, string|number|boolean>|null }} */
export function parseWhen(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  const fix = 'write the trigger as an event like thread.finished, a schedule like "daily 07:00" or "every 30 minutes", or "push gmail"';
  if (!t) throw new Error(`a duty needs a trigger: ${fix}`);
  let m;
  if ((m = /^(daily|weekdays) (\d{1,2}:\d{2})$/i.exec(t))) { const [h, mi] = at(m[2]); return sched(`${mi} ${h} * * ${m[1].toLowerCase() === "daily" ? "*" : "1-5"}`); }
  if (/^hourly$/i.test(t)) return sched("0 * * * *");
  if ((m = /^every (\d{1,3}) (minutes?|hours?)$/i.exec(t))) {
    const n = Number(m[1]), hours = /^h/i.test(m[2]);
    if (hours) { if (n < 1 || n > 23) throw new Error("every N hours takes 1 to 23"); return sched(`0 */${n} * * *`); }
    if (n < MIN_EVERY_MINUTES || n > 59) throw new Error(`every N minutes takes ${MIN_EVERY_MINUTES} to 59; Vyre does not poll faster, and prefers an event or a push where one exists`);
    return sched(`*/${n} * * * *`);
  }
  if ((m = /^push ([a-z0-9-]+)$/i.exec(t))) {
    if (!CONN.test(m[1].toLowerCase())) throw new Error(`"${m[1]}" is not a connection name; ${fix}`);
    return { schedule: "event", on: "vault.push", where: { connection: m[1].toLowerCase() } };
  }
  if (t.split(" ").length === 5 && /^[\d*/,-]+$/.test(t.replace(/ /g, ""))) return sched(t);
  const [head, ...rest] = t.split(" where ");
  if (EVENT.test(head)) {
    if (rest.length > 1) throw new Error(`one "where" only: ${fix}`);
    /** @type {Record<string, string|number|boolean>|null} */ let where = null;
    if (rest.length) {
      where = {};
      for (const pair of rest[0].split(" ")) {
        const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(pair);
        if (!kv) throw new Error(`"${pair}" is not field=value; ${fix}`);
        where[kv[1]] = kv[2] === "true" ? true : kv[2] === "false" ? false : /^-?\d+(\.\d+)?$/.test(kv[2]) ? Number(kv[2]) : kv[2];
      }
    }
    return { schedule: "event", on: head, where };
  }
  throw new Error(`"${t}" is not a trigger I can read: ${fix}`);
}

function sched(cron) { parseCron(cron); return { schedule: cron, on: null, where: null }; }
