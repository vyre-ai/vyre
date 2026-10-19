// @ts-check
// A call over a server's peer stream that got no answer is made once more, on a fresh stream (peer.ts peerCallOnce). Two failures count: the stream was closed (`unreachable`), or it took the call and
// never answered (`timeout`, relay/client/peerclient.js gives up after 30 s). A stream that stalled is dropped, so the retry and every later call open a new one. A second failure of the same kind is
// refused in plain words. Anything the server answered is the answer and is never made again here. A send carries its own message id, so the server says it once however often it arrives.

/** The failures that earn one more try on a fresh stream. */
export const RETRY_ONCE = new Set(["unreachable", "timeout"]);
/** What a person reads when the server took the call and never answered, twice. */
export const NO_ANSWER = "Your server did not answer in time. Check that it is on and online, then try again.";
/** What a person reads when the connection dropped, twice. */
export const CLOSED = "The connection to your server dropped. Check that it is on and online, then try again.";

/** @param {unknown} e */
const codeOf = (e) => String((/** @type {{ code?: unknown }} */ (e) || {}).code ?? "");

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

/** Does this failure earn one more try? @param {unknown} e */
export const retriesOnce = (e) => RETRY_ONCE.has(codeOf(e));
