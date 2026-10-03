import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createStoreFor, preflight, nameOf, REQUIRE, spacesThatFit } from "./space-store.js";
import { MEMORY_PROFILES } from "./provision.js";

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(SCRATCH, "ss-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const meminfo = (mb) => () => `MemTotal: 99999999 kB\nMemAvailable: ${mb * 1024} kB\n`;

test("sqlite is the default: nothing is checked, nothing is provisioned", async () => {
  let called = 0;
  const f = createStoreFor({ mode: "sqlite", preflight: async () => { called++; return { ok: true, reasons: [] }; } });
  assert.equal(await f("spc_aaaaaaaaaaaa", tmp()), undefined);
  assert.equal(called, 0);
});

test("preflight names every reason a box is too small, and passes a big enough one", async () => {
  const dir = tmp();
  const small = await preflight({ dir, readMeminfo: meminfo(900), docker: async () => false, statfs: () => ({ bavail: 100, bsize: 1048576 }) });
  assert.equal(small.ok, false);
  assert.ok(small.reasons.some((r) => /Docker/.test(r)) && small.reasons.some((r) => /memory/.test(r)) && small.reasons.some((r) => /disk/.test(r)));
  const big = await preflight({ dir, readMeminfo: meminfo(REQUIRE.memoryMb + 500), docker: async () => true, statfs: () => ({ bavail: 20000, bsize: 1048576 }) });
  assert.equal(big.ok, process.platform === "linux");
});

test("auto on a box that is too small falls back to SQLite, says why in a file, and remembers it", async () => {
  const dir = tmp(), lines = [];
  const f = createStoreFor({ mode: "auto", log: (l) => lines.push(l), preflight: async () => ({ ok: false, reasons: ["not enough free memory"], facts: {} }) });
  assert.equal(await f("spc_aaaaaaaaaaaa", dir), undefined);
  assert.match(fs.readFileSync(path.join(dir, "twenty-unavailable.json"), "utf8"), /not enough free memory/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8")).kind, "sqlite");
  assert.ok(lines.some((l) => /SQLite/.test(l)));
  // a later start on a bigger box does not move the Space to a second, empty store
  const g = createStoreFor({ mode: "auto", preflight: async () => { throw new Error("not asked"); } });
  assert.equal(await g("spc_aaaaaaaaaaaa", dir), undefined);
});

test("twenty on a box that is too small refuses to start the Space, with the reasons", async () => {
  const f = createStoreFor({ mode: "twenty", preflight: async () => ({ ok: false, reasons: ["Docker is not installed"], facts: {} }) });
  await assert.rejects(() => f("spc_aaaaaaaaaaaa", tmp()), (e) => e.code === "unavailable" && /Docker is not installed/.test(e.message));
});

test("a Space made on Twenty never falls back to SQLite", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({ kind: "twenty" }));
  const f = createStoreFor({ mode: "auto", preflight: async () => ({ ok: false, reasons: ["Docker is not running"], facts: {} }) });
  await assert.rejects(() => f("spc_aaaaaaaaaaaa", dir), /cannot start here/);
});

test("a Space name becomes a compose-safe name", () => { assert.equal(nameOf("spc_abcdefghijkl"), "spc-abcdefghijkl"); });

test("the admission check and the container limits are the same numbers", () => {
  const caps = Object.values(MEMORY_PROFILES.small).reduce((a, b) => a + b, 0);
  assert.equal(REQUIRE.memoryMb, caps + 300);
  assert.equal(spacesThatFit(REQUIRE.memoryMb), 1);
  assert.equal(spacesThatFit(REQUIRE.memoryMb - 1), 0);
  assert.equal(spacesThatFit(300 + 2 * caps), 2);
});

test("a new Space on a box too small for Twenty is not created until the person agrees; the plan is shown first", async () => {
  const { planStore, SMALL_BOX_NOTE, SMALL_BOX_CHOICES } = await import("./space-store.js");
  const small = async () => ({ ok: false, reasons: ["not enough free memory"], facts: {} });
  const plan = await planStore({ dir: tmp(), mode: "auto", preflight: small });
  assert.equal(plan.store, "sqlite");
  assert.equal(plan.confirm.text, SMALL_BOX_NOTE);
  assert.deepEqual(plan.confirm.choices, SMALL_BOX_CHOICES);
  assert.match(SMALL_BOX_NOTE, /can't be moved to the larger store yet, so add memory first/);
  assert.equal((await planStore({ dir: tmp(), mode: "auto", preflight: async () => ({ ok: true, reasons: [], facts: {} }) })).confirm, undefined);
  const dir = tmp();
  const f = createStoreFor({ mode: "auto", preflight: small });
  await assert.rejects(() => f("spc_aaaaaaaaaaaa", dir, { requireConfirm: true }), (e) => e.code === "needs_confirmation" && e.plan.confirm.choices.includes("cancel"));
  assert.equal(fs.existsSync(path.join(dir, "store.json")), false, "nothing was decided or written");
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({ kind: "sqlite", confirmed: true }));
  assert.equal(await f("spc_aaaaaaaaaaaa", dir, { requireConfirm: true }), undefined, "once agreed it opens on the built-in store");
});
