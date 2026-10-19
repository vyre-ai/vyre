// @ts-check
// spaces.publish-server-space: the server makes its space's key, this computer's identity publishes the record, the server keeps the name. In that order, with the owner's door on both server steps,
// and a refused name stops before the server keeps anything.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { registerPublishServerSpace } from "./publish-server-space.js";

function rig(o = {}) {
  /** @type {any[]} */ const log = [];
  /** @type {Map<string, Function>} */ const tools = new Map();
  registerPublishServerSpace({
    tool: (name, _d, _i, run) => { tools.set(name, run); },
    obj: (p) => p, str: "string",
    refuse: (m, c) => Object.assign(new Error(m), { code: c }),
    chosen: { onChosenServer: async (tool, i, _meta, keys, deny) => { log.push(["server", tool, Object.fromEntries(keys.filter((k) => i[k] !== undefined).map((k) => [k, i[k]])), i.server, deny]); return i.done ? { space: "spc_aaaaaaaaaaaa", existed: true } : { space: "spc_aaaaaaaaaaaa", rootPublic: "ROOT" }; } },
    names: { claimSpace: async (a) => { log.push(["claim", a]); return o.claim ? o.claim(a) : { ok: true }; } },
    listServer: async (a) => { log.push(["list", a.name, a.server]); if (o.list) return o.list(a); return undefined; },
  });
  return { run: /** @type {Function} */ (tools.get("spaces.publish-server-space")), list: /** @type {Function} */ (tools.get("spaces.server.list")), log };
}

test("it asks the server for its key, publishes the record with that key and id, then has the server keep the name", async () => {
  const { run, log } = rig();
  const r = await run({ server: "srv_1", name: "Juniper.vyre.run" }, {});
  assert.deepEqual(r, { space: "spc_aaaaaaaaaaaa", name: "juniper" });
  assert.deepEqual(log.map((l) => l[0] + ":" + (l[1] && l[1].name || l[1])), ["server:spaces.name-here", "claim:juniper", "list:juniper", "server:spaces.name-here"]);
  assert.deepEqual(log[0][2], { name: "juniper" });
  assert.equal(log[0][3], "srv_1");
  assert.deepEqual(log[1][1], { name: "juniper", rootPublic: "ROOT", record: { spaceId: "spc_aaaaaaaaaaaa", displayName: "juniper" } });
  assert.deepEqual(log[2], ["list", "juniper", "srv_1"], "the server is listed as serving the name before it keeps it");
  assert.deepEqual(log[3][2], { name: "juniper", done: true });
  assert.match(log[0][4], /owner/);
});

test("a name the directory refuses stops before the server keeps anything, and a bad name asks nothing", async () => {
  const { run, log } = rig({ claim: () => ({ ok: false, code: "taken", message: "someone else has that name" }) });
  await assert.rejects(() => run({ server: "srv_1", name: "juniper" }, {}), (e) => e.code === "taken" && /someone else/.test(e.message));
  assert.equal(log.filter((l) => l[0] === "server").length, 1, "the done step never ran");
  const fresh = rig();
  await assert.rejects(() => fresh.run({ server: "srv_1", name: "x" }, {}), (e) => e.code === "bad_name");
  assert.equal(fresh.log.length, 0);
});

test("the server is listed after the claim and before the name is kept; a listing that fails stops the server from keeping it, and spaces.server.list signs the same act on its own", async () => {
  const bad = rig({ list: async () => { throw Object.assign(new Error("the directory did not list the server"), { code: "unavailable" }); } });
  await assert.rejects(() => bad.run({ server: "srv_1", name: "juniper" }, {}), (/** @type {any} */ e) => e.code === "unavailable");
  assert.deepEqual(bad.log.map((l) => l[0] + ":" + (l[1] && l[1].name || l[1])), ["server:spaces.name-here", "claim:juniper", "list:juniper"], "nothing was kept on the server");
  const { list, log } = rig();
  assert.deepEqual(await list({ server: "srv_2", name: "Tess.vyre.run" }, {}), { name: "tess", listed: true });
  assert.deepEqual(log, [["list", "tess", "srv_2"]], "only the listing: no claim and no server call");
  await assert.rejects(() => list({ server: "srv_2", name: "x" }, {}), (/** @type {any} */ e) => e.code === "bad_name");
});
