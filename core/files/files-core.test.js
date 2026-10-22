// @ts-check
// Lines 25 to 29 together, on one real daemon: the Space's folders and a project show in Files and a folder moves and renames;
// a file shared with another person is listed and read by them; a file's earlier version is restored and read back;
// a second writer waits, then is told who holds the file. A Space file delete is refused (no drive.delete grant) and the bytes stay.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lockPath } from "./write-lock.js";

process.env.VYRE_KERNEL ??= "1";
process.env.VYRE_KERNEL_PATH_RULE ??= "1";
process.env.VYRE_SEAL_DEV ??= "1";

const MEMBER = "per_northfile01";
const proof = () => ({ op: "stand-in", fields: {}, n: 1 });
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");
const text = (/** @type {any} */ r) => Buffer.from(r.base64, "base64").toString();
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test("a Space folder moves and renames, a share is listed by the other person, a version restores, and a second writer is told who holds the file", { timeout: 300_000 }, async (t) => {
  const { start } = await import("../daemon/index.js");
  const { tempHome } = await import("../../test/helpers.js");
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p, /** @type {string} */ device) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: device, person: p, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(chain(OWNER, "d-owner01"), { person: MEMBER, role: "member" }, { presence: proof() });
  // A session the kernel opened, so the call is that person. A device the home has not paired is not enrolled, so kernelFacts alone would not be a chain.
  const token = (await d.kernel.surfaces.open(chain(OWNER, "d-owner01"), {})).token;
  const memberToken = (await d.kernel.surfaces.open(chain(MEMBER, "d-member1"), {})).token;
  const own = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ extra = {}) => d.registry.call(tool, input, "cli", { token, ...extra });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    const r = await own(tool, input);
    assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`);
    return r.data;
  };

  const made = await own("work.project.create", { name: "North filing" });
  assert.ok(made.data && typeof made.data.drive_path === "string" && made.data.drive_path.startsWith("Projects/"), JSON.stringify(made));
  let places = await ok("files.places", {});
  const t0 = Date.now();
  while (!places.projects.some((/** @type {any} */ p) => p.name === "North filing") && Date.now() - t0 < 15_000) {
    await sleep(200);
    places = await ok("files.places", {});
  }
  const proj = places.projects.find((/** @type {any} */ p) => p.name === "North filing");
  assert.ok(proj && String(proj.path).startsWith("Projects/"), JSON.stringify(places.projects));
  if (places.agents.length) assert.ok(places.agents.every((/** @type {any} */ a) => typeof a.path === "string" && a.path.startsWith("agents/")), JSON.stringify(places.agents));

  await ok("files.drive.space.mkdir", { name: "North" });
  await ok("files.drive.space.mkdir", { parent: "North", name: "Cabinet" });
  await ok("files.drive.upload", { path: "North/Cabinet/brief.txt", base64: b64("kept") });
  const moved = await ok("files.drive.space.move", { from: "North/Cabinet", to: "North/Archive" });
  assert.ok(moved.moved >= 1, JSON.stringify(moved));
  assert.equal(text(await ok("files.drive.space.read", { path: "North/Archive/brief.txt" })), "kept");
  assert.equal((await own("files.drive.space.read", { path: "North/Cabinet/brief.txt" })).error?.code, "not_found");
  await ok("files.drive.space.rename", { path: "North/Archive", name: "Kept" });
  assert.equal(text(await ok("files.drive.space.read", { path: "North/Kept/brief.txt" })), "kept");

  // The owner role has no drive.delete grant (kernel/grants/roles.js), so the kernel answers not_found and the bytes stay. An outward yes cannot finish it: the gateway does not take an approval on drive.delete.
  const fileDel = await own("files.drive.space.delete", { path: "North/Kept/brief.txt" });
  assert.equal(fileDel.error && fileDel.error.code, "not_found", JSON.stringify(fileDel));
  assert.equal(text(await ok("files.drive.space.read", { path: "North/Kept/brief.txt" })), "kept");
  const folderDel = await ok("files.drive.space.delete", { path: "North/Kept" });
  assert.equal(folderDel.deleted, 0, JSON.stringify(folderDel));
  assert.equal(folderDel.code, "not_found");
  assert.equal(text(await ok("files.drive.space.read", { path: "North/Kept/brief.txt" })), "kept");

  await ok("files.drive.upload", { path: "North/versions.txt", base64: b64("alpha") });
  await ok("files.drive.upload", { path: "North/versions.txt", base64: b64("beta"), base: 1 });
  const restored = await own("files.drive.restore", { path: "North/versions.txt", version: 1 });
  if (restored.error && ["needs_presence", "presence_required", "denied"].includes(restored.error.code)) {
    await d.kernel.gateway.drive.restore(chain(OWNER, "d-owner01"), "North/versions.txt", 1);
  } else {
    assert.equal(restored.data && restored.data.from, 1, JSON.stringify(restored));
  }
  assert.equal(text(await ok("files.drive.space.read", { path: "North/versions.txt" })), "alpha");
  const vers = await ok("files.drive.versions", { path: "North/versions.txt" });
  assert.ok(vers.versions.length >= 3 && vers.versions.some((/** @type {any} */ v) => v.ver === 1), JSON.stringify(vers.versions));

  const shared = await own("files.with.share", { path: "North/Kept/brief.txt", person: MEMBER }, { kernel_proof: proof() });
  assert.equal(shared.data && shared.data.path, "North/Kept/brief.txt", JSON.stringify(shared));
  const again = await own("files.with.share", { path: "North/Kept/brief.txt", person: MEMBER }, { kernel_proof: proof() });
  assert.equal(again.data && again.data.at, shared.data.at, JSON.stringify(again));
  assert.deepEqual((await ok("files.with.list", {})).shares, []);
  const asMember = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: memberToken });
  const listed = await asMember("files.with.list");
  assert.ok(listed.data && listed.data.shares.some((/** @type {any} */ s) => s.path === "North/Kept/brief.txt" && s.by === OWNER), JSON.stringify(listed));
  const got = await asMember("files.with.read", { path: "North/Kept/brief.txt" });
  assert.equal(text(got.data), "kept", JSON.stringify(got));

  const dir = path.join(root, "files", "write-locks");
  fs.mkdirSync(dir, { recursive: true });
  await ok("files.drive.upload", { path: "North/turn.txt", base64: b64("one") });
  const turnLock = lockPath(dir, "North/turn.txt");
  fs.writeFileSync(turnLock, JSON.stringify({ who: "agent:agt_writer", at: Date.now() }));
  let finished = false;
  const second = own("files.drive.upload", { path: "North/turn.txt", base64: b64("two"), base: 1 }).then((r) => { finished = true; return r; });
  await sleep(300);
  assert.equal(finished, false, "the second writer is still waiting");
  fs.unlinkSync(turnLock);
  const turned = await second;
  assert.ok(!turned.error, JSON.stringify(turned));
  assert.equal(text(await ok("files.drive.space.read", { path: "North/turn.txt" })), "two");
  assert.ok((await ok("files.drive.versions", { path: "North/turn.txt" })).versions.length >= 2);

  await ok("files.drive.upload", { path: "North/held.txt", base64: b64("first") });
  fs.writeFileSync(lockPath(dir, "North/held.txt"), JSON.stringify({ who: "person:per_holderhold", at: Date.now() }));
  const held = await own("files.drive.upload", { path: "North/held.txt", base64: b64("nope"), base: 1 });
  assert.equal(held.error && held.error.code, "locked", JSON.stringify(held));
  assert.match(held.error.message, /person:per_holderhold/);
  assert.equal(held.error.detail && held.error.detail.holder, "person:per_holderhold");
  assert.equal(text(await ok("files.drive.space.read", { path: "North/held.txt" })), "first");
});
