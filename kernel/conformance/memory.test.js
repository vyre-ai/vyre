import test from "node:test";
import assert from "node:assert/strict";
import { conformance } from "./suite.js";
import { createMemoryStore } from "../store/memory.js";

conformance(async () => createMemoryStore(), { test, assert }, "memory");

// The suite has teeth: stores that break one rule each are caught.
async function failures(make) {
  const cases = [];
  conformance(make, { test: (name, fn) => cases.push([name, fn]), assert }, "broken");
  const out = [];
  for (const [name, fn] of cases) { try { await fn(); } catch { out.push(name); } }
  return out;
}
const broken = {
  "a store that does not keep our id": s => ({ ...s, create: (t, id, d) => s.create(t, id, d).then(r => ({ ...r, id: id.replace(/.$/, id.endsWith("0") ? "1" : "0") })) }),
  "a store that ignores the version": s => ({ ...s, update: (t, id, p, v) => s.get(t, id).then(r => s.update(t, id, p, r ? r.version : v)) }),
  "a store that stores a sealed value": s => ({ ...s, create: (t, id, d) => s.create(t, id, { ...d, ssn: d.ssn && typeof d.ssn === "string" ? { sealed: "ssn", ref: d.ssn, present: true, valid_format: true, set_at: 1 } : d.ssn }) }),
  "a store that hands out its own objects": s => { const inner = new Map(); return { ...s, get: async (t, id, o) => { const r = await s.get(t, id, o); if (!r) return r; const k = t + id; if (!inner.has(k)) inner.set(k, r); return inner.get(k); } }; },
  "a store with offset paging that repeats rows": s => ({ ...s, query: async (t, spec) => { const p = await s.query(t, { ...spec, page: { limit: spec.page.limit } }); return p.rows.length ? { ...p, next_cursor: p.next_cursor && "AAAA" } : p; } }),
};
for (const [name, wrap] of Object.entries(broken)) {
  test(`conformance has teeth: ${name} fails the suite`, async () => {
    const lost = await failures(async () => wrap(createMemoryStore()));
    assert.ok(lost.length > 0, "the suite passed a broken store");
  });
}
