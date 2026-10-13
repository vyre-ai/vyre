// @ts-check
// The words under a server in "Which server is this for?" (InstallScreen): what is already on it. A server holds one Space, so one that already runs one says so before the person picks it.

/** @param {{ has: string }} c */
export const pickLine = (c) => (c.has ? `Has ${c.has}. A server holds one Space.` : "Nothing on it yet.");
