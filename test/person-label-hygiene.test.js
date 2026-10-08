// A module must not decide "is this the person" from the caller label with its own regex: any `device:<id>` then reads as the owner (found twice by reviewer-2, in core/flows and core/bridges).
// The person comes from the kernel's chain (ctx.kernel.chain(meta), the daemon's facts), or from core/modules/index.js ownerDevice for the registry's own checks. This test finds code that reads the
// `device:` label shape with a regex or startsWith, and fails on a new one. The list below is today's exceptions, per file, and only shrinks: owners fix their own and lower the count.
// Lines that only refuse a guest ("guest:") or an agent are not counted. The kernel's own chain builders are allowed in full.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["core", "local", "modules", "lib", "relay", "records", "stores", "names"];

/** The kernel's own chain builders: they define what a person is. */
const CHAIN_BUILDERS = new Set(["core/modules/index.js", "lib/caller.js", "core/daemon/index.js"]);

/** Existing hand-rolled label checks, by file: the most lines allowed. Lower a number when its owner removes one; never raise one. */
export const FROZEN = Object.freeze({});

const SHAPE = /(\^|\(\?:|\|)(device):|startsWith\(["'`](device):|\bcaller\s*===?\s*["'`](deck|capsule|cli)["'`]/;
const CODE = /\.(js|mjs)$/;

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "image") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE.test(e.name) && !/\.test\.[mc]?js$/.test(e.name)) out.push(p);
  }
}

/** Lines per file that read a person label shape to decide something. @returns {Record<string, number[]>} */
export function found() {
  /** @type {string[]} */ const files = [];
  for (const r of ROOTS) if (fs.existsSync(path.join(REPO, r))) walk(path.join(REPO, r), files);
  /** @type {Record<string, number[]>} */ const out = {};
  for (const f of files) {
    const rel = path.relative(REPO, f).split(path.sep).join("/");
    if (CHAIN_BUILDERS.has(rel)) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      // The kernel-off build keeps the old label rule, marked SHIM(legacy labels) on the line or in the four lines above it: it goes with the cut-over that makes the kernel mandatory. A new shim needs the marker, so it is found again then.
      if (/SHIM\(legacy labels\)/.test(lines.slice(Math.max(0, i - 4), i + 1).join("\n"))) return;
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (!SHAPE.test(line) || /guest:|device:2tylywrj3ydlkehz|throw|isAgent|agentClaim/.test(line) && !/device:/.test(line)) return;
      (out[rel] ||= []).push(i + 1);
    });
  }
  return out;
}

test("no module reads the device or tailnet label shape to decide who the person is, beyond the frozen list", () => {
  const now = found(), bad = [];
  for (const [file, lines] of Object.entries(now)) {
    const max = /** @type {Record<string, number>} */ (FROZEN)[file] ?? 0;
    if (lines.length > max) bad.push(`${file}: ${lines.length} (allowed ${max}) at line ${lines.join(", ")}`);
  }
  assert.deepEqual(bad, [], `A module decides "is this the person" from the caller label. Take the person from the kernel's chain (ctx.kernel.chain(meta)) or core/modules ownerDevice, not a regex on the label:\n${bad.join("\n")}`);
});

test("the frozen list only shrinks: a file that no longer has the pattern leaves the list", () => {
  const now = found(), stale = Object.entries(FROZEN).filter(([f, n]) => (now[f] || []).length < n).map(([f, n]) => `${f}: list says ${n}, found ${(now[f] || []).length}`);
  assert.deepEqual(stale, [], `lower or delete these entries in FROZEN:\n${stale.join("\n")}`);
});
