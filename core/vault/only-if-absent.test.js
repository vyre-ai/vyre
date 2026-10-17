// @ts-check
// vault.put's onlyIfAbsent, through the real registry and a real Vault: it is the one thing that stops a module's "make it if it is not there" from replacing an owner's item. Modules only, plain names only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

const NAME = "vyre-shared-computer-member-key";

async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", vault: { keystore: "file" } }));
  const d = await start({ presence: present, root, log: () => {} });
  const call = (tool, input, caller, opts) => d.registry.call(tool, input, caller, opts);
  const item = async name => (await call("vault.list", {}, "cli")).data.items.find(i => i.name === name);
  const puts = async name => (await call("vault.audit", { name }, "cli")).data.entries.filter(e => e.action === "put" && e.ok).length;
  const read = name => call("vault.release", { name }, "module:computers", { door: true });
  return { call, item, puts, read };
}

test("onlyIfAbsent from a module: absent -> created with its grant and readable by that module; present -> { existed: true } and nothing changes", async t => {
  const w = await boot(t);
  const made = await w.call("vault.put", { name: NAME, kind: "secret", value: "first-value-0123456789", grants: ["computers"], onlyIfAbsent: true }, "module:computers");
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.notEqual(made.data && made.data.existed, true);
  assert.equal((await w.read(NAME)).data.value, "first-value-0123456789");
  const before = { item: await w.item(NAME), puts: await w.puts(NAME) };
  const again = await w.call("vault.put", { name: NAME, kind: "secret", value: "second-value-0123456789", grants: ["computers", "other"], onlyIfAbsent: true }, "module:computers");
  assert.deepEqual(again.data, { existed: true });
  assert.equal((await w.read(NAME)).data.value, "first-value-0123456789", "the value is unchanged");
  assert.deepEqual(await w.item(NAME), before.item, "grants and details are unchanged");
  assert.equal(await w.puts(NAME), before.puts, "and no write was audited");
});

test("an owner's item the module has no grant on is left alone, value, grants and audit", async t => {
  const w = await boot(t);
  assert.ok(!(await w.call("vault.put", { name: NAME, kind: "secret", value: "owners-own-value-1234" }, "cli")).error);
  const before = { item: await w.item(NAME), puts: await w.puts(NAME) };
  assert.ok((await w.read(NAME)).error, "the module cannot read it: no grant");
  const r = await w.call("vault.put", { name: NAME, kind: "secret", value: "module-value-0123456789", grants: ["computers"], onlyIfAbsent: true }, "module:computers");
  assert.deepEqual(r.data, { existed: true });
  assert.deepEqual(await w.item(NAME), before.item);
  assert.equal(await w.puts(NAME), before.puts);
  assert.ok((await w.read(NAME)).error, "and it still has no grant");
});

test("the flag is for modules and plain names: a person's put goes through as always, and a name with a slash is not short-circuited", async t => {
  const w = await boot(t);
  assert.ok(!(await w.call("vault.put", { name: NAME, kind: "secret", value: "owners-own-value-1234" }, "cli")).error);
  const person = await w.call("vault.put", { name: NAME, kind: "secret", value: "owners-new-value-5678", onlyIfAbsent: true }, "cli");
  assert.notDeepEqual(person.data, { existed: true }, "a person's put is not skipped by the flag");
  assert.ok(!person.error, JSON.stringify(person.error));
  const slash = await w.call("vault.put", { name: "team/some-item", kind: "secret", value: "x-value-0123456789", onlyIfAbsent: true }, "module:computers");
  assert.notDeepEqual(slash.data, { existed: true });
  assert.ok(slash.error && /module|shared|vault/i.test(String(slash.error.message)), "it goes down the normal path, which refuses a module in a shared vault");
});
