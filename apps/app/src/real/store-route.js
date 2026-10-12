// @ts-check
import { isTransportFailure } from "./team-session.js";
// The ONE place the Store (store-core/gateway-adapter, behind Now, Tasks, Projects, Records, Calendar and Tags) picks where a read or a write goes. A call that names a team Space this device JOINED as a member
// goes to that team's door as her (real/box tool(): the member door map); every other call, her own home's Spaces, the owner's, All spaces, takes the path it always took (api/box call and send). A name the
// door has no row for is refused in words for a joined team: it never falls through to her own home as if it were the team.
//
// `deps`: joinedSpace(input) -> the joined team Space the call names (or the one showing), else null; door(name, input) -> the member door call (tool()); plain.read / plain.write -> today's calls;
// wired(name) -> does the door have a row for this name; notYet -> the words for one it has not; fail(err) -> the Error the screens expect (the Store's storeError): a refusal keeps its own words.

/** The door writes that carry an idempotency key, how long a lost one is remembered, and the transitions whose repeat is not an error. */
const IDEM = new Set(["records.create", "tasks.request"]);
const RETRY_MS = 60_000;
const SETTLE = new Set(["tasks.move", "tasks.submit"]);

/**
 * @param {{ joinedSpace: (name: string, input: Record<string, unknown>) => Promise<string | null>, door: (name: string, input: Record<string, unknown>) => Promise<any>, wired: (name: string) => boolean,
 *   now?: () => number, newKey?: () => string, notYet: string, fail: (e: any) => Error, plain: { read: (name: string, input: Record<string, unknown>) => Promise<any>, write: (name: string, input: Record<string, unknown>, o: any) => Promise<any> } }} deps
 */
export function createStoreRoute(deps) {
  const now = deps.now || Date.now;
  const newKey = deps.newKey || (() => globalThis.crypto?.randomUUID?.() ?? `k${now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
  /** A create or a task request whose answer never came back: the SAME call asked again within RETRY_MS carries the same key, so the server returns the first one instead of making a second. After any answer, a success or a refusal, the key is spent. @type {Map<string, { key: string, at: number }>} */
  const lost = new Map();
  const canon = (/** @type {any} */ v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  /** @param {string} name @param {Record<string, unknown>} input */
  const viaDoor = async (name, input) => {
    if (!deps.wired(name)) throw deps.fail({ code: "not_allowed", message: deps.notYet });
    if (IDEM.has(name)) {
      const fp = `${name}|${canon(input)}`;
      const had = lost.get(fp);
      const key = had && now() - had.at < RETRY_MS ? had.key : newKey();
      lost.delete(fp);
      try { return await deps.door(name, { ...input, idem: key }); } catch (e) { if (isTransportFailure(e)) lost.set(fp, { key, at: now() }); throw deps.fail(e); }
    }
    try { return await deps.door(name, input); } catch (e) {
      // A move or a hand-in that the first press already did: the repeat is refused ("a task that is done cannot go to done"). That is not an error to show; the task as it stands is the answer.
      const settled = SETTLE.has(name) ? await alreadyDone(name, input, e) : undefined;
      if (settled !== undefined) return settled;
      throw deps.fail(e);
    }
  };
  /** @param {string} name @param {Record<string, unknown>} input @param {any} e */
  const alreadyDone = async (name, input, e) => {
    const m = /a task that is (\w+) cannot go to (\w+)/.exec(String(e && e.message));
    if (!m || !(m[1] === m[2] || (name === "tasks.submit" && (m[1] === "done" || m[1] === "needs_check")))) return undefined;
    try { return await deps.door("tasks.get", { id: input.id }); } catch { return undefined; }
  };
  return {
    /** @param {string} name @param {Record<string, unknown>} [input] */
    async read(name, input = {}) { return (await deps.joinedSpace(name, input)) ? viaDoor(name, input) : deps.plain.read(name, input); },
    /** @param {string} name @param {Record<string, unknown>} [input] @param {any} [o] */
    async write(name, input = {}, o = {}) { return (await deps.joinedSpace(name, input)) ? viaDoor(name, input) : deps.plain.write(name, input, o); },
  };
}
