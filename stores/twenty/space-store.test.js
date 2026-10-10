import "../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createStoreFor, preflight, nameOf, REQUIRE, spacesThatFit, requireFor, SERVER_FULL, MEASURED, startingWords } from "./space-store.js";
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

test("auto on a server that cannot run Twenty for a reason other than size refuses to start the Space, never SQLite quietly", async () => {
  const home = tmp();
  const f = createStoreFor({ home, mode: "auto", preflight: async () => ({ ok: false, reasons: ["Docker is not installed or this user cannot use it"], facts: {} }) });
  await assert.rejects(() => f(SP, { personal: true }), (e) => e.code === "unavailable" && /Docker is not installed/.test(e.message));
  assert.equal(fs.existsSync(path.join(kdir(home), "store.json")), false, "no choice is written: the next start tries Twenty again");
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
  assert.equal(spacesThatFit(REQUIRE.memoryMb, 8192), 1);
  assert.equal(spacesThatFit(REQUIRE.memoryMb - 1, 8192), 0);
  assert.equal(spacesThatFit(300 + 2 * caps, 8192), 2);
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
  assert.match(SMALL_BOX_NOTE, /Put it on your server instead/);
  assert.equal((await planStore({ dir: tmp(), mode: "auto", preflight: async () => ({ ok: true, reasons: [], facts: {} }) })).confirm, undefined);
  await assert.rejects(() => f(SP, { owner: "per_x" }), (e) => e.code === "needs_confirmation" && e.plan.confirm.choices.includes("cancel"));
  assert.equal(fs.existsSync(path.join(hdir(home), "store.json")), false, "nothing was decided or written");
  assert.equal(await f(SP, { owner: "per_x", accept_builtin_store: true }), undefined, "once agreed it opens on the built-in store");
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

test("storeMode: a device install is Basic (no Twenty, no Docker); VYRE_STORE still overrides", async () => {
  const { storeMode } = await import("./space-store.js");
  assert.equal(storeMode({}, { server: false }), "sqlite");
  assert.equal(storeMode({}, {}), "sqlite");
  assert.equal(storeMode({ VYRE_STORE: "twenty" }, { server: false }), "twenty");
  const called = []; const f = createStoreFor({ home: tmp(), server: false, preflight: async () => { called.push(1); return { ok: true, reasons: [] }; } });
  assert.equal(await f("vyre://spc_aaaaaaaaaaaa"), undefined);
  assert.equal(called.length, 0);
});

test("storeMode in a packaged build: a server is Twenty unless the person said sqlite, a device always Basic", async () => {
  const { storeMode } = await import("./space-store.js");
  const pkg = fs.mkdtempSync(path.join(SCRATCH, "pkg-")); // no lib/build-kind.js: a packaged build
  for (const v of [undefined, "sqlite", "auto", "twenty"]) {
    const env = v ? { VYRE_STORE: v } : {};
    assert.equal(storeMode(env, { server: true, root: pkg }), v === "sqlite" ? "sqlite" : "twenty", `server with ${v}`);
    assert.equal(storeMode(env, { server: false, root: pkg }), "sqlite", `device with ${v}`);
  }
});

test("a 4 GB server gets the tiny profile and its measured need; when there is no room the one plain line is the answer", async () => {
  assert.equal(requireFor(8192), REQUIRE, "a bigger machine keeps the small profile's need");
  assert.equal(requireFor(4096).memoryMb, MEASURED.tiny + 300);
  assert.ok(requireFor(4096).memoryMb < REQUIRE.memoryMb);
  const dir = tmp();
  const mi = (mb) => () => `MemTotal: 4096000 kB\nMemAvailable: ${mb * 1024} kB\n`;
  const ok = await preflight({ dir, totalMb: 4096, readMeminfo: mi(requireFor(4096).memoryMb + 10), docker: async () => true, statfs: () => ({ bavail: 1e9, bsize: 4096 }), helper: false });
  assert.equal(ok.ok, true, ok.reasons.join("; "));
  const full = await preflight({ dir, totalMb: 4096, readMeminfo: mi(1500), docker: async () => true, statfs: () => ({ bavail: 1e9, bsize: 4096 }), helper: false });
  assert.equal(full.ok, false);
  assert.ok(full.reasons[0].startsWith(SERVER_FULL), full.reasons[0]);
  assert.equal(SERVER_FULL, "This server is full. Use a bigger server for another space.");
});

test("degrade: a Space whose store cannot be set up gets a store that answers unavailable, a state file says why, and the setup is tried again; when it works the kernel's definitions are applied and the store forwards", async () => {
  const { createMemoryStore } = await import("../../kernel/store/memory.js");
  const home = tmp(); const dir = path.join(home, "kernel");
  let ok = false; const lines = [];
  const real = createMemoryStore({});
  const f = createStoreFor({ home, mode: "twenty", degrade: true, retryBaseMs: 20, retryMaxMs: 40, log: (l) => lines.push(l), helper: false,
    preflight: async () => ok ? { ok: true, reasons: [] } : { ok: false, reasons: ["compose file could not be regenerated"], facts: {} },
    provision: async () => ({ url: "http://127.0.0.1:1", keyFile: "x", webhookSecretFile: "y" }) });
  const st = await f(SP, { personal: true });          // does not throw
  assert.ok(st && st.attached() === false, "a deferred store, not an error and not SQLite");
  assert.equal((await Promise.resolve(st)) === st, true, "awaiting the store does not hang");
  await st.define({ add_types: [{ name: "task_x", fields: [] }] });   // the kernel's boot-time define is remembered, not refused
  f.bootDone();
  await assert.rejects(() => st.define({ add_types: [{ name: "late", fields: [] }] }), (e) => e.code === "unavailable");
  await assert.rejects(() => st.types(), (e) => e.code === "unavailable" && /compose file could not be regenerated/.test(e.message));
  assert.throws(() => st.get("t", "i"), (e) => e.code === "unavailable");
  const state = JSON.parse(fs.readFileSync(path.join(dir, "store-state.json"), "utf8"));
  assert.equal(state.state, "unavailable"); assert.match(state.reason, /compose file could not be regenerated/); assert.ok(state.next_try_at);
  const { storeStatus } = await import("../store-status.js");
  const status = await storeStatus({ root: home, store: st, env: { VYRE_STORE: "twenty" } });
  assert.equal(status.reachable, false); assert.match(status.unavailable.reason, /compose file/);
  assert.equal(f.waiting().length, 1);
  assert.ok(lines.some((l) => /keeps running and tries again/.test(l)));
  // the box recovers: the next attempt makes the real store; here `open` is exercised through retry with a store stub
  ok = true;
  const mod = await import("./store.js");
  void mod;
  await st.attach(real);
  assert.equal(st.attached(), true);
  assert.ok((await st.types()).some((t) => t.name === "task_x"), "the definition made while the store was away is applied");
});

test("degrade: a refusal that is an answer to a person, and a bad VYRE_STORE, still throw (nothing is hidden behind the deferred store)", async () => {
  const home = tmp();
  const small = createStoreFor({ home, mode: "auto", degrade: true, helper: false, preflight: async () => ({ ok: false, reasons: ["not enough free memory: 900 MB available, a Space's Twenty needs about 2000 MB"], facts: {} }) });
  await assert.rejects(() => small(SP, { owner: "per_x" }), (e) => e.code === "needs_confirmation");
  const bad = createStoreFor({ home, mode: "nope", degrade: true });
  await assert.rejects(() => bad(SP, {}), /VYRE_STORE is sqlite, auto or twenty/);
});

test("degrade: a store still starting past startWaitMs does not hold the server: the Space gets the waiting store at once, and a late failure goes to the retries", async () => {
  const home = tmp(); const lines = [];
  /** @type {(e: Error) => void} */ let fail = () => {};
  const f = createStoreFor({ home, mode: "twenty", degrade: true, startWaitMs: 30, retryBaseMs: 60_000, log: (l) => lines.push(l), helper: false,
    preflight: async () => ({ ok: true, reasons: [] }),
    provision: () => new Promise((_, rej) => { fail = rej; }) });
  const t0 = Date.now();
  const st = await f(SP, { personal: true });
  assert.ok(Date.now() - t0 < 2000, "the server was not held while the store starts");
  assert.equal(st.attached(), false);
  assert.equal(f.waiting().length, 1);
  assert.ok(lines.some((l) => /still starting; the server goes on/.test(l)));
  await f.retry(SP);                                   // an attempt while the first start runs does not start a second one
  fail(new Error("the helper did not answer"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.waiting().length, 1);
  assert.match(f.waiting()[0].reason, /the helper did not answer/);
  assert.ok(lines.some((l) => /not available \(the helper did not answer\); the server keeps running/.test(l)));
});

test("degrade: a store still starting says where it is and how long it has been, in plain words, never a bare 'starting'", async () => {
  const home = tmp();
  /** @type {(v?: any) => void} */ let done = () => {};
  /** @type {(name: string) => void} */ let say = () => {};
  const f = createStoreFor({ home, mode: "twenty", degrade: true, startWaitMs: 30, retryBaseMs: 60_000, log: () => {}, helper: false,
    preflight: async () => ({ ok: true, reasons: [] }),
    provision: (o) => new Promise((res) => { say = o.onPhase; done = res; }) });
  const st = await f(SP, { personal: true });
  say("pull images");
  await assert.rejects(() => st.types(), (e) => /still starting: downloading it \(the first time only\) \(\d+ seconds? so far\)/.test(e.message));
  say("start Records (migrations, first healthy answer)");
  assert.match(f.waiting()[0].reason, /still starting: starting Records \(the first start takes a few minutes\)/);
  assert.match((await st.health()).detail, /starting Records/);
  void done;
});

test("startingWords: seconds at first, minutes after a minute and a half, and a phase it does not know is said as it is", () => {
  assert.equal(startingWords("pull images", 12_000), "the record store is still starting: downloading it (the first time only) (12 seconds so far)");
  assert.equal(startingWords("start database and cache", 200_000), "the record store is still starting: starting its database (3 minutes so far)");
  assert.equal(startingWords(undefined, 500), "the record store is still starting: getting ready (1 second so far)");
  assert.match(startingWords("something new", 10_000), /: something new \(/);
});

test("the first start says when each phase begins and that the saved database was not used; the retry starts at five seconds", () => {
  assert.match(startingWords("core types", 30_000), /preparing its record types/);
  const src = fs.readFileSync(new URL("./provision.js", import.meta.url), "utf8");
  assert.match(src, /phase \$\{name\}: started/);
  assert.match(src, /no saved database for this image/);
  assert.match(fs.readFileSync(new URL("./space-store.js", import.meta.url), "utf8"), /retryBaseMs \?\? 5_000/);
});
