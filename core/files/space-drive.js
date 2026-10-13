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
/** A model working a team chat's turn may READ the Space's Drive, as the member who spoke (the daemon's edge defaults `space` to the chat's); writing and restoring stay the person's own. */
const READ_CALLERS = [...CALLERS, "mcp"];
/** The most one upload call carries, decoded. A larger file goes through the Flow or the VyreDrive mount, not a tool call. */
export const MAX_UPLOAD = 8 * 1024 * 1024;

/** @param {any} ctx */
export function registerSpaceDrive(ctx) {
  const door = createDoor(ctx);
  /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: any, drive: any) => Promise<any>} fn */
  const tool = (name, description, input, fn) => ctx.tool(name, { description, input, callers: /^files\.drive\.space\.(list|read|stat|changes)$/.test(name) ? READ_CALLERS : CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
    const d = await door.open(i || {}, meta);
    if (!d.gateway.drive) throw refuse("this Space has no Drive yet; ask the owner or an admin of the Space", "unavailable");
    return fn(i || {}, d, d.gateway.drive);
  } });
  const pathOf = (/** @type {any} */ p) => { try { return safePath(String(p ?? "")); } catch { throw refuse("that is not a path in the Drive: no leading slash, dot segments, backslash, encoded slash or control characters", "bad_input"); } };

  tool("files.drive.upload", `Put a file in the Space's Drive as a new version, under the caller's own grants: { space?, path, base64, base? }. \`path\` is relative (Clients/A/retainer.pdf), \`base64\` the bytes (at most ${MAX_UPLOAD / 1048576} MB here), \`base\` the version you edited from (a second writer on one file makes a new version flagged conflict, never a merge). Answers { path, version, conflict }.`,
    obj({ space: str, path: str, base64: str, base: { type: "integer" } }, ["path", "base64"]), async (i, d, drive) => {
      const p = pathOf(i.path), text = String(i.base64 ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw refuse("base64 is the file's bytes, standard base64", "bad_input");
      // Check the size before decoding: 4 base64 characters carry 3 bytes.
      if (Math.floor(text.length / 4) * 3 > MAX_UPLOAD + 3) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow (flows.list shows them) or the VyreDrive mount`, "too_large");
      const bytes = new Uint8Array(Buffer.from(text, "base64"));
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB; a larger one goes through a Flow (flows.list shows them) or the VyreDrive mount`, "too_large");
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

  tool("files.drive.space.read", `Download one file from the Space's Drive, head or a named version, under the caller's own grants: { space?, path, version?, offset?, length? }. Answers { path, version, size, base64 } for a file of at most ${MAX_UPLOAD / 1048576} MB (\`too_large\` beyond). With \`offset\` and \`length\` (at most ${MAX_UPLOAD / 1048576} MB a call) it answers that range of any size of file: { path, version, offset, size, total, base64 }, \`size\` being the bytes in this answer and \`total\` the file's.`,
    obj({ space: str, path: str, version: { type: "integer" }, offset: { type: "integer" }, length: { type: "integer" } }, ["path"]), async (i, d, drive) => {
      const p = pathOf(i.path);
      if (i.version !== undefined && (!Number.isInteger(i.version) || i.version < 1)) throw refuse("name a version number", "bad_input");
      if (i.offset !== undefined || i.length !== undefined) {
        if (!Number.isInteger(i.offset) || i.offset < 0 || !Number.isInteger(i.length) || i.length < 1) throw refuse("offset is 0 or more and length is a positive number of bytes", "bad_input");
        if (i.length > MAX_UPLOAD) throw refuse(`a range here is at most ${MAX_UPLOAD / 1048576} MB`, "too_large");
        const r = await drive.getRange(d.chain, p, { version: i.version ?? null, offset: i.offset, length: i.length });
        return { path: p, version: i.version ?? null, offset: i.offset, size: r.bytes.length, total: r.size, base64: Buffer.from(r.bytes).toString("base64") };
      }
      const bytes = await drive.get(d.chain, p, { version: i.version ?? null, maxBytes: MAX_UPLOAD });
      if (bytes.length > MAX_UPLOAD) throw refuse(`a file here is at most ${MAX_UPLOAD / 1048576} MB to download in one call`, "too_large");
      return { path: p, version: i.version ?? null, size: bytes.length, base64: Buffer.from(bytes).toString("base64") };
    });

  // The tools a mount (Finder, File Explorer) needs beyond the app's own: what changed since an anchor, one file's version without its bytes, a rename, and a delete that goes to the trash.
  tool("files.drive.space.changes", "What changed in the Space's Drive since a change number, under the caller's own grants: { space?, prefix?, since?, limit? }. `since` is the `anchor` the last answer gave (leave it out for the first listing: every file, none deleted). Answers { prefix, anchor, items: [{ path, size, version, at, seq, deleted }], more }, oldest change first, only what the caller may read; when `more` is true ask again from `anchor`.",
    obj({ space: str, prefix: str, since: { type: "integer" }, limit: { type: "integer" } }), async (i, d, drive) => {
      const raw = String(i.prefix ?? ""), prefix = raw === "" ? "" : pathOf(raw.replace(/\/+$/, "")) + "/";
      if (i.since !== undefined && (!Number.isInteger(i.since) || i.since < 0)) throw refuse("since is the anchor the last answer gave", "bad_input");
      if (i.limit !== undefined && (!Number.isInteger(i.limit) || i.limit < 1)) throw refuse("limit is a positive number", "bad_input");
      const r = await drive.changes(d.chain, prefix, { since: i.since ?? null, limit: i.limit });
      return { prefix, anchor: r.anchor, items: r.items, more: Boolean(r.more) };
    });

  tool("files.drive.space.stat", "One file's current version, size and content hash, without its bytes, under the caller's own grants: { space?, path }. A file the caller may not read is the same as one that is not there.",
    obj({ space: str, path: str }, ["path"]), async (i, d, drive) => {
      const p = pathOf(i.path), st = await drive.stat(d.chain, p);
      return { path: p, version: st.version, size: st.size, sha256: st.sha256 ?? null };
    });

  tool("files.drive.space.move", "Move or rename one file in the Space's Drive, as the caller: { space?, from, to }. Needs the right to read and write `from` and to write `to`; a file already at `to` is refused (`exists`). Answers { path, version }.",
    obj({ space: str, from: str, to: str }, ["from", "to"]), async (i, d, drive) => drive.move(d.chain, pathOf(i.from), pathOf(i.to)));

  tool("files.drive.space.trash", "Delete a file from a mount: it moves under .trash/ (versions kept, nothing is lost) and an owner or admin can bring it back; the real delete is a separate act that asks. { space?, path }. Answers { path, version } with the path in the trash.",
    obj({ space: str, path: str }, ["path"]), async (i, d, drive) => drive.trash(d.chain, pathOf(i.path)));
}
