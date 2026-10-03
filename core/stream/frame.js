// @ts-check
// The two things a client needs to read a frame, with no imports: the app bundles the client
// (client.js) and must not pull in the server's redaction or Node modules through protocol.js.

/** The kind of a frame ("text-delta"), or "" when it is not one. @param {any} f */
export const kindOf = f => (f && typeof f.type === "string" && f.type.startsWith("session.") ? f.type.slice(8) : "");

/** The first cursor a frame covers (cur, unless it was merged). @param {any} f */
export const startOf = f => (f.span ? f.cur - f.span + 1 : f.cur);

/** Frames that are delivered but never logged, with no cursor (cur 0): who is typing or doing what, and a person's read marker. */
export const EPHEMERAL = Object.freeze(["presence", "read-marker"]);
/** True for an ephemeral frame: no cursor, never replayed, safe to deliver twice. @param {any} f */
export const isEphemeral = f => EPHEMERAL.includes(kindOf(f));

/** The last characters of streamed text the door may still cut (door.stream holdback): not final until text-done. */
export const HOLDBACK = 40;
/** Split a message's text into what is settled and what is still provisional. @param {string} text @param {boolean} done */
export const settle = (text, done) => (done || text.length <= HOLDBACK ? { stable: done ? text : "", provisional: done ? "" : text } : { stable: text.slice(0, text.length - HOLDBACK), provisional: text.slice(text.length - HOLDBACK) });
