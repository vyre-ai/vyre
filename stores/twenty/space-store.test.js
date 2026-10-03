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

const SP = "spc_aaaaaaaaaaaa";
const kdir = (home) => path.join(home, "kernel");
const hdir = (home) => path.join(home, "kernel", "spaces", SP);

test("sqlite is the default: nothing is checked, nothing is provisioned", async () => {
  let called = 0;
  const f = createStoreFor({ home: tmp(), mode: "sqlite", preflight: async () => { called++; return { ok: true, reasons: [] }; } });
  assert.equal(await f(SP, { personal: true }), undefined);
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

test("auto on a box that is too small falls back to SQLite for the home's own Space, says why in a file, and remembers it", async () => {
  const home = tmp(), lines = [];
  const f = createStoreFor({ home, mode: "auto", log: (l) => lines.push(l), preflight: async () => ({ ok: false, reasons: ["not enough free memory"], facts: {} }) });
  assert.equal(await f(SP, { personal: true }), undefined);
  assert.match(fs.readFileSync(path.join(kdir(home), "twenty-unavailable.json"), "utf8"), /not enough free memory/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(kdir(home), "store.json"), "utf8")).kind, "sqlite");
  assert.ok(lines.some((l) => /SQLite/.test(l)));
  const g = createStoreFor({ home, mode: "auto", preflight: async () => { throw new Error("not asked"); } });
  assert.equal(await g(SP, { personal: true }), undefined, "a later start does not move the Space to a second, empty store");
});

test("twenty on a box that is too small refuses to start the Space, with the reasons", async () => {
  const f = createStoreFor({ home: tmp(), mode: "twenty", preflight: async () => ({ ok: false, reasons: ["Docker is not installed"], facts: {} }) });
  await assert.rejects(() => f(SP, { personal: true }), (e) => e.code === "unavailable" && /Docker is not installed/.test(e.message));
});

test("a Space made on Twenty never falls back to SQLite", async () => {
  const home = tmp(); fs.mkdirSync(kdir(home), { recursive: true });
  fs.writeFileSync(path.join(kdir(home), "store.json"), JSON.stringify({ kind: "twenty" }));
  const f = createStoreFor({ home, mode: "auto", preflight: async () => ({ ok: false, reasons: ["Docker is not running"], facts: {} }) });
  await assert.rejects(() => f(SP, { personal: true }), /cannot start here/);
});

test("a Space name becomes a compose-safe name", () => { assert.equal(nameOf("spc_abcdefghijkl"), "spc-abcdefghijkl"); });

test("the admission check and the container limits are the same numbers", () => {
  const caps = Object.values(MEMORY_PROFILES.small).reduce((a, b) => a + b, 0);
  assert.equal(REQUIRE.memoryMb, caps + 300);
  assert.equal(spacesThatFit(REQUIRE.memoryMb), 1);
  assert.equal(spacesThatFit(REQUIRE.memoryMb - 1), 0);
  assert.equal(spacesThatFit(300 + 2 * caps), 2);
});

test("a new hosted Space on a box too small for Twenty is not created until the person agrees; the plan is shown first", async () => {
  const { planStore, SMALL_BOX_NOTE, SMALL_BOX_CHOICES } = await import("./space-store.js");
  const small = async () => ({ ok: false, reasons: ["not enough free memory"], facts: {} });
  const home = tmp();
  const f = createStoreFor({ home, mode: "auto", preflight: small });
  const plan = await f.plan();
  assert.equal(plan.store, "sqlite");
  assert.equal(plan.confirm.text, SMALL_BOX_NOTE);
  assert.deepEqual(plan.confirm.choices, SMALL_BOX_CHOICES);
  assert.match(SMALL_BOX_NOTE, /can't be moved to the larger store yet, so add memory first/);
  assert.equal((await planStore({ dir: tmp(), mode: "auto", preflight: async () => ({ ok: true, reasons: [], facts: {} }) })).confirm, undefined);
  await assert.rejects(() => f(SP, { owner: "per_x" }), (e) => e.code === "needs_confirmation" && e.plan.confirm.choices.includes("cancel"));
  assert.equal(fs.existsSync(path.join(hdir(home), "store.json")), false, "nothing was decided or written");
  assert.equal(await f(SP, { owner: "per_x", accept_builtin_store: true }), undefined, "once agreed it opens on the built-in store");
});
