// @ts-check
// core/files/space-drive.js: the Space's own Drive (kernel/storage/drive.js, behind kernel/gateway/drive.js) for the app: upload a new version of a file, list a file's versions, restore one.
// Not the box's shared folders (files.drive.list and files.drive.read in browse.js are those). Every call is the CALLER'S own chain in the Space it names (lib/gateway-door.js): a call that proved
// no person is refused, the kernel's `drive.write`, `drive.read` and `drive.restore` grants decide, a path is checked in one form (kernel/seal/uses.js safePath) and an upload is size-capped.
// A Space with no Drive wired answers `unavailable`.
import { createDoor } from "../../lib/gateway-door.js";
import { safePath } from "../../kernel/seal/uses.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device"];
/** The most one upload call carries, decoded. A larger file goes through the Flow or the VyreDrive mount, not a tool call. */
export const MAX_UPLOAD = 8 * 1024 * 1024;

/**
 * The chats the caller is in, as { project, chat } (work.chat.list: only chats the caller is in, `open` not false). A box without the tool, or one that does not answer, has none to add: search then covers the Drive root only.
 * At most 50. @param {any} ctx @param {any} meta @returns {Promise<{ project: string, chat: string }[]>}
 */
async function chatsOf(ctx, meta) {
  let r;
  try { r = await ctx.call("work.chat.list", {}, { as: meta && meta.caller }); } catch { return []; }
  const data = r && r.data !== undefined ? r.data : r;
  const rows = Array.isArray(data) ? data : data && Array.isArray(data.chats) ? data.chats : data && Array.isArray(data.rows) ? data.rows : [];
  const out = [];
  for (const row of rows) {
    const x = row && typeof row === "object" ? (row.data && typeof row.data === "object" ? { ...row.data, ...row } : row) : null;
    if (!x || x.open === false) continue;
    const chat = String(x.chat ?? x.id ?? "").replace(/^.*\//, ""), project = String(x.project ?? "");
    if (/^chat_[A-Za-z0-9_-]{4,64}$/.test(chat) && /^[A-Za-z0-9._-]{1,128}$/.test(project)) out.push({ project, chat });
    if (out.length >= 50) break;
  }
  return out;
}

/** @param {any} ctx */
export function registerSpaceDrive(ctx) {
  const door = createDoor(ctx);
  /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: any, drive: any, meta: any) => Promise<any>} fn */
  const tool = (name, description, input, fn) => ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
    const d = await door.open(i || {}, meta);
    if (!d.gateway.drive) throw refuse("this Space has no Drive yet", "unavailable");
    return fn(i || {}, d, d.gateway.drive, meta || {});
  } });
  const pathOf = (/** @type {any} */ p) => { try { return safePath(String(p ?? "")); } catch { throw refuse("that is not a path in the Drive: no leading slash, dot segments, backslash, encoded slash or control characters", "bad_input"); } };

  tool("files.drive.upload", `Put a file in the Space's Drive as a new version, under the caller's own grants: { space?, path, base64, base? }. \`path\` is relative (Clients/A/retainer.pdf), \`base64\` the bytes (at most ${MAX_UPLOAD / 1048576} MB here), \`base\` the version you edited from (a second writer on one file makes a new version flagged conflict, never a merge). Answers { path, version, conflict }.`,
    obj({ space: str, path: str, base64: str, base: { type: "integer" } }, ["path", "base64"]), async (i, d, drive) => {
      const p = pathOf(i.path), text = String(i.base64 ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw refuse("base64 is the file's bytes, standard base64", "bad_input");
      // Check the size before decoding: 4 base64 characters carry 3 bytes.
      if (Math.floor(text.length / 4) * 3 > MAX_UPLOAD + 3) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow or the VyreDrive mount`, "too_large");
      const bytes = new Uint8Array(Buffer.from(text, "base64"));
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow or the VyreDrive mount`, "too_large");
      if (i.base !== undefined && (!Number.isInteger(i.base) || i.base < 1)) throw refuse("base is a version number", "bad_input");
      const r = await drive.put(d.chain, p, bytes, { base: i.base ?? null });
      return { path: p, version: r.version, conflict: Boolean(r.conflict), size: bytes.length };
    });

  tool("files.drive.versions", "The versions of one file in the Space's Drive, newest last, under the caller's own grants: { space?, path, after?, limit? }. Answers { path, versions: [{ ver, size, at, by, ... }], next } (at most `limit`, default 200, at most 1,000, those after version `after`; `next` is the version to pass as `after`, or null); a file the caller may not read is the same as one that is not there.",
    obj({ space: str, path: str, after: { type: "integer" }, limit: { type: "integer" } }, ["path"]), async (i, d, drive) => {
      const p = pathOf(i.path);
      if (i.after !== undefined && (!Number.isInteger(i.after) || i.after < 0)) throw refuse("after is a version number", "bad_input");
      if (i.limit !== undefined && (!Number.isInteger(i.limit) || i.limit < 1)) throw refuse("limit is a positive number", "bad_input");
      const limit = Math.min(i.limit ?? 200, 1000), rest = (await drive.history(d.chain, p)).filter((/** @type {any} */ v) => v.ver > (i.after ?? 0));
      return { path: p, versions: rest.slice(0, limit), next: rest.length > limit ? rest[limit - 1].ver : null };
    });

  tool("files.drive.restore", "Restore an old version of a file in the Space's Drive as a NEW version (nothing is lost): { space?, path, version }. The person's own act with their presence proof, which rides beside the request. Answers { path, from, version }.",
    obj({ space: str, path: str, version: { type: "integer" } }, ["path", "version"]), async (i, d, drive) => {
      const p = pathOf(i.path);
      if (!Number.isInteger(i.version) || i.version < 1) throw refuse("name a version number", "bad_input");
      const r = await drive.restore(d.chain, p, i.version, d.proof ? { presence: d.proof } : {});
      return { path: p, from: i.version, version: r.version };
    });

  tool("files.drive.space.list", "The files in the Space's Drive under a folder, under the caller's own grants: { space?, prefix?, limit?, after? }. Answers { prefix, entries: [...], next } with only what the caller may read, at most `limit` (default 500, at most 1,000) per call; `next` is the cursor to pass as `after`, or null at the end.",
    obj({ space: str, prefix: str, limit: { type: "integer" }, after: str }), async (i, d, drive) => {
      const raw = String(i.prefix ?? ""), prefix = raw === "" ? "" : pathOf(raw.replace(/\/+$/, "")) + "/";
      if (i.limit !== undefined && (!Number.isInteger(i.limit) || i.limit < 1)) throw refuse("limit is a positive number", "bad_input");
      if (i.after !== undefined && typeof i.after !== "string") throw refuse("after is the cursor the last page gave", "bad_input");
      const r = await drive.listPage(d.chain, prefix, { limit: i.limit, after: i.after ?? null });
      return { prefix, entries: r.entries, next: r.next };
    });

  tool("files.drive.space.search", "Find files in the Space's Drive by name, under the caller's own grants: { space?, q, limit? }. Names and paths only, never a word from inside a file. What the caller may not read is the same as not there: a chat's files are its participants' only (kernel/core/folders.js), so a file, a folder name or a path in a chat the caller is not in never comes back, even for its exact name. The chats the caller is in (work.chat.list) are searched too, each folder read under the caller's own chain, and those results name their chat. Answers { q, results: [{ path, name, size?, mtime?, chat? }], more } (at most `limit`, default 30, at most 100).",
    obj({ space: str, q: str, limit: { type: "integer" } }, ["q"]), async (i, d, drive, meta) => {
      const q = String(i.q ?? "").trim().toLowerCase();
      if (q.length < 2 || q.length > 200) throw refuse("type two letters or more to search the Drive", "bad_input");
      if (i.limit !== undefined && (!Number.isInteger(i.limit) || i.limit < 1)) throw refuse("limit is a positive number", "bad_input");
      const limit = Math.min(i.limit ?? 30, 100), words = q.split(/\s+/);
      const results = /** @type {any[]} */ ([]);
      const seen = new Set();
      let more = false;
      const take = (/** @type {any} */ e, /** @type {string | null} */ chat) => {
        const path = String(e && (e.path ?? e.name ?? e)), hay = path.toLowerCase();
        if (seen.has(path) || !words.every((/** @type {string} */ w) => hay.includes(w))) return;
        if (results.length >= limit) { more = true; return; }
        seen.add(path);
        results.push({ path, name: path.split("/").pop() || path, ...(Number.isFinite(e && e.size) ? { size: e.size } : {}), ...(Number.isFinite(e && e.mtime) ? { mtime: e.mtime } : {}), ...(chat ? { chat } : {}) });
      };
      /** One folder's pages, every entry asked about under THIS caller's chain by the kernel: what is not theirs to read is never in a page. A refusal is absence. */
      const walk = async (/** @type {string} */ prefix, /** @type {string | null} */ chat, /** @type {number} */ pages) => {
        let after = null;
        for (let page = 0; page < pages; page++) {
          let r;
          try { r = await drive.listPage(d.chain, prefix, { limit: 1000, after }); }
          catch (e) { if (/** @type {any} */ (e)?.code && ["not_found", "denied"].includes(/** @type {any} */ (e).code)) return; throw e; }
          for (const e of r.entries) take(e, chat);
          if (!r.next) return;
          after = r.next;
          if (page === pages - 1) more = true;
        }
      };
      await walk("", null, 20);
      // The chats the caller is in. The list only says where to look: each folder is read under the caller's own chain, so a chat named wrongly (or one the caller left) gives nothing.
      for (const c of await chatsOf(ctx, meta)) {
        if (more && results.length >= limit) break;
        await walk(`Projects/${c.project}/chat/${c.chat}/`, c.chat, 3);
        await walk(`Projects/${c.project}/made/${c.chat}/`, c.chat, 3);
      }
      return { q, results, more };
    });

  tool("files.drive.space.read", `Download one file from the Space's Drive, head or a named version, under the caller's own grants: { space?, path, version? }. Answers { path, version, size, base64 } for a file of at most ${MAX_UPLOAD / 1048576} MB (\`too_large\` beyond).`,
    obj({ space: str, path: str, version: { type: "integer" } }, ["path"]), async (i, d, drive) => {
      const p = pathOf(i.path);
      if (i.version !== undefined && (!Number.isInteger(i.version) || i.version < 1)) throw refuse("name a version number", "bad_input");
      const bytes = await drive.get(d.chain, p, { version: i.version ?? null, maxBytes: MAX_UPLOAD });
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB to download in one call`, "too_large");
      return { path: p, version: i.version ?? null, size: bytes.length, base64: Buffer.from(bytes).toString("base64") };
    });
}
