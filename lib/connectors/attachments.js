// @ts-check
// Files on an outgoing message, by reference. A message names files of the Space's Drive; the held message (what the Gate shows and approves) carries each file's path, name, size and content hash and
// the person who asked, never the bytes. When the person approves, the sender reads exactly those files, refuses if one changed since, and refuses if the asker can no longer read it.
//   hold(ctx, meta, refs)   at the moment a message is held: the asker's own chain must be able to read each file (the Drive judges it); gives the entries to put in the held content
//   release(ctx, items)     at the moment it is sent: each entry rechecked against the asker's current access and against its hash, and read with the module's own service chain; gives { filename, contentType, bytes }
// A lib imports only the kernel and other libs: `ctx` is the module's own ctx (ctx.kernel.drive, chain, personMay, serviceChain, space).

import crypto from "node:crypto";

export const MAX_FILES = 10;
/** The common provider limit for one message, in bytes. */
export const MAX_TOTAL = 25 * 1024 * 1024;
const TYPES = /** @type {Record<string, string>} */ ({ pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", txt: "text/plain", csv: "text/csv", md: "text/markdown", zip: "application/zip" });
const err = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
/** The content type of a file by its name. @param {string} name */
export const typeOf = (name) => TYPES[String(name).toLowerCase().split(".").pop() || ""] || "application/octet-stream";
const fileUrn = (/** @type {string} */ space, /** @type {string} */ p) => `vyre://${space}/file/${p}`;
const one = (/** @type {any} */ v) => String(v).replace(/[\r\n"\\]/g, "_").slice(0, 120);

/**
 * @param {any} ctx @param {any} meta the call's meta (the asker's token) @param {unknown} refs [{ path, name? }]
 * @returns {Promise<{ path: string, name: string, size: number, sha256: string, by: string }[]>}
 */
export async function hold(ctx, meta, refs) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs) || refs.length > MAX_FILES) throw err(`a message carries up to ${MAX_FILES} files`, "bad_input");
  if (!refs.length) return [];
  const chain = await ctx.kernel.chain(meta);
  const who = chain && Array.isArray(chain.hops) ? chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person") : null;
  if (!who) throw err("a file goes on a message only for a person: nobody is asking", "denied");
  const out = []; let total = 0;
  for (const r of refs) {
    const p = r && typeof r === "object" ? String(/** @type {any} */ (r).path || "") : String(r || "");
    if (!p || p.includes("..") || p.startsWith("/") || /[\r\n\0]/.test(p)) throw err("name a file of your Files by its path", "bad_input");
    let st;
    try { st = await ctx.kernel.drive.stat(chain, p); } catch (e) { throw err(`${p.slice(0, 80)} cannot be attached: it is not in your Files, or you may not read it`, "denied"); }
    if (!st || typeof st.sha256 !== "string" || !st.sha256) throw err(`${p.slice(0, 80)} cannot be attached yet: it has no saved copy to check against`, "bad_input");
    total += Number(st.size);
    if (total > MAX_TOTAL) throw err(`the files on one message add up to at most ${Math.floor(MAX_TOTAL / 1024 / 1024)} MB; these are ${(total / 1024 / 1024).toFixed(1)} MB`, "too_large");
    out.push({ path: p, name: one((r && typeof r === "object" && /** @type {any} */ (r).name) || p.split("/").pop()), size: Number(st.size), sha256: st.sha256, by: String(who.actor.id) });
  }
  return out;
}

/**
 * @param {any} ctx @param {any} items what `hold` returned, as the Gate kept it
 * @returns {Promise<{ filename: string, contentType: string, bytes: Buffer }[]>}
 */
export async function release(ctx, items) {
  if (!Array.isArray(items) || !items.length) return [];
  const out = []; let total = 0;
  for (const it of items) {
    const name = String(it && it.name || "file"), p = String(it && it.path || "");
    if (!p || p.includes("..") || !it.by || typeof it.sha256 !== "string") throw err(`${name} is not a file this message may carry`, "denied");
    // the person who asked must still be allowed to read it, as well as this module
    if (!(await ctx.kernel.personMay(String(it.by), "drive.read", fileUrn(ctx.kernel.space, p)))) throw err(`${name} can no longer be read by the person who asked for this message, so nothing was sent`, "denied");
    let bytes;
    try { bytes = Buffer.from(await ctx.kernel.drive.get(ctx.kernel.serviceChain(), p, { maxBytes: MAX_TOTAL })); } catch { throw err(`${name} could not be read, so nothing was sent`, "unavailable"); }
    if (bytes.length !== Number(it.size) || crypto.createHash("sha256").update(bytes).digest("hex") !== it.sha256) throw err(`${name} changed after you approved this message, so nothing was sent. Approve it again.`, "changed");
    total += bytes.length;
    if (total > MAX_TOTAL) throw err("the files on this message are over the size limit, so nothing was sent", "too_large");
    out.push({ filename: name, contentType: typeOf(name), bytes });
  }
  return out;
}
