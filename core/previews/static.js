// @ts-check
// previews/static: the `files` source. A preview of a file or a folder the agent wrote (HTML, Markdown, SVG, Mermaid, a built site) served on its own origin by a small server on this machine's loopback,
// reached only through the apps' front. It never constrains what the file is: HTML is served as written (a Claude-style artifact page, a dashboard, a game, a React build), a folder is a static site with an
// index and a single-page-app fallback. Only the page's own request path decides what is read, and only below the preview's own root: no `..`, no link out, no dotfile. The bridge (bridge.js) is the one thing added,
// and only when the preview declared capabilities.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf", ".xml": "application/xml",
};
/** @type {Record<string, "markdown"|"svg"|"mermaid">} */ const DRAWN = { ".md": "markdown", ".markdown": "markdown", ".mmd": "mermaid" };
const MAX_FILE = 64 * 1024 * 1024;
export const BRIDGE_SRC = "/__vyre/claude.js";

/** The preview a request is for, from the host the person is on (the front sends it as x-forwarded-host): pv-<id>.<base>. @param {http.IncomingMessage} req */
export function idFromHost(req) {
  const m = /^pv-([0-9a-f]{8})\./.exec(String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase());
  return m ? m[1] : null;
}

/**
 * Where a request path lands under a root: the file, or null. Refuses `..`, a dotfile (but not `.well-known`), a symlink that leaves the root, a NUL byte, and anything not a regular file.
 * A path with no extension that is not a file falls back to the folder's index.html (a single-page app).
 * @param {string} root real path of the preview's folder @param {string} urlPath
 */
export function resolveIn(root, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  if (p.includes("\0")) return null;
  const parts = p.split("/").filter(Boolean);
  if (parts.some(x => x === ".." || (x.startsWith(".") && x !== ".well-known"))) return null;
  const ok = (/** @type {string} */ f) => { try { const real = fs.realpathSync(f); const st = fs.statSync(real); return real.startsWith(root + path.sep) || real === root ? (st.isFile() ? real : null) : null; } catch { return null; } };
  const target = path.join(root, ...parts);
  let f = ok(target);
  if (!f) { try { if (fs.statSync(target).isDirectory()) f = ok(path.join(target, "index.html")); } catch { /* not a directory */ } }
  if (!f && !path.extname(parts[parts.length - 1] || "")) f = ok(path.join(root, "index.html"));
  return f;
}

/**
 * Put the bridge's script tag at the top of an HTML page (before any of the page's own scripts), without otherwise touching it. @param {string} html
 */
export function injectBridge(html) {
  const tag = `<script src="${BRIDGE_SRC}"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + "<head>" + tag + "</head>");
  return tag + html;
}

/**
 * @param {{ lookup: (id: string) => { root: string, file: string | null, caps: boolean } | null, drawn: (format: string, title: string, text: string) => Promise<string>, api?: (req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL) => Promise<boolean>, log?: (m: string) => void }} o
 * `lookup` says what a preview serves (its folder, or its one file) and whether it declared capabilities; `drawn` turns Markdown, SVG, Mermaid text into a page; `api` answers /__vyre/ (the bridge).
 */
export function createStatic(o) {
  const server = http.createServer(async (req, res) => {
    const id = idFromHost(req);
    const gone = () => { res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end("not found"); return true; };
    try {
      const pv = id ? o.lookup(id) : null;
      if (!id || !pv) return void gone();
      const url = new URL(req.url || "/", "http://x");
      if (url.pathname.startsWith("/__vyre/")) {
        if (o.api && (await o.api(req, res, id, url))) return;
        return void gone();
      }
      if (!["GET", "HEAD"].includes(String(req.method))) { res.writeHead(405, { allow: "GET, HEAD" }); return void res.end("method not allowed"); }
      // A preview of one file serves that file at "/" (and its own folder's files beside it); a folder serves itself.
      const f = url.pathname === "/" && pv.file ? pv.file : resolveIn(pv.root, url.pathname);
      if (!f) return void gone();
      const st = fs.statSync(f);
      if (st.size > MAX_FILE) { res.writeHead(413); return void res.end("too big"); }
      const ext = path.extname(f).toLowerCase();
      const base = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
      if (DRAWN[ext] || (ext === ".svg" && url.pathname === "/" && pv.file === f)) {
        const format = DRAWN[ext] || "svg";
        const html = await o.drawn(format, path.basename(f), fs.readFileSync(f, "utf8"));
        res.writeHead(200, { ...base, "content-type": "text/html; charset=utf-8" });
        return void res.end(req.method === "HEAD" ? undefined : html);
      }
      if (ext === ".html" || ext === ".htm") {
        const text = fs.readFileSync(f, "utf8");
        const body = pv.caps ? injectBridge(text) : text;
        res.writeHead(200, { ...base, "content-type": MIME[ext] });
        return void res.end(req.method === "HEAD" ? undefined : body);
      }
      res.writeHead(200, { ...base, "content-type": MIME[ext] || "application/octet-stream", "content-length": String(st.size) });
      if (req.method === "HEAD") return void res.end();
      fs.createReadStream(f).on("error", () => res.destroy()).pipe(res);
    } catch (e) {
      o.log?.(`previews: serving ${String(req.url).slice(0, 80)}: ${/** @type {Error} */ (e).message}`);
      if (!res.headersSent) { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("could not read that"); } else res.destroy();
    }
  });
  return server;
}
