// @ts-check
// The calm "Working on it" line under a chat: it shows the moment a message is sent (before the box has said anything) and goes when the turn ends. The pure half, so Node can test it.

/**
 * Whether the chat is waiting on an answer to a message sent here. Starts at `sent`; ends when the turn has been seen working and is not any more, when the state changes to a stopped one
 * (a failure that came before any "working"), or after `give up` (a turn that never reports must not leave the line up for ever).
 * @typedef {{ on: boolean, saw: boolean, from: string }} Awaiting
 */

/** @returns {Awaiting} */
export const idle = () => ({ on: false, saw: false, from: "" });

/** A message was sent while the chat was in `state`. @param {string} state @returns {Awaiting} */
export const sent = (state) => ({ on: true, saw: false, from: state });

/** The chat's state moved. @param {Awaiting} a @param {{ busy: boolean, state: string }} m @returns {Awaiting} */
export function moved(a, m) {
  if (!a.on) return a;
  if (m.busy) return a.saw ? a : { ...a, saw: true };
  if (a.saw || m.state !== a.from) return idle();
  return a;
}

/** The send was refused: nothing is waiting. @returns {Awaiting} */
export const refused = () => idle();

/** How long a send waits for the turn to show before the line is dropped. */
export const GIVE_UP_MS = 90000;

/**
 * The words under the chat while it works, or "". A turn the box says is running shows only while the link is live (a kept copy that says "working" is old news); a message just sent shows at once.
 * @param {{ busy: boolean, connection: string, awaiting: boolean }} o
 */
export function workingLine(o) {
  return o.awaiting || (o.busy && o.connection === "live") ? "Working on it" : "";
}
