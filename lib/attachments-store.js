// @ts-check
// lib/attachments-store: where a chat's attached files live and how they are read back (team/contracts/attachments.md). A file is stored once, sealed like every chat file, in the chat's received folder of
// the Space's Drive, named `<id>-<name>`; the id is how a message refers to it, and the folder is the only index (the chat's Files panel already lists it, the Drive's own grants decide who may read it).
// Everything here runs under the PERSON's chain, which the Drive checks: a file of a chat the person is not in is not found. Shared by the attachments module (put, list) and the send path (open).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { capFor, checkAttachment, idFrom, mimeOf, parseStored, pathIn, storedName, kindOf } from "./attachments.js";

const fail = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** The chat's received folder, from its chat record. @param {any} K the kernel handle @param {any} chain the person's @param {string} thread */
export async function folderOf(K, chain, thread) {
  if (!K || !K.records || !K.drive) throw fail("files need the kernel, which this build runs without", "unavailable");
  let rec;
  try { rec = ((await K.records.query(chain, "chat-record", { filter: { field: "chat", op: "eq", value: String(thread) }, page: { limit: 1 } })).rows || [])[0]; } catch { rec = null; }
  const root = rec && rec.data && rec.data.drive ? String(rec.data.drive) : "";
  if (!root) throw fail("this chat has no folder for files yet: send a message first", "unavailable");
  return `${root}/chat/${thread}`;
}

/** Store one file. @param {any} K @param {any} chain @param {string} thread @param {{ name: string, mime?: string, bytes: Uint8Array }} f @returns {Promise<import("./attachments.js").Attachment>} */
export async function put(K, chain, thread, f) {
  const mime = String(f.mime || mimeOf(f.name)).toLowerCase();
  const id = idFrom(crypto.randomBytes(16));
  const checked = checkAttachment({ id, name: f.name, mime, bytes: f.bytes.length });
  if (!checked.ok) throw fail(checked.error, "bad_input");
  const a = checked.attachment;
  if (f.bytes.length > capFor(mime)) throw fail(`that ${kindOf(mime) === "image" ? "image" : "file"} is too large`, "bad_input");
  const folder = await folderOf(K, chain, thread);
  try { await K.drive.put(chain, `${folder}/${storedName(a.id, a.name)}`, f.bytes); } catch (e) {
    const code = /** @type {any} */ (e) && /** @type {any} */ (e).code;
    if (code !== "not_allowed" && code !== "not_found") throw fail("the file could not be saved", "failed");
    // a person who is in the chat and cannot write has a chat whose files are locked on this server; a person who is not in it gets the plain refusal
    let member = false;
    try { member = Boolean(K.grants && K.grants.chats && K.grants.chats.read(chain, String(thread))); } catch { member = false; }
    throw member ? fail("this chat's files are locked here: open the chat on your phone or computer to unlock them, then add the file again", "unavailable") : fail("you are not in that chat, so you cannot add files to it", "denied");
  }
  return a;
}

/** The files of this chat, newest last. @param {any} K @param {any} chain @param {string} thread @returns {Promise<(import("./attachments.js").Attachment & { path: string })[]>} */
export async function list(K, chain, thread) {
  const folder = await folderOf(K, chain, thread);
  const entries = (await K.drive.list(chain, folder).catch(() => [])) || [];
  /** @type {any[]} */ const out = [];
  for (const e of entries) {
    const full = String(e.path || ""), p = parseStored(full.slice(folder.length + 1));
    if (p) out.push({ id: p.id, name: p.name, mime: mimeOf(p.name), bytes: Number(e.size || 0), path: full });
  }
  return out;
}

/** One file of this chat by id, or not found (the same words for a file that is not there and one the person may not read). @param {any} K @param {any} chain @param {string} thread @param {string} id */
export async function find(K, chain, thread, id) {
  const hit = (await list(K, chain, thread).catch(() => [])).find(a => a.id === id);
  if (!hit) throw fail("that file is not in this chat", "not_found");
  return hit;
}

/** The bytes of one file. @param {any} K @param {any} chain @param {string} thread @param {string} id */
export async function read(K, chain, thread, id) {
  const hit = await find(K, chain, thread, id);
  try { return Buffer.from(await K.drive.get(chain, hit.path)); } catch { throw fail("that file is not in this chat", "not_found"); }
}

/**
 * Put one file where a model reads it by path: `<cwd>/.vyre/attachments/<id>-<name>`, written 0600, in a folder that ignores itself. Returns the path.
 * @param {any} K @param {any} chain @param {string} thread @param {string} cwd @param {import("./attachments.js").Attachment} a
 */
export async function materialise(K, chain, thread, cwd, a) {
  const bytes = await read(K, chain, thread, a.id);
  const file = pathIn(cwd, a);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const ignore = path.join(path.dirname(file), ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
