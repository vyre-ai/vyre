import "../scripts/mac-test-guard.mjs";
// A real ssh login on Linux tops out at the root sshd listener, whose /proc/<pid>/exe an unprivileged vyred cannot read. The walk then records the server as "uid0" with the kernel's comm and
// command line, and isLoginServer believes that name only with uid 0. A user process called sshd, a user-owned tmux or a daemonized shell is never one.
import test from "node:test";
import assert from "node:assert/strict";
import { insideClaude } from "../core/daemon/peer.js";
import { isLoginServer, surfaceAncestry } from "../core/daemon/index.js";

const listener = { exe: "uid0", pid: 1272, started: "t", uid: 0, comm: "sshd", cmd: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups" };

test("a root sshd or login the kernel hid the exe of is a login server", () => {
  assert.equal(isLoginServer(listener), true);
  assert.equal(isLoginServer({ ...listener, comm: "login", cmd: "/bin/login -p --" }), true);
});
test("a user-owned process called sshd, a tmux, a bare uid0 with no name and a wrong cmd are not", () => {
  assert.equal(isLoginServer({ ...listener, uid: 1000 }), false);
  assert.equal(isLoginServer({ ...listener, comm: "tmux", cmd: "tmux: server" }), false);
  assert.equal(isLoginServer({ exe: "uid0", pid: 1, started: "t", uid: 0 }), false);
  assert.equal(isLoginServer({ ...listener, cmd: "/home/x/sshd-fake" }), false);
  assert.equal(isLoginServer({ ...listener, comm: "node", cmd: "sshd: pretend" }), false);
});
test("the walk names a real ssh chain (listener, [priv], session, shell) as that server, and the stand-in turns it into outside", () => {
  const rows = {
    100: { ppid: 1, args: "/usr/bin/node vyred", pgid: 100, sid: 100, uid: 1000, start: 1 },
    1272: { ppid: 1, args: "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", pgid: 1272, sid: 1272, uid: 0, start: 2 },
    1320: { ppid: 1272, args: "sshd: alex [priv]", pgid: 1320, sid: 1320, uid: 0, start: 3 },
    1612: { ppid: 1320, args: "sshd: alex@pts/0", pgid: 1320, sid: 1320, uid: 1000, start: 4 },
    1700: { ppid: 1612, args: "-bash", pgid: 1700, sid: 1700, uid: 1000, start: 5 },
    1800: { ppid: 1700, args: "node /usr/bin/vyre signin", pgid: 1800, sid: 1700, uid: 1000, start: 6 },
  };
  const look = pid => rows[pid] || null;
  const exe = pid => (pid === 1272 || pid === 1320 || pid === 1612 ? null : pid === 1700 ? "/usr/bin/bash" : "/usr/bin/node");
  const comm = { 1272: "sshd" };
  const r = insideClaude(1800, { look, exe, started: () => "t0", uid: pid => rows[pid].uid, self: 100, threads: [] });
  assert.equal(r.inside, false);
  assert.ok(r.server, JSON.stringify(r));
  assert.equal(r.server.exe, "uid0");
  // comm comes from /proc in production; the seam-free field is checked through isLoginServer with it filled in
  assert.equal(isLoginServer({ ...r.server, comm: comm[1272] }), true);
  assert.equal(surfaceAncestry({ model: false, server: { ...r.server, comm: "sshd" } }, true).outside, true);
  assert.equal(surfaceAncestry({ model: false, server: { ...r.server, comm: "sshd" } }, false).outside, false);
});
