import { test } from "node:test";
import assert from "node:assert/strict";
import { probe } from "./probe.js";

const reader = buf => async (o, n) => buf.subarray(o, o + n);
const run = (format, buf) => probe(format, buf.length, reader(buf));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...kids) => { const body = Buffer.concat(kids); return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]); };

test("probe: an image's size from its own header, for each format", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(640), u32(480), Buffer.alloc(9)]);
  assert.deepEqual(await run("png", png), { width: 640, height: 480 });
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x20, 0x01, 0x90, 0x00]), Buffer.alloc(10)]);
  assert.deepEqual(await run("gif", gif), { width: 288, height: 144 });
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0x03, 0x00, 0x04, 0x00, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(14), sof]);
  assert.deepEqual(await run("jpeg", jpeg), { width: 1024, height: 768 }, "SOF0 after an APP0 segment");
  const vp8x = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(4), Buffer.alloc(4), Buffer.from([0x1f, 0x03, 0, 0xdf, 0x01, 0]), Buffer.alloc(8)]);
  assert.deepEqual(await run("webp", vp8x), { width: 800, height: 480 });
});

test("probe: the length of a sound and the size and length of a video", async () => {
  const fmt = Buffer.alloc(24); fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(8000, 12); fmt.writeUInt32LE(16000, 16);
  const data = Buffer.alloc(8); data.write("data", 0); data.writeUInt32LE(48000, 4);
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), fmt, data, Buffer.alloc(100)]);
  assert.deepEqual(await run("wav", wav), { duration_s: 3 });
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(12500, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(1280 * 65536, 76); tkhd.writeUInt32BE(720 * 65536, 80);
  const moov = box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd)));
  const mp4 = Buffer.concat([box("ftyp", Buffer.from("mp42"), Buffer.alloc(4)), box("mdat", Buffer.alloc(5000)), moov]);
  assert.deepEqual(await run("mp4", mp4), { duration_s: 12.5, width: 1280, height: 720 }, "moov at the end of the file, as a streamed render writes it");
  assert.deepEqual(await run("m4a", mp4), { duration_s: 12.5, width: 1280, height: 720 });
  const dur = Buffer.alloc(8); dur.writeDoubleBE(4000);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]), Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]), Buffer.from([0x44, 0x89, 0x88]), dur, Buffer.from([0x16, 0x54, 0xae, 0x6b, 0x90, 0xae, 0x8e, 0xe0, 0x8c, 0xb0, 0x82, 0x05, 0x00, 0xba, 0x82, 0x02, 0xd0])]);
  assert.deepEqual(await run("webm", webm), { duration_s: 4, width: 1280, height: 720 });
});

test("probe: nothing it cannot read is claimed, and hostile or truncated headers never throw or loop", async () => {
  assert.deepEqual(await run("png", Buffer.from([0x89, 0x50])), {});
  assert.deepEqual(await run("mp3", Buffer.from("ID3....")), {}, "no length for mp3 or ogg without scanning the file");
  assert.deepEqual(await run("jpeg", Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1000, 0xff)])), {});
  const loop = Buffer.alloc(4096); loop.writeUInt32BE(8, 0); loop.write("free", 4); // an endless run of 8-byte boxes
  const t0 = Date.now();
  assert.deepEqual(await run("mp4", Buffer.concat(Array.from({ length: 400 }, () => loop.subarray(0, 8)))), {});
  assert.ok(Date.now() - t0 < 500);
  const huge = Buffer.concat([u32(0x7fffffff), Buffer.from("moov"), Buffer.alloc(100)]);
  assert.deepEqual(await run("mp4", huge), {}, "a box longer than the file is not read");
  assert.deepEqual(await run("png", Buffer.concat([Buffer.alloc(16), u32(0), u32(70000)])), {}, "a size beyond sanity is dropped");
  // A short version-1 mvhd (it needs 32 bytes) is skipped, and the rest of the file is still read.
  const shortV1 = Buffer.alloc(24); shortV1[0] = 1;
  const tk = Buffer.alloc(84); tk.writeUInt32BE(640 * 65536, 76); tk.writeUInt32BE(360 * 65536, 80);
  assert.deepEqual(await run("mp4", Buffer.concat([box("ftyp", Buffer.from("mp42"), Buffer.alloc(4)), box("moov", box("mvhd", shortV1), box("trak", box("tkhd", tk)))])), { width: 640, height: 360 });
  // A stray 0xb0 byte far from the video track is not a width.
  const stray = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]), Buffer.from([0xb0, 0x82, 0x05, 0x00, 0xba, 0x82, 0x02, 0xd0]), Buffer.alloc(200)]);
  assert.deepEqual(await run("webm", stray), {}, "no Tracks > Video element, no size claimed");
});
