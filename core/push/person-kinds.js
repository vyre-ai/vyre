// @ts-check
// Which notifications each person wants. The switches (ask, draft, watch, lesson, planner, goal) are per person in a Space: they live in the settings module's per-person record (the push.<kind> keys,
// declared perPerson), and a person with no row of their own gets the server-wide value. This file only asks and tells that record; who the person is comes from the kernel's chain for the call, never
// from the input. What a notification carries on the lock screen (planner_label) and quiet hours stay one value for the whole box.

import { personOfChain, personOfMeta } from "../../lib/lent-placement.js";

/** The kinds that have their own per-person switch. The others (proactive, notice) stay server-wide. */
export const PERSON_KINDS = ["ask", "draft", "watch", "lesson", "planner", "goal"];
const keyOf = (/** @type {string} */ kind) => `push.${kind}`;

/** @param {{ call: (tool: string, input?: any) => Promise<any>, kernel?: any }} ctx */
export function makePersonKinds(ctx) {
  /** The person a call is from: its kernel chain, else (no kernel) what the daemon put on the call. Null for a module, a hook or anyone else. @param {any} meta @returns {Promise<string | null>} */
  const person = async meta => {
    if (!meta) return null;
    if (ctx.kernel && typeof ctx.kernel.chain === "function") { try { return personOfChain(await ctx.kernel.chain(meta)); } catch { return null; } }
    const p = personOfMeta(meta);
    return typeof p === "string" && p ? p : null;
  };
  /** One person's own switches: { ask: true, ... }, only the ones they hold. @param {string} who @returns {Promise<Record<string, boolean>>} */
  const read = async who => {
    const r = await ctx.call("settings.person.get", { person: who, keys: PERSON_KINDS.map(keyOf) }).catch(() => null);
    const v = r && !r.error && r.data && r.data.values ? r.data.values : {};
    /** @type {Record<string, boolean>} */ const kinds = {};
    for (const k of PERSON_KINDS) if (typeof v[keyOf(k)] === "boolean") kinds[k] = v[keyOf(k)];
    return kinds;
  };
  /**
   * Keep what a person switched (only the kinds that have a per-person switch). False when the settings module is not there to keep it: the caller then leaves the switch server-wide.
   * @param {string} who @param {Record<string, boolean>} kinds @returns {Promise<boolean>}
   */
  const write = async (who, kinds) => {
    let kept = false;
    for (const [k, v] of Object.entries(kinds)) {
      if (!PERSON_KINDS.includes(k)) continue;
      const r = await ctx.call("settings.person.set", { person: who, key: keyOf(k), value: Boolean(v) }).catch(() => ({ error: { code: "no_such_tool" } }));
      if (r && r.error) { if (r.error.code === "no_such_tool") return false; throw Object.assign(new Error(r.error.message || "the setting was not saved"), { code: r.error.code }); }
      kept = true;
    }
    return kept || Object.keys(kinds).some(k => PERSON_KINDS.includes(k)) === false;
  };
  /** Does this person not want this kind? Their own value, else the server-wide one (`server`). A kind with no per-person switch is never turned off here. @param {string | null} who @param {string} kind @param {boolean} server */
  const off = async (who, kind, server) => {
    if (!who || !PERSON_KINDS.includes(kind)) return false;
    const mine = (await read(who))[kind];
    return !(mine === undefined ? server : mine);
  };
  /** Does anyone in this Space want this kind? True when some person has it on, so a kind off server-wide still reaches the people who turned it on. @param {string} kind */
  const anyOn = async kind => {
    if (!PERSON_KINDS.includes(kind)) return false;
    const r = await ctx.call("settings.person.get", { holds: { key: keyOf(kind), value: true } }).catch(() => null);
    return Boolean(r && !r.error && r.data && r.data.holds === true);
  };
  return { person, read, write, off, anyOn };
}
