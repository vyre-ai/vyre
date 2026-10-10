// A module must not decide "is this the person" from the caller label with its own regex: any `device:<id>` then reads as the owner (found twice by reviewer-2, in core/flows and core/bridges).
// The person comes from the kernel's chain (ctx.kernel.chain(meta), the daemon's facts), or from core/modules/index.js ownerDevice for the registry's own checks. This test finds code that reads the
// `device:` or `tailnet:` label shape with a regex or startsWith, and fails on a new one. The list below is today's exceptions, per file, and only shrinks: owners fix their own and lower the count.
// Lines that only refuse a guest ("tailnet-guest:") or an agent are not counted. The kernel's own chain builders are allowed in full.
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

const SHAPE = /(\^|\(\?:|\|)(device|tailnet|tailnet-guest):|startsWith\(["'`](device|tailnet):|\bcaller\s*===?\s*["'`](deck|capsule|cli)["'`]/;
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

/** @param {{ blessed?: boolean }} [o] blessed: list the lines the SHIM(legacy labels) marker lets through instead of the ones that fail. @returns {Record<string, number[]>} Lines per file that read a person label shape to decide something. */
export function found({ blessed = false } = {}) {
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
      const shimmed = /SHIM\(legacy labels\)/.test(lines.slice(Math.max(0, i - 4), i + 1).join("\n"));
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (!SHAPE.test(line) || /tailnet-guest:|tailnet:agent|throw|isAgent|agentClaim/.test(line) && !/device:/.test(line)) return;
      if (shimmed !== blessed) return;
      (out[rel] ||= []).push(i + 1);
    });
  }
  return out;
}

/** Lines the SHIM(legacy labels) marker lets through, by file: the most allowed. The marker used to bless any line anywhere; now each blessed line is counted, a new one fails, and a file that loses its shim must lower or delete its entry. Goes to nothing with the kernel-on cut-over. */
export const SHIMMED = Object.freeze(/** @type {Record<string, number>} */ ({ "core/memory/index.js": 3, "core/memory/site.js": 1, "core/memory/write.js": 1, "core/modules/federate.js": 1 }));

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

test("the SHIM(legacy labels) marker blesses only the counted lines, and the list only shrinks", () => {
  const now = found({ blessed: true }), grew = [], stale = [];
  for (const [file, lines] of Object.entries(now)) if (lines.length > (SHIMMED[file] ?? 0)) grew.push(`${file}: ${lines.length} blessed (allowed ${SHIMMED[file] ?? 0}) at line ${lines.join(", ")}`);
  for (const [f, n] of Object.entries(SHIMMED)) if ((now[f] || []).length < n) stale.push(`${f}: list says ${n}, found ${(now[f] || []).length}`);
  assert.deepEqual(grew, [], `A new line hides behind SHIM(legacy labels). Take the person from the kernel's chain, or add the file to SHIMMED with the reason:\n${grew.join("\n")}`);
  assert.deepEqual(stale, [], `lower or delete these entries in SHIMMED:\n${stale.join("\n")}`);
});

test("the detector is not blind: it flags a hand-rolled device label read and the marker blesses it only when counted", () => {
  assert.ok(SHAPE.test('if (/^device:[a-z]+$/.test(caller)) return true;'), "a device regex is the shape");
  assert.ok(SHAPE.test('return caller.startsWith("tailnet:");'), "a startsWith on tailnet: is the shape");
  assert.ok(!SHAPE.test('const who = ctx.kernel.chain(meta);'), "the kernel chain is not the shape");
});
