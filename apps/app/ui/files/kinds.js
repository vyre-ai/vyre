// @ts-check
// What kind of file this is, so the viewer picks one renderer: markdown, code, text, json, image, pdf, docx, sheet, audio, video, html, or other (a card with Download). By name first, then the type the
// server gave. Pure.

/** @typedef {"markdown" | "code" | "text" | "json" | "image" | "pdf" | "docx" | "sheet" | "audio" | "video" | "html" | "other"} ViewKind */

const EXT = /** @type {Record<string, ViewKind>} */ ({
  md: "markdown", markdown: "markdown", mdx: "markdown",
  json: "json", jsonl: "text", geojson: "json",
  txt: "text", log: "text", text: "text", rtf: "text", env: "text", ini: "text", cfg: "text", conf: "text", toml: "code", lock: "text",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", svg: "image", ico: "image",
  pdf: "pdf", docx: "docx",
  xlsx: "sheet", xls: "sheet", csv: "sheet", tsv: "sheet",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio", flac: "audio", aac: "audio",
  mp4: "video", mov: "video", webm: "video", m4v: "video",
  html: "html", htm: "html",
});
const CODE = "js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql css scss less yaml yml xml graphql proto lua r scala dart vue svelte tf dockerfile makefile gradle".split(" ");
for (const e of CODE) EXT[e] ??= "code";

/** @param {string} name */
export const extOf = name => { const base = String(name || "").split("/").pop() || ""; const i = base.lastIndexOf("."); return i > 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase(); };

/** @param {string} name @param {string} [mime] @returns {ViewKind} */
export function viewerKind(name, mime = "") {
  const byName = EXT[extOf(name)];
  if (byName) return byName;
  const m = String(mime).toLowerCase();
  if (m === "text/markdown") return "markdown";
  if (m === "application/json") return "json";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "text/html") return "html";
  if (m === "text/csv") return "sheet";
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("spreadsheetml") || m === "application/vnd.ms-excel") return "sheet";
  if (m.startsWith("text/")) return "text";
  return "other";
}

/** The highlighter's language for a code file. @param {string} name */
export function languageOf(name) {
  const e = extOf(name);
  return ({ mjs: "js", cjs: "js", jsx: "js", yml: "yaml", zsh: "sh", bash: "sh", fish: "sh", htm: "html", mdx: "md" })[/** @type {string} */ (e)] || e;
}

/** Kinds whose bytes are text a person can edit and diff. @param {ViewKind} k */
export const isTextKind = k => k === "markdown" || k === "code" || k === "text" || k === "json";
/** Kinds that can be saved as a new version from the viewer. @param {ViewKind} k */
export const canEdit = k => k === "markdown" || k === "code" || k === "text";

/** The mime type for a media element or a data address. @param {string} name @param {ViewKind} kind */
export function mimeFor(name, kind) {
  const e = extOf(name);
  if (kind === "image") return e === "svg" ? "image/svg+xml" : e === "jpg" ? "image/jpeg" : `image/${e || "png"}`;
  if (kind === "pdf") return "application/pdf";
  if (kind === "audio") return e === "mp3" ? "audio/mpeg" : e === "m4a" ? "audio/mp4" : `audio/${e}`;
  if (kind === "video") return e === "mov" ? "video/quicktime" : `video/${e === "m4v" ? "mp4" : e}`;
  if (kind === "html") return "text/html";
  return "application/octet-stream";
}

/** Largest bytes each renderer reads in the page. @type {Record<ViewKind, number>} */
export const LIMITS = { markdown: 2 << 20, code: 2 << 20, text: 2 << 20, json: 4 << 20, image: 16 << 20, pdf: 32 << 20, docx: 16 << 20, sheet: 8 << 20, audio: 64 << 20, video: 128 << 20, html: 2 << 20, other: 0 };
