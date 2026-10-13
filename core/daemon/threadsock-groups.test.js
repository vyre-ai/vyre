// @ts-check
// Real uids, as root, on Linux only (the box image, or a hosted runner with sudo): the session sockets of a team server (team/0.3.4/PROJECT-GROUPS.md, option B).
//   sudo node --test core/daemon/threadsock-groups.test.js        (needs /usr/bin/setpriv)
// vyred (uid 1000, in every account's group) opens each socket; who can connect rests on the socket's group and mode alone: another account's uid gets EACCES, the account's own session connects, and nobody
// but vyred can create or remove anything in the folder.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../../test/scratch.mjs";

const root = process.platform === "linux" && process.getuid && process.getuid() === 0 && fs.existsSync("/usr/bin/setpriv");
const VYRE = 1000, AGENT = 1001, WORKGID = 1002, A = 2000, B = 2001;
const CHILD = fileURLToPath(new URL("./threadsock-groups.child.mjs", import.meta.url));
const mode = (/** @type {string} */ p) => fs.statSync(p).mode & 0o7777;

/** Connect to a socket as a uid with no group but its own (and the groups given). Prints "connected" or the error code. */
const connectAs = (/** @type {number} */ uid, /** @type {string} */ sock, groups = /** @type {number[]} */ ([])) => spawnSync("/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid}`, groups.length ? `--groups=${groups.join(",")}` : "--clear-groups", "--inh-caps=-all", "--",
  process.execPath, "-e", `const s=require("net").connect(${JSON.stringify(sock)});s.on("connect",()=>{console.log("connected");s.destroy()});s.on("error",e=>console.log(e.code))`], { encoding: "utf8" }).stdout.trim();

/** vyred's side: a folder made as the image makes it, then one socket opened as vyre with the account groups. */
async function open(/** @type {import("node:test").TestContext} */ t, /** @type {number} */ gid, regroup = 0) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-tsg-")); fs.chmodSync(dir, 0o755);
  const folder = path.join(dir, "threads");
  fs.mkdirSync(folder); fs.chownSync(folder, VYRE, WORKGID); fs.chmodSync(folder, 0o2710);   // what an older start left: vyre-work, setgid, 2710
  const child = spawn("/usr/bin/setpriv", [`--reuid=${VYRE}`, `--regid=${VYRE}`, `--groups=${[A, B, AGENT].join(",")}`, "--inh-caps=-all", "--", process.execPath, CHILD],
    { env: { PATH: "/usr/bin:/bin", VYRE_THREAD_SOCKETS: folder, SOCK_GID: String(gid), ...(regroup ? { SOCK_REGROUP: String(regroup) } : {}) }, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.stdin.end(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  let out = ""; child.stdout.setEncoding("utf8");
  const lines = await new Promise(resolve => { child.stdout.on("data", d => { out += d; if (out.split("\n").filter(Boolean).length >= (regroup ? 2 : 1)) resolve(out.split("\n").filter(Boolean)); }); child.once("exit", () => resolve(out.split("\n").filter(Boolean))); });
  return { dir, folder, sock: lines[0], child, lines };
}

test("session sockets, real uids: the folder is vyre:vyre 0711 with no setgid, the socket is the account's group at 0660, another account gets EACCES and the account's own session connects", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { folder, sock } = await open(t, A);
  assert.ok(sock && sock.startsWith(folder + path.sep), `the socket is in the folder (${sock})`);
  assert.equal(mode(folder), 0o711, "passed through by anyone, listed and written by vyre alone, no setgid");
  assert.equal(fs.statSync(folder).uid, VYRE); assert.equal(fs.statSync(folder).gid, VYRE, "vyre's own group, not vyre-work");
  const st = fs.statSync(sock);
  assert.equal(st.gid, A, "the socket takes the account's group"); assert.equal(mode(sock), 0o660);
  assert.equal(connectAs(A, sock), "connected", "the account's own session connects");
  assert.equal(connectAs(B, sock), "EACCES", "another account's uid does not");
  assert.equal(connectAs(AGENT, sock), "EACCES", "nor does the box agent");
  assert.equal(connectAs(B, sock, [WORKGID]), "EACCES", "vyre-work opens nothing here any more");
});

test("session sockets, real uids: the box agent's session socket is the agent's group; only vyred creates or removes in the folder", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { folder, sock } = await open(t, AGENT);
  assert.equal(connectAs(AGENT, sock), "connected");
  assert.equal(connectAs(A, sock), "EACCES");
  for (const uid of [A, AGENT]) {
    const r = spawnSync("/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--", "/bin/sh", "-c", `touch ${folder}/mine 2>&1; rm -f ${sock} 2>&1; ls ${folder} 2>&1`], { encoding: "utf8" });
    assert.match(r.stdout, /Permission denied/, `uid ${uid} creates, removes and lists nothing`);
    assert.ok(fs.existsSync(sock), "the socket is still there");
  }
});

test("session sockets, real uids: a session that moves to another account's group (a hop) is reached by that account and no longer by the first", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { sock, lines } = await open(t, A, B);
  assert.equal(lines[1], "regrouped");
  assert.equal(fs.statSync(sock).gid, B);
  assert.equal(connectAs(B, sock), "connected");
  assert.equal(connectAs(A, sock), "EACCES");
});
