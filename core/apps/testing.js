// @ts-check
// Test helpers for core/apps: a tiny STORED zip, and a verifier for v2/v3 signatures written
// from the spec on its own (it shares no code with apk-sign.js), so a test checks the signer
// against a second reading rather than against itself.

import crypto from "node:crypto";

/**
 * A ZIP of STORED entries. `align` pads each local header's extra field so data starts on a
 * 4-byte boundary, as zipalign does; without it data lands wherever the header ends.
 * @param {{ name: string, data: Buffer }[]} entries @param {{ align?: boolean }} [opts]
 */
export function storedZip(entries, { align = true } = {}) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const pad = align ? (4 - ((off + 30 + name.length) % 4)) % 4 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(10, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(pad, 28);
    locals.push(lh, name, Buffer.alloc(pad), e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(10, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + pad + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
/** @param {Buffer} b */
function crc32(b) { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

/** A reader over little-endian length-prefixed data. @param {Buffer} buf */
function reader(buf) {
  let p = 0;
  const r = {
    u32() { const v = buf.readUInt32LE(p); p += 4; return v; },
    bytes() { const n = r.u32(); if (p + n > buf.length) throw new Error("length prefix runs past its parent"); const v = buf.subarray(p, p + n); p += n; return v; },
    seq() { const inner = reader(r.bytes()); const out = []; while (!inner.done()) out.push(inner.bytes()); return out; },
    done: () => p >= buf.length,
  };
  return r;
}

/**
 * Parse and verify a signed APK: every v2 and v3 signer's signatures, its digest against a fresh
 * computation, its certificate against its public key. Throws on any mismatch; returns what it saw.
 * @param {Buffer} apk
 */
export function verifyApk(apk) {
  const eocd = apk.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOffset = apk.readUInt32LE(eocd + 16);
  if (apk.subarray(cdOffset - 16, cdOffset).toString("latin1") !== "APK Sig Block 42") throw new Error("no signing block magic before the central directory");
  const size = Number(apk.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - size - 8;
  if (Number(apk.readBigUInt64LE(start)) !== size) throw new Error("the signing block's two sizes differ");
  /** @type {Map<number, Buffer>} */
  const pairs = new Map();
  for (let p = start + 8; p < cdOffset - 24;) {
    const len = Number(apk.readBigUInt64LE(p));
    pairs.set(apk.readUInt32LE(p + 8), apk.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  // The digest, recomputed: chunks of 1 MiB over entries, CD, and the EOCD pointing at the block.
  const end = Buffer.from(apk.subarray(eocd));
  end.writeUInt32LE(start, 16);
  const chunks = [];
  for (const s of [apk.subarray(0, start), apk.subarray(cdOffset, eocd), end]) {
    for (let o = 0; o < s.length; o += 1 << 20) {
      const c = s.subarray(o, Math.min(o + (1 << 20), s.length));
      const len = Buffer.alloc(4); len.writeUInt32LE(c.length);
      chunks.push(crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0xa5]), len, c])).digest());
    }
  }
  const count = Buffer.alloc(4); count.writeUInt32LE(chunks.length);
  const expected = crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0x5a]), count, ...chunks])).digest();

  const out = /** @type {Record<string, any>} */ ({ pairs: [...pairs.keys()], chunks: chunks.length });
  for (const [v, id] of /** @type {[number, number][]} */ ([[2, 0x7109871a], [3, 0xf05368c0]])) {
    const value = pairs.get(id);
    if (!value) throw new Error(`no v${v} block`);
    const signers = reader(value).seq();
    if (signers.length !== 1) throw new Error(`v${v}: expected one signer`);
    const s = reader(signers[0]);
    const signed = s.bytes();
    const outerMin = v === 3 ? s.u32() : null, outerMax = v === 3 ? s.u32() : null;
    const sigs = s.seq().map(x => { const r = reader(x); return { alg: r.u32(), sig: r.bytes() }; });
    const spki = s.bytes();
    const d = reader(signed);
    const digests = d.seq().map(x => { const r = reader(x); return { alg: r.u32(), digest: r.bytes() }; });
    const certs = d.seq();
    const innerMin = v === 3 ? d.u32() : null, innerMax = v === 3 ? d.u32() : null;
    const attrs = d.seq().map(x => ({ id: x.readUInt32LE(0), value: x.subarray(4) }));
    const pub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    for (const g of sigs) {
      if (![0x0201, 0x0103].includes(g.alg)) throw new Error(`v${v}: unexpected algorithm ${g.alg}`);
      if (!crypto.verify("sha256", signed, pub, g.sig)) throw new Error(`v${v}: signature does not verify`);
    }
    if (digests.map(x => x.alg).join() !== sigs.map(x => x.alg).join()) throw new Error(`v${v}: digest and signature algorithms differ`);
    if (!digests[0].digest.equals(expected)) throw new Error(`v${v}: content digest does not match the APK`);
    const cert = new crypto.X509Certificate(certs[0]);
    if (!Buffer.from(cert.publicKey.export({ type: "spki", format: "der" })).equals(spki)) throw new Error(`v${v}: certificate key is not the signer's`);
    if (v === 3 && (outerMin !== innerMin || outerMax !== innerMax)) throw new Error("v3: min/max SDK differ inside and outside signed data");
    out[`v${v}`] = { alg: sigs[0].alg, cert, certDer: certs[0], minSdk: innerMin, maxSdk: innerMax, attrs };
  }
  return out;
}
