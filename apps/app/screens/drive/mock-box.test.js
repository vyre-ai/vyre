// @ts-check
// The sample world answers the same tools the one Drive screen calls, in the shapes the real box uses.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const fresh = async () => (await import("./mock-box.ts")).mockBox(() => 1_790_000_000_000);

test("the space lists its files, and a sealed file is not among them", { skip: !strip }, async () => {
  const call = await fresh();
  const r = /** @type {any} */ ((await call("files.drive.space.list", {})).data);
  assert.ok(r.entries.length >= 5);
  assert.ok(r.entries.every((/** @type {any} */ e) => typeof e.path === "string" && e.ver >= 1));
  assert.ok(!r.entries.some((/** @type {any} */ e) => /will|passport/i.test(e.path)));
});

test("versions run newest first and restoring an old one adds a new version", { skip: !strip }, async () => {
  const call = await fresh();
  const path = "Doe estate plan/Trust agreement v4.pdf";
  const v = /** @type {any} */ ((await call("files.drive.versions", { path })).data).versions;
  assert.deepEqual(v.map((/** @type {any} */ x) => x.ver), [4, 3, 2, 1]);
  const r = /** @type {any} */ ((await call("files.drive.restore", { path, version: 2 })).data);
  assert.equal(r.version, 5);
  assert.equal((await call("files.drive.restore", { path, version: 5 })).error?.code, "bad_input");
});

test("a link is made, listed, and taken away", { skip: !strip }, async () => {
  const call = await fresh();
  const made = /** @type {any} */ ((await call("files.drive.link.create", { path: "Vyre site/Trail map.pdf", days: 7 })).data);
  assert.equal(made.active, true);
  assert.equal(made.expires - made.made_at, 7 * 86_400_000);
  assert.equal(/** @type {any} */ ((await call("files.drive.link.list")).data).links.length, 1);
  assert.equal((await call("files.drive.link.create", { path: "nope" })).error?.code, "not_found");
  await call("files.drive.link.revoke", { code: made.code });
  assert.equal(/** @type {any} */ ((await call("files.drive.link.list")).data).links.length, 0);
});

test("the artifacts and the box folders answer too; an unknown tool is not available", { skip: !strip }, async () => {
  const call = await fresh();
  const a = /** @type {any} */ ((await call("artifacts.list", {})).data).artifacts;
  assert.ok(a.length >= 1 && a.every((/** @type {any} */ x) => x.id && x.title));
  assert.equal(/** @type {any} */ ((await call("files.drive.status")).data).shares.length, 1);
  assert.equal(/** @type {any} */ ((await call("files.drive.read", { share: "Documents", path: "/Notes.txt" })).data).done, true);
  assert.equal((await call("nope.tool")).error?.code, "not_available");
});
