// @ts-check
// The Computer tab's picture of an agent's screen: at most one capture per 5 s, none while someone types or a fill shields the screen (only who holds it), the latest picture for an asleep agent, memory only,
// dropped on reset; the agentd plan for it runs as the screen's owner and writes nothing; the tool needs use of the agent.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { AgentUsers, MIGRATIONS } from "./agent-users.js";
import { AgentFrames, FRAME_EVERY_MS } from "./agent-frame.js";
import { registerAgentTools } from "./agent-tools.js";
import { planShot, SHOT } from "./image/agentd.js";

function world(t, flags = { typing: false, shielded: false, watching: false }) {
  const db = open(path.join(tempHome(t), "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const clock = { t: 10_000 };
  let shots = 0, fail = false;
  const ctl = { createUser: async () => {}, removeUser: async () => {}, startScreen: async () => {}, stopScreen: async () => {}, wipeAgentHome: async () => {},
    shot: async () => { if (fail) throw new Error("no"); shots++; return { mime: "image/jpeg", width: 480, height: 300, jpeg: Buffer.from(`frame-${shots}`).toString("base64") }; } };
  const users = new AgentUsers({ db, ctl, now: () => clock.t });
  const frames = new AgentFrames({ users, now: () => clock.t, typing: () => flags.typing, shielded: () => flags.shielded, watching: () => flags.watching });
  return { users, frames, clock, flags, shots: () => shots, fail: (/** @type {boolean} */ v) => { fail = v; } };
}
const text = (/** @type {any} */ v) => Buffer.from(String(v.thumbnail).split(",")[1], "base64").toString();

test("a live screen gives a picture, at most one capture per 5 s; a minute later it is a new one", async t => {
  const w = world(t);
  await w.users.add("ads", "ads"); await w.users.wake("ads");
  const a = await w.frames.view("ads");
  assert.equal(a.state, "live");
  assert.match(String(a.thumbnail), /^data:image\/jpeg;base64,/);
  assert.equal(text(a), "frame-1");
  await w.frames.view("ads"); await w.frames.view("ads");
  assert.equal(w.shots(), 1, "three looks inside 5 s are one capture");
  w.clock.t += FRAME_EVERY_MS + 1;
  assert.equal(text(await w.frames.view("ads")), "frame-2");
  assert.equal(w.shots(), 2);
});

test("looking does not count as use: an open tab does not keep an agent awake", async t => {
  const w = world(t);
  await w.users.add("ads", "ads"); await w.users.wake("ads");
  const before = w.users.row("ads").last_active;
  w.clock.t += 60_000;
  await w.frames.view("ads");
  assert.equal(w.users.row("ads").last_active, before);
});

test("while a person types into the screen, or a sign-in or fill shields it, there is NO picture, only who holds it", async t => {
  const w = world(t);
  await w.users.add("ads", "ads"); await w.users.wake("ads");
  await w.frames.view("ads");   // a picture exists in the cache from before
  w.flags.typing = true;
  const typing = await w.frames.view("ads");
  assert.equal(typing.thumbnail, undefined);
  assert.deepEqual([typing.held_by, typing.withheld], ["taken-over", "typing"]);
  w.flags.typing = false; w.flags.shielded = true;
  const shielded = await w.frames.view("ads");
  assert.equal(shielded.thumbnail, undefined);
  assert.equal(shielded.withheld, "shielded");
  w.flags.shielded = false; w.flags.watching = true;
  const watched = await w.frames.view("ads");
  assert.equal(watched.held_by, "watching");
  assert.ok(watched.thumbnail, "someone merely watching gets the picture");
  assert.equal(w.shots(), 1, "nothing was captured while it was withheld");
});

test("a capture in flight when the shield turns on returns withheld and leaves nothing in the cache", async t => {
  const db = open(path.join(tempHome(t), "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const flags = { typing: false, shielded: false };
  /** @type {() => void} */ let release = () => {};
  const gate = new Promise(r => { release = () => r(null); });
  const ctl = { createUser: async () => {}, removeUser: async () => {}, startScreen: async () => {}, stopScreen: async () => {}, wipeAgentHome: async () => {},
    shot: async () => { await gate; return { mime: "image/jpeg", width: 480, height: 300, jpeg: Buffer.from("late").toString("base64") }; } };
  const users = new AgentUsers({ db, ctl, now: () => 10_000 });
  const frames = new AgentFrames({ users, now: () => 10_000, typing: () => flags.typing, shielded: () => flags.shielded, watching: () => false });
  await users.add("ads", "ads"); await users.wake("ads");
  const pending = frames.view("ads");
  flags.shielded = true;
  release();
  const v = await pending;
  assert.equal(v.thumbnail, undefined);
  assert.equal(v.withheld, "shielded");
  assert.equal(frames.cache.has("ads"), false, "nothing of that picture is kept");
  flags.shielded = false;
  assert.equal((await frames.view("ads")).thumbnail !== undefined, true, "a later look captures afresh");
});

test("an asleep agent shows the latest picture it had; a reset, a removal and a stopped computer drop it; an agent with no place shows none", async t => {
  const w = world(t);
  assert.deepEqual(await w.frames.view("ghost"), { agent: "ghost", state: "none", lastActive: 0 });
  await w.users.add("ads", "ads"); await w.users.wake("ads");
  await w.frames.view("ads");
  await w.users.sleep("ads");
  const asleep = await w.frames.view("ads");
  assert.equal(asleep.state, "asleep");
  assert.equal(text(asleep), "frame-1");
  w.frames.drop("ads");
  assert.equal((await w.frames.view("ads")).thumbnail, undefined);
  await w.users.wake("ads"); await w.frames.view("ads");
  w.frames.dropAll();
  await w.users.sleep("ads");
  assert.equal((await w.frames.view("ads")).thumbnail, undefined);
});

test("a capture that fails gives the last picture, or none, never an error to the tab", async t => {
  const w = world(t);
  await w.users.add("ads", "ads"); await w.users.wake("ads");
  w.fail(true);
  assert.equal((await w.frames.view("ads")).thumbnail, undefined);
  w.fail(false);
  assert.ok((await w.frames.view("ads")).thumbnail);
  w.fail(true); w.clock.t += FRAME_EVERY_MS + 1;
  assert.equal(text(await w.frames.view("ads")), "frame-1", "the earlier picture stands");
});

test("the tool needs use of the agent, refuses a caller with none, and adds where the computer runs as facts", async t => {
  const w = world(t);
  await w.users.add("ads", "ads"); await w.users.wake("ads");
  /** @type {Map<string, any>} */ const tools = new Map();
  let level = "use";
  registerAgentTools({ tool: (n, _d, _i, run) => tools.set(n, run), users: w.users, frames: w.frames, runsOn: () => ({ role: "box", owner: "per_owner" }), callers: ["deck"],
    call: async tool => tool === "agents.level" ? { data: { level } } : { error: { code: "no_such_tool", message: tool } } });
  const r = await tools.get("computers.agent.frame")({ agent: "ads" }, {});
  assert.equal(r.state, "live");
  assert.ok(r.thumbnail);
  assert.deepEqual(r.runs_on, { role: "box", owner: "per_owner" });
  level = "none";
  await assert.rejects(() => tools.get("computers.agent.frame")({ agent: "ads" }, {}), /cannot use that agent/);
  await assert.rejects(() => tools.get("computers.agent.frame")({ agent: "../x" }, {}), /is not an agent/);
});

test("the agentd plan for the picture runs as the screen's owner with the display's own cookie, downscaled, to standard output, with no file and a size cap", () => {
  const argv = planShot({ user: "ag20000", uid: 20000, display: 20 });
  const line = argv.join(" ");
  assert.match(line, /^\/usr\/bin\/setpriv --reuid=21000 --regid=21000 /, "the browser uid owns the screen, not the agent");
  assert.ok(argv.includes("DISPLAY=:20") && argv.includes("XAUTHORITY=/var/lib/vyre/browsers/agb21000/xauth"));
  assert.match(line, /\/usr\/bin\/import -window root -resize 480x300 -quality 40 jpeg:-$/);
  assert.ok(SHOT.maxBytes <= 40 * 1024);
  assert.throws(() => planShot({ user: "root", uid: 0, display: 20 }), /not one of the agent users/);
});

test("agentd's shot action answers a picture for a real agent triple only, refuses a picture over the cap, and a wrong token gets nothing", async t => {
  const fs = await import("node:fs");
  const { startAgentd } = await import("./image/agentd-main.js");
  const { callAgentd } = await import("./image/agentd-client.js");
  const { SCRATCH } = await import("../../test/scratch.mjs");
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-shot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "a.sock"), tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "t".repeat(40), { mode: 0o400 });
  /** @type {string[][]} */ const asked = [];
  let big = false;
  const server = startAgentd({ socket, tokenFile, run: async () => {}, shot: async (/** @type {string[]} */ argv) => { asked.push(argv); if (big) throw new Error("the picture is too large"); return Buffer.from("jpegbytes"); } });
  await new Promise(r => server.on("listening", () => r(null)));
  t.after(() => server.close());
  const call = (/** @type {any} */ body, token = "t".repeat(40)) => callAgentd({ socket, token, action: "shot", body: JSON.stringify(body) });
  const ok = await call({ user: "ag20000", uid: 20000, display: 20 });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { mime: "image/jpeg", width: 480, height: 300, jpeg: Buffer.from("jpegbytes").toString("base64") });
  assert.equal(asked.length, 1);
  assert.equal((await call({ user: "ag1000", uid: 1000, display: 20 })).status, 400);
  assert.equal((await call({ user: "ag20000", uid: 20000, display: 21 })).status, 400);
  assert.equal((await call({ user: "ag20000", uid: 20000, display: 20 }, "x".repeat(40))).status, 401);
  assert.equal(asked.length, 1, "nothing bad took a picture");
  big = true;
  assert.equal((await call({ user: "ag20000", uid: 20000, display: 20 })).status, 400);
});
