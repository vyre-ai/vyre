// @ts-check
// Providers against a fake vyred client: both manifest shapes, order, # suffixes, input merge,
// per-provider timeouts, and errors and `said` passed through as they are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Providers, parseShows, scoreRow } from "./providers.js";

const VAULT = {
  "results:vault.search": { title: "Vault" },
  "action:vault.fill.native": { title: "Fill in the front app" },
  "action:vault.copy": { title: "Copy the password or key" },
  "action:vault.copy#username": { title: "Copy username", input: { field: "username" } },
  "action:vault.copy#totp": { title: "Copy one-time code", input: { field: "totp" } },
  "action:vault.totp": { title: "Show the one-time code" },
  "action:vault.lock": { title: "Lock the vault" },
};

/**
 * A fake client. `tools` answers each tool call; `modules` is the listing; `callable` is what
 * GET /v1/tools says (undefined: the route errs).
 * @param {{ modules: any[], callable?: string[], tools?: Record<string, (input: any, opts: any) => any> }} o
 */
function fakeClient({ modules, callable, tools = {} }) {
  /** @type {{ tool: string, input: any, opts: any }[]} */
  const calls = [];
  return {
    calls,
    get: async route => route === "/v1/modules" ? { data: modules }
      : route === "/v1/tools" && callable ? { data: callable.map(name => ({ name })) } : { error: { code: "not_found", message: "no" } },
    call: async (tool, input, opts) => {
      calls.push({ tool, input, opts });
      const f = tools[tool];
      return f ? f(input, opts) : { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("providers: an ordered object keeps its order, titles, # suffixes and inputs", () => {
  const s = parseShows("vault", VAULT);
  assert.deepEqual(s.results, [{ tool: "vault.search", title: "Vault", input: {} }]);
  assert.deepEqual(s.actions.map(a => [a.key, a.tool, a.title]), [
    ["action:vault.fill.native", "vault.fill.native", "Fill in the front app"],
    ["action:vault.copy", "vault.copy", "Copy the password or key"],
    ["action:vault.copy#username", "vault.copy", "Copy username"],
    ["action:vault.copy#totp", "vault.copy", "Copy one-time code"],
    ["action:vault.totp", "vault.totp", "Show the one-time code"],
    ["action:vault.lock", "vault.lock", "Lock the vault"],
  ]);
  assert.deepEqual(s.actions[2].input, { field: "username" });
});

test("providers: an array of plain strings works with made-up titles, and odd keys are skipped", () => {
  const s = parseShows("notes", ["results:notes.find", "action:notes.open", "panel:notes", 7, "action:notes.open"]);
  assert.deepEqual(s.results, [{ tool: "notes.find", title: "Notes", input: {} }]);
  assert.deepEqual(s.actions, [{ key: "action:notes.open", tool: "notes.open", title: "notes.open", input: {} }]);
  assert.deepEqual(parseShows("x", undefined), { module: "x", results: [], actions: [] });
});

test("providers: refresh keeps running modules and only what this caller may call", async () => {
  const client = fakeClient({
    modules: [
      { name: "vault", state: "running", shows: { capsule: VAULT } },
      { name: "notes", state: "running", manifest: { shows: { capsule: ["results:notes.find", "action:notes.open"] } } },
      { name: "broken", state: "failed", shows: { capsule: ["results:broken.find"] } },
      { name: "quiet", state: "running", shows: { deck: ["panel:quiet"] } },
    ],
    callable: ["vault.search", "vault.copy", "vault.totp", "notes.find", "notes.open"],
  });
  const p = new Providers({ client });
  assert.deepEqual(await p.refresh(), { ok: true, modules: 2 });
  const [v, n] = p.list();
  assert.equal(v.module, "vault");
  assert.deepEqual(v.actions.map(a => a.key), ["action:vault.copy", "action:vault.copy#username", "action:vault.copy#totp", "action:vault.totp"],
    "fill.native and lock are not on the caller's list, so they are dropped; order is kept");
  assert.equal(n.module, "notes");
  assert.equal(client.calls.length, 0, "refresh calls no tool");
});

test("providers: without a tools listing nothing is filtered; a failed listing keeps the old state", async () => {
  const modules = [{ name: "vault", state: "running", shows: { capsule: VAULT } }];
  const client = fakeClient({ modules });
  const p = new Providers({ client });
  await p.refresh();
  assert.equal(p.list()[0].actions.length, 6);
  client.get = async () => ({ error: { code: "unreachable", message: "vyred is not running" } });
  assert.deepEqual(await p.refresh(), { ok: false, error: "vyred is not running" });
  assert.equal(p.list().length, 1);
});

test("providers: search asks every provider in parallel and makes launcher rows", async () => {
  const client = fakeClient({
    modules: [
      { name: "vault", state: "running", shows: { capsule: VAULT } },
      { name: "notes", state: "running", shows: { capsule: { "results:notes.find": { title: "Notes", input: { scope: "all" } } } } },
    ],
    tools: {
      "vault.search": async () => { await sleep(40); return { data: { rows: [
        { id: "GitHub", name: "GitHub", kind: "login", sub: "login · github.com" },
        { id: "Work mail", name: "Work mail", kind: "login", sub: "login · mail.example.com" },
      ] } }; },
      // A bare array is fine too.
      "notes.find": async () => { await sleep(40); return { data: [{ id: 3, name: "Git tips", kind: "note" }] }; },
    },
  });
  const p = new Providers({ client });
  await p.refresh();
  const t0 = Date.now();
  const rows = await p.search("git", { limit: 5 });
  assert.ok(Date.now() - t0 < 75, "the two providers ran at once");
  assert.deepEqual(rows[0], { kind: "module", id: "vault:GitHub", label: "GitHub", sub: "login · github.com", module: "vault",
    provider: "Vault", rowId: "GitHub", rowKind: "login", target: "", score: rows[0].score });
  assert.equal(rows[0].score, 0.9 + 0.1, "a prefix match, plus the vault's site bump");
  assert.equal(rows[1].score, 0.5, "matched by the provider on something else: the floor");
  assert.deepEqual(rows[2], { kind: "module", id: "notes:3", label: "Git tips", sub: "Notes", module: "notes",
    provider: "Notes", rowId: "3", rowKind: "note", target: "", score: 0.9 });
  const notes = client.calls.find(c => c.tool === "notes.find");
  assert.deepEqual(notes?.input, { scope: "all", q: "git", limit: 5 });
});

test("providers: short queries go nowhere", async () => {
  const client = fakeClient({ modules: [{ name: "vault", state: "running", shows: { capsule: VAULT } }] });
  const p = new Providers({ client });
  await p.refresh();
  assert.deepEqual(await p.search("g"), []);
  assert.deepEqual(await p.search("  "), []);
  assert.equal(client.calls.length, 0);
});

test("providers: a slow or failing provider hides no one else, and each has its own timeout", async () => {
  const client = fakeClient({
    modules: [
      { name: "slow", state: "running", shows: { capsule: ["results:slow.find"] } },
      { name: "bad", state: "running", shows: { capsule: ["results:bad.find"] } },
      { name: "throws", state: "running", shows: { capsule: ["results:throws.find"] } },
      { name: "good", state: "running", shows: { capsule: ["results:good.find"] } },
    ],
    tools: {
      "slow.find": async () => { await sleep(400); return { data: { rows: [{ id: "s", name: "slow one" }] } }; },
      "bad.find": async () => ({ error: { code: "locked", message: "The vault is locked." } }),
      "throws.find": async () => { throw new Error("boom"); },
      "good.find": async () => ({ data: { rows: [{ id: "g", name: "good one" }, { name: "no id" }, null] } }),
    },
  });
  const p = new Providers({ client });
  await p.refresh();
  const t0 = Date.now();
  const rows = await p.search("one", { timeoutMs: 80 });
  assert.ok(Date.now() - t0 < 300, "the slow provider was cut off at its own timeout");
  assert.deepEqual(rows.map(r => r.id), ["good:g"]);
  assert.ok(client.calls.every(c => c.opts.timeout === 80), "each call carries the timeout too");
});

test("providers: actions for a result come from its module, in order", async () => {
  const client = fakeClient({ modules: [{ name: "vault", state: "running", shows: { capsule: VAULT } }] });
  const p = new Providers({ client });
  await p.refresh();
  const acts = p.actions({ module: "vault" });
  assert.deepEqual(acts[0], { key: "action:vault.fill.native", title: "Fill in the front app" });
  assert.deepEqual(acts.map(a => a.title).slice(2, 4), ["Copy username", "Copy one-time code"]);
  assert.deepEqual(p.actions({ module: "nope" }), []);
  assert.deepEqual(p.actions(null), []);
});

test("providers: run passes { ...input, id, front } and hands said back as is", async () => {
  const client = fakeClient({
    modules: [{ name: "vault", state: "running", shows: { capsule: VAULT } }],
    tools: {
      "vault.copy": async i => ({ data: { copied: true, clearsAt: 1, said: `Copied the ${i.field || "value"} of ${i.id} · clears in 90 s` } }),
      "vault.totp": async () => ({ data: { code: "123456", period: 30, remaining: 12 } }),
    },
  });
  const p = new Providers({ client });
  await p.refresh();
  const result = { module: "vault", rowId: "GitHub" };
  const front = { bundle: "com.example.browser", pid: 42, name: "Example" };
  const r = await p.run(result, "action:vault.copy#username", front);
  assert.deepEqual(client.calls[0].input, { field: "username", id: "GitHub", front: { bundle: "com.example.browser", pid: 42 } });
  assert.ok(client.calls[0].opts.timeout >= 30_000, "an action may wait on Touch ID");
  assert.equal(r.said, "Copied the username of GitHub · clears in 90 s");
  const t = await p.run(result, "action:vault.totp", null);
  assert.deepEqual(client.calls[1].input, { id: "GitHub" }, "no front app, no front key");
  assert.deepEqual(t, { code: "123456", period: 30, remaining: 12, data: { code: "123456", period: 30, remaining: 12 } });
});

test("providers: run passes an error through as is, and a slow action times out", async () => {
  const client = fakeClient({
    modules: [{ name: "vault", state: "running", shows: { capsule: VAULT } }],
    tools: {
      "vault.copy": async () => ({ error: { code: "presence_refused", message: "Touch ID was cancelled." } }),
      "vault.totp": async () => { await sleep(500); return { data: { code: "1" } }; },
    },
  });
  const p = new Providers({ client });
  await p.refresh();
  const result = { module: "vault", rowId: "GitHub" };
  assert.deepEqual(await p.run(result, "action:vault.copy", null), { error: "Touch ID was cancelled.", reason: "presence_refused" });
  assert.deepEqual(await p.run(result, "action:vault.lock", null), { error: "no tool vault.lock", reason: "no_such_tool" });
  assert.deepEqual(await p.run(result, "action:vault.gone", null), { error: "That action is no longer offered." });
  const slow = await p.run(result, "action:vault.totp", null, { timeoutMs: 20 });
  assert.equal(slow.reason, "timeout");
});

test("providers: the site bump is the vault's alone", () => {
  assert.equal(scoreRow("vault", "github", { name: "Work", sub: "login · github.com" }), 0.6);
  assert.equal(scoreRow("notes", "github", { name: "Work", sub: "note · github.com" }), 0.5);
  assert.equal(scoreRow("vault", "github", { name: "Work", sub: "login" }), 0.5);
});
