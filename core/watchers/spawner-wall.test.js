import "../../scripts/mac-test-guard.mjs";
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { spawnerCandidate } from "./spawner-wall.js";
import { probe } from "../../lib/sandbox/index.js";
import { runOnce } from "./run.js";
import { skipOffRunner } from "../../lib/sandbox/test-host.js";

const offMac = skipOffRunner();
const test = (name, fn) => nodeTest(name, { skip: offMac }, fn);

test("no spawner, no candidate: a missing client, an old one, or one with no socket", async () => {
  assert.equal(await spawnerCandidate({ load: async () => { throw new Error("no module"); } }), null);
  assert.equal(await spawnerCandidate({ load: async () => ({ available: () => true }) }), null, "no spawnAsWatcher");
  assert.equal(await spawnerCandidate({ load: async () => ({ spawnAsWatcher: () => {}, available: () => false }) }), null, "no socket");
  const c = await spawnerCandidate({ load: async () => ({ spawnAsWatcher: () => {}, available: () => true }) });
  assert.equal(c.kind, "spawner"); assert.equal(c.materialize, true); assert.match(c.workGlob, /\*$/);
});

test("the spawner candidate is probed through its launcher, and a spawner that leaks is not a wall", async () => {
  const answer = o => `console.log(JSON.stringify(${JSON.stringify(o)}))`;
  const blocked = { tcp: "blocked:ECONNREFUSED", unix: "blocked:EACCES", file: "blocked:EACCES", signal: "blocked:EPERM", folder: "folder-readable" };
  const launching = out => argv => spawn(process.execPath, ["-e", answer(out)], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  const good = await probe({ kind: "spawner", launch: launching(blocked), materialize: true });
  // The probe's control must reach everything without a wall (it does, in-process), so a fake that says "blocked" passes.
  assert.equal(good.ok, true, good.why);
  const leaky = await probe({ kind: "spawner", launch: launching({ ...blocked, tcp: "connected" }), materialize: true });
  assert.equal(leaky.ok, false);
  assert.match(leaky.why, /could still reach a loopback socket/);
  const refused = await probe({ kind: "spawner", launch: async () => { throw new Error("the watcher wall is not in place: iptables failed"); }, materialize: true });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /watcher wall is not in place/);
});

test("a launched child is handed the watcher's files and runs them from its own TMPDIR", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sp-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, "work"); fs.mkdirSync(work);
  const dir = path.join(root, "folder"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({ name: "handed", project: "p", schedule: "*/15 * * * *" }));
  fs.writeFileSync(path.join(dir, "note.txt"), "a sibling file");
  fs.writeFileSync(path.join(dir, "watch.js"), `import fs from "node:fs";
export default async function watch({ emit }) {
  emit({ id: "h", title: fs.readFileSync(new URL("./note.txt", import.meta.url), "utf8") + " | " + String(process.env.TMPDIR).includes("slot") });
}`);
  const seen = [];
  const wall = { kind: "spawner", why: "fake", materialize: true, workGlob: path.join(work, "*"),
    launch: async (argv, o) => {
      seen.push({ argv, ro: o && o.ro });
      const tmp = path.join(work, "slot1"); fs.mkdirSync(tmp);
      return spawn(argv[0], argv.slice(1), { env: { TMPDIR: tmp }, stdio: ["pipe", "pipe", "pipe"] });
    } };
  const r = await runOnce({ dir, needs: [], since: null, timeoutMs: 15000, fetch: async () => "", wall });
  assert.equal(r.error, null, JSON.stringify(r));
  assert.equal(r.items[0].title, "a sibling file | true");
  assert.equal(r.wall, "spawner");
  assert.ok(seen[0].argv.some(a => a.startsWith("--allow-fs-write=") && a.endsWith("*")), "the child may write only under its work glob");
  assert.ok(!seen[0].argv.some(a => a.includes(dir)), "the person's folder is not handed to the child by path");
});

test("a spawner that refuses is a refusal in words, not a failed watcher", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sp-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "watch.js"), "export default async function watch() {}"); fs.writeFileSync(path.join(dir, "watcher.json"), "{}");
  const wall = { kind: "spawner", why: "fake", materialize: true, workGlob: "/x/*", launch: async () => { throw new Error("spawner: the watcher wall is not in place: the rule did not probe"); } };
  const r = await runOnce({ dir, needs: [], since: null, timeoutMs: 5000, fetch: async () => "", wall });
  assert.equal(r.unisolated, true);
  assert.match(r.error, /watchers cannot run on this machine: spawner: the watcher wall is not in place/);
});
