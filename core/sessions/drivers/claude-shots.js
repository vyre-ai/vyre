// @ts-check
// What a screenshot tool's result carries, in the Claude stream's own message shape (provider formats live in the drivers). The Switchboard asks for the pictures; it reads no format itself.

/** The name of each tool call seen lately, by id: a tool's result carries only the id, and a screenshot is known by the tool that took it (bounded). @type {Map<string, string>} */
const TOOL_NAMES = new Map();
/** The page each screenshot call was about (its url's host, or its title), by tool id, so the picture is named "Screenshot of <page>" and no tool name shows. @type {Map<string, string>} */
const PAGES = new Map();
/** The page a call names: a url's host or a title, short, or "". @param {any} input */
const pageOf = input => { const i = input && typeof input === "object" ? input : {}; for (const k of ["url", "page", "title"]) { const v = i[k]; if (typeof v !== "string" || !v.trim()) continue; if (k === "url") { try { return new URL(v).host.slice(0, 60); } catch { continue; } } return v.trim().slice(0, 60); } return ""; };
/** Remember a tool call's name (and the page it names) by its id (bounded). @param {unknown} id @param {unknown} name @param {unknown} [input] */
export function rememberTool(id, name, input) { const p = pageOf(input); if (p) PAGES.set(String(id), p); if (PAGES.size > 500) PAGES.delete(/** @type {string} */ (PAGES.keys().next().value)); TOOL_NAMES.set(String(id), String(name)); if (TOOL_NAMES.size > 500) TOOL_NAMES.delete(/** @type {string} */ (TOOL_NAMES.keys().next().value)); }
/** An image a screenshot tool's result carries as a content block, for the chat to show inline (0.3.3 G25): at most 4, each under 8 MB. @param {any} b a tool_result block @returns {{ mime: string, data_b64: string, source: string, title: string }[]} */
export function screenshotsOf(b) {
  if (!Array.isArray(b.content) || !/screenshot|screen_?capture/i.test(String(TOOL_NAMES.get(b.tool_use_id) || ""))) return [];
  return b.content.filter((/** @type {any} */ c) => c && c.type === "image" && c.source && c.source.type === "base64" && typeof c.source.data === "string" && c.source.data.length < 8 * 1024 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(String(c.source.media_type))).slice(0, 4).map((/** @type {any} */ c) => ({ mime: String(c.source.media_type), data_b64: c.source.data, source: "content-block", title: PAGES.get(String(b.tool_use_id)) ? `Screenshot of ${PAGES.get(String(b.tool_use_id))}` : "Screenshot" }));
}
