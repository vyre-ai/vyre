// @ts-check
// A first-party module may put a NEW item, or replace one it made itself; it cannot put over a person's item or another module's. Pinned for
// module:sessions and its ai-key-* items (0.2.2 #20), in a real vyred: the refusal says "was not made by sessions", and the person's item,
// its grants and its value are unchanged afterwards. Origin is stamped by vyred from the caller, never taken from the input.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { open } from "../store/index.js";
import { Vault } from "./vault.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

test("module:sessions cannot put over a person's ai-key item or another module's, and nothing changes; its own it may replace", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  const reg = (tool, input = {}, caller = "cli") => d.registry.call(tool, input, caller);
  const mine = fake("person"), theirs = fake("threads"), planted = fake("planted");

  assert.equal((await reg("vault.put", { name: "ai-key-openai-1", kind: "api-key", value: mine })).error, undefined);
  assert.equal((await reg("vault.grant", { name: "ai-key-openai-1", module: "threads" })).error, undefined);
  assert.equal((await reg("vault.put", { name: "ai-key-openai-2", kind: "api-key", value: theirs }, "module:threads")).error, undefined);
  const grantsBefore = JSON.stringify((await reg("vault.list")).data.items.find(i => i.name === "ai-key-openai-1").grants);

  for (const name of ["ai-key-openai-1", "ai-key-openai-2"]) {
    const r = await reg("vault.put", { name, kind: "api-key", value: planted, origin: "module:sessions" }, "module:sessions");
    assert.match(r.error && r.error.message, /was not made by sessions/, `${name}: ${JSON.stringify(r)}`);
  }
  // Unchanged: the person's item keeps its value and grants, the other module's keeps its value (read through a second Vault over the same home).
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const v = new Vault({ db, dir: path.join(root, "vault"), config: { name: "test-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  assert.equal((await v.fields(v.row("ai-key-openai-1"))).value, mine);
  assert.equal((await v.fields(v.row("ai-key-openai-2"))).value, theirs);
  assert.equal(JSON.stringify((await reg("vault.list")).data.items.find(i => i.name === "ai-key-openai-1").grants), grantsBefore, "the grants did not move");
  assert.equal(v.row("ai-key-openai-1").origin ?? null, null, "the person's item still has no module origin");

  // Positive control: a new name goes in, and sessions may replace what it made.
  assert.equal((await reg("vault.put", { name: "ai-key-openai-3", kind: "api-key", value: fake("a") }, "module:sessions")).error, undefined);
  const next = fake("b");
  assert.equal((await reg("vault.put", { name: "ai-key-openai-3", kind: "api-key", value: next }, "module:sessions")).error, undefined);
  assert.equal((await v.fields(v.row("ai-key-openai-3"))).value, next);
  assert.equal(v.row("ai-key-openai-3").origin, "module:sessions", "vyred stamped the origin from the caller");
});
