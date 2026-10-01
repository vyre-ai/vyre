import test from "node:test";
import assert from "node:assert/strict";
import { candidates, probe, getWall, bwrapArgs, macProfile, linuxHint } from "./wall.js";

test("candidates: bwrap on Linux, sandbox-exec on a Mac, nothing elsewhere or without the binary", () => {
  const find = ([p]) => p;
  const lin = candidates({ platform: "linux", find })[0];
  assert.equal(lin.kind, "bwrap");
  assert.equal(lin.wrap(["/n", "x.js"], { ro: ["/work/w"] }).cmd, "/usr/bin/bwrap");
  const mac = candidates({ platform: "darwin", find })[0];
  assert.equal(mac.kind, "sandbox-exec");
  assert.equal(mac.wrap(["/n", "x.js"], { ro: ["/work/w"] }).args[0], "-p");
  assert.deepEqual(candidates({ platform: "win32", find }), []);
  assert.deepEqual(candidates({ platform: "linux", find: () => undefined }), [], "no bwrap, no candidate");
});

test("bwrap arguments: every namespace, a minimal root, the given paths read-only, nothing of the home", () => {
  const host = { exists: () => true, isLink: p => p !== "/usr", readLink: p => "usr" + p };
  const a = bwrapArgs(["/opt/node", "--permission", "/w/runner.js"], { ro: ["/w", "/opt/tc/bin", "/usr/lib/x"], cwd: "/w" }, host);
  assert.deepEqual(a.slice(0, 4), ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]);
  assert.ok(a.join(" ").includes("--ro-bind /usr /usr"));
  assert.ok(a.join(" ").includes("--proc /proc --dev /dev --tmpfs /tmp"));
  assert.ok(a.join(" ").includes("--ro-bind /w /w") && a.join(" ").includes("--ro-bind /opt/tc/bin /opt/tc/bin"));
  assert.ok(!a.join(" ").includes("--ro-bind /usr/lib/x"), "a path already under /usr is not bound twice");
  assert.ok(!a.some(x => /^\/(home|root|run|var|etc)$/.test(x)) && !a.includes("--bind"), "no home, no run, nothing writable");
  assert.deepEqual(a.slice(-4), ["--", "/opt/node", "--permission", "/w/runner.js"]);
});

test("macOS profile: network, signals, writes and the home and temp and run areas are denied, the given folders readable", () => {
  const p = macProfile(["/work/harlow"], "/Users/alex");
  for (const must of ["(deny network*)", "(deny signal)", "(allow signal (target self))", "(deny file-write* (subpath \"/\"))", "(subpath \"/Users\")", "(subpath \"/private/var/run\")"]) assert.ok(p.includes(must), must);
  assert.ok(p.includes("(allow file-read* (subpath \"/work/harlow\"))"));
  assert.ok(p.indexOf("(deny file-read*") < p.indexOf("(allow file-read*"), "the allow comes after the deny, so it wins");
  assert.ok(macProfile(['/a"b']).includes('/a\\"b'), "a quote in a path is escaped");
});

test("the Linux hint names the one fix", () => {
  assert.match(linuxHint({ platform: "linux", has: () => false }), /sudo apt install bubblewrap/);
  assert.match(linuxHint({ platform: "linux", has: () => true, readFile: () => "1\n" }), /restricts unprivileged user namespaces.*AppArmor/);
  assert.equal(linuxHint({ platform: "linux", has: () => true, readFile: () => "0\n" }), "");
  assert.equal(linuxHint({ platform: "darwin" }), "");
});

test("probe: a wrapper that stops nothing is not a wall, and one that cannot start is not either", async () => {
  const none = await probe({ kind: "none", wrap: argv => ({ cmd: argv[0], args: argv.slice(1) }) });
  assert.equal(none.ok, false);
  assert.match(none.why, /not reachable even without a wall|could still reach/);
  const broken = await probe({ kind: "broken", wrap: argv => ({ cmd: "/nonexistent/launcher", args: argv }) });
  assert.equal(broken.ok, false);
});

test("getWall: no candidate means no wall, and says why", async () => {
  const r = await getWall({ candidates: [], fresh: true });
  assert.equal(r.wall, null);
  assert.match(r.why, /no way to start a child without a network/);
});

test("this machine's real wall holds: a child it starts cannot reach a socket, the home directory or another process, but reads its folder", async t => {
  const list = candidates();
  if (!list.length) return t.skip("no wall candidate on this platform");
  const r = await getWall({ fresh: true });
  if (!r.wall && !process.env.VYRE_REQUIRE_WALL) return t.skip(`no wall here: ${r.why}`);
  assert.ok(r.wall, `a wall is required here and none works: ${r.why}`);
  assert.match(r.wall.kind, /^(bwrap|sandbox-exec)$/);
});
