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
