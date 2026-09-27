// @ts-check
// Is the path between this Deck and the box carrying live streams at all? (deck/chat/term.js)
//
// Some ways of reaching the box pass tool calls but not WebSocket upgrades (the tailnet listener
// until it forwards them). There a stream fails the same way every time: the socket errors
// before it opens, or opens and closes with 1006 before a single byte arrives. An ordinary drop
// looks different: the stream was live and had printed something. So two stream-less failures in
// a row, each on a fresh ticket, mean "no link for streams", and reconnecting would only loop.

/**
 * @typedef {{ opened: boolean, data: boolean, code: number }} Attempt one socket, from a fresh ticket
 */

/** Did this socket end without ever carrying a stream? @param {Attempt} a */
export const streamless = a => !a.opened || (!a.data && a.code === 1006);

/**
 * "blocked" when the last two attempts both carried no stream, else "retry".
 * @param {Attempt[]} attempts oldest first
 * @returns {"blocked"|"retry"}
 */
export function linkVerdict(attempts) {
  const last = attempts.slice(-2);
  return last.length === 2 && last.every(streamless) ? "blocked" : "retry";
}
