// @ts-check
// A call over a server's peer stream that got no answer (peer.ts peerCallOnce). Two failures count: the stream was closed (`unreachable`), or it took the call and never answered (`timeout`,
// relay/client/peerclient.js gives up after 30 s). A stream that stalled is dropped either way, so no later call waits on it. The call is made once more, on a fresh stream, only when that is safe:
//   - the stream was already closed when the call was made, so it never reached the server;
//   - a read: a tool its module's manifest declares changes nothing (read-tools.generated.js, from the module.json files);
//   - a write that carries the key the server keeps it once by (SAME_ONCE: stream.send with its message id says one message per id however often it arrives).
// Any other write may have run on the server: it is not made again, and the person is told so in plain words. A second failure of a retry is refused in plain words too. Anything the server
// answered is the answer and is never made again here.
import { READ_TOOLS } from "./read-tools.generated.js";

/** The failures that may earn one more try on a fresh stream. */
export const RETRY_ONCE = new Set(["unreachable", "timeout"]);
/** What a person reads when the server took the call and never answered, twice. */
export const NO_ANSWER = "Your server did not answer in time. Check that it is on and online, then try again.";
/** What a person reads when the connection dropped, twice. */
export const CLOSED = "The connection to your server dropped. Check that it is on and online, then try again.";
/** What a person reads when a change got no answer: it may have been made, so it is not made a second time. */
export const MAYBE_DONE = "Your server did not answer in time, so Vyre did not try again: it may have done it already. Check, then try again if it did not.";
/** The same, when the connection dropped before the answer came. */
export const MAYBE_DONE_CLOSED = "The connection to your server dropped before it answered, so Vyre did not try again: it may have done it already. Check, then try again if it did not.";

const READS = new Set(READ_TOOLS);
/** The writes the server keeps once by a key in their input: the tool, and the input field that holds the key. */
export const SAME_ONCE = Object.freeze({ "stream.send": "message" });
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/** @param {unknown} e */
const codeOf = (e) => String((/** @type {{ code?: unknown }} */ (e) || {}).code ?? "");

/**
 * May this call be made a second time without doing anything twice?
 * @param {string} tool @param {Record<string, unknown> | undefined} input
 */
export function safeToRepeat(tool, input) {
  if (READS.has(tool)) return true;
  const key = Object.hasOwn(SAME_ONCE, tool) ? /** @type {Record<string, string>} */ (SAME_ONCE)[tool] : null;
  const v = key && input ? input[key] : undefined;
  return typeof v === "string" && KEY.test(v);
}

/** Does this failure count (a timeout or a closed stream)? @param {unknown} e */
export const retriesOnce = (e) => RETRY_ONCE.has(codeOf(e));

/**
 * The second try. `stuck` is the stream the first try failed on; `drop` forgets (and closes) a stream; `reopen` opens a fresh one; `call` makes the call on a stream.
 * @template T
 * @param {{ stuck: any, drop: (peer: any) => void, reopen: () => Promise<any>, call: (peer: any) => Promise<T> }} o
 * @returns {Promise<T>}
 */
export async function callAgainOnce({ stuck, drop, reopen, call }) {
  drop(stuck);
  const fresh = await reopen();
  try { return await call(fresh); }
  catch (e) {
    const code = codeOf(e);
    if (!RETRY_ONCE.has(code)) throw e;
    drop(fresh);
    throw Object.assign(new Error(code === "timeout" ? NO_ANSWER : CLOSED), { code });
  }
}

/**
 * After a call failed on its stream: made once more when it is safe (see the top), else refused in plain words. A failure that does not count is thrown as it is.
 * @template T
 * @param {{ error: unknown, tool: string, input?: Record<string, unknown>, neverSent?: boolean, stuck: any, drop: (peer: any) => void, reopen: () => Promise<any>, call: (peer: any) => Promise<T> }} o
 *   `neverSent`: the stream was already closed when the call was made, so the server never saw it
 * @returns {Promise<T>}
 */
export async function afterNoAnswer({ error, tool, input, neverSent = false, stuck, drop, reopen, call }) {
  const code = codeOf(error);
  if (!RETRY_ONCE.has(code)) throw error;
  if ((code === "unreachable" && neverSent) || safeToRepeat(tool, input)) return callAgainOnce({ stuck, drop, reopen, call });
  // a write that may have run: the stalled stream still goes (the next call opens a fresh one), the call is not made again
  drop(stuck);
  throw Object.assign(new Error(code === "timeout" ? MAYBE_DONE : MAYBE_DONE_CLOSED), { code });
}
