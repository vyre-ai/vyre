import test from "node:test";
import { skipOffRunner } from "./test-host.js";
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
  const t = bwrapArgs(["/n"], { ro: ["/tmp/vyre-x/w"] }, host);
  assert.ok(t.indexOf("--tmpfs") < t.indexOf("/tmp/vyre-x/w"), "a folder under /tmp is bound after the private /tmp, so it is still seen");
  assert.deepEqual(a.slice(-4), ["--", "/opt/node", "--permission", "/w/runner.js"]);
});

test("macOS profile: deny by default with the BSD baseline, exec of node alone, reads of the given folders only", () => {
  const p = macProfile(["/work/harlow", "/opt/node/bin/node"], { node: "/opt/node/bin/node" });
  assert.ok(p.startsWith("(version 1)\n(deny default)\n(import \"bsd.sb\")"), "deny by default, then Apple's baseline");
  assert.ok(p.includes("(allow process-exec* (literal \"/opt/node/bin/node\"))"), "node may be exec'd");
  assert.equal((p.match(/process-exec/g) || []).length, 1, "and nothing else may be");
  assert.ok(p.includes("(allow signal (target self))"));
  assert.ok(p.includes("(allow file-read* (subpath \"/work/harlow\") (subpath \"/opt/node/bin/node\"))"));
  assert.ok(p.includes("(literal \"/opt/node\")") && p.includes("(literal \"/opt\")"), "parents may be looked at, not read");
  for (const never of ["(allow default)", "network", "Library", "/Users", "(allow file-write* (subpath", "mach-lookup"]) assert.ok(!p.includes(never), `the profile names ${never}`);
  assert.ok(macProfile([], { node: '/a"b' }).includes('/a\\"b'), "a quote in a path is escaped");
});

test("the Linux hint names the one fix", () => {
  assert.match(linuxHint({ platform: "linux", has: () => false }), /sudo apt install bubblewrap/);
  assert.match(linuxHint({ platform: "linux", has: () => true, readFile: () => "1\n" }), /restricts unprivileged user namespaces.*AppArmor/);
  assert.equal(linuxHint({ platform: "linux", has: () => true, readFile: () => "0\n" }), "");
  assert.equal(linuxHint({ platform: "darwin" }), "");
});

const offMac = skipOffRunner();

test("probe: a wrapper that stops nothing is not a wall, and one that cannot start is not either", { skip: offMac }, async () => {
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

test("this machine's real wall holds: a child it starts cannot reach a socket, the home directory or another process, but reads its folder", { skip: offMac }, async t => {
  const list = candidates();
  if (!list.length) return t.skip("no wall candidate on this platform");
  const r = await getWall({ fresh: true });
  if (!r.wall && !process.env.VYRE_REQUIRE_WALL) return t.skip(`no wall here: ${r.why}`);
  assert.ok(r.wall, `a wall is required here and none works: ${r.why}`);
  assert.match(r.wall.kind, /^(bwrap|sandbox-exec)$/);
});
