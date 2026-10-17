// @ts-check
// computers.update: the Space's one agent computer is brought to this Vyre's image, keeping its state volume and every agent's place,
// and what the new image expects in the volume is made true. A fake driver stands in for Docker and a recording ctl for agentd.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Pool, MIGRATIONS } from "./pool.js";
import { AgentUsers, MIGRATIONS as AGENT_USER_MIGRATIONS } from "./agent-users.js";
import { ComputerUpdater, LAYOUT, MIGRATIONS as UPDATE_MIGRATIONS } from "./update.js";
import { FakeDriver } from "./driver/fake.js";
import { SHARED_COMPUTER_ID } from "../../lib/browser-access.js";
import { tempHome } from "../../test/helpers.js";

/** The Space's computer, made once from `image`, with two agents that have a place on it. */
async function world(t, { image = "vyre/computer:0.6", version = "0.6.0" } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", [...MIGRATIONS, ...AGENT_USER_MIGRATIONS, ...UPDATE_MIGRATIONS]);
  const driver = new FakeDriver();
  const events = /** @type {Array<{ type: string, payload: any }>} */ ([]);
  const pool = new Pool({ db, driver, call: async () => ({ data: [] }), emit: (type, payload) => { events.push({ type, payload }); }, config: { waitMs: 200, image }, memberTokenKey: async () => "k" });
  const at = Date.now();
  db.prepare(`INSERT INTO computers_computers (agent, container, state, vnc_password, helper_token, paused, created, updated, kind) VALUES (?, NULL, 'none', 'pw', 'tok', 0, ?, ?, 'browser')`).run(SHARED_COMPUTER_ID, at, at);
  /** What agentd was asked, in order: [action, agent]. */
  const asked = /** @type {Array<[string, string]>} */ ([]);
  const behaviour = { createUser: /** @type {null | ((u: any) => Promise<void>)} */ (null), terminals: /** @type {Array<{ name: string, windows: number }>} */ ([]) };
  const ctl = {
    createUser: async (/** @type {any} */ u) => { asked.push(["createUser", u.agentId]); if (behaviour.createUser) await behaviour.createUser(u); },
    removeUser: async () => {}, wipeHome: async () => {},
    startScreen: async (/** @type {any} */ u) => { asked.push(["startScreen", u.agentId]); },
    stopScreen: async (/** @type {any} */ u) => { asked.push(["stopScreen", u.agentId]); },
    terminals: async () => behaviour.terminals,
  };
  const users = new AgentUsers({ db, ctl });
  await pool.serial(SHARED_COMPUTER_ID, () => pool.ensure(SHARED_COMPUTER_ID));
  for (const a of ["ads", "intake"]) await users.add(a, a);
  asked.length = 0;
  const mk = (/** @type {Record<string, any>} */ o = {}) => new ComputerUpdater({ db, pool, users, version, wait: async () => {}, ...o });
  return { db, pool, driver, users, asked, behaviour, mk, events };
}

const containers = (/** @type {FakeDriver} */ d) => [...d.containers.values()];

test("a computer made from the image this Vyre wants is current: nothing is replaced", async t => {
  const w = await world(t);
  const up = w.mk();
  up.noteCreated();
  const before = String(w.pool.row(SHARED_COMPUTER_ID).container);
  const r = await up.run();
  assert.equal(r.state, "current");
  assert.equal(r.updated, false);
  assert.equal(String(w.pool.row(SHARED_COMPUTER_ID).container), before);
  assert.deepEqual(w.driver.calls.filter(c => c.op === "remove"), []);
});

test("a computer made by an older Vyre is replaced by one on the new image, on the same state volume", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  const old = String(w.pool.row(SHARED_COMPUTER_ID).container);
  const volumes = (/** @type {any} */ c) => [c.spec.volume, c.spec.browserVolume];
  const oldVolumes = volumes(containers(w.driver)[0]);
  // the Vyre is updated: it now asks for the new image
  w.pool.opts.image = "vyre/computer:0.6";
  const up = w.mk({ version: "0.6.0" });
  const r = await up.run();
  assert.equal(r.state, "updated");
  assert.equal(r.replaced, true);
  const now = containers(w.driver);
  assert.equal(now.length, 1, "the old container is gone, one new one runs");
  assert.notEqual(now[0].id, old);
  assert.equal(now[0].spec.image, "vyre/computer:0.6");
  assert.deepEqual(volumes(now[0]), oldVolumes, "the state volume is the same one");
  assert.equal(now[0].state, "running");
  assert.equal(w.pool.row(SHARED_COMPUTER_ID).container, now[0].id);
  assert.equal(w.driver.calls.filter(c => c.op === "remove").length, 1);
  // the agentd token is seeded on the new container
  assert.ok(now[0].agentdToken, "agentd's token is on the new computer");
  assert.equal(up.status().current, true);
  assert.equal(up.stamp().image, "vyre/computer:0.6");
});

test("agents keep their place (uid, display) and their screens read asleep afterwards", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  await w.users.wake("ads");
  const before = w.users.list().map(r => [r.agent_id, r.uid, r.display]);
  w.asked.length = 0;
  w.pool.opts.image = "vyre/computer:0.6";
  const r = await w.mk({ version: "0.6.0" }).run();
  assert.equal(r.state, "updated");
  assert.deepEqual(w.users.list().map(x => [x.agent_id, x.uid, x.display]), before);
  assert.ok(w.users.list().every(x => x.state === "asleep"));
  assert.deepEqual(w.asked.filter(a => a[0] === "stopScreen"), [["stopScreen", "ads"]], "the live screen is closed first so Chrome writes its profile");
  assert.ok(w.asked.findIndex(a => a[0] === "stopScreen") < w.asked.findIndex(a => a[0] === "createUser"), "screens close before the folders are checked");
});

test("an old-layout volume is migrated: every agent's folders are made ready again, as that agent", async t => {
  const w = await world(t);
  const up = w.mk();
  up.noteCreated();
  // the volume was last migrated under an older layout (homes not yet inside the state volume)
  w.db.prepare("UPDATE computers_update SET layout = ?").run(LAYOUT - 1);
  assert.equal(up.status().current, false);
  w.asked.length = 0;
  const r = await up.run();
  assert.equal(r.state, "updated");
  assert.equal(r.replaced, false, "the container already runs the right image: it is kept");
  assert.deepEqual(w.asked.filter(a => a[0] === "createUser").map(a => a[1]).sort(), ["ads", "intake"]);
  assert.equal(up.stamp().layout, LAYOUT);
  assert.equal(up.status().current, true);
});

test("a computer with no record of how it was made is replaced once, then recorded", async t => {
  const w = await world(t);
  const up = w.mk();
  assert.equal(up.stamp(), null);
  const r = await up.run();
  assert.equal(r.replaced, true);
  assert.ok(up.stamp());
  assert.equal((await up.run()).state, "current");
});

test("a person watching or in control holds the update back, and nothing is touched", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.pool.opts.image = "vyre/computer:0.6";
  const old = String(w.pool.row(SHARED_COMPUTER_ID).container);
  const r = await w.mk({ version: "0.6.0", held: a => a === "intake" }).run();
  assert.equal(r.state, "busy");
  assert.deepEqual(r.busy, ["intake"]);
  assert.equal(String(w.pool.row(SHARED_COMPUTER_ID).container), old);
  assert.deepEqual(w.asked, []);
});

test("an agent whose folders cannot be made ready is named, the others are done, and nothing is deleted", async t => {
  const w = await world(t);
  w.mk().noteCreated();
  w.db.prepare("UPDATE computers_update SET layout = 0").run();
  w.behaviour.createUser = async u => { if (u.agentId === "intake") throw new Error("the state folder is missing"); };
  const r = await w.mk().run();
  assert.equal(r.state, "partial");
  assert.deepEqual(r.failed.map((/** @type {any} */ f) => f.agent), ["intake"]);
  assert.equal(w.mk().stamp().layout, 0, "not recorded as migrated, so the next start tries again");
  assert.ok(containers(w.driver).length === 1);
});

test("terminal jobs that the replacement ends are counted in the answer", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.behaviour.terminals = [{ name: "deploy", windows: 1 }];
  w.pool.opts.image = "vyre/computer:0.6";
  const r = await w.mk({ version: "0.6.0" }).run();
  assert.equal(r.terminals, 2);
  assert.match(r.message, /terminal jobs/);
});

test("a computer that cannot close a screen (it already died) is still replaced and the agent reads asleep", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  await w.users.wake("ads");
  w.users.ctl.stopScreen = async () => { throw new Error("the computer is not running"); };
  w.pool.opts.image = "vyre/computer:0.6";
  const r = await w.mk({ version: "0.6.0" }).run();
  assert.equal(r.state, "updated");
  assert.equal(w.users.row("ads").state, "asleep");
});

test("two updates at once run once", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.pool.opts.image = "vyre/computer:0.6";
  const up = w.mk({ version: "0.6.0" });
  const [a, b] = await Promise.all([up.run(), up.run()]);
  assert.equal(a, b);
  assert.equal(w.driver.calls.filter(c => c.op === "create").length, 2, "the first computer and one replacement");
});

test("a Space with no agent computer yet has nothing to update", async t => {
  const w = await world(t);
  w.db.prepare("UPDATE computers_computers SET container = NULL, state = 'none' WHERE agent = ?").run(SHARED_COMPUTER_ID);
  const r = await w.mk().run();
  assert.equal(r.state, "none");
  assert.equal(r.updated, false);
});

test("force replaces a computer that looks current", async t => {
  const w = await world(t);
  const up = w.mk();
  up.noteCreated();
  const r = await up.run({ force: true });
  assert.equal(r.replaced, true);
});
