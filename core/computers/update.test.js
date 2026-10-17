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
import { ComputerUpdater, assertOwner, LAYOUT, MIGRATIONS as UPDATE_MIGRATIONS } from "./update.js";
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
  // the volume was made by an older image (agents' folders not yet in it), and was recorded under the older layout
  w.driver.volumes.set("vyre-browser-browser-shared", { layout: 1 });
  w.db.prepare("UPDATE computers_update SET layout = ?").run(LAYOUT - 1);
  assert.equal(up.status().current, false);
  w.asked.length = 0;
  const r = await up.run();
  assert.equal(r.state, "updated");
  assert.equal(r.replaced, false, "the container already runs the right image: it is kept");
  assert.deepEqual(w.asked.filter(a => a[0] === "createUser").map(a => a[1]).sort(), ["ads", "intake"]);
  assert.equal(up.stamp().layout, LAYOUT);
  assert.equal(up.status().current, true);
  assert.equal(w.driver.volumes.get("vyre-browser-browser-shared")?.layout, 2, "the old volume has the agents' folders now");
});

test("replacing the computer puts the agents' folders into an old state volume as the new one is made", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.driver.volumes.set("vyre-browser-browser-shared", { layout: 1 });
  w.pool.opts.image = "vyre/computer:0.6";
  const r = await w.mk({ version: "0.6.0" }).run();
  assert.equal(r.replaced, true);
  assert.equal(w.driver.volumes.get("vyre-browser-browser-shared")?.layout, 2);
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

test("a computer whose state volume has the old layout is replaced and the new container's volume has the agents' folders", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  const vol = String(containers(w.driver)[0].spec.browserVolume);
  w.driver.volumes.set(vol, { layout: 1 });   // as an older image left it: none of the agents' folders
  w.pool.opts.image = "vyre/computer:0.6";
  const r = await w.mk({ version: "0.6.0" }).run();
  assert.equal(r.state, "updated");
  assert.equal(containers(w.driver)[0].spec.browserVolume, vol, "the same volume");
  assert.equal(w.driver.volumes.get(vol)?.layout, 2, "its folders were put right before the new container started");
});

// ---- the owner's door -------------------------------------------------------------------

const person = id => ({ actor: { kind: "person", id } });
/** A kernel whose chain for each `meta.who` is as listed; the owner is "owen". */
const kernel = chains => ({ owner: "owen", canonicalPerson: (/** @type {string} */ x) => String(x).toLowerCase(), chain: async (/** @type {any} */ meta) => { const c = chains[meta.who]; if (c === "throw") throw new Error("no chain"); return c || null; } });
const KERNEL = kernel({
  owner: { hops: [person("Owen")] },
  admin: { hops: [person("adele")] },
  member: { hops: [person("mia")] },
  agent: { hops: [{ actor: { kind: "agent", id: "ads" } }] },
  assistant: { hops: [person("owen"), { actor: { kind: "agent", id: "juno" } }] },
  module: { hops: [{ actor: { kind: "module", id: "flows" } }] },
  mcp: { hops: [{ actor: { kind: "mcp", id: "client" } }] },
  broken: "throw",
});

test("update: the owner passes the door; an admin, a member, an agent, the owner's assistant, a module, an MCP caller, a broken chain and a build with no kernel do not", async () => {
  await assertOwner(KERNEL, { who: "owner" });
  for (const who of ["admin", "member", "agent", "assistant", "module", "mcp", "broken", "nobody"]) {
    await assert.rejects(() => assertOwner(KERNEL, { who }), e => /** @type {any} */ (e).code === "denied", who);
  }
  await assert.rejects(() => assertOwner(null, { who: "owner" }), e => /** @type {any} */ (e).code === "denied", "no kernel");
  await assert.rejects(() => assertOwner({ owner: "owen" }, { who: "owner" }), e => /** @type {any} */ (e).code === "denied", "a kernel that cannot read a chain");
});

test("update: both update tools are on the person-only floor, and the module's tools are wired through the door before anything is touched", async () => {
  const { PERSON_ONLY } = await import("../presence/index.js");
  assert.ok(PERSON_ONLY.has("computers.update") && PERSON_ONLY.has("computers.update.status"));
  const src = (await import("node:fs")).readFileSync(new URL("./index.js", import.meta.url), "utf8");
  for (const name of ["computers.update", "computers.update.status"]) {
    const at = src.indexOf(`tool("${name}"`);
    assert.ok(at > 0, name);
    assert.match(src.slice(at, at + 900), /await ownerOnly\(meta\);/, `${name} checks the owner first`);
  }
  assert.doesNotMatch(src, /agentClaim\(String\(meta && meta\.caller[^\n]*updates its agent computer/, "no weaker fallback door");
});

test("update: a refused caller leaves the computer untouched (the door is before the updater)", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.pool.opts.image = "vyre/computer:0.6";
  const calls = w.driver.calls.length;
  const up = w.mk({ version: "0.6.0" });
  const tool = async (/** @type {any} */ meta) => { await assertOwner(KERNEL, meta); return up.run(); };
  for (const who of ["admin", "member", "agent", "assistant", "module", "mcp"]) await assert.rejects(() => tool({ who }));
  assert.equal(w.driver.calls.length, calls, "no stop, remove or create was asked for");
  assert.equal((await tool({ who: "owner" })).state, "updated");
});

test("update: the replacement is made with the same create body as the first computer", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  const first = structuredClone(containers(w.driver)[0].spec);
  await w.mk({ version: "0.5.3" }).run({ force: true });
  const second = containers(w.driver)[0].spec;
  assert.deepEqual(second, first, "same mounts, labels, image field, limits and environment");
});

test("update: the folders an old volume gets include the browser folders, with the owners and modes the image gives them", async () => {
  const { layoutEntries } = await import("./driver/policy.js");
  const fs = await import("node:fs");
  const e = new Map(layoutEntries().map(x => [x[0], x.slice(1)]));
  assert.deepEqual(e.get("browsers/agb21000"), [21000, 21000, 0o700]);
  assert.deepEqual(e.get("browsers/agb21000/profile"), [21000, 21000, 0o700]);
  assert.deepEqual(e.get("x/ag20000"), [20000, 21000, 0o2750], "the X cookie folder: the agent owns it, its browser reads it");
  assert.deepEqual(e.get("downloads/ag20000"), [21000, 20000, 0o2750], "downloads: the browser writes, the agent reads");
  assert.deepEqual(e.get("agents/ag20063/home"), [20063, 20063, 0o700]);
  const docker = fs.readFileSync(new URL("./image/Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /chown "\$b:\$n" "\/var\/lib\/vyre\/downloads\/ag\$n" && chmod 2750/);
});

// ---- the automatic run waits for work to finish ---------------------------------------------

/** A clock the wait moves. */
function clocked(/** @type {any} */ w, /** @type {any} */ o = {}) {
  const c = { t: 0 };
  return { c, up: w.mk({ now: () => c.t, wait: async (/** @type {number} */ ms) => { c.t += ms; if (o.onWait) await o.onWait(c); }, ...o.deps }) };
}

test("update: the automatic run updates at once when nothing is running", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.pool.opts.image = "vyre/computer:0.6";
  const { up } = clocked(w, { deps: { version: "0.6.0", turns: () => 0 } });
  const r = await up.auto();
  assert.equal(r.state, "updated");
  assert.equal(r.interrupted, undefined);
});

test("update: the automatic run waits while an agent turn runs, and goes when it ends", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.pool.opts.image = "vyre/computer:0.6";
  let turns = 1;
  const { up, c } = clocked(w, { deps: { version: "0.6.0", turns: () => turns }, onWait: async cl => { if (cl.t >= 5 * 60_000) turns = 0; } });
  const r = await up.auto();
  assert.equal(r.state, "updated");
  assert.equal(c.t, 5 * 60_000);
  assert.equal(r.interrupted, undefined);
});

test("update: the automatic run waits while a terminal job is open", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.pool.opts.image = "vyre/computer:0.6";
  w.behaviour.terminals = [{ name: "build", windows: 1 }];
  const { up, c } = clocked(w, { deps: { version: "0.6.0" }, onWait: async cl => { if (cl.t >= 2 * 60_000) w.behaviour.terminals = []; } });
  const r = await up.auto();
  assert.equal(r.state, "updated");
  assert.equal(c.t, 2 * 60_000);
});

test("update: after 30 minutes the automatic run updates anyway and says what it interrupted", async t => {
  const w = await world(t, { image: "vyre/computer:0.5" });
  w.mk({ version: "0.5.3" }).noteCreated();
  w.pool.opts.image = "vyre/computer:0.6";
  const { up, c } = clocked(w, { deps: { version: "0.6.0", turns: () => 2 } });
  const r = await up.auto();
  assert.equal(r.state, "updated");
  assert.equal(c.t, 30 * 60_000);
  assert.deepEqual(r.interrupted, { turns: 2, terminals: 0 });
  assert.match(r.message, /2 agent turn\(s\)/);
});
