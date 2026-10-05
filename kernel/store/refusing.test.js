import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { createRefusingStore } from "./refusing.js";
import { bootKernel } from "../boot.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const sealer = { presenceCheck: async () => null };
const plain = /^This machine cannot run the record store \(Twenty\): no Docker\. Put your space on your server\.$/;

test("the refusing store answers every record call with one plain line and keeps nothing", async () => {
  const s = createRefusingStore("no Docker");
  assert.equal(s.refusing, true);
  assert.match(s.message, plain);
  for (const call of [() => s.types(), () => s.get("contact", "x"), () => s.query("contact", {}), () => s.create("contact", "x", {}), () => s.define({ add_types: [] }), () => s.search({}), () => s.changes(null, 10), () => s.health()]) {
    await assert.rejects(call, e => e.code === "unavailable" && plain.test(e.message));
  }
});

test("a kernel given the refusing store boots with its own parts (grants, log) and refuses every record call", async () => {
  const mk = () => new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-refuse-")), "kernel.db"));
  const k = await bootKernel({ db: mk(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer, store: createRefusingStore("no Docker") });
  const o = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await assert.rejects(() => k.gateway.records.define(o, { add_types: [CONTACT] }), e => /cannot run the record store \(Twenty\)/.test(e.message));
  assert.equal(k.grants.roleOf({ kind: "person", id: OWNER, space: SPACE }), "owner", "grants, the log and the owner still work");
  const dev = await bootKernel({ db: mk(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer });
  const od = dev.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await dev.gateway.records.define(od, { add_types: [CONTACT] });
  assert.equal((await dev.gateway.records.create(od, "contact", { name: "Jane" })).data.name, "Jane", "a device keeps its own store");
});

test("a store that is only briefly unavailable at boot gets the task record type in the background; the refusing store is skipped and never asked again", async () => {
  const mk = () => new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-retry-")), "kernel.db"));
  // A real store whose define answers "unavailable" twice (Twenty still coming up), then works.
  const { createMemoryStore } = await import("../store/memory.js");
  const inner = createMemoryStore();
  let downFor = 2, asked = 0;
  const flaky = new Proxy(inner, { get(t, k) {
    if (k === "define") return async (/** @type {any} */ d) => { asked++; if (downFor-- > 0) throw Object.assign(new Error("Twenty is starting"), { code: "unavailable" }); return t.define(d); };
    const v = /** @type {any} */ (t)[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
  const notes = /** @type {string[]} */ ([]);
  const k = await bootKernel({ db: mk(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer, store: flaky, taskRetryMs: 10, note: (/** @type {string} */ m) => notes.push(m) });
  assert.ok(k, "the kernel booted while the store was down");
  const end = Date.now() + 3000;
  while (!notes.some(n => /task record type is defined now/.test(n)) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(notes.some(n => /not available yet/.test(n)) && notes.some(n => /defined now/.test(n)), notes.join(" | "));
  assert.ok((await inner.types()).some((/** @type {any} */ t) => t.name === "task"), "the task type is defined once the store came up");
  assert.equal(asked, 3, "asked at boot and twice more, then done");
  // The refusing store: skipped, and nothing is retried.
  let refuseAsked = 0;
  const refusing = createRefusingStore("no Docker"); const was = refusing.define; refusing.define = async (/** @type {any} */ d) => { refuseAsked++; return was(d); };
  await bootKernel({ db: mk(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer, store: refusing, taskRetryMs: 10 });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(refuseAsked, 0, "a store that always refuses is not asked, now or later");
});
