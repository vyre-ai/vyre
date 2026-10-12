// @ts-check
// Gives one project folder to its project group. Runs AS A SINGLE UID (setpriv, no capability), never as root: it can only change what that uid owns, so a link planted in the folder
// cannot make it touch anything else. The spawner runs it as the folder's owner first (`check` names the rules), then once for every other uid that owns something inside.
//   node regroup.js [check|verify] <folder> <gid> <vyreUid>     verify: only the rules, nothing changed
// Every entry is opened with O_PATH | O_NOFOLLOW and changed through /proc/self/fd, so a name swapped for a link after it was listed is never followed. Only plain files and folders are touched.
// Prints one JSON line: { fixed, others } where others are the uids that own entries it left for their owners.

import fs from "node:fs";

const [, , first, ...rest] = process.argv;
const verify = first === "verify", check = first === "check" || verify;
const [folder, gidArg, vyreArg] = check ? rest : [first, ...rest];
const gid = Number(gidArg), vyre = Number(vyreArg), me = /** @type {number} */ (process.getuid?.());
const O_PATH = 0o10000000;
const { O_NOFOLLOW } = fs.constants;

const fail = (/** @type {string} */ why) => { process.stderr.write(why + "\n"); process.exit(3); };
if (!folder || !Number.isInteger(gid) || gid < 1 || !Number.isInteger(vyre)) fail("usage: regroup.js [check] <folder> <gid> <vyreUid>");

/** @param {string} p */
const open = p => fs.openSync(p, O_PATH | O_NOFOLLOW);
const via = (/** @type {number} */ fd) => `/proc/self/fd/${fd}`;

if (check) {
  // The rules for a project folder: a real path with no link in it, a folder, owned by vyred's user.
  let real = "";
  try { real = fs.realpathSync(folder); } catch (e) { fail(`${folder} cannot be reached (${/** @type {NodeJS.ErrnoException} */ (e).code || "error"})`); }
  if (real !== folder) fail(`${folder} goes through a link (it is really ${real}); give the real folder`);
  const st = fs.lstatSync(folder);
  if (!st.isDirectory()) fail(`${folder} is not a folder`);
  if (st.uid !== vyre) fail(`${folder} is owned by uid ${st.uid}, not by Vyre (uid ${vyre})`);
}

if (verify) { process.stdout.write('{"fixed":0,"others":[]}\n'); process.exit(0); }

const others = new Set();
let fixed = 0;

/** @param {number} fd an open O_PATH descriptor of a folder or file @param {import("node:fs").Stats} st @param {boolean} top */
function fix(fd, st, top) {
  if (st.uid !== me) { others.add(st.uid); return false; }
  const dir = st.isDirectory();
  let mode = st.mode & 0o7777;
  // the project folder itself is 2770; inside it group read and write are added, and folders keep new files in the group (setgid)
  const want = top ? 0o2770 : dir ? (mode | 0o2070) : (mode | 0o060 | ((mode & 0o111) ? 0o010 : 0));
  if (st.gid !== gid) { fs.chownSync(via(fd), -1, gid); fixed++; }
  if ((st.mode & 0o7777) !== want) { fs.chmodSync(via(fd), want); fixed++; }
  return true;
}

/** @param {number} fd an open folder @param {number} depth */
function walk(fd, depth) {
  if (depth > 200) fail("the folder is nested too deeply to give to a group (200 levels)");
  /** @type {string[]} */ let names = [];
  try { names = fs.readdirSync(via(fd)); } catch { return; }
  for (const name of names) {
    /** @type {number} */ let child;
    try { child = open(`${via(fd)}/${name}`); } catch { continue; }
    try {
      const st = fs.fstatSync(child);
      if (!st.isDirectory() && !st.isFile()) continue;
      fix(child, st, false);
      if (st.isDirectory()) walk(child, depth + 1);
    } catch { /* gone or not ours to read */ } finally { try { fs.closeSync(child); } catch {} }
  }
}

const top = open(folder);
try {
  const st = fs.fstatSync(top);
  if (!st.isDirectory()) fail(`${folder} is not a folder`);
  if (fix(top, st, true) || st.uid !== me) walk(top, 0);
} finally { fs.closeSync(top); }
process.stdout.write(JSON.stringify({ fixed, others: [...others].sort((a, b) => a - b), vyre: me === vyre }) + "\n");
