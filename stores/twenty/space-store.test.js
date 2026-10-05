import "../../scripts/mac-test-guard.mjs";
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

test("memory (a development build): nothing is checked, nothing is provisioned", async () => {
  let called = 0;
  const f = createStoreFor({ home: tmp(), mode: "memory", preflight: async () => { called++; return { ok: true, reasons: [] }; } });
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

test("on a box that is too small the home's own Space gets a store that refuses every record call, says why in a file, and the daemon still starts", async () => {
  const home = tmp(), lines = [];
  const f = createStoreFor({ home, mode: "twenty", log: (l) => lines.push(l), preflight: async () => ({ ok: false, reasons: ["not enough free memory"], facts: {} }) });
  const store = await f(SP, { personal: true });
  assert.equal(store.refusing, true);
  assert.match(fs.readFileSync(path.join(kdir(home), "twenty-unavailable.json"), "utf8"), /not enough free memory/);
  assert.equal(fs.existsSync(path.join(kdir(home), "store.json")), false, "nothing was decided: a later start with room provisions Twenty");
  await assert.rejects(() => store.query("contact", {}), (e) => e.code === "unavailable" && /cannot run the record store \(Twenty\): not enough free memory\. Put your space on your server/.test(e.message));
  assert.ok(lines.some((l) => /store for .*: none/.test(l)));
});

test("a Space made on Twenty never starts without it", async () => {
  const home = tmp(); fs.mkdirSync(kdir(home), { recursive: true });
  fs.writeFileSync(path.join(kdir(home), "store.json"), JSON.stringify({ kind: "twenty" }));
  const f = createStoreFor({ home, mode: "twenty", preflight: async () => ({ ok: false, reasons: ["Docker is not running"], facts: {} }) });
  await assert.rejects(() => f(SP, { personal: true }), /cannot start here/);
});

test("VYRE_STORE is twenty or memory: sqlite and auto are refused by name", async () => {
  const { checkMode } = await import("./space-store.js");
  assert.equal(checkMode("twenty"), "twenty"); assert.equal(checkMode("memory"), "memory");
  for (const m of ["sqlite", "auto"]) assert.throws(() => checkMode(m), /twenty or memory/);
  assert.equal(await createStoreFor({ home: tmp(), mode: "memory" })(SP, { personal: true }), undefined, "memory: the kernel makes its in-memory reference store");
});

test("a Space name becomes a compose-safe name", () => { assert.equal(nameOf("spc_abcdefghijkl"), "spc-abcdefghijkl"); });

test("the admission check and the container limits are the same numbers", () => {
  const caps = Object.values(MEMORY_PROFILES.small).reduce((a, b) => a + b, 0);
  assert.equal(REQUIRE.memoryMb, caps + 300);
  assert.equal(spacesThatFit(REQUIRE.memoryMb), 1);
  assert.equal(spacesThatFit(REQUIRE.memoryMb - 1), 0);
  assert.equal(spacesThatFit(300 + 2 * caps), 2);
});

test("a new hosted Space on a box too small for Twenty is not created; the plan is shown first and offers the server", async () => {
  const { planStore, SMALL_BOX_NOTE, SMALL_BOX_CHOICES } = await import("./space-store.js");
  const small = async () => ({ ok: false, reasons: ["not enough free memory"], facts: {} });
  const home = tmp();
  const f = createStoreFor({ home, mode: "twenty", preflight: small });
  const plan = await f.plan();
  assert.equal(plan.store, "none");
  assert.equal(plan.confirm.text, SMALL_BOX_NOTE);
  assert.deepEqual(plan.confirm.choices, SMALL_BOX_CHOICES);
  assert.match(SMALL_BOX_NOTE, /Put it on your server instead/);
  assert.equal((await planStore({ dir: tmp(), mode: "twenty", preflight: async () => ({ ok: true, reasons: [], facts: {} }) })).confirm, undefined);
  await assert.rejects(() => f(SP, { owner: "per_x" }), (e) => e.code === "needs_confirmation" && e.plan.confirm.choices.includes("server") && !e.plan.confirm.choices.includes("create"));
  assert.equal(fs.existsSync(path.join(hdir(home), "store.json")), false, "nothing was decided or written");
});

test("opening a Space whose key is inside the rotation window rotates it; a failed rotation is loud and writes a warning; an expired key refuses to start", async () => {
  const dir = path.join(tmp(), "kernel"); fs.mkdirSync(dir, { recursive: true });
  const home = path.dirname(dir);
  const tw = path.join(dir, "twenty-home", "spaces", nameOf(SP), "twenty"); fs.mkdirSync(tw, { recursive: true });
  const jwt = (ms) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(ms / 1000) })).toString("base64url")}.s`;
  fs.writeFileSync(path.join(tw, "service.key"), jwt(Date.now() + 10 * 864e5));
  fs.writeFileSync(path.join(tw, "webhook.secret"), "x"); fs.writeFileSync(path.join(tw, "workspace.id"), "w");
  const lines = []; let rotated = 0, fail = false;
  const base = { home, mode: "twenty", log: (l) => lines.push(l), preflight: async () => ({ ok: true, reasons: [] }),
    provision: async () => ({ url: "http://127.0.0.1:1", keyFile: path.join(tw, "service.key"), webhookSecretFile: path.join(tw, "webhook.secret") }),
    rotate: async () => { if (fail) throw new Error("Twenty did not answer"); rotated++; fs.writeFileSync(path.join(tw, "service.key"), jwt(Date.now() + 365 * 864e5)); } };
  const store1 = await createStoreFor(base)(SP, { personal: true }).catch((e) => e);
  assert.equal(rotated, 1, "inside the window: rotated at open");
  // (the store itself needs a live Twenty to define core types; the key check is what is under test, so a refused define is fine here)
  fail = true; fs.writeFileSync(path.join(tw, "service.key"), jwt(Date.now() + 10 * 864e5));
  const r2 = await createStoreFor(base)(SP, { personal: true }).catch((e) => e);
  assert.ok(lines.some((l) => /WARNING: the API key/.test(l) && /expires in 9 days|expires in 10 days/.test(l)), "the failure is logged loudly with the days left");
  assert.ok(fs.existsSync(path.join(dir, "key-warning.json")));
  fs.writeFileSync(path.join(tw, "service.key"), jwt(Date.now() - 864e5));
  const r3 = await createStoreFor(base)(SP, { personal: true }).catch((e) => e);
  assert.ok(r3 instanceof Error && r3.code === "unavailable" && /has expired/.test(r3.message), "an expired key stops the Space from starting quietly");
});
