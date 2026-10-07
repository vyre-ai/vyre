// @ts-check
// A first-party module may delete a vault item it made itself, with no presence proof (the person's own action, a
// person-only tool of that module, is the proof). Origin is set by vyred at put, so the module can never delete a person's
// item or another module's, and an added module never deletes anything. Boots a vyred in a temp home.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";

const MODULE = name => `export default { async start(ctx) {
  ctx.tool("${name}.put", { input: { type: "object", properties: { name: { type: "string" } } },
    run: async ({ name }) => { const r = await ctx.call("vault.put", { name, value: "tok-" + name }); return { error: r.error && r.error.code }; } });
  ctx.tool("${name}.del", { input: { type: "object", properties: { name: { type: "string" } } },
    run: async ({ name }) => { const r = await ctx.call("vault.delete", { name }); return { ok: Boolean(r.data), error: r.error && r.error.code, message: r.error && r.error.message }; } });
  return { async stop() {} };
} };`;

test("a first-party module deletes its own item without presence, and nothing else", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const first = path.join(root, "modules");
  for (const n of ["ghub", "other"]) writeModule(first, n, { does: { tools: [`${n}.put`, `${n}.del`] } }, MODULE(n));
  const d = await start({ presence: present, root, firstPartyRoots: [first], log: () => {} });
  t.after(() => d.stop());
  const as = (tool, input = {}, caller = "local") => d.registry.call(tool, input, caller);
  const has = async name => Boolean((await as("vault.list")).data.items.find(i => i.name === name));

  assert.equal((await as("vault.put", { name: "persons-key", value: "p" })).error, undefined);
  const g = await as("ghub.put", { name: "gh-token" }), o = await as("other.put", { name: "other-token" });
  assert.deepEqual([g.error, g.data && g.data.error, o.error, o.data && o.data.error], [undefined, undefined, undefined, undefined], JSON.stringify({ g, o, status: d.registry.status().map(m => [m.name, m.state, m.error]) }));
  for (const n of ["persons-key", "gh-token", "other-token"]) assert.ok(await has(n), `${n} exists`);

  // Refusals first: a person's item, another module's item, an item that is not there, an added module.
  const mine = (await as("ghub.del", { name: "persons-key" })).data;
  assert.equal(mine.ok, false); assert.match(mine.message, /not made by ghub/);
  const theirs = (await as("ghub.del", { name: "other-token" })).data;
  assert.equal(theirs.ok, false); assert.match(theirs.message, /not made by ghub/);
  const gone = (await as("ghub.del", { name: "no-such-item" })).data;
  assert.equal(gone.ok, false); assert.match(gone.message, /no item named/);
  assert.ok(await has("persons-key") && await has("other-token") && await has("gh-token"), "nothing was deleted by a refusal");

  // Positive control: its own item goes, with no presence proof, and its grants and audit are the vault's own.
  const own = (await as("ghub.del", { name: "gh-token" })).data;
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(await has("gh-token"), false);
  assert.ok(await has("persons-key") && await has("other-token"));
  // A model still cannot delete anything, and the person's own surface still can.
  assert.equal((await d.registry.call("vault.delete", { name: "persons-key" }, "mcp", { thread: "t-1" })).error.code, "denied");
  assert.equal((await as("vault.delete", { name: "persons-key" })).data.deleted, "persons-key");
});

// With the kernel on, an ADDED module runs in the sandbox supervisor with `export const handlers` and no ctx at all (kernel/modules/child.js), so it has no way to call vault.delete: the refusal is structural.
// Without the kernel it is the legacy in-process module and the registry's not_declared. Both assert that the item stays.
const KERNEL_ON = process.env.VYRE_KERNEL !== "0"; // the kernel is on by default (a development build)
const SANDBOXED = `export const handlers = { "bakery.put": async () => ({ ctx: typeof ctx }), "bakery.del": async () => ({ ctx: typeof ctx }) };`;
test("an added module that lists vault.delete in needs.tools is refused it, and the item stays", { skip: KERNEL_ON && process.platform !== "linux" ? "the added-module sandbox needs bwrap (linux)" : false, timeout: 90_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  writeModule(path.join(root, "modules"), "bakery", { vyre: "1", description: "A bakery.", does: { tools: [{ name: "bakery.put", reach: "anyone" }, { name: "bakery.del", reach: "anyone" }] }, needs: { tools: ["vault.delete", "vault.list"] } }, KERNEL_ON ? SANDBOXED : MODULE("bakery"));
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  assert.equal((await d.registry.call("vault.put", { name: "persons-key", value: "p" }, "local")).error, undefined);
  const added = (await d.registry.call("bakery.del", { name: "persons-key" }, "local")).data;
  if (KERNEL_ON) {
    assert.equal(d.registry.status().find(m => m.name === "bakery")?.state, "running", "the added module runs in the sandbox");
    assert.equal(added.ctx, "undefined", `the sandbox gives an added module no ctx, so it has no vault tool to call: ${JSON.stringify(added)}`);
  } else { assert.equal(added.ok, false); assert.equal(added.error, "not_declared", JSON.stringify(added)); }
  assert.ok((await d.registry.call("vault.list", {}, "local")).data.items.some(i => i.name === "persons-key"));
});
