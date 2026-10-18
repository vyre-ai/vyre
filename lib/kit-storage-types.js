// @ts-check
// lib/kit-storage-types: the two record types a Kit's role and view definitions are stored in (def-role, def-view). Defined with the Flow types at every start (core/daemon/flows-host.js) and put in the
// saved Records database too (stores/twenty/live/build-golden.mjs), from this one place, so the saved database cannot drift from what the kernel defines.

/** @param {string} name @param {string} label */
const storage = (name, label) => Object.freeze({ name, label, fields: Object.freeze([{ name: "name", kind: "text", label: "Name" }, { name: "body", kind: "text", label: "Definition" }, { name: "kit", kind: "text", label: "From Kit" }]) });

export const KIT_STORAGE_TYPES = Object.freeze([storage("def-role", "Role definition"), storage("def-view", "View definition")]);
