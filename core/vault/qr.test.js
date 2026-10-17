// @ts-check
// qr tests: known values from the standard (format and version BCH words, a Reed-Solomon block),
// structural checks on every version, and, where zbarimg is installed, a real decoder reading
// rendered PNGs at every version and every mask.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { encode, formatBits, versionBits, rsRemainder, pickVersion, dataCapacity, penalty, functionMask, toSvg } from "./qr.js";
import { SCRATCH } from "../../test/scratch.mjs";

test("format bits match the standard's table for level M", () => {
  const want = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  for (let k = 0; k < 8; k++) assert.equal(formatBits(k), want[k], `mask ${k}`);
});

test("version bits match the standard's table for 7 to 10", () => {
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(8), 0x085bc);
  assert.equal(versionBits(9), 0x09a99);
  assert.equal(versionBits(10), 0x0a4d3);
});

test("Reed-Solomon matches the standard's 1-M worked example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("capacities and version choice at level M", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(dataCapacity), [16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
  assert.equal(pickVersion(14), 1);
  assert.equal(pickVersion(15), 2);
  assert.equal(pickVersion(213), 10);
  assert.throws(() => pickVersion(214), /do not fit/);
});

const read = (m, x, y) => m[y][x];

test("structure: finders, separators, timing, dark module, both format copies and version blocks", () => {
  for (let v = 1; v <= 10; v++) {
    const payload = "x".repeat(dataCapacity(v) - 3);
    const q = encode(payload, { version: v });
    const m = q.modules, n = q.size;
    assert.equal(n, 17 + 4 * v);
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(read(m, ox + dx, oy + dy), ring !== 2, `finder v${v} at ${ox + dx},${oy + dy}`);
      }
    }
    for (let i = 0; i < 8; i++) {
      assert.equal(read(m, 7, i), false); assert.equal(read(m, i, 7), false);
      assert.equal(read(m, n - 8, i), false); assert.equal(read(m, i, n - 8), false);
    }
    for (let i = 8; i < n - 8; i++) { assert.equal(read(m, 6, i), i % 2 === 0); assert.equal(read(m, i, 6), i % 2 === 0); }
    assert.equal(read(m, 8, n - 8), true, "the dark module");
    // Read both copies of the format bits back and check they agree and match the mask chosen.
    let a = 0, b = 0;
    const firstCoords = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    firstCoords.forEach(([x, y], i) => { if (read(m, x, y)) a |= 1 << i; });
    for (let i = 0; i < 8; i++) if (read(m, n - 1 - i, 8)) b |= 1 << i;
    for (let i = 8; i < 15; i++) if (read(m, 8, n - 15 + i)) b |= 1 << i;
    assert.equal(a, formatBits(q.mask), `format copy 1, v${v}`);
    assert.equal(b, formatBits(q.mask), `format copy 2, v${v}`);
    if (v >= 7) {
      let tr = 0, bl = 0;
      for (let i = 0; i < 18; i++) {
        const x = n - 11 + (i % 3), y = Math.floor(i / 3);
        if (read(m, x, y)) tr |= 1 << i;
        if (read(m, y, x)) bl |= 1 << i;
      }
      assert.equal(tr, versionBits(v)); assert.equal(bl, versionBits(v));
    }
  }
});

test("the data region has the size the standard gives each version", () => {
  // Raw codewords per version, times 8, plus the remainder bits (7 for versions 2 to 6).
  const raw = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
  for (let v = 1; v <= 10; v++) {
    const fn = functionMask(v);
    const free = fn.flat().filter(f => !f).length;
    assert.equal(free, raw[v - 1] * 8 + (v >= 2 && v <= 6 ? 7 : 0), `v${v}`);
  }
});

test("the mask chosen has the lowest penalty of the eight", () => {
  const text = "vyre-kit:v1:" + JSON.stringify({ acct: "ABC123", relay: "https://box.example.com" });
  const q = encode(text);
  for (let k = 0; k < 8; k++) assert.ok(penalty(encode(text, { mask: k }).modules) >= penalty(q.modules));
});

test("svg: one path, a quiet zone, no scripts", () => {
  const svg = toSvg(encode("hello").modules);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.equal((svg.match(/<path/g) || []).length, 1);
  assert.doesNotMatch(svg, /script/i);
});

/** A greyscale PNG of the symbol, `px` pixels a module, with a four-module quiet zone. */
function png(modules, px = 4) {
  const n = (modules.length + 8) * px;
  const rows = [];
  for (let y = 0; y < n; y++) {
    const row = Buffer.alloc(n + 1, 255);
    row[0] = 0;
    const my = Math.floor(y / px) - 4;
    for (let x = 0; x < n; x++) {
      const mx = Math.floor(x / px) - 4;
      if (my >= 0 && mx >= 0 && my < modules.length && mx < modules.length && modules[my][mx]) row[x + 1] = 0;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Symbols from an independent encoder (segno 1.6.6, with its one deviation removed: it adds a
 * whole 0x00 byte after the terminator when the stream is already byte-aligned, where the
 * standard adds nothing). Same text, version and mask must give the same modules, bit for bit.
 * These were also read back by zxing-cpp 3.1.1. Rows are hex of the row's bits, left to right.
 */
const SEGNO = [
  { text: "vyre kit alex", version: 1, mask: 2,
    rows: "1fc07f 104c41 175d5d 17595d 17515d 105241 1fd57f 1c00 17ce7c f1d93 2e50e 16a90d ed87a 1a37 1fc302 105b9e 175373 17503c 17578c 1045a4 1fda62" },
  { text: "https://box.example.com/v1/relay?x=1", version: 3, mask: 5,
    rows: "1fc1747f 105fd141 1750a35d 17560f5d 17460f5d 10421941 1fd5557f 125200 105718ce 1620b236 9f3e800 1b9387a8 19c18561 168832d3 7c835dc 5062045 177c1c2c 1b07ef77 1d6e23c9 119e81a0 17d05bf7 1d6118 1fca3f5c 10434710 1745f3f9 1742f48d 174720fe 1048428d 1fdb8a14" },
  { text: "vyre-kit:v1:{\"acct\":\"Q7M2XK\",\"fp\":\"ABCD EFGH JKMN PQRS TVWX\"}", version: 5, mask: 0,
    rows: "1fc40c107f 105b503341 174746525d 174201f65d 175307be5d 10486a7b41 1fd555557f e8c3a00 1548b43c12 693be3b09 14477c7d17 e8c5a9de0 ff8b139e4 13a0f0bd6b 11e4894d51 15b472d802 3f98148f0 1eb82b6f0d 145307c1d3 4a7edebe3 1d352cd67 1b84b90042 1d6ad5807f fa12d2cf9 1edad416c3 9153ebb2d 1363fcfd4b b399a9a10 174831edf6 1c01b516 1fcd595b5f 1048f0c113 175c4141f3 17472b63b5 17534f0cbd 1048adab92 1fd813dd87" },
  { text: "alex@example.com · acme.test · 0123456789012345678901234567890123456789012345678901234567890123456789", version: 7, mask: 6,
    rows: "1fdac3ec417f 105e8d923a41 175f10f46a5d 174086b1e35d 175563fbc75d 104a0d133841 1fd55555557f 58d1d4f00 13fd75fb2697 354d5e7ddc 10f2c5c01623 395f6bfd2e 25d8e0378bb 1e28502e71f0 6c64d57e37e c0731728f67 52ff3636a0 159d4280550f 9efb4b1813f 612bb9f5577 df4a7f32ffb 1f10f917771a 1351a35c175c 151e7912f715 9fc11f63ffb 19aa64d57ac6 8c6e7cfa894 1e8aa431af96 12d2549596e3 529a48026bf 379f2d0e27f 18d37dba717 55ab3f3ed8b 1d0af3977496 16b0548b775 f1e713ec0df 136533fb07f1 1c2910611f 1fd109599d5d 105da115e91d 175bd9f9d9f1 17592bb9ecad 17415bfb2bfd 104e02aa47e7 1fd95cd3ef78" },
  { text: "vyre-kit:v1:{\"acct\":\"Q7M2XK\",\"fp\":\"ABCD EFGH JKMN PQRS TVWX\",\"relay\":\"https://vault-box.tail0000.wink.example\",\"sk\":\"V2-Q7M2XK-ABCDEFGHJKMNPQRSTVWXYZ0123\"}", version: 10, mask: 3,
    rows: "1fdd82d9d90d67f 105c311b75c3241 174f81d927ffe5d 175d78887d4225d 1749bca7cb6025d 1040478c58c6441 1fd55555555557f 15134c705b500 16edfb87eefe04b 51cd8bfe88e3b8 114de6205a01d67 1719c9c5306c549 105bbab10a8224a e3808a50bd4aaa 147f6022b752c94 79e5450bc559ef 1d6885acf6030e8 1e09a9bbe78862c 18ea71ca6de1570 19bff59e8383e97 136502cb80ecf12 4926ff850fc18c 84d07a31e7326f db36f9009b76f8 d58b86641483a8 6b7114fb0ca2ec 1bfd0347e507ff0 1110f76c46bc115 1355cc7566ea75d 1f12d8047a1b516 bfe7997fa7f5f6 5a12607e45b308 1671b2c82898014 9bec2e69ba63c6 1df6b53596319e4 b9005b4d7836ba fd25c3ced2a934 d9189acdb422e9 11ee43af0074199 f9be5d29802485 edebc0c9ecb602 1407c92aaeb2c76 1c6542477fa00be 111626e71d66d13 e496e98d23414d 583eab6171d545 14c6fd0962ac05b 1f3af56504685d8 43afdfc3003f7 158f0471e3315 1fd291f56efab54 105a7c1459fab1e 174f0bc7d54fdf7 175ff744150e45a 17534cfe1e64f14 1044d221a57ae51 1fd091c4c43c160" },
];

test("matches an independent encoder module for module at versions 1, 3, 5, 7 and 10", () => {
  for (const f of SEGNO) {
    const q = encode(f.text, { version: f.version, mask: f.mask });
    const want = f.rows.split(" ").map(h => BigInt("0x" + h).toString(2).padStart(q.size, "0"));
    const got = q.modules.map(r => r.map(c => (c ? "1" : "0")).join(""));
    assert.deepEqual(got, want, `version ${f.version} mask ${f.mask}`);
  }
});

/**
 * zbarimg, when it is installed and works. The Homebrew build on some Macs crashes (SIGSEGV)
 * inside its image loader on every input, so a probe decides; a crash skips rather than fails.
 */
function decoder() {
  try { execFileSync("zbarimg", ["--version"], { stdio: "ignore" }); } catch { return null; }
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-qr-probe-"));
  try {
    const file = path.join(dir, "p.png");
    fs.writeFileSync(file, png(encode("probe").modules));
    const got = execFileSync("zbarimg", ["-q", "--raw", file], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return got === "probe" ? "zbarimg" : null;
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const zbar = decoder();

test("zbarimg reads every version, every mask, and a kit-shaped payload", { skip: !zbar && "no working zbarimg on this machine" }, t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-qr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [];
  for (let v = 1; v <= 10; v++) {
    // Printable text that fills most of the version, so every block and the interleave are used.
    const len = dataCapacity(v) - (v < 10 ? 2 : 3) - (v % 3);
    cases.push({ text: crypto.randomBytes(len).toString("base64").slice(0, len), mask: v % 8 });
  }
  for (let k = 0; k < 8; k++) cases.push({ text: `mask ${k} check · ${crypto.randomBytes(8).toString("hex")}`, mask: k });
  cases.push({ text: "vyre-kit:v1:" + JSON.stringify({ acct: "Q7M2XK", fp: "ABCD EFGH JKMN PQRS TVWX", relay: "https://vault-box.tail0000.wink.example", sk: "V2-Q7M2XK-" + "A".repeat(26) }) });
  cases.forEach((c, i) => {
    const q = encode(c.text, c.mask === undefined ? {} : { mask: c.mask });
    const file = path.join(dir, `q${i}.png`);
    fs.writeFileSync(file, png(q.modules));
    const got = execFileSync("zbarimg", ["-q", "--raw", file]).toString("utf8").replace(/\n$/, "");
    assert.equal(got, c.text, `case ${i}: version ${q.version}, mask ${q.mask}`);
  });
});
