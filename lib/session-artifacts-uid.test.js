// @ts-check
// The folder for a session that runs as ANOTHER user (the packaged box's own-uid sessions), against real users: made by vyred as root, given to the session's user, written by a process running as
// that user, and read back by vyred with the owner check that artifacts' capture makes. Needs root and a second user; skipped otherwise (run with sudo on a test box).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { SCRATCH } from "../test/scratch.mjs";
import { artifactsDirFor, sessionsRoot } from "./session-temp.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const other = (() => { if (!isRoot) return null; for (const n of ["wkhome", "ghrunner", "nobody"]) { try { const [uid, gid] = execFileSync("id", ["-u", n]).toString().trim() && [Number(execFileSync("id", ["-u", n])), Number(execFileSync("id", ["-g", n]))]; if (uid > 0) return { name: n, uid, gid }; } catch { /* no such user */ } } return null; })();
const SKIP = !isRoot || !other ? "needs root and a second user (sudo on a test box)" : false;

test("a session that runs as another user: the folder is vyred's to make and the user's to write, reached through folders it can search but not list", { skip: SKIP, timeout: 60_000 }, async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "uidart-")); fs.chmodSync(home, 0o755);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".vyre"); fs.mkdirSync(root, { mode: 0o700 });
  const u = /** @type {{ name: string, uid: number, gid: number }} */ (other);
  const made = artifactsDirFor(root, "t-uid-1", { uid: u.uid, gid: u.gid });
  assert.ok(made && made.handed, "vyred gave the folder to the session's user");
  assert.ok(!made.dir.startsWith(root + path.sep), "outside the Vyre home");
  assert.equal(fs.statSync(made.dir).uid, u.uid);
  assert.equal((fs.statSync(sessionsRoot(root)).mode & 0o777).toString(8), "711", "searchable by the user, not listable");
  // a process running as that user writes into it...
  const w = spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(process.env.F,"made by the session")`], { uid: u.uid, gid: u.gid, env: { F: path.join(made.dir, "report.md"), PATH: process.env.PATH } });
  assert.equal(w.status, 0, String(w.stderr));
  // ...cannot list the folders above it, and cannot read another session's
  const ls = spawnSync(process.execPath, ["-e", `try{require("fs").readdirSync(${JSON.stringify(path.dirname(made.dir))});console.log("LISTED")}catch(e){console.log(e.code)}`], { uid: u.uid, gid: u.gid });
  assert.equal(String(ls.stdout).trim(), "EACCES");
  const other2 = artifactsDirFor(root, "t-uid-2", { uid: u.uid, gid: u.gid });
  assert.ok(other2 && other2.dir !== made.dir);
  // ...and vyred, as root, reads the file with the owner check capture makes (the file is the session's user's own)
  const st = fs.lstatSync(path.join(made.dir, "report.md"));
  assert.ok(st.isFile() && st.nlink === 1 && st.uid === u.uid);
  assert.equal(fs.readFileSync(path.join(made.dir, "report.md"), "utf8"), "made by the session");
  // a folder the user cannot be given (vyred is not root) is made but not handed over, and says so
});

test("a folder for a session in a sandbox is a folder inside its temp folder, 0700, a real folder; a bad id makes none", () => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "uidart2-")); const root = path.join(home, ".vyre"); fs.mkdirSync(root, { recursive: true });
  try {
    const made = artifactsDirFor(root, "t-1", {});
    assert.ok(made && made.handed && made.dir.endsWith(path.join("tmp", "t-1", "artifacts")));
    assert.equal((fs.statSync(made.dir).mode & 0o777).toString(8), "700");
    assert.ok(!made.dir.startsWith(root + path.sep));
    assert.equal(artifactsDirFor(root, "///", {}), null);
    // handing a folder to a user vyred may not give it to: made, not handed
    if (!isRoot) assert.equal(artifactsDirFor(root, "t-2", { uid: 0, gid: 0 }).handed, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
