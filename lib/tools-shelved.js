// @ts-check
// Tools shelved for 0.6 chrome-inline: still callable on the box, hidden from MCP listTools and harness catalogs.

/** @type {ReadonlySet<string>} */
export const SHELVED_TOOLS = new Set([
  "term.open",
  "threads.shell",
  "glass.files.list",
  "glass.files.stat",
  "glass.files.preview",
  "glass.files.download",
  "glass.files.upload",
  "glass.files.move",
  "glass.files.mkdir",
  "glass.files.trash",
]);

/** @param {string} name */
export function isShelvedTool(name) {
  return SHELVED_TOOLS.has(name) || name.startsWith("glass.files.");
}
