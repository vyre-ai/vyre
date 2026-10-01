// A standing duty end to end, against the real product: a person turns on a teammate's duty, the real watchers module writes
// its folder, the real wall runs it once, and the item it files lands in the project's items. A model (mcp) cannot turn it on.
// Runs on a hosted runner (the team-duty-e2e workflow), never on the person's Mac. Skipped unless VYRE_WALL_CHECK=1.
//
// There is no feed to serve: a duty's code is fixed and files one item per firing (core/watchers/duty.js), and the wall keeps
// the child off the network, loopback included. What fires it here is its own first run on create and team.duties.run-now.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import * as config from "../config/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { getWall } from "../../lib/sandbox/index.js";
import { skipOffRunner } from "../../lib/sandbox/test-host.js";

const on = process.env.VYRE_WALL_CHECK === "1" && !skipOffRunner();
const expect = process.env.VYRE_EXPECT_WALL || "";

test("a person turns on a teammate's duty: the real watcher runs once and files an item; a model cannot turn it on", { skip: on ? false : "set VYRE_WALL_CHECK=1 (the team-duty-e2e workflow does)" }, async t => {
  const found = await getWall({ fresh: true });
  t.diagnostic(`wall: ${found.wall ? found.wall.kind : "none"} (${found.why})`);
  if (expect) assert.equal(found.wall && found.wall.kind, expect, `this job expected the ${expect} wall: ${found.why}`);

  const root = tempHome(t);
  const p = config.ensure(root);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "vyre-proj-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(p.config, JSON.stringify({ roots: [], transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" }, sessions: { install: false } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const as = (caller, extra = {}) => (name, input) => call(name, input, { root, caller, timeout: 60_000, ...extra });
  const person = as("cli");
  const ok = async r => { const x = await r; assert.ok(!x.error, JSON.stringify(x.error)); return x.data; };

  const project = await ok(person("projects.create", { name: "Harlow Legal", home }));
  const added = await ok(person("team.add", { project: project.slug, role: "reviewer", brief: "reviews finished work" }));

  // The person creates a duty: it starts at once (a model's own creation is a proposal, tested elsewhere).
  const made = await ok(person("team.duties.create", { teammate: added.agent, when: "hourly", instruction: "Note which sessions finished.", act: false, title: "finished sessions" }));
  assert.equal(made.started, true, "a person's own create starts it");
  const items = async () => (await ok(person("watchers.items", { name: made.watcher }))) || [];
  const first = await items();
  assert.ok(first.length >= 1, "the first run filed an item");
  assert.equal(first[0].about, added.agent);
  assert.match(first[0].title, /Note which sessions finished/);

  // A model cannot turn a duty on, by any door.
  const proposal = await ok(person("team.duties.create", { teammate: added.agent, when: "hourly", instruction: "Check the pricing page.", act: false }));
  assert.equal(proposal.started, true);
  await ok(person("team.duties.disable", { id: proposal.id }));
  for (const tool of ["team.duties.enable", "team.duties.update", "team.duties.start"]) {
    const r = await as("mcp")(tool, { id: proposal.id, enabled: true, expect: proposal.instruction });
    assert.ok(r.error, `${tool} by mcp must be refused`);
  }
  assert.equal((await ok(person("team.duties.list", { teammate: added.agent }))).duties.find(x => x.id === proposal.id).enabled, false, "still off");

  // The person's tap turns it back on, and run-now files another item.
  await ok(person("team.duties.enable", { id: proposal.id, expect: proposal.instruction }));
  await ok(person("team.duties.run-now", { id: made.id }));
  const after = await items();
  assert.ok(after.length >= first.length, "run-now ran the real watcher again");
  await ok(person("team.duties.delete", { id: made.id }));
  await ok(person("team.duties.delete", { id: proposal.id }));
});
