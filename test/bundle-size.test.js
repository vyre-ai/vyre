// @ts-check
// The web bundle budget (.github/scripts/bundle-size.mjs): the ceiling is on the first load (what index.html names), a lazy chunk has its own limit, the total is reported and never fails alone, and a growth of
// more than 10% fails against a baseline that records both numbers (an older baseline makes the drift rules wait).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const SCRIPT = path.resolve(import.meta.dirname, "../.github/scripts/bundle-size.mjs");
/** A dist whose files gzip to about `kib` KiB (random bytes do not compress). */
const blob = (/** @type {number} */ kib) => crypto.randomBytes(kib * 1024);

function run(t, { entry, lazy = 0, other = 0, base }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-bundle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const js = path.join(dir, "dist/_expo/static/js/web");
  fs.mkdirSync(js, { recursive: true });
  fs.writeFileSync(path.join(js, "entry-a.js"), blob(entry));
  if (lazy) fs.writeFileSync(path.join(js, "route-b.js"), blob(lazy));
  if (other) { fs.mkdirSync(path.join(dir, "dist/term")); fs.writeFileSync(path.join(dir, "dist/term/xterm.js"), blob(other)); }
  fs.writeFileSync(path.join(dir, "dist/index.html"), '<html><script src="/app/_expo/static/js/web/entry-a.js" defer></script></html>');
  if (base) fs.writeFileSync(path.join(dir, "base.json"), JSON.stringify(base));
  const r = spawnSync(process.execPath, [SCRIPT, "--dist", path.join(dir, "dist"), "--out", path.join(dir, "size.json"), ...(base ? ["--base", path.join(dir, "base.json")] : [])], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, size: JSON.parse(fs.readFileSync(path.join(dir, "size.json"), "utf8")) };
}

test("the first load is what index.html names; the rest of the JS is the total, reported and never a ceiling", t => {
  const r = run(t, { entry: 1000, lazy: 250, other: 200 });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.size.first_load_kib >= 999 && r.size.first_load_kib <= 1002, JSON.stringify(r.size));
  assert.ok(r.size.js_gzip_kib >= 1449 && r.size.js_gzip_kib <= 1453, "the total counts the lazy chunk and the vendored files");
});

test("the first load over 1100 KiB fails, and a lazy chunk over 300 KiB fails", t => {
  assert.match(run(t, { entry: 1150 }).out, /over the 1100 KiB ceiling/);
  const big = run(t, { entry: 900, lazy: 320 });
  assert.equal(big.code, 1);
  assert.match(big.out, /lazy chunk .*route-b\.js is 3\d\d KiB, over 300/);
});

test("more than 10% growth fails against a baseline that records both numbers, either one; an old baseline waits", t => {
  assert.match(run(t, { entry: 1000, base: { js_gzip_kib: 1000, first_load_kib: 900 } }).out, /first-load JS grew more than 10%/);
  assert.match(run(t, { entry: 800, lazy: 300, base: { js_gzip_kib: 950, first_load_kib: 800 } }).out, /total JS grew more than 10%/);
  const old = run(t, { entry: 1000, base: { js_gzip_kib: 500 } });
  assert.equal(old.code, 0, old.out);
  assert.match(old.out, /no baseline that records both/);
  assert.equal(run(t, { entry: 1000, base: { js_gzip_kib: 1000, first_load_kib: 950 } }).code, 0);
});
