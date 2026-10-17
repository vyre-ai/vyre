// @ts-check
// A chat with more than one person always runs on the space's server: the lent home never places it on a person's computer, however ready that computer is.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLentHome } from "./lent-home.js";

const SPACE = "spc_aaaaaaaaaaaa";
const chain = (/** @type {string} */ person, /** @type {string} */ device) => ({ space: SPACE, hops: [{ actor: { kind: "person", id: person }, via: { device } }] });
const spec = async () => ({ command: "/usr/bin/agent", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider", credentialRoutes: [] });
const SOLO = "chat_00000000-0000-4000-8000-000000000001", GROUP = "chat_00000000-0000-4000-8000-000000000002";

async function readyHome(/** @type {import("node:test").TestContext} */ t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lg-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const home = createLentHome({ space: SPACE, root: dir, offers: { active: () => ({ spaceAllows: true, memberAccepts: true }) }, leases: { renew: async () => {}, bind: () => {}, unbind: () => {} }, now: () => clock, specFor: spec,
    groupChat: (/** @type {string} */ c) => c === GROUP });
  clock += 5000; await home.beat(chain("per_a", "dev_1"), { sessions: [], well: true });
  return home;
}

test("a one-person chat is placed on the person's ready computer, a chat with more than one person is not", async t => {
  const home = await readyHome(t);
  assert.equal(home.placeNew({ session: "s_solo", chat: SOLO, person: "per_a" }).where, "mac");
  assert.deepEqual(home.placeNew({ session: "s_group", chat: GROUP, person: "per_a" }), { where: "box" });
  assert.equal(home.book.get("s_group"), null, "no row says it is on a computer");
  assert.equal(home.isGroup(GROUP), true);
  assert.equal(home.isGroup(SOLO), false);
});

test("a chat with more than one person is never moved out to a computer", async t => {
  const home = await readyHome(t);
  await assert.rejects(home.adopt({ session: "s_group", thread: "s_group", chat: GROUP, person: "per_a", native: "n", lines: ["x"] }), (/** @type {any} */ e) => e.code === "conflict" && /more than one person/.test(e.message));
  assert.equal(home.book.get("s_group"), null);
});
