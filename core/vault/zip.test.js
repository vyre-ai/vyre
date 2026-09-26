// @ts-check
// Every archive here is built by the test with the tiny writer below; the contents are fictional.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { unzip, crc32 } from "./zip.js";

/**
 * A minimal zip writer, enough to build good and deliberately broken archives.
 * @param {{ name: string, data: string|Buffer, method?: 0|8, flags?: number, crc?: number, usize?: number }[]} entries
 * @param {{ comment?: string }} [opts]
 */
function zip(entries, { comment = "" } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const method = e.method ?? 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, "utf8");
    const flags = (e.flags ?? 0) | 0x800;
    const crc = e.crc ?? crc32(data);
    const usize = e.usize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const c = Buffer.from(comment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, eocd, c]);
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("unzip: stored and deflated entries, a directory and a trailing comment", () => {
  const text = "fictional note ".repeat(200);
  const z = zip([
    { name: "export.data", data: '{"accounts":[]}' },
    { name: "files/", data: "" },
    { name: "files/a.txt", data: text, method: 8 },
    { name: "empty.txt", data: "", method: 8 },
  ], { comment: "a fictional comment" });
  const m = unzip(z);
  assert.deepEqual([...m.keys()], ["export.data", "files/a.txt", "empty.txt"]);
  assert.equal(m.get("export.data")?.toString(), '{"accounts":[]}');
  assert.equal(m.get("files/a.txt")?.toString(), text);
  assert.equal(m.get("empty.txt")?.length, 0);
  assert.ok(z.length < text.length, "the deflated entry really is compressed");
  // A Uint8Array that is not a Buffer works too.
  assert.equal(unzip(new Uint8Array(z)).size, 3);
});

test("unzip: refuses a bad CRC, traversal, absolute names and encrypted entries", () => {
  assert.throws(() => unzip(zip([{ name: "a.txt", data: "hello", crc: 1 }])), /"a\.txt" fails its CRC-32 check/);
  assert.throws(() => unzip(zip([{ name: "a.txt", data: "hello", method: 8, crc: 1 }])), /CRC-32/);
  assert.throws(() => unzip(zip([{ name: "../evil.txt", data: "x" }])), /climbs out/);
  assert.throws(() => unzip(zip([{ name: "files/../../evil.txt", data: "x" }])), /climbs out/);
  assert.throws(() => unzip(zip([{ name: "files\\..\\evil.txt", data: "x" }])), /climbs out/);
  assert.throws(() => unzip(zip([{ name: "/etc/evil", data: "x" }])), /absolute path/);
  assert.throws(() => unzip(zip([{ name: "C:/evil", data: "x" }])), /absolute path/);
  assert.throws(() => unzip(zip([{ name: "secret.txt", data: "x", flags: 1 }])), /"secret\.txt" is encrypted/);
  assert.throws(() => unzip(zip([{ name: "a", data: "x" }, { name: "a", data: "y" }])), /more than once/);
});

test("unzip: the size guard checks declared sizes and what inflate really produces", () => {
  const big = Buffer.alloc(64 * 1024, 0x41);
  // Declared too large.
  assert.throws(() => unzip(zip([{ name: "big.bin", data: big, method: 8 }]), { maxBytes: 1024 }), /declares more than 1024 bytes/);
  // Declared small, inflates large: a bomb that lies about its size.
  assert.throws(() => unzip(zip([{ name: "bomb.bin", data: big, method: 8, usize: 10 }]), { maxBytes: 1024 }), /"bomb\.bin" inflates past/);
  // Two entries, each under the limit, together over it.
  const half = Buffer.alloc(700, 0x42);
  assert.throws(() => unzip(zip([{ name: "a", data: half, method: 8 }, { name: "b", data: half, method: 8 }]), { maxBytes: 1024 }), /declares more than/);
  // A stored entry whose sizes disagree.
  assert.throws(() => unzip(zip([{ name: "s.bin", data: "abc", usize: 2 }])), /mismatched sizes/);
  assert.throws(() => unzip(zip([{ name: "a", data: "x" }, { name: "b", data: "y" }]), { maxEntries: 1 }), /2 entries is more than the limit of 1/);
});

test("unzip: refuses zip64, method 12, truncation and non-zips with readable errors", () => {
  const z = zip([{ name: "a.txt", data: "hello" }]);
  const z64 = Buffer.from(z);
  z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
  assert.throws(() => unzip(z64), /zip64/);
  const bz = zip([{ name: "a.txt", data: "hello" }]);
  bz.writeUInt16LE(12, 8);
  bz.writeUInt16LE(12, 30 + 5 + 5 + 10);
  assert.throws(() => unzip(bz), /compression method 12/);
  assert.throws(() => unzip(z.subarray(0, z.length - 5)), /end-of-central-directory/);
  assert.throws(() => unzip(Buffer.from("KEY=value\nOTHER=another-fictional-value\n")), /not a zip archive/);
  assert.throws(() => unzip(Buffer.from("short")), /too short/);
  // @ts-expect-error: not bytes
  assert.throws(() => unzip("a string"), /as bytes/);
});
