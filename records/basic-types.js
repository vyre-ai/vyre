// @ts-check
// The fixed record types of a Basic (device) install. A device keeps its records in its own SQLite store and has no Twenty, so it holds only the personal types the
// product itself defines; a custom type (a Kit's, an admin's, a Flow author's) needs the person's own server (Pro). `BASIC_TYPES` is the list the product's owners keep:
// projects and chat records only (the user, 5 Oct: planner and tasks need a server Space). The hidden system types those features need (Flow and Kit bookkeeping) are named by their own modules and added in
// `basicAllow`. Anything else answers BASIC_REFUSAL.
import { FLOW_TYPES } from "../kernel/flows/store.js";
import { KIT_TYPES } from "../kernel/flows/kits.js";

export const BASIC_TYPES = Object.freeze(["project", "chat-record"]);

/** Plain words, shown as they are. */
export const BASIC_REFUSAL = "Custom types need your own server (Pro).";

/** Every type name a Basic install may define: the fixed personal types plus the hidden system types the product's own features keep. @returns {Set<string>} */
export const basicAllow = () => new Set([...BASIC_TYPES, ...FLOW_TYPES.map((/** @type {any} */ t) => t.name), ...KIT_TYPES.map((/** @type {any} */ t) => t.name), "def-role", "def-view"]);
