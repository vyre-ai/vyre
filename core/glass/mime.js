// @ts-check
// mime: a file's type from its name, and which types a browser may show inline.
//
// Only raster images and PDFs are ever served inline (ADR 0005, decision 4). An SVG or an HTML
// file can run script, so it always downloads, whatever it claims to be.

const TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  svg: "image/svg+xml", html: "text/html", htm: "text/html", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", js: "text/javascript", mjs: "text/javascript", ts: "text/plain", css: "text/css",
  xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", log: "text/plain", sh: "text/x-shellscript",
  py: "text/x-python", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Types a raw response may carry inline. Everything else is an attachment. */
export const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

/** The type for a file name, or application/octet-stream. */
export function mimeOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return (m && TYPES[m[1].toLowerCase()]) || "application/octet-stream";
}

/** Does this type read as text, so a preview can show it? */
export const isText = mime => /^text\//.test(mime) || ["application/json", "application/xml"].includes(mime);
