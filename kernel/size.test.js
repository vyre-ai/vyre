import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The kernel's size cap counts the TRUSTED BASE, not the directory (KERNEL-brief.md, "What the cap counts"): what, if wrong, lets a caller do something its grants do not allow.
// Every non-test file under kernel/ must be named here as base or as not-base, so a new part cannot arrive uncounted; the base is capped at 9,000 lines.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
// 9100 (platform, 0.2.9; signed off by reviewer-3), raised from 9000 for the module bridge (kernel/modules child, supervisor and host: an added module's ctx over a message channel) and the sealed-value moves in gateway/sealing.js; trunk b886baf35 sat just under 9000.
// 9260 (lead, 6 Oct 2026, at the 0.2.9 integration): the merged release carries the Personal to My Cloud move, per-chat keys on chat folders, the chat-folder guard and the one-yes stack together,
// each needing kernel authority; the base measured 9251. A ceiling, not a target: 0.3.0 trims it back under 9100 (team/BACKLOG.md).
// 9400 (connect-anything, 9 Oct 2026, for the lead's ruling): step A of the one grant model puts teams, named vaults, the project group and the origin condition in the base, 167 net lines (team/0.3.1/DESIGN-one-grant.md);
// step B deletes the Vault's own grant tables, which are outside the kernel. If the lead holds the cap, the way down is to drop the project group (about 20 lines) and fold teams and vaults into one record store.
const CAP = 9400;

/** Base: whole directories and single files. */
const BASE_DIRS = ["core", "grants", "tasks", "audit", "door", "modules"];
const BASE_FILES = [
  "gateway/records.js", "gateway/sealing.js", "gateway/index.js",
  "seal/client.js", "seal/uses.js", "seal/wire.js", "seal/classes.js",
  "store/sqlite.js", "store/sqlite-log.js", "store/values.js", "store/query.js",
  "index.js", "boot.js", "home.js", "keys.js", "devbuild.js",
];
/** Not base, single files. */
const NOT_BASE_FILES = {
  "modules/child.js": "runs INSIDE the module's sandbox, as the module's own host: the supervisor does not trust it (it is the confined side of the bridge, and everything it does is a message the host-side door checks)",
  "bus.js": "the event bus: an adapter that reads and writes modules' activity events as marked entries of the kernel log; the log's own rules (append-only, chained) are in core and store",
};
/** Not base, with where each goes (team/0.3/KERNEL-size.md and CUTOVER.md). */
const NOT_BASE_DIRS = {
  seal: "the sealing process: its own process and its own cap",
  flows: "moves to a first-party module at cut-over",
  expr: "moves with flows",
  storage: "moves to the storage module (vault)",
  identity: "one shared library, then out",
  remote: "moves to the remote/Wink module",
  spaces: "composition of kernels; kept, small",
  golden: "goes with the legacy gates at cut-over",
  retrofit: "goes with the legacy gates at cut-over",
  conformance: "test infrastructure",
  tools: "tool surface; out with the module move",
  contracts: "constants shared with the UI",
  gateway: "adapters (leases, drive, runner ports): out with their modules",
  store: "the reference memory store and conformance helpers",
  placement: "the scheduler: a decision over node records, never an enforcement (the grants are); moves to a first-party module with the runner",
};

const files = (/** @type {string} */ dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
  return /\.(m?js)$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [p] : [];
});
const lines = (/** @type {string} */ f) => fs.readFileSync(f, "utf8").split("\n").length;

test("the trusted base stays under its cap, and every part of kernel/ is named as base or not-base", () => {
  let base = 0;
  /** @type {string[]} */ const unnamed = [];
  for (const f of files(ROOT)) {
    const rel = path.relative(ROOT, f).split(path.sep).join("/");
    const top = rel.split("/")[0];
    if (rel in NOT_BASE_FILES) continue;
    if (BASE_FILES.includes(rel) || BASE_DIRS.includes(top)) { base += lines(f); continue; }
    if (rel.includes("/") && top in NOT_BASE_DIRS) continue;
    if (!rel.includes("/") && rel === "size.test.js") continue;
    unnamed.push(rel);
  }
  assert.deepEqual(unnamed, [], `name these in kernel/size.test.js (base, or not-base with where it goes) and in KERNEL-size.md: ${unnamed.join(", ")}`);
  assert.ok(base <= CAP, `the trusted base is ${base} lines, over the cap of ${CAP}`);
  assert.ok(base > 3000, `the base count looks wrong (${base}): is the list in this test stale?`);
});
