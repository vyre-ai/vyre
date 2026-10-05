// @ts-check
// The root helper's swap for a small server (box/vyre `sp_swap`): ENCRYPTED swap (a dm-crypt plain mapping keyed from /dev/urandom, crypttab so every boot makes a new key) or none at all. The function is cut out of the
// script and run with sh against a temp folder, with fakes for the host tools (uname, swapon, cryptsetup, losetup, mkswap, fallocate) on a PATH of its own. Linux only (stat -c).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(REPO, "box/vyre"), "utf8");
const FN = SRC.slice(SRC.indexOf("SP_SWAPFILE=${SP_SWAPFILE"), SRC.indexOf("sp_up() {"));
const LINUX = process.platform === "linux";
const REAL = ["awk", "stat", "id", "grep", "cut", "head", "rm", "chmod", "dd", "mkdir", "cat"];

/** @param {{ cryptsetup?: boolean, memMb?: number, swapOn?: boolean, loopExisting?: boolean, cryptFails?: boolean, fileMode?: string }} o */
function run(o = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "swap-"));
  const bin = path.join(dir, "bin"), dm = path.join(dir, "dm"), F = dir;
  fs.mkdirSync(bin); fs.mkdirSync(dm);
  for (const c of REAL) { const p = spawnSync("sh", ["-c", `command -v ${c}`]).stdout.toString().trim(); if (p) fs.symlinkSync(p, path.join(bin, c)); }
  const fake = (/** @type {string} */ name, /** @type {string} */ body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  fake("uname", "echo Linux");
  fake("swapon", `if [ "$1" = "--noheadings" ]; then cat "${F}/swapon-list" 2>/dev/null; exit 0; fi; echo "swapon $*" >>"${F}/calls"; exit 0`);
  fake("mkswap", `echo "mkswap $*" >>"${F}/calls"`);
  fake("fallocate", `: >"$3"`);
  fake("losetup", `case "$1" in -j) [ -f "${F}/loop-existing" ] && echo "/dev/loop7: [64769]:12 ($2)"; exit 0 ;; -f) echo "losetup $*" >>"${F}/calls"; echo /dev/loop9 ;; -d) echo "losetup $*" >>"${F}/calls" ;; esac`);
  if (o.cryptsetup !== false) fake("cryptsetup", `echo "cryptsetup $*" >>"${F}/calls"; case "$1" in open) [ -f "${F}/crypt-fails" ] && exit 1; : >"${dm}/vyre-swap" ;; close) rm -f "${dm}/vyre-swap" ;; esac; exit 0`);
  if (o.swapOn) fs.writeFileSync(path.join(F, "swapon-list"), "/swapfile\n");
  if (o.loopExisting) fs.writeFileSync(path.join(F, "loop-existing"), "1");
  if (o.cryptFails) fs.writeFileSync(path.join(F, "crypt-fails"), "1");
  fs.writeFileSync(path.join(F, "meminfo"), `MemTotal: ${(o.memMb ?? 3900) * 1024} kB\nMemAvailable: 2000000 kB\n`);
  const swapfile = path.join(F, "swapfile");
  if (o.fileMode) { fs.writeFileSync(swapfile, ""); fs.chmodSync(swapfile, parseInt(o.fileMode, 8)); }
  const script = `sp_log() { echo "$*" >>"${F}/log"; }\nSP_SWAPFILE="${swapfile}"; SP_DM="${dm}"; SP_MEMINFO="${F}/meminfo"; SP_CRYPTTAB="${F}/crypttab"; SP_FSTAB="${F}/fstab"\n${FN}\nsp_swap\n`;
  const r = spawnSync("sh", ["-c", script], { env: { PATH: bin }, encoding: "utf8" });
  const rd = (/** @type {string} */ n) => (fs.existsSync(path.join(F, n)) ? fs.readFileSync(path.join(F, n), "utf8") : "");
  return { status: r.status, stderr: r.stderr, calls: rd("calls"), log: rd("log"), crypttab: rd("crypttab"), fstab: rd("fstab"), mapped: fs.existsSync(path.join(dm, "vyre-swap")), file: fs.existsSync(swapfile) ? fs.statSync(swapfile) : null, dir };
}

test("encrypted swap: a small server with cryptsetup gets a dm-crypt plain mapping keyed from /dev/urandom, mkswap and swapon on the mapping, and crypttab so every boot makes a new key", { skip: !LINUX }, () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /cryptsetup open --type plain --cipher aes-xts-plain64 --key-size 512 --key-file \/dev\/urandom --keyfile-size 64 \/dev\/loop9 vyre-swap/);
  assert.match(r.calls, /mkswap .*\/dm\/vyre-swap/);
  assert.match(r.calls, /swapon .*\/dm\/vyre-swap/);
  assert.ok(!/swapon [^\n]*swapfile/.test(r.calls), "the plain file is never swapped on directly");
  assert.equal((r.file && (r.file.mode & 0o777)), 0o600, "the backing file is private");
  assert.match(r.crypttab, /^vyre-swap \S+ \/dev\/urandom swap,cipher=aes-xts-plain64,size=512$/m, "a new random key at every boot, kept nowhere");
  assert.match(r.fstab, /\/dm\/vyre-swap none swap sw 0 0/);
  assert.match(r.log, /encrypted swap/);
});

test("no cryptsetup: no swap at all, and the reason says why (the capped Space holds without it)", { skip: !LINUX }, () => {
  const r = run({ cryptsetup: false });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/swapon|mkswap|losetup/.test(r.calls), `nothing was set up: ${r.calls}`);
  assert.equal(r.file, null, "no swapfile was even made");
  assert.equal(r.crypttab + r.fstab, "", "and no boot entry");
  assert.match(r.log, /no cryptsetup here, so no swap/);
});

test("swap is left alone when it is not needed or not safe: a big server, a server with swap, a bad file, a failed mapping", { skip: !LINUX }, () => {
  assert.equal(run({ memMb: 8000 }).calls, "", "a server of 8 GB gets none");
  assert.equal(run({ swapOn: true }).calls, "", "a server that already has swap keeps it");
  const loose = run({ fileMode: "644" });
  assert.equal(loose.calls, "", "a world-readable file is not used");
  assert.match(loose.log, /not a 0600 file/);
  const failed = run({ cryptFails: true });
  assert.match(failed.log, /cryptsetup failed/);
  assert.ok(!/swapon/.test(failed.calls) && /losetup -d/.test(failed.calls), "a failed mapping is undone and nothing is swapped on");
  assert.equal(failed.crypttab, "", "and no boot entry is written");
  const again = run({ loopExisting: true });
  assert.ok(!/losetup -f/.test(again.calls), "an existing loop device for the file is reused, not stacked");
});
