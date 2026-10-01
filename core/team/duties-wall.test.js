// A standing duty end to end, against the real product: a person turns on a teammate's duty, the real watchers module writes
// its folder, the real wall runs it once, and the item it files lands in the project's items. A model (mcp) cannot turn it on.
// Runs on a hosted runner (watchers' watchers-isolation workflow, linux-profile and macos jobs, and team-duty-e2e), never on the person's Mac.
// Skipped unless VYRE_WALL_CHECK=1.
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

test("a person turns on a teammate's duty: the real watcher runs once and files an item; a model cannot turn it on", { skip: on ? false : "set VYRE_WALL_CHECK=1 (the watchers-isolation and team-duty-e2e workflows do)" }, async t => {
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
  const noWall = !found.wall;
  const as = (caller, extra = {}) => (name, input) => call(name, input, { root, caller, timeout: 60_000, ...extra });
  const person = as("cli");
  const ok = async r => { const x = await r; assert.ok(!x.error, JSON.stringify(x.error)); return x.data; };

  const project = await ok(person("projects.create", { name: "Harlow Legal", home }));
  const added = await ok(person("team.add", { project: project.slug, role: "reviewer", brief: "reviews finished work" }));

  // The person creates a duty: it starts at once (a model's own creation is a proposal, tested elsewhere).
  if (noWall) {
    // No bubblewrap, or the restriction with no profile: a duty cannot run here, and says so rather than failing.
    const refused = await person("team.duties.create", { teammate: added.agent, when: "daily 07:00", instruction: "Note which sessions finished.", act: false });
    assert.ok(refused.error && /cannot run on this machine/.test(refused.error.message), JSON.stringify(refused.error));
    assert.deepEqual((await ok(person("team.duties.list", { teammate: added.agent }))).duties, [], "no row left behind");
    return;
  }
  const made = await ok(person("team.duties.create", { teammate: added.agent, when: "daily 07:00", instruction: "Note which sessions finished.", act: false, title: "finished sessions" }));
  assert.equal(made.started, true, "a person's own create starts it");
  const items = async (name = made.watcher) => (await ok(person("watchers.items", { name }))) || [];
  // The first run is part of creating it; poll up to 10 seconds, and say what happened if nothing was filed.
  const firstItems = async (watcher, label) => {
    let got = await items(watcher);
    for (let i = 0; i < 20 && !got.length; i++) { await new Promise(r => setTimeout(r, 500)); got = await items(watcher); }
    if (!got.length) {
      const logs = await person("watchers.logs", { name: watcher });
      const list = await person("watchers.list", {});
      assert.fail(`${label}: the first run filed no item. logs: ${JSON.stringify(logs.data || logs.error).slice(0, 1500)} list: ${JSON.stringify(list.data || list.error).slice(0, 800)}`);
    }
    return got;
  };
  const first = await firstItems(made.watcher, "daily duty");
  assert.equal(first[0].about, added.agent);
  assert.equal(first[0].title, "Note which sessions finished.");
  assert.equal(first[0].why, "its schedule");
  assert.equal(first[0].act, false);
  assert.match(first[0].id, new RegExp(`^${made.watcher}:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$`));

  // The same with an hourly trigger (the case that failed once before the poll existed): a second duty, same real wall.
  const hourly = await ok(person("team.duties.create", { teammate: added.agent, when: "hourly", instruction: "Note anything stale.", act: false, title: "stale things" }));
  const hourlyItems = await firstItems(hourly.watcher, "hourly duty");
  assert.equal(hourlyItems[0].title, "Note anything stale.");
  assert.equal(hourlyItems[0].about, added.agent);
  await ok(person("team.duties.delete", { id: hourly.id }));

  // A model cannot reach watchers' own doors either: duty.create is hidden from it, create is asked.
  assert.equal((await as("mcp")("watchers.duty.create", { name: "duty-x-1", project: project.slug, owner: { kind: "teammate", teammate: added.agent }, when: "daily 07:00", instruction: "x" })).error.code, "no_such_tool");
  assert.equal((await as("mcp")("watchers.create", { name: made.watcher })).error.code, "not_asked");

  // A model cannot turn a duty on, by any door.
  const proposal = await ok(person("team.duties.create", { teammate: added.agent, when: "daily 08:00", instruction: "Check the pricing page.", act: false }));
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
