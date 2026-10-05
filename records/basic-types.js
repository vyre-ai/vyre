// @ts-check
// The fixed record types of a Basic (device) install. A device keeps its records in its own SQLite store and has no Twenty, so it holds only the personal types the
// product itself defines: projects and chat records (the user, 5 Oct). A custom type needs a Cloud space. Flows, Kits, roles and views, and the
// planner and tasks, need a server too, so none of their types is allowed here. Anything else answers BASIC_REFUSAL.

export const BASIC_TYPES = Object.freeze(["project", "chat-record"]);

/** Plain words, shown as they are. */
export const BASIC_REFUSAL = "Custom types need a Cloud space.";

/** Hidden system types that project and chat-record themselves need on a device; their owners add them here. None today. */
export const HIDDEN = Object.freeze(/** @type {string[]} */ ([]));

/** Every type name a Basic install may define. @returns {Set<string>} */
export const basicAllow = () => new Set([...BASIC_TYPES, ...HIDDEN]);
