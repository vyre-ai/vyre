// kernel/seal/store.js: where sealed values and sealed derivatives live, inside the sealing process's own state folder (mode 0700, files 0600).
// AES-256-GCM under a key derived from the home's master key and the Space, with the ref, Space, record, field and class in the associated data,
// so a file moved to another record, field or Space does not open. No sandbox, lent machine or project folder ever mounts this folder.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const hk = (master, info) => Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
const REF = /^(seal|out)_[a-z0-9]{20,40}$/;

export class SealStore {
  /** @param {string} dir @param {Buffer} master 32 bytes from key custody */
  constructor(dir, master) {
    this.dir = dir; this.master = master;
    for (const d of ["values", "derived"]) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  key(space) { return hk(this.master, `vyre seal v1 ${space}`); }
  /** A keyed index for the one allowed equality: a uniqueness check at write time and a rate-limited human lookup. */
  blind(space, field, cls, compactValue) { return crypto.createHmac("sha256", hk(this.master, `vyre seal index v1 ${space}`)).update(`${field}\0${cls}\0${compactValue}`).digest("base64url"); }
  newRef(kind) { return `${kind}_${crypto.randomBytes(15).toString("hex")}`; }
  file(kind, ref) { if (!REF.test(ref) || !ref.startsWith(kind === "values" ? "seal_" : "out_")) throw new Error("bad_ref"); return path.join(this.dir, kind, `${ref}.json`); }
  aad(m) { return Buffer.from(`vyre:seal:v1:${m.ref}:${m.space}:${m.record}:${m.field ?? ""}:${m.class ?? ""}`); }
  write(kind, meta, plaintext) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.key(meta.space), iv);
    c.setAAD(this.aad(meta));
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const f = this.file(kind, meta.ref), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...meta, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") }), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }
  /** @returns {{ meta: any, plaintext: string } | null} null when absent, in another Space, or does not open */
  read(kind, ref, space) {
    let j;
    try { j = JSON.parse(fs.readFileSync(this.file(kind, ref), "utf8")); } catch { return null; }
    // The file must be the one asked for: a swap of two files in one Space (a disk write, no key) must not make a reference open another value.
    if (j.space !== space || j.ref !== ref) return null;
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", this.key(space), Buffer.from(j.iv, "base64"));
      d.setAAD(this.aad(j)); d.setAuthTag(Buffer.from(j.tag, "base64"));
      const { iv, ct, tag, v, ...meta } = j;
      return { meta, plaintext: Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8") };
    } catch { return null; }
  }
  /** Metadata only (no decrypt): used for the uniqueness check and lookups. */
  metas(kind, space) {
    const out = [];
    for (const f of fs.readdirSync(path.join(this.dir, kind))) { try { const j = JSON.parse(fs.readFileSync(path.join(this.dir, kind, f), "utf8")); if (j.space === space) { const { iv, ct, tag, v, ...m } = j; out.push(m); } } catch { /* a torn file is not a value */ } }
    return out;
  }
  /** Remove files of a kind older than `maxAgeMs`. */
  sweep(kind, maxAgeMs) { const d = path.join(this.dir, kind), t = Date.now(); for (const f of fs.readdirSync(d)) { try { if (t - fs.statSync(path.join(d, f)).mtimeMs > maxAgeMs) fs.unlinkSync(path.join(d, f)); } catch { /* gone already */ } } }
  /** Crypto-shred of one value: the file is overwritten, then removed. */
  drop(kind, ref) { const f = this.file(kind, ref); try { fs.writeFileSync(f, crypto.randomBytes(fs.statSync(f).size)); fs.unlinkSync(f); return true; } catch { return false; } }
}
