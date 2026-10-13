// @ts-check
// A call to a server that is stopped or off the network never answers (the relay holds the connection open). With several servers paired a screen must not wait for ever on one of them: after `ms` the call is
// refused as server_offline, in words that name the next step. The late answer, if one comes, is dropped. Pure.

export const OFFLINE = "That server did not answer. Check that it is on and online, then try again. Nothing was sent to another server.";

/** @template T @param {Promise<T>} p @param {number} ms @returns {Promise<T>} */
export function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(OFFLINE), { code: "server_offline" })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
