// @ts-check
// lib/record-types: which record types are the kernel's own bookkeeping (Flows' definitions, runs and approvals, installed Kits and their proposals, goals, a preview's data) and not the person's business
// records. Customize, Records and the context cards leave them out. One list, written once.
const SYSTEM_TYPES = new Set(["goal", "memory_fact", "planner_firing", "planner_state", "flow-approval", "flow-state", "flow-schedule", "flow-run", "kit-install", "kit-proposal", "preview_doc"]);

/** @param {string} name */
export const isSystemType = name => SYSTEM_TYPES.has(name) || name.startsWith("def-") || name.startsWith("flow-") || name.startsWith("kit-");
