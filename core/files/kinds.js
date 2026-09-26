// @ts-check
// kinds — what sort of file a path is, from its extension alone.
//
// Search results carry a kind so a surface can filter and pick an icon without opening
// anything, and preview uses it to decide between text, a thumbnail or nothing. The extension
// is a guess, which is why preview still checks the bytes before it shows text.

import path from "node:path";

export const KINDS = ["folder", "text", "code", "image", "pdf", "doc", "audio", "video", "archive", "other"];

/** @type {Record<string, [string, string]>} extension -> [kind, mime] */
const EXT = {};
const add = (kind, list) => { for (const [ext, mime] of Object.entries(list)) EXT[ext] = [kind, mime]; };

add("text", { txt: "text/plain", md: "text/markdown", markdown: "text/markdown", rst: "text/plain", log: "text/plain",
  csv: "text/csv", tsv: "text/tab-separated-values", rtf: "application/rtf", org: "text/plain", tex: "text/x-tex" });
add("code", { js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", ts: "text/typescript", tsx: "text/typescript",
  jsx: "text/javascript", json: "application/json", jsonl: "application/jsonl", yaml: "text/yaml", yml: "text/yaml", toml: "text/plain",
  ini: "text/plain", xml: "application/xml", html: "text/html", htm: "text/html", css: "text/css", scss: "text/x-scss",
  py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust", java: "text/x-java", kt: "text/x-kotlin",
  swift: "text/x-swift", c: "text/x-c", h: "text/x-c", cpp: "text/x-c++", hpp: "text/x-c++", cs: "text/x-csharp",
  php: "text/x-php", sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript", sql: "application/sql",
  lua: "text/x-lua", vue: "text/plain", svelte: "text/plain", graphql: "text/plain", dockerfile: "text/plain" });
add("image", { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  heif: "image/heif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon" });
add("pdf", { pdf: "application/pdf" });
add("doc", { doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  pages: "application/x-iwork-pages-sffpages", numbers: "application/x-iwork-numbers-sffnumbers", epub: "application/epub+zip" });
add("audio", { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus" });
add("video", { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo" });
add("archive", { zip: "application/zip", tar: "application/x-tar", gz: "application/gzip", tgz: "application/gzip", bz2: "application/x-bzip2",
  xz: "application/x-xz", "7z": "application/x-7z-compressed", rar: "application/vnd.rar", dmg: "application/x-apple-diskimage" });

/** The kind and mime type of a file, by name. Folders are told apart by the caller, who has the stat. */
export function classify(name, dir = false) {
  if (dir) return { kind: "folder", mime: "inode/directory" };
  const ext = path.extname(name).slice(1).toLowerCase() || (name.toLowerCase() === "dockerfile" ? "dockerfile" : "");
  const hit = EXT[ext];
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: "other", mime: "application/octet-stream" };
}
