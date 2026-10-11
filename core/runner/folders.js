// @ts-check
// The folders of THIS computer the person has approved for chats (R031-95 design item 12). A chat on a computer normally works in the encrypted workspace and its files travel with it; a chat given a folder
// works IN that folder, on this disk, and goes nowhere: its files are never synced to the Space, and the chat is not moved to the server (the home never takes it, the computer freezes it instead). The person adds
// a folder here, on the computer, with the one yes (a folder widens what a model can reach); the home and the chat only ever name it by id and label, never by path. The sandbox is the same as for any session: it
// is bound read-write as the chat's folder after the home-secrets check (sandbox.js checkBind).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkBind } from "./sandbox.js";

const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
export const MAX_FOLDERS = 32;
export const FOLDER_ID = /^fld_[0-9a-f]{12}$/;

/** @param {string} file the JSON file that keeps the list (beside the runner's own folders) @param {{ home?: string }} [o] */
export function createFolders(file, o = {}) {
  /** @returns {{ id: string, label: string, path: string }[]} */
  const read = () => { try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(j) ? j.filter(x => x && FOLDER_ID.test(String(x.id)) && typeof x.path === "string") : []; } catch { return []; } };
  const write = (/** @type {any[]} */ list) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); fs.renameSync(tmp, file); };
  const idOf = (/** @type {string} */ real) => "fld_" + crypto.createHash("sha256").update(real).digest("hex").slice(0, 12);
  return {
    /** What the home may know of this computer's folders: the id and the label, never the path. */
    visible: () => read().map(f => ({ id: f.id, label: f.label })),
    /** The person's own list, with the paths. */
    list: () => read().map(f => ({ id: f.id, label: f.label, path: f.path })),
    /** Approve a folder. The path must be an absolute, existing directory the sandbox would accept. @param {string} p @param {string} [label] */
    add(p, label) {
      if (typeof p !== "string" || !path.isAbsolute(p)) throw err("bad_input", "a folder is an absolute path on this computer");
      let real; try { real = fs.realpathSync(p); } catch { throw err("not_found", "that folder does not exist on this computer"); }
      if (!fs.statSync(real).isDirectory()) throw err("bad_input", "that is not a folder");
      try { checkBind(real, o.home); } catch (e) { throw err("refused", String(/** @type {Error} */ (e).message).replace(/^the sandbox is never given /, "a chat is never given ")); }
      const list = read(), id = idOf(real);
      const name = String(label || path.basename(real) || "folder").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || "folder";
      const had = list.find(f => f.id === id);
      if (had) { had.label = name; write(list); return { id, label: name, path: real }; }
      if (list.length >= MAX_FOLDERS) throw err("quota", "this computer already has the most folders a chat may be given");
      list.push({ id, label: name, path: real }); write(list);
      return { id, label: name, path: real };
    },
    /** Take a folder away. Nothing in it is touched. @param {string} id */
    remove(id) { const list = read(), next = list.filter(f => f.id !== id); if (next.length === list.length) throw err("not_found", "no such folder"); write(next); return { removed: true }; },
    /** The path of an approved folder, checked again now: it must still exist and still be acceptable. Throws `folder_unknown` for an id this computer does not hold. @param {string} id */
    resolve(id) {
      const f = read().find(x => x.id === id);
      if (!f) throw err("folder_unknown", "this computer has no such folder");
      let real; try { real = fs.realpathSync(f.path); } catch { throw err("folder_unknown", "that folder is not on this computer any more"); }
      if (idOf(real) !== f.id) throw err("folder_unknown", "that folder is not the one that was approved");
      try { checkBind(real, o.home); } catch (e) { throw err("refused", String(/** @type {Error} */ (e).message)); }
      return real;
    },
  };
}
