// @ts-check
// person: the person sessions a browser holds on this box (e2e's web-session rule). A same-origin
// page carries the cookie __Host-vyre_person; the hosted app (app.vyre.run) carries
// `authorization: Vyre <id>.<secret>` and an `x-vyre-proof` signed by its own key. Each session is
// pinned to the tailnet node it was made on.
//
// This is the seam the router calls. Until e2e wires the store, no request has a session, so a
// cross-origin call is refused (core/daemon/index.js) and nothing else changes.

/**
 * @typedef {{ ok: true, id: string, kind: "cookie"|"bearer" } | { ok: false, why: string }} SessionCheck
 */

/**
 * @param {import("node:sqlite").DatabaseSync} [db]
 * @returns {{ sessionOf(req: import("node:http").IncomingMessage, peer: any, opts?: { body?: Buffer|string }): Promise<SessionCheck|null> }}
 */
export function personSessions(db) {
  void db;
  return { sessionOf: async () => null };
}
