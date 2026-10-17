// @ts-check
// The Connect apps screen's calls on a fake box: the tool each act reaches, the input it carries, and what it must not call. A wrong adapter (a renamed tool, a level sent in the library's words, a
// disconnect that touches sharing) fails here.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { shareChanges, appsOf, extraApps, itemOfConnection } from "./connect-apps-model.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
/** @param {Record<string, any>} [data] */
function box(data = {}) {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return { data: data[tool] ?? {} }; };
  return { call, seen };
}

test("the one-click rows come from mcp.catalog entries and nothing else", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box({ "mcp.catalog": { entries: [{ preset: "acme", name: "Acme", oneClick: true }] } });
  const e = await connectionsSource(b.call).oneClickEntries();
  assert.deepEqual(b.seen.map((s) => s.tool), ["mcp.catalog"]);
  assert.deepEqual(extraApps(e, []).map((r) => r.id), ["acme"]);
  assert.deepEqual(extraApps(await connectionsSource(box({ "mcp.catalog": { entries: "no" } }).call).oneClickEntries(), []), []);
});

test("Add reaches connectors.connect with the preset id; Disconnect reaches connectors.disconnect and never vault.access.set", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box({ "connectors.connect": { step: "connected" } });
  const s = connectionsSource(b.call);
  await s.connect("linear", "Linear");
  await s.disconnect("linear");
  assert.deepEqual(b.seen.map((x) => x.tool), ["connectors.connect", "connectors.disconnect"]);
  assert.equal(b.seen[0].input.preset, "linear");
  assert.equal(b.seen[1].input.name, "linear");
  assert.ok(!b.seen.some((x) => x.tool === "vault.access.set"), "deleting the connection's item ends its sharing in the vault; the screen does not unshare one by one");
});

test("a share change reaches vault.access.set with the kernel's level on the connection's own item", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box();
  const s = connectionsSource(b.call);
  const item = itemOfConnection({ name: "github" });
  for (const input of shareChanges(item, [], [{ who: "Alex", level: "read" }], [{ who: "Alex", subject: "p1", kind: "person" }])) await s.shareSet(input);
  await s.shareGet(item);
  await s.agentList();
  assert.deepEqual(b.seen, [
    { tool: "vault.access.set", input: { name: "github-auth", kind: "person", subject: "p1", level: "reveal" } },
    { tool: "vault.access.get", input: { name: "github-auth" } },
    { tool: "agents.list", input: {} },
  ]);
});

test("a member's share reaches vault.me.connection.share on the connection's own name, never the owner's vault.access.set", { skip: !strip }, async () => {
  const { connectionsSource } = await import("./source.ts");
  const b = box();
  const s = connectionsSource(b.call);
  for (const input of shareChanges("github", [], [{ who: "kit", level: "fill" }], [{ who: "kit", subject: "kit", kind: "agent" }])) await s.memberShareSet(input);
  await s.memberShareGet("github");
  assert.deepEqual(b.seen, [
    { tool: "vault.me.connection.share", input: { name: "github", kind: "agent", subject: "kit", level: "use" } },
    { tool: "vault.me.connection.shares", input: { name: "github" } },
  ]);
});

test("a connected row carries its connection name so Share and Disconnect act on it", () => {
  const a = appsOf([{ group: "work", presets: [{ id: "github", label: "GitHub", group: "work", who: "", note: "", setup: "token", via: "", connected: [{ name: "github-2" }] }] }]);
  assert.equal(a[0].connection, "github-2");
  assert.equal(itemOfConnection({ name: a[0].connection }), "github-2-auth");
});
