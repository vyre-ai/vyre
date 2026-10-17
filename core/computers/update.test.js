// @ts-check
// computers.update on the real Pool and the fake driver: a computer made by an older image, with a state volume from the old layout, is remade from this Vyre's image with its volume kept and its folders put right.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Pool, MIGRATIONS } from "./pool.js";
import { FakeDriver } from "./driver/fake.js";
import { updateComputers } from "./update.js";
import { LAYOUT_VERSION } from "./driver/policy.js";
import { tempHome } from "../../test/helpers.js";

const AGENTS = [{ name: "kit", kind: "agent", computer: true }, { name: "pax", kind: "agent", computer: true }];

function world(t) {
  const db = open(path.join(tempHome(t), "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const driver = new FakeDriver();
  const events = /** @type {string[]} */ ([]);
  const make = image => new Pool({ db, driver, call: async tool => tool === "agents.list" ? { data: AGENTS } : { error: { code: "no_such_tool", message: tool } }, emit: type => events.push(type), now: () => 1_000, config: { image, labelPrefix: "vyre" } });
  return { db, driver, events, make };
}

/** A computer as an older Vyre left it: its row says layout 1 and no image, its volume has the old layout, and it is running. */
async function oldComputer(w, agent, image = "vyre/computer:0.1") {
  const old = w.make(image);
  await old.ensure(agent);
  const id = String(old.row(agent).container);
  old.set(agent, { layout: 1, image: null });
  w.driver.volumes.set(`vyre-browser-${agent}`, { layout: 1 });
  return id;
}

test("a computer from the old layout is remade from this Vyre's image, keeps its volume, gets the folders the new layout needs, and is running again", async t => {
  const w = world(t);
  const oldId = await oldComputer(w, "kit");
  assert.equal(w.driver.volumes.get("vyre-browser-kit")?.layout, 1);
  const pool = w.make("vyre/computer:0.2");
  /** @type {string[]} */ const remade = [];
  const r = await updateComputers({ pool, onRemade: a => remade.push(a) });
  assert.deepEqual([r.updated, r.current, r.failed, r.image], [["kit"], [], [], "vyre/computer:0.2"]);
  assert.deepEqual(remade, ["kit"]);
  assert.equal(w.driver.containers.has(oldId), false, "the old container is gone");
  const row = pool.row("kit");
  const c = w.driver.containers.get(String(row.container));
  assert.ok(c && c.spec.image === "vyre/computer:0.2", "made from this Vyre's image");
  assert.equal(c.state, "running");
  assert.equal(row.state, "running");
  assert.deepEqual([row.layout, row.image], [LAYOUT_VERSION, "vyre/computer:0.2"]);
  assert.equal(c.spec.browserVolume, "vyre-browser-kit", "the same state volume");
  assert.equal(w.driver.volumes.get("vyre-browser-kit")?.layout, 2, "its folders are the new layout");
  assert.ok(w.events.includes("computer.updated"));
});

test("a computer that is current is left alone, a newer image remakes it, and force remakes it anyway", async t => {
  const w = world(t);
  const pool = w.make("vyre/computer:0.2");
  await pool.ensure("pax");
  const id = String(pool.row("pax").container);
  assert.deepEqual((await updateComputers({ pool })).current, ["pax"]);
  assert.equal(pool.row("pax").container, id, "untouched");
  const next = w.make("vyre/computer:0.3");
  const bumped = await next.update("pax");
  assert.equal(bumped.updated, true);
  assert.match(String(bumped.why), /runs vyre\/computer:0\.2, this Vyre uses vyre\/computer:0\.3/);
  const again = String(next.row("pax").container);
  assert.notEqual(again, id);
  assert.equal((await next.update("pax")).updated, false);
  assert.equal((await next.update("pax", { force: true })).updated, true);
  assert.notEqual(next.row("pax").container, again);
});

test("a computer that was stopped stays stopped after the update, and a row with no computer yet is skipped", async t => {
  const w = world(t);
  await oldComputer(w, "kit");
  const pool = w.make("vyre/computer:0.2");
  await pool.stop("kit");
  pool.rowFor("pax");   // a row, but no container yet
  const r = await updateComputers({ pool });
  assert.deepEqual(r.updated, ["kit"]);
  assert.equal(pool.row("kit").state, "none", "not started: it is made from the image at its next use");
  assert.equal(w.driver.volumes.get("vyre-browser-kit")?.layout, 1, "and its volume is migrated when that container is made");
  assert.deepEqual(r.current, ["pax"]);
  await pool.ensure("kit");
  assert.equal(w.driver.volumes.get("vyre-browser-kit")?.layout, 2);
});

test("an image that cannot be made leaves the computer to be made at its next use, and the failure is reported, not thrown", async t => {
  const w = world(t);
  await oldComputer(w, "kit");
  const pool = w.make("vyre/computer:0.2");
  const create = w.driver.create.bind(w.driver);
  w.driver.create = async () => { throw new Error("no such image: vyre/computer:0.2"); };
  const r = await updateComputers({ pool });
  assert.equal(r.updated.length, 0);
  assert.deepEqual(r.failed.map(f => f.agent), ["kit"]);
  assert.match(r.failed[0].error, /no such image/);
  assert.equal(pool.row("kit").container, null);
  w.driver.create = create;
  await pool.ensure("kit");
  assert.equal(pool.row("kit").layout, LAYOUT_VERSION);
});
