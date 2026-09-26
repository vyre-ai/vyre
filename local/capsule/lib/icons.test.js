// @ts-check
// The icon cache against a fake helper (keying, batching, dedupe, LRU, failure), and, when
// bin/local is built, against the real one for an app, an image file and a settings pane. No
// contact is ever looked up for real here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { Icons, iconFile, BATCH } from "./icons.js";
import { LocalHelper } from "./helper.js";

/** @param {import("node:test").TestContext} t */
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-icons-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A helper that writes a small file per item, like bin/local, and records what it was asked. */
function fakeHelper({ none = /** @type {string[]} */ ([]), delay = 0 } = {}) {
  /** @type {any[][]} */
  const calls = [];
  return {
    calls,
    /** @param {any[]} items @param {{ dir: string }} o */
    async icons(items, { dir }) {
      calls.push(items);
      if (delay) await new Promise(r => setTimeout(r, delay));
      /** @type {Record<string, string | null>} */
      const icons = {};
      for (const it of items) {
        if (none.includes(it.key)) { icons[it.key] = null; continue; }
        const p = path.join(dir, iconFile(it.key));
        fs.writeFileSync(p, "png:" + it.key);
        icons[it.key] = p;
      }
      return { icons };
    },
  };
}

const app = (/** @type {string} */ p) => ({ kind: "app", id: "app:" + p, label: path.basename(p), target: p });
const mtimes = (/** @type {Record<string, number>} */ m) => async (/** @type {string} */ p) => {
  if (!(p in m)) throw new Error("ENOENT");
  return { mtimeMs: m[p] };
};

test("icons: file URLs for picture kinds, nothing for the page's own kinds", async t => {
  const dir = path.join(tmp(t), "icons");                      // created on demand
  const helper = fakeHelper();
  const ic = new Icons({ dir, helper, stat: mtimes({ "/Applications/Notes.app": 1, "/tmp/a.pdf": 2 }) });
  const out = await ic.get([
    app("/Applications/Notes.app"),
    { kind: "file", id: "file:/tmp/a.pdf", target: "/tmp/a.pdf" },
    { kind: "setting", id: "setting:wifi", target: "x-apple.systempreferences:com.apple.wifi-settings-extension" },
    { kind: "contact", id: "contact:A1", target: "addressbook://A1" },
    { kind: "calc", id: "calc", target: "" },
    { kind: "agent", id: "agent:x", target: "vyre://x" },
    { kind: "app", id: "app:gone", target: "/Applications/Gone.app" },   // stat fails: skipped
  ]);
  assert.deepEqual(Object.keys(out).sort(), ["app:/Applications/Notes.app", "contact:A1", "file:/tmp/a.pdf", "setting:wifi"]);
  for (const u of Object.values(out)) assert.match(u, /^file:\/\/\/.+\/[0-9a-f]{32}\.png$/);
  assert.equal(helper.calls.length, 1, "one request for all the misses");
  assert.deepEqual(helper.calls[0].map(i => i.kind).sort(), ["app", "contact", "file", "setting"]);
  const byKind = Object.fromEntries(helper.calls[0].map(i => [i.kind, i]));
  assert.equal(byKind.app.key, "app:/Applications/Notes.app@1");
  assert.equal(byKind.app.path, "/Applications/Notes.app");
  assert.equal(byKind.setting.target, "x-apple.systempreferences:com.apple.wifi-settings-extension");
  assert.equal(byKind.contact.contact, "A1");
  await ic.pruning;
});

test("icons: an app's new mtime is a new icon; the same mtime is a memory hit", async t => {
  const dir = tmp(t);
  const helper = fakeHelper();
  const m = { "/Applications/Notes.app": 100 };
  const ic = new Icons({ dir, helper, stat: mtimes(m) });
  const a = await ic.get([app("/Applications/Notes.app")]);
  const b = await ic.get([app("/Applications/Notes.app")]);
  assert.deepEqual(a, b);
  assert.equal(helper.calls.length, 1);
  m["/Applications/Notes.app"] = 200;
  const c = await ic.get([app("/Applications/Notes.app")]);
  assert.equal(helper.calls.length, 2);
  assert.notEqual(c["app:/Applications/Notes.app"], a["app:/Applications/Notes.app"]);
  await ic.pruning;
});

test("icons: files from an earlier run are found on disk without asking", async t => {
  const dir = tmp(t);
  const stat = mtimes({ "/Applications/Notes.app": 5 });
  const first = new Icons({ dir, helper: fakeHelper(), stat });
  const a = await first.get([app("/Applications/Notes.app")]);
  const helper = fakeHelper();
  const second = new Icons({ dir, helper, stat });
  assert.deepEqual(await second.get([app("/Applications/Notes.app")]), a);
  assert.equal(helper.calls.length, 0);
  await first.pruning; await second.pruning;
});

test("icons: concurrent calls share one request per key", async t => {
  const dir = tmp(t);
  const helper = fakeHelper({ delay: 30 });
  const m = { "/A.app": 1, "/B.app": 1, "/C.app": 1 };
  const ic = new Icons({ dir, helper, stat: mtimes(m) });
  const [x, y] = await Promise.all([ic.get([app("/A.app"), app("/B.app")]), ic.get([app("/B.app"), app("/C.app")])]);
  assert.equal(x["app:/B.app"], y["app:/B.app"]);
  assert.ok(x["app:/A.app"] && y["app:/C.app"]);
  const asked = helper.calls.flat().map(i => i.path).sort();
  assert.deepEqual(asked, ["/A.app", "/B.app", "/C.app"], "B asked for once");
  await ic.pruning;
});

test("icons: a big call is split into batches of BATCH", async t => {
  const dir = tmp(t);
  const helper = fakeHelper();
  /** @type {Record<string, number>} */
  const m = {};
  const rs = [];
  for (let i = 0; i < BATCH + 5; i++) { m[`/X${i}.app`] = 1; rs.push(app(`/X${i}.app`)); }
  const ic = new Icons({ dir, helper, stat: mtimes(m) });
  assert.equal(Object.keys(await ic.get(rs)).length, BATCH + 5);
  assert.deepEqual(helper.calls.map(c => c.length), [BATCH, 5]);
  await ic.pruning;
});

test("icons: a failing or missing helper answers {} and a later call asks again", async t => {
  const dir = tmp(t);
  const stat = mtimes({ "/A.app": 1 });
  let mode = "throw";
  const good = fakeHelper();
  const helper = {
    calls: 0,
    /** @param {any[]} items @param {any} o */
    async icons(items, o) {
      this.calls++;
      if (mode === "throw") throw new Error("boom");
      if (mode === "error") return { error: "timeout" };
      return good.icons(items, o);
    },
  };
  const ic = new Icons({ dir, helper, stat });
  assert.deepEqual(await ic.get([app("/A.app")]), {});
  mode = "error";
  assert.deepEqual(await ic.get([app("/A.app")]), {});
  mode = "ok";
  assert.ok((await ic.get([app("/A.app")]))["app:/A.app"]);
  assert.equal(helper.calls, 3, "a failure is not remembered as 'no icon'");
  const bare = new Icons({ dir: tmp(t), stat });
  assert.deepEqual(await bare.get([app("/A.app")]), {});
  const badDir = new Icons({ dir: "/dev/null/icons", helper: good, stat });
  assert.deepEqual(await badDir.get([app("/A.app")]), {});
  assert.deepEqual(await ic.get(/** @type {any} */ (null)), {});
  await ic.pruning;
});

test("icons: 'no picture' is remembered for a while; peek knows what get learned", async t => {
  const dir = tmp(t);
  let clock = 1_000_000;
  const helper = fakeHelper({ none: ["contact:B2"] });
  const ic = new Icons({ dir, helper, now: () => clock });
  const rows = [
    { kind: "contact", id: "contact:A1", target: "addressbook://A1" },
    { kind: "contact", id: "contact:B2", target: "addressbook://B2" },
  ];
  assert.deepEqual(ic.peek(rows), {});
  const got = await ic.get(rows);
  assert.deepEqual(Object.keys(got), ["contact:A1"]);
  assert.deepEqual(ic.peek(rows), got);
  await ic.get(rows);
  assert.equal(helper.calls.length, 1, "B2's null is believed");
  clock += 301_000;
  await ic.get(rows);
  assert.equal(helper.calls.length, 2);
  assert.deepEqual(helper.calls[1].map(i => i.key), ["contact:B2"]);
  await ic.pruning;
});

test("icons: prune deletes least recently used files past either bound, at most once a minute", async t => {
  const dir = tmp(t);
  let clock = 10_000_000;
  const ic = new Icons({ dir, helper: fakeHelper(), maxFiles: 3, maxBytes: 1e6, now: () => clock, stat: mtimes({ "/A.app": 1 }) });
  const put = (/** @type {string} */ n, /** @type {number} */ age, size = 10) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, Buffer.alloc(size));
    const s = (Date.now() - age) / 1000;
    fs.utimesSync(f, s, s);
  };
  put("old1.png", 5000); put("old2.png", 4000); put("mid.png", 3000); put("new.png", 2000); put("notes.txt", 9000);
  await ic.get([app("/A.app")]);                             // first call prunes: "on start"
  await ic.pruning;
  let left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, [iconFile("app:/A.app@1"), "mid.png", "new.png", "notes.txt"].sort(), "oldest two gone, the fresh icon kept");

  put("x1.png", 100); put("x2.png", 100);
  await ic.get([app("/A.app")]);
  assert.equal(ic.pruning, null, "not again within a minute");
  assert.equal(fs.readdirSync(dir).filter(n => n.endsWith(".png")).length, 5);
  clock += 61_000;
  await ic.get([app("/A.app")]);
  await ic.pruning;
  left = fs.readdirSync(dir).filter(n => n.endsWith(".png"));
  assert.equal(left.length, 3);
  assert.ok(left.includes(iconFile("app:/A.app@1")));

  // the byte bound, and a pruned icon is forgotten, so the next get asks for it again
  const small = new Icons({ dir, helper: fakeHelper(), maxFiles: 100, maxBytes: 25, stat: mtimes({ "/A.app": 1 }) });
  put("big.png", 1, 30);
  await small.prune();
  const pngs = fs.readdirSync(dir).filter(n => n.endsWith(".png"));
  const bytes = pngs.reduce((a, n) => a + fs.statSync(path.join(dir, n)).size, 0);
  assert.ok(bytes <= 25, `under the byte bound (${bytes})`);
});

// ---------------------------------------------------------------------------------------------
// The real helper

const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "local");

/** A w x h RGBA PNG, solid red. */
function makePng(w, h) {
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4, Buffer.from([255, 0, 0, 255]))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Width, height and color type from a PNG's IHDR. @param {string} file */
function pngHeader(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}

test("icons: the real helper renders an app, an image and a settings pane at 64x64", { skip: !fs.existsSync(REAL) && "bin/local not built" }, async t => {
  const base = tmp(t);
  const img = path.join(base, "red.png");
  fs.writeFileSync(img, makePng(40, 20));
  const helper = new LocalHelper(REAL);
  t.after(() => helper.close());
  const ic = new Icons({ dir: path.join(base, "cache"), helper });
  const rows = [
    { kind: "app", id: "app:calc", target: "/System/Applications/Calculator.app" },
    { kind: "file", id: "file:red", target: img },
    { kind: "setting", id: "setting:wifi", target: "x-apple.systempreferences:com.apple.wifi-settings-extension" },
    { kind: "setting", id: "setting:ax", target: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility" },
  ];
  let out = await ic.get(rows);
  if (Object.keys(out).length < rows.length) out = { ...out, ...(await ic.get(rows)) };   // a cold first spawn can time out
  assert.deepEqual(Object.keys(out).sort(), ["app:calc", "file:red", "setting:ax", "setting:wifi"]);
  for (const u of Object.values(out)) {
    assert.deepEqual(pngHeader(fileURLToPath(u)), { w: 64, h: 64, colorType: 6 }, u);
  }
  assert.notEqual(fs.readFileSync(fileURLToPath(out["setting:wifi"])).toString("hex"),
    fs.readFileSync(fileURLToPath(out["setting:ax"])).toString("hex"), "each pane has its own icon");
  await ic.pruning;
});
