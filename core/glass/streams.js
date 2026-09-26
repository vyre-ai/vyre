// @ts-check
// streams: the bytes of Glass's files, on two plain HTTP routes (ADR 0005, decision 4).
//
// JSON tools never carry file bytes. A tool (glass.files.download, .preview or .upload) checks
// the path, goes through the Rules like every call, and hands back a ticket; the bytes then move
// on GET /v1/glass/raw?ticket= or PUT /v1/glass/put?ticket=. A ticket is 32 random bytes, works
// once, lasts 60 s, and is bound to what the tool agreed to: the operation, target, path, size,
// overwrite and caller. Tickets live in memory only and are swept when one is used, so an idle
// Glass runs no timer at all.
//
// A raw file never runs in the Deck's origin: every response is nosniff with a CSP of
// "default-src 'none'; sandbox", and only raster images and PDFs are served inline. An SVG or an
// HTML file downloads as an attachment.

import crypto from "node:crypto";
import { INLINE, mimeOf } from "./mime.js";

export const TICKET_MS = 60_000;

/**
 * @typedef {{ op: "raw"|"put", target: string, path: string, size: number, overwrite: boolean, caller: string, name: string }} Grant
 */

/** A caller that names an agent ("mcp:agent:kit"), as vyred's router has already checked it. */
const agentOf = caller => { const m = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/.exec(String(caller || "")); return m ? m[1] : null; };

export class Tickets {
  constructor() {
    /** @type {Map<string, Grant & { expires: number }>} */
    this.map = new Map();
    this.now = () => Date.now();
  }

  /** @param {Grant} grant @returns {string} */
  issue(grant) {
    this.sweep();
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.map.set(ticket, { ...grant, expires: this.now() + TICKET_MS });
    return ticket;
  }

  sweep() {
    const now = this.now();
    for (const [k, t] of this.map) if (t.expires <= now) this.map.delete(k);
  }

  /**
   * Spend a ticket for one operation. Null when it is unknown, used, expired or for another
   * operation; it is gone afterwards either way. A browser following a link cannot say who it
   * is, so the binding to the caller is this: a ticket an agent asked for works only for that
   * agent, and an agent can never spend a ticket someone else asked for.
   * @param {unknown} ticket @param {"raw"|"put"} op @param {string} caller
   * @returns {Grant|null}
   */
  redeem(ticket, op, caller) {
    const key = String(ticket || "");
    const t = this.map.get(key);
    this.sweep();
    if (!t) return null;
    this.map.delete(key);
    if (t.expires <= this.now() || t.op !== op) return null;
    if (agentOf(t.caller) !== agentOf(caller)) return null;
    return t;
  }
}

/** A Content-Disposition value: an ASCII fallback, and the real name per RFC 5987. */
export function disposition(kind, name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
  const encoded = encodeURIComponent(String(name)).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const SAFE = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store",
  "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" };

function sendError(res, status, code, message, extra = {}) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", ...SAFE, ...extra });
  res.end(JSON.stringify({ error: { code, message } }));
}

const statusOf = e => {
  const c = e && e.code;
  return c === "exists" ? 409 : c === "too_large" ? 413 : c === "wrong_size" ? 400 : c === "range" ? 416
    : /does not exist/.test(String(e && e.message)) ? 404 : /private|outside|climbs|absolute/.test(String(e && e.message)) ? 403 : 500;
};

/**
 * Register /v1/glass/raw and /v1/glass/put.
 * @param {any} ctx
 * @param {{ tickets: Tickets, providerFor: (target: string) => any, emit: (type: string, payload: any) => void }} deps
 */
export function register(ctx, { tickets, providerFor, emit }) {
  ctx.route("raw", async (req, res, { caller, url }) => {
    if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "method", "raw is GET only", { allow: "GET, HEAD" });
    const t = tickets.redeem(url.searchParams.get("ticket"), "raw", caller);
    if (!t) return sendError(res, 403, "bad_ticket", "that ticket is unknown, used or expired; ask for a new one");
    let r;
    try { r = await providerFor(t.target).read(t.path, req.headers.range); }
    catch (e) {
      const status = statusOf(e);
      return sendError(res, status, e.code || "failed", e.message, status === 416 ? { "content-range": `bytes */${e.total ?? "*"}` } : {});
    }
    const mime = mimeOf(t.name);
    const inline = INLINE.has(mime);
    const length = r.total ? r.end - r.start + 1 : 0;
    res.writeHead(r.partial ? 206 : 200, {
      ...SAFE,
      "content-type": inline ? mime : "application/octet-stream",
      "content-disposition": disposition(inline ? "inline" : "attachment", t.name),
      "content-length": String(length), "accept-ranges": "bytes",
      ...(r.partial ? { "content-range": `bytes ${r.start}-${r.end}/${r.total}` } : {}),
    });
    if (req.method === "HEAD") { r.stream.destroy(); res.end(); return; }
    r.stream.on("error", () => res.destroy());
    res.on("close", () => r.stream.destroy());
    r.stream.pipe(res);
  });

  ctx.route("put", async (req, res, { caller, url }) => {
    if (req.method !== "PUT") return sendError(res, 405, "method", "put is PUT only", { allow: "PUT" });
    const t = tickets.redeem(url.searchParams.get("ticket"), "put", caller);
    if (!t) { req.resume(); return sendError(res, 403, "bad_ticket", "that ticket is unknown, used or expired; ask for a new one", { connection: "close" }); }
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) !== t.size) {
      req.resume();
      return sendError(res, 400, "wrong_size", `the upload was announced as ${t.size} bytes and this request says ${declared}`, { connection: "close" });
    }
    try {
      const r = await providerFor(t.target).write(t.path, req, { size: t.size, overwrite: t.overwrite });
      emit("file.uploaded", { target: t.target, path: t.path, size: r.size, by: t.caller });
      res.writeHead(200, { "content-type": "application/json", ...SAFE });
      res.end(JSON.stringify({ data: { path: t.path, size: r.size } }));
    } catch (e) {
      req.resume();
      sendError(res, statusOf(e), e.code || "failed", e.message, { connection: "close" });
    }
  });
}
