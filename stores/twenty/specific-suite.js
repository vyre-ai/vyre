// @ts-check
// What only a Twenty-backed store has to prove, on top of the kernel's conformance suite: versions that
// notice an edit made inside Twenty, the change feed, the version hash, signed webhooks, sealed
// references and the ids Twenty keeps. Runs against the fake Twenty (offline) and the real one (testbox).
//
// harness: { make() -> { store, behind(type, id, kernelPatch), touch(type, id), wire?(): string, cleanup() }, waitMs? }

import crypto from "node:crypto";
import { mintUuid } from "../../kernel/core/ids.js";
import { CONTACT } from "../../kernel/conformance/suite.js";

const ref = (r = "sv_1") => ({ sealed: "ssn", ref: r, present: true, valid_format: true, set_at: 1 });

/** @param {string} label @param {{ test: any }} runner @param {{ assert: any }} deps @param {{ make: () => Promise<any>, waitMs?: number }} harness */
export function specific(label, { test }, { assert }, harness) {
  const T = (/** @type {string} */ name, /** @type {(h: any) => Promise<void>} */ fn) => test(`${label}: ${name}`, async () => { const h = await harness.make(); try { await h.store.define({ add_types: [CONTACT] }); await fn(h); } finally { await h.cleanup?.(); } });
  const until = async (/** @type {() => Promise<boolean>} */ cond, ms = harness.waitMs ?? 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  const add = (/** @type {any} */ s, /** @type {any} */ data) => s.create("contact", mintUuid(), data);
  const entries = async (/** @type {any} */ s) => (await s.changes(null, 1000)).entries;

  T("two writers holding the same version: exactly one wins, the other gets version_conflict", async ({ store }) => {
    const r = await add(store, { name: "Race", age: 1 });
    const out = await Promise.allSettled([store.update("contact", r.id, { age: 2 }, 1), store.update("contact", r.id, { age: 3 }, 1)]);
    assert.equal(out.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(/** @type {any} */ (out.find((x) => x.status === "rejected")).reason.code, "version_conflict");
    assert.equal((await store.get("contact", r.id)).version, 2);
  });

  T("an edit made inside Twenty gets the next version, in order, and a holder of the old version is refused", async ({ store, behind }) => {
    const r = await add(store, { name: "Outside", age: 10 });
    const u = await store.update("contact", r.id, { age: 11 }, 1);
    assert.equal(u.version, 2);
    await behind("contact", r.id, { age: 99 });
    const seen = await store.get("contact", r.id);
    assert.equal(seen.version, 3, "the outside edit became version 3");
    assert.equal(seen.data.age, 99);
    await assert.rejects(() => store.update("contact", r.id, { age: 12 }, 2), (/** @type {any} */ e) => e.code === "version_conflict");
    const ok = await store.update("contact", r.id, { age: 12 }, 3);
    assert.equal(ok.version, 4);
    const outside = (await entries(store)).filter((/** @type {any} */ e) => e.id === r.id && e.source === "twenty");
    assert.equal(outside.length, 1, "reported once, however it was noticed");
    assert.deepEqual([outside[0].kind, outside[0].version, outside[0].before.age, outside[0].after.age], ["updated", 3, 11, 99]);
    const all = (await entries(store)).filter((/** @type {any} */ e) => e.id === r.id).map((/** @type {any} */ e) => [e.kind, e.version]);
    assert.deepEqual(all, [["created", 1], ["updated", 2], ["updated", 3], ["updated", 4]], "own writes and the outside one, one history, no gaps");
  });

  T("the webhook finds an outside edit even if nobody reads the record", async ({ store, behind }) => {
    const r = await add(store, { name: "Quiet", age: 1 });
    await behind("contact", r.id, { age: 2 });
    assert.ok(await until(async () => (await entries(store)).some((/** @type {any} */ e) => e.id === r.id && e.source === "twenty")), "the change arrives through the signed webhook");
    const e = (await entries(store)).find((/** @type {any} */ x) => x.id === r.id && x.source === "twenty");
    assert.equal(e.version, 2);
    assert.equal(e.before.age, 1, "before comes from our snapshot");
    assert.equal(e.after.age, 2);
    assert.equal((await store.get("contact", r.id)).version, 2);
    assert.equal((await entries(store)).filter((/** @type {any} */ x) => x.id === r.id).length, 2, "no duplicate from the read that followed");
  });

  T("our own writes do not come back as outside changes", async ({ store }) => {
    const r = await add(store, { name: "Mine", age: 1 });
    await store.update("contact", r.id, { age: 2 }, 1);
    await store.remove("contact", r.id, 2);
    await store.restore("contact", r.id);
    await new Promise((res) => setTimeout(res, 700));
    const all = (await entries(store)).filter((/** @type {any} */ e) => e.id === r.id);
    assert.deepEqual(all.map((/** @type {any} */ e) => e.kind), ["created", "updated", "removed", "restored"]);
    assert.ok(all.every((/** @type {any} */ e) => e.source === "gateway"));
  });

  T("the version hash covers declared fields only, and a behind edit is detected", async ({ store, behind, touch }) => {
    const r = await add(store, { name: "Hash", age: 4 });
    const h0 = store.recordHash(r);
    assert.match(h0, /^sha256:/);
    assert.deepEqual(await store.verify("contact", r.id, h0), { ok: true, actual: h0 });
    await touch("contact", r.id);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(store.recordHash(await store.get("contact", r.id)), h0, "a column the language does not declare does not change the hash");
    assert.equal((await store.verify("contact", r.id, h0)).ok, true);
    await behind("contact", r.id, { age: 5 });
    const v = await store.verify("contact", r.id, h0);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "modified_outside");
    assert.equal((await store.verify("contact", mintUuid(), h0)).reason, "missing");
  });

  T("a sealed field holds a reference, never a value, and nothing else reaches Twenty", async ({ store, wire }) => {
    await assert.rejects(() => add(store, { name: "Leak", ssn: "123-45-6789" }), (/** @type {any} */ e) => e.code === "sealed_value_refused");
    await assert.rejects(() => add(store, { name: "Leak", ssn: { ...ref(), value: "123-45-6789" } }), (/** @type {any} */ e) => e.code === "sealed_value_refused");
    const r = await add(store, { name: "Ref", ssn: ref("sv_9") });
    assert.deepEqual((await store.get("contact", r.id)).data.ssn, ref("sv_9"));
    if (wire) assert.ok(!wire().includes("123-45-6789"), "the number never went over the wire");
    for await (const c of store.export()) assert.ok(!JSON.stringify(c).includes("123-45-6789"));
  });

  T("the id the gateway mints is the id Twenty keeps; a UUID Twenty would refuse is refused first", async ({ store }) => {
    const id = mintUuid();
    const r = await store.create("contact", id, { name: "Id" });
    assert.equal(r.id, id);
    await assert.rejects(() => store.create("contact", "01a101b0-a370-7000-b5d3-0f0df5924247", { name: "v7" }), (/** @type {any} */ e) => e.code === "invalid");
  });

  T("a webhook with a bad signature, a stale timestamp or a replayed nonce is not a change", async ({ store }) => {
    const r = await add(store, { name: "Hook", age: 1 });
    const before = (await entries(store)).length;
    const body = JSON.stringify({ eventName: "contact.updated", objectMetadata: { nameSingular: "contact" }, record: { id: r.id, updatedAt: new Date(Date.now() + 5000).toISOString(), name: "Forged" }, updatedFields: ["name"] });
    const sign = (/** @type {string} */ ts, secret = "wrong") => crypto.createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
    const now = String(Date.now());
    assert.equal((await store.handleWebhook({ "x-twenty-webhook-timestamp": now, "x-twenty-webhook-signature": sign(now) }, body)).status, 401);
    const old = String(Date.now() - 3_600_000);
    assert.equal((await store.handleWebhook({ "x-twenty-webhook-timestamp": old, "x-twenty-webhook-signature": sign(old, store.secret) }, body)).status, 401);
    assert.equal((await store.handleWebhook({}, "not json")).status, 400);
    assert.equal((await entries(store)).length, before);
    assert.ok(store.rejected >= 2);
  });

  T("aggregate and search never read a sealed field, and the type list survives define", async ({ store }) => {
    await add(store, { name: "Jane Harlow", ssn: ref("sv_1") });
    await assert.rejects(() => store.aggregate("contact", { group_by: ["ssn"], measures: [{ fn: "count" }] }), (/** @type {any} */ e) => e.code === "invalid");
    await assert.rejects(() => store.query("contact", { filter: { field: "ssn", op: "is_null" }, page: { limit: 5 } }), (/** @type {any} */ e) => e.code === "invalid");
    assert.equal((await store.search({ text: "sv_1", page: { limit: 5 } })).rows.length, 0);
  });
}
