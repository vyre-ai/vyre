// @ts-check
// The Space bundle (R031-83, #108). A backup carries the store and the files, but not the home's Space identity and sealing keys, so a restore on a fresh box made a NEW Space and could read none of the old one's
// sealed values or grants. The bundle carries what is needed to bring the Space back, and never a key of the old box:
//   - the Space id and its first owner (kernel/space.json), so every urn and sealed reference stays valid;
//   - the grants and memberships as plain data (kernel/grants `state`), written again as a snapshot under the NEW seal on restore;
//   - every sealed value, opened inside the sealing process and sealed again under the bundle key (kernel/seal `space.dump`), put back under the new process's own keys on restore (the re-key);
//   - the head hash of the old log, kept in the `space.restored` event; the old log itself stays out.
// The bundle is sealed under one random bundle key (BK) that only the owner can unwrap: wrapped to the owner's recovery code (the identity's own, never a second secret). The code is given ONCE, to enrol; after
// that the export runs unattended (scheduled backups need it), because a bundle is unreadable without the owner's identity. Restore needs the code, on a fresh home, and is refused on a home that has a Space.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { newKey } from "./keywrap.js";
import { wrapWithCode, unwrapWithCode, codeLooksRight } from "./code-wrap.js";

export const BUNDLE_FILE = "space-bundle.vyb";
export const RESTORE_FILE = path.join("kernel", "restore.json");
const MAGIC = "vyre-space-bundle";
const err = (/** @type {string} */ code, message = code) => Object.assign(new Error(message), { code });
const b64 = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64");
const aadOf = (/** @type {string} */ space) => Buffer.from(`vyre:space-bundle-file:v1:${space}`);
// the sealing process keeps the bundle key and its code wrap under these two names (the kernel handle's `bundle.keep` and `take` add the Space's prefix)
const keyName = (/** @type {string} */ space) => `spaces.${space}.bundlekey`;
const wrapName = (/** @type {string} */ space) => `spaces.${space}.bundlecode`;
/** What a module is given of the kernel for this (`ctx.kernel.bundle`, needs.kernel.bundle): the grants as data, the log's head, the sealed values under a key, and the two sealed entries. @typedef {{ state: () => any, head: () => { seq: number, hash: string }, dump: (bk: Uint8Array) => Promise<{ items: any[] }>, keep: (what: "key" | "code", value: string) => Promise<any>, take: (what: "key" | "code") => Promise<string> }} BundleKernel */

/** Wrap a new bundle key to the recovery code, and keep both in the sealing process (the key is key material: it lives there, as the Space's other keys do). @param {BundleKernel} k @param {string} space @param {string} code @param {string} [password] */
export async function enrol(k, space, code, password = "") {
  if (!codeLooksRight(code)) throw err("bad_code", "that is not a recovery code");
  const bk = newKey();
  await k.keep("key", b64(bk));
  await k.keep("code", JSON.stringify(wrapWithCode(bk, code, `bundle:${space}`, password)));
  return { enrolled: true };
}
/** Has the owner given the recovery code to wrap the bundle key to? @param {BundleKernel} k */
export const enrolled = async k => { try { await k.take("code"); return true; } catch { return false; } };

/** Seal a body under a bundle key into the one file. @param {{ space: string, bk: Uint8Array, wrapped: any, body: any }} o @returns {Buffer} */
export function pack({ space, bk, wrapped, body }) {
  const header = { magic: MAGIC, v: 1, space, made_at: Date.now(), wraps: [{ kind: "code", wrapped }] };
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", bk, iv);
  const hdr = Buffer.from(JSON.stringify(header)); c.setAAD(Buffer.concat([aadOf(space), hdr]));
  const ct = Buffer.concat([c.update(zlib.deflateSync(Buffer.from(JSON.stringify(body)))), c.final()]);
  return Buffer.concat([hdr, Buffer.from("\n"), Buffer.from(JSON.stringify({ iv: b64(iv), tag: b64(c.getAuthTag()) })), Buffer.from("\n"), ct]);
}
/** Open a bundle with the owner's recovery code. @param {Buffer} buf @param {{ code: string, password?: string }} o @returns {{ header: any, body: any, bk: Buffer }} */
export function unpack(buf, { code, password = "" }) {
  const i = buf.indexOf(10), j = buf.indexOf(10, i + 1);
  if (i < 0 || j < 0) throw err("bad_bundle", "that is not a Space bundle");
  const hdr = buf.subarray(0, i), header = JSON.parse(hdr.toString("utf8")), tail = JSON.parse(buf.subarray(i + 1, j).toString("utf8"));
  if (header.magic !== MAGIC || header.v !== 1 || !/^spc_[a-z2-7]{12}$/.test(header.space)) throw err("bad_bundle", "that is not a Space bundle");
  const wrap = (header.wraps || []).find((/** @type {any} */ w) => w.kind === "code");
  if (!wrap) throw err("no_wrap", "this bundle can be opened with a recovery code only, and has none");
  /** @type {Uint8Array} */ let bk;
  try { bk = unwrapWithCode(wrap.wrapped, code, `bundle:${header.space}`, password); } catch { throw err("bad_code", "that recovery code does not open this bundle"); }
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", bk, Buffer.from(tail.iv, "base64")); d.setAAD(Buffer.concat([aadOf(header.space), hdr])); d.setAuthTag(Buffer.from(tail.tag, "base64"));
    const body = JSON.parse(zlib.inflateSync(Buffer.concat([d.update(buf.subarray(j + 1)), d.final()])).toString("utf8"));
    return { header, body, bk: Buffer.from(bk) };
  } catch { throw err("bad_bundle", "this bundle is damaged or was changed"); }
}

/**
 * Export: unattended. The Space's identity, grants, sealed values (under the bundle key) and the log's head, written to `space-bundle.vyb` in the home (a backup of the home carries it).
 * @param {{ root: string, id: { space: string, owner: string, made_at?: number }, k: BundleKernel }} o
 * @returns {Promise<{ file: string, bytes: number, sealed: number }>}
 */
export async function exportBundle({ root, id, k }) {
  if (!(await enrolled(k))) throw err("not_enrolled", "give the recovery code once (spaces.bundle.enrol) so the Space bundle can be opened by its owner");
  const bk = Buffer.from(await k.take("key"), "base64"), wrapped = JSON.parse(await k.take("code"));
  const { items } = await k.dump(bk);
  const body = { space_json: { space: id.space, owner: id.owner, made_at: id.made_at || Date.now() }, grants: k.state(), sealed: items, head: k.head() };
  const buf = pack({ space: id.space, bk, wrapped, body });
  const file = path.join(root, BUNDLE_FILE), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, file);
  return { file, bytes: buf.length, sealed: items.length };
}

/**
 * Restore, offline, on a home with no Space yet (or a Space this box made and never used): the bundle's identity is written as the home's, the sealed values go into a sealing process of the home's own keys
 * under their old references, and the grants wait in `kernel/restore.json` for the kernel's first start, which writes them under its seal and says `space.restored` once.
 * @param {{ root: string, code: string, password?: string, file?: string, startSealer: (dir: string) => any }} o
 * @returns {Promise<{ space: string, owner: string, sealed: number }>}
 */
export async function restoreBundle({ root, code, password = "", file = path.join(root, BUNDLE_FILE), startSealer }) {
  const buf = fs.readFileSync(file);
  const { header, body, bk } = unpack(buf, { code, password });
  const dir = path.join(root, "kernel"), sealDir = path.join(dir, "seal");
  // a home that has a Space with work in it is not restored over
  try { const cur = JSON.parse(fs.readFileSync(path.join(dir, "space.json"), "utf8")); if (cur.space === header.space) throw err("already_restored", "this home already has that Space"); } catch (e) { if (/** @type {any} */ (e).code === "already_restored") throw e; }
  fs.rmSync(sealDir, { recursive: true, force: true });
  fs.mkdirSync(sealDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify(body.space_json), { mode: 0o600 });
  const sealer = startSealer(sealDir);
  try {
    const r = await sealer.spaceRestore({ space: header.space, bk, items: body.sealed });
    // the bundle key stays with the Space: the next export keeps using it, and the code wrap that opened this bundle with it
    await sealer.service.put({ name: keyName(header.space), value: b64(bk) });
    await sealer.service.put({ name: wrapName(header.space), value: JSON.stringify(header.wraps.find((/** @type {any} */ w) => w.kind === "code").wrapped) });
    fs.writeFileSync(path.join(root, RESTORE_FILE), JSON.stringify({ grants: body.grants, head: body.head, bundle_hash: crypto.createHash("sha256").update(buf).digest("hex"), restored_at: Date.now() }), { mode: 0o600 });
    return { space: header.space, owner: body.space_json.owner, sealed: r.restored };
  } finally { await sealer.close().catch(() => {}); }
}
