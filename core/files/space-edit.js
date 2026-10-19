// @ts-check
// core/files/space-edit.js: move, rename and delete in the Space's Drive, each under the caller's own chain (lib/gateway-door.js), through the gateway's drive (kernel/gateway/drive.js), so every step is the kernel's own
// decision: `drive.read` and `drive.write` on the source and the destination of a move, `drive.delete` for a delete (an outward act: the kernel asks, and the answer reaches the person as it is). Nothing is lost silently:
// the Drive keeps every version, a move writes the new path before it removes the old one, and a delete is a tombstone version that files.drive.versions lists and files.drive.restore brings back.
// A file moves by get + put + delete (no kernel call is added); a folder moves with the gateway's moveFolder.
import { PERSON_SURFACES } from "../../lib/person-surfaces.js";
import { createDoor } from "../../lib/gateway-door.js";
import { safePath } from "../../kernel/seal/uses.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const CALLERS = [...PERSON_SURFACES, "device"];
/** Most files a folder delete takes in one call; a bigger folder is done in parts, so one call cannot empty a Drive. */
export const MAX_FOLDER_DELETE = 200;
/** The largest file a move carries through this call, as upload does. */
const MAX_MOVE = 8 * 1024 * 1024;

const pathOf = (/** @type {any} */ p) => { try { const s = safePath(String(p ?? "")); if (!s) throw 0; return s.replace(/\/+$/, ""); } catch { throw refuse("that is not a path in the Drive: no leading slash, dot segments, backslash, encoded slash or control characters", "bad_input"); } };
const nameOf = (/** @type {any} */ n) => { const s = String(n ?? ""); if (!s || s.includes("/") || s.includes("\\") || s === "." || s === "..") throw refuse("a name has no slash and is not . or ..", "bad_input"); return pathOf(s); };
const parent = (/** @type {string} */ p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
/** A folder in the Drive is the path its files share, so an empty one is held by this one empty file inside it. Listings hide it (apps/app/screens/drive/space-model.ts); a folder delete or move carries it like any file. */
export const FOLDER_MARK = ".folder";
const MAX_FOLDER_NAME = 120;
const isNotFound = (/** @type {any} */ e) => e && e.code === "not_found";

/** What a path is in the Drive: a file (it has a head), a folder (files sit under it) or nothing. @param {any} drive @param {any} chain @param {string} p */
async function kindOf(drive, chain, p) {
  try { await drive.stat(chain, p); return "file"; } catch (e) { if (!isNotFound(e)) throw e; }
  const under = await drive.listPage(chain, `${p}/`, { limit: 1 });
  return under.entries && under.entries.length ? "folder" : "none";
}

/** @param {any} ctx */
export function registerSpaceEdit(ctx) {
  const door = createDoor(ctx);
  /** @param {string} name @param {string} description @param {any} input @param {(i: any, d: any, drive: any) => Promise<any>} fn */
  const tool = (name, description, input, fn) => ctx.tool(name, { description, input, callers: CALLERS, run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
    const d = await door.open(i || {}, meta);
    if (!d.gateway.drive) throw refuse("this Space has no Drive yet; ask the owner or an admin of the Space", "unavailable");
    return fn(i || {}, d, d.gateway.drive);
  } });

  /** @param {any} d @param {any} drive @param {string} from @param {string} to */
  async function move(d, drive, from, to) {
    if (from === to) throw refuse("it is already there", "bad_input");
    if (to.startsWith(`${from}/`)) throw refuse("a folder cannot move into itself", "bad_input");
    const kind = await kindOf(drive, d.chain, from);
    if (kind === "none") throw refuse("there is nothing at that path: files.drive.space.list shows what is there", "not_found");
    const there = await kindOf(drive, d.chain, to);
    if (there !== "none") throw refuse(`${to} already exists: pick another name, or move it out of the way first`, "conflict");
    if (kind === "folder") { const r = await drive.moveFolder(d.chain, from, to); return { from, to, kind, moved: r.moved }; }
    const st = await drive.stat(d.chain, from);
    if (st && typeof st.size === "number" && st.size > MAX_MOVE) throw refuse(`a file here moves up to ${MAX_MOVE / 1048576} MB: use a Flow or the VyreDrive mount for a larger one`, "too_large");
    const bytes = await drive.get(d.chain, from);
    await drive.put(d.chain, to, bytes, {});            // the new path is written first
    try { await drive.delete(d.chain, from); }          // then the old one is tombstoned
    catch (e) {
      // the copy stays and so does the original: say so, so nobody retries into a conflict at the destination
      throw Object.assign(refuse(`copied to ${to}, but the old file ${from} could not be removed: ${e instanceof Error ? e.message : "refused"}`, "partial"), { detail: { copied_to: to, left_at: from, reason: /** @type {any} */ (e)?.code } });
    }
    return { from, to, kind, moved: 1 };
  }

  tool("files.drive.space.move", "Move a file or folder in the Space's Drive, under the caller's own grants: { space?, from, to }. `to` is the new full path; it must not exist. The old path keeps its versions (files.drive.versions, files.drive.restore).",
    obj({ space: str, from: str, to: str }, ["from", "to"]), (i, d, drive) => move(d, drive, pathOf(i.from), pathOf(i.to)));

  tool("files.drive.space.mkdir", "Make an empty folder in the Space's Drive: { space?, parent?, name }. Answers { path }.",
    obj({ space: str, parent: { type: "string", description: "A folder that exists; none for the top." }, name: { type: "string", description: `One part, 1 to ${MAX_FOLDER_NAME} characters, no slash, not starting with a dot, not already there.` } }, ["name"]), async (i, d, drive) => {
      const name = nameOf(i.name).trim();
      if (!name || name.length > MAX_FOLDER_NAME || name.startsWith(".")) throw refuse(`a folder name is 1 to ${MAX_FOLDER_NAME} characters and does not start with a dot`, "bad_input");
      const up = i.parent === undefined || i.parent === "" ? "" : pathOf(i.parent);
      if (up && (await kindOf(drive, d.chain, up)) !== "folder") throw refuse("that parent folder does not exist: files.drive.space.list shows what is there", "not_found");
      const at = up ? `${up}/${name}` : name;
      if ((await kindOf(drive, d.chain, at)) !== "none") throw refuse(`${at} already exists: pick another name`, "conflict");
      await drive.put(d.chain, `${at}/${FOLDER_MARK}`, new Uint8Array(0), {});   // the drive.write answer on this path is the kernel's, under the caller's own chain
      return { path: at };
    });

  tool("files.drive.space.rename", "Rename a file or folder in place in the Space's Drive: { space?, path, name }. `name` is the new last part of the path.",
    obj({ space: str, path: str, name: str }, ["path", "name"]), (i, d, drive) => { const p = pathOf(i.path), n = nameOf(i.name), up = parent(p); return move(d, drive, p, up ? `${up}/${n}` : n); });

  tool("files.drive.space.delete", `Delete a file, or the files of a folder (at most ${MAX_FOLDER_DELETE} at once), from the Space's Drive: { space?, path }. A delete is a version: files.drive.versions lists it and files.drive.restore brings the file back. An outward act, so the kernel may ask first and the answer says so. A folder delete can stop part way: the answer then names how many went, where it stopped and why.`,
    obj({ space: str, path: str }, ["path"]), async (i, d, drive) => {
      const p = pathOf(i.path), kind = await kindOf(drive, d.chain, p);
      if (kind === "none") throw refuse("there is nothing at that path: files.drive.space.list shows what is there", "not_found");
      if (kind === "file") { await drive.delete(d.chain, p); return { path: p, kind, deleted: 1 }; }
      /** @type {string[]} */ const files = [];
      let after = null;
      for (;;) {
        const r = await drive.listPage(d.chain, `${p}/`, { limit: 500, after });
        for (const e of r.entries || []) if (typeof e.path === "string") files.push(e.path);
        if (!r.next || files.length > MAX_FOLDER_DELETE) break;
        after = r.next;
      }
      if (files.length > MAX_FOLDER_DELETE) throw refuse(`that folder holds more than ${MAX_FOLDER_DELETE} files; delete part of it first`, "too_large");
      let deleted = 0;
      for (const f of files) {
        try { await drive.delete(d.chain, f); deleted++; }
        catch (e) { return { path: p, kind, deleted, stopped_at: f, reason: e instanceof Error ? e.message : "refused", code: /** @type {any} */ (e)?.code ?? null }; }   // stop at the first refusal and say what was done
      }
      return { path: p, kind, deleted };
    });
}
