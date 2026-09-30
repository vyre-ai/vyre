// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Routes, ROUTES_MIGRATION } from "./routes.js";

const fresh = () => { const db = new DatabaseSync(":memory:"); db.exec(ROUTES_MIGRATION); return new Routes(db, n => ["claude", "codex", "grok"].includes(n)); };

test("routes: an ordered list per scope; the agent's, then the project's, then the default applies", () => {
  const r = fresh();
  r.set({ scope: "default", entries: [{ provider: "claude" }, { provider: "codex" }] });
  r.set({ scope: "project:harlow-legal", entries: [{ provider: "claude" }, { provider: "grok" }] });
  r.set({ scope: "agent:kit", entries: [{ provider: "codex" }] });
  assert.equal(r.listFor({ agent: "kit", project: "harlow-legal" }).scope, "agent:kit");
  assert.equal(r.listFor({ agent: "juno", project: "harlow-legal" }).scope, "project:harlow-legal");
  assert.equal(r.listFor({ project: "northwind" }).scope, "default");
});

test("routes: next skips what was tried, so two limited providers never bounce a thread; the end of the list is null", () => {
  const r = fresh();
  r.set({ scope: "default", entries: [{ provider: "claude" }, { provider: "codex" }, { provider: "grok" }] });
  assert.equal(r.next({ provider: "claude" }).entry.provider, "codex");
  assert.equal(r.next({ provider: "codex", tried: ["claude:"] }).entry.provider, "grok");
  assert.equal(r.next({ provider: "grok", tried: ["claude:", "codex:"] }), null);
  assert.equal(r.next({ provider: "claude" }, e => e.provider !== "codex").entry.provider, "grok", "an unusable entry is skipped");
});

test("routes: two entries on one provider save only with an acknowledgement, and the same account twice never", () => {
  const r = fresh();
  const two = [{ provider: "codex", account: "a1" }, { provider: "codex", account: "a2" }];
  assert.throws(() => r.set({ scope: "default", entries: two }), { code: "needs_acknowledgement" });
  assert.equal(r.get("default"), null);
  assert.equal(r.set({ scope: "default", entries: two, acknowledge: true }).acknowledged, true);
  assert.throws(() => r.set({ scope: "default", entries: [{ provider: "codex", account: "a1" }, { provider: "codex", account: "a1" }], acknowledge: true }), /twice/);
  assert.throws(() => r.set({ scope: "default", entries: [{ provider: "gemini" }] }), /no session provider/);
  assert.throws(() => r.set({ scope: "everyone", entries: [] }), /scope is/);
  assert.deepEqual(r.set({ scope: "default", entries: [] }).entries, [], "an empty list clears it");
});
