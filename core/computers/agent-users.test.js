// @ts-check
// The agents on a space's one computer: a user each, a screen woken on demand and closed after 5 idle minutes, a home that can be reset
// alone. A fake ctl records what would have run inside the container; the clock is the test's.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { AgentUsers, MIGRATIONS, UID_BASE, DISPLAY_BASE, IDLE_SLEEP_MS, userNameOf } from "./agent-users.js";

function setup(t, extra = {}) {
  const db = open(path.join(tempHome(t), "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const clock = { t: 1_000 };
  /** @type {string[]} */ const ran = [];
  const events = /** @type {string[]} */ ([]);
  const ctl = {
    createUser: async (/** @type {any} */ u) => { ran.push(`create ${u.user} ${u.uid} :${u.display}`); },
    removeUser: async (/** @type {any} */ u) => { ran.push(`remove ${u.user}`); },
    startScreen: async (/** @type {any} */ u) => { if (extra.failStart) throw new Error("no screen"); ran.push(`start :${u.display} ${u.user}`); },
    stopScreen: async (/** @type {any} */ u) => { ran.push(`stop :${u.display} ${u.user}`); },
    wipeHome: async (/** @type {any} */ u) => { ran.push(`wipe ${u.user}`); },
    terminals: async (/** @type {any} */ u) => [{ name: `t-${u.user}`, windows: 1 }],
    terminalTicket: async (/** @type {any} */ u, /** @type {string} */ ticket, /** @type {string} */ session) => { ran.push(`term ${u.user} ${session} ${ticket}`); },
    cdpTicket: async (/** @type {any} */ u, /** @type {string} */ ticket) => { ran.push(`cdp ${u.user} ${ticket}`); },
    screenTicket: async (/** @type {any} */ u, /** @type {string} */ ticket) => { ran.push(`ticket ${u.user} ${ticket}`); },
  };
  const users = new AgentUsers({ db, ctl, now: () => clock.t, emit: type => events.push(type), ...extra.deps });
  return { users, clock, ran, events };
}

test("each agent is its own user with its own uid and screen, made once and never changed", async t => {
  const { users, ran } = setup(t);
  const a = await users.add("ads", "Ads");
  const b = await users.add("legal-help", "Legal help");
  assert.equal(a.uid, UID_BASE);
  assert.equal(b.uid, UID_BASE + 1);
  assert.equal(a.display, DISPLAY_BASE);
  assert.equal(b.display, DISPLAY_BASE + 1);
  assert.equal(a.state, "asleep", "a new agent has no screen yet");
  const again = await users.add("ads", "Ads (renamed)");
  assert.equal(again.uid, a.uid, "adding twice keeps the same user");
  assert.equal(ran.filter(x => x.startsWith("create")).length, 2, "the user was made once");
  assert.notEqual(userNameOf(a.uid), userNameOf(b.uid));
  assert.equal(userNameOf(a.uid), "ag20000");
});

test("an agent id that is not an id is refused, and nothing is made", async t => {
  const { users, ran } = setup(t);
  await assert.rejects(() => users.add("../root", "x"), /not an agent id/);
  await assert.rejects(() => users.add("Ads", "x"), /not an agent id/);
  assert.deepEqual(ran, []);
});

test("waking starts the screen once, and a live agent is not started again", async t => {
  const { users, ran, events } = setup(t);
  await users.add("ads", "Ads");
  assert.equal((await users.wake("ads")).state, "live");
  await users.wake("ads");
  assert.equal(ran.filter(x => x.startsWith("start")).length, 1);
  assert.deepEqual(events.filter(e => /waking|live/.test(e)), ["computer.agent-waking", "computer.agent-live"]);
  await assert.rejects(() => users.wake("nobody"), /no place on this computer/);
});

test("a screen that cannot start leaves the agent asleep, not stuck waking", async t => {
  const { users } = setup(t, { failStart: true });
  await users.add("ads", "Ads");
  await assert.rejects(() => users.wake("ads"), /no screen/);
  assert.equal(users.status("ads").state, "asleep");
});

test("five idle minutes close the screen; use, a viewer or a take-over keeps it open; the home is untouched", async t => {
  const { users, clock, ran } = setup(t);
  await users.add("ads", "Ads");
  await users.add("kit", "Kit");
  await users.wake("ads"); await users.wake("kit");
  clock.t += IDLE_SLEEP_MS - 1;
  users.touch("kit");
  assert.deepEqual(await users.sweep(), [], "not yet idle for five minutes");
  clock.t += 2;
  assert.deepEqual(await users.sweep(id => id === "ads"), [], "a person watching holds it open");
  assert.deepEqual(await users.sweep(), ["ads"], "ads was idle for five minutes and a bit; kit was just used");
  assert.equal(users.status("ads").state, "asleep");
  assert.equal(users.status("kit").state, "live");
  assert.ok(!ran.some(x => x.startsWith("wipe") || x.startsWith("remove")), "sleeping never touches a home");
});

test("waking again reopens the same screen, in the same display", async t => {
  const { users } = setup(t);
  const first = await users.add("ads", "Ads");
  await users.wake("ads");
  await users.sleep("ads");
  const again = await users.wake("ads");
  assert.equal(again.display, first.display);
  assert.equal(again.state, "live");
});

test("reset empties one agent's home only, after closing its screen, and the user stays", async t => {
  const { users, ran } = setup(t);
  await users.add("ads", "Ads"); await users.add("kit", "Kit");
  await users.wake("ads");
  await users.reset("ads");
  const tail = ran.slice(ran.findIndex(x => x.startsWith("stop")));
  assert.deepEqual(tail.map(x => x.split(" ")[0]), ["stop", "wipe"], "the screen closes first");
  assert.ok(tail.some(x => x === `wipe ${userNameOf(UID_BASE)}`));
  assert.ok(!ran.some(x => x === `wipe ${userNameOf(UID_BASE + 1)}`), "nobody else's home is wiped");
  assert.ok(users.row("ads"), "the user is still there");
  await assert.rejects(() => users.reset("ghost"), /no place on this computer/);
});

test("removing an agent frees its place, and the next agent takes the freed uid", async t => {
  const { users } = setup(t);
  await users.add("ads", "Ads");
  const kit = await users.add("kit", "Kit");
  assert.equal(await users.remove("ads"), true);
  assert.equal(users.row("ads"), null);
  const pax = await users.add("pax", "Pax");
  assert.equal(pax.uid, UID_BASE, "the freed uid is reused");
  assert.notEqual(pax.uid, kit.uid);
});

test("a computer holds at most its limit of agents", async t => {
  const { users } = setup(t, { deps: { max: 2 } });
  await users.add("a1", "A"); await users.add("a2", "B");
  await assert.rejects(() => users.add("a3", "C"), /already holds 2 agents/);
});

test("a screen ticket is registered for a live agent only, under that agent's own user, and counts as use", async t => {
  const { users, ran, clock } = setup(t);
  await users.add("ads", "Ads");
  await assert.rejects(() => users.screenTicket("ads", "t".repeat(32)), /screen is not on/);
  await assert.rejects(() => users.screenTicket("nobody", "t".repeat(32)), /screen is not on/);
  await users.wake("ads");
  clock.t += 60_000;
  await users.screenTicket("ads", "t".repeat(32));
  assert.deepEqual(ran.filter(x => x.startsWith("ticket")), [`ticket ag20000 ${"t".repeat(32)}`]);
  assert.equal(users.row("ads").last_active, clock.t);
});

test("terminals are the agent's own, listed and ticketed under its own user; an agent with no place has none and cannot be ticketed", async t => {
  const { users, ran } = setup(t);
  assert.deepEqual(await users.terminals("ads"), []);
  await assert.rejects(() => users.terminalTicket("ads", "t".repeat(32), "work"), /no place/);
  await users.add("ads", "Ads"); await users.add("kit", "Kit");
  assert.deepEqual(await users.terminals("kit"), [{ name: "t-ag20001", windows: 1 }]);
  await users.terminalTicket("ads", "t".repeat(32), "work");
  assert.deepEqual(ran.filter(x => x.startsWith("term")), [`term ag20000 work ${"t".repeat(32)}`]);
});

test("a Chrome ticket is registered for a live agent only, under that agent's own user", async t => {
  const { users, ran } = setup(t);
  await users.add("ads", "Ads");
  await assert.rejects(() => users.cdpTicket("ads", "t".repeat(32)), /Chrome is not up/);
  await users.wake("ads");
  await users.cdpTicket("ads", "t".repeat(32));
  assert.deepEqual(ran.filter(x => x.startsWith("cdp")), [`cdp ag20000 ${"t".repeat(32)}`]);
});
