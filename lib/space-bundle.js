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

export const BUNDLE_DIR = "space-bundles";
export const bundleFile = (/** @type {string} */ space) => path.join(BUNDLE_DIR, `${space}.vyb`);
export const RESTORE_FILE = path.join("kernel", "restore.json");
const MAGIC = "vyre-space-bundle";
const err = (/** @type {string} */ code, message = code) => Object.assign(new Error(message), { code });
const b64 = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("base64");
const aadOf = (/** @type {string} */ space) => Buffer.from(`vyre:space-bundle-file:v1:${space}`);
// the sealing process keeps the bundle key and its code wrap under these two names (the kernel handle's `bundle.keep` and `take` add the Space's prefix)
const keyName = (/** @type {string} */ space) => `spaces.${space}.bundlekey`;
const wrapName = (/** @type {string} */ space) => `spaces.${space}.bundlecode`;
/** What a module is given of the kernel for one Space (`ctx.kernel.bundle.of(id)`, needs.kernel.bundle): the grants as data, the log's head, the sealed values under a key, and the two sealed entries; a hosted Space adds a copy of its own store (`copyDb`). @typedef {{ id?: any, state: () => any, head: () => { seq: number, hash: string }, dump: (bk: Uint8Array) => Promise<{ items: any[], pool?: string }>, keep: (what: "key" | "code", value: string) => Promise<any>, take: (what: "key" | "code") => Promise<string>, copyDb?: (file: string) => void }} BundleKernel */

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
 * Export one Space: unattended. Its identity, grants, sealed values (under the bundle key), drive pool key and log head, and for a hosted Space a consistent copy of its own store (kernel.db), written to `space-bundles/<id>.vyb`
 * in the home (a backup of the home carries the folder). The home Space's records are in the home's own store, which the backup already carries.
 * @param {{ root: string, id: { space: string, owner: string, made_at?: number }, k: BundleKernel, home?: boolean }} o
 * @returns {Promise<{ file: string, bytes: number, sealed: number }>}
 */
export async function exportBundle({ root, id, k, home = true }) {
  if (!(await enrolled(k))) throw err("not_enrolled", "give the recovery code once (spaces.bundle.enrol) so the Space bundle can be opened by its owner");
  const bk = Buffer.from(await k.take("key"), "base64"), wrapped = JSON.parse(await k.take("code"));
  const { items, pool } = await k.dump(bk);
  let db = null;
  if (!home && k.copyDb) {
    const tmp = path.join(root, `${BUNDLE_DIR}-${crypto.randomBytes(4).toString("hex")}.db`);
    try { k.copyDb(tmp); db = fs.readFileSync(tmp).toString("base64"); } finally { fs.rmSync(tmp, { force: true }); }
  }
  const body = { home, space_json: { space: id.space, owner: id.owner, made_at: id.made_at || Date.now(), ...(id.name ? { name: id.name } : {}) }, grants: k.state(), sealed: items, pool, head: k.head(), ...(db ? { db } : {}) };
  const buf = pack({ space: id.space, bk, wrapped, body });
  const file = path.join(root, bundleFile(id.space)), tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, file);
  return { file, bytes: buf.length, sealed: items.length };
}

/** The bundles a restored home carries, each with the Space it is for (read from its header, no key). @param {string} root @returns {{ file: string, space: string }[]} */
export function bundlesIn(root) {
  const dir = path.join(root, BUNDLE_DIR);
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith(".vyb")); } catch { /* none */ }
  /** @type {{ file: string, space: string }[]} */ const out = [];
  for (const n of names) { try { const buf = fs.readFileSync(path.join(dir, n)), h = JSON.parse(buf.subarray(0, buf.indexOf(10)).toString("utf8")); if (h.magic === MAGIC && /^spc_[a-z2-7]{12}$/.test(h.space)) out.push({ file: path.join(dir, n), space: h.space }); } catch { /* not a bundle */ } }
  return out;
}

/**
 * Restore, offline, on a home that has no Space yet: every Space whose owner gave a code comes back. The sealing process is made new (its own master), each Space's sealed values go into it under their old references, and
 * its identity is written (the home Space's into kernel/space.json, a hosted Space's into kernel/spaces/<id>/ with its store). Grants wait in a restore.json for the Space's first start, which writes them under its seal and says
 * `space.restored` once. A Space with no code is left out and named.
 * @param {{ root: string, codes: (space: string) => string | undefined | Promise<string | undefined>, password?: string, startSealer: (dir: string) => any }} o
 * @returns {Promise<{ restored: { space: string, owner: string, sealed: number, home: boolean }[], skipped: string[] }>}
 */
export async function restoreAll({ root, codes, password = "", startSealer }) {
  const dir = path.join(root, "kernel"), sealDir = path.join(dir, "seal");
  /** @type {{ file: string, buf: Buffer, header: any, body: any, bk: Buffer }[]} */ const opened = [];
  /** @type {string[]} */ const skipped = [];
  for (const b of bundlesIn(root)) {
    const code = await codes(b.space);
    if (!code) { skipped.push(b.space); continue; }
    const buf = fs.readFileSync(b.file);
    opened.push({ file: b.file, buf, ...unpack(buf, { code, password }) });
  }
  if (!opened.length) return { restored: [], skipped };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // a home that already has one of these Spaces is not restored over
  for (const o of opened) {
    if (o.body.home) { try { if (JSON.parse(fs.readFileSync(path.join(dir, "space.json"), "utf8")).space === o.header.space) throw err("already_restored", "this home already has that Space"); } catch (e) { if (/** @type {any} */ (e).code === "already_restored") throw e; } }
    else if (fs.existsSync(path.join(dir, "spaces", o.header.space, "space.json"))) throw err("already_restored", `this home already has the Space ${o.header.space}`);
  }
  fs.rmSync(sealDir, { recursive: true, force: true });
  fs.mkdirSync(sealDir, { recursive: true, mode: 0o700 });
  const sealer = startSealer(sealDir);
  /** @type {{ space: string, owner: string, sealed: number, home: boolean }[]} */ const restored = [];
  try {
    for (const o of opened) {
      const { header, body, bk, buf } = o, space = header.space, home = Boolean(body.home);
      const where = home ? dir : path.join(dir, "spaces", space);
      fs.mkdirSync(where, { recursive: true, mode: 0o700 });
      const r = await sealer.spaceRestore({ space, bk, items: body.sealed, ...(body.pool ? { pool: body.pool } : {}) });
      await sealer.service.put({ name: keyName(space), value: b64(bk) });
      await sealer.service.put({ name: wrapName(space), value: JSON.stringify(header.wraps.find((/** @type {any} */ w) => w.kind === "code").wrapped) });
      fs.writeFileSync(path.join(where, "space.json"), JSON.stringify(body.space_json), { mode: 0o600 });
      if (!home && body.db) fs.writeFileSync(path.join(where, "kernel.db"), Buffer.from(body.db, "base64"), { mode: 0o600 });
      fs.writeFileSync(path.join(where, "restore.json"), JSON.stringify({ grants: body.grants, head: body.head, bundle_hash: crypto.createHash("sha256").update(buf).digest("hex"), restored_at: Date.now() }), { mode: 0o600 });
      restored.push({ space, owner: body.space_json.owner, sealed: r.restored, home });
    }
  } finally { await sealer.close().catch(() => {}); }
  return { restored, skipped };
}
