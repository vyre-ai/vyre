// @ts-check
// lib/spaces/member-storage: the team server's per-member object storage, for ciphertext a member keeps there (the encrypted personal items and the identity home, team/0.3/DESIGN-personal-records.md).
// Five calls on named objects under one member's own folder of one Space: put, get, list, delete and putIf (a compare-and-set on the object's sha256, so two devices of one person never overwrite
// each other). The server stores bytes and knows no key. A write is refused once the member's stored bytes reach their cap (the space owner sets it; default 1 GiB; 0 means none); reads and
// deletes are never refused. Every call here is for ONE (space, person) the caller has already proved: this file decides nothing about who may call.
// putIf is atomic: its check and its write are synchronous, so no other call in this process runs between them (one daemon owns the folder).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CAP = 1024 ** 3;
const SPACE = /^spc_[a-z2-7]{12}$/;
const PERSON = /^per_[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z0-9._/-]{1,200}$/;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
export const sha256 = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest("hex");

/** @param {{ dir: string }} cfg `dir` holds one folder per Space (core/spaces/host.js spaceFiles' root) */
export function createMemberStorage(cfg) {
  const root = (/** @type {string} */ space, /** @type {string} */ person) => {
    if (!SPACE.test(String(space))) throw err("bad_input", "that is not a space id");
    if (!PERSON.test(String(person))) throw err("bad_input", "that is not a person id");
    return path.join(cfg.dir, space, "member-storage", person);
  };
  const file = (/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ name) => {
    if (!NAME.test(String(name)) || String(name).split("/").some(p => p === ".." || p === "" || p === ".")) throw err("bad_input", "bad object name");
    return path.join(root(space, person), ...String(name).split("/"));
  };
  const capFile = (/** @type {string} */ space) => path.join(cfg.dir, space, "member-storage-caps.json");
  const caps = (/** @type {string} */ space) => { try { return JSON.parse(fs.readFileSync(capFile(space), "utf8")); } catch { return {}; } };
  /** Total bytes under a folder. @param {string} d @returns {number} */
  const sizeOf = d => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? sizeOf(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch { /* none yet */ } return n; };
  const capOf = (/** @type {string} */ space, /** @type {string} */ person) => { const c = caps(space); const v = c[person] ?? c["*"]; return Number.isFinite(v) && v >= 0 ? v : DEFAULT_CAP; };
  const bytes = (/** @type {any} */ b) => { if (typeof b === "string") return Buffer.from(b); if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Buffer.from(b); throw err("bad_input", "an object is bytes"); };

  /** The write itself, synchronous: refuses at the cap, then lands whole (a temp file renamed into place). */
  const write = (/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ name, /** @type {Buffer} */ data) => {
    const cap = capOf(space, person);
    if (cap > 0 && sizeOf(root(space, person)) >= cap) throw err("over_cap", "this member's storage on the server is full");
    const f = file(space, person, name);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, f);
    return sha256(data);
  };
  const read = (/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ name) => { try { return fs.readFileSync(file(space, person, name)); } catch (e) { if (/** @type {any} */ (e).code === "bad_input") throw e; return null; } };

  return Object.freeze({
    /** @returns {{ ok: true, sha256: string }} */
    put(/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ name, /** @type {any} */ data) { return { ok: true, sha256: write(space, person, name, bytes(data)) }; },
    /** @returns {{ data: Buffer, sha256: string } | null} */
    get(/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ name) { const d = read(space, person, name); return d ? { data: d, sha256: sha256(d) } : null; },
    /**
     * Write only if the object is what the writer last saw: `expected` is its sha256 (hex), or null for "not there yet". Atomic. `{ ok: false, sha256 }` names what is there now.
     * @returns {{ ok: boolean, sha256: string | null }}
     */
    putIf(/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ name, /** @type {any} */ data, /** @type {string | null} */ expected) {
      if (expected !== null && !/^[0-9a-f]{64}$/.test(String(expected))) throw err("bad_input", "expected is a sha256 in hex, or null");
      const b = bytes(data);
      const cur = read(space, person, name);
      const have = cur ? sha256(cur) : null;
      if (have !== expected) return { ok: false, sha256: have };
      return { ok: true, sha256: write(space, person, name, b) };
    },
    /** @returns {string[]} the object names under a prefix (one level), as `prefix/name` */
    list(/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ prefix = "") {
      const base = prefix ? path.dirname(file(space, person, `${String(prefix).replace(/\/$/, "")}/x`)) : root(space, person);
      const p = String(prefix).replace(/\/$/, "");
      try { return fs.readdirSync(base).filter(n => !n.endsWith(".tmp")).map(n => (p ? `${p}/${n}` : n)); } catch { return []; }
    },
    /**
     * Delete an object. With `expected` (its sha256, or null for "must not exist") it is a compare-and-set like putIf: a mismatch deletes nothing and answers `{ ok: false, sha256 }`. Never refused for the cap.
     * @returns {{ ok: boolean, deleted: boolean, sha256?: string | null }}
     */
    delete(/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ name, /** @type {string | null | undefined} */ expected = undefined) {
      if (expected !== undefined) {
        if (expected !== null && !/^[0-9a-f]{64}$/.test(String(expected))) throw err("bad_input", "expected is a sha256 in hex, or null");
        const cur = read(space, person, name);
        const have = cur ? sha256(cur) : null;
        if (have !== expected) return { ok: false, deleted: false, sha256: have };
      }
      try { fs.rmSync(file(space, person, name), { force: true }); } catch (e) { if (/** @type {any} */ (e).code === "bad_input") throw e; }
      return { ok: true, deleted: true };
    },
    /** The objects under a prefix with what a client needs to compare: name, sha256 and size. @returns {{ name: string, sha: string, size: number }[]} */
    entries(/** @type {string} */ space, /** @type {string} */ person, /** @type {string} */ prefix = "") {
      /** @type {{ name: string, sha: string, size: number }[]} */ const out = [];
      for (const name of this.list(space, person, prefix)) { const d = read(space, person, name); if (d) out.push({ name, sha: sha256(d), size: d.length }); }
      return out;
    },
    /** @returns {{ used: number, cap: number }} */
    usage(/** @type {string} */ space, /** @type {string} */ person) { return { used: sizeOf(root(space, person)), cap: capOf(space, person) }; },
    /** The space owner's cap, bytes (0 for none), for one person or for every member (`person` "*"). */
    setCap(/** @type {string} */ space, /** @type {string} */ person, /** @type {number} */ capBytes) {
      if (!SPACE.test(String(space))) throw err("bad_input", "that is not a space id");
      if (person !== "*" && !PERSON.test(String(person))) throw err("bad_input", "that is not a person id");
      if (!Number.isInteger(capBytes) || capBytes < 0) throw err("bad_input", "a cap is whole bytes, 0 for none");
      const c = caps(space); c[person] = capBytes;
      fs.mkdirSync(path.join(cfg.dir, space), { recursive: true, mode: 0o700 });
      fs.writeFileSync(capFile(space), JSON.stringify(c), { mode: 0o600 });
      return { person, cap: capBytes };
    },
  });
}
