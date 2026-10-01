import test from "node:test";
import assert from "node:assert/strict";
import { candidates, probe, getWall } from "./wall.js";

test("candidates: unshare for a plain Linux user, plain unshare for root, sandbox-exec on a Mac, nothing elsewhere", () => {
  const find = ([p]) => p;
  const user = candidates({ platform: "linux", getuid: () => 1000, find })[0];
  assert.equal(user.kind, "netns");
  assert.deepEqual(user.wrap(["/n", "x.js"]), { cmd: "/usr/bin/unshare", args: ["--user", "--map-root-user", "--net", "--", "/n", "x.js"] });
  assert.deepEqual(candidates({ platform: "linux", getuid: () => 0, find })[0].wrap(["/n"]).args, ["--net", "--", "/n"]);
  const mac = candidates({ platform: "darwin", getuid: () => 501, find })[0];
  assert.equal(mac.kind, "sandbox-exec");
  assert.deepEqual(mac.wrap(["/n", "x.js"]).args.slice(0, 2), ["-p", "(version 1)(allow default)(deny network*)"]);
  assert.deepEqual(candidates({ platform: "win32", find }), []);
  assert.deepEqual(candidates({ platform: "linux", find: () => undefined }), [], "no unshare binary, no candidate");
});

test("probe: a wrapper that does not stop a socket is not a wall, and one that cannot start is not either", async () => {
  const none = await probe({ kind: "none", wrap: argv => ({ cmd: argv[0], args: argv.slice(1) }) });
  assert.equal(none.ok, false);
  assert.match(none.why, /could still open a socket/);
  const broken = await probe({ kind: "broken", wrap: argv => ({ cmd: "/nonexistent/launcher", args: argv }) });
  assert.equal(broken.ok, false);
  assert.match(broken.why, /broken could not start a child/);
});

test("getWall: no candidate means no wall, and says why", async () => {
  const r = await getWall({ candidates: [], fresh: true });
  assert.equal(r.wall, null);
  assert.match(r.why, /no way to start a child without a network/);
});

test("this machine's real wall holds: a child it starts cannot reach a listener we hold", async t => {
  const list = candidates();
  if (!list.length) return t.skip("no wall candidate on this platform");
  const r = await getWall({ fresh: true });
  // Linux hosts may forbid unprivileged user namespaces (stock Ubuntu 24.04 does); that is a real
  // answer, not a failure, unless the job says a wall is required.
  if (!r.wall && !process.env.VYRE_REQUIRE_WALL) return t.skip(`no wall here: ${r.why}`);
  assert.ok(r.wall, `a wall is required here and none works: ${r.why}`);
  assert.match(r.wall.kind, /^(netns|sandbox-exec)$/);
});
