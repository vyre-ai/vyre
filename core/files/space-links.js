// @ts-check
// core/files/space-links.js: shared links to a file in the Space's Drive, for the app's Shared links tab. A link is a copy of one version of one file, made when the person says yes
// (the box reads it under the caller's own chain, so the kernel's `drive.read` grant still decides who may share what), kept under a random code and served read only until it
// expires or is revoked. Making one is outward (a file leaves the Space), so an assistant's ask is held for a person (the one-yes queue) and a person's own call carries their presence.
// The copy is the point: a link never reaches the kernel or the live file, so sharing a version cannot widen anyone's grants or show a later edit. Revoking deletes the copy.
//
//   files.drive.link.create  { space?, path, version?, days? }  -> { code, url, name, version, size, expires }   (days: 1 to 30, default 7)
//   files.drive.link.list    { }                                -> { links: [{ code, url, name, path, version, size, made_at, expires, opens, active }] }
//   files.drive.link.revoke  { code }                           -> { revoked: true }
//   GET /v1/files/s?c=<code>                                    -> the bytes, attachment, no-store; 404 for anything else (a wrong, expired or revoked code look the same)
import crypto from "node:crypto";
import { createDoor } from "../../lib/gateway-door.js";
import { safePath } from "../../kernel/seal/uses.js";
import { chatFolderOf } from "../../kernel/core/folders.js";
import { MAX_UPLOAD } from "./space-drive.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device"];
const DAY = 86_400_000;
export const DEFAULT_DAYS = 7, MAX_DAYS = 30;
/** What may be shared at once: live links, and the copies they hold. An expired or revoked link holds nothing, so it counts for neither. */
export const MAX_LINKS = 100, MAX_TOTAL_BYTES = 64 * 1048576;
/** Where a link is read, relative to the box's own address. */
export const LINK_PATH = "/v1/files/s";
const CODE = /^[A-Za-z0-9_-]{22}$/;

export const LINK_MIGRATIONS = [
  `CREATE TABLE files_links (code TEXT PRIMARY KEY, space TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, version INTEGER, size INTEGER NOT NULL, mime TEXT NOT NULL, bytes BLOB,
     made_by TEXT NOT NULL, made_at INTEGER NOT NULL, expires INTEGER NOT NULL, revoked_at INTEGER, opens INTEGER NOT NULL DEFAULT 0)`,
];

const MIME = { txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
/** A type for the download. A file the table does not know is plain bytes, never something a browser would run (html and svg are bytes too). @param {string} name */
export const mimeOf = (name) => /** @type {any} */ (MIME)[String(name).split(".").pop()?.toLowerCase() ?? ""] || "application/octet-stream";

/** Is this path in a chat's folders (kernel/core/folders.js decides what that is)? Those files are their participants' only, so a code that anyone can hold never serves them. @param {string} space @param {string} p */
const inChatFolder = (space, p) => chatFolderOf(`vyre://${space}/file/${p}`, space) !== null;

/** @param {any} ctx @param {{ now?: () => number }} [o] */
export function registerSpaceLinks(ctx, o = {}) {
  const now = o.now || (() => Date.now());
  const door = createDoor(ctx);
  const db = () => { ctx.store.migrate(LINK_MIGRATIONS); return ctx.store.db; };
  let ready = false;
  /** An expired link keeps no copy: drop the bytes of every link past its end, so a file does not sit on the box after the person's chosen time. */
  const sweep = () => open().prepare("UPDATE files_links SET bytes = NULL WHERE bytes IS NOT NULL AND expires <= ?").run(now());
  const open = () => { const d = ready ? ctx.store.db : db(); ready = true; return d; };
  const view = (/** @type {any} */ r, /** @type {number} */ t) => ({ code: r.code, url: `${LINK_PATH}?c=${r.code}`, name: r.name, path: r.path, version: r.version, size: r.size, made_at: r.made_at, expires: r.expires, opens: r.opens, active: !r.revoked_at && r.expires > t && r.bytes !== null });

  const t = (/** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ input, /** @type {any} */ extra, /** @type {(i: any, meta: any) => Promise<any>} */ run) =>
    ctx.tool(name, { description, input, callers: CALLERS, ...extra, run: async (/** @type {any} */ i, /** @type {any} */ meta) => run(i || {}, meta || {}) });

  t("files.drive.link.create", `Share one version of a file in the Space's Drive with a link that reads it until it expires: { space?, path, version?, days? } (days 1 to ${MAX_DAYS}, default ${DEFAULT_DAYS}). The box takes a copy of that version under the caller's own grants, so a later edit is not shown and a revoked link deletes the copy. Anyone who holds the link can read the copy, so it is outward: an assistant's ask waits for a person. Answers { code, url, name, version, size, expires }.`,
    obj({ space: str, path: str, version: { type: "integer" }, days: { type: "integer" } }, ["path"]),
    { presence: { summary: async (/** @type {any} */ i) => `Share ${String(i && i.path || "a file")} with a link` } },
    async (i, meta) => {
      let p; try { p = safePath(String(i.path ?? "")); } catch { throw refuse("that is not a path in the Drive", "bad_input"); }
      if (i.version !== undefined && (!Number.isInteger(i.version) || i.version < 1)) throw refuse("name a version number", "bad_input");
      const days = i.days === undefined ? DEFAULT_DAYS : i.days;
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw refuse(`a link lasts 1 to ${MAX_DAYS} days`, "bad_input");
      const d = await door.open(i, meta);
      if (!d.gateway.drive) throw refuse("this Space has no Drive yet", "unavailable");
      // The read goes first, under the caller's own chain, so someone outside a chat learns nothing from this call (the same refusal as a missing file). Then a chat's file is never made a public link: a link is
      // opened by anyone who holds its code, and a chat's files are its participants' only; "Share to project" is the way to let members read one file.
      const bytes = await d.gateway.drive.get(d.chain, p, { version: i.version ?? null, maxBytes: MAX_UPLOAD });
      if (inChatFolder(d.space, p)) throw refuse("a chat's files are its participants' only, so they cannot be shared with a link. Use Share to project to let the project's members read one file.", "denied");
      if (bytes.length > MAX_UPLOAD) throw refuse(`a shared file is at most ${MAX_UPLOAD / 1048576} MB`, "too_large");
      sweep();
      const held = /** @type {any} */ (open().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files_links WHERE bytes IS NOT NULL").get());
      if (held.n >= MAX_LINKS) throw refuse(`at most ${MAX_LINKS} links can be live at once; revoke one first`, "too_many");
      if (held.bytes + bytes.length > MAX_TOTAL_BYTES) throw refuse(`live links can hold at most ${MAX_TOTAL_BYTES / 1048576} MB of files; revoke one first`, "too_large");
      const code = crypto.randomBytes(16).toString("base64url");
      const name = p.split("/").pop() || p, at = now();
      const hop = d.chain.hops[d.chain.hops.length - 1].actor;
      open().prepare("INSERT INTO files_links (code, space, path, name, version, size, mime, bytes, made_by, made_at, expires) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(code, d.space, p, name, i.version ?? null, bytes.length, mimeOf(name), Buffer.from(bytes), `${hop.kind}:${hop.id}`, at, at + days * DAY);
      return view({ code, name, path: p, version: i.version ?? null, size: bytes.length, made_at: at, expires: at + days * DAY, opens: 0, bytes: 1 }, at);
    });

  t("files.drive.link.list", "The shared links made on this box, newest first, with when each expires, how often it was opened and whether it still works. Never the file's bytes.", obj(), { }, async (i, meta) => {
    await door.open(i, meta);
    sweep();
    const at = now();
    return { links: open().prepare("SELECT code, path, name, version, size, made_at, expires, revoked_at, opens, bytes IS NOT NULL AS has FROM files_links ORDER BY made_at DESC LIMIT 200").all()
      .map((/** @type {any} */ r) => view({ ...r, bytes: r.has ? 1 : null }, at)) };
  });

  t("files.drive.link.revoke", "Stop a shared link now and delete the copy it served: { code }. Taking access away is always allowed.", obj({ code: str }, ["code"]), { }, async (i, meta) => {
    await door.open(i, meta);
    const code = String(i.code ?? "");
    if (!CODE.test(code)) throw refuse("that is not a link code", "bad_input");
    const r = open().prepare("UPDATE files_links SET revoked_at = ?, bytes = NULL WHERE code = ? AND revoked_at IS NULL").run(now(), code);
    if (!r.changes) throw refuse("no such link, or it is already revoked", "not_found");
    return { revoked: true };
  });

  // The read side. One answer for a wrong, expired or revoked code, so nothing is learned from the difference. It sends the bytes as a download with no sniffing and no caching.
  ctx.route("s", async (/** @type {any} */ req, /** @type {any} */ res, /** @type {{ url: URL }} */ { url }) => {
    const gone = () => { res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify({ error: { code: "not_found", message: "this link does not work" } })); };
    const code = String(url.searchParams.get("c") ?? "");
    if (!CODE.test(code)) return gone();
    sweep();
    const row = /** @type {any} */ (open().prepare("SELECT space, path, name, mime, size, bytes, expires, revoked_at FROM files_links WHERE code = ?").get(code));
    if (!row || row.revoked_at || row.bytes === null || row.expires <= now()) return gone();
    // Checked on every open, not only when the link was made: a link that came to point into a chat's folders (an older one, or a file moved there) serves nothing, as if it were not there.
    if (inChatFolder(String(row.space), String(row.path))) return gone();
    open().prepare("UPDATE files_links SET opens = opens + 1 WHERE code = ?").run(code);
    const safeName = String(row.name).replace(/[^\w. -]/g, "_");
    res.writeHead(200, { "content-type": row.mime, "content-length": row.size, "content-disposition": `attachment; filename="${safeName}"`, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "referrer-policy": "no-referrer" });
    return res.end(req.method === "HEAD" ? undefined : Buffer.from(row.bytes));
  }, { readOnly: true });
}
