// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { memberServers, memberMcpConfig } from "./member-mcp.js";
import { mergeMcpServers } from "./merge-mcp.js";

/** A fake personalStore(person, space): async get/put/list/remove of JSON under a key, one map per person. */
function fakeStore() {
  const maps = new Map();
  const locked = new Set();
  const f = (person) => {
    if (!maps.has(person)) maps.set(person, new Map());
    const m = maps.get(person);
    const gate = () => { if (locked.has(person)) throw Object.assign(new Error("locked"), { code: "locked" }); };
    return {
      get: async k => { gate(); return m.has(k) ? structuredClone(m.get(k)) : null; },
      put: async (k, v) => { gate(); m.set(k, structuredClone(v)); },
      list: async () => { gate(); return [...m].map(([key, value]) => ({ key, value: structuredClone(value) })); },
      remove: async k => { gate(); return m.delete(k); },
    };
  };
  f.lock = p => locked.add(p);
  return f;
}
const srv = { type: "http", url: "https://gmailmcp.googleapis.com/mcp/v1", headers: { authorization: "Bearer T" } };

test("a member's servers round-trip through their personal store under mcp/<name>", async () => {
  const ps = fakeStore(), s = memberServers(ps("alice"));
  await s.put("gmail", srv);
  assert.deepEqual((await s.list()).map(x => x.name), ["gmail"]);
  assert.equal((await s.get("gmail")).url, srv.url);
  assert.deepEqual((await ps("alice").list()).map(x => x.key), ["mcp/gmail"]);
  assert.equal(await s.remove("gmail"), true);
  assert.equal(await s.remove("gmail"), false);
});

test("another person's store is separate; other keys in the store are not servers", async () => {
  const ps = fakeStore();
  await memberServers(ps("alice")).put("gmail", srv);
  await ps("alice").put("mail/other", { x: 1 });
  assert.deepEqual(await memberServers(ps("bob")).list(), []);
  assert.deepEqual((await memberServers(ps("alice")).list()).map(x => x.name), ["gmail"]);
});

test("only remote https servers are accepted; vyre is reserved; bad names refused", async () => {
  const s = memberServers(fakeStore()("alice"));
  await assert.rejects(s.put("a", { type: "stdio", command: "sh", args: ["-c", "x"] }), /remote/);
  await assert.rejects(s.put("a", { type: "http", url: "http://x.example/mcp" }), /https/);
  await assert.rejects(s.put("a", { type: "http", url: "https://127.0.0.1/mcp" }), /https/);
  await assert.rejects(s.put("vyre", srv), /reserved/);
  await assert.rejects(s.put("../a", srv), /name/);
});

test("locked store: config is empty, not an error, so the session still starts", async () => {
  const ps = fakeStore();
  await memberServers(ps("alice")).put("gmail", srv);
  ps.lock("alice");
  assert.deepEqual(await memberMcpConfig(ps("alice")), { mcpServers: {} });
});

test("memberMcpConfig builds mcpServers; a hostile stored entry is dropped; Vyre's entry wins a clash", async () => {
  const ps = fakeStore(), raw = ps("alice");
  await memberServers(raw).put("gmail", srv);
  await raw.put("mcp/evil", { type: "stdio", command: "sh" });   // written around the adapter
  await raw.put("mcp/vyre", srv);
  const cfg = await memberMcpConfig(raw);
  assert.deepEqual(Object.keys(cfg.mcpServers), ["gmail"]);
  assert.deepEqual(mergeMcpServers({ vyre: { command: "node" } }, { mcpServers: { vyre: { command: "evil" }, g: { url: "u" } } }), { g: { url: "u" }, vyre: { command: "node" } });
});

import { storeOverCalls } from "./member-mcp.js";
test("storeOverCalls speaks vault.me.store.* and turns an error into a throw (a locked vault is no servers)", async () => {
  const seen = [];
  const mem = new Map();
  const call = async (tool, i) => {
    seen.push(tool);
    if (tool === "vault.me.store.put") { mem.set(i.key, i.value); return { data: { key: i.key, stored: true } }; }
    if (tool === "vault.me.store.get") return { data: mem.get(i.key) ?? null };
    if (tool === "vault.me.store.list") return { data: [...mem].map(([key, value]) => ({ key, value })) };
    if (tool === "vault.me.store.remove") return { data: { removed: mem.delete(i.key) } };
  };
  const s = memberServers(storeOverCalls(call));
  await s.put("gmail", srv);
  assert.deepEqual((await s.list()).map(x => x.name), ["gmail"]);
  assert.equal(await s.remove("gmail"), true);
  assert.ok(seen.every(t => t.startsWith("vault.me.store.")));
  const locked = storeOverCalls(async () => ({ error: { message: "locked", code: "locked" } }));
  assert.deepEqual(await memberMcpConfig(locked), { mcpServers: {} });
  await assert.rejects(memberServers(locked).put("a", srv), /locked/);
});
