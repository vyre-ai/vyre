// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SWEEP, startPhotoSweep, sweepPhotos } from "./photo-sweep.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ago = (/** @type {number} */ ms) => new Date(NOW - ms).toISOString();
/** a kernel handle over rows in memory, paging two at a time, that can refuse a remove */
function fake(/** @type {Record<string, any[]>} */ rows, /** @type {Set<string>} */ refuse = new Set()) {
  const removed = /** @type {string[]} */ ([]);
  return {
    removed,
    serviceChain: () => ({ hops: [{ actor: { kind: "service", id: "records" } }] }),
    records: {
      query: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ o) => {
        const all = rows[type] || [], at = Number(o.page.cursor || 0);
        return { rows: all.slice(at, at + 2), ...(at + 2 < all.length ? { next_cursor: String(at + 2) } : {}) };
      },
      remove: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id) => { assert.equal(type, "member-photo"); if (refuse.has(id)) throw Object.assign(new Error("store away"), { code: "unavailable" }); removed.push(id); },
    },
  };
}

test("the sweep removes every photo no profile names, across pages, and keeps the named ones and a photo made in the last hour", async () => {
  const k = fake({
    "member-profile": [{ id: "p1", data: { photo: "a" } }, { id: "p2", data: { photo: "" } }, { id: "p3", data: {} }, { id: "p4", data: { photo: "c" } }],
    "member-photo": [{ id: "a", version: 1, created_at: ago(5 * 3_600_000) }, { id: "b", version: 2, created_at: ago(5 * 3_600_000) }, { id: "c", version: 1, created_at: ago(9e6) }, { id: "d", version: 1, created_at: ago(60_000) }, { id: "e", version: 3, updated_at: ago(2 * 3_600_000) }],
  });
  const r = await sweepPhotos(k, { now: NOW });
  assert.deepEqual(r.removed, ["b", "e"]);
  assert.deepEqual(k.removed, ["b", "e"]);
  assert.equal(r.photos, 5);
  assert.deepEqual(r.failed, []);
  assert.equal(SWEEP.graceMs, 3_600_000);
});

test("a photo that cannot be removed is said, and the rest still go", async () => {
  const k = fake({ "member-profile": [], "member-photo": [{ id: "x", version: 1, created_at: ago(9e6) }, { id: "y", version: 1, created_at: ago(9e6) }] }, new Set(["x"]));
  const r = await sweepPhotos(k, { now: NOW });
  assert.deepEqual(r.removed, ["y"]);
  assert.deepEqual(r.failed, [{ id: "x", why: "store away" }]);
});

test("on a timer: never two sweeps at once, a failure is logged in words, and stop ends it", async () => {
  const lines = /** @type {string[]} */ ([]);
  const k = fake({ "member-profile": [], "member-photo": [{ id: "x", version: 1, created_at: ago(9e6) }] }, new Set(["x"]));
  const s = startPhotoSweep(k, (l) => lines.push(l), { firstMs: 1e9, everyMs: 1e9 });
  const [a, b] = await Promise.all([s.run(), s.run()]);
  assert.ok(a && a.failed.length === 1);
  assert.equal(b, null, "the second waits for the next turn");
  assert.match(lines.join("\n"), /could not be removed \(store away\); the next sweep tries again/);
  s.stop();
  assert.equal(await s.run(), null);
});
