// @ts-check
// The two things a client needs to read a frame, with no imports: the app bundles the client
// (client.js) and must not pull in the server's redaction or Node modules through protocol.js.

/** The kind of a frame ("text-delta"), or "" when it is not one. @param {any} f */
export const kindOf = f => (f && typeof f.type === "string" && f.type.startsWith("session.") ? f.type.slice(8) : "");

/** The first cursor a frame covers (cur, unless it was merged). @param {any} f */
export const startOf = f => (f.span ? f.cur - f.span + 1 : f.cur);
