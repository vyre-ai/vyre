// @ts-check
// Where the sealing master lives and who can reach it (the lead's rulings for 0.3): a file inside the Vyre home, private to its user. This checks, from the real profiles and files,
// that a Vyre-started session on macOS and Linux cannot reach the sealing folder, that on the box image an agent's uid cannot, and says where neither holds (a Windows home).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeSeatbelt, planHome } from "../../core/runner/homesandbox.js";
import { hostCheck, custodyNote } from "./process.js";
import { SealStore } from "./store.js";
import { homeIdentity } from "../home.js";
import { tmp } from "./testing.js";

const HOME = "/Users/alex", VYRE = path.join(HOME, ".vyre"), opts = { command: "/bin/echo", home: HOME, vyreHome: VYRE, sessionSocket: path.join(VYRE, "run", "s.sock"), workdirs: [path.join(HOME, "proj")] };

test("the sealing folder is inside the Vyre home (root/kernel/seal), the one place the session sandboxes deny", () => {
  const root = tmp("custody-root"), id = homeIdentity(root), sealDir = path.join(id.dir, "seal");
  assert.equal(path.dirname(sealDir), path.join(root, "kernel")); assert.ok(sealDir.startsWith(root + path.sep));
  const store = new SealStore(sealDir, Buffer.alloc(32, 1)); void store;
  assert.equal(fs.statSync(sealDir).mode & 0o077, 0, "the folder is private to the sealing process's user (0700)");
  fs.rmSync(root, { recursive: true, force: true });
});

test("macOS: the session profile denies the whole Vyre home, and nothing allowed back is inside its kernel or sealing folders", () => {
  const profile = homeSeatbelt(opts), lines = profile.split("\n");
  assert.ok(lines.includes(`(deny file* (subpath "${VYRE}"))`), "the whole Vyre home is denied");
  const seal = path.join(VYRE, "kernel", "seal"), allowed = lines.filter(l => /^\(allow /.test(l) && l.includes(VYRE));
  for (const l of allowed) assert.equal(l.includes(path.join(VYRE, "kernel")) || l.includes(seal), false, `an allow-back reaches the kernel folder: ${l}`);
  assert.ok(allowed.every(l => l.includes("run/s.sock") || l.includes("session")), "only the session's own socket is let back in: " + allowed.join(" | "));
});

test("Linux: the session sees a fresh empty home, and no bind reaches the Vyre home's kernel or sealing folders", () => {
  const root = tmp("custody-linux"), home = path.join(root, "home"), vyre = path.join(home, ".vyre"), proj = path.join(home, "proj");
  fs.mkdirSync(path.join(vyre, "kernel", "seal"), { recursive: true }); fs.mkdirSync(proj, { recursive: true });
  const r = planHome({ platform: "linux", command: "/bin/echo", home, vyreHome: vyre, sessionSocket: path.join(vyre, "run", "s.sock"), workdirs: [proj] }), a = r.argv;
  assert.ok(a.some((x, i) => x === "--tmpfs" && a[i + 1] === fs.realpathSync(home)), "an empty tmpfs covers the home, the Vyre home with it");
  const real = fs.realpathSync(vyre), binds = a.flatMap((x, i) => (x === "--bind" || x === "--ro-bind" || x === "--bind-try" || x === "--ro-bind-try" ? [a[i + 1], a[i + 2]] : []));
  for (const b of binds) assert.equal(b.startsWith(path.join(real, "kernel")), false, `a bind reaches the kernel folder: ${b}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the box image: an agent's uid is refused as the sealing uid, and the folder is private to its owner", () => {
  for (const uid of [1001, 2000, 2063]) assert.throws(() => hostCheck({ profile: "server", dev: false, uid: uid === 1001 ? 2001 : uid }), /own user/, `uid ${uid}`);
  assert.doesNotThrow(() => hostCheck({ profile: "server", dev: false, uid: 1000 }), "vyred's own uid (1000) is not in the agent range");
  const dockerfile = fs.readFileSync(new URL("../../box/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /useradd -u 1001 .*vyre-agent/, "Vyre-owned sessions run as vyre-agent (1001)"); assert.match(dockerfile, /seq 2000 2063/, "signed-in accounts run as 2000 to 2063");
});

test("where neither holds, it is said: a Windows home has no session sandbox in 0.3, and the key notice says so", () => {
  assert.throws(() => planHome({ platform: "win32", ...opts }), /not sandboxed/);
  assert.match(custodyNote("desktop", "win32"), /only as protected as this PC's own Windows account/);
  assert.match(custodyNote("desktop", "darwin") + custodyNote("desktop", "linux"), /sandboxed away from it/);
  assert.match(custodyNote("server", "linux"), /Root on this server, or a stolen disk, can read it/);
});
