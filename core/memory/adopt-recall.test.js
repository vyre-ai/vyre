// @ts-check
// A person's memory and Recall survive owner adoption (the claimed identity becomes the home's owner id). Nothing in memory or Recall is keyed by a person id, so the data stays; the one
// place an id is read is the gate's membership check, which asks the kernel who the id is NOW (`canonicalPerson`). Real daemon, kernel on, a seeded Recall index and a told fact.
// A session token minted BEFORE adoption names the old id: it must still be the owner's after.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../store/index.js";
import { start, callerFacts } from "../daemon/index.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const NEW = "per_cccccccccccccccccccccccccc";

test("seed, adopt, still recalled: told facts, Recall's index and a pre-adoption session token all still answer the owner", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ me: { domains: ["riverastudio.com"] } }));
  const db = open(path.join(root, "vyre.db")); seedRecall(db, SESSIONS); db.close();
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const old = d.kernel.id.owner;
  const cli = () => ({ kernelFacts: callerFacts("cli", {}, {}, d.kernel, false, null, { inside: false, outside: true }) });
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ meta) => d.registry.call(tool, input, "cli", meta);

  await call("recall.index", {}, cli());
  await call("memory.curate", {}, cli());
  const rem = await call("memory.remember", { text: "my wife is Jordan" }, cli()); assert.ok(!rem.error, JSON.stringify(rem.error));
  const before = (await call("memory.facts", { about: "Harlow" }, cli())).data;
  assert.equal(before.about?.label, "Harlow Legal");
  const sessionsBefore = (await call("recall.status", {}, cli())).data.sessions;
  assert.ok(sessionsBefore > 0);
  // A session token of the person, opened under the OLD owner id.
  const oldChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-old", person: old, path: "direct", session: "s" });
  const token = (await d.kernel.surfaces.open(oldChain, {})).token;
  const pre = await d.registry.call("memory.relevant", { text: "Harlow Legal", room: "unfiled" }, "deck", { token }); assert.ok(!pre.error, JSON.stringify(pre.error));

  const h = d.kernel.kernelFor({ name: "spaces", needs: { kernel: { actions: [], spaces: true } } });
  assert.equal((await h.adoptOwner(NEW)).changed, true);
  assert.equal(d.kernel.id.owner, NEW);

  // The same data, from the owner's surfaces (now built under the new id).
  const after = (await call("memory.facts", { about: "Harlow" }, cli())).data;
  assert.equal(after.about?.label, "Harlow Legal");
  assert.equal((await call("recall.status", {}, cli())).data.sessions, sessionsBefore, "Recall's index is untouched");
  assert.ok(JSON.stringify((await call("memory.profile", {}, cli())).data).includes("Jordan"), "the told fact is still the person's");
  // The pre-adoption token: the kernel says its person is the owner now.
  const stale = await d.registry.call("memory.relevant", { text: "Harlow Legal", room: "unfiled" }, "deck", { token });
  assert.ok(!stale.error, JSON.stringify(stale.error));
});
