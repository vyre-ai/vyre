// @ts-check
// The Servers screen in words. A device paired to several servers shows one row per server: its name, the Space on it (the same tag every row of that Space carries, src/state/space-name.js placeTag), and Offline
// when it did not answer. Pure: the screen passes in the pairings, the merged Spaces list (each row tagged with its server) and the servers that did not answer.
import { placeTag } from "../../src/state/space-name.js";

export const ADD = { title: "Add a server", body: "Each server holds one Space. Add another and its Space joins the switcher, with a tag on every row that says where it lives.", action: "Add another server" };

/** @param {number} n */
export const serversLine = (n) => (n === 0 ? "No server yet. Add a server to run your Spaces on a computer that stays on." : n === 1 ? "1 server" : `${n} servers`);

/**
 * @param {{ pairings: Array<{ box: string, name?: string }>, spaces: Array<Record<string, any>>, offline: string[], active: string | null }} o
 * @returns {Array<{ key: string, name: string, space: string, offline: boolean, active: boolean, sub: string }>}
 */
export function serverRows(o) {
  return o.pairings.map((p, n) => {
    const row = o.spaces.find((s) => s.server === p.box);
    const space = row ? placeTag(row) : "";
    const offline = o.offline.includes(p.box);
    const name = (p.name || "").trim() || `Server ${n + 1}`;
    const sub = `${space ? `Space: ${space}` : "No Space on it yet"}${offline ? ". Offline: it did not answer. Check that it is on, then try again." : ""}`;
    return { key: p.box, name, space, offline, active: o.active === p.box, sub };
  });
}

export const FOUND = { title: "Found on your other devices", body: "These servers are on your other devices and not on this one yet. Connect them here with no code." };

/** @param {number} n */
export const foundLine = (n) => (n === 1 ? "1 server your other devices use" : `${n} servers your other devices use`);

/**
 * The rows under "Found on your other devices". A pinned server not yet connected has a Connect button; one that refused says why and can be tried again; one with no pin to check is named and never connected
 * by itself (the person pairs it with a code from that server).
 * @param {{ found: Array<{ id: string, name: string }>, confirm: Array<{ id: string, name: string }>, failed: Array<{ entry: { id: string, name: string }, code: string, message: string }> }} o
 * @returns {Array<{ key: string, name: string, sub: string, action: string | null }>}
 */
export function foundRows(o) {
  const failed = new Set(o.failed.map((f) => f.entry.id));
  return [
    ...o.failed.map((f) => ({ key: f.entry.id, name: f.entry.name, sub: f.message, action: /** @type {string | null} */ ("Try again") })),
    ...o.found.filter((e) => !failed.has(e.id)).map((e) => ({ key: e.id, name: e.name, sub: "On your other devices", action: /** @type {string | null} */ ("Connect") })),
    ...o.confirm.map((e) => ({ key: e.id, name: e.name, sub: "Vyre has no key to check for this one. Pair it with a code from that server.", action: /** @type {string | null} */ (null) })),
  ];
}
