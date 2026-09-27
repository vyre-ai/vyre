// @ts-check
// A session spawned through the box's spawner (core/spawner, ADR 0032 part 3), as the same uid
// here (no root): the handle looks like a ChildProcess at once, the pid, group and session come
// before anything reaches stdin, the API key arrives on fd 3 and never in the environment, stop
// takes the whole group, and an agent's folder moves to the agent's own home. The uid change
// itself is checked in the box image by scripts/e2e-split/check.sh.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serve } from "../spawner/server.js";
import { spawnSession, agentCwd, killGroup } from "./spawn.js";
import { SCRATCH } from "../../test/scratch.mjs";

async function spawner(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-sp-"));
  const work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 0, gid: 0, groups: [] }, wrap: argv => argv });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, work, srv };
}

const collect = s => new Promise(r => { let out = ""; s.setEncoding("utf8"); s.on("data", d => (out += d)); s.on("end", () => r(out)); });

test("spawn through the spawner: pid first, the key on fd 3 only, output and exit", async t => {
  const { socket, work } = await spawner(t);
  const order = [];
  const child = spawnSession("sh", ["-c", 'read l; echo "got $l"; echo "key=$(cat <&3) env=${ANTHROPIC_API_KEY:-none} fd=$CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"; exit 4'],
    { spawner: true, spawnerSocket: socket, cwd: work, env: { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-test-northwind" },
      onSpawn: g => order.push(["spawn", g.pid === g.pgid && g.pgid === g.sid && g.pid > 1]) });
  assert.equal(child.pid, undefined, "not known yet");
  // Written at once, before the pid is known: held until it is.
  child.stdin.write("hello\n");
  child.stdin.end();
  const out = collect(child.stdout);
  const code = await new Promise(r => child.once("exit", c => r(c)));
  assert.deepEqual(order, [["spawn", true]]);
  assert.ok(child.pid > 1);
  assert.equal(code, 4);
  assert.equal(await out, "got hello\nkey=sk-test-northwind env=none fd=3\n");
});

test("spawn through the spawner: stop takes the whole group, and an agent's folder moves to its own home", async t => {
  const { socket, work, srv } = await spawner(t);
  const marker = path.join(work, "left-behind");
  const child = spawnSession("/bin/sh", ["-c", `(sleep 2; touch ${marker}) & sleep 30`], { spawner: true, spawnerSocket: socket, cwd: work, env: { PATH: "/usr/bin:/bin" } });
  await new Promise(r => child.once("spawn", r));
  const gone = new Promise(r => child.once("exit", (c, s) => r(s)));
  killGroup(child, "SIGTERM");
  assert.equal(await gone, "SIGTERM");
  await new Promise(r => setTimeout(r, 2500));
  assert.ok(!fs.existsSync(marker));
  assert.equal(srv.live(), 0);
  assert.equal(agentCwd("/home/vyre/.vyre/agents/kit/notes", { vyreHome: "/home/vyre/.vyre", agentHome: "/home/vyre-agent" }), "/home/vyre-agent/agents/kit/notes");
  assert.equal(agentCwd("/work/northwind", { vyreHome: "/home/vyre/.vyre", agentHome: "/home/vyre-agent" }), "/work/northwind");
  assert.equal(agentCwd("/home/vyre/.vyre/vault", { vyreHome: "/home/vyre/.vyre", agentHome: "/home/vyre-agent" }), "/home/vyre/.vyre/vault");
});

test("spawn through the spawner: a refusal comes back as an error event", async t => {
  const { socket } = await spawner(t);
  const child = spawnSession("/usr/bin/env", ["true"], { spawner: true, spawnerSocket: socket, cwd: "/etc", env: {} });
  const e = await new Promise(r => child.once("error", r));
  assert.match(String(/** @type {any} */ (e).message), /not a program the spawner starts|cwd must be under/);
});
